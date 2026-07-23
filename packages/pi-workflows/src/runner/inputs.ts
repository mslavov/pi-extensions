import type { InputDefinition, WorkflowDefinition, WorkflowValue } from "../types.js";
import { WorkflowRuntimeError } from "./types.js";

export function normalizeInputs(
  definition: WorkflowDefinition,
  supplied: Record<string, unknown>,
  path = "inputs",
): Record<string, WorkflowValue> {
  const declared = definition.inputs ?? {};
  for (const name of Object.keys(supplied)) {
    if (!(name in declared)) {
      throw new WorkflowRuntimeError("input-unknown", `Workflow "${definition.id}" has no input named "${name}"`, `${path}.${name}`);
    }
  }

  return Object.fromEntries(Object.entries(declared).map(([name, input]) => {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : input.default;
    if (value === undefined) {
      if (input.required === true) {
        throw new WorkflowRuntimeError("input-required", `Input "${name}" is required`, `${path}.${name}`);
      }
      return [name, null];
    }
    if (!matchesInput(value, input)) {
      throw new WorkflowRuntimeError("input-type", `Input "${name}" must be ${input.type}`, `${path}.${name}`);
    }
    return [name, structuredClone(value) as WorkflowValue];
  }));
}

export function parseCliInput(value: string, input: InputDefinition, name: string): WorkflowValue {
  if (input.type === "string") return value;
  if (input.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new WorkflowRuntimeError("input-type", `Input "${name}" must be number`);
    return parsed;
  }
  if (input.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new WorkflowRuntimeError("input-type", `Input "${name}" must be true or false`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isJsonValue(parsed)) throw new Error("not JSON");
    return parsed;
  } catch {
    throw new WorkflowRuntimeError("input-type", `Input "${name}" must be valid JSON`);
  }
}

function matchesInput(value: unknown, input: InputDefinition): boolean {
  if (input.type === "json") return isJsonValue(value);
  return typeof value === input.type && (input.type !== "number" || Number.isFinite(value));
}

function isJsonValue(value: unknown): value is WorkflowValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
