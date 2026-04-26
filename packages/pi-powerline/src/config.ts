import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BuiltInThemeName = "dark" | "light" | "nord" | "tokyo-night" | "rose-pine" | "gruvbox";
export type ThemeName = BuiltInThemeName | "custom";
export type FooterStyle = "minimal" | "powerline" | "capsule";
export type Charset = "unicode" | "text";
export type ColorCompatibility = "auto" | "ansi" | "ansi256" | "truecolor";
export type DirectoryStyle = "full" | "fish" | "basename";
export type SessionDisplayType = "cost" | "tokens" | "both" | "breakdown";
export type ContextDisplayStyle = "text" | "bar" | "blocks" | "blocks-line" | "dots";
export type SegmentAlignment = "left" | "right";
export type SegmentName =
	| "directory"
	| "git"
	| "model"
	| "session"
	| "subscription"
	| "context"
	| "metrics"
	| "sessionId"
	| "env"
	| "tmux"
	| "status";
export type UnsupportedSegmentName = "today" | "block" | "weekly";
export type ThemeColorKey = SegmentName | "warning" | "critical" | "muted";

export interface SegmentConfig {
	enabled: boolean;
	align?: SegmentAlignment;
	style?: DirectoryStyle;
	showSha?: boolean;
	showWorkingTree?: boolean;
	showOperation?: boolean;
	showTag?: boolean;
	showTimeSinceCommit?: boolean;
	showStashCount?: boolean;
	showUpstream?: boolean;
	showRepoName?: boolean;
	type?: SessionDisplayType;
	displayStyle?: ContextDisplayStyle;
	showPercentageOnly?: boolean;
	showTokensOnly?: boolean;
	showProviderName?: boolean;
	showReset?: boolean;
	showPercentage?: boolean;
	maxWindows?: number;
	width?: number;
	warningThreshold?: number;
	criticalThreshold?: number;
	showDuration?: boolean;
	showMessages?: boolean;
	showLastResponse?: boolean;
	length?: number;
	full?: boolean;
	variable?: string;
	prefix?: string;
	default?: string;
	label?: string;
}

export interface DisplayLineConfig {
	segments: Partial<Record<SegmentName, SegmentConfig>>;
}

export interface CustomColorPair {
	fg?: string;
	bg?: string;
}

export type CustomThemeConfig = Partial<Record<ThemeColorKey, CustomColorPair>>;

export interface PowerlineConfig {
	theme: ThemeName;
	colors?: {
		custom?: CustomThemeConfig;
	};
	display: {
		style: FooterStyle;
		charset: Charset;
		colorCompatibility: ColorCompatibility;
		autoWrap: boolean;
		padding: number;
		lines: DisplayLineConfig[];
	};
}

export interface LoadedPowerlineConfig {
	path: string;
	config: PowerlineConfig;
	warnings: string[];
	loadedFromFile: boolean;
}

const THEME_NAMES = new Set<ThemeName>(["dark", "light", "nord", "tokyo-night", "rose-pine", "gruvbox", "custom"]);
const FOOTER_STYLES = new Set<FooterStyle>(["minimal", "powerline", "capsule"]);
const CHARSETS = new Set<Charset>(["unicode", "text"]);
const COLOR_COMPATIBILITY = new Set<ColorCompatibility>(["auto", "ansi", "ansi256", "truecolor"]);
const DIRECTORY_STYLES = new Set<DirectoryStyle>(["full", "fish", "basename"]);
const SESSION_TYPES = new Set<SessionDisplayType>(["cost", "tokens", "both", "breakdown"]);
const CONTEXT_STYLES = new Set<ContextDisplayStyle>(["text", "bar", "blocks", "blocks-line", "dots"]);
const SEGMENT_ALIGNMENTS = new Set<SegmentAlignment>(["left", "right"]);
const SEGMENT_NAMES = new Set<SegmentName>([
	"directory",
	"git",
	"model",
	"session",
	"subscription",
	"context",
	"metrics",
	"sessionId",
	"env",
	"tmux",
	"status",
]);
const UNSUPPORTED_SEGMENTS = new Set<UnsupportedSegmentName>(["today", "block", "weekly"]);
const THEME_COLOR_KEYS = new Set<ThemeColorKey>([
	"directory",
	"git",
	"model",
	"session",
	"subscription",
	"context",
	"metrics",
	"sessionId",
	"env",
	"tmux",
	"status",
	"warning",
	"critical",
	"muted",
]);

