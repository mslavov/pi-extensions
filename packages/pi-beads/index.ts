import { execFile, type ExecFileException } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const WIDGET_KEY = "beads-status";
const ACTIVE_STATUSES = "open,in_progress,blocked,deferred";
const DEFAULT_LIMIT = 50;
const REFRESH_INTERVAL_MS = 10_000;
const MUTATION_REFRESH_DELAY_MS = 500;
const OVERLAY_SHORTCUT = Key.ctrlShift("b");
const LEGACY_OVERLAY_SHORTCUT = Key.ctrlShift("d");
const LIST_VISIBLE_COUNT = 12;
const DETAIL_VISIBLE_COUNT = 16;
const GRAPH_VISIBLE_COUNT = 16;

const PROMPT = `Beads task tracking is available through the preinstalled beads skill and bd CLI.
Use the beads skill plus direct bd CLI commands for persistent task management when work should be tracked across sessions or has dependencies.
The pi-beads extension is display-only: it shows current-project Beads status in the TUI.
Manage Beads through the beads skill and direct bd CLI commands: bd create, bd update, bd close, bd link/dep, bd ready, and bd show.`;

type BeadStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed";

type SnapshotState = "ok" | "loading" | "missing_database" | "cli_missing" | "error";

type OverlayMode = "list" | "detail" | "graph";

type LoadStatus = "idle" | "loading" | "loaded" | "error";

interface BeadDependency {
	issueId: string;
	dependsOnId: string;
	type?: string;
}

interface BeadIssue {
	id: string;
	title: string;
	status: BeadStatus;
	priority?: number;
	issueType?: string;
	description?: string;
	acceptanceCriteria?: string;
	notes?: string;
	assignee?: string;
	owner?: string;
	labels?: string[];
	createdAt?: string;
	updatedAt?: string;
	startedAt?: string;
	closedAt?: string;
	closeReason?: string;
	dependencyCount?: number;
	dependentCount?: number;
	commentCount?: number;
	dependencies: BeadDependency[];
	detailStatus?: LoadStatus;
	detailError?: string;
}

interface BeadGraphNode {
	id: string;
	title: string;
	status?: BeadStatus;
	external: boolean;
	layer: number;
}

interface BeadGraphEdge {
	from: string;
	to: string;
	type?: string;
}

