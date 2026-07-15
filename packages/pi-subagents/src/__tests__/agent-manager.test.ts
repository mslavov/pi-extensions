import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  steerAgent: vi.fn(),
}));

vi.mock("../agent-runner.js", () => ({
  runAgent: mocks.runAgent,
  resumeAgent: mocks.resumeAgent,
  steerAgent: mocks.steerAgent,
}));

import { AgentManager } from "../agent-manager.js";
import { registerAgents } from "../agent-types.js";

const managers: AgentManager[] = [];

beforeEach(() => {
  registerAgents(new Map());
});

function createManager(): AgentManager {
  const manager = new AgentManager();
  managers.push(manager);
  return manager;
}

function spawnRunning(manager: AgentManager) {
  let options: any;
  let finish!: (value: { responseText: string; session: AgentSession; aborted: boolean; steered: boolean }) => void;
  const completion = new Promise<{ responseText: string; session: AgentSession; aborted: boolean; steered: boolean }>((resolve) => {
    finish = resolve;
  });
  mocks.runAgent.mockImplementationOnce((_ctx, _type, _prompt, nextOptions) => {
    options = nextOptions;
    return completion;
  });

  const id = manager.spawn(
    {} as ExtensionAPI,
    { cwd: process.cwd() } as ExtensionContext,
    "general-purpose",
    "test prompt",
    { description: "test agent", isBackground: true },
  );

  return { id, getOptions: () => options, finish };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.clearAllMocks();
});

describe("AgentManager.steer", () => {
  it("queues before session creation and flushes best-effort when the session arrives", async () => {
    const manager = createManager();
    const run = spawnRunning(manager);

    await expect(manager.steer(run.id, "change direction")).resolves.toEqual({ status: "queued" });
    expect(manager.getRecord(run.id)?.pendingSteers).toEqual(["change direction"]);

    const session = { steer: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } as unknown as AgentSession;
    run.getOptions().onSessionCreated(session);
    await Promise.resolve();

    expect(session.steer).toHaveBeenCalledWith("change direction");
    expect(manager.getRecord(run.id)?.pendingSteers).toBeUndefined();

    run.finish({ responseText: "done", session, aborted: false, steered: false });
    await manager.waitForAll();
  });

  it("contains a queued flush rejection without claiming delivery", async () => {
    const manager = createManager();
    const run = spawnRunning(manager);

    await manager.steer(run.id, "queued message");
    const session = { steer: vi.fn().mockRejectedValue(new Error("flush failed")), dispose: vi.fn() } as unknown as AgentSession;
    run.getOptions().onSessionCreated(session);
    await Promise.resolve();

    expect(session.steer).toHaveBeenCalledWith("queued message");
    expect(manager.getRecord(run.id)?.status).toBe("running");

    run.finish({ responseText: "done", session, aborted: false, steered: false });
    await manager.waitForAll();
  });

  it("does not flush queued steering after the agent is explicitly stopped", async () => {
    const manager = createManager();
    const run = spawnRunning(manager);

    await manager.steer(run.id, "do not deliver");
    expect(manager.abort(run.id)).toBe(true);
    const session = { steer: vi.fn(), dispose: vi.fn() } as unknown as AgentSession;
    run.getOptions().onSessionCreated(session);
    await Promise.resolve();

    expect(session.steer).not.toHaveBeenCalled();
    expect(manager.getRecord(run.id)?.pendingSteers).toBeUndefined();
    expect(manager.getRecord(run.id)?.status).toBe("stopped");

    run.finish({ responseText: "", session, aborted: true, steered: false });
  });

  it("reports immediate sends, failures, and invalid states", async () => {
    const manager = createManager();
    const run = spawnRunning(manager);
    const session = { dispose: vi.fn() } as unknown as AgentSession;
    run.getOptions().onSessionCreated(session);

    mocks.steerAgent.mockResolvedValueOnce(undefined);
    await expect(manager.steer(run.id, "first")).resolves.toEqual({ status: "sent" });
    expect(mocks.steerAgent).toHaveBeenCalledWith(session, "first");

    mocks.steerAgent.mockRejectedValueOnce(new Error("cannot steer"));
    await expect(manager.steer(run.id, "second")).resolves.toEqual({ status: "failed", error: "cannot steer" });

    const record = manager.getRecord(run.id)!;
    record.status = "completed";
    await expect(manager.steer(run.id, "third")).resolves.toEqual({
      status: "rejected",
      reason: `Agent "${run.id}" is not running (status: completed).`,
    });
    await expect(manager.steer("missing", "third")).resolves.toEqual({
      status: "rejected",
      reason: "Agent not found: \"missing\". It may have been cleaned up.",
    });

    run.finish({ responseText: "done", session, aborted: false, steered: false });
    await manager.waitForAll();
  });
});
