import { describe, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { createPiWorkflowsExtension } from "../../src/index.js";
import type {
  WorkflowChildSession,
  WorkflowChildSessionFactory,
} from "../../src/runtime/child-session.js";

describe("feasibility surfaces", () => {
  test("the extension authoring command uses the shared child-session contract and disposes once", async () => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const child = fakeChild();
    const factory = vi.fn(async () => child) as WorkflowChildSessionFactory;
    createPiWorkflowsExtension(factory)({
      registerCommand(name: string, command: { handler: typeof handler }) {
        if (name === "workflow") handler = command.handler;
      },
      registerTool: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as never);
    const select = vi.fn(async () => "Project workflow");

    await handler?.("create Make a reusable check", {
      cwd: "/extension-cwd",
      hasUI: true,
      sessionManager: { getSessionId: () => "parent-session" },
      ui: {
        select,
        input: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    });

    await vi.waitFor(() => expect(factory).toHaveBeenCalledWith({ cwd: "/extension-cwd" }));

    expect(child.session.prompt).toHaveBeenCalledWith(expect.stringContaining("workflow-authoring/SKILL.md"));
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  test("the CLI inspect command uses the shared child-session contract and disposes once", async () => {
    const output: string[] = [];
    const child = fakeChild();
    const factory = vi.fn(async () => child) as WorkflowChildSessionFactory;

    const code = await runCli(
      ["inspect", "--cwd", ".", "--agent-dir", ".pi-test-agent"],
      { stdout: (text) => output.push(text), stderr: (text) => output.push(text) },
      factory,
    );

    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledOnce();
    expect(JSON.parse(output.join(""))).toMatchObject({ extensionCount: 0, sessionFile: null });
    expect(child.dispose).toHaveBeenCalledOnce();
  });
});

function fakeChild(): WorkflowChildSession {
  return {
    session: {
      model: { provider: "test", id: "test" },
      prompt: vi.fn(async () => {}),
    } as never,
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    inspect: () => ({
      activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      allToolSources: [],
      contextFiles: [],
      extensionCount: 0,
      model: null,
      promptCount: 0,
      runtime: { bun: false, name: "node" },
      sessionFile: null,
      skillCount: 0,
    }),
  };
}
