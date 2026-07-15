import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { AgentWidget, formatModelInfoParts, type UICtx } from "../ui/agent-widget.js";

describe("formatModelInfoParts", () => {
  it("returns no parts without model info", () => {
    expect(formatModelInfoParts()).toEqual([]);
  });

  it("renders agent and selected values in order", () => {
    expect(formatModelInfoParts({ agent: "auto", selected: "openai-codex/gpt-5.5" })).toEqual([
      "agent: auto",
      "selected: openai-codex/gpt-5.5",
    ]);
  });

  it("renders agent, override, and selected values in order", () => {
    expect(formatModelInfoParts({
      agent: "auto",
      override: "medium",
      selected: "openai-codex/gpt-5.5",
    })).toEqual([
      "agent: auto",
      "override: medium",
      "selected: openai-codex/gpt-5.5",
    ]);
  });
});

describe("AgentWidget navigator hint", () => {
  it("shows the shortcut when it fits and remains width-safe when it does not", () => {
    const manager = {
      listAgents: () => [{
        id: "agent-1",
        type: "general-purpose",
        status: "running",
        description: "test",
        toolUses: 0,
        startedAt: Date.now(),
      }],
    };
    let factory: any;
    const ui: UICtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn((_key, content) => { factory = content; }),
    };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const widget = new AgentWidget(manager as any, new Map(), "Alt+A");
    widget.setUICtx(ui);
    widget.update();

    const wide = factory({ terminal: { columns: 80 } }, theme).render();
    expect(wide[0]).toContain("Alt+A open");
    expect(wide.every((line: string) => visibleWidth(line) <= 80)).toBe(true);

    const narrow = factory({ terminal: { columns: 12 } }, theme).render();
    expect(narrow[0]).not.toContain("Alt+A");
    expect(narrow.every((line: string) => visibleWidth(line) <= 12)).toBe(true);
    widget.dispose();
  });
});
