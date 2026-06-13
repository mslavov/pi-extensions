#!/usr/bin/env node
import { createConnection, createServer } from "node:net";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

const CASPER_DIR = join(homedir(), ".pi", "agent", "extensions", "casper");
const CONFIG_PATH = join(CASPER_DIR, "casper.json");
const TEMP_DIR = join(CASPER_DIR, "tmp");
const BROKER_SOCKET_PATH = join(CASPER_DIR, "broker.sock");
const BROKER_STATE_PATH = join(CASPER_DIR, "broker-state.json");
const BROKER_STATUS_PATH = join(CASPER_DIR, "broker.json");
const BROKER_LOG_PATH = join(CASPER_DIR, "broker.log");
const DEFAULT_CHANNEL_PREFIX = "pi";
const SESSION_STALE_MS = 30_000;
const SESSION_SWEEP_MS = 10_000;
const STREAM_UPDATE_THROTTLE_MS = 1000;
const SLACK_SECTION_TEXT_LIMIT = 2900;
const SLACK_BLOCK_LIMIT = 48;
const TEXT_CLIP_LIMIT = 24_000;

let config = {};
let state = { version: 1, sessions: {}, channels: {} };
let server;
let slackSocket;
let slackReconnectTimer;
let slackConnecting = false;
let socketConnected = false;
let lastError;

const sessions = new Map();
const streamMessages = new Map();
const toolMessages = new Map();
const channelEnsures = new Map();
const joinedChannels = new Set();

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

async function ensureCasperDir() {
	await mkdir(CASPER_DIR, { recursive: true });
	await mkdir(TEMP_DIR, { recursive: true });
}

async function readConfig() {
	await ensureCasperDir();
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

async function writeConfig(nextConfig) {
	await ensureCasperDir();
	await writeFile(CONFIG_PATH, JSON.stringify(nextConfig, null, "\t") + "\n", "utf8");
}

async function ensureBrokerSecret() {
	config = await readConfig();
	if (!config.brokerSecret) {
		config = { ...config, brokerSecret: randomBytes(32).toString("hex") };
		await writeConfig(config);
	}
	config.channelPrefix = slugify(config.channelPrefix, DEFAULT_CHANNEL_PREFIX);
	config.archiveOnSessionClose = config.archiveOnSessionClose !== false;
}

async function readState() {
	try {
		const parsed = JSON.parse(await readFile(BROKER_STATE_PATH, "utf8"));
		return {
			version: 1,
			sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
			channels: parsed.channels && typeof parsed.channels === "object" ? parsed.channels : {},
		};
	} catch {
		return { version: 1, sessions: {}, channels: {} };
	}
}

async function writeState() {
	await ensureCasperDir();
	await writeFile(BROKER_STATE_PATH, JSON.stringify(state, null, "\t") + "\n", "utf8");
}

async function writeStatus() {
	await writeFile(BROKER_STATUS_PATH, JSON.stringify(buildStatus(), null, "\t") + "\n", "utf8").catch(() => undefined);
}

function buildStatus() {
	return {
		configured: Boolean(config.botToken && config.appToken),
		socketConnected,
		brokerPid: process.pid,
		botUserId: config.botUserId,
		botTeamId: config.botTeamId,
		userId: config.userId,
		channelPrefix: config.channelPrefix || DEFAULT_CHANNEL_PREFIX,
		archiveOnSessionClose: config.archiveOnSessionClose !== false,
		sessions: [...sessions.values()].map(publicSession),
		mappings: Object.values(state.sessions),
		lastError,
	};
}

function publicSession(session) {
	const mapping = state.sessions[session.sessionId];
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
		recentMessages: Array.isArray(session.recentMessages) ? session.recentMessages : [],
		lastSeen: session.lastSeen,
		channelId: mapping?.channelId,
		channelName: mapping?.channelName,
		channelState: mapping?.state,
	};
}

function configured() {
	return Boolean(config.botToken && config.appToken);
}

