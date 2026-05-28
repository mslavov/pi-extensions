import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MACOS_IOREG_PATH = "/usr/sbin/ioreg";
export const MACOS_IOREG_ARGS = ["-l", "-c", "IOHIDSystem"];

export function parseMacOsHidIdleSeconds(output) {
	const match = output.match(/"HIDIdleTime"\s*=\s*(\d+)/);
	if (!match) return undefined;
	const nanoseconds = Number(match[1]);
	if (!Number.isFinite(nanoseconds)) return undefined;
	return Math.floor(nanoseconds / 1_000_000_000);
}

export async function readMacOsHidIdleSeconds(options = {}) {
	const { stdout } = await execFileAsync(MACOS_IOREG_PATH, MACOS_IOREG_ARGS, {
		timeout: options.timeoutMs ?? 2_000,
		maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
	});
	const idleSeconds = parseMacOsHidIdleSeconds(stdout);
	if (idleSeconds === undefined) throw new Error("Unable to parse HIDIdleTime from ioreg output.");
	return idleSeconds;
}

export async function readMacOsHidIdleStatus(options = {}) {
	try {
		return { ok: true, idleSeconds: await readMacOsHidIdleSeconds(options) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function derivePresenceState(idleSeconds, previousState, settings) {
	if (idleSeconds >= settings.awayAfterSeconds) return "away";
	if (previousState === "away" && idleSeconds > settings.presentBelowSeconds) return "away";
	return "present";
}

export function shouldSendProactiveNotification({ presence, notificationKind = "progress", hasActiveTelegramTurn = false }) {
	if (hasActiveTelegramTurn) {
		return { send: false, presence, reason: "Telegram-originated turns already stream previews" };
	}
	if ((notificationKind === "completion" || notificationKind === "waiting" || notificationKind === "error") && presence.notificationPolicy === "away_only") {
		return { send: true, presence };
	}
	if (presence.notificationPolicy === "always") return { send: true, presence };
	if (presence.notificationPolicy === "never") return { send: false, presence, reason: "Telegram proactive notifications are disabled" };
	if (presence.notificationPolicy === "present_only") {
		return presence.state === "present"
			? { send: true, presence }
			: { send: false, presence, reason: `Presence is ${presence.state}; proactive notifications require present` };
	}
	return presence.state === "away"
		? { send: true, presence }
		: { send: false, presence, reason: `Presence is ${presence.state}; proactive notifications require away` };
}

export function shouldQueuePresenceDelayedNotification({ presence, notificationKind = "progress", hasActiveTelegramTurn = false }) {
	if (hasActiveTelegramTurn) return false;
	if (notificationKind !== "progress" && notificationKind !== "notify") return false;
	return Boolean(presence.enabled && presence.notificationPolicy === "away_only" && presence.state !== "away");
}

export function formatPresenceQueuedSummary({ sessionLabel = "pi session", messages, itemLimit = 5 }) {
	const visibleMessages = messages.slice(-itemLimit).map((message) => clipSummaryLine(message, 180));
	const omitted = messages.length - visibleMessages.length;
	const plural = messages.length === 1 ? "" : "s";
	const lines = [`While you were away, ${messages.length} update${plural} queued from ${sessionLabel}:`];
	if (omitted > 0) lines.push(`- …${omitted} older update${omitted === 1 ? "" : "s"} omitted`);
	lines.push(...visibleMessages.map((message) => `- ${message}`));
	lines.push("I'll send new updates until you return.");
	return lines.join("\n");
}

function clipSummaryLine(text, maxLength) {
	const value = String(text || "").trim().replace(/\s+/g, " ");
	return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;
}
