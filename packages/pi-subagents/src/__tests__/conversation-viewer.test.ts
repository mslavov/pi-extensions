import { describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../types.js";
import { ConversationViewer } from "../ui/conversation-viewer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeSession() {
  return {
    messages: [],
    subscribe: vi.fn(() => vi.fn()),
  } as any;
}

function makeTui() {
  return {
    terminal: { rows: 24 },
    requestRender: vi.fn(),
  } as any;
}

function makeRecord(): AgentRecord {
  return {
    id: "agent-1",
    type: "Explore",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
  };
}

describe("ConversationViewer stop controls", () => {
  it("stops the current agent with s", () => {
    const record = makeRecord();
    const tui = makeTui();
    const stopAgent = vi.fn(() => {
      record.status = "stopped";
      return true;
    });

    const viewer = new ConversationViewer(tui, makeSession(), record, undefined, theme, vi.fn(), { stopAgent });

    viewer.handleInput("s");

    expect(stopAgent).toHaveBeenCalledWith("agent-1");
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("stops all agents and closes on escape", () => {
    const done = vi.fn();
    const stopAll = vi.fn(() => 2);
    const viewer = new ConversationViewer(makeTui(), makeSession(), makeRecord(), undefined, theme, done, { stopAll });

    viewer.handleInput("\x1b");

    expect(stopAll).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("closes without stopping on q", () => {
    const done = vi.fn();
    const stopAll = vi.fn(() => 1);
    const viewer = new ConversationViewer(makeTui(), makeSession(), makeRecord(), undefined, theme, done, { stopAll });

    viewer.handleInput("q");

    expect(stopAll).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(undefined);
  });
});