async function callSlack(method, body = {}, token = config.botToken, retriedRateLimit = false) {
	if (!token) throw new Error(`Slack token is not configured for ${method}`);
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
	});
	if (response.status === 429 && !retriedRateLimit) {
		const retryAfter = Number(response.headers.get("retry-after") || "1");
		await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1000));
		return callSlack(method, body, token, true);
	}
	const data = await response.json();
	if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || "unknown_error"}`);
	return data;
}

async function downloadSlackFile(file) {
	const url = file.url_private_download || file.url_private;
	if (!url) return undefined;
	const fileName = sanitizeFileName(file.name || file.title || `slack-file-${file.id || Date.now()}`);
	const targetPath = join(TEMP_DIR, `${Date.now()}-${fileName}`);
	const response = await fetch(url, { headers: { authorization: `Bearer ${config.botToken}` } });
	if (!response.ok) throw new Error(`Failed to download Slack file ${fileName}: ${response.status}`);
	const arrayBuffer = await response.arrayBuffer();
	await writeFile(targetPath, Buffer.from(arrayBuffer));
	return {
		path: targetPath,
		fileName,
		isImage: isImageMimeType(file.mimetype || file.filetype),
		mimeType: file.mimetype,
	};
}

async function collectSlackFiles(event) {
	const files = [];
	for (const file of Array.isArray(event.files) ? event.files : []) {
		try {
			const downloaded = await downloadSlackFile(file);
			if (downloaded) files.push(downloaded);
		} catch (error) {
			await log(`file download failed: ${errorMessage(error)}`);
		}
	}
	return files;
}

function isImageMimeType(mimeType) {
	return String(mimeType || "").toLowerCase().startsWith("image/");
}

function sanitizeFileName(name) {
	return String(name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";
}

function scheduleSlackReconnect() {
	if (slackReconnectTimer || !configured()) return;
	slackReconnectTimer = setTimeout(() => {
		slackReconnectTimer = undefined;
		void startSlackSocket().catch((error) => handleSlackError(error));
	}, 5000);
	slackReconnectTimer.unref?.();
}

async function startSlackSocket() {
	if (!configured() || slackSocket || slackConnecting) return;
	slackConnecting = true;
	try {
		const response = await callSlack("apps.connections.open", {}, config.appToken);
		const socket = new WebSocket(response.url);
		slackSocket = socket;
		socket.addEventListener("open", () => {
			socketConnected = true;
			lastError = undefined;
			void writeStatus();
		});
		socket.addEventListener("message", (event) => {
			void handleSlackSocketMessage(event.data).catch((error) => handleSlackError(error));
		});
		socket.addEventListener("close", () => {
			if (slackSocket === socket) slackSocket = undefined;
			socketConnected = false;
			void writeStatus();
			scheduleSlackReconnect();
		});
		socket.addEventListener("error", () => {
			lastError = "Slack Socket Mode websocket error";
			void writeStatus();
		});
	} finally {
		slackConnecting = false;
	}
}

function stopSlackSocket() {
	if (slackReconnectTimer) clearTimeout(slackReconnectTimer);
	slackReconnectTimer = undefined;
	const socket = slackSocket;
	slackSocket = undefined;
	socketConnected = false;
	try {
		socket?.close?.();
	} catch {
		// ignore
	}
}

async function handleSlackSocketMessage(data) {
	const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
	const envelope = JSON.parse(raw);
	if (envelope.envelope_id) acknowledgeSlackEnvelope(envelope.envelope_id);
	if (envelope.type === "hello") return;
	if (envelope.type === "disconnect") {
		stopSlackSocket();
		scheduleSlackReconnect();
		return;
	}
	if (envelope.type !== "events_api") return;
	await handleSlackEvent(envelope.payload?.event);
}

function acknowledgeSlackEnvelope(envelopeId) {
	if (!slackSocket || slackSocket.readyState !== 1) return;
	slackSocket.send(JSON.stringify({ envelope_id: envelopeId }));
}

async function handleSlackEvent(event) {
	if (!event || (event.type !== "message" && event.type !== "app_mention")) return;
	if (event.bot_id || event.user === config.botUserId) return;
	if (event.type === "message" && event.subtype && event.subtype !== "file_share") return;
	if (config.userId && event.user !== config.userId) return;

	const sessionId = state.channels[event.channel];
	if (!sessionId) return;
	const session = sessions.get(sessionId);
	if (!session || !session.socket.writable) {
		await postSlackMessage(event.channel, [sectionBlock(`No local pi session is connected for this channel.`)], `No local pi session is connected for this channel.`).catch((error) => log(`stale channel reply failed: ${errorMessage(error)}`));
		return;
	}
	const text = stripBotMention(event.text || "").trim();
	const files = await collectSlackFiles(event);
	sendToClient(session, {
		v: 1,
		type: "deliver_turn",
		requestId: randomUUID(),
		channelId: event.channel,
		userId: event.user,
		text,
		ts: event.ts,
		files,
	});
}

function stripBotMention(text) {
	if (!config.botUserId) return text;
	return String(text || "").replace(new RegExp(`<@${escapeRegExp(config.botUserId)}>`, "g"), "").trim();
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateSessionFromMessage(client, message) {
	const existing = sessions.get(message.sessionId);
	if (existing && existing !== client) existing.socket.destroy();
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
		recentMessages: Array.isArray(message.recentMessages) ? message.recentMessages.slice(-12) : [],
		lastSeen: now(),
	});
	sessions.set(message.sessionId, client);
}

async function ensureSessionChannel(session) {
	if (!configured()) return undefined;
	const existing = channelEnsures.get(session.sessionId);
	if (existing) return existing;
	const promise = ensureSessionChannelInner(session).finally(() => {
		if (channelEnsures.get(session.sessionId) === promise) channelEnsures.delete(session.sessionId);
	});
	channelEnsures.set(session.sessionId, promise);
	return promise;
}

async function ensureSessionChannelInner(session) {
	let mapping = state.sessions[session.sessionId];
	if (mapping?.channelId) {
		const topicChanged = mapping.cwd !== session.cwd || mapping.sessionFile !== session.sessionFile;
		const nameChanged = mapping.sessionName !== session.sessionName;
		mapping.cwd = session.cwd;
		mapping.sessionFile = session.sessionFile;
		mapping.sessionName = session.sessionName;
		mapping.updatedAt = now();
		if (mapping.state === "archived") {
			await callSlack("conversations.unarchive", { channel: mapping.channelId }).catch((error) => log(`channel unarchive failed: ${errorMessage(error)}`));
		}
		mapping.state = "active";
		delete mapping.closeReason;
		delete mapping.closedAt;
		delete mapping.archivedAt;
		state.channels[mapping.channelId] = session.sessionId;
		pruneChannelAliases(session.sessionId, mapping.channelId);
		await ensureBotInChannel(mapping.channelId);
		if (nameChanged) await maybeRenameSessionChannel(session, mapping);
		if (topicChanged) await setChannelTopic(session, mapping).catch((error) => log(`channel topic failed: ${errorMessage(error)}`));
		await writeState();
		return mapping;
	}

	const created = await createSessionChannel(session);
	const channelName = created.channel.name || channelNameForSession(session);
	mapping = {
		sessionId: session.sessionId,
		channelId: created.channel.id,
		channelName: created.channel.name || channelName,
		cwd: session.cwd,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		state: "active",
		createdAt: now(),
		updatedAt: now(),
	};
	state.sessions[session.sessionId] = mapping;
	state.channels[mapping.channelId] = session.sessionId;
	pruneChannelAliases(session.sessionId, mapping.channelId);
	await ensureBotInChannel(mapping.channelId);
	await inviteConfiguredUser(mapping.channelId);
	await setChannelTopic(session, mapping).catch((error) => log(`channel topic failed: ${errorMessage(error)}`));
	await postSlackMessage(mapping.channelId, sessionConnectedBlocks(session), `pi session connected: ${formatSessionLabel(session)}`).catch((error) => log(`welcome post failed: ${errorMessage(error)}`));
	await writeState();
	return mapping;
}

async function ensureBotInChannel(channelId) {
	if (joinedChannels.has(channelId)) return;
	if (config.privateChannels === true) return;
	try {
		await callSlack("conversations.join", { channel: channelId });
		joinedChannels.add(channelId);
	} catch (error) {
		const message = errorMessage(error);
		if (message.includes("already_in_channel")) {
			joinedChannels.add(channelId);
			return;
		}
		await log(`channel join failed: ${message}`);
	}
}

function pruneChannelAliases(sessionId, activeChannelId) {
	for (const [channelId, mappedSessionId] of Object.entries(state.channels)) {
		if (mappedSessionId === sessionId && channelId !== activeChannelId) delete state.channels[channelId];
	}
}

async function createSessionChannel(session) {
	const base = channelNameForSession(session);
	for (let i = 0; i < 10; i++) {
		const name = i === 0 ? base : trimChannelName(`${base}-${i + 1}`);
		try {
			return await callSlack("conversations.create", { name, is_private: config.privateChannels === true });
		} catch (error) {
			const message = errorMessage(error);
			if (message.includes("name_taken")) continue;
			throw error;
		}
	}
	return callSlack("conversations.create", {
		name: trimChannelName(`${base}-${randomUUID().slice(0, 4)}`),
		is_private: config.privateChannels === true,
	});
}

function channelNameForSession(session) {
	const prefix = slugify(config.channelPrefix, DEFAULT_CHANNEL_PREFIX).slice(0, 18) || DEFAULT_CHANNEL_PREFIX;
	const cwdName = slugify(basename(session.cwd || "workspace"), "workspace").slice(0, 28);
	const sessionSlug = slugify(session.sessionName, session.sessionId?.slice(0, 8) || "session").slice(0, 28);
	return trimChannelName(`${prefix}-${cwdName}-${sessionSlug}`);
}

function trimChannelName(name) {
	return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "pi-session";
}

async function maybeRenameSessionChannel(session, mapping) {
	const desired = channelNameForSession(session);
	if (!session.sessionName || desired === mapping.channelName) return;
	try {
		const renamed = await callSlack("conversations.rename", { channel: mapping.channelId, name: desired });
		mapping.channelName = renamed.channel?.name || desired;
	} catch (error) {
		const message = errorMessage(error);
		if (!message.includes("name_taken") && !message.includes("not_in_channel")) await log(`channel rename failed: ${message}`);
	}
}

async function inviteConfiguredUser(channelId) {
	if (!config.userId) return;
	await callSlack("conversations.invite", { channel: channelId, users: config.userId }).catch((error) => {
		const message = errorMessage(error);
		if (!message.includes("already_in_channel") && !message.includes("cant_invite_self")) void log(`channel invite failed: ${message}`);
	});
}

async function setChannelTopic(session, mapping) {
	const topic = clip(`pi session ${session.sessionId} · ${session.cwd || "unknown cwd"}${session.sessionFile ? ` · ${session.sessionFile}` : ""}`, 250);
	await callSlack("conversations.setTopic", { channel: mapping.channelId, topic });
}

async function archiveSessionChannel(sessionId, reason = "closed") {
	const mapping = state.sessions[sessionId];
	if (!mapping || mapping.state === "archived") return;
	mapping.state = "closed";
	mapping.closeReason = reason;
	mapping.closedAt = now();
	mapping.updatedAt = now();
	if (config.archiveOnSessionClose !== false && mapping.channelId && configured()) {
		await postSlackMessage(mapping.channelId, [sectionBlock(`:black_circle: pi session closed (${escapeMrkdwn(reason)}). Archiving this channel.`)], `pi session closed (${reason})`).catch(() => undefined);
		try {
			await callSlack("conversations.archive", { channel: mapping.channelId });
			mapping.state = "archived";
			mapping.archivedAt = now();
		} catch (error) {
			lastError = errorMessage(error);
			await log(`channel archive failed: ${lastError}`);
		}
	}
	await writeState();
	await writeStatus();
}

function sessionConnectedBlocks(session) {
	const mention = config.userId ? `<@${config.userId}> ` : "";
	return [
		sectionBlock(`:large_green_circle: ${mention}pi session connected`),
		fieldsBlock([
			`*Session*\n${escapeMrkdwn(session.sessionName || session.sessionId)}`,
			`*CWD*\n${escapeMrkdwn(session.cwd || "unknown")}`,
			`*Model*\n${escapeMrkdwn(session.model || "unknown")}`,
			`*PID*\n${session.pid}`,
		]),
	];
}

async function postForwardedEvent(client, forwarded) {
	const mapping = await ensureSessionChannel(client);
	if (!mapping?.channelId) return;
	const channel = mapping.channelId;
	if (forwarded.type === "message_start" && forwarded.streamId) {
		const posted = await postSlackMessage(channel, messageBlocks(forwarded.message, { title: "Assistant", streaming: true }), "Assistant is responding...");
		streamMessages.set(streamKey(client.sessionId, forwarded.streamId), { channel, ts: posted.ts, lastUpdateAt: now(), pending: forwarded, timer: undefined });
		return;
	}
	if (forwarded.type === "message_update" && forwarded.streamId) {
		await updateStreamMessage(client, forwarded, false);
		return;
	}
	if (forwarded.type === "message_end" && forwarded.streamId) {
		await updateStreamMessage(client, forwarded, true);
		return;
	}
	if (forwarded.type === "message_end") {
		await postSlackMessage(channel, messageBlocks(forwarded.message, { attention: forwarded.attention }), fallbackTextForMessage(forwarded.message));
		return;
	}
	if (forwarded.type === "tool_start") {
		const posted = await postSlackMessage(channel, toolStartBlocks(forwarded), `Tool started: ${forwarded.toolName}`);
		toolMessages.set(toolKey(client.sessionId, forwarded.toolCallId), { channel, ts: posted.ts });
		return;
	}
	if (forwarded.type === "tool_waiting") {
		await postSlackMessage(channel, attentionBlocks(`Input needed`, forwarded.text || "ask_user is waiting for input."), "Input needed");
		return;
	}
	if (forwarded.type === "tool_end") {
		const existing = toolMessages.get(toolKey(client.sessionId, forwarded.toolCallId));
		const blocks = toolEndBlocks(forwarded);
		if (existing) {
			await updateSlackMessage(existing.channel, existing.ts, blocks, `Tool finished: ${forwarded.toolName}`);
			toolMessages.delete(toolKey(client.sessionId, forwarded.toolCallId));
		} else {
			await postSlackMessage(channel, blocks, `Tool finished: ${forwarded.toolName}`);
		}
		return;
	}
	if (forwarded.type === "agent_started") {
		await postSlackMessage(channel, [contextBlock(":hourglass_flowing_sand: Agent started")], "Agent started");
		return;
	}
	if (forwarded.type === "agent_finished") {
		const text = forwarded.stopReason === "error" ? `Pi stopped with an error: ${forwarded.errorMessage || "unknown error"}` : forwarded.stopReason === "aborted" ? "Pi turn aborted." : "Pi turn finished.";
		await postSlackMessage(channel, attentionBlocks(text, "Reply in this channel to continue."), text);
		return;
	}
	if (forwarded.type === "session_started") {
		await postSlackMessage(channel, [contextBlock(":large_green_circle: Session bridge active")], "Session bridge active");
	}
}

async function updateStreamMessage(client, forwarded, final) {
	const key = streamKey(client.sessionId, forwarded.streamId);
	const existing = streamMessages.get(key);
	const mapping = state.sessions[client.sessionId] || (await ensureSessionChannel(client));
	if (!existing) {
		if (!mapping?.channelId) return;
		const posted = await postSlackMessage(mapping.channelId, messageBlocks(forwarded.message, { streaming: !final }), fallbackTextForMessage(forwarded.message));
		if (!final) streamMessages.set(key, { channel: mapping.channelId, ts: posted.ts, lastUpdateAt: now(), pending: forwarded, timer: undefined });
		return;
	}
	existing.pending = forwarded;
	const runUpdate = async () => {
		existing.timer = undefined;
		existing.lastUpdateAt = now();
		await updateSlackMessage(existing.channel, existing.ts, messageBlocks(existing.pending.message, { streaming: !final }), fallbackTextForMessage(existing.pending.message));
		if (final) streamMessages.delete(key);
	};
	if (final || now() - existing.lastUpdateAt >= STREAM_UPDATE_THROTTLE_MS) {
		if (existing.timer) clearTimeout(existing.timer);
		await runUpdate();
		return;
	}
	if (!existing.timer) {
		existing.timer = setTimeout(() => {
			void runUpdate().catch((error) => log(`stream update failed: ${errorMessage(error)}`));
		}, STREAM_UPDATE_THROTTLE_MS);
		existing.timer.unref?.();
	}
}

function streamKey(sessionId, streamId) {
	return `${sessionId}:${streamId}`;
}

function toolKey(sessionId, toolCallId) {
	return `${sessionId}:${toolCallId}`;
}

async function postSlackMessage(channel, blocks, text, retriedJoin = false) {
	try {
		return await callSlack("chat.postMessage", { channel, text: clip(stripFormatting(text), 3000), blocks: capBlocks(blocks), unfurl_links: false, unfurl_media: false });
	} catch (error) {
		if (!retriedJoin && errorMessage(error).includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return postSlackMessage(channel, blocks, text, true);
		}
		throw error;
	}
}

async function updateSlackMessage(channel, ts, blocks, text, retriedJoin = false) {
	try {
		return await callSlack("chat.update", { channel, ts, text: clip(stripFormatting(text), 3000), blocks: capBlocks(blocks) });
	} catch (error) {
		if (!retriedJoin && errorMessage(error).includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return updateSlackMessage(channel, ts, blocks, text, true);
		}
		throw error;
	}
}

function capBlocks(blocks) {
	return blocks.filter(Boolean).slice(0, SLACK_BLOCK_LIMIT);
}

function messageBlocks(message, options = {}) {
	const value = message && typeof message === "object" ? message : {};
	const role = value.role || "message";
	const title = options.title || roleLabel(role, value.customType);
	const blocks = [];
	const mention = options.attention && config.userId ? `<@${config.userId}> ` : "";
	blocks.push(sectionBlock(`${mention}*${escapeMrkdwn(title)}*${options.streaming ? " _(streaming)_" : ""}`));
	const content = value.content;
	if (typeof content === "string") {
		blocks.push(...textSectionBlocks(content));
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text") blocks.push(...textSectionBlocks(block.text || ""));
			else if (block.type === "thinking") blocks.push(...textSectionBlocks(`_Thinking:_\n${block.thinking || ""}`, 1200));
			else if (block.type === "toolCall") blocks.push(...toolCallContentBlocks(block));
			else if (block.type === "image") blocks.push(contextBlock(`Image content (${escapeMrkdwn(block.mimeType || "image")}) is present in the pi message.`));
		}
	}
	if (role === "toolResult") {
		blocks.push(contextBlock(`tool result: ${escapeMrkdwn(value.toolName || "unknown")} · ${value.isError ? "error" : "ok"}`));
	}
	if (value.stopReason === "error" && value.errorMessage) blocks.push(sectionBlock(`:warning: ${escapeMrkdwn(value.errorMessage)}`));
	if (blocks.length === 1) blocks.push(contextBlock("(no text content)"));
	return blocks;
}

function roleLabel(role, customType) {
	if (role === "user") return "User";
	if (role === "assistant") return "Assistant";
	if (role === "toolResult") return "Tool result";
	if (role === "custom") return customType ? `Custom: ${customType}` : "Custom";
	if (role === "bashExecution") return "Bash execution";
	if (role === "branchSummary") return "Branch summary";
	if (role === "compactionSummary") return "Compaction summary";
	return String(role || "Message");
}

function fallbackTextForMessage(message) {
	const value = message && typeof message === "object" ? message : {};
	const content = value.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text = content
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text") return block.text || "";
				if (block.type === "toolCall") return `Tool call: ${block.name || "unknown"}`;
				if (block.type === "thinking") return block.thinking || "";
				return "";
			})
			.filter(Boolean)
			.join("\n");
		if (text) return text;
	}
	return roleLabel(value.role, value.customType);
}

function textSectionBlocks(text, limit = SLACK_SECTION_TEXT_LIMIT) {
	const clean = clip(String(text || "").trim(), TEXT_CLIP_LIMIT);
	if (!clean) return [];
	return chunkText(clean, limit).map((chunk) => sectionBlock(escapeMrkdwn(chunk)));
}

function toolCallContentBlocks(block) {
	const name = block.name || "unknown";
	return [sectionBlock(`*Tool call:* \`${escapeMrkdwn(name)}\``), sectionBlock(codeBlock(safeJson(block.arguments || {})))];
}

