#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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
import { blocksToPlainText, markdownToBlocks } from "markdown-to-slack-blocks";
import { Type } from "typebox";

const CASPER_DIR = join(homedir(), ".pi", "agent", "extensions", "casper");
const CONFIG_PATH = join(CASPER_DIR, "casper.json");
const TEMP_DIR = join(CASPER_DIR, "tmp");
const PLAN_ARTIFACT_DIR = join(CASPER_DIR, "plans");
const BROKER_SOCKET_PATH = join(CASPER_DIR, "broker.sock");
const BROKER_STATE_PATH = join(CASPER_DIR, "broker-state.json");
const BROKER_STATUS_PATH = join(CASPER_DIR, "broker.json");
const BROKER_LOG_PATH = join(CASPER_DIR, "broker.log");
const COMMUNICATION_AGENT_SESSION_DIR = join(CASPER_DIR, "communication-agent");
const DEFAULT_CHANNEL_PREFIX = "pi";
const SESSION_STALE_MS = 30_000;
const SESSION_SWEEP_MS = 10_000;
const CHANNEL_INFO_CACHE_MS = 60_000;
const SLACK_SECTION_TEXT_LIMIT = 2900;
const SLACK_BLOCK_LIMIT = 48;
const SLACK_MAX_FIELDS_PER_SECTION = 10;
const TEXT_CLIP_LIMIT = 24_000;
const COMMUNICATION_TEXT_LIMIT = 1000;
const COMMUNICATION_AGENT_TOOL_NAMES = ["slack_get_status", "slack_send_to_session", "slack_control_session"];
const PLAN_REFINE_CALLBACK_ID = "casper_plan_refine";
const PLAN_APPROVE_ACTION_ID = "casper_plan_approve";
const PLAN_REFINE_ACTION_ID = "casper_plan_refine";
const PLAN_EXIT_ACTION_ID = "casper_plan_exit";
const ASK_USER_CALLBACK_ID = "casper_ask_user";
const ASK_USER_OPEN_MODAL_ACTION_ID = "casper_ask_open_modal";
const ASK_USER_ANSWER_ACTION_ID = "casper_ask_answer";
const ASK_USER_CANCEL_ACTION_ID = "casper_ask_cancel";
const ASK_USER_DIRECT_BUTTON_LIMIT = 5;
const ASK_USER_STATIC_SELECT_LIMIT = 100;

let config = {};
let state = { version: 1, sessions: {}, channels: {} };
let server;
let slackSocket;
let slackReconnectTimer;
let slackConnecting = false;
let socketConnected = false;
let lastError;

const sessions = new Map();
const assistantTurnMessages = new Map();
const toolSummaryMessages = new Map();
const compactionMessages = new Map();
const planReviews = new Map();
const planActionRequests = new Map();
const ngrokTunnels = new Map();
const askUserPrompts = new Map();
const askUserPromptIdsByToolCall = new Map();
const askUserActionRequests = new Map();
const channelEnsures = new Map();
const channelInfoCache = new Map();
const joinedChannels = new Set();
const invitedChannels = new Set();
let configuredUserProfile;
let configuredUserProfileUserId;
let communicationAgent;
let communicationAgentReady;
let communicationActiveTurn;
let communicationQueue = [];
let communicationProcessing = false;
let communicationLastError;
let communicationLastHandledAt;

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
	await mkdir(PLAN_ARTIFACT_DIR, { recursive: true });
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
		communicationAgent: communicationAgentStatus(),
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

function communicationAgentStatus() {
	const session = communicationAgent?.session;
	return {
		enabled: configured(),
		sessionId: session?.sessionId,
		sessionFile: session?.sessionFile,
		isIdle: !communicationProcessing && !session?.isStreaming,
		activeTurn: communicationActiveTurn ? { requestId: communicationActiveTurn.requestId, channelId: communicationActiveTurn.channelId } : undefined,
		pendingMessages: communicationQueue.length,
		lastError: communicationLastError,
		lastHandledAt: communicationLastHandledAt,
		contextPercent: null,
	};
}

function configured() {
	return Boolean(config.botToken && config.appToken);
}

async function callSlack(method, body = {}, token = config.botToken, retriedRateLimit = false) {
	if (!token) throw new Error(`Slack token is not configured for ${method}`);
	const formBody = new URLSearchParams();
	for (const [key, value] of Object.entries(body)) {
		if (value === undefined) continue;
		formBody.set(key, typeof value === "string" ? value : JSON.stringify(value));
	}
	const response = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: formBody,
	});
	if (response.status === 429 && !retriedRateLimit) {
		const retryAfter = Number(response.headers.get("retry-after") || "1");
		await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1000));
		return callSlack(method, body, token, true);
	}
	const data = await response.json();
	if (!data.ok) {
		const details = [
			...(Array.isArray(data.errors) ? data.errors : []),
			...(Array.isArray(data.response_metadata?.messages) ? data.response_metadata.messages : []),
		].filter(Boolean);
		throw new Error(`Slack ${method} failed: ${data.error || "unknown_error"}${details.length > 0 ? ` (${details.join("; ")})` : ""}`);
	}
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
	if (envelope.type === "slash_commands") {
		await handleSlackCommand(envelope.payload);
		return;
	}
	if (envelope.type === "interactive") {
		await handleSlackInteractive(envelope.payload);
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

	const rawText = stripBotMention(event.text || "").trim();
	const text = normalizeCasperCommandText(rawText, { requirePrefix: true }) ?? rawText;
	const files = await collectSlackFiles(event);
	await routeSlackInput({
		channelId: event.channel,
		userId: event.user,
		text,
		ts: event.ts,
		files,
	});
}

async function handleSlackCommand(payload) {
	if (!payload || payload.command !== "/casper") return;
	if (config.userId && payload.user_id !== config.userId) return;
	const text = normalizeCasperCommandText(payload.text || "", { requirePrefix: false });
	if (!text) {
		await postSlackEphemeral(payload.channel_id, payload.user_id, textSectionBlocks(casperCommandHelpText()), casperCommandHelpText()).catch((error) => log(`slash command help failed: ${errorMessage(error)}`));
		return;
	}
	await routeSlackInput({
		channelId: payload.channel_id,
		userId: payload.user_id,
		text,
		files: [],
	});
}

async function handleSlackInteractive(payload) {
	if (!payload) return;
	const userId = payload.user?.id || payload.user_id;
	if (config.userId && userId !== config.userId) return;
	if (payload.type === "block_actions") {
		const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
		if (!action?.action_id) return;
		if (action.action_id === ASK_USER_ANSWER_ACTION_ID || action.action_id.startsWith(`${ASK_USER_ANSWER_ACTION_ID}_`)) {
			await submitAskUserAction(parseAskUserButtonValue(action.value), payload);
			return;
		}
		if (action.action_id === ASK_USER_CANCEL_ACTION_ID) {
			await submitAskUserAction({ promptId: action.value, response: null }, payload);
			return;
		}
		if (action.action_id === ASK_USER_OPEN_MODAL_ACTION_ID) {
			await openAskUserModal(action.value, payload);
			return;
		}
		if (action.action_id === PLAN_APPROVE_ACTION_ID) {
			await submitPlanAction(action.value, "approve", undefined, payload);
			return;
		}
		if (action.action_id === PLAN_EXIT_ACTION_ID) {
			await submitPlanAction(action.value, "exit", undefined, payload);
			return;
		}
		if (action.action_id === PLAN_REFINE_ACTION_ID) {
			await openPlanRefineModal(action.value, payload);
		}
		return;
	}
	if (payload.type === "view_submission" && payload.view?.callback_id === PLAN_REFINE_CALLBACK_ID) {
		const metadata = parseJson(payload.view.private_metadata) || {};
		const feedback = extractPlanRefineFeedback(payload.view);
		await submitPlanAction(metadata.planId, "refine", feedback, payload);
		return;
	}
	if (payload.type === "view_submission" && payload.view?.callback_id === ASK_USER_CALLBACK_ID) {
		const metadata = parseJson(payload.view.private_metadata) || {};
		await submitAskUserAction({ promptId: metadata.promptId, response: extractAskUserModalResponse(metadata.promptId, payload.view) }, payload);
	}
}

async function routeSlackInput({ channelId, userId, text, ts, files }) {
	if (!channelId || !userId) return;
	const sessionId = state.channels[channelId];
	const session = sessionId ? sessions.get(sessionId) : undefined;
	if (sessionId && session?.socket.writable) {
		try {
			await deliverTurnToSession({
				sessionId,
				channelId,
				userId,
				text,
				ts,
				files,
				source: "slack_user",
			});
			return;
		} catch (error) {
			await log(`direct Slack delivery failed: ${errorMessage(error)}`);
		}
	}
	enqueueCommunicationTurn({
		requestId: randomUUID(),
		channelId,
		channelName: await maybeChannelName(channelId, sessionId),
		userId,
		ts,
		text,
		files,
		mappedSessionId: sessionId,
		mappedSessionLive: Boolean(session?.socket.writable),
		isMappedChannel: Boolean(sessionId),
	});
}

function normalizeCasperCommandText(text, options = {}) {
	let value = String(text || "").trim();
	let hasPrefix = false;
	for (const prefix of ["casper ", "!casper "]) {
		if (value.toLowerCase().startsWith(prefix)) {
			value = value.slice(prefix.length).trim();
			hasPrefix = true;
			break;
		}
	}
	if (["casper", "!casper"].includes(value.toLowerCase())) {
		hasPrefix = true;
		value = "";
	}
	if (options.requirePrefix && !hasPrefix) return undefined;
	if (!value || value.toLowerCase() === "help") return undefined;
	if (value.startsWith("/")) return value;
	return `/${value}`;
}

