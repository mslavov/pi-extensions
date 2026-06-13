import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	BROKER_SOCKET_PATH,
	CASPER_DIR,
	CONFIG_PATH,
	DEFAULT_CHANNEL_PREFIX,
	MAX_ATTACHMENTS_PER_TURN,
	SLACK_PREFIX,
	TEMP_DIR,
	type BrokerStatus,
	type BrokerToClient,
	type CasperConfig,
	type CasperForwardedEvent,
	type ClientToBroker,
	type DownloadedSlackFile,
	type SessionSnippet,
} from "./protocol.js";

interface SlackApiResponse<T> {
	ok: boolean;
	error?: string;
	team_id?: string;
	user_id?: string;
	url?: string;
	team?: string;
	user?: string;
	bot_id?: string;
	bot_user_id?: string;
	result?: T;
}

interface PendingSlackTurn {
	requestId: string;
	channelId: string;
	userId: string;
	ts?: string;
	files: DownloadedSlackFile[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveSlackTurn = PendingSlackTurn;
type PiTextMessage = AgentMessage & { role?: string };

const SESSION_UPDATE_INTERVAL_MS = 5_000;
const SESSION_HISTORY_LIMIT = 12;
const SESSION_HISTORY_TEXT_LIMIT = 800;

const SYSTEM_PROMPT_SUFFIX = `

Slack bridge extension is active.
- Messages forwarded from Slack are prefixed with "[slack]".
- Each local pi session is mirrored to one Slack channel managed by the Casper broker.
- Every pi message is forwarded to Slack automatically as Slack Block Kit blocks; agents do not need Slack messaging tools.
- If user attention is needed, say so plainly; Casper tags the configured Slack user on turn completion, errors, and input-needed events.`;

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function ensureCasperDir(): Promise<void> {
	await mkdir(CASPER_DIR, { recursive: true });
}

async function readConfig(): Promise<CasperConfig> {
	await ensureCasperDir();
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as CasperConfig;
	} catch {
		return {};
	}
}

async function writeConfig(config: CasperConfig): Promise<void> {
	await ensureCasperDir();
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

async function ensureBrokerSecret(config: CasperConfig): Promise<CasperConfig> {
	if (config.brokerSecret) return config;
	const nextConfig = { ...config, brokerSecret: randomBytes(32).toString("hex") };
	await writeConfig(nextConfig);
	return nextConfig;
}

function isStaleContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("captured pi or command ctx");
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function getTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

function getMessageText(message: AgentMessage): string {
	const value = message as unknown as Record<string, unknown>;
	return getTextFromContent(value.content).trim();
}

function getMessageRole(message: unknown): string | undefined {
	return typeof message === "object" && message !== null && "role" in message ? String((message as { role?: unknown }).role) : undefined;
}

function isAssistantMessage(message: PiTextMessage): boolean {
	return message.role === "assistant";
}

function isSlackPromptText(text: string): boolean {
	return text.trimStart().startsWith(SLACK_PREFIX);
}

function normalizePromptText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function slugify(value: string | undefined, fallback: string): string {
	const slug = value
		?.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return slug || fallback;
}

function extractSlackUserId(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const mention = trimmed.match(/<@([A-Z0-9]+)>/i);
	if (mention) return mention[1];
	const profileUrl = trimmed.match(/\/team\/(U[A-Z0-9]+)/i);
	if (profileUrl) return profileUrl[1];
	const bare = trimmed.match(/^(U[A-Z0-9]+)$/i);
	return bare?.[1];
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

async function createSlackTurn(
	delivery: Extract<BrokerToClient, { type: "deliver_turn" }>,
	historyTurns: PendingSlackTurn[] = [],
): Promise<PendingSlackTurn> {
	const rawText = delivery.text.trim();
	const content: Array<TextContent | ImageContent> = [];
	let prompt = `${SLACK_PREFIX}`;

	if (historyTurns.length > 0) {
		prompt += `\n\nEarlier Slack messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
		for (const [index, turn] of historyTurns.entries()) {
			prompt += `\n\n${index + 1}. ${turn.historyText}`;
		}
		prompt += `\n\nCurrent Slack message:`;
	}

	prompt += `\nSlack user <@${delivery.userId}> wrote in this session channel:`;
	if (rawText.length > 0) prompt += `\n${rawText}`;
	if (delivery.files.length > 0) {
		prompt += `\n\nSlack attachments were saved locally:`;
		for (const file of delivery.files) {
			prompt += `\n- ${file.path}`;
		}
	}
	content.push({ type: "text", text: prompt });

	for (const file of delivery.files.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
		if (!file.isImage) continue;
		const mediaType = file.mimeType || guessMediaType(file.path);
		if (!mediaType) continue;
		const buffer = await readFile(file.path);
		content.push({ type: "image", data: buffer.toString("base64"), mimeType: mediaType });
	}

	return {
		requestId: delivery.requestId,
		channelId: delivery.channelId,
		userId: delivery.userId,
		ts: delivery.ts,
		files: delivery.files,
		content,
		historyText: rawText || (delivery.files.length > 0 ? `Attachments: ${delivery.files.map((file) => file.path).join(", ")}` : "(empty message)"),
	};
}

class BrokerClient {
	private socket: Socket | undefined;
	private buffer = "";
	private requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private manuallyClosed = false;
	connected = false;
	lastError: string | undefined;
	channelId: string | undefined;
	channelName: string | undefined;

	constructor(
		private readonly connectionId: string,
		private readonly getSecret: () => string | undefined,
		private readonly getSnapshot: (ctx: ExtensionContext) => Omit<Extract<ClientToBroker, { type: "hello" }>, "v" | "type" | "brokerSecret">,
		private readonly onDeliverTurn: (message: Extract<BrokerToClient, { type: "deliver_turn" }>, ctx: ExtensionContext) => Promise<void>,
		private readonly onStatusChanged: (ctx: ExtensionContext, error?: string) => void,
	) {}

	async connect(ctx: ExtensionContext): Promise<void> {
		if (this.connected) return;
		await ensureBrokerProcess();
		await this.openSocket(ctx);
	}

	close(): void {
		this.manuallyClosed = true;
		this.clearReconnectTimer();
		this.connected = false;
		this.channelId = undefined;
		this.channelName = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket && !socket.destroyed) socket.end();
		this.rejectAllRequests(new Error("Casper broker unavailable"));
	}

	send(message: ClientToBroker): void {
		if (!this.socket?.writable) return;
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	sendSessionUpdate(ctx: ExtensionContext): void {
		if (!this.connected) return;
		this.send({ v: 1, type: "session_update", ...this.getSnapshot(ctx) });
	}

	forward(event: CasperForwardedEvent): void {
		if (!this.connected) return;
		this.send({ v: 1, type: "forward_event", eventId: randomUUID(), event });
	}

	request<T>(message: ClientToBroker & { id: string }, timeoutMs = 10_000): Promise<T> {
		if (!this.connected) return Promise.reject(new Error("Casper broker is not connected"));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.requests.delete(message.id);
				reject(new Error("Casper broker request timed out"));
			}, timeoutMs);
			this.requests.set(message.id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send(message);
		});
	}

	private async openSocket(ctx: ExtensionContext): Promise<void> {
		this.manuallyClosed = false;
		const secret = this.getSecret();
		if (!secret) throw new Error("Casper broker secret is missing");
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection(BROKER_SOCKET_PATH);
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(error);
			};
			socket.setEncoding("utf8");
			socket.once("connect", () => {
				if (settled) return;
				let snapshot: Omit<Extract<ClientToBroker, { type: "hello" }>, "v" | "type" | "brokerSecret">;
				try {
					snapshot = this.getSnapshot(ctx);
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				settled = true;
				this.socket = socket;
				this.connected = true;
				this.lastError = undefined;
				this.installSocketHandlers(socket, ctx);
				this.send({ v: 1, type: "hello", brokerSecret: secret, ...snapshot });
				this.onStatusChanged(ctx);
				resolve();
			});
			socket.once("error", fail);
		});
	}

	private installSocketHandlers(socket: Socket, ctx: ExtensionContext): void {
		socket.on("data", (chunk) => {
			this.buffer += chunk;
			let index: number;
			while ((index = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, index).trim();
				this.buffer = this.buffer.slice(index + 1);
				if (!line) continue;
				try {
					void this.handleMessage(JSON.parse(line) as BrokerToClient, ctx).catch((error) => {
						if (isStaleContextError(error)) {
							this.close();
							return;
						}
						this.lastError = error instanceof Error ? error.message : String(error);
						this.onStatusChanged(ctx, this.lastError);
					});
				} catch (error) {
					if (isStaleContextError(error)) {
						this.close();
						return;
					}
					this.lastError = error instanceof Error ? error.message : String(error);
					this.onStatusChanged(ctx, this.lastError);
				}
			}
		});
		socket.on("close", () => {
			this.connected = false;
			this.socket = undefined;
			this.rejectAllRequests(new Error("Casper broker unavailable"));
			this.onStatusChanged(ctx);
			if (this.manuallyClosed) return;
			this.scheduleReconnect(ctx);
		});
		socket.on("error", (error) => {
			this.lastError = error.message;
			this.onStatusChanged(ctx, error.message);
		});
	}

	private async handleMessage(message: BrokerToClient, ctx: ExtensionContext): Promise<void> {
		if (message.type === "hello_ack") {
			this.channelId = message.channelId;
			this.channelName = message.channelName;
			this.onStatusChanged(ctx);
			return;
		}
		if (message.type === "response") {
			const request = this.requests.get(message.id);
			if (!request) return;
			this.requests.delete(message.id);
			if (message.ok) request.resolve(message.result);
			else request.reject(new Error(message.error || "Casper broker request failed"));
			return;
		}
		if (message.type === "deliver_turn") await this.onDeliverTurn(message, ctx);
	}

	private scheduleReconnect(ctx: ExtensionContext): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect(ctx).catch((error) => {
				if (isStaleContextError(error)) return;
				this.lastError = error instanceof Error ? error.message : String(error);
				this.onStatusChanged(ctx, this.lastError);
				this.scheduleReconnect(ctx);
			});
		}, 5000);
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private rejectAllRequests(error: Error): void {
		for (const request of this.requests.values()) request.reject(error);
		this.requests.clear();
	}
}

async function canConnectToBroker(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(BROKER_SOCKET_PATH);
		const done = (value: boolean): void => {
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function ensureBrokerProcess(): Promise<void> {
	await ensureCasperDir();
	if (await canConnectToBroker()) return;
	const daemonPath = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
	const child = spawn(process.execPath, [daemonPath], {
		cwd: dirname(daemonPath),
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (await canConnectToBroker()) return;
	}
	throw new Error("Casper broker did not start");
}

async function callSlackApi<T>(method: string, token: string, body: Record<string, unknown> = {}): Promise<SlackApiResponse<T>> {
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
	});
	return (await response.json()) as SlackApiResponse<T>;
}

export default function (pi: ExtensionAPI) {
	const connectionId = randomUUID();
	let config: CasperConfig = {};
	let queuedSlackTurns: PendingSlackTurn[] = [];
	let activeSlackTurn: ActiveSlackTurn | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let currentAbort: (() => void) | undefined;
	let currentCtx: ExtensionContext | undefined;
	let setupInProgress = false;
	let sessionUpdateInterval: ReturnType<typeof setInterval> | undefined;
	let assistantStreamId: string | undefined;
	const waitingAskUserToolCalls = new Set<string>();

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		try {
			if (error) {
				ctx.ui.setStatus("casper", `casper: ${error}`);
				return;
			}
			if (broker.connected && broker.channelName) ctx.ui.setStatus("casper", `#${broker.channelName}`);
			else if (broker.connected) ctx.ui.setStatus("casper", "casper: connected");
			else ctx.ui.setStatus("casper", undefined);
		} catch (caught) {
			if (isStaleContextError(caught)) return;
			throw caught;
		}
	}

	function setCurrentCtx(ctx: ExtensionContext): void {
		currentCtx = ctx;
	}

	function isEphemeralSession(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getSessionFile() === undefined;
	}

	function sendUserMessageSafely(content: Array<TextContent | ImageContent>): void {
		try {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		} catch (error) {
			if (isStaleContextError(error)) return;
			throw error;
		}
	}

	function buildRecentSessionMessages(ctx: ExtensionContext): SessionSnippet[] {
		const snippets: SessionSnippet[] = [];
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0 && snippets.length < SESSION_HISTORY_LIMIT; i--) {
			const entry = entries[i] as unknown as Record<string, unknown>;
			if (entry.type !== "message") continue;
			const message = entry.message as Record<string, unknown> | undefined;
			if (!message || typeof message.role !== "string") continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = getTextFromContent(message.content).replace(/\s+/g, " ").trim();
			if (!text) continue;
			snippets.push({ role: message.role, text: text.length > SESSION_HISTORY_TEXT_LIMIT ? `${text.slice(0, SESSION_HISTORY_TEXT_LIMIT).trimEnd()}…` : text });
		}
		return snippets.reverse();
	}

	function buildSessionSnapshot(ctx: ExtensionContext): Omit<Extract<ClientToBroker, { type: "hello" }>, "v" | "type" | "brokerSecret"> {
		return {
			connectionId,
			sessionId: ctx.sessionManager.getSessionId(),
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			sessionName: ctx.sessionManager.getSessionName(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			isIdle: ctx.isIdle(),
			activeTurn: activeSlackTurn ? { requestId: activeSlackTurn.requestId, channelId: activeSlackTurn.channelId } : undefined,
			queuedTurns: queuedSlackTurns.length,
			recentMessages: buildRecentSessionMessages(ctx),
		};
	}

	async function handleSessionStatusCommand(ctx: ExtensionContext): Promise<string> {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			totalInput += entry.message.usage.input;
			totalOutput += entry.message.usage.output;
			totalCacheRead += entry.message.usage.cacheRead;
			totalCacheWrite += entry.message.usage.cacheWrite;
			totalCost += entry.message.usage.cost.total;
		}

		const usage = ctx.getContextUsage();
		const lines: string[] = [];
		if (ctx.model) lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
		const tokenParts: string[] = [];
		if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
		if (tokenParts.length > 0) lines.push(`Usage: ${tokenParts.join(" ")}`);
		const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
		if (totalCost || usingSubscription) lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		if (usage) {
			const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
			lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
		} else {
			lines.push("Context: unknown");
		}
		return lines.length > 0 ? lines.join("\n") : "No usage data yet.";
	}

	async function dispatchBrokerTurn(delivery: Extract<BrokerToClient, { type: "deliver_turn" }>, ctx: ExtensionContext): Promise<void> {
		const rawText = delivery.text.trim();
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedSlackTurns.length > 0) preserveQueuedTurnsAsHistory = true;
				currentAbort();
				broker.forward({ type: "agent_finished", timestamp: Date.now(), stopReason: "aborted", attention: true });
			} else {
				broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: "No active turn to stop.", display: true }, attention: true });
			}
			broker.sendSessionUpdate(ctx);
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: "Cannot compact while pi is busy. Send stop first.", display: true }, attention: true });
				return;
			}
			ctx.compact({
				onComplete: () => {
					broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: "Compaction completed.", display: true }, attention: true });
				},
				onError: (error) => {
					broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`, display: true }, attention: true });
				},
			});
			broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: "Compaction started.", display: true } });
			return;
		}

		if (lower === "/status") {
			broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: await handleSessionStatusCommand(ctx), display: true }, attention: true });
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedSlackTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createSlackTurn(delivery, historyTurns);
		queuedSlackTurns.push(turn);
		broker.sendSessionUpdate(ctx);
		if (ctx.isIdle()) sendUserMessageSafely(turn.content);
	}

	function sessionNameSource(prompt: string): string {
		let text = prompt.trim().replace(/^\[slack\]\s*/i, "");
		text = text
			.replace(/^Slack user <@[A-Z0-9]+> wrote in this session channel:/gim, " ")
			.replace(/Slack attachments were saved locally:[\s\S]*$/gi, " ")
			.replace(/https?:\/\/\S+/g, " ")
			.replace(/[>`*_#[\](){}]/g, " ");
		return normalizePromptText(text);
	}

	function hasPriorUserMessage(ctx: ExtensionContext, prompt: string): boolean {
		const userTexts: string[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			const value = entry as unknown as Record<string, unknown>;
			if (value.type !== "message") continue;
			const message = value.message as Record<string, unknown> | undefined;
			if (message?.role !== "user") continue;
			const text = normalizePromptText(getTextFromContent(message.content));
			if (text) userTexts.push(text);
		}
		if (userTexts.length === 0) return false;
		const current = normalizePromptText(prompt);
		return userTexts.length > 1 || userTexts[userTexts.length - 1] !== current;
	}

	function maybeNameSessionFromPrompt(prompt: string, ctx: ExtensionContext): void {
		if (pi.getSessionName() || ctx.sessionManager.getSessionName()) return;
		if (hasPriorUserMessage(ctx, prompt)) return;
		const name = slugify(sessionNameSource(prompt), "");
		if (!name) return;
		pi.setSessionName(name);
		broker.sendSessionUpdate(ctx);
	}

	function getToolUpdateText(partialResult: unknown): string {
		if (!partialResult || typeof partialResult !== "object") return "";
		return getTextFromContent((partialResult as { content?: unknown }).content).trim();
	}

	function getAskUserQuestion(args: unknown): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		const question = (args as { question?: unknown }).question;
		return typeof question === "string" && question.trim() ? question.trim() : undefined;
	}

	async function validateAndStoreConfig(nextConfig: CasperConfig, ctx: ExtensionContext): Promise<boolean> {
		if (!nextConfig.botToken || !nextConfig.appToken) return false;
		const auth = await callSlackApi("auth.test", nextConfig.botToken);
		if (!auth.ok) {
			ctx.ui.notify(`Slack bot token failed auth.test: ${auth.error ?? "unknown error"}`, "error");
			return false;
		}
		const socket = await callSlackApi("apps.connections.open", nextConfig.appToken);
		if (!socket.ok || !socket.url) {
			ctx.ui.notify(`Slack app token failed apps.connections.open: ${socket.error ?? "unknown error"}`, "error");
			return false;
		}
		config = await ensureBrokerSecret({
			...nextConfig,
			botUserId: auth.user_id ?? nextConfig.botUserId,
			botTeamId: auth.team_id ?? nextConfig.botTeamId,
			channelPrefix: slugify(nextConfig.channelPrefix, DEFAULT_CHANNEL_PREFIX),
			archiveOnSessionClose: nextConfig.archiveOnSessionClose !== false,
		});
		await writeConfig(config);
		return true;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const botToken = await ctx.ui.input("Slack Bot User OAuth Token", "xoxb-...");
			if (!botToken) return;
			const appToken = await ctx.ui.input("Slack App-Level Token for Socket Mode", "xapp-...");
			if (!appToken) return;
			const userIdInput = await ctx.ui.input("Slack user ID or profile URL to mention", config.userId || "U0B8RPH038W");
			const userId = extractSlackUserId(userIdInput);
			if (!userId) {
				ctx.ui.notify("Enter a Slack user ID like U123… or a /team/U123… profile URL.", "error");
				return;
			}
			const channelPrefixInput = await ctx.ui.input("Session channel prefix", config.channelPrefix || DEFAULT_CHANNEL_PREFIX);
			const nextConfig: CasperConfig = {
				...config,
				botToken: botToken.trim(),
				appToken: appToken.trim(),
				userId,
				channelPrefix: slugify(channelPrefixInput, DEFAULT_CHANNEL_PREFIX),
				archiveOnSessionClose: true,
			};
			if (!(await validateAndStoreConfig(nextConfig, ctx))) return;
			ctx.ui.notify(`Casper configured for Slack user <@${config.userId}>.`, "info");
			await broker.connect(ctx);
			await broker.request({ v: 1, type: "reload_config", id: randomUUID() }).catch(() => undefined);
			broker.sendSessionUpdate(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	function formatStatusSession(session: BrokerStatus["sessions"][number]): string {
		const cwdName = basename(session.cwd || "?");
		const state = session.isIdle ? "idle" : "busy";
		const queued = session.queuedTurns ? `, ${session.queuedTurns} queued` : "";
		const model = session.model ? ` · ${session.model}` : "";
		const channel = session.channelName ? `#${session.channelName}` : "no channel";
		return `- ${channel} · ${cwdName} · pid ${session.pid} · ${state}${queued}${model}`;
	}

	function startSessionUpdates(ctx: ExtensionContext): void {
		if (sessionUpdateInterval) return;
		sessionUpdateInterval = setInterval(() => {
			try {
				broker.sendSessionUpdate(ctx);
			} catch (error) {
				if (isStaleContextError(error)) stopSessionUpdates();
			}
		}, SESSION_UPDATE_INTERVAL_MS);
	}

	function stopSessionUpdates(): void {
		if (!sessionUpdateInterval) return;
		clearInterval(sessionUpdateInterval);
		sessionUpdateInterval = undefined;
	}

	const broker = new BrokerClient(
		connectionId,
		() => config.brokerSecret,
		buildSessionSnapshot,
		dispatchBrokerTurn,
		updateStatus,
	);

	pi.registerCommand("casper-setup", {
		description: "Configure Slack Socket Mode bridge",
		handler: async (_args, ctx) => {
			config = await ensureBrokerSecret(await readConfig());
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("casper-status", {
		description: "Show Slack Casper bridge status",
		handler: async (_args, ctx) => {
			config = await ensureBrokerSecret(await readConfig());
			if (config.botToken && config.appToken && !broker.connected) {
				await broker.connect(ctx).catch(() => undefined);
				startSessionUpdates(ctx);
			}
			broker.sendSessionUpdate(ctx);
			let brokerStatus: BrokerStatus | undefined;
			if (broker.connected) {
				brokerStatus = await broker.request<BrokerStatus>({ v: 1, type: "get_status", id: randomUUID() }).catch(() => undefined);
			}
			const lines = [
				ctx.ui.theme.fg("accent", "Casper Slack bridge"),
				`Configured: ${config.botToken && config.appToken ? "yes" : "no"}`,
				`Bot user: ${brokerStatus?.botUserId ?? config.botUserId ?? "unknown"}`,
				`Mention user: ${brokerStatus?.userId ?? config.userId ?? "not set"}`,
				`Broker: ${broker.connected ? `running${brokerStatus ? ` (pid ${brokerStatus.brokerPid})` : ""}` : "stopped"}`,
				`Socket Mode: ${brokerStatus?.socketConnected ? "connected" : "disconnected"}`,
				`This session channel: ${broker.channelName ? `#${broker.channelName}` : broker.connected ? "pending" : "not registered"}`,
				`Config: ${CONFIG_PATH}`,
				`Active Slack turn: ${activeSlackTurn ? "yes" : "no"}`,
				`Queued Slack turns: ${queuedSlackTurns.length}`,
			];
			if (brokerStatus?.lastError) lines.push(`Last error: ${brokerStatus.lastError}`);
			lines.push("", `Connected sessions: ${brokerStatus?.sessions.length ?? (broker.connected ? "unknown" : 0)}`);
			if (brokerStatus?.sessions.length) lines.push(...brokerStatus.sessions.map(formatStatusSession));
			ctx.ui.notify(lines.join("\n"), brokerStatus?.lastError ? "warning" : "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setCurrentCtx(ctx);
		waitingAskUserToolCalls.clear();
		assistantStreamId = undefined;
		if (isEphemeralSession(ctx)) {
			updateStatus(ctx);
			return;
		}
		config = await ensureBrokerSecret(await readConfig());
		await mkdir(TEMP_DIR, { recursive: true });
		if (!config.botToken || !config.appToken) {
			updateStatus(ctx);
			return;
		}
		try {
			await broker.connect(ctx);
			startSessionUpdates(ctx);
			broker.forward({ type: "session_started", timestamp: Date.now() });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateStatus(ctx, message);
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (broker.connected && event.reason !== "reload") {
			broker.send({ v: 1, type: "session_closed", sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
		}
		queuedSlackTurns = [];
		activeSlackTurn = undefined;
		currentAbort = undefined;
		currentCtx = undefined;
		assistantStreamId = undefined;
		waitingAskUserToolCalls.clear();
		preserveQueuedTurnsAsHistory = false;
		stopSessionUpdates();
		broker.close();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setCurrentCtx(ctx);
		maybeNameSessionFromPrompt(event.prompt, ctx);
		return { systemPrompt: `${event.systemPrompt}${SYSTEM_PROMPT_SUFFIX}` };
	});

	pi.on("agent_start", async (_event, ctx) => {
		setCurrentCtx(ctx);
		currentAbort = () => {
			try {
				ctx.abort();
			} catch (error) {
				if (isStaleContextError(error)) return;
				throw error;
			}
		};
		if (!activeSlackTurn && queuedSlackTurns.length > 0) {
			const nextTurn = queuedSlackTurns.shift();
			if (nextTurn) activeSlackTurn = { ...nextTurn };
		}
		broker.forward({ type: "agent_started", timestamp: Date.now() });
		broker.sendSessionUpdate(ctx);
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (isAssistantMessage(event.message as PiTextMessage)) {
			assistantStreamId = randomUUID();
			broker.forward({ type: "message_start", timestamp: Date.now(), streamId: assistantStreamId, message: event.message });
		}
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!assistantStreamId || !isAssistantMessage(event.message as PiTextMessage)) return;
		broker.forward({ type: "message_update", timestamp: Date.now(), streamId: assistantStreamId, message: event.message });
	});

	pi.on("message_end", async (event, _ctx) => {
		const role = getMessageRole(event.message);
		const text = getMessageText(event.message as AgentMessage);
		if (role === "user" && isSlackPromptText(text)) return;
		if (role === "assistant") {
			broker.forward({ type: "message_end", timestamp: Date.now(), streamId: assistantStreamId, message: event.message });
			assistantStreamId = undefined;
			return;
		}
		broker.forward({ type: "message_end", timestamp: Date.now(), message: event.message });
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		setCurrentCtx(ctx);
		broker.forward({ type: "tool_start", timestamp: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (event.toolName !== "ask_user") return;
		if (waitingAskUserToolCalls.has(event.toolCallId)) return;
		if (!/waiting for user input/i.test(getToolUpdateText(event.partialResult))) return;
		waitingAskUserToolCalls.add(event.toolCallId);
		broker.forward({
			type: "tool_waiting",
			timestamp: Date.now(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			text: getAskUserQuestion(event.args) ?? "ask_user is waiting for your input.",
			attention: true,
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (event.toolName === "ask_user") waitingAskUserToolCalls.delete(event.toolCallId);
		broker.forward({
			type: "tool_end",
			timestamp: Date.now(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
			attention: event.isError,
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		setCurrentCtx(ctx);
		currentAbort = undefined;
		const turn = activeSlackTurn;
		activeSlackTurn = undefined;
		const lastAssistant = [...event.messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
		broker.forward({
			type: "agent_finished",
			timestamp: Date.now(),
			stopReason: lastAssistant?.stopReason,
			errorMessage: lastAssistant?.errorMessage,
			attention: true,
		});
		if (queuedSlackTurns.length > 0 && !preserveQueuedTurnsAsHistory) sendUserMessageSafely(queuedSlackTurns[0].content);
		if (turn) preserveQueuedTurnsAsHistory = false;
		broker.sendSessionUpdate(ctx);
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		setCurrentCtx(ctx);
		broker.sendSessionUpdate(ctx);
	});

	pi.on("thinking_level_select", async (_event, _ctx) => {
		const ctx = currentCtx;
		if (ctx) broker.sendSessionUpdate(ctx);
	});
}
