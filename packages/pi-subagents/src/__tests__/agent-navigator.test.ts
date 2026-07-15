import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager as AppKeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  KeybindingsManager,
  matchesKey,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAgents } from "../agent-types.js";
import type { AgentRecord } from "../types.js";
import {
  AGENT_NAVIGATOR_OVERLAY_OPTIONS,
  AGENT_NAVIGATOR_SHORTCUT,
  AgentNavigator,
  openAgentNavigator,
  registerAgentNavigatorControls,
  type AgentNavigatorActions,
  type AgentNavigatorResult,
} from "../ui/agent-navigator.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function keybindings(): AppKeybindingsManager {
  const manager = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o" },
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
  } as any);
  setKeybindings(manager);
  return manager as unknown as AppKeybindingsManager;
}

function record(
  id: string,
  status: AgentRecord["status"] = "running",
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status,
    toolUses: 0,
    startedAt: Date.now() - (Number(id.replace(/\D/g, "")) || 1) * 1000,
    ...overrides,
  };
}

function sessionWithMessages(messages: AgentMessage[]): AgentSession {
  return {
    messages,
    state: { streamingMessage: undefined, pendingToolCalls: new Set() },
    subscribe: vi.fn(() => vi.fn()),
    settingsManager: {
      getHideThinkingBlock: vi.fn(() => false),
      setHideThinkingBlock: vi.fn(),
      getShowImages: vi.fn(() => false),
      getImageWidthCells: vi.fn(() => 40),
    },
    sessionManager: { getCwd: vi.fn(() => process.cwd()) },
    getToolDefinition: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function createHarness(initialRecords: AgentRecord[], rows = 14, columns = 80) {
  let records = initialRecords;
  const tui = {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  };
  const manager = {
    listAgents: () => records,
    getRecord: (id: string) => records.find((candidate) => candidate.id === id),
  };
  const done = vi.fn<(result: AgentNavigatorResult) => void>();
  const actions: AgentNavigatorActions = {
    stopAgent: vi.fn(() => true),
    steerAgent: vi.fn<AgentNavigatorActions["steerAgent"]>(async () => ({ status: "sent" })),
    onSteered: vi.fn(),
  };
  const navigator = new AgentNavigator(
    tui as any,
    manager,
    new Map(),
    theme,
    keybindings(),
    done,
    actions,
  );
  navigator.focused = true;
  return {
    navigator,
    tui,
    done,
    actions,
    setRecords(next: AgentRecord[]) { records = next; },
  };
}

beforeAll(() => {
  initTheme("dark", false);
});

beforeEach(() => {
  registerAgents(new Map());
});

describe("AgentNavigator", () => {
  it("fills the terminal with width-safe transcript and a bounded scrolling bottom rail", () => {
    const records = Array.from({ length: 7 }, (_, index) => record(`agent-${index + 1}`, index === 0 ? "running" : "completed"));
    const harness = createHarness(records, 12, 48);

    const lines = harness.navigator.render(48);
    const output = lines.join("\n");

    expect(lines).toHaveLength(12);
    expect(lines.every((line) => visibleWidth(line) === 48)).toBe(true);
    expect(output).toContain("Viewing @");
    expect(output).not.toContain("○ main");
    expect(output).toMatch(/[↑↓]\d/);
    harness.navigator.dispose();
  });

  it("keeps close, management, and selected stop as distinct navigation actions", () => {
    const running = record("agent-1");
    const stopHarness = createHarness([running]);

    stopHarness.navigator.handleInput("x");
    expect(stopHarness.actions.stopAgent).toHaveBeenCalledWith(running.id);
    expect(stopHarness.done).not.toHaveBeenCalled();
    stopHarness.navigator.handleInput("q");
    expect(stopHarness.done).toHaveBeenCalledWith("close");
    stopHarness.navigator.dispose();

    const manageHarness = createHarness([record("agent-2")]);
    manageHarness.navigator.handleInput("m");
    expect(manageHarness.done).toHaveBeenCalledWith("manage");
    expect(manageHarness.actions.stopAgent).not.toHaveBeenCalled();
    manageHarness.navigator.dispose();
  });

  it("treats command letters as editable text while steering input is focused", async () => {
    const running = record("agent-1");
    const harness = createHarness([running]);

    harness.navigator.handleInput("\r");
    for (const character of "mxsq") harness.navigator.handleInput(character);
    expect(harness.navigator.render(80).join("\n")).toContain("mxsq");
    expect(harness.actions.stopAgent).not.toHaveBeenCalled();
    expect(harness.done).not.toHaveBeenCalled();

    harness.navigator.handleInput("\r");
    await vi.waitFor(() => {
      expect(harness.actions.steerAgent).toHaveBeenCalledWith(running.id, "mxsq");
    });
    expect(harness.actions.onSteered).toHaveBeenCalledWith(running.id, "mxsq");
    expect(harness.navigator.render(80).join("\n")).not.toContain("mxsq");
    harness.navigator.dispose();
  });

  it("drops an invalidated steering draft and restores navigation commands", () => {
    const running = record("agent-1");
    const harness = createHarness([running]);

    harness.navigator.handleInput("\r");
    for (const character of "draft") harness.navigator.handleInput(character);
    running.status = "completed";
    harness.navigator.render(80);
    expect(harness.navigator.render(80).join("\n")).not.toContain("draft");

    harness.navigator.handleInput("q");
    expect(harness.done).toHaveBeenCalledWith("close");
    harness.navigator.dispose();
  });

  it("falls back safely when the selected record is removed", () => {
    const selected = record("agent-1");
    const remaining = record("agent-2", "completed");
    const harness = createHarness([selected, remaining]);

    harness.setRecords([remaining]);
    const output = harness.navigator.render(80).join("\n");

    expect(output).toContain("agent agent-2");
    expect(output).not.toContain("no longer available");
    harness.navigator.dispose();
  });

  it("clears an input draft before falling back from a removed running agent", async () => {
    const selected = record("agent-1");
    const fallback = record("agent-2");
    const harness = createHarness([selected, fallback]);

    harness.navigator.handleInput("\r");
    for (const character of "private draft") harness.navigator.handleInput(character);
    harness.setRecords([fallback]);
    const output = harness.navigator.render(80).join("\n");

    expect(output).not.toContain("private draft");
    harness.navigator.handleInput("\r");
    harness.navigator.handleInput("\r");
    await Promise.resolve();
    expect(harness.actions.steerAgent).not.toHaveBeenCalled();
    harness.navigator.dispose();
  });

  it.each(["queued", "completed", "steered", "aborted", "stopped", "error"] as const)(
    "renders a useful sessionless %s state",
    (status) => {
      const harness = createHarness([record("agent-1", status)], 8, 44);
      const output = harness.navigator.render(44).join("\n");

      expect(output).toContain(status === "queued" ? "waiting for an execution slot" : `session unavailable (${status})`);
      harness.navigator.dispose();
    },
  );

  it.each([2, 3, 4])("keeps %s-row terminal output bounded", (rows) => {
    const harness = createHarness([record("agent-1")], rows, 12);
    const lines = harness.navigator.render(12);

    expect(lines).toHaveLength(rows);
    expect(lines.every((line) => visibleWidth(line) === 12)).toBe(true);
    harness.navigator.dispose();
  });

  it("does not focus a steering input that cannot be rendered", () => {
    const harness = createHarness([record("agent-1")], 4, 24);

    harness.navigator.handleInput("\r");
    harness.navigator.handleInput("q");

    expect(harness.done).toHaveBeenCalledWith("close");
    expect(harness.actions.steerAgent).not.toHaveBeenCalled();
    harness.navigator.dispose();
  });

  it("scrolls Pi-native transcript content and resumes bottom-follow on End", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const,
      content: `message-${index}`,
      timestamp: index + 1,
    }));
    const running = record("agent-1", "running", { session: sessionWithMessages(messages) });
    const harness = createHarness([running], 10, 60);

    expect(harness.navigator.render(60).join("\n")).toContain("message-11");
    harness.navigator.handleInput("\x1b[H");
    expect(harness.navigator.render(60).join("\n")).toContain("message-0");
    harness.navigator.handleInput("\x1b[F");
    expect(harness.navigator.render(60).join("\n")).toContain("message-11");
    harness.navigator.dispose();
    expect(running.session?.dispose).not.toHaveBeenCalled();
  });

  it("shows an explicit empty state without a synthetic main row", () => {
    const harness = createHarness([]);
    const output = harness.navigator.render(80).join("\n");

    expect(output).toContain("No subagents to show");
    expect(output).not.toContain("○ main");
    harness.navigator.handleInput("q");
    expect(harness.done).toHaveBeenCalledWith("close");
    harness.navigator.dispose();
  });

  it("closes on Escape without invoking selected-agent stop", () => {
    const harness = createHarness([record("agent-1")]);

    harness.navigator.handleInput("\x1b");

    expect(harness.done).toHaveBeenCalledWith("close");
    expect(harness.actions.stopAgent).not.toHaveBeenCalled();
    harness.navigator.dispose();
  });
});

