import { resolve } from "node:path";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import { withFileMutationQueue, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as showboat from "./showboat-cli.js";

const ACTIONS = ["status", "init", "note", "exec", "image", "pop", "verify", "extract"] as const;
const MUTATING_ACTIONS = new Set<ShowboatAction>(["init", "note", "exec", "image", "pop"]);
const WORK_TOOL_NAMES = new Set(["bash", "edit", "write", "Agent", "todo_write"]);
const MUTATION_TOOL_NAMES = new Set(["edit", "write"]);
const SHOWCASE_PROMPT_PATTERN = /\b(showboat|demo|showcase|demonstrat(?:e|ion))\b/i;
const COMPLEX_WORK_PROMPT_PATTERN = /\b(implement|fix|debug|investigat(?:e|ion)|build|feature|bug|refactor|repair|plan|failing|failure|error|issue)\b/i;
const GENERAL_WORK_PROMPT_PATTERN = /\b(update|add|create|change|test|verify|execute|run)\b/i;
const SIMPLE_CHANGE_PATTERN = /\b(typo|spelling|comment|readme|docs?|documentation|formatting)\b/i;
const SKIP_SHOWCASE_PATTERN = /\b(?:no|don't|do not|skip|without).{0,40}\b(?:showboat|demo|showcase|demonstrat(?:e|ion))\b/i;

type ShowboatAction = (typeof ACTIONS)[number];

type ShowboatParams = {
	action: ShowboatAction;
	file?: string;
	title?: string;
	text?: string;
	lang?: string;
	code?: string;
	path?: string;
	output?: string;
	filename?: string;
	workdir?: string;
};

type TruncationMetadata = Omit<showboat.TruncatedOutput, "content">;

interface ShowboatDetails {
	action: ShowboatAction;
	available?: boolean;
	backend?: showboat.ShowboatInvocation | null;
	command?: string[];
	exitCode?: number | null;
	stdout?: string;
	stderr?: string;
	truncation?: {
		stdout: TruncationMetadata;
		stderr: TruncationMetadata;
	};
	file?: string;
	path?: string;
	output?: string;
	filename?: string;
	workdir?: string;
	attempts?: showboat.ShowboatAttempt[];
	autoShowcase?: {
		enabled: boolean;
	};
	error?: string;
}

const ShowboatParamsSchema = Type.Object({
	action: StringEnum(ACTIONS),
	file: Type.Optional(Type.String({ description: "Showboat Markdown file" })),
	title: Type.Optional(Type.String({ description: "Demo title for init" })),
	text: Type.Optional(Type.String({ description: "Commentary for note, or optional alt text for image" })),
	lang: Type.Optional(Type.String({ description: "Language/interpreter for exec, e.g. bash or python3" })),
	code: Type.Optional(Type.String({ description: "Code to execute and capture" })),
	path: Type.Optional(Type.String({ description: "Image path for image" })),
	output: Type.Optional(Type.String({ description: "Optional output file for verify --output" })),
	filename: Type.Optional(Type.String({ description: "Optional filename override for extract --filename" })),
	workdir: Type.Optional(Type.String({ description: "Working directory for Showboat command execution" })),
});

export default function showboatExtension(pi: ExtensionAPI): void {
	let showcaseFollowUpPending = false;
	let showcaseFollowUpRunning = false;

	pi.registerTool({
		name: "showboat",
		label: "Showboat",
		description: "Create and verify Showboat demo Markdown using real captured command output and images.",
		promptSnippet: "Create and verify executable Showboat demo Markdown with captured command output and images.",
		parameters: ShowboatParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeAction(params as ShowboatParams, ctx, signal);
		},
	});

	pi.registerCommand("showboat", {
		description: "Showboat helpers: /showboat status | init <file> <title> | verify <file> | extract <file>",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			const command = parsed[0] ?? "status";

			if (command === "status") {
				const status = await showboat.resolveShowboat();
				ctx.ui.notify(`${formatStatus(status)}\nAutomatic post-task showcase: on`, status.available ? "info" : "warning");
				return;
			}

			if (command === "init") {
				if (!parsed[1] || parsed.length < 3) {
					ctx.ui.notify("Usage: /showboat init <file> <title>", "error");
					return;
				}
				await notifyAction(ctx, await executeAction({ action: "init", file: parsed[1], title: parsed.slice(2).join(" ") }, ctx, ctx.signal));
				return;
			}

			if (command === "verify") {
				if (!parsed[1]) {
					ctx.ui.notify("Usage: /showboat verify <file>", "error");
					return;
				}
				await notifyAction(ctx, await executeAction({ action: "verify", file: parsed[1] }, ctx, ctx.signal));
				return;
			}

			if (command === "extract") {
				if (!parsed[1]) {
					ctx.ui.notify("Usage: /showboat extract <file>", "error");
					return;
				}
				await notifyAction(ctx, await executeAction({ action: "extract", file: parsed[1] }, ctx, ctx.signal));
				return;
			}

			ctx.ui.notify("Usage: /showboat status | /showboat init <file> <title> | /showboat verify <file> | /showboat extract <file>", "error");
		},
	});

	pi.on("agent_start", async () => {
		showcaseFollowUpRunning = showcaseFollowUpPending;
		showcaseFollowUpPending = false;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (showcaseFollowUpRunning) {
			showcaseFollowUpRunning = false;
			return;
		}

		if (!shouldRequestShowcase(event.messages)) return;

		const status = await showboat.resolveShowboat();
		if (!status.available) {
			ctx.ui.notify(`${formatStatus(status)} Automatic showcase skipped.`, "warning");
			return;
		}

		showcaseFollowUpPending = true;
		sendUserMessage(ctx, buildShowcaseFollowUpPrompt());
	});

	async function executeAction(
		params: ShowboatParams,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ShowboatDetails>> {
		if (params.action === "status") {
			return statusResult(await showboat.resolveShowboat());
		}

		const file = params.file ? resolvePath(ctx.cwd, params.file) : undefined;
		const workdir = params.workdir ? resolvePath(ctx.cwd, params.workdir) : undefined;
		const output = params.output ? resolvePath(ctx.cwd, params.output) : undefined;
		const imagePath = params.path ? resolveImageInput(ctx.cwd, params.path, params.text) : undefined;
		const validationError = validateParams(params, file);
		if (validationError) return errorResult(params.action, validationError);

		const run = async () => {
			switch (params.action) {
				case "init":
					return showboat.init(file!, params.title!, { cwd: ctx.cwd, workdir, signal });
				case "note":
					return showboat.note(file!, params.text!, { cwd: ctx.cwd, workdir, signal });
				case "exec":
					return showboat.exec(file!, params.lang!, params.code!, { cwd: ctx.cwd, workdir, signal });
				case "image":
					return showboat.image(file!, imagePath!, { cwd: ctx.cwd, workdir, signal });
				case "pop":
					return showboat.pop(file!, { cwd: ctx.cwd, workdir, signal });
				case "verify":
					return showboat.verify(file!, output, { cwd: ctx.cwd, workdir, signal });
				case "extract":
					return showboat.extract(file!, params.filename, { cwd: ctx.cwd, workdir, signal });
				case "status":
					throw new Error("status handled before CLI execution");
			}
		};

		const runAndFormat = async () =>
			runResult(params.action, await run(), {
				file,
				path: params.action === "image" ? imagePath : undefined,
				output,
				filename: params.filename,
				workdir,
			});

		if (file && MUTATING_ACTIONS.has(params.action)) {
			return withFileMutationQueue(file, runAndFormat);
		}

		return runAndFormat();
	}

	function sendUserMessage(ctx: ExtensionContext, content: string): void {
		if (ctx.isIdle()) {
			pi.sendUserMessage(content);
		} else {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		}
	}
}

function shouldRequestShowcase(messages: unknown[]): boolean {
	if (showboatDemoWasCreated(messages)) return false;

	const userText = extractUserText(messages);
	if (!userText.trim()) return false;
	if (isSlashCommandOnly(userText)) return false;
	if (SKIP_SHOWCASE_PATTERN.test(userText)) return false;

	const toolNames = collectToolNames(messages);
	const toolCount = countToolResults(messages);
	const hasMutation = [...toolNames].some((name) => MUTATION_TOOL_NAMES.has(name));
	const hasWorkTool = [...toolNames].some((name) => WORK_TOOL_NAMES.has(name));

	if (SHOWCASE_PROMPT_PATTERN.test(userText)) return hasWorkTool;
	if (SIMPLE_CHANGE_PATTERN.test(userText) && toolCount < 3 && !toolNames.has("bash")) return false;
	if (COMPLEX_WORK_PROMPT_PATTERN.test(userText)) return hasWorkTool;
	if (hasMutation && (toolNames.has("bash") || toolNames.has("todo_write") || toolNames.has("Agent") || toolCount >= 3)) return true;
	return GENERAL_WORK_PROMPT_PATTERN.test(userText) && toolNames.has("bash");
}

function showboatDemoWasCreated(messages: unknown[]): boolean {
	return messages.some((message) => {
		const msg = message as { role?: unknown; toolName?: unknown; details?: { action?: unknown } };
		return msg.role === "toolResult" && msg.toolName === "showboat" && msg.details?.action !== "status";
	});
}

function collectToolNames(messages: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		const msg = message as { role?: unknown; toolName?: unknown };
		if (msg.role === "toolResult" && typeof msg.toolName === "string") names.add(msg.toolName);
	}
	return names;
}

