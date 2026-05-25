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
} from "@earendil-works/pi-coding-agent";

const TELEGRAM_DIR = join(homedir(), ".pi", "agent", "extensions", "telegram");
const OLD_CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const CONFIG_PATH = join(TELEGRAM_DIR, "telegram.json");
const TEMP_DIR = join(TELEGRAM_DIR, "tmp");
const BROKER_SOCKET_PATH = join(TELEGRAM_DIR, "broker.sock");
const BROKER_STATE_PATH = join(TELEGRAM_DIR, "broker-state.json");
const BROKER_STATUS_PATH = join(TELEGRAM_DIR, "broker.json");
const BROKER_LOG_PATH = join(TELEGRAM_DIR, "broker.log");
const MAX_MESSAGE_LENGTH = 4096;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const TELEGRAM_PROGRESS_MAX_LENGTH = 500;
const ROUTER_CONFIDENCE_THRESHOLD = 0.75;
const TELEGRAM_HISTORY_LIMIT = 50;
const ROUTE_DECISION_LIMIT = 50;
const MESSAGE_ROUTE_LIMIT = 500;
const SESSION_STALE_MS = 30_000;
const SESSION_SWEEP_MS = 10_000;
const ROUTER_TEXT_LIMIT = 1000;
const SESSION_SNIPPET_LIMIT = 12;
const PENDING_CHOICE_TTL_MS = 10 * 60 * 1000;

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
const pendingChoices = new Map();
const mediaGroups = new Map();
const previews = new Map();

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
		lastError,
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
		await clearPreview(requestId);
		await writeState();
		return true;
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

function fileSummaries(messages) {
	return collectTelegramFileInfos(messages).map((file) => ({ fileName: file.fileName, mimeType: file.mimeType, isImage: file.isImage }));
}

function messageRouteKey(chatId, messageId) {
	return `${chatId}:${messageId}`;
}

function linkTelegramMessage(chatId, messageId, sessionId, summary) {
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

async function deliverMessagesToSession(sessionId, messages, reason) {
	const session = sessions.get(sessionId);
	if (!session) {
		await askUserToChoose(messages, `Session disconnected before delivery (${sessionId}).`);
		return;
	}
	const first = messages[0];
	const rawText = rawTextForMessages(messages);
	const files = await buildTelegramFiles(messages);
	const requestId = randomUUID();
	const delivered = sendToClient(session, {
		v: 1,
		type: "deliver_turn",
		requestId,
		chatId: first.chat.id,
		fromUserId: first.from.id,
		replyToMessageId: first.message_id,
		rawText,
		telegramMessageIds: messages.map((message) => message.message_id),
		files,
	});
	if (!delivered) {
		await askUserToChoose(messages, `Session is no longer reachable (${sessionId}).`);
		return;
	}
	addTelegramHistory({ direction: "in", chatId: first.chat.id, messageId: first.message_id, text: clip(rawText || describeFiles(fileSummaries(messages)), 700), sessionId });
	addRouteDecision({ chatId: first.chat.id, messageId: first.message_id, sessionId, reason });
	await writeState();
}

async function routeAuthorizedMessages(messages) {
	const first = messages[0];
	if (!first) return;

	const choice = findPendingChoice(first);
	if (choice) {
		await handleChoiceReply(choice, first);
		return;
	}

	const replySessionId = findReplyRoute(first);
	if (replySessionId) {
		await deliverMessagesToSession(replySessionId, messages, "reply-to-linked-message");
		return;
	}

	const connected = [...sessions.values()].filter((session) => session.socket.writable);
	if (connected.length === 0) {
		await sendTextReply(first.chat.id, "No running pi sessions are connected to the Telegram broker yet.");
		return;
	}
	if (connected.length === 1) {
		await deliverMessagesToSession(connected[0].sessionId, messages, "only-connected-session");
		return;
	}

	const routed = await routeWithLlm(messages, connected);
	if (routed?.action === "route" && routed.confidence >= ROUTER_CONFIDENCE_THRESHOLD && sessions.has(routed.sessionId)) {
		await deliverMessagesToSession(routed.sessionId, messages, `llm:${clip(routed.reason || "", 160)}`);
		return;
	}

	await askUserToChoose(messages, routed?.reason || "I could not confidently choose a pi session.", routed?.options?.map((option) => option.sessionId));
}

async function runRouterPrompt(prompt) {
	const cwd = TELEGRAM_DIR;
	const agentDir = getAgentDir();
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
		systemPrompt: "You are a router for Telegram messages going to running pi coding-agent sessions. Return only strict JSON.",
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
		thinkingLevel: "low",
	});
	try {
		await session.prompt(prompt, { expandPromptTemplates: false });
		return extractAssistantText(session.messages);
	} finally {
		session.dispose();
	}
}

