/**
 * Tests that all path-dependent calls in agent-runner.ts receive valid string arguments.
 *
 * The core bug: DefaultResourceLoader, SettingsManager.create(), SessionManager.inMemory(),
 * and various utility functions receive `cwd` or `agentDir` — if any are undefined,
 * Node's path.join/resolve throws "The 'path' argument must be of type string".
 *
 * We mock the heavy dependencies and verify the wiring is correct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// Track all path-sensitive calls
const calls = {
  DefaultResourceLoader: [] as any[],
  SettingsManagerCreate: [] as any[],
  SessionManagerInMemory: [] as any[],
  createAgentSession: [] as any[],
  setActiveToolsByName: [] as any[],
  detectEnv: [] as any[],
  preloadSkills: [] as any[],
  getToolsForType: [] as any[],
  buildAgentPrompt: [] as any[],
};

// --- Mocks ---

// Mock pi-coding-agent
vi.mock("@mariozechner/pi-coding-agent", () => {
  const mockSession = {
    messages: [],
    getActiveToolNames: () => ["read", "bash", "Agent", "ext_tool"],
    setActiveToolsByName: vi.fn((toolNames: string[]) => calls.setActiveToolsByName.push(toolNames)),
    subscribe: vi.fn(() => vi.fn()),
    abort: vi.fn(),
    prompt: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),
    getSessionStats: () => ({ tokens: { total: 0 } }),
  };

  return {
    DefaultResourceLoader: class {
      constructor(opts: any) {
        calls.DefaultResourceLoader.push(opts);
        // Simulate what the real constructor does — join(agentDir, "skills"), etc.
        if (typeof opts.agentDir !== "string") {
          throw new TypeError(`The "path" argument must be of type string. Received ${typeof opts.agentDir}`);
        }
        if (typeof opts.cwd !== "string") {
          throw new TypeError(`The "path" argument must be of type string. Received ${typeof opts.cwd}`);
        }
      }
      async reload() {}
      getExtensions() { return []; }
    },
    SessionManager: {
      inMemory: (cwd?: string) => {
        calls.SessionManagerInMemory.push({ cwd });
        if (typeof cwd !== "string" && cwd !== undefined) {
          throw new TypeError(`The "path" argument must be of type string. Received ${typeof cwd}`);
        }
        return {};
      },
    },
    SettingsManager: {
      create: (cwd?: string, agentDir?: string) => {
        calls.SettingsManagerCreate.push({ cwd, agentDir });
        if (cwd !== undefined && typeof cwd !== "string") {
          throw new TypeError(`The "path" argument must be of type string. Received ${typeof cwd}`);
        }
        return { reload: vi.fn(async () => {}), getGlobalSettings: () => ({}), getProjectSettings: () => ({}) };
      },
    },
    createAgentSession: async (opts: any) => {
      calls.createAgentSession.push(opts);
      if (typeof opts.cwd !== "string") {
        throw new TypeError(`The "path" argument must be of type string. Received ${typeof opts.cwd}`);
      }
      return { session: mockSession };
    },
    ExtensionAPI: class {},
    parseFrontmatter: (s: string) => ({ frontmatter: {}, body: s }),
    createReadTool: (cwd: string) => ({ name: "read", cwd }),
    createBashTool: (cwd: string) => ({ name: "bash", cwd }),
    createEditTool: (cwd: string) => ({ name: "edit", cwd }),
    createWriteTool: (cwd: string) => ({ name: "write", cwd }),
    createGrepTool: (cwd: string) => ({ name: "grep", cwd }),
    createFindTool: (cwd: string) => ({ name: "find", cwd }),
    createLsTool: (cwd: string) => ({ name: "ls", cwd }),
  };
});

// Mock pi-ai
vi.mock("@mariozechner/pi-ai", () => ({}));

// Mock internal modules that do I/O
vi.mock("../env.js", () => ({
  detectEnv: async (pi: any, cwd: string) => {
    calls.detectEnv.push({ cwd });
    if (typeof cwd !== "string") {
      throw new TypeError(`cwd must be a string, got ${typeof cwd}`);
    }
    return { isGitRepo: false, branch: "", platform: "darwin" };
  },
}));

vi.mock("../skill-loader.js", () => ({
  preloadSkills: (names: string[], cwd: string) => {
    calls.preloadSkills.push({ names, cwd });
    return [];
  },
}));

vi.mock("../memory.js", () => ({
  buildMemoryBlock: () => "",
  buildReadOnlyMemoryBlock: () => "",
  isUnsafeName: () => false,
  safeReadFile: () => undefined,
}));

vi.mock("../agent-types.js", () => ({
  getAgentConfig: () => undefined,
  getConfig: () => ({
    displayName: "Explore",
    description: "test",
    builtinToolNames: ["read", "bash"],
    extensions: true,
    skills: true,
    promptMode: "replace",
  }),
  getToolsForType: (type: string, cwd: string) => {
    calls.getToolsForType.push({ type, cwd });
    if (typeof cwd !== "string") {
      throw new TypeError(`cwd must be a string, got ${typeof cwd}`);
    }
    return ["read", "bash"];
  },
  getMemoryTools: () => [],
  getReadOnlyMemoryTools: () => [],
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
}));

vi.mock("../prompts.js", () => ({
  buildAgentPrompt: (config: any, cwd: string) => {
    calls.buildAgentPrompt.push({ cwd });
    if (typeof cwd !== "string") {
      throw new TypeError(`cwd must be a string, got ${typeof cwd}`);
    }
    return "system prompt";
  },
}));

vi.mock("../context.js", () => ({
  buildParentContext: () => [],
  extractText: (content: any) => typeof content === "string" ? content : "",
}));

// --- Helpers ---

function makeCtx(cwd: string): any {
  return {
    cwd,
    model: { provider: "test", id: "test-model" },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
    },
    getSystemPrompt: () => "parent system prompt",
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

function makePi(): any {
  return {
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
  };
}

// --- Tests ---

describe("agent-runner path safety", () => {
  beforeEach(() => {
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
      calls[key] = [];
    }
  });

  it("passes valid cwd to all path-dependent functions", async () => {
    const { runAgent } = await import("../agent-runner.js");
    const ctx = makeCtx("/Users/test/project");
    const pi = makePi();

    await runAgent(ctx, "Explore", "test prompt", { pi });

    // DefaultResourceLoader should get cwd + agentDir as strings
    expect(calls.DefaultResourceLoader.length).toBeGreaterThan(0);
    const loaderOpts = calls.DefaultResourceLoader[0];
    expect(loaderOpts.cwd).toBe("/Users/test/project");
    expect(loaderOpts.agentDir).toBe(join(homedir(), ".pi", "agent"));
    expect(typeof loaderOpts.cwd).toBe("string");
    expect(typeof loaderOpts.agentDir).toBe("string");

    // SettingsManager.create should get cwd as string
    expect(calls.SettingsManagerCreate.length).toBeGreaterThan(0);
    const smOpts = calls.SettingsManagerCreate[0];
    expect(typeof smOpts.cwd).toBe("string");

    // SessionManager.inMemory should get cwd as string
    expect(calls.SessionManagerInMemory.length).toBeGreaterThan(0);
    expect(typeof calls.SessionManagerInMemory[0].cwd).toBe("string");

    // createAgentSession should get cwd as string
    expect(calls.createAgentSession.length).toBeGreaterThan(0);
    expect(typeof calls.createAgentSession[0].cwd).toBe("string");

    // detectEnv should get cwd as string
    expect(calls.detectEnv.length).toBeGreaterThan(0);
    expect(typeof calls.detectEnv[0].cwd).toBe("string");

    // getToolsForType should get cwd as string
    expect(calls.getToolsForType.length).toBeGreaterThan(0);
    expect(typeof calls.getToolsForType[0].cwd).toBe("string");

    // buildAgentPrompt should get cwd as string
    expect(calls.buildAgentPrompt.length).toBeGreaterThan(0);
    expect(typeof calls.buildAgentPrompt[0].cwd).toBe("string");
  });

  it("activates tools by name instead of passing tool objects to createAgentSession", async () => {
    const { runAgent } = await import("../agent-runner.js");
    const ctx = makeCtx("/Users/test/project");
    const pi = makePi();

    await runAgent(ctx, "Explore", "test prompt", { pi });

    const sessionOpts = calls.createAgentSession[0];
    expect(sessionOpts.tools).toBeUndefined();
    expect(sessionOpts.noTools).toBe("builtin");
    expect(calls.setActiveToolsByName[0]).toEqual(["read", "bash", "ext_tool"]);
    expect(calls.setActiveToolsByName[0].every((name: unknown) => typeof name === "string")).toBe(true);
  });

  it("uses options.cwd when provided (worktree isolation)", async () => {
    const { runAgent } = await import("../agent-runner.js");
    const ctx = makeCtx("/Users/test/project");
    const pi = makePi();
    const worktreeCwd = "/tmp/worktree-abc123";

    await runAgent(ctx, "Explore", "test prompt", { pi, cwd: worktreeCwd });

    // All path calls should use the worktree cwd, not ctx.cwd
    expect(calls.DefaultResourceLoader[0].cwd).toBe(worktreeCwd);
    expect(calls.detectEnv[0].cwd).toBe(worktreeCwd);
    expect(calls.getToolsForType[0].cwd).toBe(worktreeCwd);
    expect(calls.buildAgentPrompt[0].cwd).toBe(worktreeCwd);
  });

  it("passes cwd to SettingsManager.create()", async () => {
    const { runAgent } = await import("../agent-runner.js");
    const ctx = makeCtx("/Users/test/workspace");
    const pi = makePi();

    await runAgent(ctx, "general-purpose", "do stuff", { pi });

    // SettingsManager.create() must receive cwd
    const smCall = calls.SettingsManagerCreate[0];
    expect(smCall.cwd).toBe("/Users/test/workspace");
  });

  it("never passes undefined to any path-dependent call", async () => {
    const { runAgent } = await import("../agent-runner.js");
    const ctx = makeCtx("/valid/path");
    const pi = makePi();

    await runAgent(ctx, "Plan", "plan something", { pi, isolated: true });

    // Check no call received undefined for cwd
    for (const loaderCall of calls.DefaultResourceLoader) {
      expect(loaderCall.cwd).not.toBeUndefined();
      expect(loaderCall.agentDir).not.toBeUndefined();
    }
    for (const smCall of calls.SettingsManagerCreate) {
      expect(smCall.cwd).not.toBeUndefined();
    }
    for (const sessCall of calls.SessionManagerInMemory) {
      expect(sessCall.cwd).not.toBeUndefined();
    }
    for (const envCall of calls.detectEnv) {
      expect(envCall.cwd).not.toBeUndefined();
    }
  });
});
