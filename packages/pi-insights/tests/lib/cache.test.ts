import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CACHE_SCHEMA_VERSION,
  FACET_PROMPT_VERSION,
  PARSER_CACHE_VERSION,
  buildSessionCacheKey,
  clearPiInsightsCache,
  getPiInsightsCacheDir,
  readCachedSession,
  writeCachedSession,
} from "../../lib/cache.js";
import type { ParsedSession } from "../../lib/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-insights-cache-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: "sess-1",
    cwd: "/home/user/project",
    projectName: "project",
    startTime: new Date("2025-03-15T10:00:00Z"),
    endTime: new Date("2025-03-15T10:30:00Z"),
    duration: 30,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 0,
    tokenUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    models: { "gpt-4": { count: 1, tokens: 30, cost: 0.003 } },
    providers: { openai: 1 },
    thinkingLevels: {},
    toolUsage: {},
    stopReasons: {},
    toolCallErrors: 0,
    hasError: false,
    rageHits: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("getPiInsightsCacheDir", () => {
  it("uses the pi usage-data cache path", () => {
    expect(getPiInsightsCacheDir("/tmp/home")).toBe(path.join("/tmp/home", ".pi", "agent", "usage-data", "pi-insights"));
  });
});

describe("parsed session cache", () => {
  it("writes and reads parsed sessions with Date fields restored", async () => {
    const dir = await makeTempDir();
    const cacheRoot = path.join(dir, "cache");
    const sessionPath = path.join(dir, "session-file.jsonl");
    await writeFile(sessionPath, "session data", "utf8");

    await writeCachedSession(sessionPath, makeSession(), cacheRoot);
    const cached = await readCachedSession(sessionPath, cacheRoot);

    expect(cached?.id).toBe("sess-1");
    expect(cached?.startTime).toBeInstanceOf(Date);
    expect(cached?.startTime.toISOString()).toBe("2025-03-15T10:00:00.000Z");
    expect(cached?.tokenUsage.total).toBe(30);
  });

  it("misses when the source file metadata changes", async () => {
    const dir = await makeTempDir();
    const cacheRoot = path.join(dir, "cache");
    const sessionPath = path.join(dir, "session-file.jsonl");
    await writeFile(sessionPath, "session data", "utf8");

    await writeCachedSession(sessionPath, makeSession(), cacheRoot);
    await writeFile(sessionPath, "session data changed", "utf8");

    expect(await readCachedSession(sessionPath, cacheRoot)).toBeUndefined();
  });

  it("clears cache files", async () => {
    const dir = await makeTempDir();
    const cacheRoot = path.join(dir, "cache");
    const sessionPath = path.join(dir, "session-file.jsonl");
    await writeFile(sessionPath, "session data", "utf8");
    await writeCachedSession(sessionPath, makeSession(), cacheRoot);

    await clearPiInsightsCache(cacheRoot);

    expect(await readCachedSession(sessionPath, cacheRoot)).toBeUndefined();
  });

  it("persists version metadata without transcript text", async () => {
    const dir = await makeTempDir();
    const cacheRoot = path.join(dir, "cache");
    const sessionPath = path.join(dir, "session-file.jsonl");
    await writeFile(sessionPath, "secret transcript text", "utf8");

    await writeCachedSession(sessionPath, makeSession(), cacheRoot);
    const [entryFile] = await readdir(path.join(cacheRoot, "session-meta"));
    const raw = await readFile(path.join(cacheRoot, "session-meta", entryFile), "utf8");

    expect(raw).toContain(`"schemaVersion":"${CACHE_SCHEMA_VERSION}"`);
    expect(raw).toContain(`"parserVersion":"${PARSER_CACHE_VERSION}"`);
    expect(raw).toContain(`"facetPromptVersion":"${FACET_PROMPT_VERSION}"`);
    expect(raw).not.toContain("secret transcript text");
  });
});

describe("buildSessionCacheKey", () => {
  const keyInput = {
    sessionId: "session-file",
    filePath: "/tmp/session-file.jsonl",
    mtimeMs: 123,
    size: 456,
    schemaVersion: CACHE_SCHEMA_VERSION,
    parserVersion: PARSER_CACHE_VERSION,
    facetPromptVersion: FACET_PROMPT_VERSION,
  };

  it("includes file identity and versions", () => {
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, sessionId: "other" }));
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, filePath: "/tmp/other.jsonl" }));
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, mtimeMs: 124 }));
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, size: 457 }));
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, schemaVersion: "next" }));
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, parserVersion: "next" }));
    expect(buildSessionCacheKey(keyInput)).not.toBe(buildSessionCacheKey({ ...keyInput, facetPromptVersion: "next" }));
  });
});
