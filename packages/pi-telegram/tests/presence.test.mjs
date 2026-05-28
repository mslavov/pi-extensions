import { describe, expect, it } from "vitest";
import {
	derivePresenceState,
	formatPresenceQueuedSummary,
	parseMacOsHidIdleSeconds,
	shouldQueuePresenceDelayedNotification,
	shouldSendProactiveNotification,
} from "../presence.mjs";

const basePresence = {
	enabled: true,
	mode: "auto",
	provider: "macos-hid-idle",
	state: "present",
	notificationPolicy: "away_only",
	awayAfterSeconds: 300,
	presentBelowSeconds: 60,
	pollIntervalSeconds: 15,
};

describe("parseMacOsHidIdleSeconds", () => {
	it("parses HIDIdleTime nanoseconds as whole seconds", () => {
		expect(parseMacOsHidIdleSeconds('    "HIDIdleTime" = 51000000000')).toBe(51);
	});

	it("returns undefined when HIDIdleTime is missing or malformed", () => {
		expect(parseMacOsHidIdleSeconds("no idle time here")).toBeUndefined();
		expect(parseMacOsHidIdleSeconds('"HIDIdleTime" = nope')).toBeUndefined();
	});
});

describe("derivePresenceState", () => {
	it("marks users away at the away threshold", () => {
		expect(derivePresenceState(300, "present", basePresence)).toBe("away");
	});

	it("keeps away state until idle falls below the present threshold", () => {
		expect(derivePresenceState(120, "away", basePresence)).toBe("away");
		expect(derivePresenceState(30, "away", basePresence)).toBe("present");
	});
});

describe("shouldSendProactiveNotification", () => {
	it("sends progress only while away by default", () => {
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "present" }, notificationKind: "progress" }).send).toBe(false);
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "unknown" }, notificationKind: "progress" }).send).toBe(false);
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "away" }, notificationKind: "progress" }).send).toBe(true);
	});

	it("keeps completion, waiting, and errors as low-noise important events", () => {
		for (const notificationKind of ["completion", "waiting", "error"]) {
			expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "present" }, notificationKind }).send).toBe(true);
		}
	});

	it("suppresses all proactive updates from active Telegram turns", () => {
		const decision = shouldSendProactiveNotification({
			presence: { ...basePresence, state: "away" },
			notificationKind: "progress",
			hasActiveTelegramTurn: true,
		});
		expect(decision.send).toBe(false);
		expect(decision.reason).toContain("already stream previews");
	});

	it("supports explicit always, never, and present-only policies", () => {
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "present", notificationPolicy: "always" } }).send).toBe(true);
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "away", notificationPolicy: "never" } }).send).toBe(false);
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "present", notificationPolicy: "present_only" } }).send).toBe(true);
		expect(shouldSendProactiveNotification({ presence: { ...basePresence, state: "away", notificationPolicy: "present_only" } }).send).toBe(false);
	});
});

describe("shouldQueuePresenceDelayedNotification", () => {
	it("queues only progress and notify updates while waiting for away presence", () => {
		expect(shouldQueuePresenceDelayedNotification({ presence: { ...basePresence, state: "present" }, notificationKind: "progress" })).toBe(true);
		expect(shouldQueuePresenceDelayedNotification({ presence: { ...basePresence, state: "unknown" }, notificationKind: "notify" })).toBe(true);
		expect(shouldQueuePresenceDelayedNotification({ presence: { ...basePresence, state: "present" }, notificationKind: "completion" })).toBe(false);
		expect(shouldQueuePresenceDelayedNotification({ presence: { ...basePresence, state: "away" }, notificationKind: "progress" })).toBe(false);
	});

	it("does not queue active Telegram turns or disabled presence", () => {
		expect(
			shouldQueuePresenceDelayedNotification({
				presence: { ...basePresence, state: "present" },
				notificationKind: "progress",
				hasActiveTelegramTurn: true,
			}),
		).toBe(false);
		expect(shouldQueuePresenceDelayedNotification({ presence: { ...basePresence, enabled: false, state: "unknown" }, notificationKind: "progress" })).toBe(false);
	});
});

describe("formatPresenceQueuedSummary", () => {
	it("summarizes queued updates and omits older items", () => {
		const summary = formatPresenceQueuedSummary({
			sessionLabel: "pi-extensions:work",
			messages: ["first", "second", "third"],
			itemLimit: 2,
		});
		expect(summary).toContain("3 updates queued from pi-extensions:work");
		expect(summary).toContain("…1 older update omitted");
		expect(summary).not.toContain("- first");
		expect(summary).toContain("- second");
		expect(summary).toContain("- third");
		expect(summary).toContain("I'll send new updates until you return.");
	});
});
