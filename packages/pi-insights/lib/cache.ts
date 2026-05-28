import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ParsedSession } from "./types.js";

export const CACHE_SCHEMA_VERSION = "1";
export const PARSER_CACHE_VERSION = "1";
export const FACET_PROMPT_VERSION = "1";

export interface SessionCacheKeyInput {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  size: number;
  schemaVersion: string;
  parserVersion: string;
  facetPromptVersion: string;
}

interface SerializedParsedSession extends Omit<ParsedSession, "startTime" | "endTime"> {
  startTime: string;
  endTime: string;
}

interface CachedParsedSession {
  kind: "parsed-session";
  metadata: SessionCacheKeyInput & {
    cachedAt: string;
    parsedSessionId: string;
  };
  session: SerializedParsedSession;
}

export function getPiInsightsCacheDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", "usage-data", "pi-insights");
}

export async function clearPiInsightsCache(cacheRoot = getPiInsightsCacheDir()): Promise<void> {
  await fs.rm(cacheRoot, { recursive: true, force: true });
  await fs.mkdir(sessionMetaDir(cacheRoot), { recursive: true });
}

export async function readCachedSession(
  filePath: string,
  cacheRoot = getPiInsightsCacheDir()
): Promise<ParsedSession | undefined> {
  const fileInfo = await sessionCacheKeyInput(filePath);
  const cachePath = sessionCachePath(cacheRoot, buildSessionCacheKey(fileInfo));

  let raw: string;
  try {
    raw = await fs.readFile(cachePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  const cached = JSON.parse(raw) as unknown;
  if (!isCachedParsedSession(cached)) return undefined;
  if (!matchesCurrentFile(cached.metadata, fileInfo)) return undefined;

  return deserializeSession(cached.session);
}

export async function writeCachedSession(
  filePath: string,
  session: ParsedSession,
  cacheRoot = getPiInsightsCacheDir()
): Promise<void> {
  const fileInfo = await sessionCacheKeyInput(filePath);
  const key = buildSessionCacheKey(fileInfo);
  const cachePath = sessionCachePath(cacheRoot, key);
  const tmpPath = `${cachePath}.${process.pid}.tmp`;

  const entry: CachedParsedSession = {
    kind: "parsed-session",
    metadata: {
      ...fileInfo,
      cachedAt: new Date().toISOString(),
      parsedSessionId: session.id,
    },
    session: serializeSession(session),
  };

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(entry), "utf8");
  await fs.rename(tmpPath, cachePath);
}

export function buildSessionCacheKey(input: SessionCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function sessionCacheKeyInput(filePath: string): Promise<SessionCacheKeyInput> {
  const stats = await fs.stat(filePath);
  return {
    sessionId: path.basename(filePath, path.extname(filePath)),
    filePath: path.resolve(filePath),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    schemaVersion: CACHE_SCHEMA_VERSION,
    parserVersion: PARSER_CACHE_VERSION,
    facetPromptVersion: FACET_PROMPT_VERSION,
  };
}

function sessionMetaDir(cacheRoot: string): string {
  return path.join(cacheRoot, "session-meta");
}

function sessionCachePath(cacheRoot: string, key: string): string {
  return path.join(sessionMetaDir(cacheRoot), `${key}.json`);
}

function serializeSession(session: ParsedSession): SerializedParsedSession {
  return {
    ...session,
    startTime: session.startTime.toISOString(),
    endTime: session.endTime.toISOString(),
  };
}

function deserializeSession(session: SerializedParsedSession): ParsedSession {
  return {
    ...session,
    startTime: new Date(session.startTime),
    endTime: new Date(session.endTime),
  };
}

function matchesCurrentFile(cached: CachedParsedSession["metadata"], current: SessionCacheKeyInput): boolean {
  return cached.sessionId === current.sessionId
    && cached.filePath === current.filePath
    && cached.mtimeMs === current.mtimeMs
    && cached.size === current.size
    && cached.schemaVersion === current.schemaVersion
    && cached.parserVersion === current.parserVersion
    && cached.facetPromptVersion === current.facetPromptVersion;
}

function isCachedParsedSession(value: unknown): value is CachedParsedSession {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CachedParsedSession>;
  return entry.kind === "parsed-session"
    && typeof entry.metadata === "object"
    && typeof entry.session === "object";
}
