/**
 * Plan Mode Extension — Integrated with pi-subagents and pi-tasks
 *
 * Flow:
 *   /plan <task>
 *     → Scout subagent explores the codebase
 *     → Planner subagent creates an implementation plan
 *     → Plan saved to .pi/plans/<slug>.md, displayed with file path
 *     → User reviews/edits the plan file
 *     → Execute: main agent (fresh context + plan) or worker subagent
 *     → Both execution paths create pi-tasks for structured tracking
 *
 * Commands:
 *   /plan [description]  Toggle plan mode, or start planning with a task
 *   Ctrl+Alt+P           Toggle plan mode
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractPlanSteps, isSafeCommand, type PlanStep } from "./utils.js";

// Tools allowed during planning phase (read-only + subagent orchestration)
const PLAN_MODE_TOOLS = [
	"read", "bash", "grep", "find", "ls",           // read-only exploration
	"subagent", "subagent_status",                   // subagent orchestration
	"questionnaire",                                 // clarifying questions
	"TaskList", "TaskGet",                           // view existing tasks
];

// pi-tasks tool names used for detecting the extension
const TASK_TOOLS = ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskExecute"];

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planFilePath = "";
	let planDescription = "";
	let planSteps: PlanStep[] = [];
	let hasTasksExtension = false;

	// ---- Helpers ----

	function getPlansDir(): string {
		const dir = join(process.cwd(), ".pi", "plans");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	}

	function generatePlanPath(): string {
		const now = new Date();
		const slug = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
		return join(getPlansDir(), `plan-${slug}.md`);
	}

	function readPlanFile(path: string): string | null {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	}

	function detectTasksExtension(): void {
		try {
			hasTasksExtension = pi.getAllTools().some((t) => TASK_TOOLS.includes(t.name));
		} catch {
			hasTasksExtension = false;
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
	}

	function enablePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = true;
		planSteps = [];
		planFilePath = generatePlanPath();

		const tools = [...PLAN_MODE_TOOLS];
		pi.setActiveTools(tools);
		ctx.ui.notify("Plan mode enabled — read-only exploration via subagents.");
		updateStatus(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		planSteps = [];
		planDescription = "";
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		ctx.ui.notify("Plan mode disabled. Full access restored.");
		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			planFilePath,
			planDescription,
		});
	}

	/**
	 * After planning completes, read the plan file, extract steps, and show the menu.
	 */
	async function presentPlan(ctx: ExtensionContext): Promise<void> {
		const content = readPlanFile(planFilePath);

		if (!content) {
			ctx.ui.notify(`No plan file found at ${planFilePath}. The planner may not have written to the expected path.`, "error");

			const recovery = await ctx.ui.select("Plan file missing — what next?", [
				"Retry planning",
				"Exit plan mode",
			]);

			if (recovery === "Retry planning") {
				planFilePath = generatePlanPath();
				persistState();
				pi.sendUserMessage(planDescription || "Create the implementation plan");
			} else {
				disablePlanMode(ctx);
			}
			return;
		}

		planSteps = extractPlanSteps(content);

		// Display plan with file path
		pi.sendMessage(
			{
				customType: "plan-result",
				content: `📄 **Plan saved to:** \`${planFilePath}\`\n\nYou can review and edit the plan file before executing.\n\n---\n\n${content}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		// Show execution menu
		const options: string[] = [];
		if (hasTasksExtension) {
			options.push("Execute with main agent (fresh context + plan + task tracking)");
			options.push("Execute with subagent (worker + task tracking)");
		} else {
			options.push("Execute with main agent");
			options.push("Execute with subagent (worker)");
		}
		options.push("Refine the plan");
		options.push("Exit plan mode");

		const choice = await ctx.ui.select("Plan ready — what next?", options);

		if (choice?.startsWith("Execute with main agent")) {
			await executeWithMainAgent(ctx);
		} else if (choice?.startsWith("Execute with subagent")) {
			await executeWithSubagent(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Describe what to change:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		} else if (choice === "Exit plan mode") {
			disablePlanMode(ctx);
		}
	}

	/**
	 * Execute plan with the main agent. Creates tasks for tracking, sends the plan as fresh context.
	 */
	async function executeWithMainAgent(ctx: ExtensionContext): Promise<void> {
		// Re-read plan (user may have edited the file)
		const content = readPlanFile(planFilePath) ?? "";
		planSteps = extractPlanSteps(content);

		// Exit plan mode, restore all tools
		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();

		const taskInstructions = buildTaskCreationInstructions(content);

		pi.sendMessage(
			{
				customType: "plan-execute",
				content: `Execute the following implementation plan. The plan file is at \`${planFilePath}\`.

${taskInstructions}

Read the plan file, then execute each task in order. Mark each task as \`in_progress\` when you start it and \`completed\` when done.

Focus only on the plan — ignore previous exploration context.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	/**
	 * Execute plan with a worker subagent. Creates tasks for tracking, delegates to worker.
	 */
	async function executeWithSubagent(ctx: ExtensionContext): Promise<void> {
		// Re-read plan (user may have edited the file)
		const content = readPlanFile(planFilePath) ?? "";
		planSteps = extractPlanSteps(content);

		// Exit plan mode, restore all tools
		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();

		const taskInstructions = buildTaskCreationInstructions(content);

		pi.sendMessage(
			{
				customType: "plan-execute",
				content: `${taskInstructions}

After creating the tasks, delegate execution to a worker subagent:

subagent({ agent: "worker", task: "Execute the implementation plan at ${planFilePath}. Read the plan file and implement each step. Use TaskUpdate to mark tasks as in_progress when starting and completed when done.\\n\\nOriginal request: ${escapeForTemplate(planDescription)}" })

Monitor the subagent progress.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	/**
	 * Build instructions for creating pi-tasks from plan steps.
	 */
	function buildTaskCreationInstructions(planContent: string): string {
		if (!hasTasksExtension || planSteps.length === 0) {
			return `**Plan file:** \`${planFilePath}\``;
		}

		const taskCalls = planSteps
			.map((s, i) => {
				const subject = escapeForTemplate(s.text);
				const desc = escapeForTemplate(s.description);
				return `${i + 1}. TaskCreate({ subject: "${subject}", description: "Step ${s.step}: ${desc}", activeForm: "${subject}" })`;
			})
			.join("\n");

		return `First, create tasks for tracking progress:\n\n${taskCalls}\n\nSet up dependencies so each task is blocked by the previous one (except the first).`;
	}

	function escapeForTemplate(s: string): string {
		return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	}

	// ---- Commands ----

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration via subagents)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or start planning: /plan <task description>",
		handler: async (args, ctx) => {
			detectTasksExtension();

			if (args?.trim()) {
				planDescription = args.trim();
				enablePlanMode(ctx);
				// Trigger planning with subagents
				pi.sendUserMessage(planDescription);
			} else {
				if (planModeEnabled) {
					disablePlanMode(ctx);
				} else {
					enablePlanMode(ctx);
				}
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			detectTasksExtension();
			if (planModeEnabled) {
				disablePlanMode(ctx);
			} else {
				enablePlanMode(ctx);
			}
		},
	});

	// ---- Event Handlers ----

	// Block destructive bash in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked. Only read-only commands allowed.\nCommand: ${command}`,
			};
		}
	});

	// Inject planning instructions
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode. Your job is to create an implementation plan using subagents.