function casperCommandHelpText() {
	return [
		"Casper command usage:",
		"/casper status",
		"/casper casper-status",
		"/casper compact",
		"/casper stop",
		"/casper reload",
		"/casper skill:name optional instructions",
		"You can also send normal channel messages like `casper status` or `!casper status`.",
	].join("\n");
}

async function maybeChannelName(channelId, sessionId) {
	const mapping = sessionId ? state.sessions[sessionId] : undefined;
	if (mapping?.channelName) return mapping.channelName;
	const info = await getChannelInfo(channelId).catch(() => undefined);
	return info?.name;
}

function stripBotMention(text) {
	if (!config.botUserId) return text;
	return String(text || "").replace(new RegExp(`<@${escapeRegExp(config.botUserId)}>`, "g"), "").trim();
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCommunicationSystemPrompt() {
	return `You are Casper, the Slack communication agent for pi.

You handle Slack messages that cannot be routed directly to an active local pi session. Every Slack message arrives with structured metadata. Your job is to answer conversational Slack messages directly and help the user work with connected pi sessions.

Capabilities:
- Answer directly when a request is conversational or asks about connected sessions.
- Use slack_get_status to inspect the broker and running pi sessions.
- Use slack_send_to_session to send exact user-delegated instructions to a currently connected pi session.
- Use slack_control_session for status, compact, and stop actions.

Rules:
- Keep Slack replies concise and useful.
- Delegate coding, repository, shell, file, browser, and long-running work to a target pi session. Do not pretend to perform coding work yourself.
- If the Slack channel is mapped to a connected pi session, strongly prefer that session unless the user clearly asks otherwise.
- If only one pi session is connected, you may use it without asking when delegation is needed.
- If the target session is ambiguous, ask the Slack user which session to use instead of guessing.
- When delegating, send the target session a concise, complete instruction written on the user's behalf.
- Target sessions reply in their own Casper Slack session channels.
- If attachments are present and the user asks to analyze or transform them, delegate to a pi session and include current attachments.
- Normal local pi agents do not have Slack messaging tools.`;
}

function createCommunicationTools() {
	return [
		defineTool({
			name: "slack_get_status",
			label: "Casper Status",
			description: "Inspect Casper broker status and currently connected pi sessions.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				const status = buildStatus();
				const lines = [
					`Connected sessions: ${status.sessions.length}`,
					...status.sessions.map((session) => `- ${formatSessionLabel(session)}${session.channelName ? ` (#${session.channelName})` : ""}`),
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { ok: true, status },
				};
			},
		}),
		defineTool({
			name: "slack_send_to_session",
			label: "Send To pi Session",
			description: "Send an exact user-delegated message to a currently connected pi session.",
			parameters: Type.Object({
				sessionId: Type.String({ description: "Target connected pi session id", minLength: 1 }),
				text: Type.String({ description: "Exact text to deliver to the target pi session", minLength: 1 }),
				includeCurrentAttachments: Type.Optional(Type.Boolean({ description: "Include files from the current Slack message", default: true })),
				reason: Type.Optional(Type.String({ description: "Short routing reason", maxLength: 200 })),
			}),
			async execute(_toolCallId, params) {
				const turn = communicationActiveTurn;
				if (!turn) {
					return {
						content: [{ type: "text", text: "Could not deliver: there is no active Slack communication turn." }],
						details: { ok: false, delivered: false, reason: "no-active-turn" },
					};
				}
				try {
					const files = params.includeCurrentAttachments === false ? [] : turn.files;
					const delivered = await deliverTurnToSession({
						sessionId: params.sessionId,
						channelId: turn.channelId,
						userId: turn.userId,
						ts: turn.ts,
						text: params.text,
						files,
						source: "communication_agent",
						delegatedByRequestId: turn.requestId,
					});
					return {
						content: [{ type: "text", text: `Delivered to ${delivered.sessionLabel}.` }],
						details: { ok: true, delivered: true, delegatedReplyExpected: true, reason: params.reason || "communication-agent", ...delivered },
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
			name: "slack_control_session",
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
						content: [{ type: "text", text: "Could not deliver: there is no active Slack communication turn." }],
						details: { ok: false, delivered: false, reason: "no-active-turn" },
					};
				}
				const commandText = params.action === "status" ? "/status" : params.action === "compact" ? "/compact" : "stop";
				try {
					const delivered = await deliverTurnToSession({
						sessionId: params.sessionId,
						channelId: turn.channelId,
						userId: turn.userId,
						ts: turn.ts,
						text: commandText,
						files: [],
						source: "communication_agent",
						delegatedByRequestId: turn.requestId,
					});
					return {
						content: [{ type: "text", text: `Sent ${params.action} to ${delivered.sessionLabel}.` }],
						details: { ok: true, delivered: true, delegatedReplyExpected: true, action: params.action, commandText, reason: params.reason || `communication-agent:${params.action}`, ...delivered },
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
		const cwd = CASPER_DIR;
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
		communicationAgent = { session };
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

function buildCommunicationPrompt(turn) {
	const connected = getConnectedSessions();
	const mappedSession = turn.mappedSessionId ? state.sessions[turn.mappedSessionId] : undefined;
	const input = {
		incoming: {
			channelId: turn.channelId,
			channelName: turn.channelName,
			userId: turn.userId,
			messageTs: turn.ts,
			text: clip(turn.text, COMMUNICATION_TEXT_LIMIT),
			attachments: turn.files.map((file) => ({ fileName: file.fileName, path: file.path, mimeType: file.mimeType, isImage: file.isImage })),
		},
		routingHints: {
			mappedSessionId: turn.mappedSessionId,
			mappedSessionLive: turn.mappedSessionLive,
			mappedSessionName: mappedSession?.sessionName,
			mappedSessionCwd: mappedSession?.cwd,
			onlyConnectedSessionId: connected.length === 1 ? connected[0].sessionId : undefined,
			connectedSessionCount: connected.length,
		},
		sessions: connected.map(communicationSessionSnapshot),
	};
	return `Handle this Slack message. Decide whether to answer directly or delegate to a connected pi session with your tools.\n\nSlack turn:\n${JSON.stringify(input, null, 2)}`;
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
	try {
		const agent = await ensureCommunicationAgent();
		turn.prompt = buildCommunicationPrompt(turn);
		const startIndex = agent.session.messages.length;
		await agent.session.prompt(turn.prompt, { expandPromptTemplates: false });
		const newMessages = agent.session.messages.slice(startIndex);
		const finalText = extractAssistantText(newMessages).trim();
		if (finalText) await postSlackMessage(turn.channelId, textSectionBlocks(finalText), finalText);
		communicationLastError = undefined;
		communicationLastHandledAt = now();
	} catch (error) {
		communicationLastError = `communication turn failed: ${errorMessage(error)}`;
		await log(communicationLastError);
		await postSlackMessage(turn.channelId, textSectionBlocks(`Casper communication agent failed: ${errorMessage(error)}`), `Casper communication agent failed: ${errorMessage(error)}`).catch((postError) => log(`communication error reply failed: ${errorMessage(postError)}`));
	} finally {
		communicationActiveTurn = undefined;
		await writeStatus();
	}
}

async function deliverTurnToSession({
	sessionId,
	channelId,
	userId,
	ts,
	text,
	files = [],
	source = "slack_user",
	delegatedByRequestId,
}) {
	const session = sessions.get(sessionId);
	if (!session || !session.socket.writable) throw new Error(`Session is not connected (${sessionId})`);
	const requestId = randomUUID();
	const delivered = sendToClient(session, {
		v: 1,
		type: "deliver_turn",
		requestId,
		channelId,
		userId,
		text,
		ts,
		files,
		source,
		delegatedByRequestId,
	});
	if (!delivered) throw new Error(`Session is no longer reachable (${sessionId})`);
	await writeStatus();
	return {
		requestId,
		sessionId,
		sessionLabel: formatSessionLabel(session),
		channelId,
		filesIncluded: files.length,
		source,
		delegatedByRequestId,
	};
}

function getConnectedSessions() {
	return [...sessions.values()].filter((session) => session.socket.writable);
}

function communicationSessionSnapshot(session) {
	const snapshot = publicSession(session);
	return {
		...snapshot,
		recentMessages: sanitizeSnippets(snapshot.recentMessages),
	};
}

function disposeCommunicationAgent() {
	communicationAgent?.session?.dispose?.();
	communicationAgent = undefined;
	communicationAgentReady = undefined;
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
		const repaired = await repairMappedChannel(mapping).catch((error) => {
			log(`channel repair failed: ${errorMessage(error)}`);
			return false;
		});
		if (!repaired) {
			mapping.state = "archived";
			mapping.archivedAt ||= now();
			mapping.updatedAt = now();
			await writeState();
			return undefined;
		}
		const topicChanged = mapping.cwd !== session.cwd || mapping.sessionFile !== session.sessionFile;
		const nameChanged = mapping.sessionName !== session.sessionName;
		mapping.cwd = session.cwd;
		mapping.sessionFile = session.sessionFile;
		mapping.sessionName = session.sessionName;
		mapping.updatedAt = now();
		mapping.state = "active";
		delete mapping.closeReason;
		delete mapping.closedAt;
		delete mapping.archivedAt;
		state.channels[mapping.channelId] = session.sessionId;
		pruneChannelAliases(session.sessionId, mapping.channelId);
		await ensureBotInChannel(mapping.channelId);
		await inviteConfiguredUser(mapping.channelId);
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

async function repairMappedChannel(mapping) {
	const info = await getChannelInfo(mapping.channelId);
	if (!info || !info.is_archived) return true;
	joinedChannels.delete(mapping.channelId);
	invitedChannels.delete(mapping.channelId);
	await callSlack("conversations.unarchive", { channel: mapping.channelId });
	channelInfoCache.delete(mapping.channelId);
	return true;
}

async function getChannelInfo(channelId) {
	const cached = channelInfoCache.get(channelId);
	if (cached && cached.expiresAt > now()) return cached.channel;
	const result = await callSlack("conversations.info", { channel: channelId });
	channelInfoCache.set(channelId, { channel: result.channel, expiresAt: now() + CHANNEL_INFO_CACHE_MS });
	return result.channel;
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
	if (invitedChannels.has(channelId)) return;
	await callSlack("conversations.invite", { channel: channelId, users: config.userId }).then(() => {
		invitedChannels.add(channelId);
	}).catch((error) => {
		const message = errorMessage(error);
		if (message.includes("already_in_channel") || message.includes("cant_invite_self")) {
			invitedChannels.add(channelId);
			return;
		}
		void log(`channel invite failed: ${message}`);
	});
}

async function setChannelTopic(session, mapping) {
	const topic = clip(`pi session ${session.sessionId} · ${session.cwd || "unknown cwd"}${session.sessionFile ? ` · ${session.sessionFile}` : ""}`, 250);
	await callSlack("conversations.setTopic", { channel: mapping.channelId, topic });
}

async function archiveSessionChannel(sessionId, reason = "closed", options = {}) {
	clearAssistantTurnMessage(sessionId);
	clearToolSummaryMessage(sessionId);
	clearCompactionMessage(sessionId);
	const mapping = state.sessions[sessionId];
	if (!mapping || mapping.state === "archived") return;
	mapping.state = "closed";
	mapping.closeReason = reason;
	mapping.closedAt = now();
	mapping.updatedAt = now();
	const shouldArchive = options.archive !== false;
	const shouldNotify = options.notify !== false;
	if (shouldArchive && config.archiveOnSessionClose !== false && mapping.channelId && configured()) {
		if (shouldNotify) await postSlackMessage(mapping.channelId, [sectionBlock(`:black_circle: pi session closed (${escapeMrkdwn(reason)}). Archiving this channel.`)], `pi session closed (${reason})`).catch(() => undefined);
		try {
			await callSlack("conversations.archive", { channel: mapping.channelId });
			channelInfoCache.delete(mapping.channelId);
			mapping.state = "archived";
			mapping.archivedAt = now();
		} catch (error) {
			const message = errorMessage(error);
			if (message.includes("already_archived")) {
				channelInfoCache.delete(mapping.channelId);
				mapping.state = "archived";
				mapping.archivedAt = now();
			} else {
				lastError = message;
				await log(`channel archive failed: ${lastError}`);
			}
		}
	} else if (shouldNotify && mapping.channelId && configured()) {
		await postSlackMessage(mapping.channelId, [sectionBlock(`:black_circle: pi session closed (${escapeMrkdwn(reason)}).`)], `pi session closed (${reason})`).catch(() => undefined);
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
		await updateAssistantTurnMessage(client, channel, forwarded, false);
		return;
	}
	if (forwarded.type === "message_update" && forwarded.streamId) {
		await updateAssistantTurnMessage(client, channel, forwarded, false);
		return;
	}
	if (forwarded.type === "message_end" && forwarded.streamId) {
		const posted = await updateAssistantTurnMessage(client, channel, forwarded, true);
		if (posted) await finalizeAndClearToolSummaryMessage(client.sessionId);
		return;
	}
	if (forwarded.type === "message_end") {
		if (isAssistantMessagePayload(forwarded.message)) {
			const posted = await updateAssistantTurnMessage(client, channel, forwarded, true);
			if (posted) await finalizeAndClearToolSummaryMessage(client.sessionId);
			return;
		}
		if (isUserMessagePayload(forwarded.message)) {
			await finalizeAndClearToolSummaryMessage(client.sessionId);
			await postSlackUserMessage(channel, userMessageBlocks(forwarded.message), fallbackTextForUserMessage(forwarded.message));
			return;
		}
		if (isCasperNoticePayload(forwarded.message)) {
			await finalizeAndClearToolSummaryMessage(client.sessionId);
			const text = fallbackTextForCasperNotice(forwarded.message);
			await postSlackMessage(channel, textSectionBlocks(text), mentionForAttention(text, Boolean(forwarded.attention)));
			return;
		}
		return;
	}
	if (forwarded.type === "compaction_start") {
		await finalizeAndClearToolSummaryMessage(client.sessionId);
		await updateCompactionMessage(client.sessionId, channel, forwarded);
		return;
	}
	if (forwarded.type === "compaction_end") {
		await finalizeCompactionMessage(client.sessionId, channel, forwarded);
		return;
	}
	if (forwarded.type === "plan_ready") {
		await finalizeAndClearToolSummaryMessage(client.sessionId);
		await postPlanReview(client, channel, forwarded);
		return;
	}
	if (forwarded.type === "plan_closed") {
		await finalizeAndClearToolSummaryMessage(client.sessionId);
		closePlanReview(client.sessionId, forwarded.planFilePath, forwarded.reason);
		return;
	}
	if (forwarded.type === "tool_waiting") {
		await finalizeAndClearToolSummaryMessage(client.sessionId);
		const fallback = forwarded.text || "ask_user is waiting for input.";
		await postAskUserPrompt(client, channel, forwarded, fallback);
		return;
	}
	if (forwarded.type === "tool_start") {
		await updateToolSummaryMessage(client.sessionId, channel, forwarded.toolName, forwarded.args, client.cwd);
		return;
	}
	if (forwarded.type === "tool_end") {
		if (forwarded.toolName === "ask_user") await finalizeAskUserPromptFromToolEnd(client.sessionId, forwarded);
		return;
	}
	if (forwarded.type === "agent_started") {
		await finalizeAndClearToolSummaryMessage(client.sessionId);
		clearAssistantTurnMessage(client.sessionId);
		clearCompactionMessage(client.sessionId);
		return;
	}
	if (forwarded.type === "agent_finished") {
		await finalizeAndClearToolSummaryMessage(client.sessionId);
		await postAgentFinished(channel, forwarded);
		return;
	}
}

async function updateAssistantTurnMessage(client, channel, forwarded, final) {
	const streamId = forwarded.streamId || `assistant-${forwarded.timestamp || now()}`;
	const key = assistantMessageKey(client.sessionId, streamId);
	let existing = assistantTurnMessages.get(key);
	if (!existing) {
		existing = { channel, ts: undefined, messages: new Map() };
		assistantTurnMessages.set(key, existing);
	}
	existing.channel = channel;
	existing.messages.set(streamId, forwarded.message);
	if (!final) return false;
	if (!shouldPostAssistantTurn(existing)) {
		assistantTurnMessages.delete(key);
		return false;
	}
	const rendered = renderAssistantTurn(existing);
	if (existing.ts) {
		await updateSlackMessage(existing.channel, existing.ts, rendered.blocks, rendered.text, false, rendered.fallbackBlocks);
	} else {
		const posted = await postSlackMessage(existing.channel, rendered.blocks, rendered.text, false, rendered.fallbackBlocks);
		existing.ts = posted.ts;
	}
	assistantTurnMessages.delete(key);
	return true;
}

function assistantMessageKey(sessionId, streamId) {
	return `${sessionId}:${streamId}`;
}

function mentionForAttention(text, attention = true) {
	if (!attention || !config.userId) return text;
	const mention = `<@${config.userId}>`;
	return String(text || "").includes(mention) ? text : `${mention} ${text || "Response ready"}`;
}

function clearAssistantTurnMessage(sessionId) {
	for (const key of assistantTurnMessages.keys()) {
		if (key.startsWith(`${sessionId}:`)) assistantTurnMessages.delete(key);
	}
}

async function postAgentFinished(channel, forwarded) {
	const text = mentionForAttention(agentFinishedText(forwarded), Boolean(forwarded.attention));
	await postSlackMessage(channel, [contextBlock(text)], text);
}

function agentFinishedText(forwarded) {
	if (forwarded.stopReason === "aborted") return ":black_circle: Agent turn stopped.";
	if (forwarded.stopReason === "error" && forwarded.errorMessage) return `:warning: Agent turn ended with an error: ${escapeMrkdwn(clip(forwarded.errorMessage, 300))}`;
	if (forwarded.stopReason === "error") return ":warning: Agent turn ended with an error.";
	return ":white_check_mark: Agent turn finished.";
}

async function postPlanReview(client, channel, forwarded) {
	const planId = planReviewId(client.sessionId, forwarded.planFilePath);
	const existing = planReviews.get(planId);
	if (existing?.ngrokProcess) stopNgrokTunnel(existing);
	const review = {
		planId,
		sessionId: client.sessionId,
		channel,
		messageTs: existing?.messageTs,
		planFilePath: forwarded.planFilePath,
		reviewUrl: forwarded.reviewUrl,
		title: forwarded.title || "Plan ready",
		message: forwarded.message,
		status: "Preparing Slack plan review...",
		artifactFileName: existing?.artifactFileName,
		artifactError: undefined,
		publicReviewUrl: undefined,
		ngrokProcess: undefined,
		completed: false,
	};
	planReviews.set(planId, review);

	if (review.messageTs) await updatePlanReviewMessage(review);
	else {
		const posted = await postSlackMessage(channel, planReviewBlocks(review), planReviewFallbackText(review));
		review.messageTs = posted.ts;
	}

	await maybeAttachPublicReviewUrl(review);
	if (review.publicReviewUrl) await updatePlanReviewMessage(review);

	try {
		const artifactPath = await renderPlanPdf(review.planFilePath, review.planId);
		review.status = "Uploading rendered plan PDF...";
		await updatePlanReviewMessage(review);
		review.artifactFileName = await uploadSlackFile(channel, artifactPath, `${slugify(basename(review.planFilePath, extname(review.planFilePath)), "plan")}.pdf`, "Plan PDF");
		review.status = "Ready for review.";
	} catch (error) {
		review.artifactError = errorMessage(error);
		review.status = "Ready for review. PDF rendering/upload is unavailable on this machine.";
		await log(`plan artifact failed: ${review.artifactError}`);
	}
	await updatePlanReviewMessage(review);
}

function planReviewId(sessionId, planFilePath) {
	return `${sessionId}:${planFilePath}`;
}

function closePlanReview(sessionId, planFilePath, reason) {
	const review = planReviews.get(planReviewId(sessionId, planFilePath));
	if (!review) return;
	if (!review.completed) review.status = reason ? `Review closed (${reason}).` : "Review closed.";
	review.completed = true;
	stopNgrokTunnel(review);
	void updatePlanReviewMessage(review).catch((error) => log(`plan close update failed: ${errorMessage(error)}`));
}

async function updatePlanReviewMessage(review) {
	if (!review.messageTs) return;
	await updateSlackMessage(review.channel, review.messageTs, planReviewBlocks(review), planReviewFallbackText(review));
}

function planReviewBlocks(review) {
	const mention = config.userId && !review.completed ? `<@${config.userId}> ` : "";
	const lines = [
		`${mention}*${escapeMrkdwn(review.title || "Plan ready")}*`,
		`Plan: \`${escapeMrkdwn(review.planFilePath)}\``,
	];
	if (review.artifactFileName) lines.push(`PDF: ${escapeMrkdwn(review.artifactFileName)} uploaded above.`);
	if (review.publicReviewUrl) lines.push(`Full review UI: ${review.publicReviewUrl}`);
	if (review.artifactError) lines.push(`PDF: ${escapeMrkdwn(review.artifactError)}`);
	if (review.status) lines.push(`Status: ${escapeMrkdwn(review.status)}`);
	const blocks = [sectionBlock(lines.join("\n"))];
	if (!review.completed) {
		blocks.push({
			type: "actions",
			block_id: `plan:${shortPlanId(review.planId)}`,
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Approve and execute" },
					style: "primary",
					action_id: PLAN_APPROVE_ACTION_ID,
					value: review.planId,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Request changes" },
					action_id: PLAN_REFINE_ACTION_ID,
					value: review.planId,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Exit plan mode" },
					style: "danger",
					action_id: PLAN_EXIT_ACTION_ID,
					value: review.planId,
				},
			],
		});
	}
	return blocks;
}

function planReviewFallbackText(review) {
	const text = `${review.title || "Plan ready"}: ${review.planFilePath}${review.status ? ` · ${review.status}` : ""}`;
	return mentionForAttention(text, !review.completed);
}

function shortPlanId(planId) {
	return randomBytes(3).toString("hex") + slugify(planId, "plan").slice(0, 24);
}

async function renderPlanPdf(planFilePath, planId) {
	const { chromium } = await import("playwright");
	const targetPath = join(PLAN_ARTIFACT_DIR, `${slugify(planId, "plan")}-${Date.now()}.pdf`);
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext({ javaScriptEnabled: false });
		await context.route("**/*", (route) => {
			const url = route.request().url();
			if (url.startsWith("file://")) return route.continue();
			return route.abort();
		});
		const page = await context.newPage();
		await page.goto(pathToFileURL(planFilePath).href, { waitUntil: "load" });
		await page.pdf({ path: targetPath, format: "A4", printBackground: true, margin: { top: "16mm", right: "12mm", bottom: "16mm", left: "12mm" } });
		await context.close();
		return targetPath;
	} finally {
		await browser.close().catch(() => undefined);
	}
}

async function uploadSlackFile(channel, filePath, filename, title) {
	const uploaded = await uploadSlackFileDetailed(channel, filePath, filename, title);
	return uploaded.fileName;
}

async function uploadSlackFileDetailed(channel, filePath, filename, title, comment) {
	const size = (await stat(filePath)).size;
	const upload = await callSlack("files.getUploadURLExternal", { filename, length: size });
	const body = await readFile(filePath);
	const uploaded = await fetch(upload.upload_url, { method: "POST", body });
	if (!uploaded.ok) throw new Error(`Slack file upload failed: ${uploaded.status}`);
	await callSlack("files.completeUploadExternal", {
		channel_id: channel,
		files: [{ id: upload.file_id, title }],
		initial_comment: comment ? clip(comment, 1000) : undefined,
	});
	return { fileId: upload.file_id, fileName: filename, title, size };
}

async function handleUploadFileRequest(client, message) {
	if (!message.id) return;
	try {
		if (!client.sessionId || message.sessionId !== client.sessionId) throw new Error("Upload request does not match the authenticated session.");
		const filePath = typeof message.path === "string" ? message.path.trim() : "";
		if (!filePath) throw new Error("Upload path is required.");
		assertSafeUploadPath(filePath);
		const info = await stat(filePath);
		if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
		const mapping = await ensureSessionChannel(client);
		if (!mapping?.channelId) throw new Error("This session does not have a Slack channel.");
		const fileName = sanitizeFileName(basename(filePath));
		const title = clip(String(message.title || fileName).trim() || fileName, 200);
		const comment = typeof message.comment === "string" && message.comment.trim() ? message.comment.trim() : undefined;
		const uploaded = await uploadSlackFileDetailed(mapping.channelId, filePath, fileName, title, comment);
		respond(client, message.id, true, { uploaded: true, channelId: mapping.channelId, ...uploaded });
	} catch (error) {
		respond(client, message.id, false, undefined, errorMessage(error));
	}
}

function assertSafeUploadPath(path) {
	const name = basename(path).toLowerCase();
	if (name === ".env" || name.startsWith(".env.")) throw new Error("Refusing to upload environment files.");
	if (/\.(pem|key|p12|pfx|crt|cer|der)$/i.test(name)) throw new Error("Refusing to upload credential files.");
	if (/id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)) throw new Error("Refusing to upload private key files.");
}

async function maybeAttachPublicReviewUrl(review) {
	if (!review.reviewUrl) return;
	try {
		const localUrl = new URL(review.reviewUrl);
		if (!/^127\.0\.0\.1$|^localhost$/.test(localUrl.hostname) || !localUrl.port) return;
		const tunnel = await ensureNgrokTunnel(localUrl.port);
		if (!tunnel?.publicUrl) return;
		review.publicReviewUrl = `${tunnel.publicUrl}${localUrl.pathname}${localUrl.search}`;
		review.ngrokProcess = tunnel.process;
	} catch (error) {
		await log(`ngrok review link failed: ${errorMessage(error)}`);
	}
}

async function ensureNgrokTunnel(port) {
	const existing = await findNgrokTunnel(port).catch(() => undefined);
	if (existing) return { publicUrl: existing };
	const cached = ngrokTunnels.get(port);
	if (cached?.process?.exitCode === null && cached.publicUrl) return cached;
	const child = spawn("ngrok", ["http", `127.0.0.1:${port}`, "--log=stdout"], { stdio: ["ignore", "pipe", "pipe"] });
	child.unref?.();
	child.on("error", (error) => log(`ngrok start failed: ${errorMessage(error)}`));
	child.stdout?.on("data", (chunk) => logNgrokOutput(chunk));
	child.stderr?.on("data", (chunk) => logNgrokOutput(chunk));
	for (let i = 0; i < 30; i++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		const url = await findNgrokTunnel(port).catch(() => undefined);
		if (url) {
			const tunnel = { publicUrl: url, process: child };
			ngrokTunnels.set(port, tunnel);
			return tunnel;
		}
		if (child.exitCode !== null) return undefined;
	}
	child.kill("SIGTERM");
	return undefined;
}

async function findNgrokTunnel(port) {
	const response = await fetch("http://127.0.0.1:4040/api/tunnels");
	if (!response.ok) return undefined;
	const payload = await response.json();
	const tunnels = Array.isArray(payload.tunnels) ? payload.tunnels : [];
	const tunnel = tunnels.find((item) => String(item.config?.addr || "").includes(`:${port}`) && String(item.public_url || "").startsWith("https://"));
	return tunnel?.public_url;
}

function logNgrokOutput(chunk) {
	const text = String(chunk || "").trim();
	if (text) void log(`ngrok: ${clip(text, 500)}`);
}

function stopNgrokTunnel(review) {
	try {
		review.ngrokProcess?.kill?.("SIGTERM");
		for (const [port, tunnel] of ngrokTunnels.entries()) {
			if (tunnel.process === review.ngrokProcess) ngrokTunnels.delete(port);
		}
	} catch {
		// ignore
	}
}

async function openPlanRefineModal(planId, payload) {
	const review = planReviews.get(planId);
	if (!review) {
		await postSlackEphemeral(payload.channel?.id || payload.container?.channel_id, payload.user?.id, textSectionBlocks("That plan review is no longer available."), "That plan review is no longer available.").catch(() => undefined);
		return;
	}
	try {
		await callSlack("views.open", {
			trigger_id: payload.trigger_id,
			view: {
				type: "modal",
				callback_id: PLAN_REFINE_CALLBACK_ID,
				private_metadata: JSON.stringify({ planId }),
				title: { type: "plain_text", text: "Request changes" },
				submit: { type: "plain_text", text: "Submit" },
				close: { type: "plain_text", text: "Cancel" },
				blocks: [
					sectionBlock(`Plan: \`${escapeMrkdwn(review.planFilePath)}\``),
					{
						type: "input",
						block_id: "feedback",
						label: { type: "plain_text", text: "What should change?" },
						element: { type: "plain_text_input", action_id: "text", multiline: true },
					},
				],
			},
		});
	} catch (error) {
		await postSlackEphemeral(review.channel, payload.user?.id, textSectionBlocks(`Could not open feedback modal: ${errorMessage(error)}`), `Could not open feedback modal: ${errorMessage(error)}`).catch(() => undefined);
	}
}

function extractPlanRefineFeedback(view) {
	const values = view?.state?.values || {};
	for (const block of Object.values(values)) {
		if (!block || typeof block !== "object") continue;
		for (const item of Object.values(block)) {
			const value = item && typeof item === "object" ? item.value : undefined;
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return "";
}

async function submitPlanAction(planId, action, feedback, payload) {
	const review = planReviews.get(planId);
	const userId = payload.user?.id || payload.user_id;
	if (!review) {
		await postSlackEphemeral(payload.channel?.id || payload.container?.channel_id, userId, textSectionBlocks("That plan review is no longer available."), "That plan review is no longer available.").catch(() => undefined);
		return;
	}
	if (action === "refine" && !feedback?.trim()) {
		await postSlackEphemeral(review.channel, userId, textSectionBlocks("Add feedback before submitting plan changes."), "Add feedback before submitting plan changes.").catch(() => undefined);
		return;
	}
	const session = sessions.get(review.sessionId);
	if (!session?.socket?.writable) {
		await postSlackEphemeral(review.channel, userId, textSectionBlocks("The pi session for this plan is not connected."), "The pi session for this plan is not connected.").catch(() => undefined);
		return;
	}
	const requestId = randomUUID();
	planActionRequests.set(requestId, { planId, channel: review.channel, messageTs: review.messageTs, action });
	review.status = planActionSubmittingText(action);
	await updatePlanReviewMessage(review).catch(() => undefined);
	const sent = sendToClient(session, {
		v: 1,
		type: "plan_action",
		requestId,
		channelId: review.channel,
		userId,
		action,
		feedback,
		planFilePath: review.planFilePath,
	});
	if (!sent) {
		planActionRequests.delete(requestId);
		review.status = "The pi session for this plan is no longer connected.";
		await updatePlanReviewMessage(review).catch(() => undefined);
	}
}

function planActionSubmittingText(action) {
	if (action === "approve") return "Submitting approval...";
	if (action === "refine") return "Submitting feedback...";
	return "Exiting plan mode...";
}

async function handlePlanActionResult(message) {
	const request = planActionRequests.get(message.requestId);
	if (!request) return;
	planActionRequests.delete(message.requestId);
	const review = planReviews.get(request.planId);
	if (!review) return;
	review.status = message.ok ? message.message || "Plan action submitted." : message.error || "Plan action failed.";
	review.completed = Boolean(message.ok);
	if (message.ok) stopNgrokTunnel(review);
	await updatePlanReviewMessage(review).catch((error) => log(`plan action result update failed: ${errorMessage(error)}`));
}

function parseAskUserButtonValue(value) {
	const parsed = parseJson(value) || parseAskUserButtonToken(value) || {};
	const prompt = askUserPrompts.get(parsed.promptId);
	const question = prompt?.ask?.questions?.[0];
	const option = question?.options?.[Number(parsed.optionIndex)];
	return {
		promptId: parsed.promptId,
		response: option ? { kind: "selection", selections: [option.title] } : undefined,
	};
}

function parseAskUserButtonToken(value) {
	const text = String(value || "");
	const separatorIndex = text.lastIndexOf("|");
	if (separatorIndex === -1) return undefined;
	const promptId = text.slice(0, separatorIndex);
	const optionIndex = text.slice(separatorIndex + 1);
	if (!promptId) return undefined;
	return { promptId, optionIndex };
}

async function openAskUserModal(promptId, payload) {
	const prompt = askUserPrompts.get(promptId);
	const userId = payload.user?.id || payload.user_id;
	if (!prompt || prompt.completed) {
		await postSlackEphemeral(payload.channel?.id || payload.container?.channel_id, userId, textSectionBlocks("That ask_user prompt is no longer available."), "That ask_user prompt is no longer available.").catch(() => undefined);
		return;
	}
	const blocks = buildAskUserModalBlocks(prompt.ask);
	if (!blocks) {
		await postSlackEphemeral(prompt.channel, userId, textSectionBlocks("This ask_user prompt is too large for Slack controls. Reply in the channel with your answer."), "This ask_user prompt is too large for Slack controls.").catch(() => undefined);
		return;
	}
	try {
		await callSlack("views.open", {
			trigger_id: payload.trigger_id,
			view: {
				type: "modal",
				callback_id: ASK_USER_CALLBACK_ID,
				private_metadata: JSON.stringify({ promptId }),
				title: { type: "plain_text", text: "Answer ask_user" },
				submit: { type: "plain_text", text: "Submit" },
				close: { type: "plain_text", text: "Cancel" },
				blocks,
			},
		});
	} catch (error) {
		await postSlackEphemeral(prompt.channel, userId, textSectionBlocks(`Could not open ask_user modal: ${errorMessage(error)}`), `Could not open ask_user modal: ${errorMessage(error)}`).catch(() => undefined);
	}
}

function buildAskUserModalBlocks(ask) {
	const blocks = [];
	for (const [index, question] of ask.questions.entries()) {
		blocks.push(sectionBlock(`*${escapeMrkdwn(question.header || `Q${index + 1}`)}*\n${escapeMrkdwn(question.question)}`));
		if (question.context) blocks.push(contextBlock(escapeMrkdwn(question.context)));
		if (question.options.length > ASK_USER_STATIC_SELECT_LIMIT) return undefined;
		if (question.options.length > 0) {
			blocks.push({
				type: "input",
				block_id: askModalBlockId(index, "select"),
				optional: question.allowFreeform,
				label: { type: "plain_text", text: question.allowMultiple ? "Choose one or more options" : "Choose an option" },
				element: question.allowMultiple
					? {
						type: "multi_static_select",
						action_id: "value",
						placeholder: { type: "plain_text", text: "Select options" },
						options: question.options.map((option, optionIndex) => slackOption(option, optionIndex)),
					}
					: {
						type: "static_select",
						action_id: "value",
						placeholder: { type: "plain_text", text: "Select an option" },
						options: question.options.map((option, optionIndex) => slackOption(option, optionIndex)),
					},
			});
		}
		if (question.allowFreeform || question.options.length === 0) {
			blocks.push({
				type: "input",
				block_id: askModalBlockId(index, "freeform"),
				optional: question.options.length > 0,
				label: { type: "plain_text", text: question.options.length > 0 ? "Custom answer" : "Answer" },
				element: { type: "plain_text_input", action_id: "value", multiline: true },
			});
		}
		if (question.allowComment) {
			blocks.push({
				type: "input",
				block_id: askModalBlockId(index, "comment"),
				optional: true,
				label: { type: "plain_text", text: "Optional comment" },
				element: { type: "plain_text_input", action_id: "value", multiline: true },
			});
		}
	}
	return blocks.slice(0, SLACK_BLOCK_LIMIT);
}

function slackOption(option, index) {
	return {
		text: { type: "plain_text", text: clipPlain(option.title, 75) },
		value: String(index),
		...(option.description ? { description: { type: "plain_text", text: clipPlain(option.description, 75) } } : {}),
	};
}

function askModalBlockId(index, field) {
	return `q${index}_${field}`;
}

function extractAskUserModalResponse(promptId, view) {
	const prompt = askUserPrompts.get(promptId);
	if (!prompt) return null;
	const responses = {};
	for (const [index, question] of prompt.ask.questions.entries()) {
		const freeform = modalValue(view, askModalBlockId(index, "freeform"));
		const comment = modalValue(view, askModalBlockId(index, "comment"));
		if (freeform) {
			responses[question.question] = { kind: "freeform", text: freeform };
			continue;
		}
		const selectedIndexes = modalSelectedIndexes(view, askModalBlockId(index, "select"));
		if (selectedIndexes.length > 0) {
			responses[question.question] = {
				kind: "selection",
				selections: selectedIndexes.map((optionIndex) => question.options[optionIndex]?.title).filter(Boolean),
				...(comment ? { comment } : {}),
			};
			continue;
		}
		responses[question.question] = null;
	}
	if (prompt.ask.questions.length === 1) return responses[prompt.ask.questions[0].question] ?? undefined;
	return { kind: "questions", responses };
}

function modalValue(view, blockId) {
	const value = view?.state?.values?.[blockId]?.value?.value;
	return typeof value === "string" && value.trim() ? value.trim() : "";
}

function modalSelectedIndexes(view, blockId) {
	const item = view?.state?.values?.[blockId]?.value;
	const options = Array.isArray(item?.selected_options)
		? item.selected_options
		: item?.selected_option
			? [item.selected_option]
			: [];
	return options
		.map((option) => Number(option.value))
		.filter((index) => Number.isInteger(index) && index >= 0);
}

async function submitAskUserAction(submission, payload) {
	const promptId = submission?.promptId;
	const prompt = promptId ? askUserPrompts.get(promptId) : undefined;
	const userId = payload.user?.id || payload.user_id;
	if (!prompt) {
		await log(`ask_user action ignored: prompt not found promptId=${promptId || "unknown"}`);
		return;
	}
	if (prompt.completed || prompt.submitting) {
		await log(`ask_user action ignored: prompt already ${prompt.completed ? "completed" : "submitting"} promptId=${promptId}`);
		return;
	}
	if (submission.response === undefined) {
		await postSlackEphemeral(prompt.channel, userId, textSectionBlocks("Could not read that ask_user answer. Reply in the channel with your answer."), "Could not read that ask_user answer.").catch(() => undefined);
		return;
	}
	const session = sessions.get(prompt.sessionId);
	if (!session?.socket?.writable) {
		await postSlackEphemeral(prompt.channel, userId, textSectionBlocks("The pi session for this ask_user prompt is not connected."), "The pi session for this ask_user prompt is not connected.").catch(() => undefined);
		return;
	}
	const requestId = randomUUID();
	askUserActionRequests.set(requestId, { promptId, channel: prompt.channel, messageTs: prompt.messageTs });
	prompt.submitting = true;
	prompt.status = "Submitting answer...";
	await updateAskUserPromptMessage(prompt).catch(() => undefined);
	const sent = sendToClient(session, {
		v: 1,
		type: "ask_user_action",
		requestId,
		channelId: prompt.channel,
		userId,
		promptId,
		response: submission.response,
	});
	if (!sent) {
		askUserActionRequests.delete(requestId);
		prompt.submitting = false;
		prompt.status = "The pi session for this ask_user prompt is no longer connected.";
		await updateAskUserPromptMessage(prompt).catch(() => undefined);
		await log(`ask_user action send failed promptId=${promptId} requestId=${requestId}`);
	}
}

async function handleAskUserActionResult(message) {
	const request = askUserActionRequests.get(message.requestId);
	if (!request) return;
	askUserActionRequests.delete(message.requestId);
	const prompt = askUserPrompts.get(request.promptId);
	if (!prompt) return;
	prompt.submitting = false;
	prompt.status = message.ok ? message.message || "Answer submitted." : message.error || "Answer failed.";
	prompt.completed = Boolean(message.ok);
	await updateAskUserPromptMessage(prompt).catch((error) => log(`ask_user action result update failed: ${errorMessage(error)}`));
}

async function finalizeAskUserPromptFromToolEnd(sessionId, forwarded) {
	const prompt = askUserPrompts.get(forwarded.toolCallId) || askUserPrompts.get(askUserPromptIdsByToolCall.get(forwarded.toolCallId));
	if (!prompt || prompt.sessionId !== sessionId || prompt.completed) return;
	prompt.completed = true;
	prompt.submitting = false;
	const text = toolResultText(forwarded.result);
	if (forwarded.isError) prompt.status = text || "ask_user failed.";
	else if (/cancelled/i.test(text)) prompt.status = "ask_user prompt cancelled.";
	else prompt.status = "ask_user answered.";
	await updateAskUserPromptMessage(prompt).catch((error) => log(`ask_user tool end update failed: ${errorMessage(error)}`));
}

function toolResultText(result) {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => block && typeof block === "object" && block.type === "text" ? block.text || "" : "")
		.filter(Boolean)
		.join("\n")
		.trim();
}

async function updateAskUserPromptMessage(prompt) {
	if (!prompt.messageTs) return;
	await updateSlackMessage(prompt.channel, prompt.messageTs, askUserPromptStateBlocks(prompt), askUserPromptFallbackText(prompt));
}

function askUserPromptFallbackText(prompt) {
	return mentionForAttention(prompt.status || "ask_user prompt", !prompt.completed);
}

function askUserPromptStateBlocks(prompt) {
	const mention = config.userId ? `<@${config.userId}> ` : "";
	const text = prompt.completed
		? `${mention}*Input handled*\n${escapeMrkdwn(prompt.status || "Answer submitted.")}`
		: `${mention}*Input needed*\n${escapeMrkdwn(prompt.status || "Waiting for answer.")}`;
	const blocks = [sectionBlock(text), ...textSectionBlocks(formatAskUserPrompt({ questions: prompt.ask.questions }, "ask_user is waiting for input."), 1800)];
	if (!prompt.completed && !prompt.submitting) blocks.push(...askUserControlBlocks(prompt.ask));
	return blocks;
}

function parseJson(value) {
	try {
		return value ? JSON.parse(value) : undefined;
	} catch {
		return undefined;
	}
}

async function postSlackMessage(channel, blocks, text, retriedJoin = false, fallbackBlocks) {
	try {
		return await callSlack("chat.postMessage", { channel, text: clip(stripFormatting(text), 3000), blocks: capBlocks(blocks), unfurl_links: false, unfurl_media: false });
	} catch (error) {
		const message = errorMessage(error);
		if (!retriedJoin && message.includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return postSlackMessage(channel, blocks, text, true, fallbackBlocks);
		}
		if (fallbackBlocks && isSlackBlockRejection(message)) {
			await log(`Slack block render rejected, falling back to text blocks: ${message}`);
			try {
				return await postSlackMessage(channel, fallbackBlocks, text, retriedJoin);
			} catch (fallbackError) {
				if (isSlackBlockRejection(errorMessage(fallbackError))) return postSlackTextOnly(channel, text, retriedJoin);
				throw fallbackError;
			}
		}
		throw error;
	}
}

async function postSlackTextOnly(channel, text, retriedJoin = false) {
	try {
		return await callSlack("chat.postMessage", { channel, text: clip(stripFormatting(text), 3000), unfurl_links: false, unfurl_media: false });
	} catch (error) {
		const message = errorMessage(error);
		if (!retriedJoin && message.includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return postSlackTextOnly(channel, text, true);
		}
		throw error;
	}
}

async function postSlackUserMessage(channel, blocks, text, retriedJoin = false, retriedCustomize = false) {
	const body = { channel, text: clip(stripFormatting(text), 3000), blocks: capBlocks(blocks), unfurl_links: false, unfurl_media: false };
	const profile = retriedCustomize ? undefined : await getConfiguredUserProfile();
	if (profile?.username) body.username = profile.username;
	if (profile?.iconUrl) body.icon_url = profile.iconUrl;
	try {
		return await callSlack("chat.postMessage", body);
	} catch (error) {
		const message = errorMessage(error);
		if (!retriedJoin && message.includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return postSlackUserMessage(channel, blocks, text, true, retriedCustomize);
		}
		if (!retriedCustomize && (message.includes("missing_scope") || message.includes("invalid_arguments"))) {
			await log(`custom user message failed: ${message}`);
			return postSlackUserMessage(channel, blocks, text, retriedJoin, true);
		}
		throw error;
	}
}

async function getConfiguredUserProfile() {
	if (!config.userId) return undefined;
	if (configuredUserProfileUserId === config.userId) return configuredUserProfile;
	configuredUserProfileUserId = config.userId;
	try {
		const result = await callSlack("users.info", { user: config.userId });
		const user = result.user || {};
		const profile = user.profile || {};
		configuredUserProfile = {
			username: profile.display_name_normalized || profile.display_name || profile.real_name_normalized || profile.real_name || user.name,
			iconUrl: profile.image_72 || profile.image_48 || profile.image_32,
		};
	} catch (error) {
		configuredUserProfile = undefined;
		await log(`configured user profile lookup failed: ${errorMessage(error)}`);
	}
	return configuredUserProfile;
}

async function postSlackEphemeral(channel, user, blocks, text, retriedJoin = false) {
	try {
		return await callSlack("chat.postEphemeral", { channel, user, text: clip(stripFormatting(text), 3000), blocks: capBlocks(blocks) });
	} catch (error) {
		if (!retriedJoin && errorMessage(error).includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return postSlackEphemeral(channel, user, blocks, text, true);
		}
		throw error;
	}
}

async function updateSlackMessage(channel, ts, blocks, text, retriedJoin = false, fallbackBlocks) {
	try {
		return await callSlack("chat.update", { channel, ts, text: clip(stripFormatting(text), 3000), blocks: capBlocks(blocks) });
	} catch (error) {
		const message = errorMessage(error);
		if (!retriedJoin && message.includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return updateSlackMessage(channel, ts, blocks, text, true, fallbackBlocks);
		}
		if (fallbackBlocks && isSlackBlockRejection(message)) {
			await log(`Slack block update rejected, falling back to text blocks: ${message}`);
			try {
				return await updateSlackMessage(channel, ts, fallbackBlocks, text, retriedJoin);
			} catch (fallbackError) {
				if (isSlackBlockRejection(errorMessage(fallbackError))) return updateSlackTextOnly(channel, ts, text, retriedJoin);
				throw fallbackError;
			}
		}
		throw error;
	}
}

async function updateSlackTextOnly(channel, ts, text, retriedJoin = false) {
	try {
		return await callSlack("chat.update", { channel, ts, text: clip(stripFormatting(text), 3000), blocks: [] });
	} catch (error) {
		const message = errorMessage(error);
		if (!retriedJoin && message.includes("not_in_channel")) {
			joinedChannels.delete(channel);
			await ensureBotInChannel(channel);
			return updateSlackTextOnly(channel, ts, text, true);
		}
		throw error;
	}
}

function isSlackBlockRejection(message) {
	const text = String(message || "").toLowerCase();
	return text.includes("invalid_blocks")
		|| text.includes("msg_blocks_too_long")
		|| text.includes("too_many_blocks")
		|| text.includes("block_id_too_long")
		|| text.includes("json-pointer:/blocks")
		|| text.includes("invalid additional property")
		|| (text.includes("block") && (text.includes("too_long") || text.includes("too long") || text.includes("limit") || text.includes("size")));
}

function capBlocks(blocks) {
	return blocks.filter(Boolean).slice(0, SLACK_BLOCK_LIMIT);
}

function isAssistantMessagePayload(message) {
	return Boolean(message && typeof message === "object" && message.role === "assistant");
}

function isUserMessagePayload(message) {
	return Boolean(message && typeof message === "object" && message.role === "user");
}

function isCasperNoticePayload(message) {
	return Boolean(message && typeof message === "object" && message.role === "custom" && message.customType === "pi-casper");
}

function shouldPostMessage(message) {
	const value = message && typeof message === "object" ? message : {};
	if (value.role !== "assistant") return true;
	return messageHasVisibleContent(value);
}

function shouldPostAssistantTurn(entry) {
	for (const message of entry.messages.values()) {
		if (shouldPostMessage(message)) return true;
	}
	return false;
}

function renderAssistantTurn(entry) {
	const markdown = fallbackTextForAssistantTurn(entry);
	const fallbackBlocks = assistantTurnTextBlocks(entry);
	try {
		const blocks = sanitizeRenderedMarkdownBlocks(markdownToBlocks(markdown));
		if (blocks.length === 0) return { text: markdown || "Response ready", blocks: fallbackBlocks, fallbackBlocks };
		return {
			text: fallbackTextFromMarkdownBlocks(blocks, markdown),
			blocks,
			fallbackBlocks,
		};
	} catch (error) {
		void log(`markdown render failed, falling back to text blocks: ${errorMessage(error)}`);
		return { text: markdown || "Response ready", blocks: fallbackBlocks, fallbackBlocks };
	}
}

function sanitizeRenderedMarkdownBlocks(blocks) {
	const result = [];
	for (const block of Array.isArray(blocks) ? blocks : []) {
		if (block?.type === "section" && Array.isArray(block.fields) && block.fields.length > SLACK_MAX_FIELDS_PER_SECTION) {
			for (let index = 0; index < block.fields.length; index += SLACK_MAX_FIELDS_PER_SECTION) {
				const fields = block.fields.slice(index, index + SLACK_MAX_FIELDS_PER_SECTION);
				result.push(index === 0 ? { ...block, fields } : { type: "section", fields });
			}
		} else {
			result.push(block);
		}
	}
	return capBlocks(result);
}

function fallbackTextFromMarkdownBlocks(blocks, markdown) {
	try {
		const text = blocksToPlainText(blocks).trim();
		if (text) return text;
	} catch (error) {
		void log(`markdown fallback text failed: ${errorMessage(error)}`);
	}
	return markdown || "Response ready";
}

function assistantTurnTextBlocks(entry) {
	const blocks = [];
	for (const message of entry.messages.values()) {
		appendMessageContentBlocks(blocks, message && typeof message === "object" ? message : {});
	}
	if (blocks.length === 0) blocks.push(contextBlock("(no text content)"));
	return blocks;
}

function appendMessageContentBlocks(blocks, value) {
	const content = value.content;
	if (typeof content === "string") {
		blocks.push(...textSectionBlocks(content));
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text") blocks.push(...textSectionBlocks(block.text || ""));
		}
	}
}

function fallbackTextForAssistantTurn(entry) {
	const text = [...entry.messages.values()]
		.map(fallbackTextForMessage)
		.filter(Boolean)
		.join("\n");
	return text || "Response ready";
}

function messageHasVisibleContent(message) {
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		if (block.type === "text") return String(block.text || "").trim().length > 0;
		return false;
	});
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
				return "";
			})
			.filter(Boolean)
			.join("\n");
		if (text) return text;
	}
	return "";
}

function fallbackTextForCasperNotice(message) {
	return fallbackTextForMessage(message).trim() || "Casper notice";
}

function extractAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = fallbackTextForMessage(message).trim();
		if (text) return text;
	}
	return "";
}

