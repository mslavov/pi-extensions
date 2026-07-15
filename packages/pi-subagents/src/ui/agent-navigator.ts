import {
  rawKeyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentManager, SteerResult } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import {
  describeActivity,
  formatDuration,
  getDisplayName,
  type AgentActivity,
} from "./agent-widget.js";
import { AgentTranscript } from "./agent-transcript.js";

const MAX_RAIL_ROWS = 5;
const REFRESH_INTERVAL_MS = 1000;

export const AGENT_NAVIGATOR_SHORTCUT = Key.alt("a");
export const AGENT_NAVIGATOR_SHORTCUT_LABEL = "Alt+A";
export const AGENT_NAVIGATOR_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "top-left",
  width: "100%",
  maxHeight: "100%",
  margin: 0,
};

export type AgentNavigatorResult = "close" | "manage";

export interface AgentNavigatorActions {
  stopAgent(id: string): boolean;
  steerAgent(id: string, message: string): Promise<SteerResult>;
  onSteered?(id: string, message: string): void;
}

type NavigatorManager = Pick<AgentManager, "getRecord" | "listAgents">;

export interface AgentNavigatorControllerOptions {
  manager: NavigatorManager;
  activity: Map<string, AgentActivity>;
  actions: AgentNavigatorActions;
  manage(ctx: ExtensionContext): Promise<void>;
}

