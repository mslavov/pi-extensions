/**
 * Plan Mode Extension — Integrated with @tintinweb/pi-subagents
 *
 * Iterative planning workflow inspired by Claude Code's plan mode:
 *   1. Explore codebase (directly + Explore agents for parallel search)
 *   2. Update the standalone HTML plan file incrementally as understanding grows
 *   3. Ask user clarifying questions via ask_user/questionnaire
 *   4. Include visible Beads tasks and a dependency graph
 *   5. Repeat until plan is complete
 *   6. Call exit_plan_mode for user approval
 *
 * Commands:
 *   /plan [description]  Toggle plan mode, or start planning with a task
 *   /plan-approve        Approve the current plan without using UI
 *   /plan-refine <text>  Refine the current plan without using UI
 *   /plan-exit           Exit plan mode without using UI
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
import { startPlanReviewServer, type PlanReviewDecision } from "./plan-review-server.js";

const AGENT_TOOL = "Agent";
const EXPLORE_AGENT = "Explore";
const PLAN_AGENT = "Plan";
const PLAN_WRITER_AGENT = "PlanWriter";
const PI_NOTIFY_EVENT = "pi:notify";

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planFilePath = "";
	let planDescription = "";
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

	function openUrlInBrowser(url: string, fallbackMessage: string, ctx: ExtensionContext): void {
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
				ctx.ui.notify(fallbackMessage, "warning");
			});
			child.unref();
		} catch {
			ctx.ui.notify(fallbackMessage, "warning");
		}
	}

	function openPlanInBrowser(path: string, ctx: ExtensionContext): void {
		openUrlInBrowser(
			pathToFileURL(path).href,
			`Could not open HTML plan in a browser. Open manually: ${path}`,
			ctx,
		);
	}

	function openReviewInBrowser(url: string, ctx: ExtensionContext): void {
		openUrlInBrowser(url, `Could not open plan review UI. Open manually: ${url}`, ctx);
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
			hasAgentTool = toolNames.has(AGENT_TOOL);
		} catch {
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

	function shouldUseHeadlessControls(ctx: ExtensionContext): boolean {
		return !ctx.hasUI || pi.getFlag("plan-headless") === true;
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

	async function sendPlanResult(content: string): Promise<void> {
		await pi.sendMessage(
			{
				customType: "plan-result",
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function buildHeadlessControlsText(): string {
		return `Headless controls:
- Approve and execute: send \`/plan-approve\`.
- Refine the plan: send \`/plan-refine <changes>\`.
- Exit plan mode: send \`/plan-exit\`.`;
	}

	function buildPlanPreview(headless: boolean, reviewUrl?: string): string {
		const lines = [
			"📋 **HTML plan ready**",
			"",
			`- Plan saved to: \`${planFilePath}\``,
		];

		if (headless) {
			lines.push("", buildHeadlessControlsText());
		} else if (reviewUrl) {
			lines.push(
				"- Opened annotated review UI in your browser.",
				`- If it did not open, open this URL manually: ${reviewUrl}`,
			);
		} else {
			lines.push(
				"- Opened in your browser.",
				`- If it did not open, open this file manually: \`${planFilePath}\``,
			);
		}

		return lines.join("\n");
	}

	function buildPlanMissingMessage(): string {
		return `No HTML plan file found at \`${planFilePath}\`. The planner may not have written to the expected path. Continue planning or send \`/plan-exit\` to leave plan mode.`;
	}

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function handleReviewDecision(ctx: ExtensionContext, decision: PlanReviewDecision): Promise<void> {
		if (decision.action === "approve") {
			await executeWithBeadsCoordinator(ctx, decision.feedback);
			return;
		}

		if (decision.action === "refine") {
			if (!planModeEnabled) {
				ctx.ui.notify("That plan is no longer active; review feedback was ignored.", "warning");
				return;
			}
			const feedback = decision.feedback?.trim();
			if (!feedback) {
				ctx.ui.notify("Review submitted without feedback; plan mode remains active.", "warning");
				return;
			}
			planPresentedThisAgent = false;
			sendUserMessage(ctx, feedback);
			return;
		}

		disablePlanMode(ctx);
	}

	async function presentPlanReview(
		ctx: ExtensionContext,
		content: string,
		options: { sendPreviewMessage?: boolean; onPreview?: (preview: string) => void },
	): Promise<string> {
		const server = await startPlanReviewServer({ planFilePath, planHtml: content });
		openReviewInBrowser(server.url, ctx);

		const preview = buildPlanPreview(false, server.url);
		options.onPreview?.(preview);
		if (options.sendPreviewMessage !== false) {
			await sendPlanResult(preview);
		}

		try {
			const decision = await server.waitForDecision();
			await delay(500);
			await handleReviewDecision(ctx, decision);
			return preview;
		} finally {
			server.stop();
		}
	}

	/**
	 * After planning completes, read the HTML plan file and present available controls.
	 */
	async function presentPlan(
		ctx: ExtensionContext,
		options: { sendPreviewMessage?: boolean; onPreview?: (preview: string) => void } = {},
	): Promise<string | undefined> {
		const headless = shouldUseHeadlessControls(ctx);
		const content = readPlanFile(planFilePath);

		if (!content) {
			const missingMessage = buildPlanMissingMessage();

			if (headless) {
				options.onPreview?.(missingMessage);
				if (options.sendPreviewMessage !== false) await sendPlanResult(missingMessage);
				return missingMessage;
			}

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

		pi.events.emit(PI_NOTIFY_EVENT, {
			v: 1,
			source: "pi-plan-mode",
			kind: "ready",
			level: "info",
			title: "Plan ready",
			message: `HTML plan ready: ${planFilePath}`,
			dedupeKey: `plan-ready:${planFilePath}`,
			minIntervalMs: 30_000,
		});

		if (!headless) {
			try {
				return await presentPlanReview(ctx, content, options);
			} catch (error) {
				ctx.ui.notify(
					`Annotated plan review UI failed to start; falling back to the basic plan menu. ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				openPlanInBrowser(planFilePath, ctx);
			}
		}

		const preview = buildPlanPreview(headless);
		options.onPreview?.(preview);

		if (options.sendPreviewMessage !== false) {
			await sendPlanResult(preview);
		}

		if (headless) return preview;

		// Show execution menu
		const menuOptions = ["Execute with Beads + parallel subagents", "Refine the plan", "Exit plan mode"];
		const choice = await ctx.ui.select("Plan ready — what next?", menuOptions);

		if (choice === "Execute with Beads + parallel subagents") {
			await executeWithBeadsCoordinator(ctx);
		} else if (choice === "Refine the plan") {
			if (!planModeEnabled) {
				ctx.ui.notify("That plan is no longer active; refinement was ignored.", "warning");
				return preview;
			}
			const refinement = await ctx.ui.editor("Describe what to change:", "");
			if (refinement?.trim()) {
				if (!planModeEnabled) {
					ctx.ui.notify("That plan is no longer active; refinement was ignored.", "warning");
					return preview;
				}
				planPresentedThisAgent = false;
				sendUserMessage(ctx, refinement.trim());
			}
		} else if (choice === "Exit plan mode") {
			disablePlanMode(ctx);
		}

		return preview;
	}

	/**
	 * Execute plan with the main agent as Beads coordinator.
	 */
	function approvePlanState(ctx: ExtensionContext): string | undefined {
		if (!planModeEnabled) return "No active plan to approve.";
		if (!planFilePath || !readPlanFile(planFilePath)) return buildPlanMissingMessage();

		planModeEnabled = false;
		const tools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(tools);
		updateStatus(ctx);
		persistState();
		return undefined;
	}

	function buildPlanExecutionMessage(reviewNotes?: string): string {
		const notes = reviewNotes?.trim()
			? `

Reviewer implementation notes submitted with approval:
${reviewNotes.trim()}`
			: "";

		return `${buildBeadsExecutionInstructions()}

Coordinate execution from the main agent:
1. Create one Bead per approved vertical slice before implementation, using the visible Vertical slices / Tasks to create section and dependency graph.
2. Mirror the dependency graph in Beads with bd dependency syntax, bd link, or bd dep commands.
3. Keep coordination in the main agent: track dependencies, update Bead status, collect worker results, run final verification, and close completed Beads.
4. Launch worker subagents only for independent ready graph branches. Pass each worker the slice ID/title, Bead ID, plan path, files, acceptance criteria, dependencies, verification steps, and suggested skills.
5. Use run_in_background: true for independent work and keep overlapping-file or dependency-blocked work sequential.
6. Use pi-beads for TUI visibility while bd CLI remains the source of task state.${notes}`;
	}

	async function executeWithBeadsCoordinator(ctx: ExtensionContext, reviewNotes?: string): Promise<string> {
		const approvalError = approvePlanState(ctx);
		if (approvalError) {
			ctx.ui.notify(approvalError, "error");
			await sendPlanResult(approvalError);
			return approvalError;
		}

		const content = buildPlanExecutionMessage(reviewNotes);
		await pi.sendMessage(
			{
				customType: "plan-execute",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);

		return `Plan approved. Starting execution from \`${planFilePath}\`.`;
	}

	function refinePlan(ctx: ExtensionContext, refinement: string | undefined): string | undefined {
		if (!planModeEnabled) return "No active plan to refine.";
		const text = refinement?.trim();
		if (!text) return "Usage: /plan-refine <changes>";
		planPresentedThisAgent = false;
		sendUserMessage(ctx, text);
		return undefined;
	}

	function buildBeadsExecutionInstructions(): string {
		return `Before making changes:
1. Read the HTML plan file at \`${planFilePath}\`.
2. Use the visible "Vertical slices / Tasks to create" section and task dependency graph as the source of truth.
3. Load and follow the beads skill guidance. Use direct \`bd\` CLI commands for task management; pi-beads is display-only status visibility.
4. Check the Beads workspace with \`bd status\` / \`bd ready\`. If no Beads database exists, ask the user to run \`bd init\` before continuing.
5. Create one Bead per approved vertical slice with \`bd create\`, encoding graph dependencies with Beads dependency syntax such as \`--deps blocks:<id>\` or follow-up \`bd link\` / \`bd dep\` commands.
6. Mark active work with \`bd update <id> --status in_progress\`, blocked work with \`bd update <id> --status blocked --append-notes ...\`, and completed work with \`bd close <id> --reason ...\`.
7. Prefer parallel subagents for independent ready graph branches. Give each worker the slice ID/title, Bead ID, plan path, files, acceptance criteria, dependencies, verification steps, and suggested skills. Use \`run_in_background: true\` for independent work and keep overlapping-file or dependency-blocked work sequential.
8. Load and use relevant available skills for each task before acting. When no listed skill applies, proceed with standard tools.`;
	}

	function escapeForTemplate(s: string): string {
		return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	}

	function isBeadsMutationCommand(command: string): boolean {
		return /(?:^|[;&|({}\s])bd\s+(?:init|create|new|q|update|close|done|link|dep|delete|reopen|assign|priority|tag|label|note|comment|edit|set-state|todo\s+(?:add|create|update|close|done|delete))\b/.test(command);
	}

	function planWorkflowReminder(): string {
		return hasAgentTool
			? `Follow the agent-first workflow: ${EXPLORE_AGENT} context bundles, ${PLAN_WRITER_AGENT} HTML draft, ${PLAN_AGENT} vertical-slice breakdown, ${PLAN_WRITER_AGENT} finalization, then exit_plan_mode.`
			: "Follow iterative workflow: explore codebase, interview user, and write the standalone HTML plan with visible tasks and a dependency graph incrementally.";
	}

	function buildReviewFeedbackInstructions(): string {
		return "If the user submits annotated plan review feedback, revise the same HTML plan file directly, address each quoted comment or global note, and call exit_plan_mode again when the updated plan is ready for review.";
	}

	function buildPlanFileStructureInstructions(): string {
		return `### Final HTML Plan Contract
Goal: Write the final plan directly to the HTML plan file (the only file you can edit) as a standalone HTML document.

HTML artifact contract:
- Write a complete <!doctype html> document with html, head, and body elements.
- Use inline CSS and inline SVG only. Do not link external assets, scripts, stylesheets, images, fonts, or CDNs.
- Keep the HTML source readable. Do not include hidden JSON, hidden script blocks, hidden machine-readable task metadata, or hidden machine-readable todo contracts.
- Include visible sections with clear headings: Context, Recommended approach, Vertical slices / Tasks to create, Task dependency graph, Implementation steps, Files to modify, Existing code to reuse, Verification.
- The Vertical slices / Tasks to create section must list the Beads that should be created after approval. Each vertical slice should include title, outcome/acceptance criteria, likely files, dependencies or ordering constraints, parallel-safety, verification steps, and suggested skills when an available skill clearly applies.
- The Task dependency graph must be an inline SVG that mirrors how Beads dependencies should be managed. Show each proposed Bead as a node and draw arrows from prerequisite tasks to dependent tasks. Make independent branches visually obvious so execution can delegate them in parallel.
- Include only your recommended approach, not all alternatives.
- Keep the plan concise enough to scan quickly, but detailed enough to execute effectively.
- Include the paths of critical files to be modified.
- Reference existing functions and utilities you found that should be reused, with file paths.
- Include at least one useful, restrained diagram using inline SVG. Usually choose an architecture, flowchart, sequence diagram, or dependency graph based on the plan.
- When the diagram-design skill is available, load and follow it before drawing diagrams. Keep diagrams readable with clear labels and minimal visual noise.`;
	}

	function buildAgentFirstWorkflowInstructions(): string {
		return `## Plan Workflow

### Phase 1: Context Bundles
Goal: identify the right context for planning without polluting the main context.

1. Focus on the user's intent, constraints, and likely code paths. Use direct read-only tools only for quick targeted checks needed to brief ${EXPLORE_AGENT} agents.
2. Launch 1-3 ${EXPLORE_AGENT} agents to produce context bundles.
   - Use 1 agent when the task is isolated to known files, specific paths, or a small targeted change.
   - Use multiple agents when scope is uncertain, multiple areas are involved, or you need to understand existing patterns before planning.
   - If using multiple agents, give each a specific search focus and set run_in_background: true. Collect results with get_subagent_result using wait: true.
   - Ask each ${EXPLORE_AGENT} agent to return an extensive context bundle, not a concise summary.
   - Each bundle must include files, functions/classes, line numbers, CLI/search/read operations performed and important results, existing patterns and constraints, dead ends or irrelevant areas, risks/gaps, and open questions.
   - Quality over quantity: use the minimum number of agents necessary.
   - Do not proceed to Phase 2 until the exploration results you need have completed.

### Phase 2: PlanWriter Draft
Goal: have a planning agent create the implementation plan, including the initial standalone HTML artifact.

Launch one ${PLAN_WRITER_AGENT} agent with the HTML plan file path and the collected context bundles. The ${PLAN_WRITER_AGENT} is responsible for reading any additional proper context, loading relevant skills, proposing the solution, and writing the initial standalone HTML plan draft.

**Guidelines:**
- Pass the exact plan file path: \`${planFilePath}\`.
- Forward the full context bundles. Do not compress them into a lossy summary unless the bundle is too large; preserve file paths, line references, command results, and open questions.
- Instruct ${PLAN_WRITER_AGENT} to rely on the provided context first and perform only targeted reads when a detail is missing, ambiguous, or conflicting.
- Instruct ${PLAN_WRITER_AGENT} to load and follow relevant skills, especially diagram-design when drawing diagrams.
- Serialize plan-file writes. Do not run multiple ${PLAN_WRITER_AGENT} agents against the same plan file in parallel.

In the ${PLAN_WRITER_AGENT} prompt:
- Provide the user's requirements and constraints
- Provide every relevant Phase 1 context bundle
- Ask it to write the HTML draft directly to the plan file path
- Ask it to return the plan path, recommended approach summary, and unresolved questions only

### Phase 3: Vertical Slice Breakdown
Goal: have a separate planning agent break the proposed solution into independently implementable and verifiable vertical slices.

After the ${PLAN_WRITER_AGENT} draft is complete, launch one ${PLAN_AGENT} agent as the task-breakdown agent. Provide the plan file path, the selected approach, and the context/design outputs. Ask it to return 4-10 vertical slices of work.

Each vertical slice must include:
- Bead title
- outcome/acceptance criteria
- likely files
- dependencies or ordering constraints
- whether it is safe to run in parallel
- verification steps for that slice
- suggested skill(s), if an available skill clearly applies

The task-breakdown agent must also return a dependency graph / DAG model in prose: nodes, arrows from prerequisite slices to dependent slices, and which branches can run in parallel.
Do not create or mutate Beads in plan mode. Beads are created only after user approval by the executing agent using the beads skill and direct bd CLI commands.

### Phase 4: PlanWriter Finalization
Goal: update the same HTML plan file so it contains the final recommended solution, vertical slices, and dependency graph.

Launch or resume one ${PLAN_WRITER_AGENT} agent with the plan file path, the draft plan, and the vertical-slice breakdown. Ask it to update the HTML plan with the final visible sections and diagrams required below.

The ${PLAN_WRITER_AGENT} must include the vertical slices and dependency graph in the final HTML plan. It should not create Beads or edit any files other than the supplied HTML plan file.

### Phase 5: Main-Agent Review
Goal: validate the subagent-produced plan against the user's intent and the exploration evidence.
1. Check whether the recommended plan solves the user's actual request and respects known constraints.
2. Check whether the vertical slices and dependency graph match the implementation order and identify safe parallel branches.
3. Do not re-read files by default. Re-read only when the plan conflicts with exploration findings, depends on a code detail missing from the summaries, contains an unsupported claim, or needs exact line-level context.
4. Prefer targeted follow-up prompts to ${EXPLORE_AGENT}, ${PLAN_AGENT}, or ${PLAN_WRITER_AGENT} over broad direct exploration.
5. Do not rewrite the final plan yourself except for small corrections to the HTML file when necessary; the final plan should be authored by ${PLAN_WRITER_AGENT}.
6. Use ask_user to clarify any remaining requirements or decisions that cannot be resolved from code.

${buildPlanFileStructureInstructions()}

### Phase 7: Call exit_plan_mode
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
2. **Update the HTML plan file** — After each discovery, immediately capture what you learned in a complete standalone HTML document, including visible tasks and the dependency graph as they become clear. Don't wait until the end.
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
- Keep the HTML source readable. Do not include hidden JSON, hidden script blocks, hidden machine-readable task metadata, or any machine-readable todo contract.
- Include visible sections with clear headings: Context, Recommended approach, Vertical slices / Tasks to create, Task dependency graph, Implementation steps, Files to modify, Existing code to reuse, Verification.
- The Vertical slices / Tasks to create section must list the Beads that should be created after approval. Each vertical slice should include title, outcome/acceptance criteria, likely files, dependencies or ordering constraints, parallel-safety, verification steps, and suggested skills when an available skill clearly applies.
- The Task dependency graph must be an inline SVG that mirrors how Beads dependencies should be managed. Show each proposed Bead as a node and draw arrows from prerequisite tasks to dependent tasks. Make independent branches visually obvious so execution can delegate them in parallel.
- Include at least one useful, restrained diagram using inline SVG. Usually choose an architecture, flowchart, sequence diagram, or dependency graph based on the plan.
- When the diagram-design skill is available, load and follow it before drawing diagrams.

Do not create or mutate Beads in plan mode. Beads are created only after user approval by the executing agent using the beads skill and direct bd CLI commands.

Keep it concise enough to scan quickly, but detailed enough to execute effectively.

### When to Converge

Your plan is ready when the HTML document addresses all ambiguities and covers: what to change, which vertical-slice Beads to create, the Beads-style dependency graph, which files to modify, what existing code to reuse (with file paths), and how to verify each slice and the full change.

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

Plan mode keeps all registered tools available while restricting direct write/edit tool calls to the HTML plan file. When the Agent tool is available, use Explore for context bundles, PlanWriter to author the HTML plan, and Plan for vertical-slice breakdown; otherwise, explore directly and build the plan incrementally.`,
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

	pi.registerFlag("plan-headless", {
		description: "Use command-based plan approval instead of UI dialogs",
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

	pi.registerCommand("plan-approve", {
		description: "Approve the current plan and execute it without opening the approval UI",
		handler: async (_args, ctx) => {
			await executeWithBeadsCoordinator(ctx);
		},
	});

	pi.registerCommand("plan-refine", {
		description: "Refine the current plan without opening the approval UI: /plan-refine <changes>",
		handler: async (args, ctx) => {
			const error = refinePlan(ctx, args);
			if (error) {
				ctx.ui.notify(error, "warning");
				await sendPlanResult(error);
			}
		},
	});

	pi.registerCommand("plan-exit", {
		description: "Exit plan mode without opening the approval UI",
		handler: async (_args, ctx) => {
			if (!planModeEnabled) {
				const message = "Plan mode is not active.";
				ctx.ui.notify(message, "warning");
				await sendPlanResult(message);
				return;
			}
			disablePlanMode(ctx);
			await sendPlanResult("Plan mode exited. Full access restored.");
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

		if (event.toolName === "bash" || event.toolName === "exec_command") {
			const input = event.input as Record<string, unknown>;
			const command = ((input.command ?? input.cmd) as string | undefined) ?? "";
			if (command && isBeadsMutationCommand(command)) {
				return {
					block: true,
					reason: "Plan mode: do not create, update, close, or link Beads before the user approves the plan. Include proposed Beads visibly in the HTML plan and execute bd mutations only after approval.",
				};
			}
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
Plan mode still active (see full instructions earlier in conversation). Direct write/edit tool calls are limited to the HTML plan file (\`${planFilePath}\`). Do not mutate Beads before approval.
${planWorkflowReminder()}
End turns with ask_user (for clarifications) or by calling the exit_plan_mode tool (for plan approval).
Do not ask about plan approval via text or ask_user — call the exit_plan_mode tool instead.
${buildReviewFeedbackInstructions()}`,
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
You are in plan mode. Keep implementation work out of plan mode; direct write/edit tool calls are only allowed for the HTML plan file below. Other registered tools remain available. Do not create, update, close, or link Beads before approval; include proposed Beads visibly in the plan instead.

## HTML Plan File
${planExistsInfo}
Build your standalone HTML plan incrementally by writing to or editing this file. This is the ONLY file you may edit.

${buildReviewFeedbackInstructions()}

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

	// After agent finishes in plan mode, present the plan controls.
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || planPresentedThisAgent) return;
		if (!ctx.hasUI && !readPlanFile(planFilePath)) return;
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
