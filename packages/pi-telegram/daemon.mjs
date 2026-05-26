#!/usr/bin/env node
import { createServer, createConnection } from "node:net";
import { mkdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TELEGRAM_DIR = join(homedir(), ".pi", "agent", "extensions", "telegram");
const OLD_CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const CONFIG_PATH = join(TELEGRAM_DIR, "telegram.json");
const TEMP_DIR = join(TELEGRAM_DIR, "tmp");
const BROKER_SOCKET_PATH = join(TELEGRAM_DIR, "broker.sock");
const BROKER_STATE_PATH = join(TELEGRAM_DIR, "broker-state.json");
const BROKER_STATUS_PATH = join(TELEGRAM_DIR, "broker.json");
const BROKER_LOG_PATH = join(TELEGRAM_DIR, "broker.log");
const COMMUNICATION_AGENT_SESSION_DIR = join(TELEGRAM_DIR, "communication-agent");
const MAX_MESSAGE_LENGTH = 4096;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const TELEGRAM_PROGRESS_MAX_LENGTH = 500;
const TELEGRAM_HISTORY_LIMIT = 50;
const ROUTE_DECISION_LIMIT = 50;
const MESSAGE_ROUTE_LIMIT = 500;
const SESSION_STALE_MS = 30_000;
const SESSION_SWEEP_MS = 10_000;
const COMMUNICATION_TEXT_LIMIT = 1000;
const SESSION_SNIPPET_LIMIT = 12;
const COMMUNICATION_AGENT_TOOL_NAMES = ["telegram_get_status", "telegram_send_to_session", "telegram_control_session"];

let config = {};
let state = {
	version: 1,
	telegramHistory: [],
	routeDecisions: [],
	messageRoutes: {},
};
let pollingController;
let pollingPromise;
let server;
let lastError;
let draftSupport = "unknown";
let nextDraftId = 0;

const sessions = new Map();
const mediaGroups = new Map();
const previews = new Map();
let communicationAgent;
let communicationAgentReady;
let communicationActiveTurn;
let communicationCurrentText = "";
let communicationQueue = [];
let communicationProcessing = false;
let communicationLastError;
let communicationLastHandledAt;
let pendingTranscriptEntries = [];

function now() {
	return Date.now();
}

async function log(message) {
	const line = `${new Date().toISOString()} ${message}\n`;
	try {
		await appendFile(BROKER_LOG_PATH, line, "utf8");
	} catch {
		// ignore logging failures
	}
}

function isNodeError(error, code) {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function ensureTelegramDir() {
	await mkdir(TELEGRAM_DIR, { recursive: true });
}

async function migrateConfig() {
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

async function readConfig() {
	await migrateConfig();
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

async function writeConfig(nextConfig) {
	await migrateConfig();
	await writeFile(CONFIG_PATH, JSON.stringify(nextConfig, null, "\t") + "\n", "utf8");
}

async function ensureBrokerSecret() {
	config = await readConfig();
	if (!config.brokerSecret) {
		config = { ...config, brokerSecret: randomBytes(32).toString("hex") };
		await writeConfig(config);
	}
}

async function readState() {
	try {
		const parsed = JSON.parse(await readFile(BROKER_STATE_PATH, "utf8"));
		return {
			version: 1,
			lastUpdateId: parsed.lastUpdateId,
			telegramHistory: Array.isArray(parsed.telegramHistory) ? parsed.telegramHistory : [],
			routeDecisions: Array.isArray(parsed.routeDecisions) ? parsed.routeDecisions : [],
			messageRoutes: parsed.messageRoutes && typeof parsed.messageRoutes === "object" ? parsed.messageRoutes : {},
		};
	} catch {
		return {
			version: 1,
			lastUpdateId: config.lastUpdateId,
			telegramHistory: [],
			routeDecisions: [],
			messageRoutes: {},
		};
	}
}

async function writeState() {
	await ensureTelegramDir();
	trimState();
	await writeFile(BROKER_STATE_PATH, JSON.stringify(state, null, "\t") + "\n", "utf8");
}

function trimState() {
	state.telegramHistory = state.telegramHistory.slice(-TELEGRAM_HISTORY_LIMIT);
	state.routeDecisions = state.routeDecisions.slice(-ROUTE_DECISION_LIMIT);
	const entries = Object.entries(state.messageRoutes).sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0));
	while (entries.length > MESSAGE_ROUTE_LIMIT) {
		const [key] = entries.shift();
		delete state.messageRoutes[key];
	}
}

async function writeStatus() {
	const status = buildStatus();
	await writeFile(BROKER_STATUS_PATH, JSON.stringify(status, null, "\t") + "\n", "utf8").catch(() => undefined);
}

function buildStatus() {
	return {
		configured: Boolean(config.botToken),
		paired: config.allowedUserId !== undefined,
		botUsername: config.botUsername,
		allowedUserId: config.allowedUserId,
		polling: Boolean(pollingPromise),
		brokerPid: process.pid,
		lastUpdateId: state.lastUpdateId,
		sessions: [...sessions.values()].map((session) => publicSession(session)),
		communicationAgent: communicationAgentStatus(),
		lastError,
	};
}

function communicationAgentStatus() {
	const session = communicationAgent?.session;
	return {
		enabled: true,
		sessionId: session?.sessionId,
		sessionFile: session?.sessionFile,
		isIdle: !communicationProcessing && !session?.isStreaming,
		activeTurn: communicationActiveTurn ? { requestId: communicationActiveTurn.requestId, chatId: communicationActiveTurn.chatId } : undefined,
		pendingMessages: communicationQueue.length,
		lastError: communicationLastError,
		lastHandledAt: communicationLastHandledAt,
		contextPercent: null,
	};
}

function publicSession(session) {
	return {
		connectionId: session.connectionId,
		sessionId: session.sessionId,
		pid: session.pid,
		cwd: session.cwd,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		model: session.model,
		isIdle: session.isIdle,
		activeTurn: session.activeTurn,
		queuedTurns: session.queuedTurns ?? 0,
		queuedByChat: session.queuedByChat ?? {},
		recentMessages: Array.isArray(session.recentMessages) ? session.recentMessages : [],
		lastSeen: session.lastSeen,
	};
}

function updateSessionFromMessage(client, message) {
	const existing = sessions.get(message.sessionId);
	if (existing && existing !== client) {
		existing.socket.destroy();
	}
	Object.assign(client, {
		connectionId: message.connectionId,
		sessionId: message.sessionId,
		pid: message.pid,
		cwd: message.cwd,
		sessionFile: message.sessionFile,
		sessionName: message.sessionName,
		model: message.model,
		isIdle: Boolean(message.isIdle),
		activeTurn: message.activeTurn,
		queuedTurns: message.queuedTurns ?? 0,
		queuedByChat: message.queuedByChat ?? {},
		recentMessages: Array.isArray(message.recentMessages) ? message.recentMessages.slice(-SESSION_SNIPPET_LIMIT) : [],
		lastSeen: now(),
	});
	sessions.set(message.sessionId, client);
}

function sendToClient(client, message) {
	if (!client.socket.writable) return false;
	client.socket.write(`${JSON.stringify(message)}\n`);
	return true;
}

function broadcastPairingState() {
	for (const session of sessions.values()) {
		sendToClient(session, { v: 1, type: "hello_ack", paired: config.allowedUserId !== undefined, allowedUserId: config.allowedUserId });
	}
}

function respond(client, id, ok, result, error) {
	if (!id) return;
	sendToClient(client, { v: 1, type: "response", id, ok, result, error });
}

function chunkParagraphs(text, maxLength = MAX_MESSAGE_LENGTH) {
	if (text.length <= maxLength) return [text];
	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks = [];
	let current = "";
	const flushCurrent = () => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};
	const splitLongBlock = (block) => {
		if (block.length <= maxLength) return [block];
		const lines = block.split("\n");
		const lineChunks = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= maxLength) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= maxLength) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += maxLength) {
				lineChunks.push(line.slice(i, i + maxLength));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};
	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		for (const part of splitLongBlock(paragraph)) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= maxLength) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function callTelegram(method, body, options = {}) {
	if (!config.botToken) throw new Error("Telegram bot token is not configured");
	const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: options.signal,
	});
	const data = await response.json();
	if (!data.ok || data.result === undefined) {
		throw new Error(data.description || `Telegram API ${method} failed`);
	}
	return data.result;
}

