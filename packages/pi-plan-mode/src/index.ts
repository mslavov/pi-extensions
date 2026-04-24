/**
 * Plan Mode Extension — Integrated with @tintinweb/pi-subagents
 *
 * Iterative planning workflow inspired by Claude Code's plan mode:
 *   1. Explore codebase (directly + Explore agents for parallel search)
 *   2. Update plan file incrementally as understanding grows
 *   3. Ask user clarifying questions via ask_user/questionnaire
 *   4. Repeat until plan is complete
 *   5. Call exit_plan_mode for user approval
 *
 * Commands:
 *   /plan [description]  Toggle plan mode, or start planning with a task
 *   Ctrl+Alt+P           Toggle plan mode
 *
 * Tools (model-initiated):
 *   enter_plan_mode      Model can enter plan mode for complex tasks
 *   exit_plan_mode       Model exits plan mode, presents plan for approval
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Key, Markdown, Text } from "@mariozechner/pi-tui";
import { extractPlanSteps, type PlanStep } from "./utils.js";

const TODO_TOOL = "todo_write";

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planFilePath = "";
	let planDescription = "";
	let planSteps: PlanStep[] = [];
	let hasTodoExtension = false;
	let fullInstructionsSent = false;
	let planPresentedThisAgent = false;
	// Stash the command context (has newSession) for "execute with clean context"
	let lastCommandCtx: ExtensionCommandContext | undefined;

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

	function textContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const text = (part as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			})
			.filter(Boolean)
			.join("\n");
	}

	function renderMarkdown(content: string): Markdown | Text {
		return content.trim()
			? new Markdown(content, 0, 0, getMarkdownTheme())
			: new Text("", 0, 0);
	}

	function detectTodoExtension(): void {
		try {
			hasTodoExtension = pi.getAllTools().some((t) => t.name === TODO_TOOL);
		} catch {
			hasTodoExtension = false;
		}
	}

	function sendUserMessage(ctx: ExtensionContext, content: string): void {
		if (ctx.isIdle()) {
			pi.sendUserMessage(content);
		} else {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
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
		fullInstructionsSent = false;
		planFilePath = generatePlanPath();

		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		ctx.ui.notify("Plan mode enabled — iterative planning workflow.");
		updateStatus(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		planSteps = [];
		planDescription = "";
		fullInstructionsSent = false;
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

	pi.registerMessageRenderer("plan-result", (message) => renderMarkdown(textContent(message.content)));

	/**
	 * After planning completes, read the plan file, extract steps, and show the menu.
	 */
	async function presentPlan(
		ctx: ExtensionContext,
		options: { sendPreviewMessage?: boolean; onPreview?: (preview: string) => void } = {},
	): Promise<string | undefined> {
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
				sendUserMessage(ctx, planDescription || "Create the implementation plan");
			} else {
				disablePlanMode(ctx);
			}
			return;
		}

		planSteps = extractPlanSteps(content);

		const preview = `📋 **Plan saved to:** \`${planFilePath}\`\n\nYou can review and edit the plan file before executing.\n\n---\n\n${content}`;
		options.onPreview?.(preview);

		if (options.sendPreviewMessage !== false) {
			await pi.sendMessage(
				{
					customType: "plan-result",
					content: preview,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		// Show execution menu
		const menuOptions: string[] = [];
		if (hasTodoExtension) {
			menuOptions.push("Execute with main agent (fresh context + plan + todo tracking)");
			menuOptions.push("Execute with subagent (worker + todo tracking)");
		} else {
			menuOptions.push("Execute with main agent");
			menuOptions.push("Execute with subagent (worker)");
		}
		menuOptions.push("Refine the plan");
		menuOptions.push("Exit plan mode");

		const choice = await ctx.ui.select("Plan ready — what next?", menuOptions);

		if (choice?.startsWith("Execute with main agent")) {
			await executeWithMainAgent(ctx);
		} else if (choice?.startsWith("Execute with subagent")) {
			await executeWithSubagent(ctx);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Describe what to change:", "");
			if (refinement?.trim()) {
				sendUserMessage(ctx, refinement.trim());
			}
		} else if (choice === "Exit plan mode") {
			disablePlanMode(ctx);
		}

		return preview;
	}

	/**
	 * Execute plan with the main agent.
	 */
	async function executeWithMainAgent(ctx: ExtensionContext): Promise<void> {
		const content = readPlanFile(planFilePath) ?? "";
		planSteps = extractPlanSteps(content);

		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();

		const todoInstructions = buildTodoInstructions(content);
		const executeContent = `Execute the following implementation plan. The plan file is at \`${planFilePath}\`.

${todoInstructions}

Read the plan file, then execute each step in order. Use todo_write to update progress — mark each task as \`in_progress\` when starting and \`completed\` when done.

Focus only on the plan — ignore previous exploration context.`;

		// Try to start a fresh session so exploration context is gone
		const cmdCtx = lastCommandCtx ?? (ctx as any);
		if (typeof cmdCtx.newSession === "function") {
			const { cancelled } = await cmdCtx.newSession({
				withSession: async (freshCtx: any) => {
					await freshCtx.sendMessage(
						{
							customType: "plan-execute",
							content: executeContent,
							display: true,
						},
						{ triggerTurn: true },
					);
				},
			});
			if (!cancelled) return;
			// User cancelled new session — fall through to same-context execution
		}

		// Fallback: execute in current context
		pi.sendMessage(
			{
				customType: "plan-execute",
				content: executeContent,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	/**
	 * Execute plan with a general-purpose subagent.
	 */
	async function executeWithSubagent(ctx: ExtensionContext): Promise<void> {
		const content = readPlanFile(planFilePath) ?? "";
		planSteps = extractPlanSteps(content);

		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();

		const todoInstructions = buildTodoInstructions(content);

		pi.sendMessage(
			{
				customType: "plan-execute",
				content: `${todoInstructions}

After creating the todos, delegate execution to a subagent:

Agent({ subagent_type: "general-purpose", prompt: "Execute the implementation plan at ${planFilePath}. Read the plan file and implement each step. Use todo_write to update the todo list — mark each task as in_progress when starting and completed when done.\\n\\nOriginal request: ${escapeForTemplate(planDescription)}", description: "Execute implementation plan" })

Monitor the subagent progress with get_subagent_result.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	function buildTodoInstructions(planContent: string): string {
		if (!hasTodoExtension || planSteps.length === 0) {
			return `**Plan file:** \`${planFilePath}\``;
		}

		const todoItems = planSteps
			.map((s) => {
				const content = escapeForTemplate(s.text);
				return `  { content: "${content}", status: "pending", activeForm: "${content}" }`;
			})
			.join(",\n");

		return `First, create a todo list to track progress:\n\ntodo_write({ todos: [\n${todoItems}\n] })`;
	}

	function escapeForTemplate(s: string): string {
		return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	}

	// ---- Tools (model-initiated plan mode control) ----

	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter Plan Mode",
		description: `Enter plan mode for structured planning before implementation. Use this proactively when about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort.

Use when ANY of these apply:
- The task is complex and spans multiple files or components
- Multiple valid approaches exist (e.g., Redis vs in-memory caching)
- The task involves architectural decisions or new subsystems
- Requirements are unclear and you need to explore before understanding scope
- User preferences matter and the implementation could go multiple ways
- You would use ask_user to clarify the approach — use enter_plan_mode instead

Do NOT use for:
- Single-line or few-line fixes (typos, obvious bugs)
- Tasks where the user gave very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with Explore type instead)

Plan mode keeps all registered tools available while restricting direct write/edit tool calls to the plan file. You'll iteratively explore code, ask the user questions, and build the plan incrementally.`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (planModeEnabled) {
				return { content: [{ type: "text" as const, text: "Already in plan mode." }], details: undefined };
			}
			detectTodoExtension();
			enablePlanMode(ctx);
			return { content: [{ type: "text" as const, text: `Plan mode enabled. Plan file: ${planFilePath}\n\nYou are now in planning mode. Direct write/edit tool calls are limited to the plan file. Explore the codebase, ask the user questions, and build the plan incrementally. Call the exit_plan_mode tool when the plan is ready for approval.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit Plan Mode",
		description: `Exit plan mode and present the plan for user approval. Call this when:
- Your plan is complete and written to the plan file
- All ambiguities have been resolved (via ask_user or code exploration)
- The plan covers: what to change, which files to modify, what to reuse, and how to verify

Do NOT use ask_user to ask "Is this plan okay?" or "Should I proceed?" — that's what exit_plan_mode does.
Use ask_user ONLY to clarify requirements or choose between approaches BEFORE finalizing the plan.`,
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "📋 Plan preview"), 0, 0);
		},
		renderResult(result) {
			return renderMarkdown(textContent(result.content));
		},
		async execute(_toolCallId, _params, _signal, onUpdate, ctx) {
			if (!planModeEnabled) {
				return { content: [{ type: "text" as const, text: "Not in plan mode." }], details: undefined };
			}
			planPresentedThisAgent = true;
			const preview = await presentPlan(ctx, {
				sendPreviewMessage: false,
				onPreview: (text) => {
					onUpdate?.({ content: [{ type: "text" as const, text }], details: undefined });
				},
			});
			return { content: [{ type: "text" as const, text: preview ?? "Plan mode exited." }], details: undefined };
		},
	});

	// ---- Commands ----

	pi.registerFlag("plan", {
		description: "Start in plan mode (iterative planning via agents)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or start planning: /plan <task description>",
		handler: async (args, ctx) => {
			detectTodoExtension();
			lastCommandCtx = ctx as ExtensionCommandContext;

			if (args?.trim()) {
				planDescription = args.trim();
				enablePlanMode(ctx);
				sendUserMessage(ctx, planDescription);
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
			detectTodoExtension();
			lastCommandCtx = ctx as ExtensionCommandContext;
			if (planModeEnabled) {
				disablePlanMode(ctx);
			} else {
				enablePlanMode(ctx);
			}
		},
	});

	// ---- Event Handlers ----

	// Restrict write/edit to the plan file only
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		// Restrict write/edit to the plan file only
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPath = (event.input.path as string) ?? "";
			if (!targetPath || !planFilePath || targetPath !== planFilePath) {
				return {
					block: true,
					reason: `Plan mode: only the plan file can be edited.\nAllowed: ${planFilePath}\nAttempted: ${targetPath}`,
				};
			}
			return; // allow write/edit to plan file
		}

	});

	// Inject planning instructions
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!planModeEnabled) return;

		// Sparse reminder on subsequent turns
		if (fullInstructionsSent) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
Plan mode still active (see full instructions earlier in conversation). Direct write/edit tool calls are limited to the plan file (\`${planFilePath}\`).
Follow iterative workflow: explore codebase, interview user, write to plan incrementally.
End turns with ask_user (for clarifications) or by calling the exit_plan_mode tool (for plan approval).
Do not ask about plan approval via text or ask_user — call the exit_plan_mode tool instead.`,
					display: false,
				},
			};
		}

		fullInstructionsSent = true;

		const planExistsInfo = readPlanFile(planFilePath)
			? `A plan file already exists at \`${planFilePath}\`. You can read it and make incremental edits.`
			: `No plan file exists yet. Create your plan at \`${planFilePath}\` using the write tool.`;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode. Keep implementation work out of plan mode; direct write/edit tool calls are only allowed for the plan file below. Other registered tools remain available.

## Plan File
${planExistsInfo}
Build your plan incrementally by writing to or editing this file. This is the ONLY file you may edit.

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you can't make alone, and write your findings into the plan file as you go.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use read, bash, grep, find, ls to read code. Look for existing functions, utilities, and patterns to reuse. You can use the Explore agent type (via the Agent tool with \`subagent_type: "Explore"\`) to parallelize complex searches without filling your context, though for straightforward queries direct tools are simpler.
2. **Update the plan file** — After each discovery, immediately capture what you learned. Don't wait until the end.
3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, use ask_user. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan (headers and rough notes) and ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none

### Plan File Structure

Divide the plan into clear sections using markdown headers. Fill them out as you go:
- **Context** — why this change is needed, what prompted it, intended outcome
- **Approach** — only the recommended approach, not all alternatives
- **Files to modify** — paths of critical files
- **Existing code to reuse** — functions/utilities with file paths
- **Verification** — how to test the changes end-to-end

Keep it concise enough to scan quickly, but detailed enough to execute effectively.

### When to Converge

Your plan is ready when you've addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes.

### Ending Your Turn

Your turn should only end by either:
- Using ask_user to gather more information from the user
- Calling the exit_plan_mode tool when the plan is ready for approval

**Important:** Call the exit_plan_mode tool to request plan approval. Do NOT print \`exit_plan_mode\` as text. Do NOT ask about plan approval via text or ask_user. Do NOT say "Is this plan okay?" or "Should I proceed?" — call the tool for that.${planDescription ? `\n\n## Task\n${planDescription}` : ""}`,
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

	pi.on("agent_start", async () => {
		planPresentedThisAgent = false;
	});

	// After agent finishes in plan mode, present the plan and show menu
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI || planPresentedThisAgent) return;
		await presentPlan(ctx);
	});

	// ---- Session Restore ----

	pi.on("session_start", async (_event, ctx) => {
		detectTodoExtension();

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

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
			const tools = pi.getAllTools().map((t) => t.name);
			pi.setActiveTools(tools);
		}
		updateStatus(ctx);
	});
}