function toolStartBlocks(event) {
	return [sectionBlock(`:hammer_and_wrench: *Tool started:* \`${escapeMrkdwn(event.toolName)}\``), sectionBlock(codeBlock(safeJson(event.args || {})))];
}

function toolEndBlocks(event) {
	const icon = event.isError ? ":warning:" : ":white_check_mark:";
	return [
		sectionBlock(`${icon} *Tool finished:* \`${escapeMrkdwn(event.toolName)}\``),
		...resultBlocks(event.result),
	];
}

function resultBlocks(result) {
	if (!result || typeof result !== "object") return [];
	const content = Array.isArray(result.content) ? result.content : [];
	const text = content
		.map((block) => (block && typeof block === "object" && block.type === "text" ? block.text || "" : ""))
		.filter(Boolean)
		.join("\n");
	if (!text) return [sectionBlock(codeBlock(safeJson(result)))];
	return chunkText(clip(text, 5000), SLACK_SECTION_TEXT_LIMIT - 20).map((chunk) => sectionBlock(codeBlock(chunk)));
}

function attentionBlocks(title, detail) {
	const mention = config.userId ? `<@${config.userId}> ` : "";
	return [sectionBlock(`${mention}${escapeMrkdwn(title)}`), contextBlock(escapeMrkdwn(detail))];
}

