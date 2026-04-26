import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import type { DisplayLineConfig, SegmentAlignment, SegmentConfig, SegmentName, ThemeColorKey } from "./config.js";
import type { GitDetails } from "./git.js";
import { BAR_LEVELS, type PowerlineSymbols } from "./symbols.js";

export interface RuntimeMetrics {
	sessionStartedAt: number;
	agentStartedAt?: number;
	lastAgentDurationMs?: number;
}

export interface SegmentRenderContext {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	footerData: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		getAvailableProviderCount(): number;
	};
	gitDetails?: GitDetails;
	metrics: RuntimeMetrics;
	symbols: PowerlineSymbols;
}

export interface RenderedSegment {
	name: SegmentName;
	colorKey: ThemeColorKey;
	text: string;
	align?: SegmentAlignment;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function renderSegments(line: DisplayLineConfig, context: SegmentRenderContext): RenderedSegment[] {
	const segments: RenderedSegment[] = [];

	for (const [name, config] of Object.entries(line.segments) as [SegmentName, SegmentConfig][]) {
		if (!config?.enabled) continue;
		const segment = renderSegment(name, config, context);
		if (segment && segment.text.trim()) segments.push({ ...segment, align: config.align ?? "left" });
	}

	return segments;
}

export function sanitizePlainText(value: string): string {
	return value
		.replace(ANSI_PATTERN, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\x00-\x1F\x7F]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function renderSegment(
	name: SegmentName,
	config: SegmentConfig,
	context: SegmentRenderContext,
): RenderedSegment | undefined {
	switch (name) {
		case "directory":
			return renderDirectory(config, context);
		case "git":
			return renderGit(config, context);
		case "model":
			return renderModel(config, context);
		case "session":
			return renderSession(config, context);
		case "context":
			return renderContext(config, context);
		case "metrics":
			return renderMetrics(config, context);
		case "sessionId":
			return renderSessionId(config, context);
		case "env":
			return renderEnv(config);
		case "tmux":
			return renderTmux(config);
		case "status":
			return renderStatus(config, context);
	}
}

function renderDirectory(config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const style = config.style ?? "fish";
	const collapsed = collapseHome(context.ctx.cwd);
	const text = style === "basename" ? basenamePath(collapsed, context.ctx.cwd) : style === "full" ? collapsed : fishPath(collapsed);
	return { name: "directory", colorKey: "directory", text: sanitizePlainText(text) };
}

function renderGit(config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const branch = sanitizePlainText(context.footerData.getGitBranch() ?? context.gitDetails?.branch ?? "");
	const details = context.gitDetails;
	const parts: string[] = [];

	if (config.showRepoName && details?.repoName) parts.push(sanitizePlainText(details.repoName));
	if (branch) parts.push(formatWithOptionalSymbol(context.symbols.branch, branch));
	if (config.showSha && details?.sha) parts.push(formatWithOptionalSymbol(context.symbols.sha, sanitizePlainText(details.sha)));
	if (config.showWorkingTree && details) {
		const workingTree = formatWorkingTree(details, context.symbols);
		if (workingTree) parts.push(workingTree);
	}
	if (config.showOperation && details?.operation) parts.push(`${context.symbols.operation} ${details.operation}`);
	if (config.showTag && details?.tag) parts.push(`${context.symbols.tag} ${sanitizePlainText(details.tag)}`);
	if (config.showTimeSinceCommit && details?.timeSinceCommit) parts.push(`${context.symbols.clock} ${details.timeSinceCommit}`);
	if (config.showStashCount && details?.stashCount) parts.push(`${context.symbols.stash} ${details.stashCount}`);
	if (config.showUpstream && details?.upstream) {
		const upstreamParts: string[] = [];
		if (details.upstream.name) upstreamParts.push(sanitizePlainText(details.upstream.name));
		if (details.upstream.ahead) upstreamParts.push(`${context.symbols.ahead}${details.upstream.ahead}`);
		if (details.upstream.behind) upstreamParts.push(`${context.symbols.behind}${details.upstream.behind}`);
		if (upstreamParts.length > 0) parts.push(upstreamParts.join(" "));
	}

	return parts.length > 0 ? { name: "git", colorKey: "git", text: parts.join(" ") } : undefined;
}

function renderModel(_config: SegmentConfig, context: SegmentRenderContext): RenderedSegment {
	const model = context.ctx.model;
	let text = model?.id ?? "no-model";
	if (model && context.footerData.getAvailableProviderCount() > 1) text = `(${model.provider}) ${text}`;
	if (model?.reasoning) {
		const thinkingLevel = getThinkingLevel(context.pi);
		if (thinkingLevel) text = `${text} • ${thinkingLevel}`;
	}
	return { name: "model", colorKey: "model", text: sanitizePlainText(text) };
}

function renderSession(config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const totals = getUsageTotals(context.ctx);
	const type = config.type ?? "tokens";
	const tokenText = `${context.symbols.tokensIn}${formatTokens(totals.input)} ${context.symbols.tokensOut}${formatTokens(totals.output)}`;
	const cacheText = `${context.symbols.cacheRead}${formatTokens(totals.cacheRead)} ${context.symbols.cacheWrite}${formatTokens(totals.cacheWrite)}`;
	const costText = `$${totals.cost.toFixed(3)}`;

	let text: string;
	if (type === "cost") text = costText;
	else if (type === "both") text = `${tokenText} ${costText}`;
	else if (type === "breakdown") text = `${tokenText} ${cacheText} ${costText}`;
	else text = tokenText;

	return text.trim() ? { name: "session", colorKey: "session", text } : undefined;
}

function renderContext(config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const usage = context.ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? context.ctx.model?.contextWindow;
	if (!contextWindow) return undefined;

	const percent = usage?.percent ?? null;
	const tokens = usage?.tokens ?? null;
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const ratio = percent === null ? 0 : clamp(percent / 100, 0, 1);
	const width = config.width ?? 10;
	const displayStyle = config.displayStyle ?? "bar";
	const usageText = tokens === null ? `?/${formatTokens(contextWindow)}` : `${formatTokens(tokens)}/${formatTokens(contextWindow)}`;

	let text: string;
	if (config.showTokensOnly) {
		text = `ctx ${usageText}`;
	} else if (config.showPercentageOnly) {
		text = `ctx ${percentText}`;
	} else if (displayStyle === "text") {
		text = `ctx ${usageText} ${percentText}`;
	} else if (displayStyle === "dots") {
		text = `ctx ${percentText} ${repeatProgress(context.symbols.dotFull, context.symbols.dotEmpty, ratio, width)}`;
	} else if (displayStyle === "blocks-line") {
		text = renderBlockLine(ratio, width, context.symbols);
	} else if (displayStyle === "blocks") {
		text = `ctx ${percentText} ${renderBlockLine(ratio, width, context.symbols)}`;
	} else {
		text = `ctx ${percentText} ${repeatProgress(context.symbols.blockFull, context.symbols.blockEmpty, ratio, width)}`;
	}

	const warning = config.warningThreshold ?? 70;
	const critical = config.criticalThreshold ?? 90;
	const colorKey: ThemeColorKey = percent !== null && percent >= critical ? "critical" : percent !== null && percent >= warning ? "warning" : "context";
	return { name: "context", colorKey, text };
}

function renderMetrics(config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const showDuration = config.showDuration ?? true;
	const showMessages = config.showMessages ?? true;
	const showLastResponse = config.showLastResponse ?? true;
	const parts: string[] = [];

	if (showDuration) parts.push(`${context.symbols.clock} ${formatDuration(Date.now() - context.metrics.sessionStartedAt)}`);
	if (showMessages) parts.push(`${context.symbols.message} ${countMessages(context.ctx)}`);
	if (showLastResponse && context.metrics.lastAgentDurationMs !== undefined) {
		parts.push(`last ${formatDuration(context.metrics.lastAgentDurationMs)}`);
	}

	return parts.length > 0 ? { name: "metrics", colorKey: "metrics", text: parts.join(" ") } : undefined;
}

function renderSessionId(config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const id = sanitizePlainText(context.ctx.sessionManager.getSessionId());
	if (!id) return undefined;
	const text = config.full ? id : id.slice(0, config.length ?? 8);
	return { name: "sessionId", colorKey: "sessionId", text };
}

function renderEnv(config: SegmentConfig): RenderedSegment | undefined {
	if (!config.variable) return undefined;
	const value = process.env[config.variable] ?? config.default;
	if (!value) return undefined;
	const text = `${config.prefix ?? ""}${sanitizePlainText(value)}`;
	return text ? { name: "env", colorKey: "env", text } : undefined;
}

function renderTmux(config: SegmentConfig): RenderedSegment | undefined {
	if (!process.env.TMUX) return undefined;
	return { name: "tmux", colorKey: "tmux", text: sanitizePlainText(config.label ?? "tmux") };
}

function renderStatus(_config: SegmentConfig, context: SegmentRenderContext): RenderedSegment | undefined {
	const statuses = Array.from(context.footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizePlainText(text))
		.filter(Boolean);
	return statuses.length > 0 ? { name: "status", colorKey: "status", text: statuses.join(" ") } : undefined;
}

function formatWithOptionalSymbol(symbol: string, text: string): string {
	return symbol ? `${symbol} ${text}` : text;
}

function formatWorkingTree(details: GitDetails, symbols: PowerlineSymbols): string | undefined {
	if (!details.dirty) return symbols.clean || undefined;
	if (details.changedFiles > 0) return symbols.dirty ? `${symbols.dirty} ${details.changedFiles}` : String(details.changedFiles);
	return symbols.dirty || undefined;
}

function getUsageTotals(context: ExtensionContext): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of context.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		totals.input += message.usage.input;
		totals.output += message.usage.output;
		totals.cacheRead += message.usage.cacheRead;
		totals.cacheWrite += message.usage.cacheWrite;
		totals.cost += message.usage.cost.total;
	}
	return totals;
}

