import {
	DynamicBorder,
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type SessionMessageEntry,
	type Skill,
	type SlashCommandInfo,
	type SourceInfo,
	type Theme,
	type ThemeColor,
	type ToolInfo,
} from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, type Component } from "@mariozechner/pi-tui";

type UsedCategoryKey = "systemPrompt" | "systemTools" | "extensions" | "contextFiles" | "skills" | "messages" | "other";
type CategoryKey = UsedCategoryKey | "available";

type UsedEstimates = Record<UsedCategoryKey, number>;
type TokenBreakdown = Record<CategoryKey, number>;

interface CategoryDefinition {
	key: CategoryKey;
	label: string;
	marker: string;
	color: ThemeColor;
}

interface ExtensionDetail {
	label: string;
	toolCount: number;
	tokens: number;
}

interface SkillDetail {
	label: string;
	tokens: number;
	promptVisible: boolean;
}

interface ContextReport {
	breakdown: TokenBreakdown;
	usedTokens: number;
	contextWindow: number | null;
	usagePercent: number | null;
	estimated: boolean;
	systemToolCount: number;
	extensionToolCount: number;
	contextFileCount: number;
	skillCount: number;
	extensionDetails: ExtensionDetail[];
	skillDetails: SkillDetail[];
	modelLabel: string | null;
}

interface TextPart {
	type: "text";
	text: string;
}

interface ThinkingPart {
	type: "thinking";
	thinking: string;
}

interface ToolCallPart {
	type: "toolCall";
	name: string;
	arguments: unknown;
}

interface PromptSectionEstimates {
	systemPrompt: number;
	contextFiles: number;
	skills: number;
	contextFileCount: number;
	skillCount: number;
	skillDetails: SkillDetail[];
}

interface ToolEstimates {
	systemTools: number;
	extensions: number;
	systemToolCount: number;
	extensionToolCount: number;
	extensionDetails: ExtensionDetail[];
}

const USED_CATEGORIES: UsedCategoryKey[] = ["systemPrompt", "systemTools", "extensions", "contextFiles", "skills", "messages", "other"];
const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
	{ key: "systemPrompt", label: "System Prompt", marker: "⛁", color: "accent" },
	{ key: "systemTools", label: "System Tools", marker: "⛀", color: "warning" },
	{ key: "extensions", label: "Extensions", marker: "⛃", color: "success" },
	{ key: "contextFiles", label: "Context Files", marker: "⛬", color: "customMessageText" },
	{ key: "skills", label: "Skills", marker: "⛧", color: "thinkingHigh" },
	{ key: "messages", label: "Messages", marker: "⛝", color: "text" },
	{ key: "other", label: "Other", marker: "◆", color: "muted" },
	{ key: "available", label: "Free Space", marker: "⛶", color: "dim" },
];

export default function piContextExtension(pi: ExtensionAPI): void {
	let latestPromptOptions: BuildSystemPromptOptions | undefined;
	let latestSystemPrompt: string | undefined;

	pi.on("before_agent_start", (event) => {
		latestPromptOptions = event.systemPromptOptions;
		latestSystemPrompt = event.systemPrompt;
	});

	pi.registerCommand("context", {
		description: "Show current context window usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = collectContextReport(pi, ctx, latestPromptOptions, latestSystemPrompt);

			if (!ctx.hasUI) {
				ctx.ui.notify(formatCompactReport(report), "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new ContextUsageOverlay(report, theme, done), {
				overlay: true,
				overlayOptions: {
					width: 88,
					minWidth: 56,
					maxHeight: "90%",
					margin: 2,
				},
			});
		},
	});
}

function collectContextReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, promptOptions: BuildSystemPromptOptions | undefined, latestSystemPrompt: string | undefined): ContextReport {
	const usage = ctx.getContextUsage();
	const branch = ctx.sessionManager.getBranch();
	const currentSystemPrompt = ctx.getSystemPrompt();
	const systemPrompt = currentSystemPrompt.length > 0 ? currentSystemPrompt : latestSystemPrompt ?? "";
	const activeToolNames = new Set(pi.getActiveTools());
	const activeTools = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));
	const commands = pi.getCommands();
	const promptSections = estimatePromptSections(systemPrompt, promptOptions, commands);
	const toolEstimates = estimateTools(activeTools);

	const estimates: UsedEstimates = {
		systemPrompt: promptSections.systemPrompt,
		systemTools: toolEstimates.systemTools,
		extensions: toolEstimates.extensions,
		contextFiles: promptSections.contextFiles,
		skills: promptSections.skills,
		messages: 0,
		other: 0,
	};

	for (const entry of getContextEntries(branch)) {
		addEntryEstimate(entry, estimates);
	}

	const usedBreakdown = roundEstimates(estimates);
	const usedTokens = sumUsed(usedBreakdown);
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	const available = contextWindow === null ? 0 : Math.max(0, contextWindow - usedTokens);
	const usagePercent = contextWindow && contextWindow > 0 ? (usedTokens / contextWindow) * 100 : null;

	return {
		breakdown: {
			...usedBreakdown,
			available,
		},
		usedTokens,
		contextWindow,
		usagePercent,
		estimated: true,
		systemToolCount: toolEstimates.systemToolCount,
		extensionToolCount: toolEstimates.extensionToolCount,
		contextFileCount: promptSections.contextFileCount,
		skillCount: promptSections.skillCount,
		extensionDetails: toolEstimates.extensionDetails,
		skillDetails: promptSections.skillDetails,
		modelLabel: formatModelLabel(ctx),
	};
}

function estimatePromptSections(systemPrompt: string, promptOptions: BuildSystemPromptOptions | undefined, commands: SlashCommandInfo[]): PromptSectionEstimates {
	const totalSystemPrompt = estimateTokens(systemPrompt);
	const contextFileSection = extractProjectContextSection(systemPrompt);
	const skillSection = extractDelimitedSection(systemPrompt, "<available_skills>", "</available_skills>");
	const contextFileTokens = estimateTokens(contextFileSection);
	const skillTokens = estimateTokens(skillSection);
	const skillCommands = commands.filter((command) => command.source === "skill");

	return {
		systemPrompt: Math.max(0, totalSystemPrompt - contextFileTokens - skillTokens),
		contextFiles: contextFileTokens,
		skills: skillTokens,
		contextFileCount: promptOptions?.contextFiles?.length ?? countContextFileHeadings(contextFileSection),
		skillCount: promptOptions?.skills?.length ?? skillCommands.length,
		skillDetails: promptOptions?.skills ? promptOptions.skills.map((skill) => estimateSkillDetail(skill, skillSection.length > 0)) : estimateSkillCommandDetails(skillCommands, skillSection.length > 0),
	};
}

function estimateSkillCommandDetails(commands: SlashCommandInfo[], promptVisible: boolean): SkillDetail[] {
	return commands.map((command) => ({
		label: command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name,
		tokens: promptVisible ? estimateTokens(`${command.name}\n${command.description ?? ""}`) : 0,
		promptVisible,
	}));
}

function estimateSkillDetail(skill: Skill, hasSkillSection: boolean): SkillDetail {
	const promptVisible = hasSkillSection && !skill.disableModelInvocation;
	return {
		label: skill.name,
		tokens: promptVisible ? estimateTokens(formatSkillsForPrompt([skill])) : 0,
		promptVisible,
	};
}

function estimateTools(activeTools: ToolInfo[]): ToolEstimates {
	let systemTools = 0;
	let extensions = 0;
	let systemToolCount = 0;
	let extensionToolCount = 0;
	const extensionDetails = new Map<string, ExtensionDetail>();

	for (const tool of activeTools) {
		const tokens = estimateToolDefinition(tool);
		if (isBuiltinTool(tool)) {
			systemTools += tokens;
			systemToolCount++;
			continue;
		}

		extensions += tokens;
		extensionToolCount++;
		const label = sourceLabel(tool.sourceInfo);
		const detail = extensionDetails.get(label) ?? { label, toolCount: 0, tokens: 0 };
		detail.toolCount++;
		detail.tokens += tokens;
		extensionDetails.set(label, detail);
	}

	return {
		systemTools,
		extensions,
		systemToolCount,
		extensionToolCount,
		extensionDetails: Array.from(extensionDetails.values()).toSorted((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label)),
	};
}

