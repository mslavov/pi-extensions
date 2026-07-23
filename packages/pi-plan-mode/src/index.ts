/**
 * Plan Mode Extension — Integrated with @tintinweb/pi-subagents
 *
 * Decision-complete planning workflow:
 *   1. Ground the plan in targeted repository evidence
 *   2. Clarify only decisions that cannot be discovered
 *   3. Write one adaptive standalone HTML implementation plan
 *   4. Review substantial plans independently, then request approval
 *
 * Commands:
 *   /plan [description]  Toggle plan mode, or start planning with a task
 *   /plan-approve        Approve the current plan without using UI
 *   /plan-refine <text>  Refine the current plan without using UI
 *   /plan-exit           Exit plan mode without using UI
 *   Ctrl+Alt+P           Toggle plan mode
 *
 * Tool (model-initiated after /plan):
 *   exit_plan_mode       Model presents the completed plan for approval
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key, Markdown, Text } from "@earendil-works/pi-tui";
import { formatPlanReviewFeedback, startPlanReviewServer, type PlanReviewDecision } from "./plan-review-server.js";

const AGENT_TOOL = "Agent";
const EXPLORE_AGENT = "Explore";
const PLAN_AGENT = "Plan";
const EXPLORATION_AGENT_MODEL = "low";
const EXPLORATION_AGENT_THINKING = "low";
const PLANNING_AGENT_MODEL = "high";
const PLANNING_AGENT_THINKING = "xhigh";
const PI_NOTIFY_EVENT = "pi:notify";
const PLAN_READY_EVENT = "pi:plan-mode:ready";
const PLAN_CLOSED_EVENT = "pi:plan-mode:closed";
const PLAN_MODE_BRIDGE_SYMBOL = Symbol.for("pi-plan-mode:external-bridge:v1");
const PLAN_TEMPLATE = readFileSync(new URL("./plan-template.html", import.meta.url), "utf-8");

type ExternalPlanReviewAction = "approve" | "refine" | "exit";

type ExternalPlanReviewPrompt = {
	sessionId: string;
	planFilePath: string;
	reviewUrl?: string;
	createdAt: number;
	submitDecision(action: ExternalPlanReviewAction, feedback?: string): { ok: boolean; error?: string };
};

type ExternalPlanModeBridge = {
	pending: Map<string, ExternalPlanReviewPrompt>;
};

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planFilePath = "";
	let planDescription = "";
	let planAwaitingApproval = false;
	let submittedPlanDigest = "";
	let hasAgentTool = false;
	// Stash the command context (has newSession) for "execute with clean context"
	let lastCommandCtx: ExtensionCommandContext | undefined;

	// ---- Helpers ----

	function getPlansDir(): string {
		const dir = join(process.cwd(), ".pi", "plans");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	}

	function allocateInitializedPlanPath(): string {
		const now = new Date();
		const slug = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
		const plansDir = getPlansDir();

		for (let attempt = 0; ; attempt += 1) {
			const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
			const path = join(plansDir, `plan-${slug}${suffix}.html`);
			try {
				writeFileSync(path, PLAN_TEMPLATE, { encoding: "utf-8", flag: "wx" });
				return path;
			} catch (error) {
				if ((error as { code?: string }).code !== "EEXIST") throw error;
			}
		}
	}

	function readPlanFile(path: string): string | null {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	}

	function digestPlan(content: string): string {
		return createHash("sha256").update(content).digest("hex");
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
		const initializedPlanPath = allocateInitializedPlanPath();
		planModeEnabled = true;
		planAwaitingApproval = false;
		submittedPlanDigest = "";
		planFilePath = initializedPlanPath;

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
		planAwaitingApproval = false;
		submittedPlanDigest = "";
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
			planAwaitingApproval,
			submittedPlanDigest,
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

	function getExternalPlanModeBridge(): ExternalPlanModeBridge {
		const global = globalThis as Record<PropertyKey, unknown>;
		const existing = global[PLAN_MODE_BRIDGE_SYMBOL] as ExternalPlanModeBridge | undefined;
		if (existing) return existing;
		const bridge = { pending: new Map<string, ExternalPlanReviewPrompt>() };
		global[PLAN_MODE_BRIDGE_SYMBOL] = bridge;
		return bridge;
	}

	function planReadyMessage(reviewUrl?: string): string {
		return reviewUrl ? `HTML plan ready: ${planFilePath} (${reviewUrl})` : `HTML plan ready: ${planFilePath}`;
	}

	function emitPlanReady(ctx: ExtensionContext, reviewUrl?: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const event = {
			v: 1,
			source: "pi-plan-mode",
			kind: "ready",
			level: "info",
			title: "Plan ready",
			message: planReadyMessage(reviewUrl),
			sessionId,
			planFilePath,
			reviewUrl,
			dedupeKey: `plan-ready:${sessionId}:${planFilePath}`,
			minIntervalMs: 30_000,
		};
		pi.events.emit(PLAN_READY_EVENT, event);
		pi.events.emit(PI_NOTIFY_EVENT, event);
	}

	function emitPlanClosed(ctx: ExtensionContext, reason: string): void {
		pi.events.emit(PLAN_CLOSED_EVENT, {
			v: 1,
			source: "pi-plan-mode",
			sessionId: ctx.sessionManager.getSessionId(),
			planFilePath,
			reason,
		});
	}

	function registerExternalPlanReview(ctx: ExtensionContext, reviewUrl: string | undefined, handleImmediately: boolean): { waitForDecision: () => Promise<PlanReviewDecision>; clear: () => void } {
		const sessionId = ctx.sessionManager.getSessionId();
		let settled = false;
		let resolveDecision!: (decision: PlanReviewDecision) => void;
		const decisionPromise = new Promise<PlanReviewDecision>((resolve) => {
			resolveDecision = resolve;
		});
		const prompt: ExternalPlanReviewPrompt = {
			sessionId,
			planFilePath,
			reviewUrl,
			createdAt: Date.now(),
			submitDecision(action, feedback) {
				if (settled) return { ok: false, error: "That plan review has already been handled." };
				if (!planModeEnabled) return { ok: false, error: "Plan mode is not active." };
				settled = true;
				getExternalPlanModeBridge().pending.delete(sessionId);
				const note = feedback?.trim();
				const decision: PlanReviewDecision = {
					action,
					feedback: action === "refine" && note
						? formatPlanReviewFeedback({ planFilePath, annotations: [], note })
						: note || undefined,
					annotations: [],
				};
				resolveDecision(decision);
				if (handleImmediately) {
					void handleReviewDecision(ctx, decision)
						.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
						.finally(() => emitPlanClosed(ctx, action));
				}
				return { ok: true };
			},
		};
		getExternalPlanModeBridge().pending.set(sessionId, prompt);
		return {
			waitForDecision: () => decisionPromise,
			clear: () => {
				if (getExternalPlanModeBridge().pending.get(sessionId) === prompt) {
					getExternalPlanModeBridge().pending.delete(sessionId);
				}
			},
		};
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
			planAwaitingApproval = false;
			submittedPlanDigest = "";
			persistState();
			const feedback = decision.feedback?.trim();
			if (!feedback) {
				ctx.ui.notify("Review submitted without feedback; plan mode remains active.", "warning");
				return;
			}
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
		const externalReview = registerExternalPlanReview(ctx, server.url, false);
		emitPlanReady(ctx, server.url);
		openReviewInBrowser(server.url, ctx);

		const preview = buildPlanPreview(false, server.url);
		options.onPreview?.(preview);
		if (options.sendPreviewMessage !== false) {
			await sendPlanResult(preview);
		}

		try {
			const decision = await Promise.race([server.waitForDecision(), externalReview.waitForDecision()]);
			await delay(500);
			await handleReviewDecision(ctx, decision);
			return preview;
		} finally {
			externalReview.clear();
			server.stop();
			emitPlanClosed(ctx, "resolved");
		}
	}

	/**
	 * After planning completes, read the HTML plan file and present available controls.
	 */
	async function presentPlan(
		ctx: ExtensionContext,
		options: { sendPreviewMessage?: boolean; onPreview?: (preview: string) => void } = {},
	): Promise<string | undefined> {
		planAwaitingApproval = false;
		submittedPlanDigest = "";
		persistState();
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
				const initializedPlanPath = allocateInitializedPlanPath();
				planAwaitingApproval = false;
				planFilePath = initializedPlanPath;
				persistState();
				sendUserMessage(ctx, planDescription || "Create the implementation plan");
			} else {
				disablePlanMode(ctx);
			}
			return;
		}

		planAwaitingApproval = true;
		submittedPlanDigest = digestPlan(content);
		persistState();

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
		registerExternalPlanReview(ctx, undefined, true);
		emitPlanReady(ctx);
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
			planAwaitingApproval = false;
			submittedPlanDigest = "";
			persistState();
			const refinement = await ctx.ui.editor("Describe what to change:", "");
			if (refinement?.trim()) {
				if (!planModeEnabled) {
					ctx.ui.notify("That plan is no longer active; refinement was ignored.", "warning");
					return preview;
				}
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
		const content = planFilePath ? readPlanFile(planFilePath) : null;
		if (!content) return buildPlanMissingMessage();
		if (!planAwaitingApproval) return "The plan has not been submitted for approval. Call exit_plan_mode after finalizing the HTML plan.";
		if (!submittedPlanDigest || digestPlan(content) !== submittedPlanDigest) {
			planAwaitingApproval = false;
			submittedPlanDigest = "";
			persistState();
			return "The HTML plan changed after it was submitted for approval. Call exit_plan_mode again to review the current artifact.";
		}

		planModeEnabled = false;
		planDescription = "";
		planAwaitingApproval = false;
		submittedPlanDigest = "";
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
1. Create one Bead per approved implementation task before implementation, using the visible Implementation tasks section and explicit task dependencies.
2. Mirror explicit task dependencies in Beads with bd dependency syntax, bd link, or bd dep commands. Keep tasks sequential when parallel safety is not explicit.
3. Keep coordination in the main agent: track dependencies, update Bead status, collect worker results, run final verification, and close completed Beads.
4. Launch worker subagents only for independent ready tasks. Pass each worker the task ID/title, Bead ID, plan path, files, acceptance criteria, dependencies, verification steps, and suggested skills.
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
		planAwaitingApproval = false;
		submittedPlanDigest = "";
		persistState();
		sendUserMessage(ctx, text);
		return undefined;
	}

	function buildBeadsExecutionInstructions(): string {
		return `Before making changes:
1. Read the HTML plan file at \`${planFilePath}\`.
2. Use the visible "Implementation tasks" section and any explicit task dependencies as the source of truth.
3. Load and follow the beads skill guidance. Use direct \`bd\` CLI commands for task management; pi-beads is display-only status visibility.
4. Check the Beads workspace with \`bd status\` / \`bd ready\`. If no Beads database exists, ask the user to run \`bd init\` before continuing.
5. Create one Bead per approved implementation task with \`bd create\`, encoding explicit dependencies with Beads dependency syntax such as \`--deps blocks:<id>\` or follow-up \`bd link\` / \`bd dep\` commands.
6. Mark active work with \`bd update <id> --status in_progress\`, blocked work with \`bd update <id> --status blocked --append-notes ...\`, and completed work with \`bd close <id> --reason ...\`.
7. Prefer parallel subagents for independent ready tasks. Give each worker the task ID/title, Bead ID, plan path, files, acceptance criteria, dependencies, verification steps, and suggested skills. Use \`run_in_background: true\` for independent work and keep overlapping-file or dependency-blocked work sequential.
8. Load and use relevant available skills for each task before acting. When no listed skill applies, proceed with standard tools.`;
	}

	function escapeForTemplate(s: string): string {
		return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	}

	function isBeadsMutationCommand(command: string): boolean {
		return /(?:^|[;&|({}\s])bd\s+(?:init|create|new|q|update|close|done|link|dep|delete|reopen|assign|priority|tag|label|note|comment|edit|set-state|todo\s+(?:add|create|update|close|done|delete))\b/.test(command);
	}

	function buildReviewFeedbackInstructions(): string {
		return "If the user submits annotated plan review feedback, revise the same HTML plan file directly, address each quoted comment or global note, and call exit_plan_mode again when the updated plan is ready for review.";
	}

	function buildPlanFileStructureInstructions(): string {
		return `### Authoritative HTML Plan
The supplied HTML path is already initialized from the implementation-plan starter. Read the complete starter before editing it, then refine that same artifact directly. It is the only editable artifact and the implementation source of truth after approval.

Strict artifact rules:
- Preserve the starter's paper/ink/accent visual system and its existing responsive, accessible cards, callouts, tables, and task primitives. Adapt them to the plan instead of replacing the design with a new theme or rendering abstraction.
- Replace every visible [[Replace...]] placeholder with final content. Adapt or remove every optional or example section that is irrelevant to this plan.
- Write a complete <!doctype html> document with semantic html, head, and body elements.
- Use inline CSS and inline SVG only. Do not use scripts or link external assets, stylesheets, images, fonts, or CDNs.
- Keep the source readable. Do not add hidden JSON, hidden task metadata, or machine-readable todo contracts.
- Present one recommended approach. Include a rejected alternative only when its trade-off explains a consequential decision.
- Keep the plan concise by default and decision-complete: enough detail for another engineer or agent to implement safely without inventing product or architecture policy.

Required content. Use the canonical **Implementation tasks** heading for execution handoff; adapt the other headings to the task:
- **Summary** — the problem or current constraint, desired outcome, and core implementation move.
- **Recommended changes** — behavior and design changes grouped by subsystem or user-visible flow, with critical paths or symbols only where they remove ambiguity.
- **Implementation tasks** — the Beads to create after approval. Use the number of tasks justified by real delivery, dependency, ownership, or verification boundaries; never target an arbitrary count. Each task includes its outcome, acceptance criteria, likely files when useful, explicit dependencies, parallel-safety, verification, and clearly relevant skills.
- **Verification** — focused tests and quality commands, plus important manual or integration scenarios.
- **Decisions and assumptions** — settled choices, user-approved defaults, and any remaining implementation-safe assumptions.

Add only when relevant:
- Customer/user problem, goals, non-goals, requirements, and acceptance criteria for product or system work.
- Current-system evidence, ownership boundaries, reusable code, and current-to-target divergence.
- Interfaces, schemas, data flow, security/privacy, failure modes, observability, migration, rollout, and rollback.
- A dependency graph when multiple tasks have meaningful ordering or parallel branches.
- An architecture, sequence, flow, or state diagram when it communicates the design more clearly than prose.
- Review findings with an explicit accepted, deferred, or rejected disposition.
- ADR candidates for cross-component, hard-to-reverse decisions that rejected a real alternative.

Shape the plan to the work:
- Product/system changes: lead with user value and order tasks by the smallest independently releasable outcome, not by architecture layer.
- Refactors: state preserved behavior and use behavior-preserving checkpoints.
- Bugs: capture observed behavior, root-cause evidence, the targeted fix, and regression coverage.

Visual design:
- Use a restrained system-font layout with strong hierarchy, readable cards/tables/callouts, responsive styling, and accessible contrast.
- For multi-component, stateful, async, security-boundary, migration, or dependency-heavy plans, proactively inspect the skills that are actually available and use a relevant diagram or visualization skill when one is present.
- Diagrams are optional. Final diagrams must be focused, accessible inline SVG with role="img", aria-labelledby referencing a <title> and <desc>, readable labels and contrast, and text or shape semantics so meaning does not rely on color alone. Omit diagrams for simple work when prose or a table is clearer. Never invent or invoke an unavailable skill.`;
	}

	function buildPlanningWorkflowInstructions(): string {
		const delegation = hasAgentTool
			? `### Agent Workflow
Use direct read-only tools only for quick checks needed to brief agents or validate their evidence. Keep delegated scopes independent and use the minimum number of agents needed for complete coverage.

- Use one or more ${EXPLORE_AGENT} agents for distinct repository questions that can run independently. Prefer the cheap configuration \`model: "${EXPLORATION_AGENT_MODEL}"\`, \`thinking: "${EXPLORATION_AGENT_THINKING}"\`. Give each agent a narrow focus and request a detailed evidence bundle with paths, symbols, line numbers, patterns, constraints, risks, and unresolved questions. Run independent calls in the background and do not duplicate their work in the main agent.
- After the required evidence is collected, launch one ${PLAN_AGENT} at \`model: "${PLANNING_AGENT_MODEL}"\`, \`thinking: "${PLANNING_AGENT_THINKING}"\`. Pass the exact HTML path, user intent, constraints, evidence bundles, and the full artifact contract below. The ${PLAN_AGENT} owns plan synthesis and writes the HTML artifact. Keep one plan writer at a time.
- If ${PLAN_AGENT} is unavailable or disabled, do not substitute an unrestricted general-purpose agent; author the artifact directly using the fallback workflow.
- For substantial, cross-component, security-sensitive, migration-heavy, or otherwise risky work, optionally launch a separate ${PLAN_AGENT} as an independent adversarial reviewer after a coherent draft exists. Ask it to return findings without editing, covering unsupported assumptions, contract gaps, security/privacy issues, rollout hazards, verification gaps, and incorrect task dependencies. Require evidence and a recommendation for every finding, then send accepted revisions to the writing ${PLAN_AGENT}.
- Keep clarification with the root agent. Subagents return evidence or critique; they do not decide user preferences.

After an independent review, revise the same HTML artifact and record each material finding as accepted, deferred with rationale, or rejected with rationale.`
			: `### Delegation
No Agent tool is available. Perform targeted exploration and review directly with read-only tools.`;

		const authoring = hasAgentTool
			? `Have the ${PLAN_AGENT} write and refine one coherent HTML artifact after enough evidence exists. A lightweight skeleton is acceptable while a user decision is pending, but it is not ready for approval. The main agent coordinates clarification, checks the artifact against user intent and evidence, and keeps all plan-file writes serialized through the writing ${PLAN_AGENT}.`
			: "Write and refine one coherent HTML artifact directly after enough evidence exists. A lightweight skeleton is acceptable while a user decision is pending, but it is not ready for approval.";

		return `## Planning Workflow

### 1. Ground in Evidence
Start with targeted non-mutating exploration. Resolve repository facts from code, tests, configuration, docs, and history before asking the user. Identify current behavior, ownership, reusable patterns, constraints, and practical verification commands.

### 2. Resolve Material Decisions
Clarify only choices that materially change scope, behavior, architecture, compatibility, or risk and cannot be discovered. Prefer one focused ask_user question, or a short wizard for independent decisions. Put the recommended option first and record defaulted choices as assumptions.

Do not ask the user for approval through ask_user. Approval is handled by exit_plan_mode.

${delegation}

### 3. Author the Plan
${authoring}

${buildPlanFileStructureInstructions()}

Do not create or mutate Beads in plan mode. The approved implementation tasks become Beads during execution.

### 4. Finalize Explicitly
Before approval, confirm that the plan matches the user's intent, every claim is supported or labeled as an assumption, task boundaries follow delivery/dependency reality, and verification proves the desired outcome. Before calling exit_plan_mode, remove every remaining [[Replace...]] placeholder and every irrelevant optional or example section. Preserve the starter's visual system. Do not invent schemas, fallback rules, rollout policy, or edge-case behavior unless the request or repository requires them.

Call exit_plan_mode only when the artifact is decision-complete. Do not print the tool name as prose and do not ask “Should I proceed?”`;
	}

	// ---- Tool (available only to finish user-initiated plan mode) ----

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
		description: "Approve a plan submitted through exit_plan_mode and execute it without opening the approval UI",
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
			planAwaitingApproval = false;
			submittedPlanDigest = "";
			persistState();
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
	pi.on("before_agent_start", async (event) => {
		if (!planModeEnabled) return;
		detectAvailableTools();

		const planExistsInfo = readPlanFile(planFilePath)
			? `The initialized HTML plan starter exists at \`${planFilePath}\`. Read it completely and refine that same artifact while preserving its visual system.`
			: `No HTML plan file exists yet. Create a standalone HTML plan at \`${planFilePath}\` using the write tool.`;

		return {
			systemPrompt: `${event.systemPrompt}

[PLAN MODE ACTIVE]
You are in plan mode. Keep implementation work out of plan mode; direct write/edit tool calls are only allowed for the HTML plan file below. Other registered tools remain available. Do not create, update, close, or link Beads before approval; include proposed Beads visibly in the plan instead.

## HTML Plan File
${planExistsInfo}
This is the ONLY file you may edit.

${buildReviewFeedbackInstructions()}

${buildPlanningWorkflowInstructions()}${planDescription ? `\n\n## Task\n${planDescription}` : ""}`,
		};
	});

	// System-prompt instructions supersede persisted plan-mode context entries.
	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const msg = message as { customType?: unknown };
			return msg.customType !== "plan-mode-context";
		}),
	}));

	// ---- Session Restore ----

	pi.on("session_start", async (_event, ctx) => {
		detectAvailableTools();

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const saved = entries
			.filter((e: any) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled: boolean; planFilePath?: string; planDescription?: string; planAwaitingApproval?: boolean; submittedPlanDigest?: string } } | undefined;

		if (saved?.data) {
			planModeEnabled = saved.data.enabled ?? planModeEnabled;
			planFilePath = saved.data.planFilePath ?? planFilePath;
			planDescription = saved.data.planDescription ?? planDescription;
			planAwaitingApproval = saved.data.planAwaitingApproval ?? planAwaitingApproval;
			submittedPlanDigest = saved.data.submittedPlanDigest ?? submittedPlanDigest;
		}

		if (planModeEnabled) {
			if (!planFilePath) planFilePath = allocateInitializedPlanPath();
			const tools = pi.getAllTools().map((t) => t.name);
			pi.setActiveTools(tools);
		}
		updateStatus(ctx);
	});
}
