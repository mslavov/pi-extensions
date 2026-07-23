import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.ts"), "utf-8");

describe("plan-mode workflow instructions", () => {
  it("starts plan mode only through the user command", () => {
    expect(source).toContain('pi.registerCommand("plan"');
    expect(source).not.toContain('name: "enter_plan_mode"');
    expect(source).toContain('name: "exit_plan_mode"');
  });

  it("uses strict workflow invariants with adaptive plan content", () => {
    expect(source).toContain("Ground in Evidence");
    expect(source).toContain("Resolve Material Decisions");
    expect(source).toContain("Agent Workflow");
    expect(source).toContain("Implementation tasks");
    expect(source).toContain("canonical **Implementation tasks** heading");
    expect(source).toContain("never target an arbitrary count");
    expect(source).toContain("smallest independently releasable outcome");
    expect(source).toContain("accepted, deferred, or rejected disposition");
    expect(source).toContain("Diagrams are optional");
    expect(source).toContain("exit_plan_mode");
    expect(source).not.toContain("4-10 vertical slices");
    expect(source).not.toContain("Include at least one useful, restrained diagram");
    expect(source).not.toContain('pi.on("agent_end"');
    expect(source).toContain("planAwaitingApproval");
    expect(source).toContain("submittedPlanDigest");
    expect(source).toContain("digestPlan(content) !== submittedPlanDigest");
    expect(source).toContain("The plan has not been submitted for approval");
    expect(source).toContain("systemPrompt: `${event.systemPrompt}");
    expect(source).toContain('msg.customType !== "plan-mode-context"');
  });

  it("recommends cheap exploration and high-effort synthesis without enforcing either", () => {
    expect(source).toContain("Prefer the cheap configuration");
    expect(source).toContain("request a detailed evidence bundle");
    expect(source).toContain("launch one ${PLAN_AGENT}");
    expect(source).toContain("The ${PLAN_AGENT} owns plan synthesis and writes the HTML artifact");
    expect(source).toContain("Write and refine one coherent HTML artifact directly");
    expect(source).not.toContain("PLAN_WRITER_AGENT");
    expect(source).not.toContain("enforcePlanningAgentEffort");
  });

  it("initializes each newly allocated path from the sibling starter without overwriting", () => {
    expect(source).toContain('readFileSync(new URL("./plan-template.html", import.meta.url), "utf-8")');
    expect(source).toContain('writeFileSync(path, PLAN_TEMPLATE, { encoding: "utf-8", flag: "wx" })');
    expect(source).toContain('(error as { code?: string }).code !== "EEXIST"');
    expect(source.match(/allocateInitializedPlanPath\(\)/g)).toHaveLength(4);
    expect(source).toContain("const initializedPlanPath = allocateInitializedPlanPath();");
    expect(source).toContain("if (!planFilePath) planFilePath = allocateInitializedPlanPath();");
    expect(source).not.toContain("generatePlanPath");
  });

  it("directs root planners to refine and finish the starter visual system", () => {
    expect(source).toContain("Read the complete starter before editing it");
    expect(source).toContain("Preserve the starter's paper/ink/accent visual system");
    expect(source).toContain("Replace every visible [[Replace...]] placeholder");
    expect(source).toContain("Adapt or remove every optional or example section");
    expect(source).toContain("Before calling exit_plan_mode, remove every remaining [[Replace...]] placeholder");
    expect(source).toContain("proactively inspect the skills that are actually available");
    expect(source).toContain("multi-component, stateful, async, security-boundary, migration, or dependency-heavy plans");
    expect(source).toContain('focused, accessible inline SVG with role="img"');
    expect(source).toContain("aria-labelledby referencing a <title> and <desc>");
    expect(source).toContain("meaning does not rely on color alone");
    expect(source).toContain("Omit diagrams for simple work when prose or a table is clearer");
    expect(source).toContain("Never invent or invoke an unavailable skill");
  });

  it("supports headless plan approval and refinement controls", () => {
    expect(source).toContain("plan-headless");
    expect(source).toContain("Headless controls");
    expect(source).toContain("plan-approve");
    expect(source).toContain("plan-refine");
    expect(source).toContain("plan-exit");
    expect(source).not.toContain("name: \"approve_plan\"");
  });

  it("supports annotated plan review refinement cycles", () => {
    expect(source).toContain("startPlanReviewServer");
    expect(source).toContain("Opened annotated review UI");
    expect(source).toContain("annotated plan review feedback");
    expect(source).toContain("call exit_plan_mode again");
  });
});
