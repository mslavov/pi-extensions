import { describe, expect, test } from "vitest";
import { parseWorkflowYaml } from "../../src/schema.js";

describe("workflow v1 schema", () => {
  test("accepts typed inputs and every step discriminator with applicable controls", () => {
    const result = parseWorkflowYaml(`
version: 1
id: complete
cwd: .
inputs:
  text: { type: string, required: true }
  count: { type: number, default: 2 }
  enabled: { type: boolean, default: false }
  config: { type: json, default: { mode: safe } }
steps:
  - id: ask
    type: agent
    prompt: inspect
    timeoutMs: 10
    continueOnError: false
  - id: run
    type: run
    command: tool
    args: [inspect]
    idempotent: true
    retry: { maxAttempts: 2, delayMs: 1 }
  - id: shell
    type: shell
    command: echo ok
  - id: script
    type: script
    interpreter: node
    file: script.js
  - id: set
    type: set
    values: { ready: true }
  - id: approve
    type: approval
    message: Continue?
    timeoutMs: 10
  - id: nested
    type: workflow
    workflow: child
    inputs: { value: x }
    continueOnError: true
outputs:
  done: true
`, "complete.yaml");

    expect(result.diagnostics).toEqual([]);
    expect(result.definition?.steps.map((step) => step.type)).toEqual([
      "agent", "run", "shell", "script", "set", "approval", "workflow",
    ]);
  });

  test("rejects unknown and inapplicable fields at their YAML source location", () => {
    const result = parseWorkflowYaml(`version: 1
id: invalid
steps:
  - id: assign
    type: set
    values: { ready: true }
    timeoutMs: 10
`, "invalid.yaml");

    expect(result.definition).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "schema-unknown-field",
      message: "Unknown field \"timeoutMs\"",
      source: "invalid.yaml",
      line: 7,
      column: 16,
    }));
  });

  test("rejects a default that does not match its declared input type", () => {
    const result = parseWorkflowYaml(`
version: 1
id: invalid-default
inputs:
  count:
    type: number
    default: many
steps:
  - id: done
    type: set
    values: { ok: true }
`, "input.yaml");

    expect(result.definition).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "schema-type",
      path: "inputs.count.default",
    }));
  });

  test("rejects malformed YAML with line and column diagnostics", () => {
    const result = parseWorkflowYaml("version: 1\nid: [\n", "broken.yaml");
    expect(result.definition).toBeUndefined();
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({
      code: "yaml-parse",
      source: "broken.yaml",
      line: expect.any(Number),
      column: expect.any(Number),
    }));
  });
});
