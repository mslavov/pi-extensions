import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isContextOverflow, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	BROKER_SOCKET_PATH,
	CASPER_DIR,
	CONFIG_PATH,
	DEFAULT_CHANNEL_PREFIX,
	MAX_ATTACHMENTS_PER_TURN,
	TEMP_DIR,
	type BrokerStatus,
	type BrokerToClient,
	type BrokerAskUserPrompt,
	type BrokerAskUserResponse,
	type BrokerUploadFileResult,
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
	promptText: string;
}

type ActiveSlackTurn = PendingSlackTurn;
type PiTextMessage = AgentMessage & { role?: string };
type AssistantTurnResult = AgentMessage & { role: "assistant"; stopReason?: string; errorMessage?: string };
type UserMessageDelivery = "steer" | "followUp";
type CompactionReason = "manual" | "threshold" | "overflow";

interface SlashRouteResult {
	handled: boolean;
	text?: string;
}

interface CasperUploadFileToolResult extends BrokerUploadFileResult {
	path: string;
}

interface ExternalAskPrompt {
	promptId: string;
	sessionId: string;
	createdAt: number;
	questions: Array<{
		question: string;
		header: string;
		context?: string;
		options: Array<{ title: string; description?: string }>;
		allowMultiple: boolean;
		allowFreeform: boolean;
		allowComment: boolean;
	}>;
	submitText(text: string): { ok: boolean; error?: string };
	submitResponse(response: BrokerAskUserResponse): { ok: boolean; error?: string };
}

interface ExternalAskBridge {
	pending: Map<string, ExternalAskPrompt>;
}

interface ExternalPlanReviewPrompt {
	sessionId: string;
	planFilePath: string;
	reviewUrl?: string;
	submitDecision(action: "approve" | "refine" | "exit", feedback?: string): { ok: boolean; error?: string };
}

interface ExternalPlanModeBridge {
	pending: Map<string, ExternalPlanReviewPrompt>;
}

interface PlanReadyEvent {
	planFilePath: string;
	reviewUrl?: string;
	title?: string;
	message?: string;
}

interface PlanClosedEvent {
	planFilePath: string;
	reason?: string;
}

const SESSION_UPDATE_INTERVAL_MS = 5_000;
const SESSION_HISTORY_LIMIT = 12;
const SESSION_HISTORY_TEXT_LIMIT = 800;
const TERMINAL_AGENT_ERROR_GRACE_MS = 750;
const RECOVERABLE_AGENT_ERROR_GRACE_MS = 90_000;
const ASK_USER_BRIDGE_SYMBOL = Symbol.for("pi-ask-user:external-bridge:v1");
const PLAN_MODE_BRIDGE_SYMBOL = Symbol.for("pi-plan-mode:external-bridge:v1");
const PLAN_READY_EVENT = "pi:plan-mode:ready";
const PLAN_CLOSED_EVENT = "pi:plan-mode:closed";
const CASPER_UPLOAD_FILE_TOOL = "casper_upload_file";
const SLACK_SILENT_TOOLS = new Set([CASPER_UPLOAD_FILE_TOOL]);

