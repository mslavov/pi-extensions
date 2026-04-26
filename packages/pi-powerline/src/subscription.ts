import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SubscriptionProviderName = "codex" | "anthropic";
export type UsageErrorCode = "NO_CREDENTIALS" | "FETCH_FAILED" | "HTTP_ERROR";

export interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
}

export interface UsageError {
	code: UsageErrorCode;
	message: string;
	httpStatus?: number;
}

export interface UsageSnapshot {
	provider: SubscriptionProviderName;
	displayName: string;
	windows: RateWindow[];
	extraUsageEnabled?: boolean;
	fiveHourUsage?: number;
	lastSuccessAt?: number;
	error?: UsageError;
}

export interface SubscriptionState {
	provider?: SubscriptionProviderName;
	usage?: UsageSnapshot;
	loading: boolean;
	lastRefreshAt?: number;
}

export interface SubscriptionRefreshOptions {
	force?: boolean;
	allowStaleCache?: boolean;
	resetProvider?: boolean;
}

export interface SubscriptionController {
	readonly state: SubscriptionState;
	refresh(ctx: ExtensionContext, options?: SubscriptionRefreshOptions): Promise<void>;
	clear(): void;
}

interface CodexCredentials {
	accessToken?: string;
	accountId?: string;
}

interface CodexRateWindow {
	reset_at?: number;
	reset_after_seconds?: number;
	limit_window_seconds?: number;
	used_percent?: number;
}

interface CodexRateLimit {
	primary_window?: CodexRateWindow;
	secondary_window?: CodexRateWindow;
}

interface CodexAdditionalRateLimit {
	limit_name?: string;
	metered_feature?: string;
	rate_limit?: CodexRateLimit;
}

interface AnthropicUsageResponse {
	five_hour?: { utilization?: number; resets_at?: string };
	seven_day?: { utilization?: number; resets_at?: string };
	extra_usage?: {
		is_enabled?: boolean;
		used_credits?: number;
		monthly_limit?: number;
		utilization?: number;
	};
}

const API_TIMEOUT_MS = 5_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;

const DISPLAY_NAMES: Record<SubscriptionProviderName, string> = {
	codex: "Codex Plan",
	anthropic: "Claude Plan",
};

export function createSubscriptionController(onUpdate?: () => void): SubscriptionController {
	const state: SubscriptionState = { loading: false };
	const cache: Partial<Record<SubscriptionProviderName, UsageSnapshot>> = {};
	const lastAttemptAt: Partial<Record<SubscriptionProviderName, number>> = {};
	let inFlightProvider: SubscriptionProviderName | undefined;
	let inFlight: Promise<void> | undefined;
	let sequence = 0;

	function notify(): void {
		onUpdate?.();
	}

	function setCurrentProvider(provider: SubscriptionProviderName, options: SubscriptionRefreshOptions): void {
		const providerChanged = state.provider !== provider;
		state.provider = provider;
		if (providerChanged || options.resetProvider) {
			state.usage = options.allowStaleCache ? cache[provider] : undefined;
		} else if (!state.usage && cache[provider]) {
			state.usage = cache[provider];
		}
	}

	async function refresh(ctx: ExtensionContext, options: SubscriptionRefreshOptions = {}): Promise<void> {
		const provider = detectSubscriptionProvider(ctx.model);
		if (!provider) {
			sequence++;
			state.provider = undefined;
			state.usage = undefined;
			state.loading = false;
			notify();
			return;
		}

		const requestSequence = ++sequence;
		setCurrentProvider(provider, options);
		state.loading = !state.usage;
		notify();

		const now = Date.now();
		const previousAttempt = lastAttemptAt[provider];
		if (!options.force && previousAttempt && now - previousAttempt < MIN_REFRESH_INTERVAL_MS) {
			state.loading = false;
			notify();
			return;
		}

		if (inFlight && inFlightProvider === provider) return inFlight;

		lastAttemptAt[provider] = now;
		state.loading = true;
		notify();

		const promise = fetchAndCommit(provider, ctx, requestSequence).finally(() => {
			if (inFlight === promise) {
				inFlight = undefined;
				inFlightProvider = undefined;
			}
			if (state.provider === provider && sequence === requestSequence) {
				state.loading = false;
				notify();
			}
		});
		inFlight = promise;
		inFlightProvider = provider;
		return promise;
	}

	async function fetchAndCommit(
		provider: SubscriptionProviderName,
		ctx: ExtensionContext,
		requestSequence: number,
	): Promise<void> {
		const snapshot = provider === "codex" ? await fetchCodexUsage(ctx) : await fetchAnthropicUsage(ctx);
		const displaySnapshot = withFallbackForFetchFailure(snapshot, cache[provider]);
		if (!snapshot.error) {
			cache[provider] = displaySnapshot;
		}
		if (state.provider === provider && sequence === requestSequence) {
			state.usage = displaySnapshot;
			state.lastRefreshAt = Date.now();
			notify();
		}
	}

	function clear(): void {
		sequence++;
		state.provider = undefined;
		state.usage = undefined;
		state.loading = false;
		state.lastRefreshAt = undefined;
		delete cache.codex;
		delete cache.anthropic;
		delete lastAttemptAt.codex;
		delete lastAttemptAt.anthropic;
		inFlight = undefined;
		inFlightProvider = undefined;
		notify();
	}

	return { state, refresh, clear };
}