function estimateToolDefinition(tool: ToolInfo): number {
	return estimateTokens(
		safeStringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}),
	);
}

function isBuiltinTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source === "builtin" || tool.sourceInfo.path.startsWith("<builtin:");
}

function sourceLabel(sourceInfo: SourceInfo): string {
	if (sourceInfo.source === "builtin") return "Built-in";
	if (sourceInfo.source === "sdk") return "SDK";
	if (sourceInfo.source && sourceInfo.source !== "local") return compactSource(sourceInfo.source);

	const normalized = (sourceInfo.baseDir ?? sourceInfo.path).replace(/\\/g, "/");
	const packagesMatch = normalized.match(/(?:^|\/)packages\/([^/]+)/);
	if (packagesMatch?.[1]) return packagesMatch[1];

	const extensionsMatch = normalized.match(/(?:^|\/)extensions\/([^/]+)/);
	if (extensionsMatch?.[1]) return stripScriptExtension(extensionsMatch[1]);

	const withoutEntry = normalized.replace(/\/src\/index\.[cm]?[tj]s$/, "").replace(/\/index\.[cm]?[tj]s$/, "").replace(/\.[cm]?[tj]s$/, "");
	return basename(withoutEntry) || compactSource(sourceInfo.path);
}

function compactSource(source: string): string {
	const normalized = source.replace(/\\/g, "/");
	if (normalized.startsWith("<") && normalized.endsWith(">")) return normalized.slice(1, -1);
	return stripScriptExtension(basename(normalized)) || source;
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

function stripScriptExtension(path: string): string {
	return path.replace(/\.[cm]?[tj]s$/, "");
}

function getContextEntries(branch: SessionEntry[]): SessionEntry[] {
	const compactionIndex = findLastIndex(branch, (entry) => entry.type === "compaction");
	if (compactionIndex === -1) return branch.filter(isContextEntry);

	const compaction = branch[compactionIndex];
	if (!compaction || compaction.type !== "compaction") return branch.filter(isContextEntry);

	const entries: SessionEntry[] = [compaction];
	let foundFirstKept = false;

	for (let index = 0; index < compactionIndex; index++) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept && isContextEntry(entry)) entries.push(entry);
	}

	for (let index = compactionIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry && isContextEntry(entry)) entries.push(entry);
	}

	return entries;
}

function isContextEntry(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "custom_message";
}

function addEntryEstimate(entry: SessionEntry, estimates: UsedEstimates): void {
	switch (entry.type) {
		case "message":
			addMessageEstimate(entry.message, estimates);
			return;
		case "custom_message":
			estimates.messages += estimateTextContent(entry.content);
			return;
		case "branch_summary":
			estimates.other += estimateTokens(entry.summary);
			return;
		case "compaction":
			estimates.other += estimateTokens(entry.summary);
			return;
	}
}

function addMessageEstimate(message: SessionMessageEntry["message"], estimates: UsedEstimates): void {
	switch (message.role) {
		case "user":
			estimates.messages += estimateTextContent(message.content);
			return;
		case "assistant":
			for (const part of message.content) {
				if (isTextPart(part)) {
					estimates.messages += estimateTokens(part.text);
				} else if (isThinkingPart(part)) {
					estimates.messages += estimateTokens(part.thinking);
				} else if (isToolCallPart(part)) {
					estimates.messages += estimateTokens(safeStringify({ name: part.name, arguments: part.arguments }));
				} else {
					estimates.other += estimateTokens(safeStringify(part));
				}
			}
			return;
		case "toolResult":
			estimates.messages += estimateTextContent(message.content);
			return;
		case "bashExecution":
			if (!message.excludeFromContext) {
				estimates.messages += estimateTokens(`${message.command}\n${message.output}`);
			}
			return;
		case "custom":
			estimates.messages += estimateTextContent(message.content);
			return;
		case "branchSummary":
			estimates.other += estimateTokens(message.summary);
			return;
		case "compactionSummary":
			estimates.other += estimateTokens(message.summary);
			return;
		default:
			estimates.other += estimateTokens(safeStringify(message));
	}
}

