import { homedir } from "node:os";
import { join } from "node:path";

export interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
	brokerSecret?: string;
	presence?: TelegramPresenceConfig;
}

export type PresenceState = "present" | "away" | "unknown";
export type PresenceMode = "auto" | "disabled";
export type PresenceProvider = "macos-hid-idle" | "disabled";
export type PresenceNotificationPolicy = "away_only" | "present_only" | "always" | "never";
export type TelegramNotificationKind = "progress" | "completion" | "waiting" | "notify" | "error";

export interface TelegramPresenceConfig {
	enabled?: boolean;
	mode?: PresenceMode;
	provider?: PresenceProvider;
	awayAfterSeconds?: number;
	presentBelowSeconds?: number;
	pollIntervalSeconds?: number;
	notificationPolicy?: PresenceNotificationPolicy;
}

export interface BrokerPresenceStatus {
	enabled: boolean;
	mode: PresenceMode;
	provider: PresenceProvider;
	state: PresenceState;
	notificationPolicy: PresenceNotificationPolicy;
	awayAfterSeconds: number;
	presentBelowSeconds: number;
	pollIntervalSeconds: number;
	idleSeconds?: number;
	updatedAt?: number;
	lastError?: string;
}

export interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

export interface QueuedAttachment {
	path: string;
	fileName: string;
}

export interface SessionSnippet {
	role: string;
	text: string;
}

export interface BrokerSessionSnapshot {
	connectionId: string;
	sessionId: string;
	pid: number;
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	model?: string;
	isIdle: boolean;
	activeTurn?: { requestId: string; chatId: number };
	queuedTurns: number;
	queuedByChat: Record<string, number>;
	recentMessages: SessionSnippet[];
}

export interface BrokerStatus {
	configured: boolean;
	paired: boolean;
	botUsername?: string;
	allowedUserId?: number;
	polling: boolean;
	brokerPid: number;
	lastUpdateId?: number;
	presence: BrokerPresenceStatus;
	sessions: BrokerSessionSnapshot[];
	communicationAgent?: {
		enabled: boolean;
		sessionId?: string;
		sessionFile?: string;
		isIdle: boolean;
		activeTurn?: { requestId: string; chatId: number };
		pendingMessages: number;
		lastError?: string;
		lastHandledAt?: number;
		contextPercent?: number | null;
	};
	lastError?: string;
}

export type ClientToBroker =
	| ({ v: 1; type: "hello"; brokerSecret: string } & BrokerSessionSnapshot)
	| ({ v: 1; type: "session_update" } & BrokerSessionSnapshot)
	| { v: 1; type: "reload_config"; id?: string }
	| { v: 1; type: "get_status"; id: string }
	| { v: 1; type: "send_text"; id?: string; chatId: number; text: string; replyToMessageId?: number; linkToSession?: boolean }
	| { v: 1; type: "send_files"; id: string; chatId?: number; attachments: QueuedAttachment[]; linkToSession?: boolean }
	| { v: 1; type: "preview_start"; requestId: string; chatId: number }
	| { v: 1; type: "preview_update"; requestId: string; chatId: number; text: string }
	| {
			v: 1;
			type: "turn_result";
			requestId: string;
			chatId: number;
			replyToMessageId: number;
			stopReason?: string;
			text?: string;
			errorMessage?: string;
			attachments: QueuedAttachment[];
		}
	| { v: 1; type: "send_progress"; id: string; text: string; notificationKind?: TelegramNotificationKind }
	| { v: 1; type: "local_error"; errorMessage: string };

export type BrokerToClient =
	| { v: 1; type: "hello_ack"; paired: boolean; allowedUserId?: number }
	| {
			v: 1;
			type: "deliver_turn";
			requestId: string;
			chatId: number;
			fromUserId: number;
			replyToMessageId: number;
			rawText: string;
			telegramMessageIds: number[];
			files: DownloadedTelegramFile[];
			source?: "telegram_user" | "communication_agent";
			delegatedByRequestId?: string;
		}
	| { v: 1; type: "response"; id: string; ok: boolean; result?: unknown; error?: string };

export const TELEGRAM_DIR = join(homedir(), ".pi", "agent", "extensions", "telegram");
export const OLD_CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
export const CONFIG_PATH = join(TELEGRAM_DIR, "telegram.json");
export const TEMP_DIR = join(TELEGRAM_DIR, "tmp");
export const BROKER_SOCKET_PATH = join(TELEGRAM_DIR, "broker.sock");
export const BROKER_STATE_PATH = join(TELEGRAM_DIR, "broker-state.json");
export const BROKER_STATUS_PATH = join(TELEGRAM_DIR, "broker.json");
export const BROKER_LOG_PATH = join(TELEGRAM_DIR, "broker.log");
export const TELEGRAM_PREFIX = "[telegram]";
export const MAX_ATTACHMENTS_PER_TURN = 10;
export const TELEGRAM_PROGRESS_MAX_LENGTH = 500;
