import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	readFileSync: fsMocks.readFileSync,
}));

import piPrewalkExtension from "../index.js";
import {
	CONTINUATION_MESSAGE_TYPE,
	CONTROL_MESSAGE_PREFIX,
	IMPLEMENTATION_MESSAGE_TYPE,
	PLANNING_MESSAGE_TYPE,
} from "../prompts.js";

type Handler = (event: any, ctx: ExtensionContext) => any;

const plannerModel = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" } as any;
const targetModel = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" } as any;
const externalModel = { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" } as any;

function validTodos() {
	return Array.from({ length: 5 }, (_, index) => ({
		content: `Task ${index + 1}`,
		activeForm: `Doing task ${index + 1}`,
		status: index === 0 ? "in_progress" : "pending",
	}));
}

function assistant(stopReason: "stop" | "toolUse" | "error" = "stop", content: any[] = [{ type: "text", text: "Plan" }]) {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string, isError = false, details?: unknown) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		details,
		isError,
		timestamp: Date.now(),
	};
}

function missingConfigFile(): never {
	throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

function createHarness(
	options: {
		activeTools?: string[];
		models?: any[];
		authenticated?: boolean;
		idle?: boolean;
		beads?: boolean;
		mode?: "tui" | "rpc" | "json" | "print";
	} = {},
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const models = options.models ?? [plannerModel, targetModel, externalModel];
	let currentModel = plannerModel;
	let thinkingLevel = "max";
	let authenticated = options.authenticated ?? true;
	let idle = options.idle ?? true;

	const ui = {
		notify: vi.fn(),
		setStatus: vi.fn(),
	};
	const waitForIdle = vi.fn(async () => undefined);

	const ctx = {
		ui,
		hasUI: options.mode !== "json" && options.mode !== "print",
		mode: options.mode ?? "tui",
		cwd: "C:/work",
		get model() {
			return currentModel;
		},
		modelRegistry: {
			find: vi.fn((provider: string, modelId: string) =>
				models.find((model) => model.provider === provider && model.id === modelId),
			),
			hasConfiguredAuth: vi.fn(() => authenticated),
		},
		isIdle: vi.fn(() => idle),
		waitForIdle,
	} as unknown as ExtensionContext;

	async function emit(type: string, event: any = { type }) {
		let result: any;
		for (const handler of handlers.get(type) ?? []) {
			const handlerResult = await handler(event, ctx);
			if (handlerResult !== undefined) result = handlerResult;
		}
		return result;
	}

	const setModel = vi.fn(async (model: any) => {
		const previousModel = currentModel;
		currentModel = model;
		await emit("model_select", { type: "model_select", model, previousModel, source: "set" });
		return true;
	});
	const setThinkingLevel = vi.fn((level: string) => {
		thinkingLevel = level;
	});
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();
	const exec = vi.fn(async () => ({
		stdout: options.beads ? "{}" : "",
		stderr: "",
		code: options.beads ? 0 : 1,
		killed: false,
	}));

	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		}),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		getActiveTools: vi.fn(() => options.activeTools ?? ["read", "bash", "todo_write", "edit", "write"]),
		exec,
		getThinkingLevel: vi.fn(() => thinkingLevel),
		setThinkingLevel,
		setModel,
		sendMessage,
		sendUserMessage,
	} as unknown as ExtensionAPI;

	piPrewalkExtension(pi);

	return {
		pi,
		ctx,
		ui,
		emit,
		command: commands.get("prewalk"),
		setModel,
		setThinkingLevel,
		sendMessage,
		sendUserMessage,
		exec,
		waitForIdle,
		get currentModel() {
			return currentModel;
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		setCurrentModel(model: any) {
			currentModel = model;
		},
		setThinking(level: string) {
			thinkingLevel = level;
		},
		setAuthenticated(value: boolean) {
			authenticated = value;
		},
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

async function startPlanning(harness: ReturnType<typeof createHarness>, task = "Implement the feature") {
	await harness.command.handler(task, harness.ctx);
	await harness.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: task,
		systemPrompt: "system",
		systemPromptOptions: {},
	});
}