function sanitizeSnippets(snippets = []) {
	return snippets.slice(-12).map((snippet) => ({
		role: snippet.role,
		text: redactSecrets(clip(snippet.text, 800)),
	}));
}

function redactSecrets(text) {
	return String(text || "")
		.replace(/\b(?:sk|pk|ghp|gho|github_pat)_[A-Za-z0-9_\-]{12,}\b/g, "[redacted]")
		.replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g, "[redacted]")
		.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

function userMessageBlocks(message) {
	const blocks = [];
	appendUserMessageContentBlocks(blocks, message && typeof message === "object" ? message : {});
	if (blocks.length === 0) blocks.push(contextBlock("(no text content)"));
	return blocks;
}

function appendUserMessageContentBlocks(blocks, value) {
	const content = value.content;
	if (typeof content === "string") {
		blocks.push(...textSectionBlocks(content));
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text") blocks.push(...textSectionBlocks(block.text || ""));
			else if (block.type === "image") blocks.push(contextBlock(`Image attached locally (${escapeMrkdwn(block.mimeType || "image")})`));
		}
	}
}

function fallbackTextForUserMessage(message) {
	const value = message && typeof message === "object" ? message : {};
	const text = fallbackTextForMessage(value);
	return text || "User message";
}

async function updateToolSummaryMessage(sessionId, channel, toolName, args, cwd) {
	let entry = toolSummaryMessages.get(sessionId);
	if (!entry || entry.finalized) {
		entry = { channel, ts: undefined, labels: new Set(), count: 0, finalized: false };
		toolSummaryMessages.set(sessionId, entry);
	}
	entry.channel = channel;
	entry.count += 1;
	entry.labels.add(toolActivityLabel(toolName, args, cwd));
	await postOrUpdateToolSummaryMessage(entry, false);
}

