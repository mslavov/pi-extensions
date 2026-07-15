import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  getMarkdownTheme,
  initTheme,
  type KeybindingsManager as AppKeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AgentTranscript, type AgentTranscriptOptions } from "../ui/agent-transcript.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 100,
    ...overrides,
  };
}

function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: text, timestamp };
}

function toolResult(
  toolCallId: string,
  text: string,
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: `tool-${toolCallId}`,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 200,
    ...overrides,
  };
}

interface SessionHarness {
  session: AgentSession;
  emit(event: AgentSessionEvent): void;
  messages: AgentMessage[];
  state: {
    streamingMessage?: AgentMessage;
    pendingToolCalls: Set<string>;
  };
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setHideThinkingBlock: ReturnType<typeof vi.fn>;
  getToolDefinition: ReturnType<typeof vi.fn>;
}

function makeSession(
  initialMessages: AgentMessage[] = [],
  options: {
    onSubscribe?: (listener: (event: AgentSessionEvent) => void, harness: SessionHarness) => void;
    messagesError?: Error;
    toolDefinitions?: Record<string, unknown>;
  } = {},
): SessionHarness {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const dispose = vi.fn();
  const setHideThinkingBlock = vi.fn();
  const messages = [...initialMessages];
  const state = { streamingMessage: undefined as AgentMessage | undefined, pendingToolCalls: new Set<string>() };
  const getToolDefinition = vi.fn((name: string) => options.toolDefinitions?.[name]);
  let harness: SessionHarness;
  const subscribe = vi.fn((nextListener: (event: AgentSessionEvent) => void) => {
    listener = nextListener;
    options.onSubscribe?.(nextListener, harness);
    return unsubscribe;
  });
  const session = {
    subscribe,
    get messages() {
      if (options.messagesError) throw options.messagesError;
      return messages;
    },
    state,
    settingsManager: {
      getHideThinkingBlock: vi.fn(() => false),
      setHideThinkingBlock,
      getShowImages: vi.fn(() => true),
      getImageWidthCells: vi.fn(() => 40),
    },
    sessionManager: { getCwd: vi.fn(() => "/tmp/agent") },
    getToolDefinition,
    dispose,
  } as unknown as AgentSession;
  harness = {
    session,
    emit(event) {
      listener?.(event);
    },
    messages,
    state,
    subscribe,
    unsubscribe,
    dispose,
    setHideThinkingBlock,
    getToolDefinition,
  };
  return harness;
}

function makeKeybindings(): AppKeybindingsManager {
  const keybindings = new KeybindingsManager({
    "app.tools.expand": { defaultKeys: "x" },
    "app.thinking.toggle": { defaultKeys: "t" },
  } as any);
  setKeybindings(keybindings);
  return keybindings as unknown as AppKeybindingsManager;
}

function makeTranscript(options: AgentTranscriptOptions = {}) {
  const tui = { requestRender: vi.fn() };
  const transcript = new AgentTranscript(tui as any, makeKeybindings(), options);
  return { transcript, tui };
}