function countToolResults(messages: unknown[]): number {
	return messages.filter((message) => (message as { role?: unknown }).role === "toolResult").length;
}

function extractUserText(messages: unknown[]): string {
	return messages
		.map((message) => {
			const msg = message as { role?: unknown; content?: unknown };
			if (msg.role !== "user") return "";
			return textFromContent(msg.content);
		})
		.filter(Boolean)
		.join("\n");
}

function textFromContent(content: unknown): string {
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

function isSlashCommandOnly(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("/") && !trimmed.includes("\n");
}

function validateParams(params: ShowboatParams, file: string | undefined): string | undefined {
	if (!file) return `file is required for ${params.action}`;

	switch (params.action) {
		case "init":
			if (!params.title) return "title is required for init";
			return;
		case "note":
			if (!params.text) return "text is required for note";
			return;
		case "exec":
			if (!params.lang) return "lang is required for exec";
			if (!params.code) return "code is required for exec";
			return;
		case "image":
			if (!params.path) return "path is required for image";
			return;
		case "pop":
		case "verify":
		case "extract":
			return;
		case "status":
			return;
	}
}

function runResult(
	action: ShowboatAction,
	result: showboat.ShowboatRunResult,
	paths: { file?: string; path?: string; output?: string; filename?: string; workdir?: string },
): AgentToolResult<ShowboatDetails> {
	const details: ShowboatDetails = {
		action,
		available: result.available,
		backend: result.backend,
		command: result.command,
		exitCode: result.exitCode,
		stdout: result.stdout.content,
		stderr: result.stderr.content,
		truncation: {
			stdout: truncationMetadata(result.stdout),
			stderr: truncationMetadata(result.stderr),
		},
		file: paths.file,
		path: paths.path,
		output: paths.output,
		filename: paths.filename,
		workdir: paths.workdir,
		error: result.error,
	};

	if (!result.available) details.attempts = result.attempts;

	return {
		content: [{ type: "text", text: formatRunResult(action, result, paths.file) }],
		details,
	};
}

function statusResult(status: showboat.ShowboatStatus): AgentToolResult<ShowboatDetails> {
	return {
		content: [{ type: "text", text: `${formatStatus(status)}\nAutomatic post-task showcase: on` }],
		details: {
			action: "status",
			available: status.available,
			backend: status.backend,
			attempts: status.attempts,
			autoShowcase: { enabled: true },
		},
	};
}

function errorResult(action: ShowboatAction, message: string): AgentToolResult<ShowboatDetails> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { action, error: message },
	};
}

