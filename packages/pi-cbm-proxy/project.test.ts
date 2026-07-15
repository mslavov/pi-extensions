import { describe, expect, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateAutoIndexPath } from "./src/domain/auto-index-paths";
import { ProjectService, type CbmProject } from "./src/domain/project";
import { registerLifecycle } from "./src/extension/lifecycle";
import { createCbmProxyToolDefinition } from "./src/pi-tools/proxy";

function workspacePath(...parts: string[]): string {
  return join(homedir(), "workspace", ...parts);
}

function createProjectService(cwdRoot: string, projects: CbmProject[]) {
  return new ProjectService(
    {
      gitRoot: async () => cwdRoot,
      findGitRoot: async () => undefined,
      callTool: async (toolName: string) => {
        if (toolName !== "list_projects") throw new Error(`unexpected tool: ${toolName}`);
        return { ok: true, data: { projects }, rawText: "", stderr: "" };
      },
    } as never,
    { autoIndexNonGitDirectories: true },
  );
}

describe("workspace root protection", () => {
  test("refuses to auto-index the workspace container", () => {
    const result = validateAutoIndexPath(workspacePath());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("workspace");
  });

  test("allows auto-indexing children of the workspace container", () => {
    const child = workspacePath("pi-extensions");

    expect(validateAutoIndexPath(child)).toEqual({ ok: true, path: resolve(child) });
  });

  test("refuses paths outside workspace children", () => {
    const result = validateAutoIndexPath(join(homedir(), "other-project"));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("workspace");
  });

  test("does not infer the workspace container project from the workspace cwd", async () => {
    const workspace = workspacePath();
    const service = createProjectService(workspace, [
      { name: "Users-milkoslavov-workspace", root_path: workspace },
      { name: "Users-milkoslavov-workspace-pi-extensions", root_path: workspacePath("pi-extensions") },
    ]);

    await expect(service.inferProject(workspace)).rejects.toThrow("workspace");
  });

  test("infers a child workspace project from inside that project", async () => {
    const child = workspacePath("pi-extensions");
    const service = createProjectService(child, [
      { name: "Users-milkoslavov-workspace", root_path: workspacePath() },
      { name: "Users-milkoslavov-workspace-pi-extensions", root_path: child },
    ]);

    await expect(service.inferProject(child)).resolves.toBe("Users-milkoslavov-workspace-pi-extensions");
  });
});

describe("codebase-memory statusbar", () => {
  test("shows idx while indexing and on after indexing completes", async () => {
    const status: string[] = [];
    let finishIndexing!: () => void;
    const events = registerLifecycleForTest({
      projects: {
        indexCurrentRepo: () =>
          new Promise((resolve) => {
            finishIndexing = () => resolve({ status: "indexed", project: "ready", data: {} });
          }),
      },
    });

    events.session_start?.({}, createContext(status));

    expect(status.at(-1)).toBe("cbm: idx");

    finishIndexing();
    await waitForLifecycle();

    expect(status.at(-1)).toBe("cbm: on");
    events.session_shutdown?.({}, createContext(status));
  });

  test("shows off when indexing is skipped", async () => {
    const status: string[] = [];
    const events = registerLifecycleForTest({
      projects: {
        indexCurrentRepo: async () => ({ status: "skipped", reason: "workspace root" }),
      },
    });

    events.session_start?.({}, createContext(status));
    await waitForLifecycle();

    expect(status.at(-1)).toBe("cbm: off");
    events.session_shutdown?.({}, createContext(status));
  });

  test("shows on when another session already owns the index", async () => {
    const status: string[] = [];
    const events = registerLifecycleForTest({
      projects: {
        indexCurrentRepo: async () => ({ status: "deduplicated", reason: "already indexing" }),
      },
    });

    events.session_start?.({}, createContext(status));
    await waitForLifecycle();

    expect(status.at(-1)).toBe("cbm: on");
    events.session_shutdown?.({}, createContext(status));
  });

  test("does not schedule periodic reindexing", async () => {
    const interval = spyOn(globalThis, "setInterval");
    const status: string[] = [];
    const events = registerLifecycleForTest({
      projects: {
        indexCurrentRepo: async () => ({ status: "indexed", project: "ready", data: {} }),
      },
    });

    try {
      events.session_start?.({}, createContext(status));
      await waitForLifecycle();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      events.session_shutdown?.({}, createContext(status));
      interval.mockRestore();
    }
  });
});

describe("auto-index locking", () => {
  test("deduplicates concurrent indexes for the same repository", async () => {
    const root = workspacePath(`cbm-lock-${process.pid}-${Date.now()}`);
    let indexCalls = 0;
    let finishIndexing!: () => void;
    const firstStarted = Promise.withResolvers<void>();
    const cbm = {
      findGitRoot: async () => root,
      callTool: async (toolName: string) => {
        if (toolName !== "index_repository") throw new Error(`unexpected tool: ${toolName}`);
        indexCalls += 1;
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          finishIndexing = resolve;
        });
        return { ok: true, data: { project: "locked" }, rawText: "", stderr: "" };
      },
    } as never;
    const settings = { autoIndexNonGitDirectories: true };
    const firstService = new ProjectService(cbm, settings);
    const secondService = new ProjectService(cbm, settings);

    const first = firstService.indexCurrentRepo(root);
    await firstStarted.promise;
    const second = await secondService.indexCurrentRepo(root);

    expect(second).toEqual({ status: "deduplicated", reason: "another Pi session is already indexing this repository" });
    expect(indexCalls).toBe(1);

    finishIndexing();
    await expect(first).resolves.toMatchObject({ status: "indexed", project: "locked" });
  });
});

describe("cbm proxy errors", () => {
  test("includes a command description only on its first failure in a session", async () => {
    const proxy = createCbmProxyToolDefinition();
    const services = {
      query: {
        queryGraph: async () => {
          throw new Error("query is required");
        },
      },
    } as never;
    const messages: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await proxy.execute({ action: "call", command: "query_graph", args: "{}" }, services, { cwd: process.cwd() });
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("query is required");
    expect(messages[0]).toContain("Command description:");
    expect(messages[0]).toContain('"command": "query_graph"');
    expect(messages[0]).toContain('"input_schema"');
    expect(messages[1]).toBe("query is required");
  });
});

function registerLifecycleForTest(services: Record<string, unknown>) {
  const events: Record<string, (event: unknown, ctx: ReturnType<typeof createContext>) => void> = {};
  registerLifecycle(
    {
      on(name: string, handler: (event: unknown, ctx: ReturnType<typeof createContext>) => void) {
        events[name] = handler;
      },
    } as never,
    {
      settings: { reload() {} },
      stats: {
        startSession() {},
        endSession() {},
        recordToolStart() {},
        recordToolEnd() {},
        recordAugmentation() {},
      },
      augment: { augmentResult: async () => ({ status: "skipped", reason: "test" }) },
      ...services,
    } as never,
  );
  return events;
}

function createContext(status: string[]) {
  return {
    cwd: workspacePath("pi-extensions"),
    ui: {
      setStatus(_key: string, text: string | undefined) {
        if (text) status.push(text);
      },
    },
  };
}

async function waitForLifecycle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