async function qualifyHandoff(harness: ReturnType<typeof createHarness>) {
	await startPlanning(harness);
	await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	await harness.emit("tool_call", {
		type: "tool_call",
		toolCallId: "todo",
		toolName: "todo_write",
		input: { todos: validTodos() },
	});
	await harness.emit("tool_call", {
		type: "tool_call",
		toolCallId: "mutation",
		toolName: "edit",
		input: { path: "src/index.ts", oldText: "a", newText: "b" },
	});
	await harness.emit("turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: assistant("toolUse", [
			{ type: "text", text: "Plan" },
			{ type: "toolCall", id: "todo", name: "todo_write", arguments: {} },
			{ type: "toolCall", id: "mutation", name: "edit", arguments: {} },
		]),
		toolResults: [toolResult("mutation", "edit"), toolResult("todo", "todo_write", false, { newTodos: validTodos() })],
	});
}

async function contextMessages(harness: ReturnType<typeof createHarness>, messages: any[]) {
	const result = await harness.emit("context", { type: "context", messages });
	return result.messages as any[];
}

beforeEach(() => {
	fsMocks.readFileSync.mockReset();
	fsMocks.readFileSync.mockImplementation(missingConfigFile);
});

describe("/prewalk commands", () => {
	it("arms and sends an inline task without changing sessions", async () => {
		const harness = createHarness();

		await harness.command.handler("Implement the parser", harness.ctx);

		expect(harness.sendUserMessage).toHaveBeenCalledWith("Implement the parser");
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
			"prewalk",
			"Prewalk armed → openai-codex/gpt-5.6-luna",
		);
	});

	it.each(["json", "print"] as const)("keeps %s mode alive for an inline task", async (mode) => {
		const harness = createHarness({ mode });

		await harness.command.handler("Implement the parser", harness.ctx);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: "pi-prewalk-task",
				content: "Implement the parser",
				display: true,
			},
			{ triggerTurn: true },
		);
		expect(harness.waitForIdle).toHaveBeenCalledOnce();
		expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
	});

	it("arms the next prompt when no task is supplied", async () => {
		const harness = createHarness();

		await harness.command.handler("", harness.ctx);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();

		await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Next prompt",
			systemPrompt: "system",
			systemPromptOptions: {},
		});
		const messages = await contextMessages(harness, []);
		expect(messages.at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
	});

	it("handles exact status and off commands without starting inference", async () => {
		const harness = createHarness();

		await harness.command.handler("status", harness.ctx);
		await harness.command.handler("off", harness.ctx);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Prewalk: idle | target openai-codex/gpt-5.6-luna | restore planner on",
			"info",
		);
	});

	it("refuses to arm when required tools are missing or the agent is busy", async () => {
		const missingTools = createHarness({ activeTools: ["read"] });
		await missingTools.command.handler("Task", missingTools.ctx);
		expect(missingTools.sendUserMessage).not.toHaveBeenCalled();
		expect(missingTools.ui.notify).toHaveBeenCalledWith(expect.stringContaining("todo_write"), "error");

		const busy = createHarness({ idle: false });
		await busy.command.handler("Task", busy.ctx);
		expect(busy.sendUserMessage).not.toHaveBeenCalled();
		expect(busy.ui.notify).toHaveBeenCalledWith("Prewalk can only be armed while the agent is idle.", "warning");
	});
});

