import { describe, expect, it } from "vitest";

import { formatModelInfoParts } from "../ui/agent-widget.js";

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
