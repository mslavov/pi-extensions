import { describe, expect, it } from "vitest";

import { DEFAULT_AGENTS } from "../default-agents.js";
import { DEFAULT_AGENT_NAMES } from "../types.js";

describe("default agents", () => {
  it("asks Explore for planning context bundles", () => {
    const explore = DEFAULT_AGENTS.get("Explore");

    expect(explore?.systemPrompt).toContain("context bundle");
    expect(explore?.systemPrompt).toContain("Files, functions, classes, and line numbers");
    expect(explore?.systemPrompt).toContain("CLI/search/read operations");
    expect(explore?.systemPrompt).toContain("Dead ends and irrelevant areas");
    expect(explore?.systemPrompt).toContain("open questions");
    expect(explore?.systemPrompt).toContain("CRITICAL: READ-ONLY MODE");
  });

  it("registers PlanWriter as a write-capable plan author", () => {
    const planWriter = DEFAULT_AGENTS.get("PlanWriter");

    expect(DEFAULT_AGENT_NAMES).toContain("PlanWriter");
    expect(planWriter).toBeDefined();
    expect(planWriter?.model).toBe("high");
    expect(planWriter?.builtinToolNames).toEqual(expect.arrayContaining(["read", "write", "edit", "grep", "find", "ls"]));
    expect(planWriter?.builtinToolNames).not.toContain("bash");
    expect(planWriter?.extensions).toBe(false);
    expect(planWriter?.skills).toBe(true);
    expect(planWriter?.systemPrompt).toContain("ONLY the plan HTML file path");
    expect(planWriter?.systemPrompt).toContain("Do not mutate Beads");
  });
});
