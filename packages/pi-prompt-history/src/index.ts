import {
	migrateSessionEntries,
	parseSessionEntries,
	type ExtensionAPI,
	type ExtensionContext,
	type FileEntry,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, fuzzyFilter, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const SHORTCUT = Key.ctrl("r");
const COMMAND_SHORTCUT = Key.super("r");
const SCOPE_SHORTCUT = Key.ctrl("s");
const MAX_VISIBLE = 12;
const MAX_RESULTS = 50;
const SEARCH_BATCH_SIZE = 8;
const SEARCH_DEBOUNCE_MS = 120;

type Scope = "all" | "project" | "session";

interface PromptHistoryItem {
	id: string;
	text: string;
	cwd: string;
	sessionPath?: string;
	sessionName?: string;
	timestamp: number;
}

interface HistorySource {
	sessionDir: string;
	getCurrentItems: () => PromptHistoryItem[];
}

interface PromptSessionRef {
	path: string;
	cwd: string;
	modified: Date;
}

interface SearchState {
	items: PromptHistoryItem[];
	loading: boolean;
	scanned: number;
	total?: number;
	complete: boolean;
}

interface PromptHistoryResult {
	text: string;
}

const SCOPES: Scope[] = ["session", "project", "all"];
const SCOPE_LABELS: Record<Scope, string> = {
	all: "All projects",
	project: "Current project",
	session: "Current session",
};

export default function piPromptHistory(pi: ExtensionAPI): void {
	pi.registerShortcut(SHORTCUT, {
		description: "Search prompt history",
		handler: openPromptHistory,
	});
	pi.registerShortcut(COMMAND_SHORTCUT, {
		description: "Search prompt history",
		handler: openPromptHistory,
	});
}

async function openPromptHistory(ctx: ExtensionContext): Promise<void> {
	const source = createHistorySource(ctx);

	const result = await ctx.ui.custom<PromptHistoryResult | undefined>(
		(tui, theme, _keybindings, done) => new PromptHistoryPicker(source, theme, () => tui.requestRender(), done),
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
}

function createHistorySource(ctx: ExtensionContext): HistorySource {
	const sessionManager = ctx.sessionManager;
	const cwd = ctx.cwd;
	return {
		sessionDir: sessionManager.getSessionDir(),
		getCurrentItems: () => collectCurrentSessionPrompts(cwd, sessionManager),
	};
}

async function readSessionPrompts(session: PromptSessionRef): Promise<PromptHistoryItem[]> {
	try {
		const content = await readFile(session.path, "utf8");
		const entries = parseSessionEntries(content);
		migrateSessionEntries(entries);
		const sessionEntries = entries.filter(isSessionEntry);
		return collectPrompts(sessionEntries, {
			cwd: sessionCwd(entries, session.cwd),
			sessionPath: session.path,
			sessionName: sessionName(sessionEntries),
			timestampFallback: session.modified.getTime(),
		});
	} catch {
		return [];
	}
}

function collectCurrentSessionPrompts(cwd: string, sessionManager: ExtensionContext["sessionManager"]): PromptHistoryItem[] {
	return collectPrompts(sessionManager.getEntries(), {
		cwd: sessionManager.getCwd() || cwd,
		sessionPath: sessionManager.getSessionFile(),
		sessionName: sessionManager.getSessionName(),
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

function sessionCwd(entries: FileEntry[], fallback: string): string {
	const header = entries.find((entry) => entry.type === "session");
	return header && "cwd" in header && typeof header.cwd === "string" ? header.cwd : fallback;
}

function sessionName(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
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

function limitedPrompts(items: PromptHistoryItem[], query: string): PromptHistoryItem[] {
	const sorted = dedupeAndSort(items);
	if (!query.trim()) return sorted.slice(0, MAX_RESULTS);
	return fuzzyFilter(sorted, query, (item) => `${item.text} ${item.cwd} ${item.sessionName ?? ""}`).slice(0, MAX_RESULTS);
}

async function listSessionsForScope(source: HistorySource, scope: Scope): Promise<PromptSessionRef[]> {
	const sessions = scope === "all" ? await listAllSessionRefs(source.sessionDir) : await listSessionRefsInDir(source.sessionDir);
	return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

async function listAllSessionRefs(sessionDir: string): Promise<PromptSessionRef[]> {
	try {
		const sessionsRoot = dirname(sessionDir);
		const entries = await readdir(sessionsRoot, { withFileTypes: true });
		const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => listSessionRefsInDir(join(sessionsRoot, entry.name))));
		return nested.flat();
	} catch {
		return [];
	}
}

async function listSessionRefsInDir(sessionDir: string): Promise<PromptSessionRef[]> {
	try {
		const entries = await readdir(sessionDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => ({ path: join(sessionDir, entry.name), cwd: "", modified: sessionDateFromFileName(entry.name) }));
	} catch {
		return [];
	}
}

function sessionDateFromFileName(name: string): Date {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/.exec(name);
	const timestamp = match?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
	const time = timestamp ? new Date(timestamp).getTime() : NaN;
	return Number.isFinite(time) ? new Date(time) : new Date(0);
}

async function searchScopedHistory(
	source: HistorySource,
	scope: Scope,
	query: string,
	onProgress: (state: SearchState) => void,
	shouldContinue: () => boolean,
): Promise<SearchState> {
	if (scope === "session") {
		const state = searchState(limitedPrompts(source.getCurrentItems(), query), false, 0, undefined, true);
		onProgress(state);
		return state;
	}

	const sessions = await listSessionsForScope(source, scope);
	let scanned = 0;
	let matches: PromptHistoryItem[] = [];

	for (let index = 0; index < sessions.length && shouldContinue(); index += SEARCH_BATCH_SIZE) {
		const batch = sessions.slice(index, index + SEARCH_BATCH_SIZE);
		const nested = await Promise.all(batch.map((session) => readSessionPrompts(session)));
		scanned += batch.length;
		matches = limitedPrompts([...matches, ...nested.flat()], query);
		onProgress(searchState(matches, true, scanned, sessions.length, false));
		if (matches.length >= MAX_RESULTS) break;
	}

	return searchState(matches, false, scanned, sessions.length, scanned >= sessions.length);
}

function searchState(items: PromptHistoryItem[], loading: boolean, scanned: number, total: number | undefined, complete: boolean): SearchState {
	return { items, loading, scanned, total, complete };
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
	private scope: Scope = "session";
	private query = "";
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private searchToken = 0;
	private searchTimer?: ReturnType<typeof setTimeout>;
	private closed = false;
	private readonly states: Record<Scope, SearchState>;

	constructor(
		private readonly source: HistorySource,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: (value: PromptHistoryResult | undefined) => void,
	) {
		this.states = {
			session: searchState([], true, 0, undefined, false),
			project: searchState([], false, 0, undefined, false),
			all: searchState([], false, 0, undefined, false),
		};
		setTimeout(() => {
			if (!this.closed && this.searchToken === 0) this.scheduleSearch(0);
		}, 0);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}

		if (matchesKey(data, SHORTCUT) || matchesKey(data, COMMAND_SHORTCUT) || matchesKey(data, SCOPE_SHORTCUT)) {
			this.cycleScope();
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const selected = this.filteredItems()[this.selectedIndex];
			if (selected) {
				this.finish({ text: selected.text });
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
				this.resetSelectionAndSearch();
			}
			return;
		}

		if (matchesKey(data, Key.delete)) {
			this.query = "";
			this.resetSelectionAndSearch();
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.resetSelectionAndSearch();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const filtered = this.filteredItems();
		const state = this.states[this.scope];
		const lines: string[] = [];
		const contentWidth = Math.max(20, width - 4);
		const border = th.fg("borderMuted", "─".repeat(width));
		const scopeLabel = SCOPE_LABELS[this.scope];
		const queryText = this.query;
		const cursor = this.focused ? CURSOR_MARKER + th.fg("accent", "▌") : "";

		lines.push(border);
		lines.push(truncateToWidth(` ${th.fg("accent", th.bold("Prompt History"))} ${th.fg("muted", "·")} ${scopeLabel} ${th.fg("dim", formatCount(state))}`, width));
		lines.push(truncateToWidth(` ${th.fg("muted", "Search:")} ${queryText}${cursor}`, width));
		lines.push("");

		const start = this.visibleStart(filtered.length);
		const visible = filtered.slice(start, start + MAX_VISIBLE);
		const emptyMessage = state.loading ? th.fg("muted", "Searching prompt history…") : th.fg("warning", "No matching prompts");

		for (let i = 0; i < MAX_VISIBLE; i++) {
			if (i < visible.length) {
				const item = visible[i];
				const index = start + i;
				const selected = index === this.selectedIndex;
				const marker = selected ? th.fg("accent", "›") : " ";
				const preview = highlightMatches(formatPreview(item.text), this.query, th);
				const promptLine = selected && !this.query.trim() ? th.bold(preview) : preview;
				lines.push(truncateToWidth(` ${marker} ${promptLine}`, width));
				lines.push(truncateToWidth(`   ${th.fg("dim", formatMetadata(item))}`, contentWidth));
			} else if (i === 0) {
				lines.push(truncateToWidth(`   ${emptyMessage}`, width));
				lines.push("");
			} else {
				lines.push("");
				lines.push("");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", formatStatus(state, filtered.length, start))}`, width));
		lines.push("");
		lines.push(truncateToWidth(` ${th.fg("dim", "↑/↓ move · Enter select · Cmd/Ctrl+R scope · Esc cancel")}`, width));
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
		return this.states[this.scope].items;
	}

	private cycleScope(): void {
		const currentIndex = SCOPES.indexOf(this.scope);
		this.scope = SCOPES[(currentIndex + 1) % SCOPES.length] ?? "all";
		this.resetSelectionAndSearch(0);
	}

	private moveSelection(delta: number): void {
		const count = this.filteredItems().length;
		if (count === 0) return;
		this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		this.invalidate();
		this.requestRender();
	}

	private resetSelectionAndSearch(delayMs = SEARCH_DEBOUNCE_MS): void {
		this.selectedIndex = 0;
		this.scheduleSearch(delayMs);
	}

	private scheduleSearch(delayMs: number): void {
		this.invalidate();
		this.requestRender();
		if (this.searchTimer) clearTimeout(this.searchTimer);
		if (this.scope === "session") {
			this.searchToken++;
			this.states.session = searchState([], true, 0, undefined, false);
			this.invalidate();
			this.requestRender();
			void this.runSearch(this.searchToken, "session", this.query);
			return;
		}

		const token = ++this.searchToken;
		const scope = this.scope;
		const query = this.query;
		this.states[scope] = searchState([], true, 0, undefined, false);
		this.invalidate();
		this.requestRender();
		this.searchTimer = setTimeout(() => {
			this.searchTimer = undefined;
			void this.runSearch(token, scope, query);
		}, delayMs);
	}

	private async runSearch(token: number, scope: Scope, query: string): Promise<void> {
		const current = () => !this.closed && token === this.searchToken && scope === this.scope && query === this.query;
		const apply = (state: SearchState) => {
			if (!current()) return;
			this.states[scope] = state;
			this.clampSelection();
			this.invalidate();
			this.requestRender();
		};

		try {
			const finalState = await searchScopedHistory(this.source, scope, query, apply, current);
			apply(finalState);
		} catch {
			apply(searchState([], false, 0, undefined, true));
		}
	}

	private clampSelection(): void {
		const count = this.filteredItems().length;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, count - 1)));
	}

	private finish(value: PromptHistoryResult | undefined): void {
		this.closed = true;
		this.searchToken++;
		if (this.searchTimer) clearTimeout(this.searchTimer);
		this.searchTimer = undefined;
		this.done(value);
	}

	private visibleStart(count: number): number {
		return Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), count - MAX_VISIBLE));
	}
}

function formatPreview(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatCount(state: SearchState): string {
	if (state.total === undefined) return `(${state.items.length})`;
	const suffix = state.complete ? "" : "+";
	return `(${state.items.length}${suffix}, scanned ${state.scanned}/${state.total})`;
}

function formatStatus(state: SearchState, count: number, start: number): string {
	if (count === 0) return state.loading ? "Searching…" : "No matches";
	const range = `Showing ${start + 1}-${Math.min(start + MAX_VISIBLE, count)} of ${count}`;
	return state.loading ? `${range} · searching more…` : range;
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