describe("openAgentNavigator", () => {
  it("consumes Escape into the navigator close path and removes the listener", async () => {
    let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
    const unsubscribe = vi.fn();
    const ui = {
      onTerminalInput: vi.fn((handler) => {
        inputHandler = handler;
        return unsubscribe;
      }),
      custom: vi.fn((_factory: any) => new Promise<AgentNavigatorResult>((resolve) => {
        const component = _factory(
          { terminal: { rows: 12, columns: 80 }, requestRender: vi.fn() },
          theme,
          keybindings(),
          resolve,
        );
        component.focused = true;
        queueMicrotask(() => expect(inputHandler?.("\x1b")).toEqual({ consume: true }));
      })),
    };
    const actions: AgentNavigatorActions = {
      stopAgent: vi.fn(() => true),
      steerAgent: vi.fn<AgentNavigatorActions["steerAgent"]>(async () => ({ status: "sent" })),
    };

    await openAgentNavigator({ ui } as unknown as ExtensionContext, {
      manager: { listAgents: () => [record("agent-1")], getRecord: () => record("agent-1") },
      activity: new Map(),
      actions,
      manage: vi.fn(),
    });

    expect(actions.stopAgent).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("lets only the opener perform one management round-trip and reopen", async () => {
    const results: AgentNavigatorResult[] = ["manage", "close"];
    const unsubscribe = vi.fn();
    const ui = {
      onTerminalInput: vi.fn(() => unsubscribe),
      custom: vi.fn(async () => results.shift()),
    };
    const manage = vi.fn(async () => undefined);

    await openAgentNavigator({ ui } as unknown as ExtensionContext, {
      manager: { listAgents: () => [], getRecord: () => undefined },
      activity: new Map(),
      actions: {
        stopAgent: vi.fn(() => false),
        steerAgent: vi.fn<AgentNavigatorActions["steerAgent"]>(async () => ({ status: "sent" })),
      },
      manage,
    });

    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(manage).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});

describe("registerAgentNavigatorControls", () => {
  it("registers /agents and Alt+A with the same opener", async () => {
    let command: any;
    let shortcut: any;
    const pi = {
      registerCommand: vi.fn((_name, options) => { command = options; }),
      registerShortcut: vi.fn((_key, options) => { shortcut = options; }),
    } as unknown as Pick<ExtensionAPI, "registerCommand" | "registerShortcut">;
    const open = vi.fn(async (_ctx: ExtensionContext) => undefined);
    const ctx = {} as ExtensionContext;

    registerAgentNavigatorControls(pi, open);
    await command.handler("", ctx);
    await shortcut.handler(ctx);

    expect(pi.registerCommand).toHaveBeenCalledWith("agents", expect.anything());
    expect(pi.registerShortcut).toHaveBeenCalledWith(AGENT_NAVIGATOR_SHORTCUT, expect.anything());
    expect(matchesKey("\x1ba", AGENT_NAVIGATOR_SHORTCUT)).toBe(true);
    expect(matchesKey("\x1b[97;3u", AGENT_NAVIGATOR_SHORTCUT)).toBe(true);
    expect(open).toHaveBeenNthCalledWith(1, ctx);
    expect(open).toHaveBeenNthCalledWith(2, ctx);
    expect(AGENT_NAVIGATOR_OVERLAY_OPTIONS).toEqual({
      anchor: "top-left",
      width: "100%",
      maxHeight: "100%",
      margin: 0,
    });
  });
});