async function callTelegramMultipart(method, fields, fileField, filePath, fileName, options = {}) {
	if (!config.botToken) throw new Error("Telegram bot token is not configured");
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		form.set(key, value);
	}
	const buffer = await readFile(filePath);
	form.set(fileField, new Blob([buffer]), fileName);
	const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
		method: "POST",
		body: form,
		signal: options.signal,
	});
	const data = await response.json();
	if (!data.ok || data.result === undefined) {
		throw new Error(data.description || `Telegram API ${method} failed`);
	}
	return data.result;
}

function slugify(value, fallback) {
	const slug = value
		?.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return slug || fallback;
}

function sessionMessagePrefix(sessionId) {
	const session = sessions.get(sessionId);
	if (!session) return "";
	const cwdName = basename(session.cwd || "?");
	const fallbackSlug = session.sessionId ? session.sessionId.slice(0, 8) : "session";
	return `[${cwdName}:${slugify(session.sessionName, fallbackSlug)}]`;
}

function formatSessionText(text, sessionId) {
	const prefix = sessionMessagePrefix(sessionId);
	return prefix ? `${prefix}\n${text}` : text;
}

async function sendTextReply(chatId, text, sessionId) {
	const prefix = sessionMessagePrefix(sessionId);
	const maxChunkLength = prefix ? MAX_MESSAGE_LENGTH - prefix.length - 1 : MAX_MESSAGE_LENGTH;
	const chunks = chunkParagraphs(text, maxChunkLength);
	const messageIds = [];
	for (const chunk of chunks) {
		const body = prefix ? `${prefix}\n${chunk}` : chunk;
		const sent = await callTelegram("sendMessage", { chat_id: chatId, text: body });
		messageIds.push(sent.message_id);
		if (sessionId) linkTelegramMessage(chatId, sent.message_id, sessionId, body);
	}
	if (sessionId && messageIds.length > 0) {
		await recordCommunicationTranscript({ direction: "out", source: "pi-session", chatId, messageIds, sessionId, text });
	}
	await writeState();
	return messageIds;
}

function allocateDraftId() {
	nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
	return nextDraftId;
}

async function clearPreview(requestId) {
	const preview = previews.get(requestId);
	if (!preview) return;
	if (preview.flushTimer) clearTimeout(preview.flushTimer);
	previews.delete(requestId);
	if (preview.mode === "draft" && preview.draftId !== undefined) {
		await callTelegram("sendMessageDraft", { chat_id: preview.chatId, draft_id: preview.draftId, text: "" }).catch(() => undefined);
	}
}