export function detectSubscriptionProvider(
	model: { provider?: string; id?: string } | undefined,
): SubscriptionProviderName | undefined {
	if (!model) return undefined;
	const provider = model.provider?.toLowerCase() ?? "";
	const id = model.id?.toLowerCase() ?? "";

	if (provider.includes("openai-codex") || provider.includes("codex") || id.includes("openai-codex") || id.includes("codex")) {
		return "codex";
	}
	if (provider.includes("anthropic") || id.includes("claude")) return "anthropic";
	return undefined;
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<UsageSnapshot> {
	const { accessToken, accountId } = await loadCodexCredentials(ctx);
	if (!accessToken) return emptySnapshot("codex", noCredentials());

	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		};
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;

		const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers,
			signal: controller.signal,
		});

		if (!res.ok) return emptySnapshot("codex", httpError(res.status));

		const data = (await res.json()) as {
			rate_limit?: CodexRateLimit;
			additional_rate_limits?: CodexAdditionalRateLimit[];
		};
		const windows: RateWindow[] = [];
		addCodexRateWindows(windows, data.rate_limit);
		if (Array.isArray(data.additional_rate_limits)) {
			for (const entry of data.additional_rate_limits) {
				if (!isRecord(entry)) continue;
				const prefix = getNonEmptyString(entry.limit_name) ?? getNonEmptyString(entry.metered_feature) ?? "Additional";
				const rateLimit = isRecord(entry.rate_limit) ? (entry.rate_limit as CodexRateLimit) : undefined;
				addCodexRateWindows(windows, rateLimit, prefix);
			}
		}

		return snapshot("codex", { windows });
	} catch {
		return emptySnapshot("codex", fetchFailed());
	} finally {
		clear();
	}
}

async function fetchAnthropicUsage(ctx: ExtensionContext): Promise<UsageSnapshot> {
	const token = await loadAnthropicToken(ctx);
	if (!token) return emptySnapshot("anthropic", noCredentials());

	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: controller.signal,
		});

		if (!res.ok) return emptySnapshot("anthropic", httpError(res.status));

		const data = (await res.json()) as AnthropicUsageResponse;
		const windows: RateWindow[] = [];
		const fiveHourUsage = clampPercent(data.five_hour?.utilization ?? 0);

		if (typeof data.five_hour?.utilization === "number") {
			const resetAt = parseDate(data.five_hour.resets_at);
			windows.push({
				label: "5h",
				usedPercent: fiveHourUsage,
				resetDescription: resetAt ? formatReset(resetAt) : undefined,
				resetAt: resetAt?.toISOString(),
			});
		}

		if (typeof data.seven_day?.utilization === "number") {
			const resetAt = parseDate(data.seven_day.resets_at);
			windows.push({
				label: "Week",
				usedPercent: clampPercent(data.seven_day.utilization),
				resetDescription: resetAt ? formatReset(resetAt) : undefined,
				resetAt: resetAt?.toISOString(),
			});
		}

		const extraUsageEnabled = data.extra_usage?.is_enabled === true;
		if (extraUsageEnabled) {
			const extra = data.extra_usage!;
			const status = fiveHourUsage >= 99 ? "active" : "on";
			windows.push({
				label: formatExtraUsageLabel(status, extra.used_credits, extra.monthly_limit),
				usedPercent: clampPercent(extra.utilization ?? 0),
				resetDescription: status === "active" ? "__ACTIVE__" : undefined,
			});
		}

		return snapshot("anthropic", { windows, extraUsageEnabled, fiveHourUsage });
	} catch {
		return emptySnapshot("anthropic", fetchFailed());
	} finally {
		clear();
	}
}