Steps:
1. Run the **scout** subagent to explore the codebase and understand the architecture:
   subagent({ agent: "scout", task: "Explore the codebase for: ${escapeForTemplate(planDescription || "the user's request")}. Be thorough — trace imports, read key files, check tests and types.", model: "anthropic/claude-sonnet-4" })

2. Once scout completes, run the **planner** subagent to create a detailed plan. Pass the scout's findings and save the plan to the designated file:
   subagent({ agent: "planner", task: "Create a detailed implementation plan for: ${escapeForTemplate(planDescription || "the user's request")}. Scout findings: {previous}", output: "${planFilePath}", model: "anthropic/claude-opus-4-6" })

3. After the planner finishes, confirm the plan has been written.

Restrictions:
- Do NOT modify any project files — only explore and plan
- Bash is restricted to read-only commands
- Use the subagent tool for exploration and planning`,
				display: false,
			},
		};
	});

	// Filter stale plan mode context from conversation
	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as any;
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some((c: any) => c.type === "text" && c.text?.includes("[PLAN MODE ACTIVE]"));
				}
				return true;
			}),
		};
	});

	// After agent finishes in plan mode, present the plan and show menu
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;
		await presentPlan(ctx);
	});

	// ---- Session Restore ----

	pi.on("session_start", async (_event, ctx) => {
		detectTasksExtension();

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const saved = entries
			.filter((e: any) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; planFilePath?: string; planDescription?: string } } | undefined;

		if (saved?.data) {
			planModeEnabled = saved.data.enabled ?? planModeEnabled;
			planFilePath = saved.data.planFilePath ?? planFilePath;
			planDescription = saved.data.planDescription ?? planDescription;
		}

		if (planModeEnabled) {
			if (!planFilePath) planFilePath = generatePlanPath();
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
