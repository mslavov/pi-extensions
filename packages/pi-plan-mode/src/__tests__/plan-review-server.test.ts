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
          text: "Split this into two independent tasks.",
          originalText: "Implement everything in one task",
          location: "Implementation tasks",
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
    expect(feedback).toContain("Implementation tasks");
    expect(feedback).toContain("Implement everything in one task");
    expect(feedback).toContain("Split this into two independent tasks.");
    expect(feedback).toContain("Add fallback verification.");
    expect(feedback).toContain("exit_plan_mode");
  });

  it("serves the authored plan unchanged in an isolated review wrapper", async () => {
    const planHtml = "<!doctype html><html><body><h1>Plan Café</h1><p>Authored only</p></body></html>";
    const server = await startPlanReviewServer({
      planFilePath: "/tmp/plan.html",
      planHtml,
    });

    try {
      const planResponse = await fetch(new URL("plan", server.url));
      expect(planResponse.ok).toBe(true);
      expect(planResponse.headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
      expect(Buffer.from(await planResponse.arrayBuffer())).toEqual(Buffer.from(planHtml));

      const wrapper = await (await fetch(server.url)).text();
      const planPath = new URL("plan", server.url).pathname;
      expect(wrapper).toContain(`<iframe id="plan" sandbox="allow-same-origin" src="${planPath}"></iframe>`);
      expect(wrapper).not.toContain(planHtml);
      expect(wrapper).toContain("const range = selection.getRangeAt(0).cloneRange();");
      expect(wrapper).toMatch(/function captureSelection\(\) \{\s+const selection = readSelection\(\);\s+if \(!selection\) return;\s+setPending\(selection\);\s+frame\.contentWindow\?\.getSelection\(\)\?\.removeAllRanges\(\);\s+\}/);
      expect(wrapper).toContain("doc?.addEventListener('mouseup', captureSelection);");
      expect(wrapper).toContain("doc?.addEventListener('keyup', captureSelection);");
      expect(wrapper).toContain("mark.style.color = 'inherit';");
    } finally {
      server.stop();
    }
  });

  it("serves a browser review session and resolves submitted decisions", async () => {
    const server = await startPlanReviewServer({
      planFilePath: "/tmp/plan.html",
      planHtml: "<!doctype html><html><body><h1>Plan</h1></body></html>",
    });

    try {
      const response = await fetch(new URL("decision", server.url), {
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
