import {
	SessionManager,
	migrateSessionEntries,
	parseSessionEntries,
	type ExtensionAPI,
	type ExtensionContext,
	type FileEntry,
	type SessionEntry,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, fuzzyFilter, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const SHORTCUT = Key.ctrl("r");
const SCOPE_SHORTCUT = Key.ctrl("s");
const MAX_VISIBLE = 12;

type Scope = "all" | "project" | "session";

interface PromptHistoryItem {
	id: string;
	text: string;
	cwd: string;
	sessionPath?: string;
	sessionName?: string;
	timestamp: number;
}

type ItemsByScope = Record<Scope, PromptHistoryItem[]>;

interface PromptHistoryResult {
	text: string;
}

const SCOPES: Scope[] = ["all", "project", "session"];
const SCOPE_LABELS: Record<Scope, string> = {
	all: "All projects",
	project: "Current project",
	session: "Current session",
};

export default function piPromptHistory(pi: ExtensionAPI): void {
	pi.registerShortcut(SHORTCUT, {
		description: "Search prompt history",
		handler: async (ctx) => {
			const itemsByScope = await loadHistory(ctx);
			if (itemsByScope.all.length === 0) {
				ctx.ui.notify("No prompt history found", "info");
				return;
			}

			const result = await ctx.ui.custom<PromptHistoryResult | undefined>(
				(tui, theme, _keybindings, done) => new PromptHistoryPicker(itemsByScope, theme, () => tui.requestRender(), done),
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 64,
						maxHeight: "90%",
						margin: 2,
					},
				},
			);

			if (result) {
				ctx.ui.setEditorText(result.text);
			}
		},
	});
}

async function loadHistory(ctx: ExtensionContext): Promise<ItemsByScope> {
	const currentItems = collectCurrentSessionPrompts(ctx);
	const [allSessions, projectSessions] = await Promise.all([
		SessionManager.listAll(),
		SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()),
	]);

	const [allFileItems, projectFileItems] = await Promise.all([loadSessionPrompts(allSessions), loadSessionPrompts(projectSessions)]);

	return {
		all: dedupeAndSort([...allFileItems, ...currentItems]),
		project: dedupeAndSort([...projectFileItems, ...currentItems]),
		session: dedupeAndSort(currentItems),
	};
}

async function loadSessionPrompts(sessions: SessionInfo[]): Promise<PromptHistoryItem[]> {
	const nested = await Promise.all(sessions.map((session) => readSessionPrompts(session)));
	return nested.flat();
}

async function readSessionPrompts(session: SessionInfo): Promise<PromptHistoryItem[]> {
	try {
		const content = await readFile(session.path, "utf8");
		const entries = parseSessionEntries(content);
		migrateSessionEntries(entries);
		const sessionEntries = entries.filter(isSessionEntry);
		return collectPrompts(sessionEntries, {
			cwd: session.cwd,
			sessionPath: session.path,
			sessionName: session.name,
			timestampFallback: session.modified.getTime(),
		});
	} catch {
		return [];
	}
}

function collectCurrentSessionPrompts(ctx: ExtensionContext): PromptHistoryItem[] {
	return collectPrompts(ctx.sessionManager.getEntries(), {
		cwd: ctx.sessionManager.getCwd() || ctx.cwd,
		sessionPath: ctx.sessionManager.getSessionFile(),
		sessionName: ctx.sessionManager.getSessionName(),
		timestampFallback: Date.now(),
	});
}

function collectPrompts(
	entries: SessionEntry[],
	metadata: { cwd: string; sessionPath?: string; sessionName?: string; timestampFallback: number },
): PromptHistoryItem[] {
	const items: PromptHistoryItem[] = [];
	const cwd = normalizeCwd(metadata.cwd);

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;

		const text = extractUserText(entry.message.content).trim();
		if (!text) continue;

		items.push({
			id: `${metadata.sessionPath ?? "current"}:${entry.id}`,
			text,
			cwd,
			sessionPath: metadata.sessionPath,
			sessionName: metadata.sessionName,
			timestamp: parseTimestamp(entry.timestamp, metadata.timestampFallback),
		});
	}

	return items;
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
	return entry.type !== "session";
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const maybeText = part as { type?: unknown; text?: unknown };
			return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
		})
		.join("");
}

function dedupeAndSort(items: PromptHistoryItem[]): PromptHistoryItem[] {
	const seen = new Set<string>();
	const sorted = [...items].sort((left, right) => right.timestamp - left.timestamp);
	const result: PromptHistoryItem[] = [];

	for (const item of sorted) {
		if (seen.has(item.text)) continue;
		seen.add(item.text);
		result.push(item);
	}

	return result;
}

function normalizeCwd(cwd: string): string {
	return cwd ? resolve(cwd) : "";
}

