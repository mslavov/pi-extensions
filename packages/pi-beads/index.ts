import { execFile, type ExecFileException } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "beads-status";
const ACTIVE_STATUSES = "open,in_progress,blocked,deferred";
const DEFAULT_LIMIT = 50;
const REFRESH_INTERVAL_MS = 10_000;
const MUTATION_REFRESH_DELAY_MS = 500;
const OVERLAY_SHORTCUT = Key.ctrlShift("b");
const LEGACY_OVERLAY_SHORTCUT = Key.ctrlShift("d");

const PROMPT = `Beads task tracking is available through the preinstalled beads skill and bd CLI.
Use the beads skill plus direct bd CLI commands for persistent task management when work should be tracked across sessions or has dependencies.
The pi-beads extension is display-only: it shows current-project Beads status in the TUI.
Manage Beads through the beads skill and direct bd CLI commands: bd create, bd update, bd close, bd link/dep, bd ready, and bd show.`;

type BeadStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed";

type SnapshotState = "ok" | "missing_database" | "cli_missing" | "error";

interface BeadIssue {
	id: string;
	title: string;
	status: BeadStatus;
	priority?: number;
	issueType?: string;
	labels?: string[];
	updatedAt?: string;
	dependencyCount?: number;
	dependentCount?: number;
}

interface BeadsSummary {
	totalIssues: number;
	openIssues: number;
	inProgressIssues: number;
	blockedIssues: number;
	deferredIssues: number;
	closedIssues: number;
	readyIssues: number;
}

interface BeadsSnapshot {
	state: SnapshotState;
	message?: string;
	summary: BeadsSummary;
	active: BeadIssue[];
	ready: BeadIssue[];
	refreshedAt: Date;
}

interface BdResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	missingDatabase: boolean;
	cliMissing: boolean;
	error?: string;
}

interface RefreshTarget {
	cwd: string;
	ui: ExtensionContext["ui"];
	hasUI: boolean;
	signal?: AbortSignal;
}

const emptySummary: BeadsSummary = {
	totalIssues: 0,
	openIssues: 0,
	inProgressIssues: 0,
	blockedIssues: 0,
	deferredIssues: 0,
	closedIssues: 0,
	readyIssues: 0,
};