const SYSTEM_PROMPT_SUFFIX = `

Slack bridge extension is active.
- Slack messages arrive as regular user messages in this session.
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

function assertSafeUploadPath(path: string): void {
	const name = basename(path).toLowerCase();
	if (name === ".env" || name.startsWith(".env.")) throw new Error("Refusing to upload environment files.");
	if (/\.(pem|key|p12|pfx|crt|cer|der)$/i.test(name)) throw new Error("Refusing to upload credential files.");
	if (/id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)) throw new Error("Refusing to upload private key files.");
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

function getExternalAskBridge(): ExternalAskBridge | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[ASK_USER_BRIDGE_SYMBOL] as ExternalAskBridge | undefined;
}

function getPendingExternalAsk(ctx: ExtensionContext): ExternalAskPrompt | undefined {
	return getExternalAskBridge()?.pending.get(ctx.sessionManager.getSessionId());
}

function brokerAskPromptFromExternalAsk(prompt: ExternalAskPrompt | undefined): BrokerAskUserPrompt | undefined {
	if (!prompt) return undefined;
	return {
		promptId: prompt.promptId,
		createdAt: prompt.createdAt,
		questions: prompt.questions,
	};
}

function getExternalPlanModeBridge(): ExternalPlanModeBridge | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[PLAN_MODE_BRIDGE_SYMBOL] as ExternalPlanModeBridge | undefined;
}

function getPendingExternalPlanReview(ctx: ExtensionContext): ExternalPlanReviewPrompt | undefined {
	return getExternalPlanModeBridge()?.pending.get(ctx.sessionManager.getSessionId());
}

function parsePlanReadyEvent(value: unknown): PlanReadyEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	if (event.source !== "pi-plan-mode") return undefined;
	if (event.kind !== undefined && event.kind !== "ready") return undefined;
	const planFilePath = typeof event.planFilePath === "string" ? event.planFilePath.trim() : "";
	if (!planFilePath) return undefined;
	return {
		planFilePath,
		reviewUrl: typeof event.reviewUrl === "string" && event.reviewUrl.trim() ? event.reviewUrl.trim() : undefined,
		title: typeof event.title === "string" && event.title.trim() ? event.title.trim() : undefined,
		message: typeof event.message === "string" && event.message.trim() ? event.message.trim() : undefined,
	};
}

function parsePlanClosedEvent(value: unknown): PlanClosedEvent | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	if (event.source !== "pi-plan-mode") return undefined;
	const planFilePath = typeof event.planFilePath === "string" ? event.planFilePath.trim() : "";
	if (!planFilePath) return undefined;
	return {
		planFilePath,
		reason: typeof event.reason === "string" && event.reason.trim() ? event.reason.trim() : undefined,
	};
}

function isAssistantMessage(message: PiTextMessage): boolean {
	return message.role === "assistant";
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
	let prompt = "";

	if (historyTurns.length > 0) {
		prompt += `Earlier messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
		for (const [index, turn] of historyTurns.entries()) {
			prompt += `\n\n${index + 1}. ${turn.historyText}`;
		}
		prompt += `\n\nCurrent message:`;
	}

	if (rawText.length > 0) prompt += `${prompt ? "\n" : ""}${rawText}`;
	if (delivery.files.length > 0) {
		prompt += `${prompt ? "\n\n" : ""}Attachments were saved locally:`;
		for (const file of delivery.files) {
			prompt += `\n- ${file.path}`;
		}
	}
	if (!prompt) prompt = "(empty message)";
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
		promptText: prompt,
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
		private readonly onPlanAction: (message: Extract<BrokerToClient, { type: "plan_action" }>, ctx: ExtensionContext) => Promise<void>,
		private readonly onAskUserAction: (message: Extract<BrokerToClient, { type: "ask_user_action" }>, ctx: ExtensionContext) => Promise<void>,
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
		if (!this.connected) {
			if (!this.manuallyClosed) this.scheduleReconnect(ctx);
			return;
		}
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
		if (message.type === "plan_action") await this.onPlanAction(message, ctx);
		if (message.type === "ask_user_action") await this.onAskUserAction(message, ctx);
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
		let settled = false;
		const done = (value: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(300, () => done(false));
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
	let compactionInProgress = false;
	let brokerConnecting = false;
	let sessionStartupToken = 0;
	const waitingAskUserToolCalls = new Map<string, unknown>();
	const forwardedAskUserToolCalls = new Set<string>();
	const askUserForwardTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const slackPromptTexts = new Set<string>();
	let pendingAgentFinishedTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingAgentFinishedToken = 0;

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		try {
			if (error) {
				ctx.ui.setStatus("casper", `casper: ${error}`);
				return;
			}
			if (broker.connected && broker.channelName) ctx.ui.setStatus("casper", `#${broker.channelName}`);
			else if (broker.connected) ctx.ui.setStatus("casper", "casper: connected");
			else if (brokerConnecting) ctx.ui.setStatus("casper", "casper: connecting");
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

	function sendUserMessageSafely(content: Array<TextContent | ImageContent>, deliverAs?: UserMessageDelivery): void {
		try {
			if (deliverAs) pi.sendUserMessage(content, { deliverAs });
			else pi.sendUserMessage(content);
		} catch (error) {
			if (isStaleContextError(error)) return;
			throw error;
		}
	}

	function sendNextQueuedSlackTurnIfReady(ctx: ExtensionContext): void {
		if (compactionInProgress || activeSlackTurn || queuedSlackTurns.length === 0 || !ctx.isIdle()) return;
		sendUserMessageSafely(queuedSlackTurns[0].content);
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

	function consumeSlackPromptText(text: string): boolean {
		const key = normalizePromptText(text);
		if (!slackPromptTexts.has(key)) return false;
		slackPromptTexts.delete(key);
		return true;
	}

	function forwardCasperNotice(text: string, attention = true): void {
		broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: text, display: true }, attention });
	}

	function clearPendingAgentFinished(): void {
		pendingAgentFinishedToken++;
		if (!pendingAgentFinishedTimer) return;
		clearTimeout(pendingAgentFinishedTimer);
		pendingAgentFinishedTimer = undefined;
	}

	function forwardAgentFinished(forwarded: Extract<CasperForwardedEvent, { type: "agent_finished" }>, ctx: ExtensionContext, assistant?: AssistantTurnResult): void {
		clearPendingAgentFinished();
		const delayMs = agentFinishedDelayMs(forwarded, ctx, assistant);
		if (delayMs === 0) {
			broker.forward(forwarded);
			return;
		}

		const token = ++pendingAgentFinishedToken;
		pendingAgentFinishedTimer = setTimeout(() => {
			if (token !== pendingAgentFinishedToken) return;
			pendingAgentFinishedTimer = undefined;
			broker.forward(forwarded);
		}, delayMs);
		pendingAgentFinishedTimer.unref?.();
	}

	function agentFinishedDelayMs(forwarded: Extract<CasperForwardedEvent, { type: "agent_finished" }>, ctx: ExtensionContext, assistant?: AssistantTurnResult): number {
		if (forwarded.stopReason !== "error") return 0;
		return isRecoverableAssistantError(assistant, ctx) ? RECOVERABLE_AGENT_ERROR_GRACE_MS : TERMINAL_AGENT_ERROR_GRACE_MS;
	}

	function isRecoverableAssistantError(message: AssistantTurnResult | undefined, ctx: ExtensionContext): boolean {
		if (!message?.errorMessage || message.stopReason !== "error") return false;
		return isContextOverflowAssistant(message, ctx) || isRetryableAgentError(message.errorMessage);
	}

	function isContextOverflowAssistant(message: AssistantTurnResult, ctx: ExtensionContext): boolean {
		try {
			return isContextOverflow(message as Parameters<typeof isContextOverflow>[0], ctx.model?.contextWindow ?? 0);
		} catch {
			return /context.?overflow|context.?window|context.?length|maximum.?context|token.?limit|too many tokens/i.test(message.errorMessage || "");
		}
	}

	function isRetryableAgentError(message: string): boolean {
		if (/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(message)) return false;
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(message);
	}

	function forwardCompactionStart(reason?: CompactionReason): void {
		compactionInProgress = true;
		broker.forward({ type: "compaction_start", timestamp: Date.now(), reason });
	}

	function forwardCompactionEnd(options: {
		reason?: CompactionReason;
		result?: { summary?: string; firstKeptEntryId?: string; tokensBefore?: number; details?: unknown };
		aborted?: boolean;
		willRetry?: boolean;
		errorMessage?: string;
		attention?: boolean;
	}): void {
		if (!compactionInProgress && !options.result && !options.errorMessage && !options.aborted) return;
		compactionInProgress = false;
		broker.forward({ type: "compaction_end", timestamp: Date.now(), ...options });
	}

	async function handleSlashInput(rawText: string, ctx: ExtensionContext): Promise<SlashRouteResult> {
		if (!rawText.startsWith("/")) return { handled: false };
		const parsed = parseSlashInput(rawText);
		const command = parsed.command.toLowerCase();

		if (command === "stop") {
			if (currentAbort) {
				if (queuedSlackTurns.length > 0) preserveQueuedTurnsAsHistory = true;
				currentAbort();
				broker.forward({ type: "agent_finished", timestamp: Date.now(), stopReason: "aborted", attention: true });
			} else {
				forwardCasperNotice("No active turn to stop.");
			}
			broker.sendSessionUpdate(ctx);
			return { handled: true };
		}

		if (command === "compact") {
			if (!ctx.isIdle()) {
				forwardCasperNotice("Cannot compact while pi is busy. Send /stop first.");
				return { handled: true };
			}
			forwardCompactionStart("manual");
			ctx.compact({
				onError: (error) => {
					forwardCompactionEnd({
						reason: "manual",
						aborted: error.name === "AbortError" || error.message === "Compaction cancelled",
						errorMessage: error.name === "AbortError" || error.message === "Compaction cancelled" ? undefined : error.message,
						attention: true,
					});
					sendNextQueuedSlackTurnIfReady(ctx);
				},
			});
			return { handled: true };
		}

		if (command === "status") {
			forwardCasperNotice(await handleSessionStatusCommand(ctx));
			return { handled: true };
		}

		if (command === "casper-status") {
			forwardCasperNotice(await handleCasperStatusText(ctx));
			return { handled: true };
		}

		if (command === "reload") {
			const reload = (ctx as ExtensionContext & { reload?: () => Promise<void> | void }).reload;
			if (typeof reload !== "function") {
				forwardCasperNotice("Slack /reload is not available in this Pi runtime. Run /reload in the local TUI.");
				return { handled: true };
			}
			forwardCasperNotice("Reloading pi extensions, skills, prompts, and themes.", false);
			await reload.call(ctx);
			return { handled: true };
		}

		const skillName = parseSkillSlashName(parsed.command);
		if (skillName) {
			const expanded = await expandSkillSlashInput(skillName, parsed.args);
			return expanded ? { handled: false, text: expanded } : { handled: true };
		}

		const prompt = findSlashCommand(parsed.command);
		if (prompt?.source === "prompt") {
			const expanded = await expandPromptTemplateSlashInput(prompt, parsed.args);
			return expanded ? { handled: false, text: expanded } : { handled: true };
		}

		const knownCommand = findSlashCommand(parsed.command);
		if (knownCommand?.source === "extension") {
			forwardCasperNotice(`/${parsed.command} is an extension command. Casper can run /stop, /status, /casper-status, /compact, and /reload from Slack; run /${parsed.command} in the local TUI for now.`);
			return { handled: true };
		}

		return { handled: false };
	}

	async function handleCasperStatusText(ctx: ExtensionContext): Promise<string> {
		config = await ensureBrokerSecret(await readConfig());
		if (config.botToken && config.appToken && !broker.connected) {
			await broker.connect(ctx).catch(() => undefined);
			startSessionUpdates(ctx);
		}
		broker.sendSessionUpdate(ctx);
		const brokerStatus = broker.connected ? await broker.request<BrokerStatus>({ v: 1, type: "get_status", id: randomUUID() }).catch(() => undefined) : undefined;
		const lines = [
			"Casper Slack bridge",
			`Configured: ${config.botToken && config.appToken ? "yes" : "no"}`,
			`Bot user: ${brokerStatus?.botUserId ?? config.botUserId ?? "unknown"}`,
			`Mention user: ${brokerStatus?.userId ?? config.userId ?? "not set"}`,
			`Broker: ${broker.connected ? `running${brokerStatus ? ` (pid ${brokerStatus.brokerPid})` : ""}` : "stopped"}`,
			`Socket Mode: ${brokerStatus?.socketConnected ? "connected" : "disconnected"}`,
			`This session channel: ${broker.channelName ? `#${broker.channelName}` : broker.connected ? "pending" : "not registered"}`,
			`Config: ${CONFIG_PATH}`,
			`Active Slack turn: ${activeSlackTurn ? "yes" : "no"}`,
			`Queued Slack turns: ${queuedSlackTurns.length}`,
			...formatCommunicationAgentStatus(brokerStatus?.communicationAgent),
		];
		if (brokerStatus?.lastError) lines.push(`Last error: ${brokerStatus.lastError}`);
		lines.push("", `Connected sessions: ${brokerStatus?.sessions.length ?? (broker.connected ? "unknown" : 0)}`);
		if (brokerStatus?.sessions.length) lines.push(...brokerStatus.sessions.map(formatStatusSession));
		return lines.join("\n");
	}

	async function uploadFileToSlack(params: { path: string; title?: string; comment?: string }, ctx: ExtensionContext): Promise<CasperUploadFileToolResult> {
		const filePath = resolve(ctx.cwd, params.path);
		assertSafeUploadPath(filePath);
		const stats = await stat(filePath);
		if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);

		config = await ensureBrokerSecret(await readConfig());
		if (!config.botToken || !config.appToken) throw new Error("Casper Slack bridge is not configured.");
		if (!broker.connected) {
			await broker.connect(ctx);
			startSessionUpdates(ctx);
		}
		broker.sendSessionUpdate(ctx);

		const result = await broker.request<BrokerUploadFileResult>({
			v: 1,
			type: "upload_file",
			id: randomUUID(),
			sessionId: ctx.sessionManager.getSessionId(),
			path: filePath,
			title: params.title?.trim() || undefined,
			comment: params.comment?.trim() || undefined,
		}, 60_000);

		return { ...result, path: filePath };
	}

	function parseSlashInput(text: string): { command: string; args: string } {
		const trimmed = text.trim();
		const spaceIndex = trimmed.search(/\s/);
		const command = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
		const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
		return { command, args };
	}

	function findSlashCommand(name: string): SlashCommandInfo | undefined {
		return pi.getCommands().find((command) => command.name === name);
	}

	function parseSkillSlashName(command: string): string | undefined {
		if (command.startsWith("skill:")) return command.slice("skill:".length);
		if (command.startsWith("skills:")) return command.slice("skills:".length);
		return undefined;
	}

	async function expandSkillSlashInput(skillName: string, args: string): Promise<string | undefined> {
		const command = findSlashCommand(`skill:${skillName}`) ?? findSlashCommand(`skills:${skillName}`);
		if (!command || command.source !== "skill") {
			forwardCasperNotice(`Unknown skill: ${skillName}`);
			return undefined;
		}
		const filePath = command.sourceInfo.path;
		try {
			const body = stripFrontmatter(await readFile(filePath, "utf8")).trim();
			const baseDir = command.sourceInfo.baseDir || dirname(filePath);
			const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (error) {
			forwardCasperNotice(`Failed to load skill ${skillName}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async function expandPromptTemplateSlashInput(command: SlashCommandInfo, args: string): Promise<string | undefined> {
		try {
			const content = stripFrontmatter(await readFile(command.sourceInfo.path, "utf8")).trim();
			return substitutePromptArgs(content, parseCommandArgs(args));
		} catch (error) {
			forwardCasperNotice(`Failed to load prompt ${command.name}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	function parseCommandArgs(args: string): string[] {
		const values: string[] = [];
		let current = "";
		let quote: "'" | '"' | undefined;
		let escaping = false;
		for (const char of args) {
			if (escaping) {
				current += char;
				escaping = false;
				continue;
			}
			if (char === "\\") {
				escaping = true;
				continue;
			}
			if (quote) {
				if (char === quote) quote = undefined;
				else current += char;
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
			if (/\s/.test(char)) {
				if (current) values.push(current);
				current = "";
				continue;
			}
			current += char;
		}
		if (escaping) current += "\\";
		if (current) values.push(current);
		return values;
	}

	function substitutePromptArgs(content: string, args: string[]): string {
		const allArgs = args.join(" ");
		return content
			.replace(/\$ARGUMENTS/g, allArgs)
			.replace(/\$@/g, allArgs)
			.replace(/\$\{(\d+):-([^}]*)\}/g, (_match, index: string, fallback: string) => args[Number(index) - 1] || fallback)
			.replace(/\$(\d+)/g, (_match, index: string) => args[Number(index) - 1] || "");
	}

	async function dispatchBrokerTurn(delivery: Extract<BrokerToClient, { type: "deliver_turn" }>, ctx: ExtensionContext): Promise<void> {
		const rawText = delivery.text.trim();
		const lower = rawText.toLowerCase();
		const slashResult = await handleSlashInput(rawText, ctx);
		if (slashResult.handled) return;
		const routedDelivery = slashResult.text === undefined ? delivery : { ...delivery, text: slashResult.text };

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

		const pendingAsk = getPendingExternalAsk(ctx) ?? (waitingAskUserToolCalls.size > 0 ? await waitForPendingExternalAsk(ctx) : undefined);
		if (pendingAsk && rawText) {
			const result = pendingAsk.submitText(rawText);
			if (!result.ok) {
				broker.forward({
					type: "tool_waiting",
					timestamp: Date.now(),
					toolCallId: `slack-ask-user-${Date.now()}`,
					toolName: "ask_user",
					args: { questions: pendingAsk.questions },
					text: result.error || "Could not parse ask_user answer.",
					attention: true,
				});
			}
			return;
		}

		const waitingAskArgs = [...waitingAskUserToolCalls.values()].at(-1);
		if (waitingAskArgs && rawText) {
			broker.forward({
				type: "tool_waiting",
				timestamp: Date.now(),
				toolCallId: `slack-ask-user-unsupported-${Date.now()}`,
				toolName: "ask_user",
				args: waitingAskArgs,
				text: "This input prompt is controlled by the local Pi runtime and cannot be answered from Slack. Answer it in the local Pi prompt.",
				attention: true,
			});
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedSlackTurns.splice(0) : [];
		for (const historyTurn of historyTurns) slackPromptTexts.delete(normalizePromptText(historyTurn.promptText));
		preserveQueuedTurnsAsHistory = false;
		const turn = await createSlackTurn(routedDelivery, historyTurns);
		slackPromptTexts.add(normalizePromptText(turn.promptText));
		const idle = ctx.isIdle();
		if (compactionInProgress) {
			queuedSlackTurns.push(turn);
			broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: "Queued your Slack message until context compaction finishes.", display: true }, attention: true });
			broker.sendSessionUpdate(ctx);
			return;
		}
		if (idle) queuedSlackTurns.push(turn);
		broker.sendSessionUpdate(ctx);
		sendUserMessageSafely(turn.content, idle ? undefined : "steer");
	}

	async function dispatchPlanAction(message: Extract<BrokerToClient, { type: "plan_action" }>, ctx: ExtensionContext): Promise<void> {
		const pendingPlan = getPendingExternalPlanReview(ctx);
		if (!pendingPlan) {
			broker.send({
				v: 1,
				type: "plan_action_result",
				requestId: message.requestId,
				channelId: message.channelId,
				ok: false,
				error: "No active plan review is waiting in this session.",
			});
			return;
		}
		if (message.planFilePath && pendingPlan.planFilePath !== message.planFilePath) {
			broker.send({
				v: 1,
				type: "plan_action_result",
				requestId: message.requestId,
				channelId: message.channelId,
				ok: false,
				error: "That Slack plan card no longer matches the active plan.",
			});
			return;
		}
		const result = pendingPlan.submitDecision(message.action, message.feedback);
		broker.send({
			v: 1,
			type: "plan_action_result",
			requestId: message.requestId,
			channelId: message.channelId,
			ok: result.ok,
			message: result.ok ? planActionSuccessMessage(message.action) : undefined,
			error: result.error,
		});
	}

	async function dispatchAskUserAction(message: Extract<BrokerToClient, { type: "ask_user_action" }>, ctx: ExtensionContext): Promise<void> {
		const pendingAsk = getPendingExternalAsk(ctx);
		if (!pendingAsk) {
			broker.send({
				v: 1,
				type: "ask_user_action_result",
				requestId: message.requestId,
				channelId: message.channelId,
				ok: false,
				error: "No bridge-backed ask_user prompt is waiting in this session.",
			});
			return;
		}
		if (pendingAsk.promptId !== message.promptId) {
			broker.send({
				v: 1,
				type: "ask_user_action_result",
				requestId: message.requestId,
				channelId: message.channelId,
				ok: false,
				error: "That Slack ask_user prompt no longer matches the active prompt.",
			});
			return;
		}
		const result = pendingAsk.submitResponse(message.response);
		broker.send({
			v: 1,
			type: "ask_user_action_result",
			requestId: message.requestId,
			channelId: message.channelId,
			ok: result.ok,
			message: result.ok ? askUserActionSuccessMessage(message.response) : undefined,
			error: result.error,
		});
	}

	function askUserActionSuccessMessage(response: BrokerAskUserResponse): string {
		return response === null ? "ask_user prompt cancelled." : "ask_user answer submitted.";
	}

	function planActionSuccessMessage(action: "approve" | "refine" | "exit"): string {
		if (action === "approve") return "Plan approved. Starting execution.";
		if (action === "refine") return "Plan feedback submitted.";
		return "Plan mode exited.";
	}

	async function waitForPendingExternalAsk(ctx: ExtensionContext): Promise<ExternalAskPrompt | undefined> {
		for (let attempt = 0; attempt < 5; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			const pendingAsk = getPendingExternalAsk(ctx);
			if (pendingAsk) return pendingAsk;
		}
		return undefined;
	}

	function clearAskUserForwardTimer(toolCallId: string): void {
		const timer = askUserForwardTimers.get(toolCallId);
		if (!timer) return;
		clearTimeout(timer);
		askUserForwardTimers.delete(toolCallId);
	}

	function clearAskUserForwardTimers(): void {
		for (const timer of askUserForwardTimers.values()) clearTimeout(timer);
		askUserForwardTimers.clear();
	}

	function scheduleAskUserForward(toolCallId: string, args: unknown, ctx: ExtensionContext): void {
		clearAskUserForwardTimer(toolCallId);
		const timer = setTimeout(() => {
			askUserForwardTimers.delete(toolCallId);
			void forwardAskUserWaiting(toolCallId, args, ctx).catch((error) => {
				if (isStaleContextError(error)) return;
				broker.forward({ type: "message_end", timestamp: Date.now(), message: { role: "custom", customType: "pi-casper", content: `Failed to forward ask_user prompt to Slack: ${error instanceof Error ? error.message : String(error)}`, display: true }, attention: true });
			});
		}, 150);
		timer.unref?.();
		askUserForwardTimers.set(toolCallId, timer);
	}

	async function forwardAskUserWaiting(toolCallId: string, args: unknown, ctx: ExtensionContext): Promise<void> {
		if (forwardedAskUserToolCalls.has(toolCallId)) return;
		forwardedAskUserToolCalls.add(toolCallId);
		clearAskUserForwardTimer(toolCallId);
		const pendingAsk = await waitForPendingExternalAsk(ctx);
		broker.forward({
			type: "tool_waiting",
			timestamp: Date.now(),
			toolCallId,
			toolName: "ask_user",
			args: pendingAsk ? { questions: pendingAsk.questions } : args,
			ask: brokerAskPromptFromExternalAsk(pendingAsk),
			text: getAskUserQuestion(args) ?? "ask_user is waiting for your input.",
			attention: true,
		});
	}

	function sessionNameSource(prompt: string): string {
		let text = prompt.trim();
		text = text
			.replace(/Attachments were saved locally:[\s\S]*$/gi, " ")
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

	function formatCommunicationAgentStatus(status: BrokerStatus["communicationAgent"]): string[] {
		if (!status) return ["Communication agent: unknown"];
		const state = status.isIdle ? "idle" : "busy";
		const activeTurn = status.activeTurn ? `${status.activeTurn.channelId} (${status.activeTurn.requestId})` : "none";
		const lines = [
			`Communication agent: ${status.enabled ? state : "disabled"}`,
			`Communication agent queue: ${status.pendingMessages}`,
			`Communication agent active channel turn: ${activeTurn}`,
		];
		if (status.lastError) lines.push(`Communication agent last error: ${status.lastError}`);
		return lines;
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
		dispatchPlanAction,
		dispatchAskUserAction,
		updateStatus,
	);

	function startCasperSession(ctx: ExtensionContext): void {
		const token = ++sessionStartupToken;
		brokerConnecting = true;
		updateStatus(ctx);
		void initializeCasperSession(ctx, token);
	}

	async function initializeCasperSession(ctx: ExtensionContext, token: number): Promise<void> {
		let errorStatusShown = false;
		try {
			config = await ensureBrokerSecret(await readConfig());
			await mkdir(TEMP_DIR, { recursive: true });
			if (token !== sessionStartupToken) return;
			if (!config.botToken || !config.appToken) return;
			await broker.connect(ctx);
			if (token !== sessionStartupToken) return;
			startSessionUpdates(ctx);
			broker.forward({ type: "session_started", timestamp: Date.now() });
		} catch (error) {
			if (token !== sessionStartupToken || isStaleContextError(error)) return;
			const message = error instanceof Error ? error.message : String(error);
			brokerConnecting = false;
			updateStatus(ctx, message);
			errorStatusShown = true;
			return;
		} finally {
			if (token === sessionStartupToken && !errorStatusShown) {
				brokerConnecting = false;
				updateStatus(ctx);
			}
		}
	}

	pi.events.on(PLAN_READY_EVENT, (event) => {
		const ctx = currentCtx;
		if (!ctx || isEphemeralSession(ctx)) return;
		const parsed = parsePlanReadyEvent(event);
		if (!parsed) return;
		broker.forward({ type: "plan_ready", timestamp: Date.now(), attention: true, ...parsed });
	});

	pi.events.on(PLAN_CLOSED_EVENT, (event) => {
		const ctx = currentCtx;
		if (!ctx || isEphemeralSession(ctx)) return;
		const parsed = parsePlanClosedEvent(event);
		if (!parsed) return;
		broker.forward({ type: "plan_closed", timestamp: Date.now(), ...parsed });
	});

	pi.registerTool({
		name: CASPER_UPLOAD_FILE_TOOL,
		label: "Casper Upload File",
		description: "Upload a local file from this pi session to the mapped Slack channel. Use when the user asks to receive a generated artifact, report, screenshot, PDF, archive, or other local file in Slack.",
		promptSnippet: "Upload a local file to this session's mapped Slack channel.",
		promptGuidelines: [
			"When the user asks to receive a generated artifact or local file in Slack, call casper_upload_file with the local path instead of only mentioning the path in text.",
			"Upload only files that are meant for the user; do not upload secrets, environment files, private keys, token dumps, or unrelated workspace files.",
			"casper_upload_file always uploads to this pi session's mapped Slack channel; do not ask for or infer a Slack channel ID.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Local file path to upload to Slack.", minLength: 1 }),
			title: Type.Optional(Type.String({ description: "Optional Slack file title. Defaults to the file name.", minLength: 1, maxLength: 200 })),
			comment: Type.Optional(Type.String({ description: "Optional short message to include with the uploaded file.", minLength: 1, maxLength: 1000 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await uploadFileToSlack(params, ctx);
			return {
				content: [{ type: "text", text: `Uploaded ${result.fileName} to Slack.` }],
				details: result,
			};
		},
	});

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
				...formatCommunicationAgentStatus(brokerStatus?.communicationAgent),
			];
			if (brokerStatus?.lastError) lines.push(`Last error: ${brokerStatus.lastError}`);
			lines.push("", `Connected sessions: ${brokerStatus?.sessions.length ?? (broker.connected ? "unknown" : 0)}`);
			if (brokerStatus?.sessions.length) lines.push(...brokerStatus.sessions.map(formatStatusSession));
			ctx.ui.notify(lines.join("\n"), brokerStatus?.lastError ? "warning" : "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		setCurrentCtx(ctx);
		waitingAskUserToolCalls.clear();
		forwardedAskUserToolCalls.clear();
		clearAskUserForwardTimers();
		assistantStreamId = undefined;
		compactionInProgress = false;
		if (isEphemeralSession(ctx)) {
			updateStatus(ctx);
			return;
		}
		startCasperSession(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		sessionStartupToken++;
		brokerConnecting = false;
		clearPendingAgentFinished();
		if (broker.connected && event.reason !== "reload") {
			broker.send({ v: 1, type: "session_closed", sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
		}
		queuedSlackTurns = [];
		activeSlackTurn = undefined;
		currentAbort = undefined;
		currentCtx = undefined;
		assistantStreamId = undefined;
		waitingAskUserToolCalls.clear();
		forwardedAskUserToolCalls.clear();
		clearAskUserForwardTimers();
		slackPromptTexts.clear();
		preserveQueuedTurnsAsHistory = false;
		stopSessionUpdates();
		broker.close();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setCurrentCtx(ctx);
		clearPendingAgentFinished();
		maybeNameSessionFromPrompt(event.prompt, ctx);
		return { systemPrompt: `${event.systemPrompt}${SYSTEM_PROMPT_SUFFIX}` };
	});

	pi.on("agent_start", async (_event, ctx) => {
		setCurrentCtx(ctx);
		clearPendingAgentFinished();
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
			clearPendingAgentFinished();
			assistantStreamId = randomUUID();
			broker.forward({ type: "message_start", timestamp: Date.now(), streamId: assistantStreamId, message: event.message });
		}
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!assistantStreamId || !isAssistantMessage(event.message as PiTextMessage)) return;
		broker.forward({ type: "message_update", timestamp: Date.now(), streamId: assistantStreamId, message: event.message });
	});

	pi.on("session_before_compact", async (event, ctx) => {
		setCurrentCtx(ctx);
		forwardCompactionStart();
		event.signal.addEventListener(
			"abort",
			() => {
				forwardCompactionEnd({ aborted: true, attention: true });
				sendNextQueuedSlackTurnIfReady(ctx);
			},
			{ once: true },
		);
		broker.sendSessionUpdate(ctx);
		updateStatus(ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		setCurrentCtx(ctx);
		clearPendingAgentFinished();
		forwardCompactionEnd({
			result: {
				summary: event.compactionEntry.summary,
				firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
				tokensBefore: event.compactionEntry.tokensBefore,
				details: event.compactionEntry.details,
			},
		});
		broker.sendSessionUpdate(ctx);
		updateStatus(ctx);
		sendNextQueuedSlackTurnIfReady(ctx);
	});

	pi.on("message_end", async (event, _ctx) => {
		const role = getMessageRole(event.message);
		const text = getMessageText(event.message as AgentMessage);
		if (role === "user" && consumeSlackPromptText(text)) return;
		if (role === "assistant") {
			broker.forward({ type: "message_end", timestamp: Date.now(), streamId: assistantStreamId, message: event.message });
			assistantStreamId = undefined;
			return;
		}
		broker.forward({ type: "message_end", timestamp: Date.now(), message: event.message });
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (SLACK_SILENT_TOOLS.has(event.toolName)) return;
		if (event.toolName === "ask_user") {
			waitingAskUserToolCalls.set(event.toolCallId, event.args);
			scheduleAskUserForward(event.toolCallId, event.args, ctx);
			return;
		}
		broker.forward({ type: "tool_start", timestamp: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (event.toolName !== "ask_user") return;
		if (forwardedAskUserToolCalls.has(event.toolCallId)) return;
		if (!/waiting for user input/i.test(getToolUpdateText(event.partialResult))) return;
		waitingAskUserToolCalls.set(event.toolCallId, event.args);
		await forwardAskUserWaiting(event.toolCallId, event.args, ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (SLACK_SILENT_TOOLS.has(event.toolName)) return;
		if (event.toolName === "ask_user") {
			waitingAskUserToolCalls.delete(event.toolCallId);
			forwardedAskUserToolCalls.delete(event.toolCallId);
			clearAskUserForwardTimer(event.toolCallId);
		}
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
		const lastAssistant = [...event.messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as AssistantTurnResult | undefined;
		forwardAgentFinished({
			type: "agent_finished",
			timestamp: Date.now(),
			stopReason: lastAssistant?.stopReason,
			errorMessage: lastAssistant?.errorMessage,
			attention: true,
		}, ctx, lastAssistant);
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
