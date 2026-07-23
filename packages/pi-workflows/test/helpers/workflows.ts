import type { CompiledWorkflow, WorkflowDefinition, WorkflowSource } from "../../src/types.js";
import { compileWorkflow, type WorkflowDefinitionEntry } from "../../src/validation/compiler.js";

export function compilePlans(definitions: WorkflowDefinition[], root = process.cwd()): Map<string, CompiledWorkflow> {
  const entries = new Map<string, WorkflowDefinitionEntry>(definitions.map((definition) => [
    definition.id,
    { definition, source: source(definition.id, root) },
  ]));
  return new Map([...entries].map(([id, entry]) => {
    const result = compileWorkflow(entry, entries);
    if (!result.plan) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
    return [id, result.plan];
  }));
}

export function workflow(
  id: string,
  steps: WorkflowDefinition["steps"],
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return { version: 1, id, steps, ...extra };
}

function source(id: string, root: string): WorkflowSource {
  const path = `${root}/.pi/workflows/${id}.yaml`;
  return { scope: "project", path, canonicalPath: path };
}