class BeadsOverlay {
	private snapshot: BeadsSnapshot;
	private theme: Theme;
	private onClose: () => void;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(snapshot: BeadsSnapshot, theme: Theme, onClose: () => void) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, Key.ctrlShift("d"))) {
			this.onClose();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollOffset++;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;
		const title = th.fg("accent", ` Beads ${th.fg("muted", statusTitle(this.snapshot))} `);
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 18)));

		lines.push("");
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.snapshot.state !== "ok") {
			lines.push(truncateToWidth(`  ${stateIcon(this.snapshot.state, th)} ${stateMessage(this.snapshot)}`, width));
			lines.push("");
			if (this.snapshot.state === "missing_database") {
				lines.push(truncateToWidth(`  ${th.fg("muted", "No .beads database was found for this project.")}`, width));
				lines.push(truncateToWidth(`  ${th.fg("muted", "Use the beads skill and run bd init if you want to track this project.")}`, width));
			}
			this.pushFooter(lines, width);
			return this.cache(width, lines);
		}

		const summary = this.snapshot.summary;
		lines.push(
			truncateToWidth(
				`  ${th.fg("text", `${summary.openIssues} open`)}  ${th.fg("accent", `${summary.inProgressIssues} in progress`)}  ${th.fg("warning", `${summary.blockedIssues} blocked`)}  ${th.fg("muted", `${summary.deferredIssues} deferred`)}  ${th.fg("success", `${summary.readyIssues} ready`)}`,
				width,
			),
		);
		lines.push("");

		if (this.snapshot.active.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No active beads.")}`, width));
		} else {
			const maxVisible = 12;
			const maxScroll = Math.max(0, this.snapshot.active.length - maxVisible);
			if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

			const readyIds = new Set(this.snapshot.ready.map((issue) => issue.id));
			const visible = this.snapshot.active.slice(this.scrollOffset, this.scrollOffset + maxVisible);
			for (let i = 0; i < visible.length; i++) {
				const issue = visible[i];
				const idx = this.scrollOffset + i + 1;
				const num = th.fg("dim", `${String(idx).padStart(2)}.`);
				const icon = statusIcon(issue.status, th);
				const id = th.fg("muted", issue.id);
				const priority = issue.priority === undefined ? "" : th.fg("dim", ` P${issue.priority}`);
				const ready = readyIds.has(issue.id) ? th.fg("success", " ready") : "";
				lines.push(truncateToWidth(`  ${num} ${icon} ${id}${priority} ${issueTitle(issue, th)}${ready}`, width));
			}

			if (this.snapshot.active.length > maxVisible) {
				lines.push("");
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `Showing ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxVisible, this.snapshot.active.length)} of ${this.snapshot.active.length} · ↑/↓ to scroll`)}`,
						width,
					),
				);
			}
		}

		this.pushFooter(lines, width);
		return this.cache(width, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setSnapshot(snapshot: BeadsSnapshot): void {
		this.snapshot = snapshot;
		this.invalidate();
	}

	private pushFooter(lines: string[], width: number): void {
		lines.push("");
		lines.push(truncateToWidth(`  ${this.theme.fg("dim", `Refreshed ${formatTime(this.snapshot.refreshedAt)} · Esc or Ctrl+Shift+B to close`)}`, width));
		lines.push("");
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function beadsExtension(pi: ExtensionAPI): void {
	const globals = globalThis as typeof globalThis & { __piBeadsCleanup?: () => void };
	globals.__piBeadsCleanup?.();

	let currentTarget: RefreshTarget | undefined;
	let snapshot: BeadsSnapshot = missingSnapshot("Not refreshed yet.");
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let queuedRefresh = false;
	let mutationRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	const mutationToolCalls = new Set<string>();
	let activeOverlay: { overlay: BeadsOverlay; requestRender: () => void } | undefined;

	function createTarget(ctx: ExtensionContext): RefreshTarget {
		return { cwd: ctx.cwd, ui: ctx.ui, hasUI: ctx.hasUI, signal: ctx.signal };
	}

	async function refresh(target: RefreshTarget): Promise<void> {
		snapshot = await readBeadsSnapshot(target.cwd, target.signal);
		updateWidget(target);
		activeOverlay?.overlay.setSnapshot(snapshot);
		activeOverlay?.requestRender();
	}

	function requestRefresh(target: RefreshTarget): Promise<void> {
		currentTarget = target;
		if (refreshPromise) {
			queuedRefresh = true;
			return refreshPromise;
		}

		refreshPromise = refresh(target)
			.catch(() => undefined)
			.finally(() => {
				refreshPromise = undefined;
				if (queuedRefresh && currentTarget) {
					queuedRefresh = false;
					void requestRefresh(currentTarget);
				}
			});
		return refreshPromise;
	}

	function scheduleMutationRefresh(target: RefreshTarget): void {
		currentTarget = target;
		if (mutationRefreshTimer) clearTimeout(mutationRefreshTimer);
		mutationRefreshTimer = setTimeout(() => {
			mutationRefreshTimer = undefined;
			if (currentTarget) void requestRefresh(currentTarget);
		}, MUTATION_REFRESH_DELAY_MS);
	}

	function startRefreshTimer(target: RefreshTarget): void {
		currentTarget = target;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (currentTarget) void requestRefresh(currentTarget);
		}, REFRESH_INTERVAL_MS);
	}

	function clearTimers(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		if (mutationRefreshTimer) clearTimeout(mutationRefreshTimer);
		refreshTimer = undefined;
		mutationRefreshTimer = undefined;
	}

	function cleanup(): void {
		clearTimers();
		try {
			currentTarget?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Cleanup may run after the old extension context has already been invalidated.
		}
		currentTarget = undefined;
		activeOverlay = undefined;
		mutationToolCalls.clear();
		if (globals.__piBeadsCleanup === cleanup) globals.__piBeadsCleanup = undefined;
	}

	globals.__piBeadsCleanup = cleanup;

	function updateWidget(target: RefreshTarget): void {
		const th = target.ui.theme;
		const parts: string[] = [th.fg("muted", "🧿")];

		if (snapshot.state !== "ok") {
			parts.push(stateIcon(snapshot.state, th));
			parts.push(th.fg(snapshot.state === "missing_database" ? "muted" : "warning", shortStateMessage(snapshot)));
			parts.push(th.fg("dim", "Ctrl+Shift+B"));
			target.ui.setWidget(WIDGET_KEY, [parts.join("  ")]);
			return;
		}

		const summary = snapshot.summary;
		const current = snapshot.active.find((issue) => issue.status === "in_progress");
		parts.push(th.fg("accent", `${snapshot.active.length} active`));
		parts.push(th.fg("success", `${summary.readyIssues} ready`));
		if (summary.blockedIssues > 0) parts.push(th.fg("warning", `${summary.blockedIssues} blocked`));
		if (current) parts.push(th.fg("accent", "▸ ") + th.fg("text", current.title));
		parts.push(th.fg("dim", "Ctrl+Shift+B"));
		target.ui.setWidget(WIDGET_KEY, [parts.join("  ")]);
	}

	async function showOverlay(ctx: ExtensionContext): Promise<void> {
		let overlay: BeadsOverlay | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				overlay = new BeadsOverlay(snapshot, theme, () => done());
				activeOverlay = { overlay, requestRender: () => tui.requestRender() };
				return overlay;
			});
		} finally {
			if (overlay && activeOverlay?.overlay === overlay) activeOverlay = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		const target = createTarget(ctx);
		startRefreshTimer(target);
		void requestRefresh(target);
	});

	pi.on("session_tree", (_event, ctx) => {
		const target = createTarget(ctx);
		startRefreshTimer(target);
		void requestRefresh(target);
	});

	pi.on("agent_end", (_event, ctx) => {
		void requestRefresh(createTarget(ctx));
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + PROMPT,
		};
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash" && event.toolName !== "exec_command") return;
		const command = commandFromInput(event.input);
		if (command && isBdMutationCommand(command)) mutationToolCalls.add(event.toolCallId);
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "bash" && event.toolName !== "exec_command") return;
		const command = commandFromInput(event.args);
		if (command && isBdMutationCommand(command)) mutationToolCalls.add(event.toolCallId);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!mutationToolCalls.delete(event.toolCallId)) return;
		scheduleMutationRefresh(createTarget(ctx));
	});

	pi.on("user_bash", async (event, ctx) => {
		if (isBdMutationCommand(event.command)) scheduleMutationRefresh(createTarget(ctx));
	});

	const openStatusOverlay = {
		description: "Toggle Beads task status",
		handler: async (ctx: ExtensionContext) => {
			const target = createTarget(ctx);
			await requestRefresh(target);
			if (!target.hasUI) {
				target.ui.notify(compactSummary(snapshot), snapshot.state === "ok" ? "info" : "warning");
				return;
			}
			await showOverlay(ctx);
		},
	};

	pi.registerShortcut(OVERLAY_SHORTCUT, openStatusOverlay);
	pi.registerShortcut(LEGACY_OVERLAY_SHORTCUT, {
		...openStatusOverlay,
		description: "Toggle Beads task status (legacy shortcut)",
	});

	pi.registerCommand("beads", {
		description: "Show Beads status: /beads | /beads status | /beads refresh",
		handler: async (args, ctx) => {
			const target = createTarget(ctx);
			await requestRefresh(target);

			const command = args?.trim() || "show";
			if (command === "status" || command === "refresh") {
				target.ui.notify(compactSummary(snapshot), snapshot.state === "ok" ? "info" : "warning");
				return;
			}

			if (command !== "show") {
				target.ui.notify("Usage: /beads | /beads status | /beads refresh", "error");
				return;
			}

			if (!target.hasUI) {
				target.ui.notify(compactSummary(snapshot), snapshot.state === "ok" ? "info" : "warning");
				return;
			}

			await showOverlay(ctx);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanup();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}

async function readBeadsSnapshot(cwd: string, signal?: AbortSignal): Promise<BeadsSnapshot> {
	const statusResult = await runBd(cwd, ["status", "--no-activity"], signal);
	if (statusResult.cliMissing) return errorSnapshot("bd CLI was not found in PATH.", "cli_missing");
	if (statusResult.missingDatabase) return missingSnapshot("No Beads database found for this project.");
	if (!statusResult.ok) return errorSnapshot((statusResult.error ?? statusResult.stderr) || "bd status failed.");

	const summary = parseSummary(parseJson(statusResult.stdout));
	const [listResult, readyResult] = await Promise.all([
		runBd(cwd, ["list", "--status", ACTIVE_STATUSES, "--limit", String(DEFAULT_LIMIT), "--flat", "--no-pager"], signal),
		runBd(cwd, ["ready", "--limit", String(DEFAULT_LIMIT)], signal),
	]);

	if (listResult.cliMissing || readyResult.cliMissing) return errorSnapshot("bd CLI was not found in PATH.", "cli_missing");
	if (listResult.missingDatabase || readyResult.missingDatabase) return missingSnapshot("No Beads database found for this project.");
	if (!listResult.ok) return errorSnapshot((listResult.error ?? listResult.stderr) || "bd list failed.");
	if (!readyResult.ok) return errorSnapshot((readyResult.error ?? readyResult.stderr) || "bd ready failed.");

	const active = normalizeIssues(parseJson(listResult.stdout));
	const ready = normalizeIssues(parseJson(readyResult.stdout));
	return {
		state: "ok",
		summary: { ...summary, readyIssues: summary.readyIssues || ready.length },
		active,
		ready,
		refreshedAt: new Date(),
	};
}

function runBd(cwd: string, args: string[], signal?: AbortSignal): Promise<BdResult> {
	return new Promise((resolve) => {
		execFile(
			"bd",
			["-C", cwd, "--readonly", "--json", ...args],
			{ encoding: "utf8", maxBuffer: 1024 * 1024, signal },
			(error: ExecFileException | null, stdout: string, stderr: string) => {
				const combined = `${stdout}\n${stderr}`;
				const cliMissing = error?.code === "ENOENT";
				resolve({
					ok: !error,
					stdout,
					stderr,
					missingDatabase: isMissingDatabase(combined),
					cliMissing,
					error: error?.message,
				});
			},
		);
	});
}

function isMissingDatabase(text: string): boolean {
	return /no beads database found|no beads project found|No active beads workspace found|no \.beads directory found|cannot resolve repo context/i.test(text);
}

function commandFromInput(input: unknown): string | undefined {
	const object = asRecord(input);
	if (!object) return undefined;
	const command = object.command ?? object.cmd;
	return typeof command === "string" ? command : undefined;
}

function isBdMutationCommand(command: string): boolean {
	return /(?:^|[;&|({}\s])bd\b(?=[^;&|]*\b(?:init|create|new|q|update|close|done|link|dep|delete|reopen|assign|priority|tag|label|note|comment|edit|set-state|sync|todo\s+(?:add|create|update|close|done|delete))\b)/.test(command);
}

function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = Math.min(...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((idx) => idx >= 0));
		if (!Number.isFinite(start)) return undefined;
		try {
			return JSON.parse(trimmed.slice(start));
		} catch {
			return undefined;
		}
	}
}

function parseSummary(value: unknown): BeadsSummary {
	const object = asRecord(value);
	const source = asRecord(object?.summary) ?? object;
	if (!source) return { ...emptySummary };
	return {
		totalIssues: numberField(source.total_issues),
		openIssues: numberField(source.open_issues),
		inProgressIssues: numberField(source.in_progress_issues),
		blockedIssues: numberField(source.blocked_issues),
		deferredIssues: numberField(source.deferred_issues),
		closedIssues: numberField(source.closed_issues),
		readyIssues: numberField(source.ready_issues),
	};
}

function normalizeIssues(value: unknown): BeadIssue[] {
	const items = issueArray(value);
	return items.map(toIssue).filter((issue): issue is BeadIssue => issue !== undefined);
}

function issueArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const object = asRecord(value);
	if (!object) return [];
	for (const key of ["issues", "items", "data", "results"]) {
		const maybeArray = object[key];
		if (Array.isArray(maybeArray)) return maybeArray;
	}
	return typeof object.id === "string" ? [object] : [];
}

function toIssue(value: unknown): BeadIssue | undefined {
	const object = asRecord(value);
	if (!object || typeof object.id !== "string") return undefined;
	const title = typeof object.title === "string" ? object.title : object.id;
	const labels = Array.isArray(object.labels) ? object.labels.filter((label): label is string => typeof label === "string") : undefined;
	return {
		id: object.id,
		title,
		status: parseStatus(object.status),
		priority: typeof object.priority === "number" ? object.priority : undefined,
		issueType: typeof object.issue_type === "string" ? object.issue_type : typeof object.type === "string" ? object.type : undefined,
		labels,
		updatedAt: typeof object.updated_at === "string" ? object.updated_at : undefined,
		dependencyCount: typeof object.dependency_count === "number" ? object.dependency_count : undefined,
		dependentCount: typeof object.dependent_count === "number" ? object.dependent_count : undefined,
	};
}

function parseStatus(value: unknown): BeadStatus {
	switch (value) {
		case "in_progress":
		case "blocked":
		case "deferred":
		case "closed":
		case "open":
			return value;
		default:
			return "open";
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function missingSnapshot(message: string): BeadsSnapshot {
	return { state: "missing_database", message, summary: { ...emptySummary }, active: [], ready: [], refreshedAt: new Date() };
}

function errorSnapshot(message: string, state: SnapshotState = "error"): BeadsSnapshot {
	return { state, message, summary: { ...emptySummary }, active: [], ready: [], refreshedAt: new Date() };
}

function compactSummary(snapshot: BeadsSnapshot): string {
	if (snapshot.state !== "ok") return `Beads: ${shortStateMessage(snapshot)}`;
	const summary = snapshot.summary;
	return `Beads: ${snapshot.active.length} active, ${summary.readyIssues} ready, ${summary.inProgressIssues} in progress, ${summary.blockedIssues} blocked`;
}

function statusTitle(snapshot: BeadsSnapshot): string {
	if (snapshot.state !== "ok") return shortStateMessage(snapshot);
	return `${snapshot.active.length} active · ${snapshot.summary.readyIssues} ready`;
}

function shortStateMessage(snapshot: BeadsSnapshot): string {
	switch (snapshot.state) {
		case "missing_database":
			return "No beads database";
		case "cli_missing":
			return "bd not found";
		case "error":
			return snapshot.message ?? "bd status failed";
		case "ok":
			return "Ready";
	}
}

function stateMessage(snapshot: BeadsSnapshot): string {
	return snapshot.message ?? shortStateMessage(snapshot);
}

function statusIcon(status: BeadStatus, theme: Theme): string {
	switch (status) {
		case "closed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "◐");
		case "blocked":
			return theme.fg("warning", "●");
		case "deferred":
			return theme.fg("dim", "❄");
		case "open":
			return theme.fg("muted", "○");
	}
}

function stateIcon(state: SnapshotState, theme: Theme): string {
	switch (state) {
		case "ok":
			return theme.fg("success", "✓");
		case "missing_database":
			return theme.fg("dim", "○");
		case "cli_missing":
		case "error":
			return theme.fg("warning", "!");
	}
}

function issueTitle(issue: BeadIssue, theme: Theme): string {
	if (issue.status === "in_progress") return theme.fg("text", issue.title);
	if (issue.status === "blocked") return theme.fg("warning", issue.title);
	if (issue.status === "deferred") return theme.fg("dim", issue.title);
	return theme.fg("muted", issue.title);
}

function formatTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