async function finalizeToolSummaryMessage(sessionId) {
	const entry = toolSummaryMessages.get(sessionId);
	if (!entry || entry.finalized) return;
	await postOrUpdateToolSummaryMessage(entry, true);
	entry.finalized = true;
}

async function finalizeAndClearToolSummaryMessage(sessionId) {
	await finalizeToolSummaryMessage(sessionId);
	clearToolSummaryMessage(sessionId);
}

async function postOrUpdateToolSummaryMessage(entry, final) {
	const blocks = toolSummaryBlocks(entry, final);
	const text = toolSummaryText(entry, final);
	if (entry.ts) {
		await updateSlackMessage(entry.channel, entry.ts, blocks, text);
		return;
	}
	const posted = await postSlackMessage(entry.channel, blocks, text);
	entry.ts = posted.ts;
}

function clearToolSummaryMessage(sessionId) {
	toolSummaryMessages.delete(sessionId);
}

async function updateCompactionMessage(sessionId, channel, forwarded) {
	let entry = compactionMessages.get(sessionId);
	if (!entry) {
		entry = { channel, ts: undefined, reason: forwarded.reason, final: false };
		compactionMessages.set(sessionId, entry);
	}
	entry.channel = channel;
	entry.reason = forwarded.reason || entry.reason;
	entry.final = false;
	entry.result = undefined;
	entry.aborted = false;
	entry.errorMessage = undefined;
	entry.willRetry = false;
	await postOrUpdateCompactionMessage(entry);
}

