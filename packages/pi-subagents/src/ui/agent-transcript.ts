import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  CompactionSummaryMessageComponent,
  type AgentSession,
  type AgentSessionEvent,
  getMarkdownTheme,
  keyHint,
  keyText,
  type KeybindingsManager,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type MarkdownTheme, Spacer, type TUI } from "@earendil-works/pi-tui";

type CompactionSummaryMessage = Extract<AgentMessage, { role: "compactionSummary" }>;

export interface AgentTranscriptOptions {
  markdownTheme?: MarkdownTheme;
  hideThinkingBlock?: boolean;
  toolsExpanded?: boolean;
  showImages?: boolean;
  imageWidthCells?: number;
  hiddenThinkingLabel?: string;
}

interface Attachment {
  session: AgentSession;
  unsubscribe?: () => void;
  released: boolean;
}

export class AgentTranscript implements Component {
  private readonly container = new Container();
  private readonly markdownTheme: MarkdownTheme;
  private readonly initialHideThinkingBlock: boolean | undefined;
  private readonly initialShowImages: boolean | undefined;
  private readonly initialImageWidthCells: number | undefined;
  private readonly hiddenThinkingLabel: string;
  private readonly assistantComponents = new Map<string, AssistantMessageComponent>();
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  private readonly pendingToolIds = new Set<string>();
  private readonly renderedUserMessages = new Set<string>();
  private readonly renderedCompactionMessages = new Set<string>();
  private readonly expandableComponents = new Set<{ setExpanded(expanded: boolean): void }>();
  private attachment: Attachment | undefined;
  private activeAssistantKey: string | undefined;
  private hideThinkingBlock = false;
  private toolsExpanded: boolean;
  private showImages = true;
  private imageWidthCells = 60;

  constructor(
    private readonly tui: TUI,
    private readonly keybindings: KeybindingsManager,
    options: AgentTranscriptOptions = {},
  ) {
    this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
    this.initialHideThinkingBlock = options.hideThinkingBlock;
    this.initialShowImages = options.showImages;
    this.initialImageWidthCells = options.imageWidthCells;
    this.hiddenThinkingLabel = options.hiddenThinkingLabel ?? "Thinking...";
    this.toolsExpanded = options.toolsExpanded ?? false;
  }

  attach(session: AgentSession): void {
    this.detach();

    const attachment: Attachment = { session, released: false };
    const queuedEvents: AgentSessionEvent[] = [];
    let replaying = true;
    this.attachment = attachment;

    try {
      attachment.unsubscribe = session.subscribe((event) => {
        if (this.attachment !== attachment) return;
        if (replaying) {
          queuedEvents.push(event);
          return;
        }
        this.handleEvent(event);
      });

      this.hideThinkingBlock = this.initialHideThinkingBlock ?? session.settingsManager.getHideThinkingBlock();
      this.showImages = this.initialShowImages ?? session.settingsManager.getShowImages();
      this.imageWidthCells = this.initialImageWidthCells ?? session.settingsManager.getImageWidthCells();
      this.rebuildFromSession(session);

      replaying = false;
      for (const event of queuedEvents) this.handleEvent(event);
      this.tui.requestRender();
    } catch (error) {
      replaying = false;
      if (this.attachment === attachment) this.detach();
      throw error;
    }
  }

  detach(): void {
    const attachment = this.attachment;
    this.attachment = undefined;
    if (attachment && !attachment.released) {
      attachment.released = true;
      const unsubscribe = attachment.unsubscribe;
      attachment.unsubscribe = undefined;
      unsubscribe?.();
    }
    this.clear();
  }

