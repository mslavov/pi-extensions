import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	BROKER_SOCKET_PATH,
	CONFIG_PATH,
	MAX_ATTACHMENTS_PER_TURN,
	OLD_CONFIG_PATH,
	TELEGRAM_DIR,
	TELEGRAM_PREFIX,
	TELEGRAM_PROGRESS_MAX_LENGTH,
	TEMP_DIR,
	type BrokerStatus,
	type BrokerPresenceStatus,
	type BrokerToClient,
	type ClientToBroker,
	type DownloadedTelegramFile,
	type QueuedAttachment,
	type SessionSnippet,
	type TelegramConfig,
	type TelegramNotificationKind,
} from "./protocol.js";
import {
	LEGACY_NOTIFY_EVENT,
	PI_NOTIFY_EVENT,
	parsePiNotifyEvent,
	type PiNotifyEventV1,
} from "./notify-contract.js";

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface PendingTelegramTurn {
	requestId: string;
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

type TelegramPreviewTextMessage = AgentMessage & { role?: string };

interface TelegramProgressSendResult {
	sent: boolean;
	queued?: boolean;
	message?: string;
	reason?: string;
	presence?: BrokerPresenceStatus;
	queuedCount?: number;
}

interface TelegramFileSendResult {
	sent: boolean;
	sentCount?: number;
	failedCount?: number;
	reason?: string;
	results?: Array<{ fileName: string; ok: boolean; messageId?: number; error?: string }>;
}

const TELEGRAM_ERROR_NOTIFY_DELAY_MS = 20_000;
const SESSION_UPDATE_INTERVAL_MS = 5_000;
const SESSION_HISTORY_LIMIT = 12;
const SESSION_HISTORY_TEXT_LIMIT = 800;
const TELEGRAM_FILE_SEND_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- Some [telegram] messages are delegated by the persistent Telegram communication agent on the user's behalf.
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If the user asked to receive a file or generated artifact through Telegram, call telegram_send_file with the local path instead of only mentioning the path.
- telegram_send_file works for Telegram-originated and locally-started turns when the bridge is paired.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function ensureTelegramDir(): Promise<void> {
	await mkdir(TELEGRAM_DIR, { recursive: true });
}

async function migrateConfig(): Promise<void> {
	await ensureTelegramDir();
	try {
		await stat(CONFIG_PATH);
		return;
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
	try {
		await rename(OLD_CONFIG_PATH, CONFIG_PATH);
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
}

async function readConfig(): Promise<TelegramConfig> {
	await migrateConfig();
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		return JSON.parse(content) as TelegramConfig;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await migrateConfig();
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

async function ensureBrokerSecret(config: TelegramConfig): Promise<TelegramConfig> {
	if (config.brokerSecret) return config;
	const nextConfig = { ...config, brokerSecret: randomBytes(32).toString("hex") };
	await writeConfig(nextConfig);
	return nextConfig;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function isStaleContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("captured pi or command ctx");
}

function getMessageText(message: AgentMessage): string {
	const value = message as unknown as Record<string, unknown>;
	const content = Array.isArray(value.content) ? value.content : [];
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("")
		.trim();
}

function isAssistantMessage(message: TelegramPreviewTextMessage): boolean {
	return message.role === "assistant";
}

function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as unknown as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
		return { text: text || undefined, stopReason, errorMessage };
	}
	return {};
}

function clampProgressText(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	return normalized.length > TELEGRAM_PROGRESS_MAX_LENGTH ? normalized.slice(0, TELEGRAM_PROGRESS_MAX_LENGTH).trimEnd() : normalized;
}

function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
	let summary = rawText.length > 0 ? rawText : "(no text)";
	if (files.length > 0) {
		summary += `\nAttachments:`;
		for (const file of files) {
			summary += `\n- ${file.path}`;
		}
	}
	return summary;
}

async function createTelegramTurn(
	delivery: Extract<BrokerToClient, { type: "deliver_turn" }>,
	historyTurns: PendingTelegramTurn[] = [],
): Promise<PendingTelegramTurn> {
	const rawText = delivery.rawText.trim();
	const files = delivery.files;
	const content: Array<TextContent | ImageContent> = [];
	let prompt = `${TELEGRAM_PREFIX}`;
	const delegatedByCommunicationAgent = delivery.source === "communication_agent";

	if (delegatedByCommunicationAgent) {
		prompt += `\n\nThe Telegram communication agent delegated this user request to this pi session. Respond to the Telegram user through the normal Telegram bridge flow.`;
	}

	if (historyTurns.length > 0) {
		prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
		for (const [index, turn] of historyTurns.entries()) {
			prompt += `\n\n${index + 1}. ${turn.historyText}`;
		}
		prompt += `\n\nCurrent Telegram message:`;
	}

	if (rawText.length > 0) {
		prompt += historyTurns.length > 0 || delegatedByCommunicationAgent ? `\n${rawText}` : ` ${rawText}`;
	}
	if (files.length > 0) {
		prompt += `\n\nTelegram attachments were saved locally:`;
		for (const file of files) {
			prompt += `\n- ${file.path}`;
		}
	}
	content.push({ type: "text", text: prompt });

	for (const file of files) {
		if (!file.isImage) continue;
		const mediaType = file.mimeType || guessMediaType(file.path);
		if (!mediaType) continue;
		const buffer = await readFile(file.path);
		content.push({
			type: "image",
			data: buffer.toString("base64"),
			mimeType: mediaType,
		});
	}

	return {
		requestId: delivery.requestId,
		chatId: delivery.chatId,
		replyToMessageId: delivery.replyToMessageId,
		queuedAttachments: [],
		content,
		historyText: formatTelegramHistoryText(rawText, files),
	};
}

class BrokerClient {
	private socket: Socket | undefined;
	private buffer = "";
	private requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	connected = false;
	paired = false;
	lastError: string | undefined;

	constructor(
		private readonly connectionId: string,
		private readonly getSecret: () => string | undefined,
		private readonly getSnapshot: (ctx: ExtensionContext) => Omit<ClientToBroker & { type: "hello" }, "v" | "type" | "brokerSecret">,
		private readonly onDeliverTurn: (delivery: Extract<BrokerToClient, { type: "deliver_turn" }>, ctx: ExtensionContext) => Promise<void>,
		private readonly updateStatus: (ctx: ExtensionContext, error?: string) => void,
	) {}

	async connect(ctx: ExtensionContext): Promise<void> {
		if (this.connected) {
			this.sendSessionUpdate(ctx);
			return;
		}
		this.clearReconnectTimer();
		await ensureBrokerProcess();
		await this.openSocket(ctx);
	}

	close(): void {
		this.clearReconnectTimer();
		this.socket?.destroy();
		this.socket = undefined;
		this.connected = false;
	}

	sendSessionUpdate(ctx: ExtensionContext): void {
		if (!this.connected) return;
		let snapshot: Omit<ClientToBroker & { type: "hello" }, "v" | "type" | "brokerSecret">;
		try {
			snapshot = this.getSnapshot(ctx);
		} catch (error) {
			if (isStaleContextError(error)) {
				this.close();
				return;
			}
			throw error;
		}
		this.send({ v: 1, type: "session_update", ...snapshot });
	}

	send(message: ClientToBroker): void {
		if (!this.socket?.writable) return;
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	async request<T = unknown>(message: ClientToBroker & { id: string }, timeoutMs = 8000): Promise<T> {
		if (!this.socket?.writable) throw new Error("Telegram broker is not connected");
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.requests.delete(message.id);
				reject(new Error("Telegram broker request timed out"));
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
		const secret = this.getSecret();
		if (!secret) throw new Error("Telegram broker secret is missing");
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
				let snapshot: Omit<ClientToBroker & { type: "hello" }, "v" | "type" | "brokerSecret">;
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
				this.updateStatus(ctx);
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
						this.updateStatus(ctx, this.lastError);
					});
				} catch (error) {
					if (isStaleContextError(error)) {
						this.close();
						return;
					}
					this.lastError = error instanceof Error ? error.message : String(error);
					this.updateStatus(ctx, this.lastError);
				}
			}
		});
		socket.on("close", () => {
			this.connected = false;
			this.socket = undefined;
			this.rejectAllRequests(new Error("Telegram broker unavailable"));
			this.updateStatus(ctx);
			this.scheduleReconnect(ctx);
		});
		socket.on("error", (error) => {
			this.lastError = error.message;
			this.updateStatus(ctx, error.message);
		});
	}

	private async handleMessage(message: BrokerToClient, ctx: ExtensionContext): Promise<void> {
		if (message.type === "hello_ack") {
			this.paired = message.paired;
			this.updateStatus(ctx);
			return;
		}
		if (message.type === "response") {
			const request = this.requests.get(message.id);
			if (!request) return;
			this.requests.delete(message.id);
			if (message.ok) {
				request.resolve(message.result);
			} else {
				request.reject(new Error(message.error || "Telegram broker request failed"));
			}
			return;
		}
		if (message.type === "deliver_turn") {
			await this.onDeliverTurn(message, ctx);
		}
	}

	private scheduleReconnect(ctx: ExtensionContext): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect(ctx).catch((error) => {
				if (isStaleContextError(error)) return;
				this.lastError = error instanceof Error ? error.message : String(error);
				this.updateStatus(ctx, this.lastError);
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
		for (const request of this.requests.values()) {
			request.reject(error);
		}
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
	await ensureTelegramDir();
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
	throw new Error("Telegram broker did not start");
}

export default function (pi: ExtensionAPI) {
	const connectionId = randomUUID();
	let config: TelegramConfig = {};
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let pendingLocalErrorTimer: ReturnType<typeof setTimeout> | undefined;
	let sessionUpdateInterval: ReturnType<typeof setInterval> | undefined;
	let currentCtx: ExtensionContext | undefined;
	const sentNotifyDedupeKeys = new Map<string, number>();
	const waitingAskUserToolCalls = new Set<string>();

	function updateStatus(ctx: ExtensionContext, _error?: string): void {
		try {
			ctx.ui.setStatus("telegram", undefined);
		} catch (error) {
			if (isStaleContextError(error)) return;
			throw error;
		}
	}

	function setCurrentCtx(ctx: ExtensionContext): void {
		currentCtx = ctx;
	}

	function isEphemeralSession(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getSessionFile() === undefined;
	}

	function formatNotifyMessage(event: PiNotifyEventV1): string {
		return event.title ? `${event.title}: ${event.message}` : event.message;
	}

	function redactNotificationText(text: string): string {
		return text
			.replace(/\b(?:sk|pk|ghp|gho|github_pat)_[A-Za-z0-9_\-]{12,}\b/g, "[redacted]")
			.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
			.replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, "[redacted]");
	}

	function summarizeAssistantForNotification(text: string | undefined): string {
		if (!text) return "Turn completed";
		const firstSentence = text.match(/^[^.!?\n]+[.!?]?/)?.[0] ?? text;
		const summary = firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}...` : firstSentence;
		return redactNotificationText(summary.trim() || "Turn completed");
	}

	function getAskUserQuestion(args: unknown): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		const question = (args as { question?: unknown }).question;
		return typeof question === "string" && question.trim() ? question.trim() : undefined;
	}

	function getToolUpdateText(partialResult: unknown): string {
		if (!partialResult || typeof partialResult !== "object") return "";
		return getTextFromContent((partialResult as { content?: unknown }).content).trim();
	}

	function notifyDedupeKey(event: PiNotifyEventV1): string {
		return event.dedupeKey ?? `${event.source}:${event.kind ?? "notify"}:${event.title ?? ""}:${event.message}`;
	}

	function telegramNotificationKind(event: PiNotifyEventV1): TelegramNotificationKind {
		if (event.kind === "ready") return "completion";
		if (event.kind === "waiting") return "waiting";
		return "notify";
	}

	async function handleNotifyEvent(rawEvent: unknown, ctx: ExtensionContext): Promise<void> {
		const event = parsePiNotifyEvent(rawEvent);
		if (!event) return;
		if (isEphemeralSession(ctx)) return;
		if (activeTelegramTurn && event.suppressForTelegramOriginated !== false) return;

		const key = notifyDedupeKey(event);
		const now = Date.now();
		const minIntervalMs = event.minIntervalMs ?? 30_000;
		const previous = sentNotifyDedupeKeys.get(key);
		if (previous !== undefined && now - previous < minIntervalMs) return;
		if (sentNotifyDedupeKeys.size > 200) sentNotifyDedupeKeys.clear();
		sentNotifyDedupeKeys.set(key, now);

		await sendTelegramProgress(formatNotifyMessage(event), ctx, telegramNotificationKind(event));
	}

	function installNotifyListener(eventName: typeof PI_NOTIFY_EVENT | typeof LEGACY_NOTIFY_EVENT): void {
		pi.events.on(eventName, (event) => {
			const ctx = currentCtx;
			if (!ctx) return;
			void handleNotifyEvent(event, ctx).catch((error) => {
				if (isStaleContextError(error)) return;
			});
		});
	}

	function sendUserMessageSafely(content: Array<TextContent | ImageContent>): void {
		try {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		} catch (error) {
			if (isStaleContextError(error)) return;
			throw error;
		}
	}

	function countQueuedByChat(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const turn of queuedTelegramTurns) {
			counts[String(turn.chatId)] = (counts[String(turn.chatId)] ?? 0) + 1;
		}
		return counts;
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

	function getTextFromContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("");
	}

	function buildSessionSnapshot(ctx: ExtensionContext): Omit<ClientToBroker & { type: "hello" }, "v" | "type" | "brokerSecret"> {
		return {
			connectionId,
			sessionId: ctx.sessionManager.getSessionId(),
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			sessionName: ctx.sessionManager.getSessionName(),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			isIdle: ctx.isIdle(),
			activeTurn: activeTelegramTurn ? { requestId: activeTelegramTurn.requestId, chatId: activeTelegramTurn.chatId } : undefined,
			queuedTurns: queuedTelegramTurns.length,
			queuedByChat: countQueuedByChat(),
			recentMessages: buildRecentSessionMessages(ctx),
		};
	}

	async function sendBrokerText(chatId: number, text: string): Promise<void> {
		if (!broker.connected) return;
		await broker.request({ v: 1, type: "send_text", id: randomUUID(), chatId, text, linkToSession: true }).catch(() => undefined);
	}

	async function sendTelegramProgress(text: string, ctx: ExtensionContext, notificationKind: TelegramNotificationKind = "progress"): Promise<TelegramProgressSendResult> {
		const message = clampProgressText(text);
		if (!message) return { sent: false, reason: "Progress message is empty" };
		if (isEphemeralSession(ctx)) {
			return { sent: false, message, reason: "Telegram notifications are disabled for subagent sessions" };
		}
		if (!broker.connected) {
			config = await ensureBrokerSecret(await readConfig());
			if (config.botToken) {
				await broker.connect(ctx).catch(() => undefined);
				startSessionUpdates(ctx);
				broker.sendSessionUpdate(ctx);
			}
		}
		if (!broker.connected) return { sent: false, message, reason: "Telegram broker is not connected" };
		try {
			const result = await broker.request<TelegramProgressSendResult>({ v: 1, type: "send_progress", id: randomUUID(), text: message, notificationKind });
			return result;
		} catch (error) {
			return { sent: false, message, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async function sendTelegramFiles(attachments: QueuedAttachment[], ctx: ExtensionContext): Promise<TelegramFileSendResult> {
		if (!broker.connected) {
			config = await ensureBrokerSecret(await readConfig());
			if (config.botToken) {
				await broker.connect(ctx).catch(() => undefined);
				startSessionUpdates(ctx);
				broker.sendSessionUpdate(ctx);
			}
		}
		if (!broker.connected) return { sent: false, reason: "Telegram broker is not connected" };
		try {
			return await broker.request<TelegramFileSendResult>(
				{ v: 1, type: "send_files", id: randomUUID(), attachments, linkToSession: true },
				TELEGRAM_FILE_SEND_TIMEOUT_MS,
			);
		} catch (error) {
			return { sent: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async function handleSessionStatusCommand(chatId: number, ctx: ExtensionContext): Promise<void> {
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
		if (lines.length === 0) lines.push("No usage data yet.");
		await sendBrokerText(chatId, lines.join("\n"));
	}

	async function dispatchBrokerTurn(delivery: Extract<BrokerToClient, { type: "deliver_turn" }>, ctx: ExtensionContext): Promise<void> {
		const rawText = delivery.rawText.trim();
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) preserveQueuedTurnsAsHistory = true;
				currentAbort();
				updateStatus(ctx);
				broker.sendSessionUpdate(ctx);
				await sendBrokerText(delivery.chatId, "Aborted current turn.");
			} else {
				await sendBrokerText(delivery.chatId, "No active turn.");
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendBrokerText(delivery.chatId, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendBrokerText(delivery.chatId, "Compaction completed.");
				},
				onError: (error) => {
					void sendBrokerText(delivery.chatId, `Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
				},
			});
			await sendBrokerText(delivery.chatId, "Compaction started.");
			return;
		}

		if (lower === "/status") {
			await handleSessionStatusCommand(delivery.chatId, ctx);
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(delivery, historyTurns);
		queuedTelegramTurns.push(turn);
		broker.sendSessionUpdate(ctx);
		if (ctx.isIdle()) {
			updateStatus(ctx);
			sendUserMessageSafely(turn.content);
		}
	}

	function clearPendingLocalErrorNotification(): void {
		if (!pendingLocalErrorTimer) return;
		clearTimeout(pendingLocalErrorTimer);
		pendingLocalErrorTimer = undefined;
	}

	function scheduleLocalErrorNotification(errorMessage: string): void {
		clearPendingLocalErrorNotification();
		pendingLocalErrorTimer = setTimeout(() => {
			pendingLocalErrorTimer = undefined;
			broker.send({ v: 1, type: "local_error", errorMessage });
		}, TELEGRAM_ERROR_NOTIFY_DELAY_MS);
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = await ensureBrokerSecret({ ...config, botToken: token.trim() });
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot configured: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await broker.connect(ctx);
			await broker.request({ v: 1, type: "reload_config", id: randomUUID() }).catch(() => undefined);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
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

	function slugify(value: string | undefined, fallback: string): string {
		const slug = value
			?.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32);
		return slug || fallback;
	}

	function normalizePromptText(value: string): string {
		return value.replace(/\s+/g, " ").trim();
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

	function sessionNameSource(prompt: string): string {
		let text = prompt.trim().replace(/^\[telegram\]\s*/i, "");
		const currentMessageIndex = text.lastIndexOf("Current Telegram message:");
		if (currentMessageIndex !== -1) {
			text = text.slice(currentMessageIndex + "Current Telegram message:".length);
		}
		text = text.split("Telegram attachments were saved locally:")[0] ?? text;
		text = text
			.replace(/The Telegram communication agent delegated this user request[^\n]*\n?/gi, " ")
			.replace(/Earlier Telegram messages arrived after an aborted turn[^\n]*\n?/gi, " ")
			.replace(/https?:\/\/\S+/g, " ")
			.replace(/[>`*_#[\](){}]/g, " ");
		return normalizePromptText(text);
	}

	function maybeNameSessionFromPrompt(prompt: string, ctx: ExtensionContext): void {
		if (pi.getSessionName() || ctx.sessionManager.getSessionName()) return;
		if (hasPriorUserMessage(ctx, prompt)) return;
		const name = slugify(sessionNameSource(prompt), "");
		if (!name) return;
		pi.setSessionName(name);
		broker.sendSessionUpdate(ctx);
	}

	function formatStatusSession(session: BrokerStatus["sessions"][number]): string {
		const cwdName = basename(session.cwd || "?");
		const fallbackSlug = session.sessionId ? session.sessionId.slice(0, 8) : "session";
		const sessionSlug = slugify(session.sessionName, fallbackSlug);
		const state = session.isIdle ? "idle" : "busy";
		const queued = session.queuedTurns ? `, ${session.queuedTurns} queued` : "";
		const model = session.model ? ` · ${session.model}` : "";
		return `- [${cwdName}:${sessionSlug}] pid ${session.pid} · ${state}${queued}${model}`;
	}

	function formatStatusPresence(presence: BrokerStatus["presence"] | undefined): string[] {
		if (!presence) return ["Presence: unavailable (restart the broker to enable presence status)"];
		const idle = presence.idleSeconds === undefined ? "unknown idle" : `${presence.idleSeconds}s idle`;
		const updated = presence.updatedAt ? ` · updated ${new Date(presence.updatedAt).toLocaleTimeString()}` : "";
		const threshold = `away ≥${presence.awayAfterSeconds}s, present ≤${presence.presentBelowSeconds}s, poll ${presence.pollIntervalSeconds}s`;
		const lines = [
			`Presence: ${presence.state} · ${idle} · ${presence.provider}${presence.enabled ? "" : " disabled"}${updated}`,
			`Presence policy: ${presence.notificationPolicy} (${threshold})`,
		];
		if (presence.lastError) lines.push(`Presence error: ${presence.lastError}`);
		return lines;
	}

	const broker = new BrokerClient(
		connectionId,
		() => config.brokerSecret,
		buildSessionSnapshot,
		dispatchBrokerTurn,
		updateStatus,
	);

	installNotifyListener(PI_NOTIFY_EVENT);
	installNotifyListener(LEGACY_NOTIFY_EVENT);

	pi.registerTool({
		name: "telegram_send_file",
		label: "Telegram Send File",
		description: "Send one or more local files to Telegram.",
		promptSnippet: "Send local files to Telegram.",
		promptGuidelines: [
			"When the user asks to receive a file or generated artifact through Telegram, call telegram_send_file with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to send" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const attachments: QueuedAttachment[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
				attachments.push({ path: inputPath, fileName: basename(inputPath) });
			}

			if (activeTelegramTurn) {
				if (activeTelegramTurn.queuedAttachments.length + attachments.length > MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Telegram file limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push(...attachments);
				return {
					content: [{ type: "text", text: `Queued ${attachments.length} Telegram file(s) to send with the final reply.` }],
					details: { queued: true, paths: attachments.map((attachment) => attachment.path) },
				};
			}

			const result = await sendTelegramFiles(attachments, ctx);
			const sentCount = result.sentCount ?? 0;
			const failedCount = result.failedCount ?? 0;
			const text = result.sent
				? `Sent ${sentCount || attachments.length} Telegram file(s).`
				: sentCount > 0
				? `Sent ${sentCount} Telegram file(s); ${failedCount} failed.`
				: `Failed to send Telegram file(s): ${result.reason ?? "unavailable"}.`;
			return {
				content: [{ type: "text", text }],
				details: { ...result, paths: attachments.map((attachment) => attachment.path) },
			};
		},
	});

	pi.registerTool({
		name: "telegram_progress",
		label: "Telegram Progress",
		description: "Send a brief progress or key-point update to the connected Telegram chat for the active pi session.",
		promptSnippet: "Send a brief progress or key-point update for the broker to deliver, queue, or drop based on Telegram presence policy.",
		promptGuidelines: [
			"Use telegram_progress in locally started sessions for meaningful milestones, blockers, and periodic long-running-work updates; do not try to infer whether the user is present because the broker decides whether to deliver, queue, summarize, or drop each update.",
			"Keep telegram_progress messages short and do not include secrets, tokens, raw command output, or repetitive status.",
			"Do not use telegram_progress for Telegram-originated turns unless the user explicitly asks, because those turns already stream previews.",
		],
		renderShell: "self",
		parameters: Type.Object({
			message: Type.String({ description: "Brief progress update to send", minLength: 1, maxLength: TELEGRAM_PROGRESS_MAX_LENGTH }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await sendTelegramProgress(params.message, ctx);
			const text = result.sent
				? "Sent Telegram progress update."
				: result.queued
				? "Queued Telegram progress update for away summary."
				: `Skipped Telegram progress update: ${result.reason ?? "unavailable"}.`;
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("muted", "↗ Telegram progress"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TelegramProgressSendResult | undefined;
			const state = details?.sent ? "sent" : details?.queued ? "queued" : "held";
			return new Text(theme.fg("muted", `↗ Telegram progress ${state}`), 0, 0);
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			config = await ensureBrokerSecret(await readConfig());
			if (config.botToken && !broker.connected) {
				await broker.connect(ctx).catch(() => undefined);
				startSessionUpdates(ctx);
			}
			broker.sendSessionUpdate(ctx);
			let brokerStatus: BrokerStatus | undefined;
			if (broker.connected) {
				brokerStatus = await broker.request<BrokerStatus>({ v: 1, type: "get_status", id: randomUUID() }).catch(() => undefined);
			}
			const lines = [
				ctx.ui.theme.fg("accent", "Telegram bridge"),
				`Bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`Allowed user: ${brokerStatus?.allowedUserId ?? config.allowedUserId ?? "not paired"}`,
				`Broker: ${broker.connected ? `running${brokerStatus ? ` (pid ${brokerStatus.brokerPid})` : ""}` : "stopped"}`,
				`Polling: ${brokerStatus?.polling ? "running" : "stopped"}`,
				...formatStatusPresence(brokerStatus?.presence),
				`This session: ${broker.connected ? "registered" : "not registered"}`,
				`Config: ${CONFIG_PATH}`,
				`Active Telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`Queued Telegram turns: ${queuedTelegramTurns.length}`,
			];
			if (brokerStatus?.communicationAgent) {
				const agent = brokerStatus.communicationAgent;
				lines.push(`Communication agent: ${agent.isIdle ? "idle" : "busy"}, queued ${agent.pendingMessages}`);
				if (agent.sessionFile) lines.push(`Communication session: ${agent.sessionFile}`);
				if (agent.contextPercent !== undefined && agent.contextPercent !== null) lines.push(`Communication context: ${agent.contextPercent.toFixed(1)}%`);
				if (agent.lastError) lines.push(`Communication error: ${agent.lastError}`);
			}
			if (brokerStatus?.lastError) lines.push(`Last error: ${brokerStatus.lastError}`);
			lines.push("", `Connected sessions: ${brokerStatus?.sessions.length ?? (broker.connected ? "unknown" : 0)}`);
			if (brokerStatus?.sessions.length) {
				lines.push(...brokerStatus.sessions.map(formatStatusSession));
			}
			ctx.ui.notify(lines.join("\n"), brokerStatus?.lastError ? "warning" : "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setCurrentCtx(ctx);
		sentNotifyDedupeKeys.clear();
		waitingAskUserToolCalls.clear();
		if (isEphemeralSession(ctx)) {
			updateStatus(ctx);
			return;
		}
		config = await ensureBrokerSecret(await readConfig());
		await mkdir(TEMP_DIR, { recursive: true });
		try {
			await broker.connect(ctx);
			startSessionUpdates(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateStatus(ctx, message);
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		queuedTelegramTurns = [];
		clearPendingLocalErrorNotification();
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		currentCtx = undefined;
		sentNotifyDedupeKeys.clear();
		waitingAskUserToolCalls.clear();
		preserveQueuedTurnsAsHistory = false;
		stopSessionUpdates();
		broker.close();
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (event.toolName !== "ask_user") return;
		if (waitingAskUserToolCalls.has(event.toolCallId)) return;
		if (!/waiting for user input/i.test(getToolUpdateText(event.partialResult))) return;
		waitingAskUserToolCalls.add(event.toolCallId);
		await handleNotifyEvent(
			{
				v: 1,
				source: "pi-telegram",
				kind: "waiting",
				level: "info",
				title: "Input needed",
				message: getAskUserQuestion(event.args) ?? "ask_user is waiting for your input.",
				dedupeKey: `ask-user:${event.toolCallId}`,
				minIntervalMs: 60_000,
			},
			ctx,
		);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		setCurrentCtx(ctx);
		if (event.toolName === "ask_user") waitingAskUserToolCalls.delete(event.toolCallId);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setCurrentCtx(ctx);
		maybeNameSessionFromPrompt(event.prompt, ctx);
		const progressGuidance = isEphemeralSession(ctx)
			? "- Telegram notifications are disabled in subagent sessions. Do not call telegram_progress."
			: isTelegramPrompt(event.prompt)
			? "- The current user message came from Telegram. Do not call telegram_progress unless the user explicitly asks; Telegram-originated turns already stream previews."
			: "- When the Telegram bridge is connected and this session was started locally, use telegram_progress for meaningful milestones, blockers, and periodic long-running-work updates; do not decide based on local presence yourself. The broker delivers, queues/summarizes, or drops updates according to presence policy. Keep updates short and avoid secrets, raw command output, or repetitive status.";
		return { systemPrompt: `${event.systemPrompt}${SYSTEM_PROMPT_SUFFIX}\n${progressGuidance}` };
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
		clearPendingLocalErrorNotification();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				broker.send({ v: 1, type: "preview_start", requestId: nextTurn.requestId, chatId: nextTurn.chatId });
			}
		}
		broker.sendSessionUpdate(ctx);
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message as TelegramPreviewTextMessage)) return;
		broker.send({ v: 1, type: "preview_start", requestId: activeTelegramTurn.requestId, chatId: activeTelegramTurn.chatId });
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message as TelegramPreviewTextMessage)) return;
		broker.send({
			v: 1,
			type: "preview_update",
			requestId: activeTelegramTurn.requestId,
			chatId: activeTelegramTurn.chatId,
			text: getMessageText(event.message),
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		setCurrentCtx(ctx);
		const turn = activeTelegramTurn;
		const assistant = extractAssistantText(event.messages);
		currentAbort = undefined;
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) {
			if (isEphemeralSession(ctx)) {
				clearPendingLocalErrorNotification();
				return;
			}
			if (assistant.stopReason === "error") {
				scheduleLocalErrorNotification(assistant.errorMessage || "Unknown error");
			} else if (assistant.stopReason !== "aborted") {
				clearPendingLocalErrorNotification();
				await handleNotifyEvent(
					{
						v: 1,
						source: "pi-telegram",
						kind: "ready",
						level: "success",
						title: "Pi turn finished",
						message: summarizeAssistantForNotification(assistant.text),
						dedupeKey: `agent-end:${ctx.sessionManager.getLeafId() ?? Date.now()}`,
						minIntervalMs: 1000,
					},
					ctx,
				);
			} else {
				clearPendingLocalErrorNotification();
			}
			if (queuedTelegramTurns.length > 0) {
				sendUserMessageSafely(queuedTelegramTurns[0].content);
			}
			broker.sendSessionUpdate(ctx);
			return;
		}

		broker.send({
			v: 1,
			type: "turn_result",
			requestId: turn.requestId,
			chatId: turn.chatId,
			replyToMessageId: turn.replyToMessageId,
			stopReason: assistant.stopReason,
			text: assistant.text,
			errorMessage: assistant.errorMessage,
			attachments: turn.queuedAttachments,
		});

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			updateStatus(ctx);
			sendUserMessageSafely(queuedTelegramTurns[0].content);
		}
		broker.sendSessionUpdate(ctx);
	});
}
