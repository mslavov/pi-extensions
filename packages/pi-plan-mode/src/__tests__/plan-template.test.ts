import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../plan-template.html"), "utf-8");

describe("implementation plan starter", () => {
  it("is a standalone responsive script-free document", () => {
    expect(template.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
    expect(template).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(template).toContain("@media (max-width: 880px)");
    expect(template).toContain("@media print");
    expect(template).not.toMatch(/<script\b/i);
    expect(template).not.toMatch(/<link\b/i);
    expect(template).not.toMatch(/<img\b/i);
    expect(template).not.toMatch(/https?:\/\//i);
  });

  it("provides the stable implementation-plan content spine", () => {
    const headings = [
      ">Summary</h2>",
      ">Recommended changes</h2>",
      ">Implementation tasks</h2>",
      ">Verification</h2>",
      ">Decisions and assumptions</h2>",
    ];

    for (const heading of headings) expect(template).toContain(heading);
    for (let index = 1; index < headings.length; index += 1) {
      expect(template.indexOf(headings[index])).toBeGreaterThan(template.indexOf(headings[index - 1]));
    }
    expect(template.match(/>Implementation tasks<\/h2>/g)).toHaveLength(1);
  });

  it("contains visible author guidance, placeholders, and reusable visual primitives", () => {
    expect(template).toContain("Template guidance:");
    expect(template).toContain("Replace every double-bracket placeholder before review");
    expect(template).toContain("remove optional or example content that does not apply");
    expect(template).toContain("remove this guidance note");
    expect(template).toContain("[[Replace with plan title]]");
    expect(template.match(/\[\[Replace/g)?.length).toBeGreaterThan(20);
    expect(template).toContain(".card, .task, .decision");
    expect(template).toContain(".callout");
    expect(template).toContain(".table-wrap");
    expect(template).toContain(".tasks");
    expect(template).toContain("grid-template-columns: 1.1fr 1fr 0.9fr;");
    expect(template).toContain("--paper:");
    expect(template).toContain("--ink:");
    expect(template).toContain("--accent:");
  });

  it("makes the optional inline SVG accessible and removable", () => {
    expect(template).toContain('role="img"');
    expect(template).toContain('aria-labelledby="plan-diagram-title plan-diagram-desc"');
    expect(template).toContain('<title id="plan-diagram-title">');
    expect(template).toContain('<desc id="plan-diagram-desc">');
    expect(template).toContain("Remove this section when prose or a table is clearer.");
    expect(template).toContain('class="skip-link"');
    expect(template).toContain('<caption>');
    expect(template).toContain('scope="col"');
  });

  it("contains no hidden machine task metadata", () => {
    expect(template).not.toMatch(/type=["']application\/(?:json|ld\+json)["']/i);
    expect(template).not.toMatch(/\s+hidden(?:\s|=|>)/i);
    expect(template).not.toMatch(/data-(?:task|bead|dependency|metadata)=/i);
  });
});