async function routeWithLlm(messages, connectedSessions) {
	try {
		const input = buildRouterInput(messages, connectedSessions);
		const prompt = `Choose which connected pi session should receive this Telegram message.\n\nRules:\n- Return only JSON. Do not wrap it in markdown.\n- If one session is clearly best, return {"action":"route","sessionId":"...","confidence":0.0-1.0,"reason":"short reason"}.\n- If the best target is ambiguous, return {"action":"ask","confidence":0.0-1.0,"reason":"short reason","options":[{"sessionId":"...","label":"short label"}]}.\n- Only use one of the provided sessionId values.\n- Prefer sessions whose cwd, recent messages, active task, or previous Telegram route decisions match the incoming message.\n\nRouter input:\n${JSON.stringify(input, null, 2)}`;
		return parseRouterJson(await runRouterPrompt(prompt));
	} catch (error) {
		lastError = `router failed: ${errorMessage(error)}`;
		await log(lastError);
		await writeStatus();
		return { action: "ask", confidence: 0, reason: lastError };
	}
}

function buildRouterInput(messages, connectedSessions) {
	const first = messages[0];
	return {
		incoming: {
			chatId: first.chat.id,
			messageIds: messages.map((message) => message.message_id),
			text: clip(rawTextForMessages(messages), ROUTER_TEXT_LIMIT),
			attachments: fileSummaries(messages),
			replyTo: first.reply_to_message
				? {
						messageId: first.reply_to_message.message_id,
						text: clip(first.reply_to_message.text || first.reply_to_message.caption || "", 400),
					}
				: undefined,
		},
		telegramHistory: state.telegramHistory.slice(-20),
		routeDecisions: state.routeDecisions.slice(-20),
		sessions: connectedSessions.map((session) => ({
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
		})),
	};
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

function parseRouterJson(text) {
	const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return undefined;
	const parsed = JSON.parse(cleaned.slice(start, end + 1));
	if (parsed.action === "route") {
		return {
			action: "route",
			sessionId: String(parsed.sessionId || ""),
			confidence: Number(parsed.confidence) || 0,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	}
	if (parsed.action === "ask") {
		return {
			action: "ask",
			confidence: Number(parsed.confidence) || 0,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			options: Array.isArray(parsed.options) ? parsed.options.filter((option) => typeof option?.sessionId === "string") : undefined,
		};
	}
	return undefined;
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

async function askUserToChoose(messages, reason, preferredSessionIds) {
	const first = messages[0];
	const connected = [...sessions.values()].filter((session) => session.socket.writable);
	const preferred = Array.isArray(preferredSessionIds)
		? preferredSessionIds.map((sessionId) => sessions.get(sessionId)).filter(Boolean)
		: [];
	const candidates = preferred.length > 0 ? preferred : connected;
	if (candidates.length === 0) {
		await sendTextReply(first.chat.id, "No running pi sessions are connected to the Telegram broker yet.");
		return;
	}
	const lines = ["Which pi session should receive this message?", "", reason, ""];
	candidates.forEach((session, index) => {
		lines.push(`${index + 1}. ${formatSessionLabel(session)}`);
	});
	lines.push("", "Send a number, or reply to this message with one.");
	const sentIds = await sendTextReply(first.chat.id, lines.join("\n"));
	const promptMessageId = sentIds.at(-1);
	if (promptMessageId === undefined) return;
	deletePendingChoicesForChat(first.chat.id);
	pendingChoices.set(messageRouteKey(first.chat.id, promptMessageId), {
		chatId: first.chat.id,
		promptMessageId,
		messages,
		candidateSessionIds: candidates.map((session) => session.sessionId),
		createdAt: now(),
	});
}

function isPendingChoiceExpired(choice) {
	return now() - choice.createdAt > PENDING_CHOICE_TTL_MS;
}

function deletePendingChoicesForChat(chatId) {
	for (const [key, choice] of pendingChoices) {
		if (choice.chatId === chatId) pendingChoices.delete(key);
	}
}

function findPendingChoice(message) {
	const replyMessageId = message.reply_to_message?.message_id;
	if (replyMessageId !== undefined) {
		const key = messageRouteKey(message.chat.id, replyMessageId);
		const choice = pendingChoices.get(key);
		if (choice && isPendingChoiceExpired(choice)) {
			pendingChoices.delete(key);
			return undefined;
		}
		if (choice) return choice;
	}

	const text = (message.text || message.caption || "").trim();
	if (!text) return undefined;
	let latest;
	for (const choice of pendingChoices.values()) {
		if (choice.chatId !== message.chat.id) continue;
		if (isPendingChoiceExpired(choice)) {
			pendingChoices.delete(messageRouteKey(choice.chatId, choice.promptMessageId));
			continue;
		}
		if (!latest || choice.createdAt > latest.createdAt) latest = choice;
	}
	return latest;
}

function parseChoiceJson(text) {
	const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return undefined;
	const parsed = JSON.parse(cleaned.slice(start, end + 1));
	return {
		action: parsed.action === "select" ? "select" : "no_match",
		sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
		confidence: Number(parsed.confidence) || 0,
		reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
	};
}

async function resolveChoiceWithLlm(choice, replyMessage) {
	const candidates = choice.candidateSessionIds
		.map((sessionId, index) => {
			const session = sessions.get(sessionId);
			return session
				? {
						index: index + 1,
						sessionId,
						label: formatSessionLabel(session),
						cwd: session.cwd,
						sessionName: session.sessionName,
						recentMessages: sanitizeSnippets(session.recentMessages),
					}
				: undefined;
		})
		.filter(Boolean);
	const input = {
		reply: {
			text: clip(replyMessage.text || replyMessage.caption || "", 300),
			replyToPromptMessageId: replyMessage.reply_to_message?.message_id,
		},
		pendingTelegramMessage: {
			text: clip(rawTextForMessages(choice.messages), ROUTER_TEXT_LIMIT),
			attachments: fileSummaries(choice.messages),
		},
		telegramHistory: state.telegramHistory.slice(-20),
		routeDecisions: state.routeDecisions.slice(-20),
		candidates,
	};
	const prompt = `A Telegram user is answering a pending pi session selection prompt. Decide which candidate they selected.\n\nRules:\n- Return only JSON. Do not wrap it in markdown.\n- If the reply selects a candidate, return {"action":"select","sessionId":"...","confidence":0.0-1.0,"reason":"short reason"}.\n- If the reply does not select a candidate, return {"action":"no_match","confidence":0.0-1.0,"reason":"short reason"}.\n- Use numeric references, natural-language references, cwd, session name, recent conversation, and the original pending Telegram message.\n- Only use one of the provided sessionId values.\n\nChoice input:\n${JSON.stringify(input, null, 2)}`;
	return parseChoiceJson(await runRouterPrompt(prompt));
}

async function resolveChoiceSessionId(choice, replyMessage) {
	const decision = await resolveChoiceWithLlm(choice, replyMessage).catch((error) => {
		lastError = `choice router failed: ${errorMessage(error)}`;
		void log(lastError);
		void writeStatus();
		return undefined;
	});
	if (decision?.action === "select" && decision.confidence >= 0.5 && choice.candidateSessionIds.includes(decision.sessionId)) {
		return decision.sessionId;
	}
	return undefined;
}

async function handleChoiceReply(choice, replyMessage) {
	const selectedSessionId = await resolveChoiceSessionId(choice, replyMessage);
	if (!selectedSessionId || !sessions.has(selectedSessionId)) {
		await sendTextReply(replyMessage.chat.id, "I could not match that choice. Send one of the listed numbers or names.");
		return;
	}
	pendingChoices.delete(messageRouteKey(choice.chatId, choice.promptMessageId));
	await deliverMessagesToSession(selectedSessionId, choice.messages, "telegram-user-choice");
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
		await sendTextReply(message.chat.id, "Send me a message and I will route it to the right running pi session. Reply to a bot message to target that session. Commands routed to sessions include /status, /compact, and stop.");
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
	server?.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
});
process.on("SIGINT", () => {
	stopPolling();
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