async function notifyAction(ctx: ExtensionContext, result: AgentToolResult<ShowboatDetails>): Promise<void> {
	const text = result.content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
	const details = result.details;
	const type = details.error || details.available === false ? "error" : details.exitCode && details.exitCode !== 0 ? "warning" : "info";
	ctx.ui.notify(text, type);
}

function formatStatus(status: showboat.ShowboatStatus): string {
	if (status.available && status.backend) return `Showboat available via ${status.backend.display}.`;
	const tried = status.attempts.map((attempt) => attempt.backend.display).join(", ") || "showboat, uvx showboat";
	return `Showboat unavailable. Tried: ${tried}.`;
}

function formatRunResult(action: ShowboatAction, result: showboat.ShowboatRunResult, file: string | undefined): string {
	if (!result.available) return "Showboat unavailable. Install `showboat` or `uv`, then try again.";

	const lines = [`Showboat ${action} exited ${result.exitCode ?? "unknown"}${file ? ` for ${file}` : ""}.`];
	if (action === "verify" && result.exitCode === 0 && !result.stdout.content.trim() && !result.stderr.content.trim()) {
		lines.push("Verification passed.");
	}
	appendOutput(lines, "stdout", result.stdout);
	appendOutput(lines, "stderr", result.stderr);
	if (result.error && result.exitCode === null) lines.push(`error: ${result.error}`);
	return lines.join("\n\n");
}

