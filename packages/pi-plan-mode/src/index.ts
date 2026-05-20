/**
 * Plan Mode Extension — Integrated with @tintinweb/pi-subagents
 *
 * Iterative planning workflow inspired by Claude Code's plan mode:
 *   1. Explore codebase (directly + Explore agents for parallel search)
 *   2. Update the standalone HTML plan file incrementally as understanding grows
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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, Markdown, Text } from "@earendil-works/pi-tui";

const TODO_TOOL = "todo_write";
const AGENT_TOOL = "Agent";
const EXPLORE_AGENT = "Explore";
const PLAN_AGENT = "Plan";

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planFilePath = "";
	let planDescription = "";
	let hasTodoExtension = false;
	let hasAgentTool = false;
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
		return join(getPlansDir(), `plan-${slug}.html`);
	}

	function readPlanFile(path: string): string | null {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	}

	function openPlanInBrowser(path: string, ctx: ExtensionContext): void {
		const url = pathToFileURL(path).href;
		let command: string;
		let args: string[];

		if (process.platform === "darwin") {
			command = "open";
			args = [url];
		} else if (process.platform === "win32") {
			command = "cmd";
			args = ["/c", "start", "", url];
		} else {
			command = "xdg-open";
			args = [url];
		}

		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.on("error", () => {
				ctx.ui.notify(`Could not open HTML plan in a browser. Open manually: ${path}`, "warning");
			});
			child.unref();
		} catch {
			ctx.ui.notify(`Could not open HTML plan in a browser. Open manually: ${path}`, "warning");
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

	function detectAvailableTools(): void {
		try {
			const toolNames = new Set(pi.getAllTools().map((t) => t.name));
			hasTodoExtension = toolNames.has(TODO_TOOL);
			hasAgentTool = toolNames.has(AGENT_TOOL);
		} catch {
			hasTodoExtension = false;
			hasAgentTool = false;
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
		fullInstructionsSent = false;
		planFilePath = generatePlanPath();

		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		ctx.ui.notify(
			hasAgentTool
				? "Plan mode enabled — agent-first planning workflow."
				: "Plan mode enabled — iterative planning workflow.",
		);
		updateStatus(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
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
	 * After planning completes, read the HTML plan file and show the menu.
	 */
	async function presentPlan(
		ctx: ExtensionContext,
		options: { sendPreviewMessage?: boolean; onPreview?: (preview: string) => void } = {},
	): Promise<string | undefined> {
		const content = readPlanFile(planFilePath);

		if (!content) {
			ctx.ui.notify(`No HTML plan file found at ${planFilePath}. The planner may not have written to the expected path.`, "error");

			const recovery = await ctx.ui.select("HTML plan file missing — what next?", [
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

		openPlanInBrowser(planFilePath, ctx);

		const preview = `📋 **HTML plan ready**\n\n- Plan saved to: \`${planFilePath}\`\n- Opened in your browser.\n- If it did not open, open this file manually: \`${planFilePath}\``;
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
				planPresentedThisAgent = false;
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
		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();

		const executeContent = `Execute the implementation plan saved as standalone HTML at \`${planFilePath}\`.

${buildTodoInstructions()}

Focus only on the HTML plan — ignore previous exploration context.`;

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
		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();

		const todoInstructions = buildTodoInstructions();
		const delegationLead = hasTodoExtension ? "After creating the todos" : "After reading the HTML plan";

		pi.sendMessage(
			{
				customType: "plan-execute",
				content: `${todoInstructions}

${delegationLead}, delegate execution to a subagent:

Agent({ subagent_type: "general-purpose", prompt: "Execute the implementation plan at ${escapeForTemplate(planFilePath)}. Read the standalone HTML plan file before making changes. Derive the implementation tasks from the visible headings, lists, and diagrams, then implement them in order. Use todo_write if available to update progress as you work.\\n\\nOriginal request: ${escapeForTemplate(planDescription)}", description: "Execute implementation plan" })

Monitor the subagent progress with get_subagent_result.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	function buildTodoInstructions(): string {
		if (!hasTodoExtension) {
			return `Before making changes, read the HTML plan file at \`${planFilePath}\` and derive the implementation tasks from the visible headings, lists, and diagrams.`;
		}

		return `Before making changes:
1. Read the HTML plan file at \`${planFilePath}\`.
2. Extract a concise implementation task list from the visible headings, lists, and diagrams.
3. Call todo_write with those tasks.
4. Execute the tasks in order, updating todos as you work — mark each task as \`in_progress\` when starting and \`completed\` when done.`;
	}

	function escapeForTemplate(s: string): string {
		return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	}

	function planWorkflowReminder(): string {
		return hasAgentTool
			? "Follow the agent-first 5-phase workflow: Explore agents, Plan agents, review, write the final HTML plan, then call exit_plan_mode."
			: "Follow iterative workflow: explore codebase, interview user, and write the standalone HTML plan incrementally.";
	}

	function buildPlanFileStructureInstructions(): string {
		return `### Phase 4: Final HTML Plan
Goal: Write the final plan directly to the HTML plan file (the only file you can edit) as a standalone HTML document.

HTML artifact contract:
- Write a complete <!doctype html> document with html, head, and body elements.
- Use inline CSS and inline SVG only. Do not link external assets, scripts, stylesheets, images, fonts, or CDNs.
- Keep the HTML source readable. Do not include hidden JSON, hidden script blocks, or any machine-readable todo contract.
- Include visible sections with clear headings: Context, Recommended approach, Implementation steps, Files to modify, Existing code to reuse, Verification.
- Include only your recommended approach, not all alternatives.
- Keep the plan concise enough to scan quickly, but detailed enough to execute effectively.
- Include the paths of critical files to be modified.
- Reference existing functions and utilities you found that should be reused, with file paths.
- Include at least one useful, restrained diagram using inline SVG. Usually choose an architecture, flowchart, or sequence diagram based on the plan.
- When the diagram-design skill is available, load and follow it before drawing diagrams. Keep diagrams readable with clear labels and minimal visual noise.`;
	}

	function buildAgentFirstWorkflowInstructions(): string {
		return `## Plan Workflow

### Phase 1: Initial Understanding
Goal: Understand the user's request and gather relevant evidence without polluting the main context.

1. Focus on the user's intent, constraints, and likely code paths. Use direct read-only tools only for quick targeted checks needed to brief ${EXPLORE_AGENT} agents.
2. Launch 1-3 ${EXPLORE_AGENT} agents to explore efficiently.
   - Use 1 agent when the task is isolated to known files, specific paths, or a small targeted change.
   - Use multiple agents when scope is uncertain, multiple areas are involved, or you need to understand existing patterns before planning.
   - If using multiple agents, give each a specific search focus and set run_in_background: true. Collect results with get_subagent_result using wait: true.
   - Ask each ${EXPLORE_AGENT} agent to return a concise summary of what it explored, key files/functions, evidence that matters, dead ends or irrelevant areas, and open questions.
   - Quality over quantity: use the minimum number of agents necessary.
   - Do not proceed to Phase 2 until the exploration results you need have completed.

### Phase 2: Design
Goal: Design an implementation approach using the exploration summaries.

Launch ${PLAN_AGENT} agent(s) to design the implementation based on the user's intent and the ${EXPLORE_AGENT} results. Forward the exploration summaries to the ${PLAN_AGENT}; do not re-read files yourself just to restate what the ${EXPLORE_AGENT} agents already found.

**Guidelines:**
- Default: launch at least 1 ${PLAN_AGENT} agent for most non-trivial tasks. It helps validate your understanding and consider trade-offs.
- Skip ${PLAN_AGENT} agents only for truly trivial tasks like typo fixes, single-line changes, or simple renames.
- For complex work, launch up to 3 ${PLAN_AGENT} agents in parallel with different perspectives. If launching multiple agents, set run_in_background: true and collect results with get_subagent_result using wait: true.
- Instruct ${PLAN_AGENT} agents to rely on the provided exploration summaries first and perform only targeted reads when a specific detail is missing, ambiguous, or conflicting.
- Do not write the final plan until the design results you need have completed.

In each ${PLAN_AGENT} prompt:
- Provide the relevant Phase 1 summaries, including filenames, code path traces, dead ends, and open questions
- Describe requirements and constraints
- Request a concrete implementation plan with critical files and verification steps

### Phase 3: Review
Goal: Validate the ${PLAN_AGENT} output against the user's intent and the exploration evidence.
1. Check whether the recommended plan solves the user's actual request and respects known constraints.
2. Do not re-read files by default. Re-read only when the plan conflicts with exploration findings, depends on a code detail missing from the summaries, contains an unsupported claim, or needs exact line-level context.
3. Prefer targeted follow-up prompts to ${EXPLORE_AGENT} or ${PLAN_AGENT} agents over broad direct exploration.
4. Synthesize a single recommended approach.
5. Use ask_user to clarify any remaining requirements or decisions that cannot be resolved from code.

${buildPlanFileStructureInstructions()}

### Phase 5: Call exit_plan_mode
At the very end of your turn, once you have asked necessary questions and are happy with the final HTML plan file, call exit_plan_mode to request user approval.

Your turn should only end by either:
- Using ask_user to gather more information from the user
- Calling the exit_plan_mode tool when the plan is ready for approval

**Important:** Call the exit_plan_mode tool to request plan approval. Do NOT print exit_plan_mode as text. Do NOT ask about plan approval via text or ask_user. Do NOT say "Is this plan okay?" or "Should I proceed?" — call the tool for that.`;
	}

	function buildIterativeWorkflowInstructions(): string {
		const exploreAgentHint = hasAgentTool
			? ` You can use the ${EXPLORE_AGENT} agent type through the ${AGENT_TOOL} tool to parallelize complex searches without filling your context, though for straightforward queries direct tools are simpler.`
			: "";

		return `## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you can't make alone, and write your findings into the standalone HTML plan file as you go.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use read, bash, grep, find, ls to read code. Look for existing functions, utilities, and patterns to reuse.${exploreAgentHint}
2. **Update the HTML plan file** — After each discovery, immediately capture what you learned in a complete standalone HTML document. Don't wait until the end.
3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, use ask_user. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton standalone HTML plan with the required visible sections and ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none

### HTML Plan File Structure

Maintain a complete standalone HTML document as the plan source of truth. Fill it out as you go:
- Start with <!doctype html> and include html, head, and body elements.
- Use inline CSS and inline SVG only. Do not link external assets, scripts, stylesheets, images, fonts, or CDNs.
- Keep the HTML source readable. Do not include hidden JSON, hidden script blocks, or any machine-readable todo contract.
- Include visible sections with clear headings: Context, Recommended approach, Implementation steps, Files to modify, Existing code to reuse, Verification.
- Include at least one useful, restrained diagram using inline SVG. Usually choose an architecture, flowchart, or sequence diagram based on the plan.
- When the diagram-design skill is available, load and follow it before drawing diagrams.

Keep it concise enough to scan quickly, but detailed enough to execute effectively.

### When to Converge

Your plan is ready when the HTML document addresses all ambiguities and covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes.

### Ending Your Turn

Your turn should only end by either:
- Using ask_user to gather more information from the user
- Calling the exit_plan_mode tool when the plan is ready for approval

**Important:** Call the exit_plan_mode tool to request plan approval. Do NOT print exit_plan_mode as text. Do NOT ask about plan approval via text or ask_user. Do NOT say "Is this plan okay?" or "Should I proceed?" — call the tool for that.`;
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

Plan mode keeps all registered tools available while restricting direct write/edit tool calls to the HTML plan file. When the Agent tool is available, use Explore and Plan subagents for agent-first planning; otherwise, explore directly and build the plan incrementally.`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (planModeEnabled) {
				return { content: [{ type: "text" as const, text: "Already in plan mode." }], details: undefined };
			}
			detectAvailableTools();
			enablePlanMode(ctx);
			return { content: [{ type: "text" as const, text: `Plan mode enabled. HTML plan file: ${planFilePath}\n\nYou are now in planning mode. Direct write/edit tool calls are limited to the HTML plan file. ${planWorkflowReminder()} Call the exit_plan_mode tool when the plan is ready for approval.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit Plan Mode",
		description: `Exit plan mode and present the plan for user approval. Call this when:
- Your plan is complete and written to the standalone HTML plan file
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
			return { content: [{ type: "text" as const, text: preview ?? "Plan mode exited." }], details: undefined, terminate: true };
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
			detectAvailableTools();
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
			detectAvailableTools();
			lastCommandCtx = ctx as ExtensionCommandContext;
			if (planModeEnabled) {
				disablePlanMode(ctx);
			} else {
				enablePlanMode(ctx);
			}
		},
	});

	// ---- Event Handlers ----

	// Restrict write/edit to the HTML plan file only
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		// Restrict write/edit to the HTML plan file only
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPath = (event.input.path as string) ?? "";
			if (!targetPath || !planFilePath || targetPath !== planFilePath) {
				return {
					block: true,
					reason: `Plan mode: only the HTML plan file can be edited.\nAllowed: ${planFilePath}\nAttempted: ${targetPath}`,
				};
			}
			return; // allow write/edit to the HTML plan file
		}

	});

	// Inject planning instructions
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!planModeEnabled) return;
		detectAvailableTools();

		// Sparse reminder on subsequent turns
		if (fullInstructionsSent) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
Plan mode still active (see full instructions earlier in conversation). Direct write/edit tool calls are limited to the HTML plan file (\`${planFilePath}\`).
${planWorkflowReminder()}
End turns with ask_user (for clarifications) or by calling the exit_plan_mode tool (for plan approval).
Do not ask about plan approval via text or ask_user — call the exit_plan_mode tool instead.`,
					display: false,
				},
			};
		}

		fullInstructionsSent = true;

		const planExistsInfo = readPlanFile(planFilePath)
			? `An HTML plan file already exists at \`${planFilePath}\`. You can read it and make incremental edits.`
			: `No HTML plan file exists yet. Create a standalone HTML plan at \`${planFilePath}\` using the write tool.`;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode. Keep implementation work out of plan mode; direct write/edit tool calls are only allowed for the HTML plan file below. Other registered tools remain available.

## HTML Plan File
${planExistsInfo}
Build your standalone HTML plan incrementally by writing to or editing this file. This is the ONLY file you may edit.

${hasAgentTool ? buildAgentFirstWorkflowInstructions() : buildIterativeWorkflowInstructions()}${planDescription ? `\n\n## Task\n${planDescription}` : ""}`,
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
		detectAvailableTools();

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
