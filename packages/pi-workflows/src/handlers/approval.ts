import { resolveTemplate } from "../runner/references.js";
import { WorkflowCancelledError } from "../runner/types.js";
import type { HandlerContext, HandlerResult } from "./types.js";

export async function runApprovalStep(context: HandlerContext): Promise<HandlerResult> {
  const definition = context.step.definition;
  if (definition.type !== "approval") throw new Error("approval handler received another step type");
  const message = resolveTemplate(definition.message, context.values, `${context.path}.message`);
  if (typeof message !== "string") throw new Error("approval message must resolve to a string");
  const decision = await awaitDecision(
    context.decideApproval({ path: context.path, message, signal: context.signal }),
    context.signal,
    context.path,
  );
  const output = { decision, approved: decision === "accepted" };
  if (decision === "cancelled") {
    return { output, cancelled: new WorkflowCancelledError("Approval cancelled", context.path) };
  }
  if (decision === "denied") {
    return { output, error: { code: "approval-denied", message: `Approval denied at ${context.path}` } };
  }
  return { output };
}

async function awaitDecision(
  decision: Promise<"accepted" | "denied" | "cancelled">,
  signal: AbortSignal,
  path: string,
): Promise<"accepted" | "denied" | "cancelled"> {
  if (signal.aborted) throw new WorkflowCancelledError("Approval cancelled", path);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new WorkflowCancelledError("Approval cancelled", path));
    signal.addEventListener("abort", onAbort, { once: true });
    void decision.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