async function loadCodexCredentials(ctx: ExtensionContext): Promise<CodexCredentials> {
	const envAccessToken = firstEnv(["OPENAI_CODEX_OAUTH_TOKEN", "OPENAI_CODEX_ACCESS_TOKEN", "CODEX_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"]);
	const envAccountId = firstEnv(["OPENAI_CODEX_ACCOUNT_ID", "CHATGPT_ACCOUNT_ID"]);
	if (envAccessToken) {
		return {
			accessToken: envAccessToken,
			accountId: envAccountId ?? loadCodexAccountIdFromDisk() ?? extractAccountIdFromJwt(envAccessToken),
		};
	}

	const accessToken = await loadActiveOAuthToken(ctx, "codex");
	return {
		accessToken,
		accountId: envAccountId ?? loadCodexAccountIdFromDisk() ?? (accessToken ? extractAccountIdFromJwt(accessToken) : undefined),
	};
}

async function loadAnthropicToken(ctx: ExtensionContext): Promise<string | undefined> {
	const envToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
	if (envToken) return envToken;
	return loadActiveOAuthToken(ctx, "anthropic");
}

async function loadActiveOAuthToken(ctx: ExtensionContext, provider: SubscriptionProviderName): Promise<string | undefined> {
	if (!ctx.model || detectSubscriptionProvider(ctx.model) !== provider) return undefined;
	try {
		if (!ctx.modelRegistry.isUsingOAuth(ctx.model)) return undefined;
		const token = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
		return token?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function loadCodexAccountIdFromDisk(): string | undefined {
	const piAuth = readJson(join(homedir(), ".pi", "agent", "auth.json"));
	const piEntry = isRecord(piAuth?.["openai-codex"]) ? piAuth["openai-codex"] : undefined;
	const piAccountId = getRecordString(piEntry, ["accountId", "account_id", "chatgptAccountId", "chatgpt_account_id"]);
	if (piAccountId) return piAccountId;

	const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
	const codexAuth = readJson(join(codexHome, "auth.json"));
	const tokenEntry = isRecord(codexAuth?.tokens) ? codexAuth.tokens : undefined;
	return getRecordString(tokenEntry, ["account_id", "accountId"]);
}

function addCodexRateWindows(windows: RateWindow[], rateLimit: CodexRateLimit | undefined, prefix?: string): void {
	pushCodexWindow(windows, prefix, rateLimit?.primary_window, 10_800);
	pushCodexWindow(windows, prefix, rateLimit?.secondary_window, 86_400);
}

function pushCodexWindow(
	windows: RateWindow[],
	prefix: string | undefined,
	window: CodexRateWindow | undefined,
	fallbackWindowSeconds: number,
): void {
	if (!window) return;
	const resetDate = getCodexResetDate(window);
	const label = getWindowLabel(window.limit_window_seconds, fallbackWindowSeconds);
	windows.push({
		label: prefix ? `${prefix} ${label}` : label,
		usedPercent: clampPercent(window.used_percent ?? 0),
		resetDescription: resetDate ? formatReset(resetDate) : undefined,
		resetAt: resetDate?.toISOString(),
	});
}

function getCodexResetDate(window: CodexRateWindow): Date | undefined {
	if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at) && window.reset_at > 0) {
		return new Date(window.reset_at * 1_000);
	}
	if (
		typeof window.reset_after_seconds === "number" &&
		Number.isFinite(window.reset_after_seconds) &&
		window.reset_after_seconds > 0
	) {
		return new Date(Date.now() + window.reset_after_seconds * 1_000);
	}
	return undefined;
}