interface BeadDependencyGraph {
	nodes: BeadGraphNode[];
	edges: BeadGraphEdge[];
	layers: string[][];
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
	graph: BeadDependencyGraph;
	graphStatus: LoadStatus;
	graphError?: string;
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
	private requestRender: () => void;
	private onLoadDetail: (issueId: string) => void;
	private onLoadGraph: () => void;
	private mode: OverlayMode = "list";
	private selectedIssueId: string | undefined;
	private listScrollOffset = 0;
	private detailScrollOffset = 0;
	private graphScrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		snapshot: BeadsSnapshot,
		theme: Theme,
		onClose: () => void,
		requestRender: () => void,
		onLoadDetail: (issueId: string) => void,
		onLoadGraph: () => void,
	) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.onClose = onClose;
		this.requestRender = requestRender;
		this.onLoadDetail = onLoadDetail;
		this.onLoadGraph = onLoadGraph;
		this.ensureSelection();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, OVERLAY_SHORTCUT) || matchesKey(data, LEGACY_OVERLAY_SHORTCUT)) {
			this.onClose();
			return;
		}

		if (this.snapshot.state !== "ok") return;

		if (this.mode === "detail") {
			this.handleDetailInput(data);
		} else if (this.mode === "graph") {
			this.handleGraphInput(data);
		} else {
			this.handleListInput(data);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		this.ensureSelection();

		const lines: string[] = [];
		const th = this.theme;
		const mode = this.snapshot.state === "ok" ? th.fg("dim", ` · ${this.mode}`) : "";
		const title = th.fg("accent", ` Beads ${th.fg("muted", statusTitle(this.snapshot))}${mode} `);
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 28)));

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

		this.pushSummary(lines, width);

		if (this.mode === "detail") {
			this.renderDetail(lines, width);
		} else if (this.mode === "graph") {
			this.renderGraph(lines, width);
		} else {
			this.renderList(lines, width);
		}

		this.pushFooter(lines, width);
		return this.cache(width, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setSnapshot(snapshot: BeadsSnapshot): void {
		const selectedIssueId = this.selectedIssueId;
		this.snapshot = snapshot;
		if (snapshot.state !== "ok") {
			this.selectedIssueId = undefined;
			this.mode = "list";
		} else if (selectedIssueId && snapshot.active.some((issue) => issue.id === selectedIssueId)) {
			this.selectedIssueId = selectedIssueId;
		} else {
			this.selectedIssueId = snapshot.active[0]?.id;
			if (!this.selectedIssueId) this.mode = "list";
		}
		this.ensureSelection();
		this.invalidate();
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.moveSelection(1);
		} else if (matchesKey(data, Key.home)) {
			this.setSelection(0);
		} else if (matchesKey(data, Key.end)) {
			this.setSelection(this.snapshot.active.length - 1);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.enterDetail();
		} else if (matchesKey(data, "g")) {
			this.enterGraph();
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.left)) {
			this.mode = "list";
			this.refresh();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.detailScrollOffset > 0) {
				this.detailScrollOffset--;
				this.refresh();
			}
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.detailScrollOffset++;
			this.refresh();
		} else if (matchesKey(data, Key.home)) {
			this.detailScrollOffset = 0;
			this.refresh();
		} else if (matchesKey(data, Key.end)) {
			this.detailScrollOffset = Number.MAX_SAFE_INTEGER;
			this.refresh();
		} else if (matchesKey(data, "g")) {
			this.enterGraph();
		}
	}

	private handleGraphInput(data: string): void {
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.left)) {
			this.mode = "list";
			this.refresh();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.enterDetail();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.graphScrollOffset > 0) {
				this.graphScrollOffset--;
				this.refresh();
			}
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.graphScrollOffset++;
			this.refresh();
		} else if (matchesKey(data, Key.home)) {
			this.graphScrollOffset = 0;
			this.refresh();
		} else if (matchesKey(data, Key.end)) {
			this.graphScrollOffset = Number.MAX_SAFE_INTEGER;
			this.refresh();
		}
	}

	private pushSummary(lines: string[], width: number): void {
		const summary = this.snapshot.summary;
		const th = this.theme;
		lines.push(
			truncateToWidth(
				`  ${th.fg("text", `${summary.openIssues} open`)}  ${th.fg("accent", `${summary.inProgressIssues} in progress`)}  ${th.fg("warning", `${summary.blockedIssues} blocked`)}  ${th.fg("muted", `${summary.deferredIssues} deferred`)}  ${th.fg("success", `${summary.readyIssues} ready`)}`,
				width,
			),
		);
		lines.push("");
	}

	private renderList(lines: string[], width: number): void {
		const th = this.theme;
		if (this.snapshot.active.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No active beads.")}`, width));
			return;
		}

		this.ensureSelection();
		this.clampListScroll();

		const readyIds = new Set(this.snapshot.ready.map((issue) => issue.id));
		const visible = this.snapshot.active.slice(this.listScrollOffset, this.listScrollOffset + LIST_VISIBLE_COUNT);
		const selectedIndex = this.selectedIndex();
		for (let i = 0; i < visible.length; i++) {
			const issue = visible[i];
			const idx = this.listScrollOffset + i;
			const selected = idx === selectedIndex;
			const cursor = selected ? th.fg("accent", "›") : " ";
			const num = th.fg(selected ? "accent" : "dim", `${String(idx + 1).padStart(2)}.`);
			const icon = statusIcon(issue.status, th);
			const id = th.fg(selected ? "accent" : "muted", issue.id);
			const priority = issue.priority === undefined ? "" : th.fg("dim", ` P${issue.priority}`);
			const ready = readyIds.has(issue.id) ? th.fg("success", " ready") : "";
			const counts = issueCounts(issue, th);
			const title = selected ? th.fg("text", issue.title) : issueTitle(issue, th);
			lines.push(truncateToWidth(`  ${cursor} ${num} ${icon} ${id}${priority} ${title}${ready}${counts}`, width));
		}

		if (this.snapshot.active.length > LIST_VISIBLE_COUNT) {
			lines.push("");
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", `Showing ${this.listScrollOffset + 1}-${Math.min(this.listScrollOffset + LIST_VISIBLE_COUNT, this.snapshot.active.length)} of ${this.snapshot.active.length}`)}`,
					width,
				),
			);
		}
	}

	private renderDetail(lines: string[], width: number): void {
		const issue = this.selectedIssue();
		const th = this.theme;
		if (!issue) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No selected bead.")}`, width));
			return;
		}

		const content: string[] = [];
		this.pushWrapped(content, width, `${statusIcon(issue.status, th)} ${th.fg("accent", issue.id)} ${th.fg("text", issue.title)}`);
		this.pushWrapped(content, width, detailMeta(issue, th));
		this.pushWrapped(content, width, dateMeta(issue, th));
		if (issue.labels?.length) this.pushWrapped(content, width, `${th.fg("dim", "Labels:")} ${issue.labels.join(", ")}`);
		content.push("");
		if (issue.detailStatus === "loading") {
			this.pushWrapped(content, width, th.fg("accent", "Loading task details…"));
		} else if (issue.detailStatus === "error") {
			this.pushWrapped(content, width, `${th.fg("warning", "Could not load task details:")} ${issue.detailError ?? "bd show failed"}`);
		} else if (issue.detailStatus !== "loaded") {
			this.pushWrapped(content, width, th.fg("dim", "Task details have not been loaded yet."));
		}
		this.pushSection(content, width, "Description", issue.description);
		this.pushSection(content, width, "Acceptance", issue.acceptanceCriteria);
		this.pushSection(content, width, "Notes", issue.notes);
		this.pushDependencySection(content, width, issue);

		this.detailScrollOffset = clampScrollOffset(this.detailScrollOffset, content.length, DETAIL_VISIBLE_COUNT);
		lines.push(...content.slice(this.detailScrollOffset, this.detailScrollOffset + DETAIL_VISIBLE_COUNT));
		this.pushScrollInfo(lines, width, this.detailScrollOffset, DETAIL_VISIBLE_COUNT, content.length);
	}

	private renderGraph(lines: string[], width: number): void {
		const graph = this.snapshot.graph;
		const th = this.theme;
		const content: string[] = [];
		if (this.snapshot.graphStatus === "loading") {
			this.pushWrapped(lines, width, th.fg("accent", "Loading dependency graph…"));
			return;
		}
		if (this.snapshot.graphStatus === "error") {
			this.pushWrapped(lines, width, `${th.fg("warning", "Could not load dependency graph:")} ${this.snapshot.graphError ?? "bd list failed"}`);
			return;
		}
		if (graph.nodes.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", this.snapshot.graphStatus === "idle" ? "Dependency graph has not been loaded yet." : "No active beads to graph.")}`, width));
			return;
		}

		this.pushWrapped(content, width, `${th.fg("dim", "Direction:")} prerequisite ${th.fg("accent", "→")} dependent`);
		content.push("");
		for (let layerIndex = 0; layerIndex < graph.layers.length; layerIndex++) {
			const layer = graph.layers[layerIndex];
			this.pushWrapped(content, width, th.fg("dim", `Layer ${layerIndex}`));
			for (const nodeId of layer) {
				const node = graph.nodes.find((item) => item.id === nodeId);
				if (!node) continue;
				this.pushWrapped(content, width, this.graphNodeLine(node));
			}
			content.push("");
		}

		if (graph.edges.length === 0) {
			this.pushWrapped(content, width, th.fg("dim", "No dependency edges among active beads."));
		} else {
			this.pushWrapped(content, width, th.fg("dim", "Edges"));
			for (const edge of graph.edges) {
				const from = this.graphNode(edge.from);
				const to = this.graphNode(edge.to);
				const fromLabel = from ? this.shortNodeLabel(from) : edge.from;
				const toLabel = to ? this.shortNodeLabel(to) : edge.to;
				this.pushWrapped(content, width, `${th.fg("muted", fromLabel)} ${th.fg("accent", "→")} ${th.fg("muted", toLabel)}${edge.type ? th.fg("dim", ` (${edge.type})`) : ""}`);
			}
		}

		this.graphScrollOffset = clampScrollOffset(this.graphScrollOffset, content.length, GRAPH_VISIBLE_COUNT);
		lines.push(...content.slice(this.graphScrollOffset, this.graphScrollOffset + GRAPH_VISIBLE_COUNT));
		this.pushScrollInfo(lines, width, this.graphScrollOffset, GRAPH_VISIBLE_COUNT, content.length);
	}

	private pushDependencySection(lines: string[], width: number, issue: BeadIssue): void {
		const th = this.theme;
		this.pushWrapped(lines, width, th.fg("dim", "Dependencies"));
		if (issue.dependencies.length === 0) {
			this.pushWrapped(lines, width, "No blockers.", "    ");
		} else {
			for (const dependency of issue.dependencies) {
				this.pushWrapped(lines, width, `${th.fg("warning", "depends on")} ${this.dependencyLabel(dependency.dependsOnId)}${dependency.type ? th.fg("dim", ` (${dependency.type})`) : ""}`, "    ");
			}
		}

		const blocking = this.snapshot.graph.edges.filter((edge) => edge.from === issue.id);
		if (blocking.length > 0) {
			this.pushWrapped(lines, width, th.fg("dim", "Blocks"));
			for (const edge of blocking) {
				this.pushWrapped(lines, width, this.dependencyLabel(edge.to), "    ");
			}
		}
	}

	private pushSection(lines: string[], width: number, title: string, value: string | undefined): void {
		if (!value?.trim()) return;
		lines.push("");
		this.pushWrapped(lines, width, this.theme.fg("dim", title));
		for (const paragraph of value.trim().split(/\n{2,}/)) {
			this.pushWrapped(lines, width, paragraph.replace(/\n/g, " "), "    ");
		}
	}

	private pushWrapped(lines: string[], width: number, text: string, indent = "  "): void {
		const innerWidth = Math.max(1, width - indent.length);
		for (const line of wrapTextWithAnsi(text, innerWidth)) {
			lines.push(truncateToWidth(`${indent}${line}`, width));
		}
	}

	private pushScrollInfo(lines: string[], width: number, offset: number, visibleCount: number, total: number): void {
		if (total <= visibleCount) return;
		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${this.theme.fg("dim", `Showing ${offset + 1}-${Math.min(offset + visibleCount, total)} of ${total}`)}`,
				width,
			),
		);
	}

	private pushFooter(lines: string[], width: number): void {
		lines.push("");
		lines.push(truncateToWidth(`  ${this.theme.fg("dim", `Refreshed ${formatTime(this.snapshot.refreshedAt)} · ${this.footerHelp()}`)}`, width));
		lines.push("");
	}

	private footerHelp(): string {
		if (this.snapshot.state !== "ok") return "Esc or Ctrl+Shift+B to close";
		if (this.mode === "detail") return "↑/↓ scroll · Backspace list · g graph · Esc close";
		if (this.mode === "graph") return "↑/↓ scroll · Enter details · Backspace list · Esc close";
		return "↑/↓ select · Enter details · g graph · Esc close";
	}

	private cache(width: number, lines: string[]): string[] {
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private refresh(): void {
		this.invalidate();
		this.requestRender();
	}

	private enterDetail(): void {
		const issue = this.selectedIssue();
		if (!issue) return;
		this.mode = "detail";
		this.detailScrollOffset = 0;
		if (issue.detailStatus !== "loaded") this.onLoadDetail(issue.id);
		this.refresh();
	}

	private enterGraph(): void {
		this.mode = "graph";
		this.graphScrollOffset = 0;
		if (this.snapshot.graphStatus !== "loaded") this.onLoadGraph();
		this.refresh();
	}

	private moveSelection(delta: number): void {
		const active = this.snapshot.active;
		if (active.length === 0) return;
		const current = this.selectedIndex();
		this.setSelection((current < 0 ? 0 : current) + delta);
	}

	private setSelection(index: number): void {
		const active = this.snapshot.active;
		if (active.length === 0) return;
		const clamped = Math.max(0, Math.min(active.length - 1, index));
		this.selectedIssueId = active[clamped].id;
		this.clampListScroll();
		this.refresh();
	}

	private ensureSelection(): void {
		if (this.snapshot.state !== "ok" || this.snapshot.active.length === 0) {
			this.selectedIssueId = undefined;
			this.listScrollOffset = 0;
			this.detailScrollOffset = 0;
			this.graphScrollOffset = 0;
			if (this.mode !== "list") this.mode = "list";
			return;
		}

		if (!this.selectedIssueId || !this.snapshot.active.some((issue) => issue.id === this.selectedIssueId)) {
			this.selectedIssueId = this.snapshot.active[0].id;
		}
		this.clampListScroll();
	}

	private clampListScroll(): void {
		const selectedIndex = this.selectedIndex();
		const maxScroll = Math.max(0, this.snapshot.active.length - LIST_VISIBLE_COUNT);
		this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, maxScroll));
		if (selectedIndex < 0) return;
		if (selectedIndex < this.listScrollOffset) this.listScrollOffset = selectedIndex;
		if (selectedIndex >= this.listScrollOffset + LIST_VISIBLE_COUNT) {
			this.listScrollOffset = Math.min(maxScroll, selectedIndex - LIST_VISIBLE_COUNT + 1);
		}
	}

	private selectedIndex(): number {
		if (!this.selectedIssueId) return -1;
		return this.snapshot.active.findIndex((issue) => issue.id === this.selectedIssueId);
	}

	private selectedIssue(): BeadIssue | undefined {
		const index = this.selectedIndex();
		return index >= 0 ? this.snapshot.active[index] : undefined;
	}

	private dependencyLabel(id: string): string {
		const node = this.graphNode(id);
		if (!node) return this.theme.fg("muted", id);
		const title = node.external ? "external bead" : node.title;
		return `${this.theme.fg(node.external ? "dim" : "muted", id)} ${this.theme.fg(node.external ? "dim" : "text", title)}`;
	}

	private graphNode(id: string): BeadGraphNode | undefined {
		return this.snapshot.graph.nodes.find((node) => node.id === id);
	}

	private graphNodeLine(node: BeadGraphNode): string {
		const th = this.theme;
		const selected = node.id === this.selectedIssueId;
		const marker = selected ? th.fg("accent", "◆") : th.fg(node.external ? "dim" : "muted", "◇");
		const id = th.fg(selected ? "accent" : node.external ? "dim" : "muted", node.id);
		const status = node.status ? `${statusIcon(node.status, th)} ` : "";
		const title = th.fg(selected ? "text" : node.external ? "dim" : "muted", node.title);
		return `${marker} ${status}${id} ${title}`;
	}

	private shortNodeLabel(node: BeadGraphNode): string {
		return `${node.id} ${node.title}`;
	}
}

export default function beadsExtension(pi: ExtensionAPI): void {
	const globals = globalThis as typeof globalThis & { __piBeadsCleanup?: () => void };
	globals.__piBeadsCleanup?.();

	let currentTarget: RefreshTarget | undefined;
	let snapshot: BeadsSnapshot = loadingSnapshot("Loading Beads…");
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let queuedRefresh = false;
	let mutationRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	const mutationToolCalls = new Set<string>();
	const issueDetails = new Map<string, BeadIssue>();
	const issueDetailLoads = new Map<string, Promise<void>>();
	const issueDetailErrors = new Map<string, string>();
	let graphLoadPromise: Promise<void> | undefined;
	let graphStatus: LoadStatus = "idle";
	let graphError: string | undefined;
	let activeOverlay: { overlay: BeadsOverlay; requestRender: () => void } | undefined;

	function createTarget(ctx: ExtensionContext): RefreshTarget {
		return { cwd: ctx.cwd, ui: ctx.ui, hasUI: ctx.hasUI, signal: ctx.signal };
	}

	async function refresh(target: RefreshTarget): Promise<void> {
		snapshot = decorateSnapshot(await readBeadsSnapshot(target.cwd, target.signal));
		updateWidget(target);
		activeOverlay?.overlay.setSnapshot(snapshot);
		activeOverlay?.requestRender();
	}

	function decorateSnapshot(next: BeadsSnapshot): BeadsSnapshot {
		if (next.state !== "ok") return next;
		const active = next.active.map(applyIssueDetailState);
		const ready = next.ready.map(applyIssueDetailState);
		return {
			...next,
			active,
			ready,
			graph: graphStatus === "loaded" ? buildDependencyGraph(active) : emptyGraph(),
			graphStatus,
			graphError,
		};
	}

	function applyIssueDetailState(issue: BeadIssue): BeadIssue {
		const detail = issueDetails.get(issue.id);
		const detailError = issueDetailErrors.get(issue.id);
		const merged: BeadIssue = detail ? { ...issue, ...detail, id: issue.id } : issue;
		return {
			...merged,
			detailStatus: issueDetailLoads.has(issue.id) ? "loading" : detailError ? "error" : detail ? "loaded" : "idle",
			detailError,
		};
	}

	function publishSnapshot(next: BeadsSnapshot = snapshot): void {
		snapshot = decorateSnapshot(next);
		if (currentTarget) updateWidget(currentTarget);
		activeOverlay?.overlay.setSnapshot(snapshot);
		activeOverlay?.requestRender();
	}

	function publishLoading(target: RefreshTarget, message: string): void {
		currentTarget = target;
		snapshot = loadingSnapshot(message);
		updateWidget(target);
		activeOverlay?.overlay.setSnapshot(snapshot);
		activeOverlay?.requestRender();
	}

	function requestIssueDetail(issueId: string): void {
		if (!currentTarget || issueDetails.has(issueId) || issueDetailLoads.has(issueId)) return;
		issueDetailErrors.delete(issueId);
		const target = currentTarget;
		const load = readBeadIssueDetail(target.cwd, issueId, target.signal)
			.then((issue) => {
				issueDetails.set(issue.id, issue);
				issueDetailErrors.delete(issueId);
			})
			.catch((error: unknown) => {
				issueDetailErrors.set(issueId, errorMessage(error));
			})
			.finally(() => {
				issueDetailLoads.delete(issueId);
				publishSnapshot();
			});
		issueDetailLoads.set(issueId, load);
		publishSnapshot();
	}

	function requestGraphDetails(): void {
		if (!currentTarget || graphLoadPromise || graphStatus === "loaded") return;
		graphStatus = "loading";
		graphError = undefined;
		const target = currentTarget;
		graphLoadPromise = readBeadGraphDetails(target.cwd, target.signal)
			.then((issues) => {
				for (const issue of issues) issueDetails.set(issue.id, issue);
				graphStatus = "loaded";
				graphError = undefined;
			})
			.catch((error: unknown) => {
				graphStatus = "error";
				graphError = errorMessage(error);
			})
			.finally(() => {
				graphLoadPromise = undefined;
				publishSnapshot();
			});
		publishSnapshot();
	}

	function requestRefresh(target: RefreshTarget): Promise<void> {
		currentTarget = target;
		if (refreshPromise) {
			queuedRefresh = true;
			return refreshPromise;
		}

		refreshPromise = refresh(target)
			.catch((error: unknown) => {
				snapshot = errorSnapshot(errorMessage(error));
				updateWidget(target);
				activeOverlay?.overlay.setSnapshot(snapshot);
				activeOverlay?.requestRender();
			})
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
				overlay = new BeadsOverlay(snapshot, theme, () => done(), () => tui.requestRender(), requestIssueDetail, requestGraphDetails);
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
			if (!target.hasUI) {
				await requestRefresh(target);
				target.ui.notify(compactSummary(snapshot), snapshot.state === "ok" ? "info" : "warning");
				return;
			}
			if (snapshot.state !== "ok") publishLoading(target, "Loading Beads…");
			void requestRefresh(target);
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
			const command = args?.trim() || "show";
			if (command === "status" || command === "refresh") {
				await requestRefresh(target);
				target.ui.notify(compactSummary(snapshot), snapshot.state === "ok" ? "info" : "warning");
				return;
			}

			if (command !== "show") {
				target.ui.notify("Usage: /beads | /beads status | /beads refresh", "error");
				return;
			}

			if (!target.hasUI) {
				await requestRefresh(target);
				target.ui.notify(compactSummary(snapshot), snapshot.state === "ok" ? "info" : "warning");
				return;
			}

			if (snapshot.state !== "ok") publishLoading(target, "Loading Beads…");
			void requestRefresh(target);
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
		graph: emptyGraph(),
		graphStatus: "idle",
		refreshedAt: new Date(),
	};
}

async function readBeadIssueDetail(cwd: string, issueId: string, signal?: AbortSignal): Promise<BeadIssue> {
	const result = await runBd(cwd, ["show", issueId, "--long"], signal);
	if (result.cliMissing) throw new Error("bd CLI was not found in PATH.");
	if (result.missingDatabase) throw new Error("No Beads database found for this project.");
	if (!result.ok) throw new Error((result.error ?? result.stderr) || "bd show failed.");
	const issue = normalizeIssues(parseJson(result.stdout))[0];
	if (!issue) throw new Error("bd show returned no issue details.");
	return issue;
}

async function readBeadGraphDetails(cwd: string, signal?: AbortSignal): Promise<BeadIssue[]> {
	const result = await runBd(cwd, ["list", "--status", ACTIVE_STATUSES, "--limit", String(DEFAULT_LIMIT), "--flat", "--long", "--no-pager"], signal);
	if (result.cliMissing) throw new Error("bd CLI was not found in PATH.");
	if (result.missingDatabase) throw new Error("No Beads database found for this project.");
	if (!result.ok) throw new Error((result.error ?? result.stderr) || "bd list failed.");
	return normalizeIssues(parseJson(result.stdout));
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
		priority: optionalNumber(object.priority),
		issueType: stringField(object.issue_type) ?? stringField(object.type),
		description: stringField(object.description),
		acceptanceCriteria: stringField(object.acceptance_criteria) ?? stringField(object.acceptanceCriteria),
		notes: stringField(object.notes),
		assignee: stringField(object.assignee),
		owner: stringField(object.owner),
		labels,
		createdAt: stringField(object.created_at),
		updatedAt: stringField(object.updated_at),
		startedAt: stringField(object.started_at),
		closedAt: stringField(object.closed_at),
		closeReason: stringField(object.close_reason),
		dependencyCount: optionalNumber(object.dependency_count),
		dependentCount: optionalNumber(object.dependent_count),
		commentCount: optionalNumber(object.comment_count),
		dependencies: dependencyArray(object.dependencies),
	};
}

function dependencyArray(value: unknown): BeadDependency[] {
	if (!Array.isArray(value)) return [];
	return value.map(toDependency).filter((dependency): dependency is BeadDependency => dependency !== undefined);
}

function toDependency(value: unknown): BeadDependency | undefined {
	const object = asRecord(value);
	if (!object) return undefined;
	const issueId = stringField(object.issue_id) ?? stringField(object.issueId);
	const dependsOnId = stringField(object.depends_on_id) ?? stringField(object.dependsOnId);
	if (!issueId || !dependsOnId) return undefined;
	return { issueId, dependsOnId, type: stringField(object.type) };
}

function buildDependencyGraph(issues: BeadIssue[]): BeadDependencyGraph {
	const nodeMap = new Map<string, BeadGraphNode>();
	const order = new Map<string, number>();
	for (let index = 0; index < issues.length; index++) {
		const issue = issues[index];
		nodeMap.set(issue.id, { id: issue.id, title: issue.title, status: issue.status, external: false, layer: 0 });
		order.set(issue.id, index);
	}

	const edges = new Map<string, BeadGraphEdge>();
	for (const issue of issues) {
		for (const dependency of issue.dependencies) {
			if (!nodeMap.has(dependency.dependsOnId)) {
				nodeMap.set(dependency.dependsOnId, { id: dependency.dependsOnId, title: dependency.dependsOnId, external: true, layer: 0 });
				order.set(dependency.dependsOnId, order.size);
			}
			const key = `${dependency.dependsOnId}\u0000${issue.id}\u0000${dependency.type ?? ""}`;
			edges.set(key, { from: dependency.dependsOnId, to: issue.id, type: dependency.type });
		}
	}

	const edgeList = [...edges.values()];
	const incoming = new Map<string, string[]>();
	for (const node of nodeMap.values()) incoming.set(node.id, []);
	for (const edge of edgeList) incoming.get(edge.to)?.push(edge.from);

	const memo = new Map<string, number>();
	function layerFor(id: string, visiting: Set<string>): number {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) return 0;
		const dependencies = incoming.get(id) ?? [];
		if (dependencies.length === 0) {
			memo.set(id, 0);
			return 0;
		}
		const next = new Set(visiting);
		next.add(id);
		const layer = Math.max(...dependencies.map((dependencyId) => layerFor(dependencyId, next) + 1));
		memo.set(id, layer);
		return layer;
	}

	for (const node of nodeMap.values()) node.layer = layerFor(node.id, new Set());
	const nodes = [...nodeMap.values()].sort((a, b) => a.layer - b.layer || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	const layers: string[][] = [];
	for (const node of nodes) {
		layers[node.layer] ??= [];
		layers[node.layer].push(node.id);
	}
	return { nodes, edges: edgeList, layers: layers.filter((layer) => layer.length > 0) };
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

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number {
	return optionalNumber(value) ?? 0;
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function loadingSnapshot(message: string): BeadsSnapshot {
	return { state: "loading", message, summary: { ...emptySummary }, active: [], ready: [], graph: emptyGraph(), graphStatus: "idle", refreshedAt: new Date() };
}

function missingSnapshot(message: string): BeadsSnapshot {
	return { state: "missing_database", message, summary: { ...emptySummary }, active: [], ready: [], graph: emptyGraph(), graphStatus: "idle", refreshedAt: new Date() };
}

function errorSnapshot(message: string, state: SnapshotState = "error"): BeadsSnapshot {
	return { state, message, summary: { ...emptySummary }, active: [], ready: [], graph: emptyGraph(), graphStatus: "idle", refreshedAt: new Date() };
}

function emptyGraph(): BeadDependencyGraph {
	return { nodes: [], edges: [], layers: [] };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		case "loading":
			return "Loading…";
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
		case "loading":
			return theme.fg("accent", "◌");
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

function issueCounts(issue: BeadIssue, theme: Theme): string {
	const parts: string[] = [];
	if (issue.dependencyCount) parts.push(`${issue.dependencyCount} deps`);
	if (issue.dependentCount) parts.push(`${issue.dependentCount} blocks`);
	if (issue.commentCount) parts.push(`${issue.commentCount} comments`);
	return parts.length === 0 ? "" : theme.fg("dim", ` · ${parts.join(" · ")}`);
}

function detailMeta(issue: BeadIssue, theme: Theme): string {
	const parts = [
		issue.status.replace(/_/g, " "),
		issue.priority === undefined ? undefined : `P${issue.priority}`,
		issue.issueType,
		issue.owner ? `owner ${issue.owner}` : undefined,
		issue.assignee ? `assignee ${issue.assignee}` : undefined,
	].filter((part): part is string => Boolean(part));
	return theme.fg("dim", parts.join(" · "));
}

function dateMeta(issue: BeadIssue, theme: Theme): string {
	const parts = [
		issue.createdAt ? `created ${formatDate(issue.createdAt)}` : undefined,
		issue.updatedAt ? `updated ${formatDate(issue.updatedAt)}` : undefined,
		issue.startedAt ? `started ${formatDate(issue.startedAt)}` : undefined,
		issue.closedAt ? `closed ${formatDate(issue.closedAt)}` : undefined,
		issue.closeReason ? `reason ${issue.closeReason}` : undefined,
	].filter((part): part is string => Boolean(part));
	return theme.fg("dim", parts.join(" · "));
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function clampScrollOffset(offset: number, total: number, visible: number): number {
	const max = Math.max(0, total - visible);
	return Math.max(0, Math.min(offset, max));
}