describe("planning gate and context", () => {
	it("detects a Beads workspace and hands off after Beads tracking", async () => {
		const harness = createHarness({ beads: true });
		await startPlanning(harness);

		expect(harness.exec).toHaveBeenCalledWith(
			"bd",
			["-C", "C:/work", "--readonly", "--json", "status", "--no-activity"],
			{ timeout: 5_000 },
		);
		const planning = await contextMessages(harness, []);
		expect(planning.at(-1)?.content).toContain("Use the beads skill and direct bd CLI commands");
		expect(planning.at(-1)?.content).toContain("instead of todo_write");

		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "beads",
			toolName: "bash",
			input: { command: "bd create --title 'Implement feature' --type task" },
		});
		await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "mutation",
			toolName: "edit",
			input: { path: "src/index.ts", oldText: "a", newText: "b" },
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: assistant("toolUse"),
			toolResults: [toolResult("beads", "bash"), toolResult("mutation", "edit")],
		});

		expect(harness.setModel).toHaveBeenCalledWith(targetModel);
		const implementing = await contextMessages(harness, []);
		expect(implementing.at(-1)?.content).toContain("close each completed Bead");
		expect(implementing.at(-1)?.content).toContain("instead of todo_write");
	});

	it("blocks invalid planning checklists before the todo tool executes", async () => {
		const harness = createHarness();
		await startPlanning(harness);
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });

		const blocked = await harness.emit("tool_call", {
			type: "tool_call",
			toolCallId: "todo",
			toolName: "todo_write",
			input: { todos: validTodos().slice(0, 4) },
		});

		expect(blocked).toEqual({
			block: true,
			reason: "Prewalk requires 5-9 todo items before the first mutation.",
		});
	});

	it("preserves unrelated history while replacing only its own phase message", async () => {
		const harness = createHarness();
		await startPlanning(harness);
		const original = [
			{ role: "user", content: "Task", timestamp: 1 },
			toolResult("old-todo", "todo_write", false, { newTodos: validTodos() }),
			{ role: "custom", customType: "other-extension", content: "keep", display: false, timestamp: 2 },
			{ role: "custom", customType: `${CONTROL_MESSAGE_PREFIX}stale`, content: "remove", display: false, timestamp: 3 },
		];

		const planning = await contextMessages(harness, original);
		expect(planning).toHaveLength(4);
		expect(planning[0]).toEqual(original[0]);
		expect(planning[0]).not.toBe(original[0]);
		expect(planning[1]).toEqual(original[1]);
		expect(planning[2]).toEqual(original[2]);
		expect(planning.at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);

		await qualifyHandoff(harness);
		const implementing = await contextMessages(harness, planning);
		const ownMessages = implementing.filter(
			(message) => message.role === "custom" && message.customType.startsWith(CONTROL_MESSAGE_PREFIX),
		);
		expect(ownMessages).toHaveLength(1);
		expect(ownMessages[0].customType).toBe(IMPLEMENTATION_MESSAGE_TYPE);
		expect(implementing).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "todo_write" })]));
	});

	it("queues a hidden continuation once per no-progress stretch", async () => {
		const harness = createHarness();
		await startPlanning(harness);

		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: assistant(),
			toolResults: [],
		});
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{ customType: CONTINUATION_MESSAGE_TYPE, content: "", display: false },
			{ deliverAs: "followUp" },
		);

		await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: assistant(),
			toolResults: [],
		});
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);

		await harness.emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });
		await harness.emit("tool_call", { type: "tool_call", toolCallId: "read", toolName: "read", input: { path: "x" } });
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 2,
			message: assistant("toolUse"),
			toolResults: [toolResult("read", "read")],
		});
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() });
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 3,
			message: assistant(),
			toolResults: [],
		});
		expect(harness.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("does not continue provider errors", async () => {
		const harness = createHarness();
		await startPlanning(harness);
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: assistant("error", []),
			toolResults: [],
		});

		expect(harness.sendMessage).not.toHaveBeenCalled();
	});
});

