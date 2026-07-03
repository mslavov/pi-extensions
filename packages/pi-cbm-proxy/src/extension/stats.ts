import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AugmentationOutcome } from "./augment.js";
import { isRecord } from "../shared/object.js";

const STATS_VERSION = 1;
const EXTENSION_DIR = "pi-cbm-proxy";
const STATS_FILE_NAME = "session-stats.json";
const MAX_SESSIONS = 100;

const DIRECT_CBM_SEARCH_TOOLS = new Set(["read_symbol", "search_and_read_symbols"]);
const CBM_SEARCH_COMMANDS = new Set([
  "search_graph",
  "search_code",
  "trace_path",
  "query_graph",
  "get_graph_schema",
  "get_code_snippet",
  "get_architecture",
  "detect_changes",
]);
const REGULAR_FILE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "exec_command"]);
const FILE_EXPLORATION_COMMAND_RE = /(?:^|[;&|(){}\s])(?:rg|grep|find|ls|cat|head|tail|less|awk)(?=\s|$)|(?:^|[;&|(){}\s])sed\s+-n(?=\s|$)/;

type StatsCategory = "cbm" | "regular" | "other";

type BucketStats = {
  total: number;
  errors: number;
  tools: Record<string, number>;
  commands: Record<string, number>;
};

type AugmentationStats = {
  attempted: number;
  matched: number;
  skipped: number;
  errors: number;
  estimatedAddedTokens: number;
  skipReasons: Record<string, number>;
  matchTokens: Record<string, number>;
};

export type CbmSessionStats = {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  totals: {
    toolCalls: number;
    errors: number;
    cbmSearches: number;
    regularSearches: number;
    otherToolCalls: number;
  };
  cbm: BucketStats;
  regular: BucketStats;
  other: BucketStats;
  augmentation: AugmentationStats;
};

type StatsFile = {
  version: number;
  currentSessionId?: string;
  sessions: CbmSessionStats[];
};

type TrackedCall = {
  category: StatsCategory;
};

function statsFilePath(): string {
  return path.join(getAgentDir(), "extensions", EXTENSION_DIR, STATS_FILE_NAME);
}

function emptyBucket(): BucketStats {
  return { total: 0, errors: 0, tools: {}, commands: {} };
}

function emptyAugmentation(): AugmentationStats {
  return { attempted: 0, matched: 0, skipped: 0, errors: 0, estimatedAddedTokens: 0, skipReasons: {}, matchTokens: {} };
}