export const DEFAULT_CONFIG: PowerlineConfig = {
	theme: "dark",
	display: {
		style: "powerline",
		charset: "text",
		colorCompatibility: "auto",
		autoWrap: true,
		padding: 1,
		lines: [
			{
				segments: {
					directory: { enabled: true, style: "fish" },
					git: { enabled: true, showSha: true, showWorkingTree: true },
					model: { enabled: true },
					session: { enabled: true, type: "tokens" },
				},
			},
			{
				segments: {
					subscription: { enabled: true, showProviderName: true, showReset: true, maxWindows: 3 },
					context: { enabled: true, displayStyle: "bar" },
					metrics: { enabled: true },
					status: { enabled: true },
				},
			},
		],
	},
};

export function getConfigDir(): string {
	return join(homedir(), ".pi", "agent", "extensions", "pi-powerline");
}

export function getConfigPath(): string {
	return join(getConfigDir(), "config.json");
}

export function getDefaultConfig(): PowerlineConfig {
	return clone(DEFAULT_CONFIG);
}

export function loadConfig(path = getConfigPath()): LoadedPowerlineConfig {
	if (!existsSync(path)) {
		return { path, config: getDefaultConfig(), warnings: [], loadedFromFile: false };
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		return {
			path,
			config: getDefaultConfig(),
			warnings: [`Could not read config.json: ${error instanceof Error ? error.message : String(error)}`],
			loadedFromFile: false,
		};
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		const warnings: string[] = [];
		return {
			path,
			config: normalizeConfig(parsed, warnings),
			warnings,
			loadedFromFile: true,
		};
	} catch (error) {
		return {
			path,
			config: getDefaultConfig(),
			warnings: [`Could not parse config.json: ${error instanceof Error ? error.message : String(error)}`],
			loadedFromFile: false,
		};
	}
}

export function normalizeConfig(input: unknown, warnings: string[] = []): PowerlineConfig {
	const config = getDefaultConfig();
	if (!isRecord(input)) {
		warnings.push("Config root must be an object; using defaults.");
		return config;
	}

	if (typeof input.theme === "string") {
		if (THEME_NAMES.has(input.theme as ThemeName)) {
			config.theme = input.theme as ThemeName;
		} else {
			warnings.push(`Unsupported theme '${input.theme}'; using '${config.theme}'.`);
		}
	}

	const customColors = normalizeCustomColors(input.colors, warnings);
	if (customColors) {
		config.colors = { custom: customColors };
	}

	if (isRecord(input.display)) {
		const display = input.display;

		if (typeof display.style === "string") {
			if (FOOTER_STYLES.has(display.style as FooterStyle)) {
				config.display.style = display.style as FooterStyle;
			} else if (display.style === "tui") {
				config.display.style = "powerline";
				warnings.push("display.style 'tui' is not supported yet; using 'powerline'.");
			} else {
				warnings.push(`Unsupported display.style '${display.style}'; using '${config.display.style}'.`);
			}
		}

		if (typeof display.charset === "string") {
			if (CHARSETS.has(display.charset as Charset)) {
				config.display.charset = display.charset as Charset;
			} else {
				warnings.push(`Unsupported display.charset '${display.charset}'; using '${config.display.charset}'.`);
			}
		}

		if (typeof display.colorCompatibility === "string") {
			if (COLOR_COMPATIBILITY.has(display.colorCompatibility as ColorCompatibility)) {
				config.display.colorCompatibility = display.colorCompatibility as ColorCompatibility;
			} else {
				warnings.push(
					`Unsupported display.colorCompatibility '${display.colorCompatibility}'; using '${config.display.colorCompatibility}'.`,
				);
			}
		}

		if (typeof display.autoWrap === "boolean") {
			config.display.autoWrap = display.autoWrap;
		}

		if (typeof display.padding === "number" && Number.isFinite(display.padding)) {
			config.display.padding = clampInteger(display.padding, 0, 4);
		}

		if (Array.isArray(display.lines)) {
			const lines = display.lines
				.map((line, index) => normalizeLine(line, warnings, index))
				.filter((line): line is DisplayLineConfig => Boolean(line));
			if (lines.length > 0) {
				config.display.lines = lines;
			} else {
				warnings.push("display.lines did not contain any supported segments; using default lines.");
			}
		}
	}

	return config;
}

