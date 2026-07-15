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

  it("registers Plan as the write-capable plan author", () => {
    const plan = DEFAULT_AGENTS.get("Plan");

    expect(DEFAULT_AGENT_NAMES).toContain("Plan");
    expect(DEFAULT_AGENT_NAMES).not.toContain("PlanWriter");
    expect(plan).toBeDefined();
    expect(plan?.model).toBe("high");
    expect(plan?.builtinToolNames).toEqual(["read", "write", "edit", "grep", "find", "ls"]);
    expect(plan?.builtinToolNames).not.toContain("bash");
    expect(plan?.extensions).toBe(false);
    expect(plan?.skills).toBe(true);
    expect(plan?.isolated).toBe(false);
    expect(plan?.systemPrompt).toContain("write or edit ONLY that file");
    expect(plan?.systemPrompt).toContain("When no artifact path is supplied, remain read-only");
    expect(plan?.systemPrompt).toContain("Do not mutate Beads");
    expect(plan?.systemPrompt).toContain("caller's artifact contract is authoritative");
    expect(plan?.systemPrompt).toContain("Add diagrams");
    expect(plan?.systemPrompt).not.toContain("Include at least one useful inline SVG diagram");
  });

  it("requires Plan to refine populated starter artifacts", () => {
    const prompt = DEFAULT_AGENTS.get("Plan")?.systemPrompt;

    expect(prompt).toContain("read that artifact before planning or editing");
    expect(prompt).toContain("preserve and refine its starter visual system");
    expect(prompt).toContain("adapt or remove irrelevant optional sections");
    expect(prompt).toContain("replace every visible starter placeholder before completion");
  });

  it("requires Plan to discover visualization skills for complex work", () => {
    const prompt = DEFAULT_AGENTS.get("Plan")?.systemPrompt;

    expect(prompt).toContain("multi-component work");
    expect(prompt).toContain("stateful or state-transition work");
    expect(prompt).toContain("asynchronous handoffs");
    expect(prompt).toContain("security boundaries");
    expect(prompt).toContain("migrations");
    expect(prompt).toContain("nontrivial dependency work");
    expect(prompt).toContain("proactively inspect the available skills");
    expect(prompt).toContain("load the most relevant available diagram or visualization skill before drawing");
    expect(prompt).toContain("Do not assume a named skill exists");
    expect(prompt).toContain("diagram-design is one example when available");
  });

  it("requires accessible diagrams only when they improve the plan", () => {
    const prompt = DEFAULT_AGENTS.get("Plan")?.systemPrompt;

    expect(prompt).toContain("For simple work, explicitly omit diagrams when prose or a table is clearer");
    expect(prompt).toContain("Keep final diagrams focused");
    expect(prompt).toContain('role="img"');
    expect(prompt).toContain("aria-labelledby referencing a <title> and <desc>");
    expect(prompt).toContain("readable labels and contrast");
    expect(prompt).toContain("meaning does not rely on color alone");
  });
});
