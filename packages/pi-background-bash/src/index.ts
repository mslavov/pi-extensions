import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentToolResult, type BashToolDetails, createBashTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { normalizeBackgroundCommand } from "./command-normalizer.js";
import { type BackgroundBashJob, type BackgroundBashStatusFilter } from "./job-store.js";
import { BackgroundBashManager } from "./process-manager.js";
import { BackgroundBashOverlay } from "./ui/background-bash-overlay.js";

const STATUS_VALUES = ["running", "completed", "failed", "killed", "unknown", "all"] as const;
const SIGNAL_VALUES = ["SIGTERM", "SIGKILL"] as const;

const BashParams = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds for foreground commands" })),
	background: Type.Optional(
		Type.Boolean({
			description: "If true, start the command as a detached background job and return immediately with a log file path",
		}),
	),
});

const ListBackgroundBashParams = Type.Object({
	status: Type.Optional(StringEnum(STATUS_VALUES, { description: "Filter jobs by status" })),
});

const WaitBackgroundBashParams = Type.Object({
	id: Type.String({ description: "Background bash job id returned by bash(background: true)" }),
	timeout: Type.Optional(Type.Number({ description: "Maximum seconds to wait before returning current status" })),
});

const StopBackgroundBashParams = Type.Object({
	id: Type.String({ description: "Background bash job id returned by bash(background: true)" }),
	signal: Type.Optional(StringEnum(SIGNAL_VALUES, { description: "Signal to send. Default: SIGTERM." })),
});

type BashParams = Static<typeof BashParams>;
type ListBackgroundBashParams = Static<typeof ListBackgroundBashParams>;
type WaitBackgroundBashParams = Static<typeof WaitBackgroundBashParams>;
type StopBackgroundBashParams = Static<typeof StopBackgroundBashParams>;

interface BackgroundBashDetails {
	background: true;
	id: string;
	pid?: number;
	status: string;
	logPath: string;
	infoPath: string;
	jobDir: string;
	command: string;
	originalCommand?: string;
	rtkRewriteRemoved?: boolean;
	cwd: string;
	startedAt: number;
}

function formatDate(ms: number | undefined): string {
	return ms ? new Date(ms).toISOString() : "-";
}

