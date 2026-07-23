import { MAX_AUTOMATIC_CONTINUATIONS } from "./prompts.js";

export type PrewalkPhase = "idle" | "armed" | "planning" | "handoff" | "implementing" | "restoring";

export interface PrewalkState {
	phase: PrewalkPhase;
	run?: PrewalkRunState;
}

export interface PrewalkRunState {
	todoGateOpen: boolean;
	toolCalls: RecordedToolCall[];
	nextOrdinal: number;
	continuationCount: number;
	continuationArmed: boolean;
}

export interface ToolCallSummary {
	toolCallId: string;
	toolName: string;
}

export interface ToolResultSummary {
	toolCallId: string;
	isError: boolean;
}

export interface TurnDecision {
	state: PrewalkRunState;
	shouldHandoff: boolean;
	shouldContinue: boolean;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

type RecordedToolCall = {
	toolCallId: string;
	kind: "todo" | "mutation";
	ordinal: number;
};

const MUTATION_TOOLS = ["edit", "write", "apply_patch"] as const;
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(MUTATION_TOOLS);

export function validateArmingTools(activeTools: readonly string[]): ValidationResult {
	const missingTodo = !activeTools.includes("todo_write");
	const missingMutation = !activeTools.some((toolName) => MUTATION_TOOL_NAMES.has(toolName));

	if (!missingTodo && !missingMutation) return { ok: true };

	const requirements: string[] = [];
	if (missingTodo) requirements.push("the active todo_write tool");
	if (missingMutation) requirements.push("an active mutation tool (edit, write, or apply_patch)");

	return {
		ok: false,
		reason: `Prewalk requires ${requirements.join(" and ")}.`,
	};
}

export function validateTodoWriteInput(input: unknown): ValidationResult {
	if (!isRecord(input) || !Array.isArray(input.todos)) {
		return { ok: false, reason: "Prewalk requires todo_write input with a todos array." };
	}

	if (input.todos.length < 5 || input.todos.length > 9) {
		return { ok: false, reason: "Prewalk requires 5-9 todo items before the first mutation." };
	}

	if (input.todos.some((todo) => !isRecord(todo) || !TODO_STATUSES.has(String(todo.status)))) {
		return { ok: false, reason: "Every Prewalk todo must have a valid pending, in_progress, or completed status." };
	}

	const inProgressCount = input.todos.filter((todo) => todo.status === "in_progress").length;
	if (inProgressCount !== 1) {
		return { ok: false, reason: "Prewalk requires exactly one in_progress todo item." };
	}

	return { ok: true };
}

export function createRunState(): PrewalkRunState {
	return {
		todoGateOpen: false,
		toolCalls: [],
		nextOrdinal: 0,
		continuationCount: 0,
		continuationArmed: true,
	};
}

export function beginTurn(state: PrewalkRunState): PrewalkRunState {
	return {
		...state,
		toolCalls: [],
		nextOrdinal: 0,
	};
}

export function recordToolCall(state: PrewalkRunState, call: ToolCallSummary): PrewalkRunState {
	const ordinal = state.nextOrdinal;
	const nextState = { ...state, nextOrdinal: ordinal + 1 };
	const kind = call.toolName === "todo_write" ? "todo" : MUTATION_TOOL_NAMES.has(call.toolName) ? "mutation" : undefined;

	if (!kind) return nextState;

	return {
		...nextState,
		toolCalls: [...state.toolCalls, { toolCallId: call.toolCallId, kind, ordinal }],
	};
}

export function reduceTurn(
	state: PrewalkRunState,
	results: readonly ToolResultSummary[],
	options: { allowContinuation?: boolean } = {},
): TurnDecision {
	const successfulIds = new Set(results.filter((result) => !result.isError).map((result) => result.toolCallId));
	const successfulTodos = state.toolCalls.filter(
		(call) => call.kind === "todo" && successfulIds.has(call.toolCallId),
	);
	const successfulMutations = state.toolCalls.filter(
		(call) => call.kind === "mutation" && successfulIds.has(call.toolCallId),
	);

	const shouldHandoff = state.todoGateOpen
		? successfulMutations.length > 0
		: successfulMutations.some((mutation) => successfulTodos.some((todo) => todo.ordinal < mutation.ordinal));

	let continuationArmed = results.some((result) => !result.isError) || state.continuationArmed;
	let continuationCount = state.continuationCount;
	let shouldContinue = false;

	if (
		!shouldHandoff &&
		options.allowContinuation !== false &&
		results.length === 0 &&
		continuationArmed &&
		continuationCount < MAX_AUTOMATIC_CONTINUATIONS
	) {
		shouldContinue = true;
		continuationCount++;
		continuationArmed = false;
	}

	return {
		state: {
			todoGateOpen: state.todoGateOpen || successfulTodos.length > 0,
			toolCalls: [],
			nextOrdinal: 0,
			continuationCount,
			continuationArmed,
		},
		shouldHandoff,
		shouldContinue,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
