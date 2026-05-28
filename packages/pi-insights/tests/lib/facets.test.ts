import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAiInsights, normalizeFacetResponse, parseJsonObject, type FacetModelClient } from "../../lib/facets.js";
import type { ParsedSession } from "../../lib/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-insights-facets-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: "sess-1",
    cwd: "/repo/project",
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
    providers: {},
    thinkingLevels: {},
    toolUsage: {},
    stopReasons: {},
    toolCallErrors: 0,
    hasError: false,
    rageHits: [],
    ...overrides,
  };
}

async function writeSessionFile(dir: string): Promise<string> {
  const filePath = path.join(dir, "sess-1.jsonl");
  await writeFile(filePath, [
    JSON.stringify({ type: "session", id: "sess-1", cwd: "/repo/project", timestamp: "2025-03-15T10:00:00Z" }),
    JSON.stringify({ type: "message", timestamp: "2025-03-15T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "secret transcript text" }] } }),
    JSON.stringify({ type: "message", timestamp: "2025-03-15T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ].join("\n"), "utf8");
  return filePath;
}

function facetResponse(): string {
  return JSON.stringify({
    goal: "Improve report UX",
    goalCategories: ["analytics"],
    outcome: "success",
    satisfaction: "positive",
    friction: ["rework"],
    helpfulness: "high",
    sessionType: "implementation",
    summary: "Built a focused feature",
    recommendations: [{ title: "Try cache", detail: "Use cached facets", category: "workflow" }],
    stopDoing: [{ title: "Stop rerunning everything", detail: "Use refresh only when needed", category: "stop" }],
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("buildAiInsights", () => {
  it("returns an unavailable empty state without a model client", async () => {
    const result = await buildAiInsights({
      sessions: [makeSession()],
      sessionFilesById: new Map(),
      cacheRoot: "/tmp/cache",
      refresh: false,
    });

    expect(result.status).toBe("unavailable");
    expect(result.cacheState).toBe("skipped");
    expect(result.facets).toEqual([]);
  });

  it("extracts, caches, and reuses derived facets without caching raw transcripts", async () => {
    const dir = await makeTempDir();
    const homeDir = path.join(dir, "home");
    await mkdir(path.join(homeDir, ".pi", "agent", "skills"), { recursive: true });
    await writeFile(path.join(homeDir, ".pi", "agent", "AGENTS.md"), "Existing rule: use Beads.", "utf8");
    await writeFile(path.join(homeDir, ".pi", "agent", "skills", "beads"), "", "utf8");
    const sessionPath = await writeSessionFile(dir);
    const cacheRoot = path.join(dir, "cache");
    let calls = 0;
    const modelClient: FacetModelClient = {
      async complete(prompt: string) {
        calls++;
        expect(prompt).toContain("Existing rule: use Beads.");
        expect(prompt).toContain("secret transcript text");
        return facetResponse();
      },
    };

    const first = await buildAiInsights({
      sessions: [makeSession()],
      sessionFilesById: new Map([["sess-1", sessionPath]]),
      cacheRoot,
      refresh: false,
      modelClient,
      homeDir,
    });
    const second = await buildAiInsights({
      sessions: [makeSession()],
      sessionFilesById: new Map([["sess-1", sessionPath]]),
      cacheRoot,
      refresh: false,
      modelClient,
      homeDir,
    });

    expect(calls).toBe(1);
    expect(first.status).toBe("available");
    expect(first.cacheState).toBe("miss");
    expect(second.cacheState).toBe("hit");
    expect(second.facets[0].goal).toBe("Improve report UX");
    const [cacheFile] = await readdir(path.join(cacheRoot, "facets"));
    const rawCache = await readFile(path.join(cacheRoot, "facets", cacheFile), "utf8");
    expect(rawCache).not.toContain("secret transcript text");
  });

  it("returns unavailable when strict JSON parsing fails", async () => {
    const dir = await makeTempDir();
    const sessionPath = await writeSessionFile(dir);
    const result = await buildAiInsights({
      sessions: [makeSession()],
      sessionFilesById: new Map([["sess-1", sessionPath]]),
      cacheRoot: path.join(dir, "cache"),
      refresh: false,
      modelClient: { complete: async () => "not json" },
      homeDir: dir,
    });

    expect(result.status).toBe("unavailable");
    expect(result.unavailableReason).toContain("failed");
  });
});

describe("facet response parsing", () => {
  it("normalizes strict JSON objects", () => {
    const result = normalizeFacetResponse("s1", parseJsonObject(`prefix ${facetResponse()} suffix`));
    expect(result.facet.sessionId).toBe("s1");
    expect(result.facet.goal).toBe("Improve report UX");
    expect(result.recommendations[0].category).toBe("workflow");
    expect(result.stopDoing[0].category).toBe("stop");
  });

  it("rejects objects without facet content", () => {
    expect(() => normalizeFacetResponse("s1", {})).toThrow(/goal, outcome, or summary/);
  });
});
