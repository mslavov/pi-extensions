import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.ts"), "utf-8");

describe("plan-mode workflow instructions", () => {
  it("directs agent-first planning through context bundles, PlanWriter, and vertical slices", () => {
    expect(source).toContain("const PLAN_WRITER_AGENT = \"PlanWriter\"");
    expect(source).toContain("Context Bundles");
    expect(source).toContain("extensive context bundle");
    expect(source).toContain("PlanWriter Draft");
    expect(source).toContain("Vertical Slice Breakdown");
    expect(source).toContain("PlanWriter Finalization");
    expect(source).toContain("dependency graph / DAG");
    expect(source).toContain("one Bead per approved vertical slice");
    expect(source).toContain("independent ready graph branches");
    expect(source).toContain("Vertical slices / Tasks to create");
    expect(source).toContain("get_subagent_result using wait: true");
    expect(source).toContain("exit_plan_mode");
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
