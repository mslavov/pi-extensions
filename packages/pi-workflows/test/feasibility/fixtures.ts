import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = "pi-workflows-feasibility";
const SOURCE = "pi-workflows-feasibility-tests";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export async function writeControlledAgentConfig(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        controlled: {
          baseUrl: "http://127.0.0.1/unused",
          api: API,
          apiKey: "controlled-test-key",
          models: [{ id: "controlled-model", contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "controlled",
      defaultModel: "controlled-model",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    }),
  );
}

export function registerControlledProvider(
  respond: (context: Context, call: number, options?: StreamOptions) => AssistantMessageEventStream,
): { contexts: Context[]; unregister(): void } {
  const contexts: Context[] = [];
  let call = 0;
  registerApiProvider(
    {
      api: API,
      stream: (_model, context, options) => {
        contexts.push(context);
        call += 1;
        return respond(context, call, options);
      },
      streamSimple: (_model, context, options) => {
        contexts.push(context);
        call += 1;
        return respond(context, call, options);
      },
    },
    SOURCE,
  );
  return { contexts, unregister: () => unregisterApiProviders(SOURCE) };
}

export function errorResponse(message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const assistant = messageBase("error", [], message);
  stream.push({ type: "start", partial: assistant });
  stream.push({ type: "error", reason: "error", error: assistant });
  stream.end();
  return stream;
}

export function toolResponse(name: string, arguments_: Record<string, unknown>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const toolCall = { type: "toolCall" as const, id: "controlled-tool-call", name, arguments: arguments_ };
  const assistant = messageBase("toolUse", [toolCall]);
  stream.push({ type: "start", partial: assistant });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: assistant });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant });
  stream.push({ type: "done", reason: "toolUse", message: assistant });
  stream.end();
  return stream;
}

export function textResponse(text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueTextResponse(stream, text);
  return stream;
}

export function deferredTextResponse(
  text: string,
  release: Promise<void>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void release.then(() => queueTextResponse(stream, text));
  return stream;
}

export function abortableTextResponse(text: string, signal?: AbortSignal): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const assistant = messageBase("stop", [{ type: "text", text }]);
  const aborted = messageBase("aborted", []);
  stream.push({ type: "start", partial: assistant });
  if (signal?.aborted) {
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end();
    return stream;
  }
  signal?.addEventListener("abort", () => {
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end();
  }, { once: true });
  return stream;
}

function queueTextResponse(stream: AssistantMessageEventStream, text: string): void {
  const assistant = messageBase("stop", [{ type: "text", text }]);
  stream.push({ type: "start", partial: assistant });
  stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant });
  stream.push({ type: "done", reason: "stop", message: assistant });
  stream.end();
}

function messageBase(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    api: API,
    provider: "controlled",
    model: "controlled-model",
    content,
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}
