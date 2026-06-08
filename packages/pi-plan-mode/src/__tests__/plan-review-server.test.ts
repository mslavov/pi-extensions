import { describe, expect, it } from "vitest";
import { formatPlanReviewFeedback, startPlanReviewServer } from "../plan-review-server.js";

describe("plan review feedback formatting", () => {
  it("formats inline and global comments for plan refinement", () => {
    const feedback = formatPlanReviewFeedback({
      planFilePath: "/tmp/plan.html",
      note: "Overall: simplify the rollout.",
      annotations: [
        {
          id: "a1",
          type: "comment",
          text: "Split this into two independent slices.",
          originalText: "Implement everything in one slice",
          location: "Vertical slices / Tasks to create",
        },
        {
          id: "a2",
          type: "global",
          text: "Add fallback verification.",
          location: "Global",
        },
      ],
    });

    expect(feedback).toContain("Revise the HTML plan at `/tmp/plan.html`");
    expect(feedback).toContain("Overall: simplify the rollout.");
    expect(feedback).toContain("Vertical slices / Tasks to create");
    expect(feedback).toContain("Implement everything in one slice");
    expect(feedback).toContain("Split this into two independent slices.");
    expect(feedback).toContain("Add fallback verification.");
    expect(feedback).toContain("exit_plan_mode");
  });

  it("serves a browser review session and resolves submitted decisions", async () => {
    const server = await startPlanReviewServer({
      planFilePath: "/tmp/plan.html",
      planHtml: "<!doctype html><html><body><h1>Plan</h1></body></html>",
    });

    try {
      const response = await fetch(new URL("/decision", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "refine",
          note: "Please revise this.",
          annotations: [{ id: "a1", type: "comment", text: "Clarify scope.", originalText: "Plan" }],
        }),
      });

      expect(response.ok).toBe(true);
      const decision = await server.waitForDecision();
      expect(decision.action).toBe("refine");
      expect(decision.annotations).toHaveLength(1);
      expect(decision.feedback).toContain("Please revise this.");
      expect(decision.feedback).toContain("Clarify scope.");
    } finally {
      server.stop();
    }
  });
});
