import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTINUATION_MESSAGE_TYPE,
	CONTROL_MESSAGE_PREFIX,
	IMPLEMENTATION_MESSAGE_TYPE,
	PLANNING_INSTRUCTION,
	PLANNING_MESSAGE_TYPE,
	VERIFICATION_INSTRUCTION,
} from "./prompts.js";
import {
	beginTurn,
	createRunState,
	recordToolCall,
	reduceTurn,
	validateArmingTools,
	validateTodoWriteInput,
	type PrewalkPhase,
	type PrewalkState,
} from "./state.js";

type PlannerModel = NonNullable<ExtensionContext["model"]>;
type PlannerThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type NotificationType = "info" | "warning" | "error";

interface PrewalkConfig {
	targetModel: string;
	restorePlanner: boolean;
}

interface TargetModel {
	provider: string;
	modelId: string;
	key: string;
}

interface PlannerSnapshot {
	model: PlannerModel;
	modelKey: string;
	thinkingLevel: PlannerThinkingLevel;
}

const DEFAULT_CONFIG: PrewalkConfig = {
	targetModel: "openai-codex/gpt-5.6-luna",
	restorePlanner: true,
};
const HEADLESS_TASK_MESSAGE_TYPE = "pi-prewalk-task";

export default function piPrewalkExtension(pi: ExtensionAPI): void {
	const loadedConfig = loadConfig();
	const config = loadedConfig.config;
	const targetModel = parseTargetModel(config.targetModel) as TargetModel;
	let configWarningShown = false;
	let state: PrewalkState = { phase: "idle" };
	let plannerSnapshot: PlannerSnapshot | undefined;
	let expectedModelKey: string | undefined;

	function notify(ctx: ExtensionContext, message: string, type: NotificationType = "info"): void {
		if (ctx.hasUI) {
			ctx.ui.notify(message, type);
		} else {
			console.error(message);
		}
	}

	function publishConfigWarning(ctx: ExtensionContext): void {
		if (!loadedConfig.warning || configWarningShown) return;
		configWarningShown = true;
		notify(ctx, `Prewalk configuration warning: ${loadedConfig.warning} Using defaults.`, "warning");
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.phase === "idle") {
			ctx.ui.setStatus("prewalk", undefined);
			return;
		}

		const continuationCount = state.run?.continuationCount ?? 0;
		const continuationText = state.phase === "planning" && continuationCount > 0 ? ` · ${continuationCount}/3` : "";
		ctx.ui.setStatus("prewalk", `Prewalk ${state.phase}${continuationText} → ${targetModel.key}`);
	}

	function publishStatus(ctx: ExtensionContext): void {
		publishConfigWarning(ctx);
		const planner = plannerSnapshot ? ` | planner ${plannerSnapshot.modelKey}` : "";
		notify(
			ctx,
			`Prewalk: ${state.phase} | target ${targetModel.key} | restore planner ${config.restorePlanner ? "on" : "off"}${planner}`,
		);
	}

	function clearAutomation(ctx: ExtensionContext): void {
		state = { phase: "idle" };
		plannerSnapshot = undefined;
		expectedModelKey = undefined;
		updateStatus(ctx);
	}

	function failAutomation(ctx: ExtensionContext, message: string): void {
		clearAutomation(ctx);
		notify(ctx, message, "error");
	}

	function arm(ctx: ExtensionContext): boolean {
		publishConfigWarning(ctx);
		if (state.phase !== "idle") {
			notify(ctx, `Prewalk is already ${state.phase}. Use /prewalk off before starting another run.`, "warning");
			return false;
		}
		if (!ctx.isIdle()) {
			notify(ctx, "Prewalk can only be armed while the agent is idle.", "warning");
			return false;
		}

		const validation = validateArmingTools(pi.getActiveTools());
		if (!validation.ok) {
			notify(ctx, validation.reason, "error");
			return false;
		}

		state = { phase: "armed" };
		updateStatus(ctx);
		notify(ctx, `Prewalk armed. The next task will plan, make one mutation, then hand off to ${targetModel.key}.`);
		return true;
	}

	function beginRun(ctx: ExtensionContext): void {
		if (state.phase !== "armed") return;
		if (!ctx.model) {
			failAutomation(ctx, "Prewalk requires a selected planner model.");
			return;
		}

		plannerSnapshot = {
			model: ctx.model,
			modelKey: modelKey(ctx.model),
			thinkingLevel: pi.getThinkingLevel(),
		};
		state = { phase: "planning", run: createRunState() };
		updateStatus(ctx);
	}

	async function switchToTarget(ctx: ExtensionContext): Promise<void> {
		if (state.phase !== "planning" || !state.run || !plannerSnapshot) return;

		const run = state.run;
		const snapshot = plannerSnapshot;
		state = { phase: "handoff", run };
		updateStatus(ctx);

		const target = ctx.modelRegistry.find(targetModel.provider, targetModel.modelId);
		if (!target) {
			failAutomation(ctx, `Prewalk target model is unavailable: ${targetModel.key}.`);
			return;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(target)) {
			failAutomation(ctx, `Prewalk target model is not authenticated: ${targetModel.key}.`);
			return;
		}

		try {
			expectedModelKey = targetModel.key;
			const switched = await pi.setModel(target);
			if (state.phase !== "handoff" || plannerSnapshot !== snapshot) return;
			if (!switched) {
				failAutomation(ctx, `Prewalk could not switch to ${targetModel.key}.`);
				return;
			}

			state = { phase: "implementing", run };
			updateStatus(ctx);
			notify(ctx, `Prewalk handed implementation to ${targetModel.key}.`);
		} catch (error) {
			if (state.phase === "handoff" && plannerSnapshot === snapshot) {
				failAutomation(ctx, `Prewalk could not switch to ${targetModel.key}: ${errorMessage(error)}`);
			}
		} finally {
			if (expectedModelKey === targetModel.key) expectedModelKey = undefined;
		}
	}

	async function restorePlanner(ctx: ExtensionContext): Promise<boolean> {
		const snapshot = plannerSnapshot;
		if (!snapshot) {
			clearAutomation(ctx);
			return true;
		}

		state = { phase: "restoring", run: state.run };
		updateStatus(ctx);

		try {
			if (modelKey(ctx.model) !== snapshot.modelKey) {
				expectedModelKey = snapshot.modelKey;
				const restored = await pi.setModel(snapshot.model);
				if (state.phase !== "restoring" || plannerSnapshot !== snapshot) return false;
				if (!restored) throw new Error(`model ${snapshot.modelKey} is not authenticated`);
			}

			if (state.phase !== "restoring" || plannerSnapshot !== snapshot) return false;
			pi.setThinkingLevel(snapshot.thinkingLevel);
			clearAutomation(ctx);
			return true;
		} catch (error) {
			if (state.phase !== "idle") {
				clearAutomation(ctx);
				notify(ctx, `Prewalk could not restore ${snapshot.modelKey}: ${errorMessage(error)}`, "error");
			}
			return false;
		} finally {
			if (expectedModelKey === snapshot.modelKey) expectedModelKey = undefined;
		}
	}

	async function turnOff(ctx: ExtensionContext): Promise<void> {
		if (state.phase === "idle") {
			notify(ctx, "Prewalk is already off.");
			return;
		}

		const targetIsActive = state.phase === "handoff" || state.phase === "implementing" || state.phase === "restoring";
		if (targetIsActive && config.restorePlanner && plannerSnapshot) {
			const restored = await restorePlanner(ctx);
			if (restored) notify(ctx, "Prewalk is off and the planner model has been restored.");
			return;
		}

		clearAutomation(ctx);
		notify(ctx, "Prewalk is off.");
	}

	pi.registerCommand("prewalk", {
		description: "Plan with the current model, make one mutation, then hand off implementation",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command === "status") {
				publishStatus(ctx);
				return;
			}
			if (command === "off") {
				await turnOff(ctx);
				return;
			}
			if (!arm(ctx)) return;
			if (!command) return;

			if (!ctx.hasUI) {
				beginRun(ctx);
				if (state.phase !== "planning") return;
				pi.sendMessage(
					{
						customType: HEADLESS_TASK_MESSAGE_TYPE,
						content: command,
						display: true,
					},
					{ triggerTurn: true },
				);
				await ctx.waitForIdle();
				return;
			}

			pi.sendUserMessage(command);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		publishConfigWarning(ctx);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		beginRun(ctx);
	});

	pi.on("context", (event) => {
		return { messages: buildContextMessages(event.messages, state.phase) };
	});

	pi.on("turn_start", (_event, _ctx) => {
		if (state.phase !== "planning" || !state.run) return;
		state = { phase: "planning", run: beginTurn(state.run) };
	});

	pi.on("tool_call", (event) => {
		if (state.phase !== "planning" || !state.run) return;

		if (event.toolName === "todo_write") {
			const validation = validateTodoWriteInput(event.input);
			if (!validation.ok) return { block: true, reason: validation.reason };
		}

		state = {
			phase: "planning",
			run: recordToolCall(state.run, { toolCallId: event.toolCallId, toolName: event.toolName }),
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (state.phase !== "planning" || !state.run) return;

		const decision = reduceTurn(state.run, event.toolResults, {
			allowContinuation: isTextOnlyCompletion(event.message),
		});
		state = { phase: "planning", run: decision.state };
		updateStatus(ctx);

		if (decision.shouldHandoff) {
			await switchToTarget(ctx);
			return;
		}

		if (decision.shouldContinue) {
			pi.sendMessage(
				{
					customType: CONTINUATION_MESSAGE_TYPE,
					content: "",
					display: false,
				},
				{ deliverAs: "followUp" },
			);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (state.phase === "idle") return;

		const selectedModelKey = modelKey(event.model);
		if (expectedModelKey === selectedModelKey) {
			expectedModelKey = undefined;
			return;
		}

		clearAutomation(ctx);
		notify(ctx, `Prewalk cancelled after the model changed to ${selectedModelKey}.`, "warning");
	});

	const handleAgentSettled = async (_event: { type: "agent_settled" }, ctx: ExtensionContext): Promise<void> => {
		if (state.phase === "implementing" || state.phase === "handoff") {
			if (config.restorePlanner && plannerSnapshot) {
				const snapshot = plannerSnapshot;
				const restored = await restorePlanner(ctx);
				if (restored) notify(ctx, `Prewalk restored ${snapshot.modelKey}.`);
			} else {
				clearAutomation(ctx);
			}
			return;
		}

		if (state.phase === "planning") {
			clearAutomation(ctx);
			notify(ctx, "Prewalk ended before a qualifying first mutation.", "warning");
		}
	};

	pi.on("agent_settled", handleAgentSettled);

	pi.on("session_shutdown", async (_event, ctx) => {
		const targetIsActive = state.phase === "handoff" || state.phase === "implementing" || state.phase === "restoring";
		if (targetIsActive && config.restorePlanner && plannerSnapshot) {
			await restorePlanner(ctx);
		} else if (state.phase !== "idle") {
			clearAutomation(ctx);
		}
	});
}

function buildContextMessages(messages: AgentMessage[], phase: PrewalkPhase): AgentMessage[] {
	const filtered = structuredClone(messages).filter(
		(message) => !(message.role === "custom" && message.customType.startsWith(CONTROL_MESSAGE_PREFIX)),
	);
	const instruction =
		phase === "planning"
			? { customType: PLANNING_MESSAGE_TYPE, content: PLANNING_INSTRUCTION }
			: phase === "implementing"
				? { customType: IMPLEMENTATION_MESSAGE_TYPE, content: VERIFICATION_INSTRUCTION }
				: undefined;

	if (!instruction) return filtered;

	return [
		...filtered,
		{
			role: "custom",
			customType: instruction.customType,
			content: instruction.content,
			display: false,
			timestamp: Date.now(),
		},
	];
}

function isTextOnlyCompletion(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		message.stopReason === "stop" &&
		!message.content.some((content) => content.type === "toolCall")
	);
}