function fieldsBlock(fields) {
	return {
		type: "section",
		fields: fields.map((text) => ({ type: "mrkdwn", text: clip(text, 1900) })),
	};
}

function sectionBlock(text) {
	return { type: "section", text: { type: "mrkdwn", text: clip(text || " ", SLACK_SECTION_TEXT_LIMIT) || " " } };
}

function contextBlock(text) {
	return { type: "context", elements: [{ type: "mrkdwn", text: clip(text || " ", 1900) || " " }] };
}

function codeBlock(text) {
	return `\`\`\`\n${String(text || "").replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function safeJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function chunkText(text, limit) {
	const chunks = [];
	let current = String(text || "");
	while (current.length > limit) {
		let split = current.lastIndexOf("\n", limit);
		if (split < limit * 0.5) split = limit;
		chunks.push(current.slice(0, split));
		current = current.slice(split).trimStart();
	}
	if (current) chunks.push(current);
	return chunks;
}

function escapeMrkdwn(text) {
	return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripFormatting(text) {
	return String(text || "").replace(/\*/g, "").replace(/_/g, "").replace(/`/g, "");
}

function slugify(value, fallback) {
	const slug = String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || fallback;
}

function clip(text, max) {
	const value = String(text || "");
	return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function formatSessionLabel(session) {
	const name = session.sessionName ? `${session.sessionName} — ` : "";
	const stateText = session.isIdle ? "idle" : "busy";
	const queued = session.queuedTurns ? `, ${session.queuedTurns} queued` : "";
	return `${name}${session.cwd} (${stateText}${queued})`;
}

function sendToClient(client, message) {
	if (!client.socket.writable) return false;
	client.socket.write(`${JSON.stringify(message)}\n`);
	return true;
}

function respond(client, id, ok, result, error) {
	if (!id) return;
	sendToClient(client, { v: 1, type: "response", id, ok, result, error });
}

async function reloadConfig() {
	const previousBotToken = config.botToken;
	const previousAppToken = config.appToken;
	await ensureBrokerSecret();
	if (previousBotToken !== config.botToken || previousAppToken !== config.appToken) stopSlackSocket();
	await startSlackSocket();
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
		let mapping;
		try {
			mapping = await ensureSessionChannel(client);
		} catch (error) {
			lastError = errorMessage(error);
			await log(`ensure channel failed: ${lastError}`);
		}
		sendToClient(client, { v: 1, type: "hello_ack", configured: configured(), channelId: mapping?.channelId, channelName: mapping?.channelName });
		await writeStatus();
		return;
	}
	if (!client.authenticated) return;

	if (message.type === "session_update") {
		updateSessionFromMessage(client, message);
		try {
			await ensureSessionChannel(client);
		} catch (error) {
			lastError = errorMessage(error);
			await log(`session update channel failed: ${lastError}`);
		}
		await writeStatus();
		return;
	}
	if (message.type === "session_closed") {
		await archiveSessionChannel(message.sessionId, message.reason || "closed");
		if (sessions.get(message.sessionId) === client) sessions.delete(message.sessionId);
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
	if (message.type === "forward_event") {
		try {
			await postForwardedEvent(client, message.event);
		} catch (error) {
			lastError = errorMessage(error);
			await log(`forward event failed: ${lastError}`);
			await writeStatus();
		}
	}
}

function setupSocketServer() {
	server = createServer((socket) => {
		const client = { socket, authenticated: false, buffer: "", lastSeen: now() };
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
			// Stale sweep archives dead sessions after a grace period, so reloads can reconnect.
			void writeStatus();
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
	for (const [sessionId, session] of sessions) {
		if (session.lastSeen < cutoff || !session.socket.writable) {
			sessions.delete(sessionId);
			void archiveSessionChannel(sessionId, "stale").catch((error) => log(`stale archive failed: ${errorMessage(error)}`));
		}
	}
	void writeStatus();
}

async function handleSlackError(error) {
	lastError = errorMessage(error);
	await log(`slack error: ${lastError}`);
	await writeStatus();
	scheduleSlackReconnect();
}

async function main() {
	await ensureCasperDir();
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
	await startSlackSocket();
	setInterval(sweepStaleSessions, SESSION_SWEEP_MS).unref();
}

process.on("SIGTERM", () => {
	stopSlackSocket();
	server?.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
});
process.on("SIGINT", () => {
	stopSlackSocket();
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