async function flushPreview(requestId) {
	const preview = previews.get(requestId);
	if (!preview) return;
	preview.flushTimer = undefined;
	const text = preview.pendingText.trim();
	const displayText = formatSessionText(text, preview.sessionId);
	if (!text || displayText === preview.lastSentText) return;
	const truncated = displayText.length > MAX_MESSAGE_LENGTH ? displayText.slice(0, MAX_MESSAGE_LENGTH) : displayText;

	if (draftSupport !== "unsupported") {
		const draftId = preview.draftId ?? allocateDraftId();
		preview.draftId = draftId;
		try {
			await callTelegram("sendMessageDraft", { chat_id: preview.chatId, draft_id: draftId, text: truncated });
			draftSupport = "supported";
			preview.mode = "draft";
			preview.lastSentText = truncated;
			return;
		} catch {
			draftSupport = "unsupported";
		}
	}

	if (preview.messageId === undefined) {
		const sent = await callTelegram("sendMessage", { chat_id: preview.chatId, text: truncated });
		preview.messageId = sent.message_id;
		preview.mode = "message";
		preview.lastSentText = truncated;
		linkTelegramMessage(preview.chatId, sent.message_id, preview.sessionId, truncated);
		await writeState();
		return;
	}
	await callTelegram("editMessageText", { chat_id: preview.chatId, message_id: preview.messageId, text: truncated });
	preview.mode = "message";
	preview.lastSentText = truncated;
}

function schedulePreviewFlush(requestId) {
	const preview = previews.get(requestId);
	if (!preview || preview.flushTimer) return;
	preview.flushTimer = setTimeout(() => {
		void flushPreview(requestId).catch((error) => void log(`preview flush failed: ${errorMessage(error)}`));
	}, PREVIEW_THROTTLE_MS);
}

async function finalizePreview(requestId, finalText) {
	const preview = previews.get(requestId);
	if (!preview) return false;
	if (finalText !== undefined) preview.pendingText = finalText;
	await flushPreview(requestId);
	const text = (preview.pendingText.trim() || preview.lastSentText).trim();
	if (!text) {
		await clearPreview(requestId);
		return false;
	}
	if (preview.mode === "draft") {
		const body = formatSessionText(text, preview.sessionId);
		const sent = await callTelegram("sendMessage", { chat_id: preview.chatId, text: body });
		linkTelegramMessage(preview.chatId, sent.message_id, preview.sessionId, body);
		if (preview.sessionId) {
			await recordCommunicationTranscript({ direction: "out", source: "pi-session", chatId: preview.chatId, messageIds: [sent.message_id], sessionId: preview.sessionId, text });
		}
		await clearPreview(requestId);
		await writeState();
		return true;
	}
	if (preview.sessionId && preview.messageId !== undefined) {
		await recordCommunicationTranscript({ direction: "out", source: "pi-session", chatId: preview.chatId, messageIds: [preview.messageId], sessionId: preview.sessionId, text });
	}
	previews.delete(requestId);
	return preview.messageId !== undefined;
}

async function sendQueuedAttachments(chatId, attachments, sessionId) {
	const caption = sessionMessagePrefix(sessionId);
	for (const attachment of attachments) {
		try {
			const mediaType = guessMediaType(attachment.path);
			const method = mediaType ? "sendPhoto" : "sendDocument";
			const fieldName = mediaType ? "photo" : "document";
			const fields = { chat_id: String(chatId) };
			if (caption) fields.caption = caption;
			const sent = await callTelegramMultipart(
				method,
				fields,
				fieldName,
				attachment.path,
				attachment.fileName,
			);
			linkTelegramMessage(chatId, sent.message_id, sessionId, caption ? `${caption} ${attachment.fileName}` : attachment.fileName);
			if (sessionId) {
				await recordCommunicationTranscript({
					direction: "out",
					source: "pi-session",
					chatId,
					messageIds: [sent.message_id],
					sessionId,
					text: `Sent attachment: ${attachment.fileName}`,
					attachments: [{ fileName: attachment.fileName, path: attachment.path }],
				});
			}
		} catch (error) {
			await sendTextReply(chatId, `Failed to send attachment ${attachment.fileName}: ${errorMessage(error)}`, sessionId);
		}
	}
	await writeState();
}

