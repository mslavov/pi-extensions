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

export interface BrokerAskUserQuestion {
	question: string;
	header: string;
	context?: string;
	options: Array<{ title: string; description?: string }>;
	allowMultiple: boolean;
	allowFreeform: boolean;
	allowComment: boolean;
}

export interface BrokerAskUserPrompt {
	promptId: string;
	createdAt: number;
	questions: BrokerAskUserQuestion[];
}

export type BrokerAskUserSingleResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string };

export type BrokerAskUserResponse =
	| BrokerAskUserSingleResponse
	| { kind: "questions"; responses: Record<string, BrokerAskUserSingleResponse | null> }
	| null;

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

export interface BrokerCommunicationAgentStatus {
	enabled: boolean;
	sessionId?: string;
	sessionFile?: string;
	isIdle: boolean;
	activeTurn?: { requestId: string; channelId: string };
	pendingMessages: number;
	lastError?: string;
	lastHandledAt?: number;
	contextPercent?: number | null;
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
	communicationAgent?: BrokerCommunicationAgentStatus;
	lastError?: string;
}

export type CasperForwardedEvent =
	| { type: "session_started"; timestamp: number }
	| { type: "agent_started"; timestamp: number }
	| { type: "agent_finished"; timestamp: number; stopReason?: string; errorMessage?: string; attention?: boolean }
	| { type: "message_start"; timestamp: number; streamId?: string; message: unknown }
	| { type: "message_update"; timestamp: number; streamId?: string; message: unknown }
	| { type: "message_end"; timestamp: number; streamId?: string; message: unknown; attention?: boolean }
	| { type: "compaction_start"; timestamp: number; reason?: "manual" | "threshold" | "overflow"; attention?: boolean }
	| {
			type: "compaction_end";
			timestamp: number;
			reason?: "manual" | "threshold" | "overflow";
			result?: { summary?: string; firstKeptEntryId?: string; tokensBefore?: number; details?: unknown };
			aborted?: boolean;
			willRetry?: boolean;
			errorMessage?: string;
			attention?: boolean;
		}
	| { type: "plan_ready"; timestamp: number; planFilePath: string; reviewUrl?: string; title?: string; message?: string; attention?: boolean }
	| { type: "plan_closed"; timestamp: number; planFilePath: string; reason?: string }
	| { type: "tool_start"; timestamp: number; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_waiting"; timestamp: number; toolCallId: string; toolName: string; args: unknown; text?: string; ask?: BrokerAskUserPrompt; attention?: boolean }
	| { type: "tool_end"; timestamp: number; toolCallId: string; toolName: string; result: unknown; isError: boolean; attention?: boolean };

export type ClientToBroker =
	| ({ v: 1; type: "hello"; brokerSecret: string } & BrokerSessionSnapshot)
	| ({ v: 1; type: "session_update" } & BrokerSessionSnapshot)
	| { v: 1; type: "session_closed"; sessionId: string; reason?: string }
	| { v: 1; type: "reload_config"; id?: string }
	| { v: 1; type: "get_status"; id: string }
	| { v: 1; type: "plan_action_result"; requestId: string; channelId?: string; ok: boolean; message?: string; error?: string }
	| { v: 1; type: "ask_user_action_result"; requestId: string; channelId?: string; ok: boolean; message?: string; error?: string }
	| { v: 1; type: "forward_event"; eventId: string; event: CasperForwardedEvent };

export type BrokerToClient =
	| { v: 1; type: "hello_ack"; configured: boolean; channelId?: string; channelName?: string }
	| {
			v: 1;
			type: "deliver_turn";
			requestId: string;
			channelId: string;
			userId: string;
			text: string;
			ts?: string;
			files: DownloadedSlackFile[];
			source?: "slack_user" | "communication_agent";
			delegatedByRequestId?: string;
		}
	| {
			v: 1;
			type: "plan_action";
			requestId: string;
			channelId: string;
			userId?: string;
			action: "approve" | "refine" | "exit";
			feedback?: string;
			planFilePath?: string;
		}
	| {
			v: 1;
			type: "ask_user_action";
			requestId: string;
			channelId: string;
			userId?: string;
			promptId: string;
			response: BrokerAskUserResponse;
		}
	| { v: 1; type: "response"; id: string; ok: boolean; result?: unknown; error?: string };

export const CASPER_DIR = join(homedir(), ".pi", "agent", "extensions", "casper");
export const CONFIG_PATH = join(CASPER_DIR, "casper.json");
export const TEMP_DIR = join(CASPER_DIR, "tmp");
export const BROKER_SOCKET_PATH = join(CASPER_DIR, "broker.sock");
export const BROKER_STATE_PATH = join(CASPER_DIR, "broker-state.json");
export const BROKER_STATUS_PATH = join(CASPER_DIR, "broker.json");
export const BROKER_LOG_PATH = join(CASPER_DIR, "broker.log");
export const DEFAULT_CHANNEL_PREFIX = "pi";
export const MAX_ATTACHMENTS_PER_TURN = 10;