  dispose(): void {
    this.detach();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): boolean {
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toggleToolsExpanded();
      return true;
    }
    if (this.keybindings.matches(data, "app.thinking.toggle")) {
      this.toggleThinking();
      return true;
    }
    return false;
  }

  toggleToolsExpanded(): void {
    this.setToolsExpanded(!this.toolsExpanded);
  }

  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const component of this.expandableComponents) component.setExpanded(expanded);
    this.tui.requestRender();
  }

  toggleThinking(): void {
    this.setThinkingHidden(!this.hideThinkingBlock);
  }

  setThinkingHidden(hidden: boolean): void {
    this.hideThinkingBlock = hidden;
    this.attachment?.session.settingsManager.setHideThinkingBlock(hidden);
    for (const component of this.assistantComponents.values()) component.setHideThinkingBlock(hidden);
    this.tui.requestRender();
  }

  get toolsToggleKey(): string {
    return keyText("app.tools.expand");
  }

  get thinkingToggleKey(): string {
    return keyText("app.thinking.toggle");
  }

  getToggleHints(): { tools: string; thinking: string } {
    return {
      tools: keyHint("app.tools.expand", this.toolsExpanded ? "collapse tools" : "expand tools"),
      thinking: keyHint("app.thinking.toggle", this.hideThinkingBlock ? "show thinking" : "hide thinking"),
    };
  }

  private clear(): void {
    this.container.clear();
    this.assistantComponents.clear();
    this.toolComponents.clear();
    this.pendingToolIds.clear();
    this.renderedUserMessages.clear();
    this.renderedCompactionMessages.clear();
    this.expandableComponents.clear();
    this.activeAssistantKey = undefined;
  }

  private rebuildFromSession(session: AgentSession): void {
    const messages = [...session.messages];
    const streamingMessage = session.state.streamingMessage;
    const pendingToolCalls = new Set(session.state.pendingToolCalls);
    this.clear();

    for (const message of messages) this.replayMessage(message);
    if (streamingMessage?.role === "assistant") this.startAssistant(streamingMessage);
    for (const toolCallId of pendingToolCalls) {
      const component = this.toolComponents.get(toolCallId);
      if (component) {
        this.pendingToolIds.add(toolCallId);
        component.markExecutionStarted();
      }
    }
  }

  private replayMessage(message: AgentMessage): void {
    if (message.role === "user") {
      this.addUserMessage(message);
      return;
    }
    if (message.role === "assistant") {
      const toolIds = this.addAssistantMessage(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        this.failTools(toolIds, this.assistantError(message));
      } else {
        for (const toolCallId of toolIds) this.toolComponents.get(toolCallId)?.setArgsComplete();
      }
      return;
    }
    if (message.role === "toolResult") this.applyToolResult(message);
    else if (message.role === "compactionSummary") this.addCompactionSummary(message);
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "user") this.addUserMessage(event.message);
        else if (event.message.role === "assistant") this.startAssistant(event.message);
        else if (event.message.role === "toolResult") this.applyToolResult(event.message);
        else return;
        break;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.updateAssistant(event.message);
        break;
      case "message_end":
        if (event.message.role !== "assistant") return;
        this.endAssistant(event.message);
        break;
      case "tool_execution_start": {
        const component = this.addTool(event.toolName, event.toolCallId, event.args);
        this.pendingToolIds.add(event.toolCallId);
        component.markExecutionStarted();
        break;
      }
      case "tool_execution_update": {
        const component = this.addTool(event.toolName, event.toolCallId, event.args);
        this.pendingToolIds.add(event.toolCallId);
        component.updateResult({ ...event.partialResult, isError: false }, true);
        break;
      }
      case "tool_execution_end": {
        const component = this.addTool(event.toolName, event.toolCallId, {});
        component.updateResult({ ...event.result, isError: event.isError });
        this.pendingToolIds.delete(event.toolCallId);
        break;
      }
      case "compaction_end": {
        if (event.aborted || !event.result || !this.attachment) return;
        this.rebuildFromSession(this.attachment.session);
        this.addCompactionSummary({
          role: "compactionSummary",
          summary: event.result.summary,
          tokensBefore: event.result.tokensBefore,
          timestamp: Date.now(),
        });
        break;
      }
      default:
        return;
    }
    this.tui.requestRender();
  }

  private addUserMessage(message: UserMessage): void {
    const key = `${message.timestamp}:${this.userText(message)}`;
    if (this.renderedUserMessages.has(key)) return;
    const text = this.userText(message);
    if (!text) return;
    this.renderedUserMessages.add(key);
    this.container.addChild(new UserMessageComponent(text, this.markdownTheme));
  }

  private startAssistant(message: AssistantMessage): void {
    const key = this.assistantKey(message);
    this.activeAssistantKey = key;
    this.addAssistantMessage(message);
  }

  private updateAssistant(message: AssistantMessage): void {
    const key = this.activeAssistantKey ?? this.assistantKey(message);
    let component = this.assistantComponents.get(key);
    if (!component) {
      this.startAssistant(message);
      return;
    }
    component.updateContent(message);
    this.activeAssistantKey = key;
    this.addToolsFromAssistant(message);
  }

  private endAssistant(message: AssistantMessage): void {
    const key = this.activeAssistantKey ?? this.assistantKey(message);
    const component = this.assistantComponents.get(key);
    if (component) component.updateContent(message);
    else this.addAssistantMessage(message);

    const toolIds = this.addToolsFromAssistant(message);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      this.failTools(toolIds, this.assistantError(message));
    } else {
      for (const toolCallId of toolIds) this.toolComponents.get(toolCallId)?.setArgsComplete();
    }
    this.activeAssistantKey = undefined;
  }

  private addAssistantMessage(message: AssistantMessage): Set<string> {
    const key = this.assistantKey(message);
    let component = this.assistantComponents.get(key);
    if (!component) {
      component = new AssistantMessageComponent(
        message,
        this.hideThinkingBlock,
        this.markdownTheme,
        this.hiddenThinkingLabel,
      );
      this.assistantComponents.set(key, component);
      this.container.addChild(component);
    } else {
      component.updateContent(message);
    }
    return this.addToolsFromAssistant(message);
  }

  private addToolsFromAssistant(message: AssistantMessage): Set<string> {
    const toolIds = new Set<string>();
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      toolIds.add(content.id);
      this.addTool(content.name, content.id, content.arguments).updateArgs(content.arguments);
    }
    return toolIds;
  }

  private addTool(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
    const existing = this.toolComponents.get(toolCallId);
    if (existing) return existing;

    const session = this.attachment?.session;
    if (!session) throw new Error("Cannot render a tool without an attached session");
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args,
      { showImages: this.showImages, imageWidthCells: this.imageWidthCells },
      session.getToolDefinition(toolName),
      this.tui,
      session.sessionManager.getCwd(),
    );
    component.setExpanded(this.toolsExpanded);
    this.toolComponents.set(toolCallId, component);
    this.expandableComponents.add(component);
    this.pendingToolIds.add(toolCallId);
    this.container.addChild(component);
    return component;
  }

  private applyToolResult(message: ToolResultMessage): void {
    const component = this.toolComponents.get(message.toolCallId);
    if (!component) return;
    component.updateResult(message);
    this.pendingToolIds.delete(message.toolCallId);
  }

  private addCompactionSummary(message: CompactionSummaryMessage): void {
    const key = `${message.tokensBefore}:${message.summary}`;
    if (this.renderedCompactionMessages.has(key)) return;
    this.renderedCompactionMessages.add(key);
    const component = new CompactionSummaryMessageComponent(message, this.markdownTheme);
    component.setExpanded(this.toolsExpanded);
    this.expandableComponents.add(component);
    this.container.addChild(new Spacer(1));
    this.container.addChild(component);
  }

  private failTools(toolIds: Iterable<string>, errorMessage: string): void {
    for (const toolCallId of toolIds) {
      if (!this.pendingToolIds.has(toolCallId)) continue;
      this.toolComponents.get(toolCallId)?.updateResult({
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      });
      this.pendingToolIds.delete(toolCallId);
    }
  }

  private assistantError(message: AssistantMessage): string {
    if (message.stopReason === "aborted") return message.errorMessage || "Operation aborted";
    return message.errorMessage || "Error";
  }

  private assistantKey(message: AssistantMessage): string {
    return `${message.timestamp}:${message.provider}:${message.model}`;
  }

  private userText(message: UserMessage): string {
    if (typeof message.content === "string") return message.content;
    return message.content.filter((content) => content.type === "text").map((content) => content.text).join("");
  }
}