async function finalizeCompactionMessage(sessionId, channel, forwarded) {
	let entry = compactionMessages.get(sessionId);
	if (!entry) entry = { channel, ts: undefined, reason: forwarded.reason, final: true };
	entry.channel = channel;
	entry.reason = forwarded.reason || entry.reason;
	entry.final = true;
	entry.result = forwarded.result;
	entry.aborted = Boolean(forwarded.aborted);
	entry.errorMessage = forwarded.errorMessage;
	entry.willRetry = Boolean(forwarded.willRetry);
	await postOrUpdateCompactionMessage(entry);
	compactionMessages.delete(sessionId);
}

async function postOrUpdateCompactionMessage(entry) {
	const blocks = compactionBlocks(entry);
	const text = compactionText(entry);
	if (entry.ts) {
		await updateSlackMessage(entry.channel, entry.ts, blocks, text);
		return;
	}
	const posted = await postSlackMessage(entry.channel, blocks, text);
	entry.ts = posted.ts;
}

function clearCompactionMessage(sessionId) {
	compactionMessages.delete(sessionId);
}

function compactionBlocks(entry) {
	return [contextBlock(escapeMrkdwn(compactionText(entry)))];
}

function compactionText(entry) {
	const reason = compactionReasonText(entry.reason);
	if (!entry.final) return `:hourglass_flowing_sand: Compacting context${reason}...`;
	if (entry.errorMessage) return `:warning: Compaction failed${reason}: ${entry.errorMessage}`;
	if (entry.aborted) return `:black_circle: Compaction cancelled${reason}.`;
	const tokensBefore = Number(entry.result?.tokensBefore);
	const tokens = Number.isFinite(tokensBefore) && tokensBefore > 0 ? ` from ${formatInteger(tokensBefore)} tokens` : "";
	const retry = entry.willRetry ? " Continuing automatically." : "";
	return `:white_check_mark: Compaction finished${tokens}.${retry}`;
}

