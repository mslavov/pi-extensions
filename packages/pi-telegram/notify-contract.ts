export const PI_NOTIFY_EVENT = "pi:notify" as const;
export const LEGACY_NOTIFY_EVENT = "notify" as const;

export type PiNotifyKind = "progress" | "ready" | "waiting" | "error" | (string & {});
export type PiNotifyLevel = "info" | "success" | "warning" | "error";

export interface PiNotifyEventV1 {
	v: 1;
	source: string;
	kind?: PiNotifyKind;
	level?: PiNotifyLevel;
	title?: string;
	message: string;
	dedupeKey?: string;
	minIntervalMs?: number;
	suppressForTelegramOriginated?: boolean;
}

export interface PiNotifyEmitter {
	events: {
		emit(event: string, data: unknown): void;
	};
}

export function emitPiNotify(pi: PiNotifyEmitter, event: Omit<PiNotifyEventV1, "v">): void {
	pi.events.emit(PI_NOTIFY_EVENT, { v: 1, ...event });
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parsePiNotifyEvent(data: unknown): PiNotifyEventV1 | undefined {
	if (typeof data === "string") {
		const message = data.trim();
		return message ? { v: 1, source: "notify", message } : undefined;
	}

	if (!data || typeof data !== "object") return undefined;
	const value = data as Record<string, unknown>;
	const message = optionalString(value.message) ?? optionalString(value.text);
	if (!message) return undefined;

	return {
		v: 1,
		source: optionalString(value.source) ?? "unknown",
		kind: optionalString(value.kind),
		level: optionalString(value.level) as PiNotifyLevel | undefined,
		title: optionalString(value.title),
		message,
		dedupeKey: optionalString(value.dedupeKey) ?? optionalString(value.id),
		minIntervalMs: optionalNonNegativeNumber(value.minIntervalMs),
		suppressForTelegramOriginated: optionalBoolean(value.suppressForTelegramOriginated),
	};
}