function countMessages(context: ExtensionContext): number {
	let count = 0;
	for (const entry of context.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role !== "toolResult") count++;
	}
	return count;
}

function collapseHome(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`) ? `~${path.slice(home.length)}` : path;
}

function basenamePath(collapsed: string, cwd: string): string {
	if (collapsed === "~") return "~";
	return basename(cwd) || collapsed;
}

function fishPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	if (normalized === "~" || !normalized.includes("/")) return normalized;

	const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
	const withoutPrefix = normalized.replace(/^~\//, "").replace(/^\//, "");
	const parts = withoutPrefix.split("/").filter(Boolean);
	if (parts.length <= 1) return `${prefix}${parts.join("/")}`;
	const abbreviated = parts.slice(0, -1).map((part) => part[0] ?? part);
	return `${prefix}${[...abbreviated, parts.at(-1)].join("/")}`;
}

function getThinkingLevel(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getThinkingLevel();
	} catch {
		return undefined;
	}
}

function repeatProgress(full: string, empty: string, ratio: number, width: number): string {
	const filled = Math.round(width * ratio);
	return `${full.repeat(filled)}${empty.repeat(Math.max(0, width - filled))}`;
}

function renderBlockLine(ratio: number, width: number, symbols: PowerlineSymbols): string {
	if (width <= 0) return "";
	if (symbols.blockFull !== "█") return repeatProgress(symbols.blockFull, symbols.blockEmpty, ratio, width);
	const exact = ratio * width;
	const fullBlocks = Math.floor(exact);
	const remainder = exact - fullBlocks;
	const partial = remainder > 0 && fullBlocks < width ? BAR_LEVELS[Math.max(0, Math.ceil(remainder * BAR_LEVELS.length) - 1)] : "";
	const empty = Math.max(0, width - fullBlocks - (partial ? 1 : 0));
	return `${symbols.blockFull.repeat(fullBlocks)}${partial}${symbols.blockEmpty.repeat(empty)}`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
