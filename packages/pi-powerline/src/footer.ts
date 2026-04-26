import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import {
	colorBlock,
	colorForeground,
	colorPairText,
	getThemePalette,
	resolveColorMode,
	type ColorMode,
	type ThemePalette,
} from "./colors.js";
import {
	getConfigDir,
	getConfigPath,
	getDefaultConfig,
	loadConfig,
	summarizeConfig,
	type LoadedPowerlineConfig,
	type PowerlineConfig,
} from "./config.js";
import { GitCache } from "./git.js";
import { renderSegments, type RenderedSegment, type RuntimeMetrics } from "./segments.js";
import type { SubscriptionState } from "./subscription.js";
import { getSymbols, type PowerlineSymbols } from "./symbols.js";

export interface FooterDataLike {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

interface PowerlineFooterOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	tui: TUI;
	footerData: FooterDataLike;
	metrics: RuntimeMetrics;
	subscription: SubscriptionState;
}

const CONFIG_WATCH_DEBOUNCE_MS = 120;

export class PowerlineFooter implements Component {
	private loaded: LoadedPowerlineConfig;
	private watcher: FSWatcher | undefined;
	private reloadTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private readonly gitCache: GitCache;
	private readonly unsubscribeBranch: () => void;

	constructor(private readonly options: PowerlineFooterOptions) {
		this.loaded = loadConfig();
		this.gitCache = new GitCache(options.ctx.cwd);
		this.unsubscribeBranch = options.footerData.onBranchChange(() => {
			this.refreshGit();
			this.requestRender();
		});
		this.startConfigWatcher();
		this.refreshGit();
	}

	invalidate(): void {
		this.refreshGit();
		this.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeBranch();
		this.gitCache.dispose();
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.watcher?.close();
	}

	reloadConfig(): LoadedPowerlineConfig {
		this.loaded = loadConfig();
		this.requestRender();
		return this.loaded;
	}

	restoreDefaults(): void {
		this.loaded = {
			path: getConfigPath(),
			config: getDefaultConfig(),
			warnings: [],
			loadedFromFile: false,
		};
		this.requestRender();
	}

	summary(): string {
		const summary = summarizeConfig(this.loaded.config, this.loaded.path, this.loaded.loadedFromFile);
		if (this.loaded.warnings.length === 0) return summary;
		return `${summary}\nWarnings:\n${this.loaded.warnings.map((warning) => `- ${warning}`).join("\n")}`;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(0, Math.floor(width));
		if (safeWidth <= 0) return [""];

		const config = this.loaded.config;
		const symbols = getSymbols(config.display.charset);
		const palette = getThemePalette(config);
		const mode = resolveColorMode(config.display.colorCompatibility);
		const lines: string[] = [];

		for (const line of config.display.lines) {
			const segments = renderSegments(line, {
				pi: this.options.pi,
				ctx: this.options.ctx,
				footerData: this.options.footerData,
				gitDetails: this.gitCache.get(),
				metrics: this.options.metrics,
				subscription: this.options.subscription,
				symbols,
			});
			if (segments.length === 0) continue;
			lines.push(...renderFooterLine(segments, config, palette, mode, symbols, safeWidth));
		}

		const output = lines.length > 0 ? lines : [""];
		return output.map((line) => ensureWidth(line, safeWidth));
	}

	private refreshGit(): void {
		void this.gitCache.refresh().then(() => this.requestRender());
	}

	private requestRender(): void {
		if (!this.disposed) this.options.tui.requestRender();
	}

	private startConfigWatcher(): void {
		try {
			mkdirSync(getConfigDir(), { recursive: true });
			this.watcher = watch(getConfigDir(), (_event, filename) => {
				if (filename && filename.toString() !== "config.json") return;
				this.scheduleReload();
			});
		} catch {
			this.watcher = undefined;
		}
	}

	private scheduleReload(): void {
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined;
			this.reloadConfig();
		}, CONFIG_WATCH_DEBOUNCE_MS);
	}
}

