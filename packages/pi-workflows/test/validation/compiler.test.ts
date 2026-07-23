import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowSource } from "../../src/types.js";
import { compileWorkflow, type WorkflowDefinitionEntry } from "../../src/validation/compiler.js";

describe("workflow compiler validation", () => {
  test("preserves exact JSON references and rejects JSON string interpolation", () => {
    const exact = workflow("exact", [{ id: "set", type: "set", values: { config: "${{ inputs.config }}" } }], {
      inputs: { config: { type: "json", required: true } },
    });
    const exactResult = compile(exact);
    expect(exactResult.diagnostics).toEqual([]);
    expect(exactResult.plan?.steps[0].references[0]).toMatchObject({ exact: true, valueKind: "json" });

    const interpolated = workflow("mixed", [{
      id: "set",
      type: "set",
      values: { config: "config=${{ inputs.config }}" },
    }], { inputs: { config: { type: "json", required: true } } });
    expect(compile(interpolated).diagnostics).toContainEqual(expect.objectContaining({
      code: "reference-interpolation-type",
    }));
  });

  test("allows only prior step references and marks skipped output resolution as an error rule", () => {
    const valid = workflow("prior", [
      { id: "collect", type: "run", command: "tool", if: false },
      { id: "save", type: "set", values: { text: "${{ steps.collect.output.stdout }}" } },
    ]);
    const result = compile(valid);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps[1].references[0]).toMatchObject({
      expression: "steps.collect.output.stdout",
      skippedOutput: "error",
    });

    const forward = workflow("forward", [
      { id: "first", type: "set", values: { value: "${{ steps.later.status }}" } },
      { id: "later", type: "set", values: { value: true } },
    ]);
    expect(compile(forward).diagnostics).toContainEqual(expect.objectContaining({
      code: "reference-step-order",
    }));
  });

  test("validates static nested IDs, cycles, and depth", () => {
    const missing = workflow("root", [{ id: "nested", type: "workflow", workflow: "absent" }]);
    expect(compile(missing).diagnostics).toContainEqual(expect.objectContaining({ code: "workflow-missing" }));

    const a = workflow("a", [{ id: "b", type: "workflow", workflow: "b" }]);
    const b = workflow("b", [{ id: "a", type: "workflow", workflow: "a" }]);
    expect(compile(a, [a, b]).diagnostics).toContainEqual(expect.objectContaining({ code: "workflow-cycle" }));

    const chain = Array.from({ length: 4 }, (_, index) => workflow(
      `depth-${index}`,
      index === 3 ? [{ id: "done", type: "set", values: { ok: true } }] : [{
        id: "next",
        type: "workflow",
        workflow: `depth-${index + 1}`,
      }],
    ));
    const entries = entryMap(chain);
    const depthResult = compileWorkflow(entries.get("depth-0")!, entries, { maxDepth: 3 });
    expect(depthResult.diagnostics).toContainEqual(expect.objectContaining({ code: "workflow-depth" }));
  });

  test("enforces cwd bases and lowers script while retaining source metadata", () => {
    const definition = workflow("script", [{
      id: "execute",
      type: "script",
      interpreter: "node",
      file: "scripts/check.js",
      cwd: "tools",
      args: ["--json"],
    }], { cwd: "workspace" });
    const result = compile(definition);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.cwd).toEqual({ base: "invocation", value: "workspace", dynamic: false });
    expect(result.plan?.steps[0]).toMatchObject({
      type: "script",
      sourceKind: "script",
      cwd: { base: "workflow", value: "tools", dynamic: false },
      script: {
        interpreter: "node",
        file: { base: "step", value: "scripts/check.js", dynamic: false },
      },
      definition: { type: "run", command: "node", args: ["scripts/check.js", "--json"] },
    });

    const escape = workflow("escape", [{ id: "run", type: "run", command: "tool", cwd: "../outside" }]);
    expect(compile(escape).diagnostics).toContainEqual(expect.objectContaining({ code: "path-escape" }));
  });

  test("requires idempotence and enforces the process retry ceiling", () => {
    const definition = workflow("retry", [{
      id: "run",
      type: "run",
      command: "tool",
      retry: { maxAttempts: 4 },
    }]);
    expect(compile(definition).diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "retry-idempotent",
      "retry-limit",
    ]));
  });
});

function workflow(
  id: string,
  steps: WorkflowDefinition["steps"],
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return { version: 1, id, steps, ...extra };
}

function source(id: string): WorkflowSource {
  return { scope: "project", path: `/project/.pi/workflows/${id}.yaml`, canonicalPath: `/project/.pi/workflows/${id}.yaml` };
}

function entryMap(definitions: WorkflowDefinition[]): Map<string, WorkflowDefinitionEntry> {
  return new Map(definitions.map((definition) => [definition.id, { definition, source: source(definition.id) }]));
}

function compile(definition: WorkflowDefinition, all: WorkflowDefinition[] = [definition]) {
  return compileWorkflow({ definition, source: source(definition.id) }, entryMap(all));
}
