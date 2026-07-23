import { resolveTemplate } from "../runner/references.js";
import { WorkflowCancelledError, WorkflowRuntimeError } from "../runner/types.js";
import type { WorkflowChildSession } from "../runtime/child-session.js";
import type { HandlerContext, HandlerResult } from "./types.js";

type AssistantMessage = Extract<WorkflowChildSession["session"]["messages"][number], { role: "assistant" }>;

export async function runAgentStep(context: HandlerContext): Promise<HandlerResult> {
  const definition = context.step.definition;
  if (definition.type !== "agent") throw new Error("agent handler received another step type");
  const prompt = resolveTemplate(definition.prompt, context.values, `${context.path}.prompt`);
  if (typeof prompt !== "string") {
    throw new WorkflowRuntimeError("value-type", `Value at ${context.path}.prompt must resolve to a string`, context.path);
  }

  const child = await context.runtime.getChildSession();
  if (context.signal.aborted) {
    await context.runtime.abort();
    throw new WorkflowCancelledError("Workflow agent cancelled", context.path);
  }
  if (!child.session.model) {
    throw new WorkflowRuntimeError(
      "agent-model-unavailable",
      "No model is available for workflow agent steps. Configure a pi model and provider credentials, then retry.",
      context.path,
    );
  }

  const firstNewMessage = child.session.messages.length;
  await promptAndAwaitAbort(child, prompt, context);
  if (context.signal.aborted) throw new WorkflowCancelledError("Workflow agent cancelled", context.path);

  const assistant = findFinalAssistant(child, firstNewMessage);
  if (!assistant) {
    return {
      output: null,
      error: { code: "agent-empty-response", message: `Agent returned no assistant response at ${context.path}` },
    };
  }
  if (assistant.stopReason === "error") {
    return {
      output: null,
      error: {
        code: "agent-provider",
        message: assistant.errorMessage ?? `Agent provider failed at ${context.path}`,
      },
    };
  }
  if (assistant.stopReason === "aborted") {
    throw new WorkflowCancelledError("Workflow agent cancelled", context.path);
  }

  const text = assistant.content
    .filter((content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("")
    .trim();
  return { output: { text: capText(text, context.runtime.maxAgentOutputBytes) } };
}

async function promptAndAwaitAbort(
  child: WorkflowChildSession,
  prompt: string,
  context: HandlerContext,
): Promise<void> {
  let abortPromise: Promise<void> | undefined;
  const onAbort = () => {
    abortPromise ??= context.runtime.abort();
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  try {
    if (abortPromise) {
      await abortPromise;
      throw new WorkflowCancelledError("Workflow agent cancelled", context.path);
    }
    await child.session.prompt(prompt);
  } catch (error) {
    if (context.signal.aborted) throw new WorkflowCancelledError("Workflow agent cancelled", context.path);
    const message = error instanceof Error ? error.message : String(error);
    const configurationFailure = message.startsWith("No model selected") ||
      message.startsWith("No API key found") || message.startsWith("Authentication failed");
    throw new WorkflowRuntimeError(
      configurationFailure ? "agent-provider-config" : "agent-prompt",
      configurationFailure ? `Workflow agent provider configuration failed: ${message}` : message,
      context.path,
      { cause: error instanceof Error ? error : undefined },
    );
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    if (abortPromise) await abortPromise;
  }
}

function findFinalAssistant(child: WorkflowChildSession, firstNewMessage: number): AssistantMessage | undefined {
  return child.session.messages
    .slice(firstNewMessage)
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");
}

function capText(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const marker = "\n[truncated]";
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= limit) return truncateUtf8(text, limit);
  return `${truncateUtf8(text, limit - markerBytes)}${marker}`;
}

function truncateUtf8(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/\uFFFD$/u, "");
}
