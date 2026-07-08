import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateAutoIndexPath } from "./src/domain/auto-index-paths";
import { ProjectService, type CbmProject } from "./src/domain/project";
import { registerLifecycle } from "./src/extension/lifecycle";

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