function compactionReasonText(reason) {
	if (reason === "threshold") return " automatically";
	if (reason === "overflow") return " after context overflow";
	return "";
}

function formatInteger(value) {
	return Math.round(value).toLocaleString("en-US");
}

function toolSummaryBlocks(entry, final) {
	return [contextBlock(escapeMrkdwn(toolSummaryText(entry, final)))];
}

function toolSummaryText(entry, final) {
	const labels = [...entry.labels];
	const skillNames = labels.map(skillNameFromActivityLabel).filter(Boolean);
	if (skillNames.length > 0 && skillNames.length === labels.length) {
		const icon = final ? ":white_check_mark:" : ":books:";
		const verb = final ? "Read" : "Reading";
		const subject = skillNames.length === 1 ? "skill" : "skills";
		const repeatedReads = entry.count > skillNames.length ? ` · ${entry.count} reads` : "";
		return `${icon} ${verb} ${subject}: ${skillNames.join(", ")}${repeatedReads}`;
	}
	const prefix = final ? ":white_check_mark: Worked on" : ":hammer_and_wrench: Working on";
	const labelText = labels.join(", ") || "the task";
	const count = entry.count === 1 ? "1 tool call" : `${entry.count} tool calls`;
	return `${prefix}: ${labelText} · ${count}`;
}