function estimateTextContent(content: unknown): number {
	if (typeof content === "string") return estimateTokens(content);
	if (!Array.isArray(content)) return 0;

	let tokens = 0;
	for (const part of content) {
		if (isTextPart(part)) tokens += estimateTokens(part.text);
	}
	return tokens;
}

function estimateTokens(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function roundEstimates(estimates: UsedEstimates): Record<UsedCategoryKey, number> {
	return {
		systemPrompt: Math.max(0, Math.round(estimates.systemPrompt)),
		systemTools: Math.max(0, Math.round(estimates.systemTools)),
		extensions: Math.max(0, Math.round(estimates.extensions)),
		contextFiles: Math.max(0, Math.round(estimates.contextFiles)),
		skills: Math.max(0, Math.round(estimates.skills)),
		messages: Math.max(0, Math.round(estimates.messages)),
		other: Math.max(0, Math.round(estimates.other)),
	};
}

function sumUsed(breakdown: Record<UsedCategoryKey, number>): number {
	return USED_CATEGORIES.reduce((total, key) => total + breakdown[key], 0);
}

function isTextPart(value: unknown): value is TextPart {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isThinkingPart(value: unknown): value is ThinkingPart {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCallPart(value: unknown): value is ToolCallPart {
	return isRecord(value) && value.type === "toolCall" && typeof value.name === "string" && "arguments" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(
				value,
				(_key, innerValue: unknown) => {
					if (typeof innerValue === "function") return "[Function]";
					if (typeof innerValue === "object" && innerValue !== null) {
						if (seen.has(innerValue)) return "[Circular]";
						seen.add(innerValue);
					}
					return innerValue;
				},
				2,
			) ?? ""
		);
	} catch {
		return String(value);
	}
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index]!)) return index;
	}
	return -1;
}

function extractProjectContextSection(systemPrompt: string): string {
	const start = systemPrompt.indexOf("# Project Context");
	if (start === -1) return "";

	const endCandidates = [systemPrompt.indexOf("\n<available_skills>", start), systemPrompt.indexOf("\nCurrent date:", start)].filter((index) => index >= 0);
	const end = endCandidates.length > 0 ? Math.min(...endCandidates) : systemPrompt.length;
	return systemPrompt.slice(start, end);
}

function extractDelimitedSection(text: string, startMarker: string, endMarker: string): string {
	const start = text.indexOf(startMarker);
	if (start === -1) return "";

	const end = text.indexOf(endMarker, start + startMarker.length);
	return end === -1 ? text.slice(start) : text.slice(start, end + endMarker.length);
}

function countContextFileHeadings(section: string): number {
	if (!section) return 0;
	return section.split("\n").filter((line) => line.startsWith("## ")).length;
}

function formatCompactReport(report: ContextReport): string {
	const denominator = report.contextWindow ?? report.usedTokens;
	const suffix = report.estimated ? " estimated" : "";
	const total = report.contextWindow === null ? formatTokens(report.usedTokens) : `${formatTokens(report.usedTokens)} / ${formatTokens(report.contextWindow)}`;
	const rows = CATEGORY_DEFINITIONS.map((definition) => {
		const tokens = report.breakdown[definition.key];
		const percent = denominator > 0 ? (tokens / denominator) * 100 : null;
		return `${definition.label}: ${formatTokens(tokens)} (${formatPercent(percent)})`;
	});
	const extensions = report.extensionDetails.length > 0 ? ["Extensions:", ...report.extensionDetails.map((detail) => `  ${detail.label}: ${detail.toolCount} tool${detail.toolCount === 1 ? "" : "s"}, ${formatTokens(detail.tokens)} context`)] : [];
	const skills = report.skillDetails.length > 0 ? ["Skills:", ...report.skillDetails.map((detail) => `  ${detail.label}: ${detail.promptVisible ? formatTokens(detail.tokens) : "not in prompt"}`)] : [];

	return [`Context Usage: ${total} (${formatPercent(report.usagePercent)})${suffix}`, ...rows, ...extensions, ...skills].join("\n");
}

