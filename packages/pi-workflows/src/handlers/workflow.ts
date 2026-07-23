import { resolveValue } from "../runner/references.js";
import { WorkflowRuntimeError } from "../runner/types.js";
import type { WorkflowValue } from "../types.js";
import type { HandlerContext, HandlerResult } from "./types.js";

export async function runNestedWorkflowStep(context: HandlerContext): Promise<HandlerResult> {
  const definition = context.step.definition;
  if (definition.type !== "workflow") throw new Error("workflow handler received another step type");
  const plan = context.plans.get(definition.workflow);
  if (!plan) throw new WorkflowRuntimeError("workflow-missing", `Nested workflow "${definition.workflow}" is unavailable`, context.path);
  const inputs = resolveValue(definition.inputs ?? {}, context.values, `${context.path}.inputs`);
  if (inputs === null || Array.isArray(inputs) || typeof inputs !== "object") {
    throw new WorkflowRuntimeError("workflow-inputs", "Nested workflow inputs must resolve to an object", context.path);
  }
  return context.runNested(plan, inputs as Record<string, WorkflowValue>, context.path, context.signal);
}