function toolActivityLabel(toolName, args, cwd) {
	const name = String(toolName || "tool");
	const skillName = name === "read" ? skillNameFromReadArgs(args, cwd) : undefined;
	if (skillName) return `reading skill ${skillName}`;
	if (["read", "grep", "find", "ls", "code_search"].includes(name)) return "reading and searching";
	if (["exec_command", "bash", "write_stdin", "list_background_bash", "wait_background_bash"].includes(name)) return "running commands";
	if (["apply_patch", "edit", "write"].includes(name)) return "editing files";
	if (["web_search", "web_run", "fetch_content", "get_search_content"].includes(name)) return "researching";
	if (["Agent", "get_subagent_result", "steer_subagent"].includes(name)) return "delegating work";
	if (name === "ask_user") return "asking for input";
	return `using ${name}`;
}

function skillNameFromActivityLabel(label) {
	const prefix = "reading skill ";
	return label.startsWith(prefix) ? label.slice(prefix.length) : undefined;
}

function skillNameFromReadArgs(args, cwd) {
	const path = toolArgsPath(args);
	if (!path) return undefined;
	const absolutePath = resolvePath(cwd || "", path);
	if (basename(absolutePath) !== "SKILL.md") return undefined;
	return basename(dirname(absolutePath)) || "SKILL.md";
}