function newSession(sessionId: string, cwd: string): CbmSessionStats {
  const now = new Date().toISOString();
  return {
    sessionId,
    cwd,
    startedAt: now,
    updatedAt: now,
    totals: { toolCalls: 0, errors: 0, cbmSearches: 0, regularSearches: 0, otherToolCalls: 0 },
    cbm: emptyBucket(),
    regular: emptyBucket(),
    other: emptyBucket(),
    augmentation: emptyAugmentation(),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function commandFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  return readString(args.command) ?? readString(args.cmd);
}

function cbmCommandFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  return readString(args.command);
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function sortedEntries(map: Record<string, number>, limit = 5): string[] {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${value}`);
}

function percentage(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}

function normalizeStatsFile(value: unknown): StatsFile {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return { version: STATS_VERSION, sessions: [] };
  return {
    version: STATS_VERSION,
    currentSessionId: readString(value.currentSessionId),
    sessions: value.sessions.map(normalizeSessionStats).filter((entry): entry is CbmSessionStats => entry !== undefined).slice(-MAX_SESSIONS),
  };
}

function isBucketStats(value: unknown): value is BucketStats {
  return isRecord(value) && typeof value.total === "number" && typeof value.errors === "number" && isRecord(value.tools) && isRecord(value.commands);
}

function isAugmentationStats(value: unknown): value is AugmentationStats {
  return isRecord(value)
    && typeof value.attempted === "number"
    && typeof value.matched === "number"
    && typeof value.skipped === "number"
    && typeof value.errors === "number"
    && typeof value.estimatedAddedTokens === "number"
    && isRecord(value.skipReasons)
    && isRecord(value.matchTokens);
}

function isSessionStats(value: unknown): value is Omit<CbmSessionStats, "augmentation"> & { augmentation?: unknown } {
  return isRecord(value)
    && typeof value.sessionId === "string"
    && typeof value.cwd === "string"
    && typeof value.startedAt === "string"
    && typeof value.updatedAt === "string"
    && isRecord(value.totals)
    && typeof value.totals.toolCalls === "number"
    && typeof value.totals.errors === "number"
    && typeof value.totals.cbmSearches === "number"
    && typeof value.totals.regularSearches === "number"
    && typeof value.totals.otherToolCalls === "number"
    && isBucketStats(value.cbm)
    && isBucketStats(value.regular)
    && isBucketStats(value.other);
}

function normalizeSessionStats(value: unknown): CbmSessionStats | undefined {
  if (!isSessionStats(value)) return undefined;
  return {
    ...value,
    augmentation: isAugmentationStats(value.augmentation) ? value.augmentation : emptyAugmentation(),
  };
}

export class CbmStatsService {
  private readonly trackedCalls = new Map<string, TrackedCall>();
  private store: StatsFile = { version: STATS_VERSION, sessions: [] };
  private currentSession: CbmSessionStats | undefined;

  readonly filePath = statsFilePath();

  startSession(ctx: ExtensionContext): void {
    this.load();
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? `session-${Date.now()}`;
    let session = this.store.sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      session = newSession(sessionId, ctx.cwd);
      this.store.sessions.push(session);
      this.store.sessions = this.store.sessions.slice(-MAX_SESSIONS);
    } else {
      session.cwd = ctx.cwd;
      session.updatedAt = new Date().toISOString();
      delete session.endedAt;
    }
    this.store.currentSessionId = sessionId;
    this.currentSession = session;
    this.trackedCalls.clear();
    this.save();
  }

  endSession(): void {
    if (!this.currentSession) return;
    const now = new Date().toISOString();
    this.currentSession.updatedAt = now;
    this.currentSession.endedAt = now;
    this.save();
  }

  recordToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const session = this.currentSession;
    if (!session) return;

    const classification = this.classify(toolName, args);
    const bucket = session[classification.category];
    session.totals.toolCalls++;
    bucket.total++;
    increment(bucket.tools, toolName);
    if (classification.command) increment(bucket.commands, classification.command);

    if (classification.category === "cbm") session.totals.cbmSearches++;
    else if (classification.category === "regular") session.totals.regularSearches++;
    else session.totals.otherToolCalls++;

    session.updatedAt = new Date().toISOString();
    this.trackedCalls.set(toolCallId, { category: classification.category });
    this.save();
  }

  recordToolEnd(toolCallId: string, isError: boolean): void {
    const session = this.currentSession;
    const tracked = this.trackedCalls.get(toolCallId);
    if (!session || !tracked) return;
    this.trackedCalls.delete(toolCallId);
    if (!isError) return;

    session.totals.errors++;
    session[tracked.category].errors++;
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  recordAugmentation(outcome: AugmentationOutcome): void {
    const session = this.currentSession;
    if (!session) return;
    if (outcome.status === "skipped" && outcome.reason === "not a supported regular search") return;

    const stats = session.augmentation;
    stats.attempted++;

    if (outcome.status === "matched") {
      stats.matched++;
      stats.estimatedAddedTokens += outcome.estimatedTokens;
      increment(stats.matchTokens, outcome.token);
    } else if (outcome.status === "skipped") {
      stats.skipped++;
      increment(stats.skipReasons, outcome.reason);
    } else {
      stats.errors++;
      increment(stats.skipReasons, outcome.reason);
    }

    session.updatedAt = new Date().toISOString();
    this.save();
  }

  snapshot(): CbmSessionStats | undefined {
    return this.currentSession ? structuredClone(this.currentSession) : undefined;
  }

  summaryLines(): string[] {
    const session = this.currentSession;
    if (!session) return ["pi-cbm search stats", "  No active session stats yet.", `  Stats file: ${this.filePath}`];

    const totalSearches = session.totals.cbmSearches + session.totals.regularSearches;
    const lines = [
      "pi-cbm search stats",
      `  Session: ${session.sessionId}`,
      `  CWD: ${session.cwd}`,
      `  Stats file: ${this.filePath}`,
      "",
      "Search/exploration usage:",
      `  CBM searches:     ${session.totals.cbmSearches} (${percentage(session.totals.cbmSearches, totalSearches)})`,
      `  Regular searches: ${session.totals.regularSearches} (${percentage(session.totals.regularSearches, totalSearches)})`,
      `  Search total:     ${totalSearches}`,
      "",
      "Tool calls:",
      `  Total:  ${session.totals.toolCalls}`,
      `  Other:  ${session.totals.otherToolCalls}`,
      `  Errors: ${session.totals.errors}`,
    ];

    appendTop(lines, "Top CBM tools", session.cbm.tools);
    appendTop(lines, "Top CBM commands", session.cbm.commands);
    appendTop(lines, "Top regular tools", session.regular.tools);
    appendTop(lines, "Top regular commands", session.regular.commands);
    lines.push(
      "",
      "Search augmentation:",
      `  Attempted:              ${session.augmentation.attempted}`,
      `  Matched:                ${session.augmentation.matched}`,
      `  Skipped:                ${session.augmentation.skipped}`,
      `  Errors:                 ${session.augmentation.errors}`,
      `  Estimated added tokens: ${session.augmentation.estimatedAddedTokens}`,
    );
    appendTop(lines, "Top augmented tokens", session.augmentation.matchTokens);
    appendTop(lines, "Top augmentation skip reasons", session.augmentation.skipReasons);
    return lines;
  }

  private classify(toolName: string, args: unknown): { category: StatsCategory; command?: string } {
    if (DIRECT_CBM_SEARCH_TOOLS.has(toolName)) return { category: "cbm", command: toolName };

    if (toolName === "cbm") {
      const command = cbmCommandFromArgs(args);
      return command && CBM_SEARCH_COMMANDS.has(command) ? { category: "cbm", command } : { category: "other", command: command ?? "cbm" };
    }

    if (REGULAR_FILE_TOOLS.has(toolName)) return { category: "regular", command: toolName };

    if (SHELL_TOOLS.has(toolName)) {
      const command = commandFromArgs(args);
      if (command && FILE_EXPLORATION_COMMAND_RE.test(command)) return { category: "regular", command: shellCommandLabel(command) };
      return { category: "other", command: toolName };
    }

    return { category: "other", command: toolName };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.store = { version: STATS_VERSION, sessions: [] };
        return;
      }
      this.store = normalizeStatsFile(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      this.store = { version: STATS_VERSION, sessions: [] };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), "utf8");
    } catch {
      // Stats are best-effort and must never affect tool execution.
    }
  }
}

function shellCommandLabel(command: string): string {
  const match = command.match(/(?:^|[;&|(){}\s])(rg|grep|find|ls|cat|head|tail|less|awk)(?=\s|$)|(?:^|[;&|(){}\s])(sed\s+-n)(?=\s|$)/);
  return match?.[1] ?? match?.[2] ?? "shell-search";
}

function appendTop(lines: string[], title: string, map: Record<string, number>): void {
  const entries = sortedEntries(map);
  if (entries.length === 0) return;
  lines.push("", `${title}:`);
  for (const entry of entries) lines.push(`  ${entry}`);
}