class ContextUsageOverlay implements Component {
	constructor(
		private readonly report: ContextReport,
		private readonly theme: Theme,
		private readonly done: (result: void) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q" || data === "Q") {
			this.done(undefined);
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const borderColor = (text: string) => this.theme.fg("border", text);
		const container = new Container();

		container.addChild(new DynamicBorder(borderColor));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Context Usage")), 1, 0));
		if (this.report.modelLabel) {
			container.addChild(new Text(this.theme.fg("dim", this.report.modelLabel), 1, 0));
		}
		container.addChild(new Spacer(1));

		for (const line of this.renderDiagramWithCategoryRows()) {
			container.addChild(new Text(line, 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(this.renderTotalLine(), 1, 0));
		container.addChild(new Text(this.renderCountsLine(), 1, 0));

		for (const line of this.renderExtensionRows()) {
			container.addChild(new Text(line, 1, 0));
		}

		for (const line of this.renderSkillRows()) {
			container.addChild(new Text(line, 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(this.theme.fg("dim", "Esc, Enter, or q to close"), 1, 0));
		container.addChild(new DynamicBorder(borderColor));

		return container.render(renderWidth).map((line) => truncateToWidth(line, renderWidth, ""));
	}

	invalidate(): void {}

	private renderDiagramWithCategoryRows(): string[] {
		const grid = this.renderGrid();
		const categories = [this.theme.fg("dim", "Estimated usage by category"), ...this.renderCategoryRows()];
		const rows: string[] = [];
		const rowCount = Math.max(grid.length, categories.length);
		const blankGrid = " ".repeat(19);

		for (let index = 0; index < rowCount; index++) {
			const left = grid[index] ?? blankGrid;
			const right = categories[index] ?? "";
			rows.push(right ? `${left}   ${right}` : left);
		}

		return rows;
	}

	private renderGrid(): string[] {
		const cells = allocateGridCells(this.report);
		const lines: string[] = [];

		for (let row = 0; row < 5; row++) {
			const start = row * 10;
			const content = cells
				.slice(start, start + 10)
				.map((key) => this.colorCategory(key, CATEGORY_DEFINITIONS.find((definition) => definition.key === key)!.marker))
				.join(" ");
			lines.push(content);
		}

		return lines;
	}

	private renderTotalLine(): string {
		const estimated = this.report.estimated ? " estimated" : "";
		const total = this.report.contextWindow === null ? formatTokens(this.report.usedTokens) : `${formatTokens(this.report.usedTokens)} / ${formatTokens(this.report.contextWindow)}`;
		return `${this.theme.fg("accent", "Used")}: ${total} (${formatPercent(this.report.usagePercent)})${estimated}`;
	}

	private renderCountsLine(): string {
		return this.theme.fg(
			"dim",
			`${this.report.systemToolCount} system tool${this.report.systemToolCount === 1 ? "" : "s"} · ${this.report.extensionToolCount} extension tool${this.report.extensionToolCount === 1 ? "" : "s"} · ${this.report.contextFileCount} context file${this.report.contextFileCount === 1 ? "" : "s"} · ${this.report.skillCount} skill${this.report.skillCount === 1 ? "" : "s"}`,
		);
	}

	private renderCategoryRows(): string[] {
		const denominator = this.report.contextWindow ?? this.report.usedTokens;
		return CATEGORY_DEFINITIONS.map((definition) => {
			const tokens = this.report.breakdown[definition.key];
			const percent = denominator > 0 ? (tokens / denominator) * 100 : null;
			const marker = this.colorCategory(definition.key, definition.marker);
			return `${marker} ${definition.label.padEnd(14)} ${formatTokens(tokens).padStart(8)} ${formatPercent(percent).padStart(7)}`;
		});
	}

	private renderExtensionRows(): string[] {
		if (this.report.extensionDetails.length === 0) return [];

		const rows = ["", this.theme.fg("dim", "Extensions")];
		const visible = this.report.extensionDetails.slice(0, 8);
		for (const detail of visible) {
			rows.push(`  ${truncatePlain(detail.label, 28).padEnd(28)} ${this.theme.fg("dim", `${detail.toolCount} tool${detail.toolCount === 1 ? "" : "s"} · ${formatTokens(detail.tokens)} context`)}`);
		}
		if (this.report.extensionDetails.length > visible.length) {
			rows.push(this.theme.fg("dim", `  +${this.report.extensionDetails.length - visible.length} more`));
		}
		return rows;
	}

	private renderSkillRows(): string[] {
		if (this.report.skillDetails.length === 0) return [];

		const rows = ["", this.theme.fg("dim", "Skills")];
		const visible = this.report.skillDetails.slice(0, 8);
		for (const detail of visible) {
			const tokens = detail.promptVisible ? `${formatTokens(detail.tokens)} context` : "not in prompt";
			rows.push(`  ${truncatePlain(detail.label, 28).padEnd(28)} ${this.theme.fg("dim", tokens)}`);
		}
		if (this.report.skillDetails.length > visible.length) {
			rows.push(this.theme.fg("dim", `  +${this.report.skillDetails.length - visible.length} more`));
		}
		return rows;
	}

	private colorCategory(key: CategoryKey, text: string): string {
		const definition = CATEGORY_DEFINITIONS.find((item) => item.key === key)!;
		return this.theme.fg(definition.color, text);
	}
}

function allocateGridCells(report: ContextReport): CategoryKey[] {
	const total = report.contextWindow && report.contextWindow > 0 ? report.contextWindow : report.usedTokens;
	if (total <= 0) return Array(50).fill("available") as CategoryKey[];

	const categories = CATEGORY_DEFINITIONS.map((definition) => ({
		key: definition.key,
		tokens: report.contextWindow && report.contextWindow > 0 ? report.breakdown[definition.key] : definition.key === "available" ? 0 : report.breakdown[definition.key],
	}));
	const exact = categories.map((item) => ({ ...item, cells: (item.tokens / total) * 50 }));
	const counts = new Map<CategoryKey, number>();
	let assigned = 0;

	for (const item of exact) {
		const whole = Math.floor(item.cells);
		counts.set(item.key, whole);
		assigned += whole;
	}

	const byRemainder = exact.toSorted((left, right) => right.cells % 1 - (left.cells % 1));
	for (let remaining = 50 - assigned, index = 0; remaining > 0; remaining--, index++) {
		const key = byRemainder[index % byRemainder.length]!.key;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const cells: CategoryKey[] = [];
	for (const definition of CATEGORY_DEFINITIONS) {
		cells.push(...Array(counts.get(definition.key) ?? 0).fill(definition.key));
	}

	const visibleCells = cells.slice(0, 50);
	if (report.usedTokens > 0 && !visibleCells.some((key) => key !== "available")) {
		const largestUsed = USED_CATEGORIES.toSorted((left, right) => report.breakdown[right] - report.breakdown[left]).find((key) => report.breakdown[key] > 0);
		if (largestUsed) visibleCells[0] = largestUsed;
	}

	return visibleCells;
}

function formatModelLabel(ctx: ExtensionCommandContext): string | null {
	if (!ctx.model) return null;

	const name = ctx.model.name || ctx.model.id;
	const context = ctx.model.contextWindow ? `${formatTokens(ctx.model.contextWindow)} context` : "unknown context";
	return `${name} (${context})`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`;
	return Math.round(tokens).toString();
}

function trimFixed(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function formatPercent(percent: number | null): string {
	if (percent === null || !Number.isFinite(percent)) return "n/a";
	if (percent > 0 && percent < 0.1) return "<0.1%";
	return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function truncatePlain(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