function rendered(transcript: AgentTranscript, width = 80): string {
  return transcript.render(width).join("\n");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

beforeAll(() => {
  initTheme("dark", false);
});

describe("AgentTranscript", () => {
  it("replays ordered history and binds full tool results to their calls", () => {
    const longResult = `${"a".repeat(550)}TAIL`;
    const session = makeSession([
      user("first user"),
      assistant([
        { type: "text", text: "first assistant" },
        { type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "pi" } },
      ], { stopReason: "toolUse" }),
      toolResult("call-1", longResult, { toolName: "lookup" }),
      assistant([{ type: "text", text: "second assistant" }], { timestamp: 300 }),
    ]);
    const { transcript } = makeTranscript();

    transcript.attach(session.session);

    const output = rendered(transcript, 100);
    expect(output.indexOf("first user")).toBeLessThan(output.indexOf("first assistant"));
    expect(output.indexOf("first assistant")).toBeLessThan(output.indexOf("lookup"));
    expect(output.indexOf("TAIL")).toBeLessThan(output.indexOf("second assistant"));
    expect(output).not.toContain("[User]");
    expect(output).not.toContain("[Result]");
    expect(output).not.toContain("truncated");
  });

  it("subscribes before replay and merges an immediate attach-race event", () => {
    const racingMessage = assistant([
      { type: "text", text: "racing response" },
      { type: "toolCall", id: "race-tool", name: "race_lookup", arguments: { value: 1 } },
    ], { stopReason: "toolUse", timestamp: 400 });
    const session = makeSession([], {
      onSubscribe(listener, harness) {
        harness.messages.push(racingMessage);
        listener({ type: "message_start", message: racingMessage });
      },
    });
    const { transcript } = makeTranscript();

    transcript.attach(session.session);

    const output = rendered(transcript);
    expect(session.subscribe).toHaveBeenCalledTimes(1);
    expect(occurrences(output, "racing response")).toBe(1);
    expect(occurrences(output, "race_lookup")).toBe(1);
  });

  it("streams assistant Markdown, thinking, and tool updates through public components", () => {
    const markdownTheme = { ...getMarkdownTheme(), bold: (text: string) => `MARK(${text})` };
    const session = makeSession();
    const { transcript } = makeTranscript({ markdownTheme });
    const started = assistant([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "**draft**" },
    ], { timestamp: 500 });

    transcript.attach(session.session);
    session.emit({ type: "message_start", message: started });
    session.emit({
      type: "message_update",
      message: assistant([
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "**final text**" },
        { type: "toolCall", id: "live-tool", name: "live_lookup", arguments: { q: "a" } },
      ], { timestamp: 500, stopReason: "toolUse" }),
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " text", partial: started },
    });
    session.emit({ type: "tool_execution_start", toolCallId: "live-tool", toolName: "live_lookup", args: { q: "a" } });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "live-tool",
      toolName: "live_lookup",
      args: { q: "a" },
      partialResult: { content: [{ type: "text", text: "partial output" }], details: {} },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "live-tool",
      toolName: "live_lookup",
      result: { content: [{ type: "text", text: "final output" }], details: {} },
      isError: false,
    });
    session.emit({
      type: "message_end",
      message: assistant([
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "**final text**" },
        { type: "toolCall", id: "live-tool", name: "live_lookup", arguments: { q: "a" } },
      ], { timestamp: 500, stopReason: "toolUse" }),
    });

    const output = rendered(transcript);
    expect(output).toContain("private reasoning");
    expect(output).toContain("MARK(final text)");
    expect(output).toContain("final output");
    expect(output).not.toContain("partial output");

    expect(transcript.handleInput("t")).toBe(true);
    expect(session.setHideThinkingBlock).toHaveBeenCalledWith(true);
    expect(rendered(transcript)).toContain("Thinking...");
    expect(rendered(transcript)).not.toContain("private reasoning");
  });

  it("keeps concurrent partial, final, error, and image tool flows isolated by id", () => {
    const session = makeSession();
    const { transcript } = makeTranscript();
    const message = assistant([
      { type: "toolCall", id: "a", name: "tool_a", arguments: {} },
      { type: "toolCall", id: "b", name: "tool_b", arguments: {} },
    ], { timestamp: 600, stopReason: "toolUse" });

    transcript.attach(session.session);
    session.emit({ type: "message_start", message });
    session.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "tool_a", args: {} });
    session.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "tool_b", args: {} });
    session.emit({
      type: "tool_execution_update",
      toolCallId: "a",
      toolName: "tool_a",
      args: {},
      partialResult: { content: [{ type: "text", text: "A partial" }], details: {} },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "b",
      toolName: "tool_b",
      result: { content: [{ type: "text", text: "B failed" }], details: {} },
      isError: true,
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "a",
      toolName: "tool_a",
      result: {
        content: [
          { type: "text", text: "A final" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        details: {},
      },
      isError: false,
    });

    const output = rendered(transcript);
    expect(output.indexOf("tool_a")).toBeLessThan(output.indexOf("A final"));
    expect(output.indexOf("A final")).toBeLessThan(output.indexOf("tool_b"));
    expect(output.indexOf("tool_b")).toBeLessThan(output.indexOf("B failed"));
    expect(output).not.toContain("A partial");
  });

  it("uses session tool renderers and configured expansion bindings and hints", () => {
    const definition = {
      name: "custom_tool",
      label: "Custom",
      description: "test",
      parameters: {},
      execute: vi.fn(),
      renderCall: (_args: unknown, _theme: unknown, context: { toolCallId: string }) => new Text(`call:${context.toolCallId}`, 0, 0),
      renderResult: (
        result: { content: Array<{ type: string; text?: string }> },
        options: { expanded: boolean },
      ) => new Text(`${options.expanded ? "expanded" : "collapsed"}:${result.content[0]?.text}`, 0, 0),
    };
    const session = makeSession([
      assistant([{ type: "toolCall", id: "custom-1", name: "custom_tool", arguments: {} }], { stopReason: "toolUse" }),
      toolResult("custom-1", "custom result", { toolName: "custom_tool" }),
    ], { toolDefinitions: { custom_tool: definition } });
    const { transcript } = makeTranscript();

    transcript.attach(session.session);
    expect(rendered(transcript)).toContain("collapsed:custom result");
    expect(session.getToolDefinition).toHaveBeenCalledWith("custom_tool");

    expect(transcript.handleInput("x")).toBe(true);
    expect(rendered(transcript)).toContain("expanded:custom result");
    expect(transcript.toolsToggleKey).toBe("x");
    expect(transcript.thinkingToggleKey).toBe("t");
    expect(transcript.getToggleHints().tools).toContain("collapse tools");
    expect(transcript.handleInput("z")).toBe(false);
  });

  it("renders stable, width-safe lines across reflow widths", () => {
    const session = makeSession([
      user("A user message with enough words to wrap across several narrow terminal lines."),
      assistant([{ type: "text", text: "An assistant answer with **Markdown** and enough text to reflow." }]),
    ]);
    const { transcript } = makeTranscript();
    transcript.attach(session.session);

    const narrow = transcript.render(24);
    const wide = transcript.render(72);

    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(wide.every((line) => visibleWidth(line) <= 72)).toBe(true);
    transcript.invalidate();
    expect(transcript.render(24)).toEqual(narrow);
  });

  it("finalizes unresolved tools as errors when an assistant message fails", () => {
    const session = makeSession();
    const { transcript } = makeTranscript();
    const started = assistant([
      { type: "toolCall", id: "failed-tool", name: "dangerous_tool", arguments: {} },
    ], { timestamp: 700, stopReason: "toolUse" });

    transcript.attach(session.session);
    session.emit({ type: "message_start", message: started });
    session.emit({
      type: "message_end",
      message: assistant(started.content, {
        timestamp: 700,
        stopReason: "error",
        errorMessage: "provider failed",
      }),
    });

    expect(rendered(transcript)).toContain("provider failed");
  });

  it("rebuilds from compacted session history before accepting new live messages", () => {
    const session = makeSession([
      user("old history"),
      assistant([{ type: "text", text: "old answer" }]),
    ]);
    const { transcript } = makeTranscript();
    transcript.attach(session.session);

    session.messages.splice(0, session.messages.length, user("compacted context", 900));
    session.emit({
      type: "compaction_end",
      reason: "threshold",
      result: {
        summary: "summary after compaction",
        firstKeptEntryId: "entry-1",
        tokensBefore: 1200,
      },
      aborted: false,
      willRetry: false,
    });
    session.emit({
      type: "message_start",
      message: assistant([{ type: "text", text: "new live answer" }], { timestamp: 901 }),
    });

    const output = rendered(transcript);
    expect(output).not.toContain("old history");
    expect(output).not.toContain("old answer");
    expect(output).toContain("compacted context");
    expect(output).toContain("Compacted from 1,200 tokens");
    expect(output).toContain("new live answer");
    transcript.setToolsExpanded(true);
    expect(rendered(transcript)).toContain("summary after compaction");
    expect(session.subscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes once on switch, attach failure, and repeated disposal without owning sessions", () => {
    const first = makeSession([user("first")]);
    const second = makeSession([user("second")]);
    const failing = makeSession([], { messagesError: new Error("snapshot failed") });
    const { transcript } = makeTranscript();

    transcript.attach(first.session);
    transcript.attach(second.session);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(rendered(transcript)).toContain("second");
    expect(rendered(transcript)).not.toContain("first");

    expect(() => transcript.attach(failing.session)).toThrow("snapshot failed");
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
    expect(failing.unsubscribe).toHaveBeenCalledTimes(1);

    transcript.dispose();
    transcript.dispose();
    expect(failing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(failing.dispose).not.toHaveBeenCalled();
  });
});