function renderFooterLine(
	segments: RenderedSegment[],
	config: PowerlineConfig,
	palette: ThemePalette,
	mode: ColorMode,
	symbols: PowerlineSymbols,
	width: number,
): string[] {
	const leftSegments = segments.filter((segment) => segment.align !== "right");
	const rightSegments = segments.filter((segment) => segment.align === "right");
	if (rightSegments.length > 0) {
		return [renderAlignedLine(leftSegments, rightSegments, config, palette, mode, symbols, width)];
	}

	if (!config.display.autoWrap) {
		return [ensureWidth(renderStyledSegments(segments, config, palette, mode, symbols), width)];
	}

	const lines: string[] = [];
	let current: RenderedSegment[] = [];
	for (const segment of segments) {
		const candidate = [...current, segment];
		const renderedCandidate = renderStyledSegments(candidate, config, palette, mode, symbols);
		if (current.length > 0 && visibleWidth(renderedCandidate) > width) {
			lines.push(ensureWidth(renderStyledSegments(current, config, palette, mode, symbols), width));
			current = [segment];
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) lines.push(ensureWidth(renderStyledSegments(current, config, palette, mode, symbols), width));
	return lines;
}

function renderAlignedLine(
	leftSegments: RenderedSegment[],
	rightSegments: RenderedSegment[],
	config: PowerlineConfig,
	palette: ThemePalette,
	mode: ColorMode,
	symbols: PowerlineSymbols,
	width: number,
): string {
	const right = ensureWidth(renderStyledSegments(rightSegments, config, palette, mode, symbols), width);
	const rightWidth = visibleWidth(right);
	const leftAvailable = Math.max(0, width - rightWidth - (leftSegments.length > 0 ? 1 : 0));
	const left = leftAvailable > 0 ? ensureWidth(renderStyledSegments(leftSegments, config, palette, mode, symbols), leftAvailable) : "";
	if (!left) return right;

	const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
	return ensureWidth(left + padding + right, width);
}

function renderStyledSegments(
	segments: RenderedSegment[],
	config: PowerlineConfig,
	palette: ThemePalette,
	mode: ColorMode,
	symbols: PowerlineSymbols,
): string {
	if (config.display.style === "minimal") return renderMinimal(segments, config, palette, mode, symbols);
	if (config.display.style === "capsule") return renderCapsule(segments, config, palette, mode, symbols);
	return renderPowerline(segments, config, palette, mode, symbols);
}

function renderMinimal(
	segments: RenderedSegment[],
	config: PowerlineConfig,
	palette: ThemePalette,
	mode: ColorMode,
	symbols: PowerlineSymbols,
): string {
	const separator = colorForeground(` ${symbols.separatorThin} `, palette.colors.muted.fg, mode);
	return segments
		.map((segment) => colorPairText(pad(segment.text, config.display.padding), palette.colors[segment.colorKey], mode))
		.join(separator);
}

function renderPowerline(
	segments: RenderedSegment[],
	config: PowerlineConfig,
	palette: ThemePalette,
	mode: ColorMode,
	symbols: PowerlineSymbols,
): string {
	let output = "";
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const pair = palette.colors[segment.colorKey];
		const next = segments[i + 1];
		output += colorBlock(pad(segment.text, config.display.padding), pair, mode);
		if (next) {
			output += colorBlock(symbols.separator, { fg: pair.bg, bg: palette.colors[next.colorKey].bg }, mode);
		} else {
			output += colorForeground(symbols.separator, pair.bg, mode);
		}
	}
	return output;
}

function renderCapsule(
	segments: RenderedSegment[],
	config: PowerlineConfig,
	palette: ThemePalette,
	mode: ColorMode,
	symbols: PowerlineSymbols,
): string {
	return segments
		.map((segment) => {
			const pair = palette.colors[segment.colorKey];
			return [
				colorForeground(symbols.capsuleLeft, pair.bg, mode),
				colorBlock(pad(segment.text, config.display.padding), pair, mode),
				colorForeground(symbols.capsuleRight, pair.bg, mode),
			].join("");
		})
		.join(" ");
}

function pad(text: string, padding: number): string {
	return padding > 0 ? `${" ".repeat(padding)}${text}${" ".repeat(padding)}` : text;
}

function ensureWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	return truncateToWidth(line, width, "…");
}