function parseTimestamp(value: string, fallback: number): number {
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

class PromptHistoryPicker implements Component, Focusable {
	focused = false;
	private scope: Scope = "all";
	private query = "";
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly itemsByScope: ItemsByScope,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: (value: PromptHistoryResult | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, SCOPE_SHORTCUT)) {
			this.cycleScope();
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const selected = this.filteredItems()[this.selectedIndex];
			if (selected) {
				this.done({ text: selected.text });
			}
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.moveSelection(1);
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.moveSelection(-MAX_VISIBLE);
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.moveSelection(MAX_VISIBLE);
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			if (this.query.length > 0) {
				this.query = Array.from(this.query).slice(0, -1).join("");
				this.resetSelection();
			}
			return;
		}

		if (matchesKey(data, Key.delete)) {
			this.query = "";
			this.resetSelection();
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.resetSelection();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const filtered = this.filteredItems();
		const lines: string[] = [];
		const contentWidth = Math.max(20, width - 4);
		const border = th.fg("borderMuted", "─".repeat(width));
		const scopeLabel = SCOPE_LABELS[this.scope];
		const queryText = this.query;
		const cursor = this.focused ? CURSOR_MARKER + th.fg("accent", "▌") : "";

		lines.push(border);
		lines.push(truncateToWidth(` ${th.fg("accent", th.bold("Prompt History"))} ${th.fg("muted", "·")} ${scopeLabel} ${th.fg("dim", `(${filtered.length}/${this.itemsByScope[this.scope].length})`)}`, width));
		lines.push(truncateToWidth(` ${th.fg("muted", "Search:")} ${queryText}${cursor}`, width));
		lines.push("");

		if (filtered.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("warning", "No matching prompts")}`, width));
		} else {
			const start = this.visibleStart(filtered.length);
			const visible = filtered.slice(start, start + MAX_VISIBLE);

			for (let i = 0; i < visible.length; i++) {
				const item = visible[i];
				const index = start + i;
				const selected = index === this.selectedIndex;
				const marker = selected ? th.fg("accent", "›") : " ";
				const preview = highlightMatches(formatPreview(item.text), this.query, th);
				const promptLine = selected && !this.query.trim() ? th.bold(preview) : preview;
				lines.push(truncateToWidth(` ${marker} ${promptLine}`, width));
				lines.push(truncateToWidth(`   ${th.fg("dim", formatMetadata(item))}`, contentWidth));
			}

			if (filtered.length > MAX_VISIBLE) {
				lines.push("");
				lines.push(truncateToWidth(`  ${th.fg("dim", `Showing ${start + 1}-${Math.min(start + MAX_VISIBLE, filtered.length)} of ${filtered.length}`)}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(` ${th.fg("dim", "↑/↓ move · Enter select · Ctrl+S scope · Esc cancel")}`, width));
		lines.push(border);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private filteredItems(): PromptHistoryItem[] {
		const items = this.itemsByScope[this.scope];
		if (!this.query.trim()) return items;
		return fuzzyFilter(items, this.query, (item) => `${item.text} ${item.cwd} ${item.sessionName ?? ""}`);
	}

	private cycleScope(): void {
		const currentIndex = SCOPES.indexOf(this.scope);
		this.scope = SCOPES[(currentIndex + 1) % SCOPES.length] ?? "all";
		this.resetSelection();
	}

	private moveSelection(delta: number): void {
		const count = this.filteredItems().length;
		if (count === 0) return;
		this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		this.invalidate();
		this.requestRender();
	}

	private resetSelection(): void {
		this.selectedIndex = 0;
		this.invalidate();
		this.requestRender();
	}

	private visibleStart(count: number): number {
		return Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), count - MAX_VISIBLE));
	}
}

function formatPreview(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function highlightMatches(text: string, query: string, theme: Theme): string {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return text;

	const chars = Array.from(text);
	const lowerChars = chars.map((char) => char.toLocaleLowerCase());
	const highlighted = new Set<number>();

	for (const token of tokens) {
		markTokenMatches(lowerChars, Array.from(token), highlighted);
	}

	let result = "";
	let run = "";
	let runHighlighted = highlighted.has(0);

	for (let i = 0; i < chars.length; i++) {
		const currentHighlighted = highlighted.has(i);
		if (currentHighlighted !== runHighlighted) {
			result += styleHighlightRun(run, runHighlighted, theme);
			run = "";
			runHighlighted = currentHighlighted;
		}
		run += chars[i];
	}

	return result + styleHighlightRun(run, runHighlighted, theme);
}

function markTokenMatches(lowerChars: string[], token: string[], highlighted: Set<number>): void {
	if (token.length === 0) return;

	for (let start = 0; start <= lowerChars.length - token.length; start++) {
		let matches = true;
		for (let offset = 0; offset < token.length; offset++) {
			if (lowerChars[start + offset] !== token[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			for (let offset = 0; offset < token.length; offset++) {
				highlighted.add(start + offset);
			}
			return;
		}
	}

	const positions: number[] = [];
	let searchFrom = 0;
	for (const char of token) {
		const index = lowerChars.findIndex((candidate, candidateIndex) => candidateIndex >= searchFrom && candidate === char);
		if (index === -1) return;
		positions.push(index);
		searchFrom = index + 1;
	}

	for (const position of positions) highlighted.add(position);
}

function styleHighlightRun(text: string, highlighted: boolean, theme: Theme): string {
	return highlighted ? theme.fg("accent", theme.bold(text)) : text;
}

function formatMetadata(item: PromptHistoryItem): string {
	const project = item.cwd ? basename(item.cwd) || item.cwd : "unknown project";
	const session = item.sessionName?.trim() || (item.sessionPath ? basename(item.sessionPath) : "current session");
	const date = new Date(item.timestamp).toLocaleString();
	return `${project} · ${session} · ${date}`;
}