function modelKey(model: ExtensionContext["model"]): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

function parseTargetModel(value: string): TargetModel | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;

	const provider = value.slice(0, separator).trim();
	const modelId = value.slice(separator + 1).trim();
	if (!provider || !modelId) return undefined;

	return { provider, modelId, key: `${provider}/${modelId}` };
}

function loadConfig(): { config: PrewalkConfig; warning?: string } {
	const path = join(homedir(), ".pi", "agent", "prewalk.json");

	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || Array.isArray(parsed)) return invalidConfig("the root value must be an object");

		const targetModel = "targetModel" in parsed ? parsed.targetModel : DEFAULT_CONFIG.targetModel;
		const restorePlanner = "restorePlanner" in parsed ? parsed.restorePlanner : DEFAULT_CONFIG.restorePlanner;
		const parsedTarget = typeof targetModel === "string" ? parseTargetModel(targetModel) : undefined;
		if (!parsedTarget) {
			return invalidConfig('targetModel must use the form "provider/model-id"');
		}
		if (typeof restorePlanner !== "boolean") {
			return invalidConfig("restorePlanner must be a boolean");
		}

		return {
			config: {
				targetModel: parsedTarget.key,
				restorePlanner,
			},
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { config: { ...DEFAULT_CONFIG } };
		return invalidConfig(errorMessage(error));
	}
}

function invalidConfig(reason: string): { config: PrewalkConfig; warning: string } {
	return { config: { ...DEFAULT_CONFIG }, warning: `${reason}.` };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