function toolArgsPath(args) {
	if (!args || typeof args !== "object") return undefined;
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? value : undefined;
}

function textSectionBlocks(text, limit = SLACK_SECTION_TEXT_LIMIT) {
	const clean = clip(String(text || "").trim(), TEXT_CLIP_LIMIT);
	if (!clean) return [];
	return chunkText(clean, limit).map((chunk) => sectionBlock(escapeMrkdwn(chunk)));
}

async function postAskUserPrompt(client, channel, forwarded, fallback) {
	const ask = forwarded.ask;
	const blocks = askUserBlocks(forwarded.args, fallback, ask);
	let prompt;
	if (ask?.promptId) {
		prompt = {
			promptId: ask.promptId,
			toolCallId: forwarded.toolCallId,
			sessionId: client.sessionId,
			channel,
			messageTs: undefined,
			ask,
			completed: false,
			submitting: false,
			status: "Waiting for answer.",
		};
		askUserPrompts.set(ask.promptId, prompt);
		askUserPromptIdsByToolCall.set(forwarded.toolCallId, ask.promptId);
	}
	let posted;
	try {
		posted = await postSlackMessage(channel, blocks, fallbackTextForAskUser(forwarded.args, fallback));
	} catch (error) {
		if (prompt) {
			askUserPrompts.delete(ask.promptId);
			askUserPromptIdsByToolCall.delete(forwarded.toolCallId);
		}
		throw error;
	}
	if (prompt) prompt.messageTs = posted.ts;
}

function askUserBlocks(args, fallbackText, ask) {
	const mention = config.userId ? `<@${config.userId}> ` : "";
	const blocks = [
		sectionBlock(`${mention}*Input needed*`),
		...textSectionBlocks(`${formatAskUserPrompt(args, fallbackText)}\n\nReply in this Slack channel to answer. If Slack controls are shown below, you can use them instead.`, 1800),
	];
	if (ask?.promptId) blocks.push(...askUserControlBlocks(ask));
	else blocks.push(contextBlock("This prompt is controlled by the local Pi runtime and may need to be answered in the local Pi prompt."));
	return blocks;
}

function askUserControlBlocks(ask) {
	const question = ask.questions?.[0];
	if (isDirectButtonAsk(ask, question)) {
		return [{
			type: "actions",
			block_id: `ask_${shortAskId(ask.promptId)}`,
			elements: [
				...question.options.map((option, index) => ({
					type: "button",
					text: { type: "plain_text", text: clipPlain(option.title, 75) },
					action_id: `${ASK_USER_ANSWER_ACTION_ID}_${index}`,
					value: askUserButtonValue(ask.promptId, index),
				})),
				{
					type: "button",
					text: { type: "plain_text", text: "Cancel" },
					style: "danger",
					action_id: ASK_USER_CANCEL_ACTION_ID,
					value: ask.promptId,
				},
			],
		}];
	}
	return [{
		type: "actions",
		block_id: `ask_${shortAskId(ask.promptId)}`,
		elements: [
			{
				type: "button",
				text: { type: "plain_text", text: ask.questions.length > 1 ? "Answer questions" : "Answer in Slack" },
				style: "primary",
				action_id: ASK_USER_OPEN_MODAL_ACTION_ID,
				value: ask.promptId,
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Cancel" },
				style: "danger",
				action_id: ASK_USER_CANCEL_ACTION_ID,
				value: ask.promptId,
			},
		],
	}];
}

function isDirectButtonAsk(ask, question) {
	return ask.questions.length === 1
		&& question
		&& Array.isArray(question.options)
		&& question.options.length > 0
		&& question.options.length <= ASK_USER_DIRECT_BUTTON_LIMIT
		&& !question.allowMultiple
		&& !question.allowFreeform
		&& !question.allowComment;
}

function shortAskId(promptId) {
	return slugify(promptId, "ask").slice(0, 32);
}

function askUserButtonValue(promptId, optionIndex) {
	return JSON.stringify({ promptId, optionIndex });
}

function clipPlain(text, max) {
	const value = String(text || " ").replace(/\s+/g, " ").trim() || " ";
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatAskUserPrompt(args, fallbackText) {
	const value = args && typeof args === "object" ? args : {};
	if (Array.isArray(value.questions) && value.questions.length > 0) {
		const prompt = value.questions
			.map((question, index) => `Question ${index + 1}:\n${formatAskQuestion(question, fallbackText)}`)
			.join("\n\n---\n\n");
		return `${prompt}\n\nFor multiple questions, reply with one line per answer, e.g.\n1: your answer\n2: your answer`;
	}
	return formatAskQuestion(value, fallbackText);
}

function fallbackTextForAskUser(args, fallbackText) {
	const mention = config.userId ? `<@${config.userId}> ` : "";
	return `${mention}Input needed: ${formatAskUserPrompt(args, fallbackText).replace(/\s+/g, " ").trim()}`;
}

function formatAskQuestion(question, fallbackText) {
	const value = question && typeof question === "object" ? question : {};
	const lines = [String(value.question || fallbackText || "ask_user is waiting for input.")];
	if (value.context) lines.push(`Context:\n${value.context}`);
	if (Array.isArray(value.options) && value.options.length > 0) {
		lines.push(`Options:\n${value.options.map((option, index) => `${index + 1}. ${formatAskOption(option)}`).join("\n")}`);
	}
	if (value.allowMultiple) lines.push("You can choose multiple options with comma-separated numbers or titles.");
	else if (Array.isArray(value.options) && value.options.length > 0) lines.push("Reply with an option number/title, or type a custom answer if freeform is allowed.");
	return lines.filter(Boolean).join("\n\n");
}

function formatAskOption(option) {
	if (typeof option === "string") return option;
	if (!option || typeof option !== "object") return String(option || "");
	return option.description ? `${option.title} — ${option.description}` : String(option.title || "");
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
	if (message.type === "upload_file") {
		await handleUploadFileRequest(client, message);
		return;
	}
	if (message.type === "plan_action_result") {
		await handlePlanActionResult(message);
		return;
	}
	if (message.type === "ask_user_action_result") {
		await handleAskUserActionResult(message);
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
		const client = { socket, authenticated: false, buffer: "", lastSeen: now(), messageQueue: Promise.resolve() };
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
					client.messageQueue = client.messageQueue
						.then(() => handleClientMessage(client, message))
						.catch((error) => log(`client message failed: ${errorMessage(error)}`));
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
			void archiveSessionChannel(sessionId, "stale", { notify: false }).catch((error) => log(`stale close failed: ${errorMessage(error)}`));
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
	disposeCommunicationAgent();
	server?.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
});
process.on("SIGINT", () => {
	stopSlackSocket();
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