export function summarizeConfig(config: PowerlineConfig, path = getConfigPath(), loadedFromFile = existsSync(path)): string {
	const segmentLines = config.display.lines.map((line) => Object.keys(line.segments).join(", ") || "none");
	return [
		`Config: ${path}${loadedFromFile ? "" : " (defaults)"}`,
		`Theme: ${config.theme}`,
		`Display: ${config.display.style}, ${config.display.charset}, colors=${config.display.colorCompatibility}, wrap=${config.display.autoWrap}`,
		`Lines: ${segmentLines.map((segments, i) => `${i + 1}: ${segments}`).join(" | ")}`,
	].join("\n");
}

function normalizeLine(input: unknown, warnings: string[], index: number): DisplayLineConfig | undefined {
	if (!isRecord(input) || !isRecord(input.segments)) {
		warnings.push(`display.lines[${index}] must contain a segments object; skipping it.`);
		return undefined;
	}

	const segments: Partial<Record<SegmentName, SegmentConfig>> = {};
	for (const [rawName, rawSegment] of Object.entries(input.segments)) {
		if (SEGMENT_NAMES.has(rawName as SegmentName)) {
			const name = rawName as SegmentName;
			const segment = normalizeSegment(name, rawSegment, warnings);
			if (segment) segments[name] = segment;
			continue;
		}

		if (UNSUPPORTED_SEGMENTS.has(rawName as UnsupportedSegmentName)) {
			if (segmentIsEnabled(rawSegment)) {
				warnings.push(`Segment '${rawName}' needs Claude usage data that pi does not expose; ignoring it.`);
			}
			continue;
		}

		warnings.push(`Unsupported segment '${rawName}'; ignoring it.`);
	}

	return Object.keys(segments).length > 0 ? { segments } : undefined;
}

function normalizeSegment(name: SegmentName, input: unknown, warnings: string[]): SegmentConfig | undefined {
	const segment = getSegmentDefaults(name);

	if (typeof input === "boolean") {
		segment.enabled = input;
		return segment;
	}

	if (!isRecord(input)) {
		warnings.push(`Segment '${name}' must be an object or boolean; ignoring it.`);
		return undefined;
	}

	if (typeof input.enabled === "boolean") segment.enabled = input.enabled;
	if (typeof input.align === "string") {
		if (SEGMENT_ALIGNMENTS.has(input.align as SegmentAlignment)) segment.align = input.align as SegmentAlignment;
		else warnings.push(`Unsupported ${name}.align '${input.align}'; using left alignment.`);
	}

	if (name === "directory" && typeof input.style === "string") {
		if (DIRECTORY_STYLES.has(input.style as DirectoryStyle)) segment.style = input.style as DirectoryStyle;
		else warnings.push(`Unsupported directory.style '${input.style}'; using the segment default.`);
	}

	if (name === "git") {
		copyBooleans(input, segment, [
			"showSha",
			"showWorkingTree",
			"showOperation",
			"showTag",
			"showTimeSinceCommit",
			"showStashCount",
			"showUpstream",
			"showRepoName",
		]);
	}

	if (name === "session" && typeof input.type === "string") {
		if (SESSION_TYPES.has(input.type as SessionDisplayType)) segment.type = input.type as SessionDisplayType;
		else warnings.push(`Unsupported session.type '${input.type}'; using the segment default.`);
	}

	if (name === "context") {
		if (typeof input.displayStyle === "string") {
			if (CONTEXT_STYLES.has(input.displayStyle as ContextDisplayStyle)) {
				segment.displayStyle = input.displayStyle as ContextDisplayStyle;
			} else {
				warnings.push(`Unsupported context.displayStyle '${input.displayStyle}'; using the segment default.`);
			}
		}
		if (typeof input.showPercentageOnly === "boolean") segment.showPercentageOnly = input.showPercentageOnly;
		if (typeof input.showTokensOnly === "boolean") segment.showTokensOnly = input.showTokensOnly;
		copyNumber(input, segment, "width", 4, 40);
		copyNumber(input, segment, "warningThreshold", 1, 100);
		copyNumber(input, segment, "criticalThreshold", 1, 100);
	}

	if (name === "subscription") {
		copyBooleans(input, segment, ["showProviderName", "showReset", "showPercentage"]);
		copyNumber(input, segment, "maxWindows", 1, 8);
	}

	if (name === "metrics") {
		copyBooleans(input, segment, ["showDuration", "showMessages", "showLastResponse"]);
	}

	if (name === "sessionId") {
		copyNumber(input, segment, "length", 4, 64);
		if (typeof input.full === "boolean") segment.full = input.full;
	}

	if (name === "env") {
		copyString(input, segment, "variable");
		copyString(input, segment, "prefix");
		copyString(input, segment, "default");
	}

	if (name === "tmux") {
		copyString(input, segment, "label");
	}

	return segment;
}

