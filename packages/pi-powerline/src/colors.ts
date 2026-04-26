import type { ColorCompatibility, PowerlineConfig, ThemeColorKey } from "./config.js";

export type ColorMode = "none" | "ansi" | "ansi256" | "truecolor";

export interface ColorPair {
	fg: string;
	bg: string;
}

export interface ThemePalette {
	colors: Record<ThemeColorKey, ColorPair>;
}

const THEME_KEYS: ThemeColorKey[] = [
	"directory",
	"git",
	"model",
	"session",
	"context",
	"metrics",
	"sessionId",
	"env",
	"tmux",
	"status",
	"warning",
	"critical",
	"muted",
];

const THEMES: Record<string, ThemePalette> = {
	dark: makeTheme({
		directory: ["#f8fafc", "#2563eb"],
		git: ["#052e16", "#22c55e"],
		model: ["#ffffff", "#7c3aed"],
		session: ["#111827", "#f59e0b"],
		context: ["#ecfeff", "#0891b2"],
		metrics: ["#e0e7ff", "#4f46e5"],
		sessionId: ["#e5e7eb", "#475569"],
		env: ["#022c22", "#14b8a6"],
		tmux: ["#fef3c7", "#92400e"],
		status: ["#f8fafc", "#334155"],
		warning: ["#111827", "#fbbf24"],
		critical: ["#ffffff", "#dc2626"],
		muted: ["#cbd5e1", "#1f2937"],
	}),
	light: makeTheme({
		directory: ["#ffffff", "#1d4ed8"],
		git: ["#052e16", "#86efac"],
		model: ["#ffffff", "#6d28d9"],
		session: ["#451a03", "#fcd34d"],
		context: ["#083344", "#67e8f9"],
		metrics: ["#172554", "#93c5fd"],
		sessionId: ["#111827", "#d1d5db"],
		env: ["#042f2e", "#5eead4"],
		tmux: ["#431407", "#fdba74"],
		status: ["#111827", "#e5e7eb"],
		warning: ["#451a03", "#fde68a"],
		critical: ["#ffffff", "#ef4444"],
		muted: ["#374151", "#e5e7eb"],
	}),
	nord: makeTheme({
		directory: ["#eceff4", "#5e81ac"],
		git: ["#2e3440", "#a3be8c"],
		model: ["#2e3440", "#b48ead"],
		session: ["#2e3440", "#ebcb8b"],
		context: ["#2e3440", "#88c0d0"],
		metrics: ["#eceff4", "#81a1c1"],
		sessionId: ["#d8dee9", "#4c566a"],
		env: ["#2e3440", "#8fbcbb"],
		tmux: ["#2e3440", "#d08770"],
		status: ["#d8dee9", "#434c5e"],
		warning: ["#2e3440", "#ebcb8b"],
		critical: ["#eceff4", "#bf616a"],
		muted: ["#d8dee9", "#3b4252"],
	}),
	"tokyo-night": makeTheme({
		directory: ["#c0caf5", "#2f7dc8"],
		git: ["#1a1b26", "#9ece6a"],
		model: ["#c0caf5", "#7aa2f7"],
		session: ["#1a1b26", "#e0af68"],
		context: ["#1a1b26", "#7dcfff"],
		metrics: ["#c0caf5", "#565f89"],
		sessionId: ["#c0caf5", "#414868"],
		env: ["#1a1b26", "#73daca"],
		tmux: ["#1a1b26", "#ff9e64"],
		status: ["#c0caf5", "#24283b"],
		warning: ["#1a1b26", "#e0af68"],
		critical: ["#c0caf5", "#f7768e"],
		muted: ["#a9b1d6", "#1f2335"],
	}),
	"rose-pine": makeTheme({
		directory: ["#e0def4", "#31748f"],
		git: ["#191724", "#9ccfd8"],
		model: ["#e0def4", "#c4a7e7"],
		session: ["#191724", "#f6c177"],
		context: ["#191724", "#ebbcba"],
		metrics: ["#e0def4", "#6e6a86"],
		sessionId: ["#e0def4", "#403d52"],
		env: ["#191724", "#31748f"],
		tmux: ["#191724", "#eb6f92"],
		status: ["#e0def4", "#26233a"],
		warning: ["#191724", "#f6c177"],
		critical: ["#e0def4", "#eb6f92"],
		muted: ["#908caa", "#21202e"],
	}),
	gruvbox: makeTheme({
		directory: ["#fbf1c7", "#458588"],
		git: ["#282828", "#98971a"],
		model: ["#fbf1c7", "#b16286"],
		session: ["#282828", "#d79921"],
		context: ["#282828", "#83a598"],
		metrics: ["#fbf1c7", "#665c54"],
		sessionId: ["#ebdbb2", "#504945"],
		env: ["#282828", "#8ec07c"],
		tmux: ["#282828", "#fe8019"],
		status: ["#ebdbb2", "#3c3836"],
		warning: ["#282828", "#fabd2f"],
		critical: ["#fbf1c7", "#cc241d"],
		muted: ["#d5c4a1", "#3c3836"],
	}),
};