export class AgentNavigator implements Component, Focusable {
  private readonly input = new Input();
  private records: AgentRecord[] = [];
  private selectedId: string | undefined;
  private transcript: AgentTranscript | undefined;
  private transcriptSession: AgentRecord["session"];
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private inputFocused = false;
  private closed = false;
  private statusMessage = "";
  private scrollOffset = 0;
  private autoScroll = true;
  private lastContentLength = 0;
  private lastViewportHeight = 1;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly manager: NavigatorManager,
    private readonly activity: Map<string, AgentActivity>,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: AgentNavigatorResult) => void,
    private readonly actions: AgentNavigatorActions,
  ) {
    this.records = manager.listAgents();
    this.selectedId = this.initialSelection(this.records);
    this.input.onSubmit = (value) => { void this.submitSteer(value); };
    this.input.onEscape = () => this.close();
    this.syncSelectedRecord();
    this.refreshInterval = setInterval(() => {
      if (this.closed) return;
      this.refreshRecords();
      this.tui.requestRender();
    }, REFRESH_INTERVAL_MS);
    this.refreshInterval.unref?.();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.inputFocused;
  }

  close(): void {
    this.finish("close");
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }

    if (this.inputFocused) {
      if (matchesKey(data, Key.tab)) {
        this.focusNavigation();
      } else {
        this.input.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }

    if (this.transcript?.handleInput(data)) return;
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.moveSelection(-1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.moveSelection(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-this.lastViewportHeight);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(this.lastViewportHeight);
    } else if (matchesKey(data, Key.home)) {
      this.autoScroll = false;
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.autoScroll = true;
    } else if (matchesKey(data, Key.enter)) {
      this.focusInput();
    } else if (matchesKey(data, Key.tab)) {
      this.focusInput();
    } else if (matchesKey(data, "m")) {
      this.finish("manage");
    } else if (matchesKey(data, "q")) {
      this.close();
    } else if (matchesKey(data, "x") || matchesKey(data, "s")) {
      this.stopSelected();
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    this.refreshRecords();

    const rows = Math.max(1, this.tui.terminal.rows);
    if (this.inputFocused && rows < 5) this.focusNavigation(true);
    const selected = this.selectedRecord();
    const canSteer = selected?.status === "running";
    const showStatus = Boolean(this.statusMessage) && rows >= 7;
    const showPrompt = canSteer && rows >= 5;
    const showDivider = rows >= 6;
    const showHints = rows >= 4;
    const fixedRows = 1 + Number(showStatus) + Number(showPrompt) + Number(showDivider) + Number(showHints);
    const contentBudget = Math.max(0, rows - fixedRows);
    let railRows = contentBudget > 1
      ? Math.min(MAX_RAIL_ROWS, this.railItems().length, Math.max(1, contentBudget - 1))
      : 0;
    let viewportHeight = contentBudget - railRows;
    if (viewportHeight < 1 && railRows > 0 && contentBudget > 1) {
      railRows--;
      viewportHeight = 1;
    }
    this.lastViewportHeight = Math.max(1, viewportHeight);

    const lines: string[] = [this.renderHeader(selected)];
    if (showStatus) lines.push(this.theme.fg("warning", this.statusMessage));
    lines.push(...this.renderTranscript(width, viewportHeight, selected));
    if (showDivider) lines.push(this.theme.fg("border", "─".repeat(width)));
    if (showPrompt && selected) lines.push(this.renderInput(width, selected));
    lines.push(...this.renderRail(width, railRows));
    if (showHints) lines.push(this.renderHints());

    while (lines.length < rows) lines.splice(Math.max(1, lines.length - railRows - Number(showHints)), 0, "");
    return lines.slice(0, rows).map((line) => this.fitLine(line, width));
  }

  invalidate(): void {
    this.transcript?.invalidate();
  }

  dispose(): void {
    if (this.closed && !this.refreshInterval && !this.transcript) return;
    this.closed = true;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    this.focusNavigation(true);
    this.transcript?.dispose();
    this.transcript = undefined;
    this.transcriptSession = undefined;
  }

  private finish(result: AgentNavigatorResult): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  private initialSelection(records: AgentRecord[]): string | undefined {
    return records.find((record) => record.status === "running" || record.status === "queued")?.id
      ?? records[0]?.id;
  }

  private refreshRecords(): void {
    const previousIndex = Math.max(0, this.records.findIndex((record) => record.id === this.selectedId));
    this.records = this.manager.listAgents();

    if (this.selectedId && !this.records.some((record) => record.id === this.selectedId)) {
      if (this.inputFocused) this.focusNavigation(true);
      this.selectedId = this.records[Math.min(previousIndex, this.records.length - 1)]?.id;
      this.statusMessage = "";
    } else if (!this.selectedId && this.records.length > 0) {
      this.selectedId = this.initialSelection(this.records);
    }

    const selected = this.selectedRecord();
    if (this.inputFocused && selected?.status !== "running") this.focusNavigation(true);
    this.syncSelectedRecord();
  }

  private syncSelectedRecord(): void {
    const session = this.selectedRecord()?.session;
    if (session === this.transcriptSession) return;

    this.transcript?.dispose();
    this.transcript = undefined;
    this.transcriptSession = session;
    this.scrollOffset = 0;
    this.autoScroll = true;

    if (!session) return;
    try {
      this.transcript = new AgentTranscript(this.tui, this.keybindings);
      this.transcript.attach(session);
    } catch (error) {
      this.transcript?.dispose();
      this.transcript = undefined;
      this.statusMessage = `Unable to render transcript: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private selectedRecord(): AgentRecord | undefined {
    return this.selectedId ? this.manager.getRecord(this.selectedId) : undefined;
  }

  private railItems(): AgentRecord[] {
    return this.records;
  }

  private moveSelection(delta: number): void {
    const items = this.railItems();
    if (items.length === 0) return;
    const current = Math.max(0, items.findIndex((item) => item.id === this.selectedId));
    const next = Math.max(0, Math.min(items.length - 1, current + delta));
    if (next === current) return;
    this.focusNavigation(true);
    this.selectedId = items[next].id;
    this.statusMessage = "";
    this.syncSelectedRecord();
  }

  private focusInput(): void {
    if (this.selectedRecord()?.status !== "running" || this.tui.terminal.rows < 5) return;
    this.inputFocused = true;
    this.input.focused = this.focused;
  }

  private focusNavigation(clearDraft = false): void {
    this.inputFocused = false;
    this.input.focused = false;
    if (clearDraft) this.input.setValue("");
  }

  private stopSelected(): void {
    const record = this.selectedRecord();
    if (!record || (record.status !== "running" && record.status !== "queued")) {
      this.statusMessage = record ? `Agent is ${record.status}.` : "Select a running or queued agent first.";
      return;
    }
    this.statusMessage = this.actions.stopAgent(record.id)
      ? `Stopped @${getDisplayName(record.type)}.`
      : `Agent is ${record.status}.`;
    this.refreshRecords();
  }

  private async submitSteer(value: string): Promise<void> {
    const message = value.trim();
    const record = this.selectedRecord();
    if (!message || !record || record.status !== "running") return;
    const id = record.id;
    const result = await this.actions.steerAgent(id, message);
    if (this.closed) return;

    const name = getDisplayName(record.type);
    if (result.status === "queued") {
      this.statusMessage = `Message queued for delivery to @${name}.`;
      this.actions.onSteered?.(id, message);
    } else if (result.status === "sent") {
      this.statusMessage = `Message sent to @${name}.`;
      this.actions.onSteered?.(id, message);
    } else if (result.status === "rejected") {
      this.statusMessage = result.reason;
    } else {
      this.statusMessage = `Failed to steer @${name}: ${result.error}`;
    }

    if ((result.status === "queued" || result.status === "sent") && this.selectedId === id && this.input.getValue() === value) {
      this.input.setValue("");
    }
    this.tui.requestRender();
  }

  private scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.lastContentLength - this.lastViewportHeight);
    this.autoScroll = false;
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + delta));
    if (this.scrollOffset >= maxScroll) this.autoScroll = true;
  }

  private renderTranscript(width: number, height: number, selected: AgentRecord | undefined): string[] {
    if (height <= 0) return [];
    let content: string[];
    if (!selected) {
      content = [this.theme.fg("dim", "No subagents to show. Press m to manage agents, or Esc/q to close.")];
    } else if (!selected.session) {
      const state = selected.status === "queued" ? "waiting for an execution slot" : `session unavailable (${selected.status})`;
      content = [this.theme.fg("dim", state)];
    } else {
      content = this.transcript?.render(width) ?? [];
      if (content.length === 0) content = [this.theme.fg("dim", "Waiting for the first message…")];
    }

    this.lastContentLength = content.length;
    const maxScroll = Math.max(0, content.length - height);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visible = content.slice(this.scrollOffset, this.scrollOffset + height);
    return [...visible, ...Array(Math.max(0, height - visible.length)).fill("")];
  }

  private renderHeader(selected: AgentRecord | undefined): string {
    if (!selected) return this.theme.bold("Agent navigator") + this.theme.fg("dim", " · no subagents · Esc closes");
    const name = getDisplayName(selected.type);
    const duration = formatDuration(selected.startedAt, selected.completedAt);
    const activity = this.activity.get(selected.id);
    const detail = selected.status === "running" && activity
      ? describeActivity(activity.activeTools, activity.responseText)
      : selected.status;
    return this.theme.bold(`Viewing @${name}`) + this.theme.fg("dim", ` · ${detail} · ${duration} · Esc returns`);
  }

  private renderInput(width: number, selected: AgentRecord): string {
    const fullLabel = `Message @${getDisplayName(selected.type)}… `;
    const labelText = visibleWidth(fullLabel) <= Math.max(1, width - 4) ? fullLabel : "> ";
    const label = this.theme.fg("accent", labelText);
    const inputWidth = Math.max(1, width - visibleWidth(label));
    return label + (this.input.render(inputWidth)[0] ?? "");
  }

  private renderRail(width: number, maxRows: number): string[] {
    if (maxRows <= 0) return [];
    const items = this.railItems();
    const selectedIndex = Math.max(0, items.findIndex((item) => item.id === this.selectedId));
    const windowSize = Math.min(maxRows, items.length);
    const maxStart = Math.max(0, items.length - windowSize);
    const start = Math.max(0, Math.min(maxStart, selectedIndex - Math.floor(windowSize / 2)));
    const visibleItems = items.slice(start, start + windowSize);

    return visibleItems.map((item, index) => {
      const indicators: string[] = [];
      if (index === 0 && start > 0) indicators.push(`↑${start}`);
      const below = items.length - (start + windowSize);
      if (index === visibleItems.length - 1 && below > 0) indicators.push(`↓${below}`);
      const indicator = indicators.length > 0 ? this.theme.fg("dim", `${indicators.join(" ")} `) : "";
      const line = indicator + this.renderRailItem(item, item.id === this.selectedId);
      return truncateToWidth(line, width);
    });
  }

  private renderRailItem(item: AgentRecord, selected: boolean): string {
    const cursor = selected ? this.theme.fg("accent", "›") : " ";
    const record = item;
    const icon = record.status === "running"
      ? this.theme.fg("accent", "●")
      : record.status === "queued"
        ? this.theme.fg("muted", "◦")
        : record.status === "completed"
          ? this.theme.fg("success", "✓")
          : record.status === "error"
            ? this.theme.fg("error", "✗")
            : this.theme.fg("dim", "○");
    const name = getDisplayName(record.type);
    const activity = this.activity.get(record.id);
    const summary = record.status === "running" && activity
      ? describeActivity(activity.activeTools, activity.responseText)
      : record.description;
    return `${cursor} ${icon} ${selected ? this.theme.bold(name) : name}  ${this.theme.fg("dim", summary)}  ${this.theme.fg("dim", formatDuration(record.startedAt, record.completedAt))}`;
  }

  private renderHints(): string {
    const hints = [
      rawKeyHint("↑↓", "select"),
      rawKeyHint("Enter/Tab", "view/message"),
      rawKeyHint("PgUp/PgDn", "scroll"),
      rawKeyHint("x", "stop"),
      rawKeyHint("m", "manage"),
      rawKeyHint("q/Esc", "close"),
    ];
    if (this.transcript) {
      const transcriptHints = this.transcript.getToggleHints();
      hints.splice(3, 0, transcriptHints.tools, transcriptHints.thinking);
    }
    return hints.join(this.theme.fg("dim", " · "));
  }

  private fitLine(line: string, width: number): string {
    const truncated = truncateToWidth(line, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }
}

export async function openAgentNavigator(
  ctx: ExtensionContext,
  options: AgentNavigatorControllerOptions,
): Promise<void> {
  while (true) {
    let navigator: AgentNavigator | undefined;
    let escapeRequested = false;
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, Key.escape)) return undefined;
      escapeRequested = true;
      navigator?.close();
      return { consume: true };
    });

    let result: AgentNavigatorResult | undefined;
    try {
      result = await ctx.ui.custom<AgentNavigatorResult>(
        (tui, theme, keybindings, done) => {
          navigator = new AgentNavigator(
            tui,
            options.manager,
            options.activity,
            theme,
            keybindings,
            done,
            options.actions,
          );
          if (escapeRequested) queueMicrotask(() => navigator?.close());
          return navigator;
        },
        { overlay: true, overlayOptions: AGENT_NAVIGATOR_OVERLAY_OPTIONS },
      );
    } finally {
      unsubscribe();
    }

    if (result !== "manage") return;
    await options.manage(ctx);
  }
}

export function registerAgentNavigatorControls(
  pi: Pick<ExtensionAPI, "registerCommand" | "registerShortcut">,
  openNavigator: (ctx: ExtensionContext) => Promise<void>,
): void {
  pi.registerCommand("agents", {
    description: "Open the agent navigator",
    handler: async (_args, ctx) => openNavigator(ctx),
  });
  pi.registerShortcut(AGENT_NAVIGATOR_SHORTCUT, {
    description: "Open the agent navigator",
    handler: openNavigator,
  });
}