function normalizeCustomColors(input: unknown, warnings: string[]): CustomThemeConfig | undefined {
	if (!isRecord(input) || !isRecord(input.custom)) return undefined;

	const custom: CustomThemeConfig = {};
	for (const [key, value] of Object.entries(input.custom)) {
		if (!THEME_COLOR_KEYS.has(key as ThemeColorKey)) {
			warnings.push(`Unsupported custom color key '${key}'; ignoring it.`);
			continue;
		}
		if (!isRecord(value)) {
			warnings.push(`colors.custom.${key} must be an object with fg/bg colors; ignoring it.`);
			continue;
		}
		const pair: CustomColorPair = {};
		if (typeof value.fg === "string" && isHexColor(value.fg)) pair.fg = normalizeHex(value.fg);
		if (typeof value.bg === "string" && isHexColor(value.bg)) pair.bg = normalizeHex(value.bg);
		if (pair.fg || pair.bg) custom[key as ThemeColorKey] = pair;
	}

	return Object.keys(custom).length > 0 ? custom : undefined;
}

function getSegmentDefaults(name: SegmentName): SegmentConfig {
	switch (name) {
		case "directory":
			return { enabled: true, style: "fish" };
		case "git":
			return { enabled: true, showSha: true, showWorkingTree: true };
		case "session":
			return { enabled: true, type: "tokens" };
		case "context":
			return { enabled: true, displayStyle: "bar" };
		case "subscription":
			return { enabled: true, showProviderName: true, showReset: true, showPercentage: true, maxWindows: 3 };
		case "metrics":
			return { enabled: true, showDuration: true, showMessages: true, showLastResponse: true };
		case "sessionId":
			return { enabled: true, length: 8 };
		case "tmux":
			return { enabled: true, label: "tmux" };
		default:
			return { enabled: true };
	}
}

function segmentIsEnabled(input: unknown): boolean {
	if (typeof input === "boolean") return input;
	if (isRecord(input) && typeof input.enabled === "boolean") return input.enabled;
	return true;
}

function copyBooleans(input: Record<string, unknown>, segment: SegmentConfig, keys: (keyof SegmentConfig)[]): void {
	for (const key of keys) {
		if (typeof input[key] === "boolean") {
			(segment as unknown as Record<string, unknown>)[key] = input[key];
		}
	}
}

function copyString(input: Record<string, unknown>, segment: SegmentConfig, key: keyof SegmentConfig): void {
	if (typeof input[key] === "string") {
		(segment as unknown as Record<string, unknown>)[key] = input[key];
	}
}

function copyNumber(
	input: Record<string, unknown>,
	segment: SegmentConfig,
	key: keyof SegmentConfig,
	min: number,
	max: number,
): void {
	if (typeof input[key] === "number" && Number.isFinite(input[key])) {
		(segment as unknown as Record<string, unknown>)[key] = clampInteger(input[key], min, max);
	}
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexColor(value: string): boolean {
	return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
}

function normalizeHex(value: string): string {
	if (value.length === 4) {
		return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase();
	}
	return value.toLowerCase();
}