function appendOutput(lines: string[], label: string, output: showboat.TruncatedOutput): void {
	if (!output.content.trim()) return;
	const suffix = output.truncated ? ` (truncated by ${output.truncatedBy})` : "";
	lines.push(`${label}${suffix}:\n${output.content.trimEnd()}`);
}

function truncationMetadata(output: showboat.TruncatedOutput): TruncationMetadata {
	const { content: _content, ...metadata } = output;
	return metadata;
}

function resolvePath(cwd: string, path: string): string {
	const normalized = stripPathPrefix(path.trim());
	return resolve(cwd, normalized);
}

function resolveImageInput(cwd: string, path: string, altText: string | undefined): string {
	const trimmed = path.trim();
	if (trimmed.startsWith("![")) return trimmed;
	const imagePath = resolvePath(cwd, trimmed);
	if (!altText) return imagePath;
	return `![${altText.replaceAll("]", "\\]")}](${imagePath})`;
}

function stripPathPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function parseArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) current += "\\";
	if (current) args.push(current);
	return args;
}

function buildShowcaseFollowUpPrompt(): string {
	return `Create a concise Showboat showcase for the work you just completed.

Use the \`showboat\` tool only; do not edit Showboat Markdown manually.
- Create a task-specific demo file such as \`demo.md\` or \`demos/<slug>.md\` if one does not already fit this work.
- Add a short note summarizing what changed.
- Capture the key verification or demonstration commands with \`showboat\` action \`exec\`.
- If UI or visual behavior changed, use available project/browser tooling to produce screenshots, then append them with \`showboat\` action \`image\`.
- Use \`showboat\` action \`verify\` before the final response when practical.
- If a captured step is wrong or noisy, use \`showboat\` action \`pop\`.

Do not redo implementation work unless a demonstration command reveals a real issue. If there is genuinely no executable or visible behavior to demonstrate, say that briefly and do not create a demo.

End with a brief final response that includes the demo file path when a demo is created.`;
}