function formatDuration(job: BackgroundBashJob): string {
	const end = job.status.completedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - job.meta.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m${remaining}s`;
}

function oneLine(value: string, max = 90): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function formatJobDetails(job: BackgroundBashJob): string {
	return [
		`ID: ${job.meta.id}`,
		`Status: ${job.status.status}`,
		`PID: ${job.status.pid ?? job.meta.pid ?? "-"}`,
		`Exit code: ${job.status.exitCode ?? "-"}`,
		`Signal: ${job.status.signal ?? "-"}`,
		`Started: ${formatDate(job.meta.startedAt)}`,
		`Completed: ${formatDate(job.status.completedAt)}`,
		`Duration: ${formatDuration(job)}`,
		`Log: ${job.meta.logPath}`,
		`Info: ${job.meta.infoPath}`,
		`Job dir: ${job.meta.jobDir}`,
		`Command: ${job.meta.command}`,
	].join("\n");
}

function formatStarted(job: BackgroundBashJob): string {
	return `Started background bash job.\n\n${formatJobDetails(job)}\n\nUse list_background_bash to see jobs, wait_background_bash with id "${job.meta.id}" to wait, stop_background_bash to stop it, or read the log file to inspect live output.`;
}

function formatJobList(jobs: BackgroundBashJob[]): string {
	if (jobs.length === 0) return "No background bash jobs found for this project.";
	const rows = jobs.map((job) => {
		const pid = String(job.status.pid ?? job.meta.pid ?? "-");
		const exit = job.status.exitCode ?? job.status.signal ?? "-";
		return [
			`${job.meta.id}  ${job.status.status}  pid=${pid}  exit=${exit}  started=${formatDate(job.meta.startedAt)}  duration=${formatDuration(job)}`,
			`  log: ${job.meta.logPath}`,
			`  command: ${oneLine(job.meta.command)}`,
		].join("\n");
	});
	return rows.join("\n\n");
}

function formatWaitResult(job: BackgroundBashJob, timedOut: boolean): string {
	const heading = timedOut ? "Background bash job is still running." : "Background bash job finished.";
	return `${heading}\n\n${formatJobDetails(job)}\n\nUse the read tool on the Log path to inspect output.`;
}

export default function backgroundBashExtension(pi: ExtensionAPI): void {
	const manager = new BackgroundBashManager();
	const foregroundBash = createBashTool(process.cwd());
	let currentCtx: ExtensionContext | undefined;
	let statusPollTimer: ReturnType<typeof setInterval> | undefined;
	let statusUpdateRunning = false;

	const updateStatus = async (ctx = currentCtx) => {
		if (!ctx?.hasUI || statusUpdateRunning) return;
		statusUpdateRunning = true;
		try {
			const running = await manager.list(ctx.cwd, "running");
			const count = running.length;
			const label = count === 1 ? "1 job" : `${count} jobs`;
			const icon = count > 0 ? ctx.ui.theme.fg("accent", "●") : ctx.ui.theme.fg("dim", "○");
			const text = count > 0 ? ctx.ui.theme.fg("accent", label) : ctx.ui.theme.fg("dim", label);
			ctx.ui.setStatus("background-bash", `${icon} ${text}`);
		} catch {
			ctx.ui.setStatus("background-bash", ctx.ui.theme.fg("warning", "jobs ?"));
		} finally {
			statusUpdateRunning = false;
		}
	};

	const startStatusPolling = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (statusPollTimer) clearInterval(statusPollTimer);
		void updateStatus(ctx);
		statusPollTimer = setInterval(() => void updateStatus(), 5000);
	};

	const stopStatusPolling = (ctx?: ExtensionContext) => {
		if (statusPollTimer) {
			clearInterval(statusPollTimer);
			statusPollTimer = undefined;
		}
		(ctx ?? currentCtx)?.ui.setStatus("background-bash", undefined);
		currentCtx = undefined;
	};

	const openOverlay = async (ctx: ExtensionContext) => {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => new BackgroundBashOverlay(manager, ctx.cwd, theme, () => done(undefined), () => tui.requestRender()),
			{
				overlay: true,
				overlayOptions: {
					width: "85%",
					minWidth: 72,
					maxHeight: "90%",
					margin: 2,
				},
			},
		);
		await updateStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		startStatusPolling(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopStatusPolling(ctx);
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Set background: true for long-running commands; output is written to a project-local log file that can be inspected with read.",
		promptSnippet: "Execute bash commands, optionally as detached background jobs with background: true",
		promptGuidelines: [
			"Use bash with background: true for long-running commands such as dev servers, watchers, and scripts the agent should not block on.",
			"After starting background bash, inspect output with the read tool on the returned Log path; do not use wait_background_bash just to read output.",
			"Use wait_background_bash only when you need to wait for the job to finish or check whether it has finished.",
			"Use list_background_bash to discover background jobs started by any pi session in the same project.",
		],
		parameters: BashParams,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | BackgroundBashDetails | undefined>> {
			if (!params.background) {
				return foregroundBash.execute(toolCallId, { command: params.command, timeout: params.timeout }, signal, onUpdate);
			}

			const normalized = normalizeBackgroundCommand(params.command);
			const job = await manager.start(normalized.command, ctx.cwd);
			await updateStatus(ctx);
			const notice = normalized.rtkRewriteRemoved
				? "\n\nRTK rewrite was removed for this background job so output streams directly to the log file."
				: "";
			return {
				content: [{ type: "text", text: `${formatStarted(job)}${notice}` }],
				details: {
					background: true,
					id: job.meta.id,
					pid: job.status.pid ?? job.meta.pid,
					status: job.status.status,
					logPath: job.meta.logPath,
					infoPath: job.meta.infoPath,
					jobDir: job.meta.jobDir,
					command: job.meta.command,
					originalCommand: normalized.originalCommand,
					rtkRewriteRemoved: normalized.rtkRewriteRemoved || undefined,
					cwd: job.meta.cwd,
					startedAt: job.meta.startedAt,
				},
			};
		},
		renderCall(args, theme, _context) {
			const suffix = args.background ? theme.fg("muted", " (background)") : "";
			return new Text(theme.fg("toolTitle", theme.bold(`$ ${args.command}`)) + suffix, 0, 0);
		},
	});

	pi.registerTool({
		name: "list_background_bash",
		label: "List Background Bash",
		description: "List background bash jobs started in this project, including jobs started by other pi sessions.",
		promptSnippet: "List project-local background bash jobs and their log paths",
		parameters: ListBackgroundBashParams,
		async execute(_toolCallId, params: ListBackgroundBashParams, _signal, _onUpdate, ctx) {
			const jobs = await manager.list(ctx.cwd, (params.status ?? "all") as BackgroundBashStatusFilter);
			await updateStatus(ctx);
			return {
				content: [{ type: "text", text: formatJobList(jobs) }],
				details: { jobs: jobs.map((job) => ({ meta: job.meta, status: job.status })) },
			};
		},
	});

	pi.registerTool({
		name: "wait_background_bash",
		label: "Wait Background Bash",
		description: "Wait for a background bash job to finish, or return current status after a timeout. Does not return output; use read on the Log path for output.",
		promptSnippet: "Wait for a background bash job and return status plus log path",
		parameters: WaitBackgroundBashParams,
		async execute(_toolCallId, params: WaitBackgroundBashParams, signal, _onUpdate, ctx) {
			const result = await manager.wait(ctx.cwd, params.id, params.timeout, signal);
			await updateStatus(ctx);
			return {
				content: [{ type: "text", text: formatWaitResult(result.job, result.timedOut) }],
				details: { job: result.job, timedOut: result.timedOut },
			};
		},
	});

	pi.registerTool({
		name: "stop_background_bash",
		label: "Stop Background Bash",
		description: "Stop a running background bash job by id and mark it as killed in the project registry.",
		promptSnippet: "Stop a running background bash job by id",
		parameters: StopBackgroundBashParams,
		async execute(_toolCallId, params: StopBackgroundBashParams, _signal, _onUpdate, ctx) {
			const job = await manager.stop(ctx.cwd, params.id, params.signal ?? "SIGTERM");
			await updateStatus(ctx);
			return {
				content: [{ type: "text", text: `Background bash stop result.\n\n${formatJobDetails(job)}` }],
				details: { job },
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "View background bash jobs and logs",
		handler: async (_args, ctx) => openOverlay(ctx),
	});

	pi.registerShortcut(Key.ctrlShift("b"), {
		description: "View background bash jobs and logs",
		handler: openOverlay,
	});
}
