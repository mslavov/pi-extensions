import { resolveValue } from "../runner/references.js";
import type { HandlerContext, HandlerResult } from "./types.js";

export function runSetStep(context: HandlerContext): HandlerResult {
  const definition = context.step.definition;
  if (definition.type !== "set") throw new Error("set handler received another step type");
  const values = resolveValue(definition.values, context.values, `${context.path}.values`);
  if (values === null || Array.isArray(values) || typeof values !== "object") {
    throw new Error("set values must resolve to an object");
  }
  Object.assign(context.values.vars, values);
  return { output: null };
}
