import type { WorkflowValue } from "../types.js";
import type { StepResult } from "./types.js";
import { WorkflowRuntimeError } from "./types.js";

const exactPattern = /^\$\{\{\s*([^{}]+?)\s*\}\}$/;
const expressionPattern = /\$\{\{\s*([^{}]+?)\s*\}\}/g;

export interface RuntimeValues {
  inputs: Record<string, WorkflowValue>;
  vars: Record<string, WorkflowValue>;
  steps: Map<string, StepResult>;
}

export function resolveValue(value: unknown, context: RuntimeValues, path: string): WorkflowValue {
  if (typeof value === "string") return resolveTemplate(value, context, path);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item, index) => resolveValue(item, context, `${path}.${index}`));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, context, `${path}.${key}`)]));
  }
  throw new WorkflowRuntimeError("value-type", `Unsupported workflow value at ${path}`, path);
}

export function resolveTemplate(value: string, context: RuntimeValues, path: string): WorkflowValue {
  const exact = value.match(exactPattern);
  if (exact) return resolveExpression(exact[1].trim(), context, path);
  return value.replace(expressionPattern, (_match, expression: string) => {
    const resolved = resolveExpression(expression.trim(), context, path);
    if (resolved === null || typeof resolved === "object") {
      throw new WorkflowRuntimeError(
        "reference-interpolation-type",
        `Interpolated reference "${expression.trim()}" is not scalar`,
        path,
      );
    }
    return String(resolved);
  });
}

export function resolveCondition(value: boolean | string | undefined, context: RuntimeValues, path: string): boolean {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  const exact = value.match(exactPattern);
  if (!exact) throw new WorkflowRuntimeError("reference-condition", "Condition must be one exact reference", path);
  const raw = exact[1].trim();
  const negated = raw.startsWith("!");
  const expression = negated ? raw.slice(1).trim() : raw;
  const truthy = workflowTruthy(resolveExpression(expression, context, path));
  return negated ? !truthy : truthy;
}

function resolveExpression(expression: string, context: RuntimeValues, path: string): WorkflowValue {
  const parts = expression.split(".");
  let value: unknown;
  if (parts[0] === "inputs") value = context.inputs;
  else if (parts[0] === "vars") value = context.vars;
  else if (parts[0] === "steps") {
    const step = context.steps.get(parts[1]);
    if (!step) throw new WorkflowRuntimeError("reference-step", `Step "${parts[1]}" is not available`, path);
    if (parts[2] === "output" && step.status === "skipped") {
      throw new WorkflowRuntimeError(
        "reference-skipped-output",
        `Step "${parts[1]}" was skipped and has no output`,
        path,
      );
    }
    value = step;
  } else {
    throw new WorkflowRuntimeError("reference-root", `Unsupported reference "${expression}"`, path);
  }

  for (const part of parts.slice(parts[0] === "steps" ? 2 : 1)) {
    if (!isObject(value) && !Array.isArray(value)) {
      throw new WorkflowRuntimeError("reference-path", `Reference "${expression}" is unavailable`, path);
    }
    if (!(part in value)) {
      throw new WorkflowRuntimeError("reference-path", `Reference "${expression}" is unavailable`, path);
    }
    value = value[part as keyof typeof value];
  }
  if (!isWorkflowValue(value)) {
    throw new WorkflowRuntimeError("reference-path", `Reference "${expression}" is unavailable`, path);
  }
  return value;
}

function workflowTruthy(value: WorkflowValue): boolean {
  return value !== false && value !== null && value !== 0 && value !== "";
}

function isWorkflowValue(value: unknown): value is WorkflowValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWorkflowValue);
  return isObject(value) && Object.values(value).every(isWorkflowValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
