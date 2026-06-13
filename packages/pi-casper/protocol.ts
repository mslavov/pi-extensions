import { homedir } from "node:os";
import { join } from "node:path";

export interface CasperConfig {
	botToken?: string;
	appToken?: string;
	botUserId?: string;
	botTeamId?: string;
	userId?: string;
	channelPrefix?: string;
	privateChannels?: boolean;
	archiveOnSessionClose?: boolean;
	brokerSecret?: string;
}

export interface DownloadedSlackFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
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
	activeTurn?: { requestId: string; channelId: string };
	queuedTurns: number;
	recentMessages: SessionSnippet[];
}

export interface CasperSessionMapping {
	sessionId: string;
	channelId: string;
	channelName: string;
	cwd?: string;
	sessionFile?: string;
	sessionName?: string;
	state: "active" | "closed" | "archived";
	createdAt: number;
	updatedAt: number;
	closedAt?: number;
	archivedAt?: number;
	closeReason?: string;
}

export interface BrokerStatus {
	configured: boolean;
	socketConnected: boolean;
	brokerPid: number;
	botUserId?: string;
	botTeamId?: string;
	userId?: string;
	channelPrefix: string;
	archiveOnSessionClose: boolean;
	sessions: Array<BrokerSessionSnapshot & { lastSeen?: number; channelId?: string; channelName?: string; channelState?: CasperSessionMapping["state"] }>;
	mappings: CasperSessionMapping[];
	lastError?: string;
}

export type CasperForwardedEvent =
	| { type: "session_started"; timestamp: number }
	| { type: "agent_started"; timestamp: number }
	| { type: "agent_finished"; timestamp: number; stopReason?: string; errorMessage?: string; attention?: boolean }
	| { type: "message_start"; timestamp: number; streamId?: string; message: unknown }
	| { type: "message_update"; timestamp: number; streamId?: string; message: unknown }
	| { type: "message_end"; timestamp: number; streamId?: string; message: unknown; attention?: boolean }
	| { type: "tool_start"; timestamp: number; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_waiting"; timestamp: number; toolCallId: string; toolName: string; args: unknown; text?: string; attention?: boolean }
	| { type: "tool_end"; timestamp: number; toolCallId: string; toolName: string; result: unknown; isError: boolean; attention?: boolean };

export type ClientToBroker =
	| ({ v: 1; type: "hello"; brokerSecret: string } & BrokerSessionSnapshot)
	| ({ v: 1; type: "session_update" } & BrokerSessionSnapshot)
	| { v: 1; type: "session_closed"; sessionId: string; reason?: string }
	| { v: 1; type: "reload_config"; id?: string }
	| { v: 1; type: "get_status"; id: string }
	| { v: 1; type: "forward_event"; eventId: string; event: CasperForwardedEvent };

export type BrokerToClient =
	| { v: 1; type: "hello_ack"; configured: boolean; channelId?: string; channelName?: string }
	| { v: 1; type: "deliver_turn"; requestId: string; channelId: string; userId: string; text: string; ts?: string; files: DownloadedSlackFile[] }
	| { v: 1; type: "response"; id: string; ok: boolean; result?: unknown; error?: string };

export const CASPER_DIR = join(homedir(), ".pi", "agent", "extensions", "casper");
export const CONFIG_PATH = join(CASPER_DIR, "casper.json");
export const TEMP_DIR = join(CASPER_DIR, "tmp");
export const BROKER_SOCKET_PATH = join(CASPER_DIR, "broker.sock");
export const BROKER_STATE_PATH = join(CASPER_DIR, "broker-state.json");
export const BROKER_STATUS_PATH = join(CASPER_DIR, "broker.json");
export const BROKER_LOG_PATH = join(CASPER_DIR, "broker.log");
export const SLACK_PREFIX = "[slack]";
export const DEFAULT_CHANNEL_PREFIX = "pi";
export const MAX_ATTACHMENTS_PER_TURN = 10;