export function resolveColorMode(compatibility: ColorCompatibility): ColorMode {
	if (process.env.NO_COLOR || process.env.TERM === "dumb" || process.env.FORCE_COLOR === "0") {
		return "none";
	}

	if (compatibility !== "auto") return compatibility;

	const colorTerm = (process.env.COLORTERM ?? "").toLowerCase();
	if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return "truecolor";
	if ((process.env.TERM ?? "").includes("256color")) return "ansi256";
	return "ansi";
}

export function getThemePalette(config: PowerlineConfig): ThemePalette {
	const base = THEMES[config.theme === "custom" ? "dark" : config.theme] ?? THEMES.dark;
	const palette = clonePalette(base);
	const custom = config.colors?.custom;
	if (!custom) return palette;

	for (const key of THEME_KEYS) {
		const pair = custom[key];
		if (!pair) continue;
		palette.colors[key] = {
			fg: pair.fg ?? palette.colors[key].fg,
			bg: pair.bg ?? palette.colors[key].bg,
		};
	}
	return palette;
}

export function colorBlock(text: string, pair: ColorPair, mode: ColorMode): string {
	return applyAnsi(text, mode, pair.fg, pair.bg);
}

export function colorForeground(text: string, color: string, mode: ColorMode): string {
	return applyAnsi(text, mode, color);
}

export function colorPairText(text: string, pair: ColorPair, mode: ColorMode): string {
	return applyAnsi(text, mode, pair.fg);
}

function makeTheme(colors: Record<ThemeColorKey, [fg: string, bg: string]>): ThemePalette {
	const pairs = {} as Record<ThemeColorKey, ColorPair>;
	for (const key of THEME_KEYS) {
		const [fg, bg] = colors[key];
		pairs[key] = { fg, bg };
	}
	return { colors: pairs };
}

function clonePalette(palette: ThemePalette): ThemePalette {
	const colors = {} as Record<ThemeColorKey, ColorPair>;
	for (const key of THEME_KEYS) {
		colors[key] = { ...palette.colors[key] };
	}
	return { colors };
}

function applyAnsi(text: string, mode: ColorMode, fg?: string, bg?: string): string {
	if (mode === "none") return text;
	const codes: string[] = [];
	if (fg) codes.push(colorCode(fg, false, mode));
	if (bg) codes.push(colorCode(bg, true, mode));
	const validCodes = codes.filter(Boolean);
	return validCodes.length > 0 ? `\x1b[${validCodes.join(";")}m${text}\x1b[0m` : text;
}

function colorCode(hex: string, background: boolean, mode: Exclude<ColorMode, "none">): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return "";
	if (mode === "truecolor") {
		return `${background ? 48 : 38};2;${rgb.r};${rgb.g};${rgb.b}`;
	}
	if (mode === "ansi256") {
		return `${background ? 48 : 38};5;${rgbToAnsi256(rgb.r, rgb.g, rgb.b)}`;
	}
	return String(nearestAnsi16(rgb.r, rgb.g, rgb.b, background));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	if (!/^[\da-f]{6}$/i.test(normalized)) return undefined;
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

function rgbToAnsi256(r: number, g: number, b: number): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	const red = Math.round((r / 255) * 5);
	const green = Math.round((g / 255) * 5);
	const blue = Math.round((b / 255) * 5);
	return 16 + 36 * red + 6 * green + blue;
}

const ANSI16_COLORS = [
	{ rgb: [0, 0, 0], fg: 30, bg: 40 },
	{ rgb: [128, 0, 0], fg: 31, bg: 41 },
	{ rgb: [0, 128, 0], fg: 32, bg: 42 },
	{ rgb: [128, 128, 0], fg: 33, bg: 43 },
	{ rgb: [0, 0, 128], fg: 34, bg: 44 },
	{ rgb: [128, 0, 128], fg: 35, bg: 45 },
	{ rgb: [0, 128, 128], fg: 36, bg: 46 },
	{ rgb: [192, 192, 192], fg: 37, bg: 47 },
	{ rgb: [128, 128, 128], fg: 90, bg: 100 },
	{ rgb: [255, 0, 0], fg: 91, bg: 101 },
	{ rgb: [0, 255, 0], fg: 92, bg: 102 },
	{ rgb: [255, 255, 0], fg: 93, bg: 103 },
	{ rgb: [0, 0, 255], fg: 94, bg: 104 },
	{ rgb: [255, 0, 255], fg: 95, bg: 105 },
	{ rgb: [0, 255, 255], fg: 96, bg: 106 },
	{ rgb: [255, 255, 255], fg: 97, bg: 107 },
] as const;

function nearestAnsi16(r: number, g: number, b: number, background: boolean): number {
	let best: (typeof ANSI16_COLORS)[number] = ANSI16_COLORS[0];
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of ANSI16_COLORS) {
		const [cr, cg, cb] = candidate.rgb;
		const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return background ? best.bg : best.fg;
}