function getWindowLabel(windowSeconds?: number, fallbackWindowSeconds?: number): string {
	const safeWindowSeconds =
		typeof windowSeconds === "number" && windowSeconds > 0
			? windowSeconds
			: typeof fallbackWindowSeconds === "number" && fallbackWindowSeconds > 0
				? fallbackWindowSeconds
				: 0;
	if (!safeWindowSeconds) return "0h";
	const hours = Math.round(safeWindowSeconds / 3_600);
	if (hours >= 144) return "Week";
	if (hours >= 24) return "Day";
	return `${hours}h`;
}

function formatExtraUsageLabel(status: "on" | "active", usedCredits?: number, monthlyLimit?: number): string {
	const label = `Extra [${status}]`;
	const used = typeof usedCredits === "number" && Number.isFinite(usedCredits) ? usedCredits : undefined;
	const limit = typeof monthlyLimit === "number" && Number.isFinite(monthlyLimit) && monthlyLimit > 0 ? monthlyLimit : undefined;
	if (used === undefined) return label;
	if (limit) return `${label} ${formatCredits(used)}/${formatCredits(limit)}`;
	return `${label} ${formatCredits(used)}`;
}

function formatCredits(credits: number): string {
	return `$${(credits / 100).toFixed(2)}`;
}

function withFallbackForFetchFailure(snapshot: UsageSnapshot, fallback: UsageSnapshot | undefined): UsageSnapshot {
	const now = Date.now();
	if (!snapshot.error) return { ...snapshot, lastSuccessAt: now };
	if (snapshot.error.code !== "NO_CREDENTIALS" && fallback?.windows.length) {
		return { ...fallback, error: snapshot.error };
	}
	return snapshot;
}

function snapshot(provider: SubscriptionProviderName, data: Partial<Omit<UsageSnapshot, "provider" | "displayName">>): UsageSnapshot {
	return { provider, displayName: DISPLAY_NAMES[provider], windows: [], ...data };
}

function emptySnapshot(provider: SubscriptionProviderName, error: UsageError): UsageSnapshot {
	return snapshot(provider, { error });
}

function noCredentials(): UsageError {
	return { code: "NO_CREDENTIALS", message: "No OAuth credentials found" };
}

function fetchFailed(): UsageError {
	return { code: "FETCH_FAILED", message: "Fetch failed" };
}

function httpError(status: number): UsageError {
	return { code: "HTTP_ERROR", message: `HTTP ${status}`, httpStatus: status };
}

export function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (!Number.isFinite(diffMs) || diffMs < 0) return "now";

	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 60) return `${diffMins}m`;

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function createTimeoutController(timeoutMs: number): { controller: AbortController; clear: () => void } {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	return { controller, clear: () => clearTimeout(timeoutId) };
}

export function normalizeTokens(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
}

export function prioritizeWindowsForModel(windows: RateWindow[], model?: { id?: string } | null): RateWindow[] {
	if (!model?.id || windows.length <= 1) return windows;

	const modelTokens = normalizeTokens(model.id);
	if (modelTokens.length === 0) return windows;

	const matched: RateWindow[] = [];
	const rest: RateWindow[] = [];
	for (const window of windows) {
		const labelTokens = normalizeTokens(window.label);
		const isMatch = modelTokens.every((token) => labelTokens.includes(token)) && modelTokens.length * 2 > labelTokens.length;
		if (isMatch) matched.push(window);
		else rest.push(window);
	}

	if (matched.length === 0 || matched.length === windows.length) return windows;
	return [...matched, ...rest];
}

function firstEnv(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function extractAccountIdFromJwt(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	return getRecordString(payload, [
		"account_id",
		"accountId",
		"chatgpt_account_id",
		"chatgptAccountId",
		"https://api.openai.com/auth/account_id",
		"https://api.openai.com/auth/chatgpt_account_id",
	]);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function getNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRecordString(record: unknown, keys: string[]): string | undefined {
	if (!isRecord(record)) return undefined;
	for (const key of keys) {
		const value = getNonEmptyString(record[key]);
		if (value) return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