function guessMediaType(filePath) {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function guessExtensionFromMime(mimeType, fallback) {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function sanitizeFileName(name) {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isImageMimeType(mimeType) {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

async function downloadTelegramFile(fileId, suggestedName) {
	const file = await callTelegram("getFile", { file_id: fileId });
	await mkdir(TEMP_DIR, { recursive: true });
	const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
	const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
	if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
	const arrayBuffer = await response.arrayBuffer();
	await writeFile(targetPath, Buffer.from(arrayBuffer));
	return targetPath;
}

function collectTelegramFileInfos(messages) {
	const files = [];
	for (const message of messages) {
		if (Array.isArray(message.photo) && message.photo.length > 0) {
			const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
			if (photo) files.push({ file_id: photo.file_id, fileName: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", isImage: true });
		}
		if (message.document) {
			const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
			files.push({ file_id: message.document.file_id, fileName, mimeType: message.document.mime_type, isImage: isImageMimeType(message.document.mime_type) });
		}
		if (message.video) {
			const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
			files.push({ file_id: message.video.file_id, fileName, mimeType: message.video.mime_type, isImage: false });
		}
		if (message.audio) {
			const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
			files.push({ file_id: message.audio.file_id, fileName, mimeType: message.audio.mime_type, isImage: false });
		}
		if (message.voice) {
			files.push({ file_id: message.voice.file_id, fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`, mimeType: message.voice.mime_type, isImage: false });
		}
		if (message.animation) {
			const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
			files.push({ file_id: message.animation.file_id, fileName, mimeType: message.animation.mime_type, isImage: false });
		}
		if (message.sticker) {
			files.push({ file_id: message.sticker.file_id, fileName: `sticker-${message.message_id}.webp`, mimeType: "image/webp", isImage: true });
		}
	}
	return files;
}

async function buildTelegramFiles(messages) {
	const downloaded = [];
	for (const file of collectTelegramFileInfos(messages)) {
		const filePath = await downloadTelegramFile(file.file_id, file.fileName);
		downloaded.push({ path: filePath, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
	}
	return downloaded;
}

function rawTextForMessages(messages) {
	return messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
}

function messageRouteKey(chatId, messageId) {
	return `${chatId}:${messageId}`;
}

function linkTelegramMessage(chatId, messageId, sessionId, summary) {
	if (!sessionId) return;
	state.messageRoutes[messageRouteKey(chatId, messageId)] = {
		sessionId,
		summary: clip(summary, 300),
		createdAt: now(),
	};
}

function findReplyRoute(message) {
	const replyMessageId = message.reply_to_message?.message_id;
	if (replyMessageId === undefined) return undefined;
	const route = state.messageRoutes[messageRouteKey(message.chat.id, replyMessageId)];
	if (!route) return undefined;
	return sessions.has(route.sessionId) ? route.sessionId : undefined;
}

function addTelegramHistory(entry) {
	state.telegramHistory.push({ ...entry, at: now() });
	state.telegramHistory = state.telegramHistory.slice(-TELEGRAM_HISTORY_LIMIT);
}

function addRouteDecision(decision) {
	state.routeDecisions.push({ ...decision, at: now() });
	state.routeDecisions = state.routeDecisions.slice(-ROUTE_DECISION_LIMIT);
}

function getConnectedSessions() {
	return [...sessions.values()].filter((session) => session.socket.writable);
}

function communicationSessionSnapshot(session) {
	return {
		sessionId: session.sessionId,
		cwd: session.cwd,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		model: session.model,
		isIdle: session.isIdle,
		activeTurn: session.activeTurn,
		queuedTurns: session.queuedTurns,
		queuedByChat: session.queuedByChat,
		lastSeenSecondsAgo: Math.round((now() - session.lastSeen) / 1000),
		recentMessages: sanitizeSnippets(session.recentMessages),
	};
}

function buildCommunicationSystemPrompt() {
	return `You are the Telegram communication agent for pi.

You handle private Telegram DMs from the paired user. Every authorized Telegram message arrives in your persistent session with structured metadata. Your job is to be the user's conversational Telegram agent, not just a router.

Capabilities:
- Answer the Telegram user directly when a request is conversational or asks about connected sessions.
- Use telegram_get_status to inspect the broker and running pi sessions.
- Use telegram_send_to_session to send exact user-delegated instructions to a currently connected pi session.
- Use telegram_control_session for status, compact, and stop actions.

Rules:
- Delegate coding, repository, shell, file, browser, and long-running work to a target pi session. Do not pretend to perform coding work yourself.
- If the message is a reply to a Telegram bot message linked to a session, strongly prefer that linked session unless the user clearly asks otherwise.
- If only one pi session is connected, you may use it without asking when delegation is needed.
- If the target session is ambiguous, ask the user which session to use instead of guessing.
- When delegating, send the target session a concise, complete instruction written on the user's behalf.
- Target sessions reply to Telegram through their own Telegram extension tools and previews; you do not need to wait for their final answer.
- If attachments are present and the user asks to analyze or transform them, delegate to a pi session and include current attachments.
- Keep direct Telegram replies concise.`;
}

function createCommunicationTools() {
	return [
		defineTool({
			name: "telegram_get_status",
			label: "Telegram Status",
			description: "Inspect Telegram broker status and currently connected pi sessions.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				const status = buildStatus();
				const lines = [
					`Connected sessions: ${status.sessions.length}`,
					...status.sessions.map((session) => `- ${formatSessionLabel(session)}`),
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { ok: true, status },
				};
			},
		}),
		defineTool({
			name: "telegram_send_to_session",
			label: "Send To pi Session",
			description: "Send an exact user-delegated message to a currently connected pi session.",
			parameters: Type.Object({
				sessionId: Type.String({ description: "Target connected pi session id", minLength: 1 }),
				text: Type.String({ description: "Exact text to deliver to the target pi session", minLength: 1 }),
				includeCurrentAttachments: Type.Optional(Type.Boolean({ description: "Include files from the current Telegram message", default: true })),
				reason: Type.Optional(Type.String({ description: "Short routing reason", maxLength: 200 })),
			}),
			async execute(_toolCallId, params) {
				const turn = communicationActiveTurn;
				if (!turn) {
					return {
						content: [{ type: "text", text: "Could not deliver: there is no active Telegram communication turn." }],
						details: { ok: false, delivered: false, reason: "no-active-turn" },
					};
				}
				try {
					const files = params.includeCurrentAttachments === false ? [] : turn.files;
					const delivered = await deliverTurnToSession({
						sessionId: params.sessionId,
						chatId: turn.chatId,
						fromUserId: turn.fromUserId,
						replyToMessageId: turn.replyToMessageId,
						telegramMessageIds: turn.telegramMessageIds,
						rawText: params.text,
						files,
						reason: params.reason || "communication-agent",
						source: "communication_agent",
						delegatedByRequestId: turn.requestId,
					});
					return {
						content: [{ type: "text", text: `Delivered to ${delivered.sessionLabel}.` }],
						details: { ok: true, delivered: true, delegatedReplyExpected: true, command: null, ...delivered },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Could not deliver: ${errorMessage(error)}` }],
						details: { ok: false, delivered: false, sessionId: params.sessionId, reason: errorMessage(error) },
					};
				}
			},
		}),
		defineTool({
			name: "telegram_control_session",
			label: "Control pi Session",
			description: "Send status, compact, or stop control actions to a currently connected pi session.",
			parameters: Type.Object({
				sessionId: Type.String({ description: "Target connected pi session id", minLength: 1 }),
				action: Type.Union([Type.Literal("status"), Type.Literal("compact"), Type.Literal("stop")]),
				reason: Type.Optional(Type.String({ description: "Short routing reason", maxLength: 200 })),
			}),
			async execute(_toolCallId, params) {
				const turn = communicationActiveTurn;
				if (!turn) {
					return {
						content: [{ type: "text", text: "Could not deliver: there is no active Telegram communication turn." }],
						details: { ok: false, delivered: false, reason: "no-active-turn" },
					};
				}
				const commandText = params.action === "status" ? "/status" : params.action === "compact" ? "/compact" : "stop";
				try {
					const delivered = await deliverTurnToSession({
						sessionId: params.sessionId,
						chatId: turn.chatId,
						fromUserId: turn.fromUserId,
						replyToMessageId: turn.replyToMessageId,
						telegramMessageIds: turn.telegramMessageIds,
						rawText: commandText,
						files: [],
						reason: params.reason || `communication-agent:${params.action}`,
						source: "communication_agent",
						delegatedByRequestId: turn.requestId,
					});
					return {
						content: [{ type: "text", text: `Sent ${params.action} to ${delivered.sessionLabel}.` }],
						details: { ok: true, delivered: true, delegatedReplyExpected: true, action: params.action, commandText, ...delivered },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Could not deliver: ${errorMessage(error)}` }],
						details: { ok: false, delivered: false, sessionId: params.sessionId, action: params.action, reason: errorMessage(error) },
					};
				}
			},
		}),
	];
}

async function ensureCommunicationAgent() {
	if (communicationAgent) return communicationAgent;
	if (communicationAgentReady) return communicationAgentReady;
	communicationAgentReady = (async () => {
		const cwd = TELEGRAM_DIR;
		const agentDir = getAgentDir();
		await mkdir(COMMUNICATION_AGENT_SESSION_DIR, { recursive: true });
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => buildCommunicationSystemPrompt(),
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.continueRecent(cwd, COMMUNICATION_AGENT_SESSION_DIR),
			tools: COMMUNICATION_AGENT_TOOL_NAMES,
			customTools: createCommunicationTools(),
			thinkingLevel: "low",
		});
		const unsubscribe = session.subscribe(handleCommunicationAgentEvent);
		communicationAgent = { session, unsubscribe };
		communicationLastError = undefined;
		await writeStatus();
		return communicationAgent;
	})().catch(async (error) => {
		communicationAgentReady = undefined;
		communicationLastError = `communication agent failed: ${errorMessage(error)}`;
		await log(communicationLastError);
		await writeStatus();
		throw error;
	});
	return communicationAgentReady;
}

function ensureCommunicationPreview(turn) {
	if (previews.has(turn.requestId)) return;
	previews.set(turn.requestId, {
		requestId: turn.requestId,
		chatId: turn.chatId,
		mode: draftSupport === "unsupported" ? "message" : "draft",
		pendingText: "",
		lastSentText: "",
	});
}

function handleCommunicationAgentEvent(event) {
	const turn = communicationActiveTurn;
	if (!turn) return;
	if (event.type === "message_start" && event.message?.role === "assistant") {
		communicationCurrentText = "";
		ensureCommunicationPreview(turn);
		return;
	}
	if (event.type !== "message_update" || event.assistantMessageEvent?.type !== "text_delta") return;
	communicationCurrentText += event.assistantMessageEvent.delta;
	ensureCommunicationPreview(turn);
	const preview = previews.get(turn.requestId);
	if (!preview) return;
	preview.pendingText = communicationCurrentText;
	schedulePreviewFlush(turn.requestId);
}

async function buildCommunicationTurn(messages) {
	const first = messages[0];
	const rawText = rawTextForMessages(messages);
	const files = await buildTelegramFiles(messages);
	const replyToLinkedSessionId = findReplyRoute(first);
	const telegramMessageIds = messages.map((message) => message.message_id);
	const turn = {
		requestId: randomUUID(),
		chatId: first.chat.id,
		fromUserId: first.from.id,
		replyToMessageId: first.message_id,
		telegramMessageIds,
		rawText,
		files,
		replyToLinkedSessionId,
		replyTo: first.reply_to_message
			? {
					messageId: first.reply_to_message.message_id,
					text: clip(first.reply_to_message.text || first.reply_to_message.caption || "", 400),
				}
			: undefined,
	};
	turn.prompt = buildCommunicationPrompt(turn);
	addTelegramHistory({
		direction: "in",
		source: "telegram-user",
		chatId: first.chat.id,
		messageId: first.message_id,
		messageIds: telegramMessageIds,
		text: clip(rawText || describeFiles(files), 700),
		replyToLinkedSessionId,
	});
	await writeState();
	return turn;
}

function buildCommunicationPrompt(turn) {
	const connected = getConnectedSessions();
	const input = {
		incoming: {
			chatId: turn.chatId,
			fromUserId: turn.fromUserId,
			messageIds: turn.telegramMessageIds,
			text: clip(turn.rawText, COMMUNICATION_TEXT_LIMIT),
			attachments: turn.files.map((file) => ({ fileName: file.fileName, path: file.path, mimeType: file.mimeType, isImage: file.isImage })),
			replyTo: turn.replyTo,
		},
		routingHints: {
			replyToLinkedSessionId: turn.replyToLinkedSessionId,
			onlyConnectedSessionId: connected.length === 1 ? connected[0].sessionId : undefined,
			connectedSessionCount: connected.length,
		},
		telegramHistory: state.telegramHistory.slice(-20),
		routeDecisions: state.routeDecisions.slice(-20),
		sessions: connected.map(communicationSessionSnapshot),
	};
	return `Handle this Telegram message. Decide whether to answer directly or delegate to a connected pi session with your tools.\n\nTelegram turn:\n${JSON.stringify(input, null, 2)}`;
}

async function routeAuthorizedMessages(messages) {
	const first = messages[0];
	if (!first) return;
	const turn = await buildCommunicationTurn(messages);
	enqueueCommunicationTurn(turn);
}

function enqueueCommunicationTurn(turn) {
	communicationQueue.push(turn);
	void processCommunicationQueue().catch((error) => void log(`communication queue failed: ${errorMessage(error)}`));
	void writeStatus();
}

async function processCommunicationQueue() {
	if (communicationProcessing) return;
	communicationProcessing = true;
	try {
		while (communicationQueue.length > 0) {
			const turn = communicationQueue.shift();
			await runCommunicationTurn(turn);
		}
	} finally {
		communicationProcessing = false;
		await writeStatus();
	}
}

async function runCommunicationTurn(turn) {
	communicationActiveTurn = turn;
	communicationCurrentText = "";
	try {
		const agent = await ensureCommunicationAgent();
		ensureCommunicationPreview(turn);
		const startIndex = agent.session.messages.length;
		await agent.session.prompt(turn.prompt, { expandPromptTemplates: false });
		const newMessages = agent.session.messages.slice(startIndex);
		const finalText = (extractAssistantText(newMessages) || communicationCurrentText).trim();
		if (finalText.length > 0 && finalText.length <= MAX_MESSAGE_LENGTH) {
			await finalizePreview(turn.requestId, finalText);
		} else {
			await clearPreview(turn.requestId);
			if (finalText.length > 0) await sendTextReply(turn.chatId, finalText);
		}
		communicationLastError = undefined;
		communicationLastHandledAt = now();
	} catch (error) {
		communicationLastError = `communication turn failed: ${errorMessage(error)}`;
		await log(communicationLastError);
		await clearPreview(turn.requestId);
		await sendTextReply(turn.chatId, `Telegram communication agent failed: ${errorMessage(error)}`);
	} finally {
		communicationActiveTurn = undefined;
		communicationCurrentText = "";
		await flushPendingTranscriptEntries();
		await writeStatus();
	}
}

async function deliverTurnToSession({
	sessionId,
	chatId,
	fromUserId,
	replyToMessageId,
	telegramMessageIds,
	rawText,
	files,
	reason,
	source,
	delegatedByRequestId,
}) {
	const session = sessions.get(sessionId);
	if (!session || !session.socket.writable) throw new Error(`Session is not connected (${sessionId})`);
	const requestId = randomUUID();
	const delivered = sendToClient(session, {
		v: 1,
		type: "deliver_turn",
		requestId,
		chatId,
		fromUserId,
		replyToMessageId,
		rawText,
		telegramMessageIds,
		files,
		source,
		delegatedByRequestId,
	});
	if (!delivered) throw new Error(`Session is no longer reachable (${sessionId})`);
	const messageId = telegramMessageIds[0] ?? replyToMessageId;
	addRouteDecision({ chatId, messageId, messageIds: telegramMessageIds, sessionId, reason, source, delegatedByRequestId });
	await writeState();
	await writeStatus();
	return {
		requestId,
		sessionId,
		sessionLabel: formatSessionLabel(session),
		telegramMessageIds,
		replyToMessageId,
		filesIncluded: files.length,
		reason,
	};
}

async function recordCommunicationTranscript(entry, options = {}) {
	const text = formatTranscriptEntry(entry);
	if (!text) return;
	if (!options.force && (communicationProcessing || communicationAgent?.session?.isStreaming)) {
		pendingTranscriptEntries.push(entry);
		return;
	}
	try {
		const agent = await ensureCommunicationAgent();
		if (!options.force && agent.session.isStreaming) {
			pendingTranscriptEntries.push(entry);
			return;
		}
		await agent.session.sendCustomMessage(
			{
				customType: "pi-telegram-transcript",
				content: text,
				display: false,
				details: entry,
			},
			{ triggerTurn: false },
		);
	} catch (error) {
		communicationLastError = `transcript record failed: ${errorMessage(error)}`;
		await log(communicationLastError);
		await writeStatus();
	}
}

async function flushPendingTranscriptEntries() {
	if (pendingTranscriptEntries.length === 0) return;
	if (communicationAgent?.session?.isStreaming) return;
	const entries = pendingTranscriptEntries;
	pendingTranscriptEntries = [];
	for (const entry of entries) {
		await recordCommunicationTranscript(entry, { force: true });
	}
}

function formatTranscriptEntry(entry) {
	const lines = ["Telegram transcript entry:"];
	lines.push(`direction: ${entry.direction}`);
	lines.push(`source: ${entry.source}`);
	if (entry.sessionId) lines.push(`sessionId: ${entry.sessionId}`);
	if (entry.messageIds?.length) lines.push(`telegramMessageIds: ${entry.messageIds.join(", ")}`);
	if (entry.text) lines.push("text:", clip(entry.text, 4000));
	if (entry.attachments?.length) {
		lines.push("attachments:");
		for (const attachment of entry.attachments) {
			lines.push(`- ${attachment.fileName}${attachment.path ? ` (${attachment.path})` : ""}`);
		}
	}
	return lines.join("\n");
}

function sanitizeSnippets(snippets = []) {
	return snippets.slice(-SESSION_SNIPPET_LIMIT).map((snippet) => ({
		role: snippet.role,
		text: redactSecrets(clip(snippet.text, 800)),
	}));
}

function redactSecrets(text) {
	return text
		.replace(/\b(?:sk|pk|ghp|gho|github_pat)_[A-Za-z0-9_\-]{12,}\b/g, "[redacted]")
		.replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, "[redacted]")
		.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

function extractAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = Array.isArray(message.content) ? message.content : [];
		return content
			.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("")
			.trim();
	}
	return "";
}

function formatSessionLabel(session) {
	const name = session.sessionName ? `${session.sessionName} — ` : "";
	const stateText = session.isIdle ? "idle" : "busy";
	const queued = session.queuedTurns ? `, ${session.queuedTurns} queued` : "";
	const recent = session.recentMessages?.at(-1)?.text;
	return `${name}${session.cwd} (${stateText}${queued})${recent ? ` — ${clip(recent.replace(/\s+/g, " "), 80)}` : ""}`;
}

function describeFiles(files) {
	if (!files.length) return "(no text)";
	return `Attachments: ${files.map((file) => file.fileName).join(", ")}`;
}

async function handleAuthorizedMessage(message) {
	if (message.media_group_id) {
		const key = `${message.chat.id}:${message.media_group_id}`;
		const existing = mediaGroups.get(key) ?? { messages: [] };
		existing.messages.push(message);
		if (existing.flushTimer) clearTimeout(existing.flushTimer);
		existing.flushTimer = setTimeout(() => {
			const state = mediaGroups.get(key);
			mediaGroups.delete(key);
			if (!state) return;
			void routeAuthorizedMessages(state.messages).catch((error) => handleTelegramError(error));
		}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
		mediaGroups.set(key, existing);
		return;
	}
	await routeAuthorizedMessages([message]);
}

async function handleUpdate(update) {
	const message = update.message || update.edited_message;
	if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

	if (config.allowedUserId === undefined) {
		config.allowedUserId = message.from.id;
		await writeConfig(config);
		broadcastPairingState();
		await sendTextReply(message.chat.id, "Telegram bridge paired with this account.");
	}

	if (message.from.id !== config.allowedUserId) {
		await sendTextReply(message.chat.id, "This bot is not authorized for your account.");
		return;
	}

	const text = (message.text || "").trim().toLowerCase();
	if (text === "/start" || text === "/help") {
		await sendTextReply(message.chat.id, "Send me a message and I will answer as your Telegram communication agent or delegate to a running pi session. Replying to a session message gives me a strong target hint. I can also delegate /status, /compact, and stop.");
		return;
	}

	await handleAuthorizedMessage(message);
}

async function pollLoop(signal) {
	if (!config.botToken) return;
	try {
		await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
	} catch {
		// ignore
	}
	if (state.lastUpdateId === undefined) {
		try {
			const updates = await callTelegram("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
			const last = updates.at(-1);
			if (last) {
				state.lastUpdateId = last.update_id;
				await writeState();
			}
		} catch {
			// ignore
		}
	}
	while (!signal.aborted) {
		try {
			const updates = await callTelegram(
				"getUpdates",
				{
					offset: state.lastUpdateId !== undefined ? state.lastUpdateId + 1 : undefined,
					limit: 10,
					timeout: 30,
					allowed_updates: ["message", "edited_message"],
				},
				{ signal },
			);
			for (const update of updates) {
				state.lastUpdateId = update.update_id;
				await writeState();
				await handleUpdate(update);
			}
			lastError = undefined;
			await writeStatus();
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof DOMException && error.name === "AbortError") return;
			await handleTelegramError(error);
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
	}
}

async function handleTelegramError(error) {
	lastError = errorMessage(error);
	await log(`telegram error: ${lastError}`);
	await writeStatus();
}

function stopPolling() {
	pollingController?.abort();
	pollingController = undefined;
	pollingPromise = undefined;
}

function disposeCommunicationAgent() {
	communicationAgent?.unsubscribe?.();
	communicationAgent?.session?.dispose?.();
	communicationAgent = undefined;
	communicationAgentReady = undefined;
}

async function startPollingIfConfigured() {
	if (!config.botToken || pollingPromise) return;
	pollingController = new AbortController();
	pollingPromise = pollLoop(pollingController.signal).finally(() => {
		pollingPromise = undefined;
		pollingController = undefined;
		void writeStatus();
	});
	await writeStatus();
}

async function reloadConfig() {
	const previousToken = config.botToken;
	config = await readConfig();
	if (previousToken !== config.botToken) stopPolling();
	await startPollingIfConfigured();
	await writeStatus();
}

async function handleClientMessage(client, message) {
	if (message?.v !== 1 || typeof message.type !== "string") return;
	if (message.type === "hello") {
		if (!config.brokerSecret || message.brokerSecret !== config.brokerSecret) {
			client.socket.destroy();
			return;
		}
		client.authenticated = true;
		updateSessionFromMessage(client, message);
		sendToClient(client, { v: 1, type: "hello_ack", paired: config.allowedUserId !== undefined, allowedUserId: config.allowedUserId });
		await writeStatus();
		return;
	}
	if (!client.authenticated) return;

	if (message.type === "session_update") {
		updateSessionFromMessage(client, message);
		await writeStatus();
		return;
	}
	if (message.type === "reload_config") {
		await reloadConfig();
		respond(client, message.id, true, buildStatus());
		return;
	}
	if (message.type === "get_status") {
		respond(client, message.id, true, buildStatus());
		return;
	}
	if (message.type === "send_text") {
		try {
			const ids = await sendTextReply(message.chatId, message.text, message.linkToSession ? client.sessionId : undefined);
			respond(client, message.id, true, { messageIds: ids });
		} catch (error) {
			respond(client, message.id, false, undefined, errorMessage(error));
		}
		return;
	}
	if (message.type === "preview_start") {
		previews.set(message.requestId, {
			requestId: message.requestId,
			chatId: message.chatId,
			sessionId: client.sessionId,
			mode: draftSupport === "unsupported" ? "message" : "draft",
			pendingText: "",
			lastSentText: "",
		});
		return;
	}
	if (message.type === "preview_update") {
		const preview = previews.get(message.requestId);
		if (!preview) {
			previews.set(message.requestId, {
				requestId: message.requestId,
				chatId: message.chatId,
				sessionId: client.sessionId,
				mode: draftSupport === "unsupported" ? "message" : "draft",
				pendingText: message.text,
				lastSentText: "",
			});
		} else {
			preview.pendingText = message.text;
		}
		schedulePreviewFlush(message.requestId);
		return;
	}
	if (message.type === "turn_result") {
		await handleTurnResult(client, message);
		return;
	}
	if (message.type === "send_progress") {
		const result = await sendProgress(client, message.text);
		respond(client, message.id, result.sent, result, result.reason);
		return;
	}
	if (message.type === "local_error") {
		if (config.allowedUserId !== undefined) {
			await sendTextReply(config.allowedUserId, `Pi stopped with an error:\n${clip(message.errorMessage || "Unknown error", 1500)}\n\nReply with what I should do next.`, client.sessionId).catch(() => undefined);
		}
	}
}

async function handleTurnResult(client, message) {
	if (message.stopReason === "aborted") {
		await clearPreview(message.requestId);
		return;
	}
	if (message.stopReason === "error") {
		await clearPreview(message.requestId);
		await sendTextReply(message.chatId, message.errorMessage || "Telegram bridge: pi failed while processing the request.", client.sessionId);
		return;
	}

	const finalText = message.text?.trim();
	if (finalText && formatSessionText(finalText, client.sessionId).length <= MAX_MESSAGE_LENGTH) {
		const finalized = await finalizePreview(message.requestId, finalText);
		if (!finalized && finalText) await sendTextReply(message.chatId, finalText, client.sessionId);
	} else {
		await clearPreview(message.requestId);
		if (finalText) {
			await sendTextReply(message.chatId, finalText, client.sessionId);
		} else if (message.attachments.length > 0) {
			await sendTextReply(message.chatId, "Attached requested file(s).", client.sessionId);
		}
	}
	await sendQueuedAttachments(message.chatId, message.attachments, client.sessionId);
}

async function sendProgress(client, text) {
	const message = String(text || "").trim().replace(/\s+/g, " ").slice(0, TELEGRAM_PROGRESS_MAX_LENGTH).trimEnd();
	if (!message) return { sent: false, reason: "Progress message is empty" };
	if (!config.botToken) return { sent: false, message, reason: "Telegram bot token is not configured" };
	if (config.allowedUserId === undefined) return { sent: false, message, reason: "Telegram bridge is not paired" };
	try {
		await sendTextReply(config.allowedUserId, message, client.sessionId);
		return { sent: true, message };
	} catch (error) {
		return { sent: false, message, reason: errorMessage(error) };
	}
}

function setupSocketServer() {
	server = createServer((socket) => {
		const client = {
			socket,
			authenticated: false,
			buffer: "",
			lastSeen: now(),
		};
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			client.buffer += chunk;
			let index;
			while ((index = client.buffer.indexOf("\n")) !== -1) {
				const line = client.buffer.slice(0, index).trim();
				client.buffer = client.buffer.slice(index + 1);
				if (!line) continue;
				try {
					const message = JSON.parse(line);
					void handleClientMessage(client, message).catch((error) => log(`client message failed: ${errorMessage(error)}`));
				} catch (error) {
					void log(`invalid client JSON: ${errorMessage(error)}`);
				}
			}
		});
		socket.on("close", () => {
			if (client.sessionId && sessions.get(client.sessionId) === client) {
				sessions.delete(client.sessionId);
				void writeStatus();
			}
		});
		socket.on("error", (error) => void log(`socket error: ${errorMessage(error)}`));
	});
}

async function removeStaleSocket() {
	if (!existsSync(BROKER_SOCKET_PATH)) return;
	await new Promise((resolve) => {
		const socket = createConnection(BROKER_SOCKET_PATH);
		socket.once("connect", () => {
			socket.end();
			resolve(false);
		});
		socket.once("error", () => resolve(true));
	}).then(async (shouldRemove) => {
		if (shouldRemove) await unlink(BROKER_SOCKET_PATH).catch(() => undefined);
	});
}

function sweepStaleSessions() {
	const cutoff = now() - SESSION_STALE_MS;
	let changed = false;
	for (const [sessionId, session] of sessions) {
		if (session.lastSeen < cutoff || !session.socket.writable) {
			sessions.delete(sessionId);
			changed = true;
		}
	}
	if (changed) void writeStatus();
}

function clip(text, max) {
	const value = String(text || "").trim();
	return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

async function main() {
	await ensureTelegramDir();
	await mkdir(TEMP_DIR, { recursive: true });
	await ensureBrokerSecret();
	state = await readState();
	await removeStaleSocket();
	setupSocketServer();
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(BROKER_SOCKET_PATH);
	});
	await writeStatus();
	await log(`broker started pid=${process.pid}`);
	await startPollingIfConfigured();
	setInterval(sweepStaleSessions, SESSION_SWEEP_MS).unref();
}

process.on("SIGTERM", () => {
	stopPolling();
	disposeCommunicationAgent();
	server?.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
});
process.on("SIGINT", () => {
	stopPolling();
	disposeCommunicationAgent();
	server?.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
});
process.on("uncaughtException", (error) => {
	void log(`uncaught exception: ${errorMessage(error)}`).finally(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
	void log(`unhandled rejection: ${errorMessage(error)}`).finally(() => process.exit(1));
});

main().catch((error) => {
	void log(`startup failed: ${errorMessage(error)}`).finally(() => process.exit(1));
});