describe("model handoff and restoration", () => {
	it("switches once at turn_end and restores model before thinking at agent_settled", async () => {
		const harness = createHarness();

		await qualifyHandoff(harness);
		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.setModel).toHaveBeenNthCalledWith(1, targetModel);
		expect(harness.currentModel).toBe(targetModel);
		const implementing = await contextMessages(harness, []);
		expect(implementing.at(-1)?.customType).toBe(IMPLEMENTATION_MESSAGE_TYPE);

		harness.setThinking("low");
		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel);
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
		expect(harness.setModel.mock.invocationCallOrder[1]).toBeLessThan(
			harness.setThinkingLevel.mock.invocationCallOrder[0],
		);
		expect(harness.currentModel).toBe(plannerModel);
		expect(harness.thinkingLevel).toBe("max");
		expect(await contextMessages(harness, implementing)).toHaveLength(0);
	});

	it("restores the planner when Prewalk is turned off after handoff", async () => {
		const harness = createHarness();
		await qualifyHandoff(harness);

		await harness.command.handler("off", harness.ctx);

		expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel);
		expect(harness.currentModel).toBe(plannerModel);
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("uses session_shutdown as a restoration backstop", async () => {
		const harness = createHarness();
		await qualifyHandoff(harness);
		harness.setThinking("low");

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

		expect(harness.currentModel).toBe(plannerModel);
		expect(harness.thinkingLevel).toBe("max");
	});

	it("keeps the target when restoration is disabled", async () => {
		fsMocks.readFileSync.mockReturnValue(
			JSON.stringify({ targetModel: "openai-codex/gpt-5.6-luna", restorePlanner: false }),
		);
		const harness = createHarness();
		await qualifyHandoff(harness);

		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.currentModel).toBe(targetModel);
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("clears after one failed restoration without retrying", async () => {
		const harness = createHarness();
		await qualifyHandoff(harness);
		harness.setModel.mockResolvedValueOnce(false);

		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.setModel).toHaveBeenCalledTimes(2);
		expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not restore"), "error");
	});
});

describe("model failures and manual control", () => {
	it("cancels when the target model is unavailable", async () => {
		const harness = createHarness({ models: [plannerModel] });
		await qualifyHandoff(harness);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Prewalk target model is unavailable: openai-codex/gpt-5.6-luna.",
			"error",
		);
		expect(await contextMessages(harness, [])).toEqual([]);
	});

	it("cancels when target authentication is unavailable", async () => {
		const harness = createHarness({ authenticated: false });
		await qualifyHandoff(harness);

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not authenticated"), "error");
	});

	it.each([
		["returns false", (harness: ReturnType<typeof createHarness>) => harness.setModel.mockResolvedValueOnce(false)],
		["throws", (harness: ReturnType<typeof createHarness>) => harness.setModel.mockRejectedValueOnce(new Error("switch failed"))],
	])("cancels when setModel %s", async (_label, arrange) => {
		const harness = createHarness();
		arrange(harness);

		await qualifyHandoff(harness);

		expect(await contextMessages(harness, [])).toEqual([]);
		expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not switch"), "error");
	});

	it("cancels planning on an external model selection and retains that model", async () => {
		const harness = createHarness();
		await startPlanning(harness);
		harness.setCurrentModel(externalModel);

		await harness.emit("model_select", {
			type: "model_select",
			model: externalModel,
			previousModel: plannerModel,
			source: "cycle",
		});
		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.currentModel).toBe(externalModel);
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(await contextMessages(harness, [])).toEqual([]);
	});

	it("does not restore over a manual model selection after handoff", async () => {
		const harness = createHarness();
		await qualifyHandoff(harness);
		harness.setCurrentModel(externalModel);
		await harness.emit("model_select", {
			type: "model_select",
			model: externalModel,
			previousModel: targetModel,
			source: "cycle",
		});

		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.currentModel).toBe(externalModel);
	});
});

describe("configuration", () => {
	it.each([
		["targetModel", { targetModel: null }],
		["restorePlanner", { restorePlanner: null }],
	])("warns and uses defaults when %s is null", async (_field, config) => {
		fsMocks.readFileSync.mockReturnValue(JSON.stringify(config));
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("status", harness.ctx);

		expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Using defaults"), "warning");
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Prewalk: idle | target openai-codex/gpt-5.6-luna | restore planner on",
			"info",
		);
	});

	it("warns once and uses defaults for malformed configuration", async () => {
		fsMocks.readFileSync.mockReturnValue(JSON.stringify({ targetModel: "luna", restorePlanner: "yes" }));
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("session_start", { type: "session_start" });
		await harness.command.handler("status", harness.ctx);

		const warnings = harness.ui.notify.mock.calls.filter(([, type]) => type === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0][0]).toContain("Using defaults");
		expect(harness.ui.notify).toHaveBeenCalledWith(
			"Prewalk: idle | target openai-codex/gpt-5.6-luna | restore planner on",
			"info",
		);
	});
});
