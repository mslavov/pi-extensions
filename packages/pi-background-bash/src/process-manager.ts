import { spawn } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { createOutputLog, readLogTail } from "./logs.js";
import {
	BackgroundBashJobStore,
	type BackgroundBashJob,
	type BackgroundBashStatusFilter,
	isProcessAlive,
	isTerminalStatus,
} from "./job-store.js";

export interface WaitBackgroundBashResult {
	job: BackgroundBashJob;
	timedOut: boolean;
}

const WAIT_POLL_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function createRunnerCommand(): string {
	return `set +e
"$PI_BG_SHELL" -c "$PI_BG_COMMAND" >> "$PI_BG_OUTPUT_PATH" 2>&1
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
	status="completed"
else
	status="failed"
fi
completed_at=$(($(date +%s) * 1000))
"$PI_BG_NODE" -e 'const fs = require("fs"); const [status, exitCodeRaw, completedAtRaw] = process.argv.slice(1); const infoPath = process.env.PI_BG_INFO_PATH; const tmpPath = infoPath + "." + process.pid + ".tmp"; const info = JSON.parse(fs.readFileSync(infoPath, "utf8")); info.status = status; info.exitCode = Number(exitCodeRaw); info.signal = null; info.completedAt = Number(completedAtRaw); info.updatedAt = Number(completedAtRaw); fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2) + "\\n"); fs.renameSync(tmpPath, infoPath);' "$status" "$exit_code" "$completed_at"
exit "$exit_code"
`;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		process.kill(pid, signal);
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch {
		process.kill(pid, signal);
	}
}

export class BackgroundBashManager {
	private storeFor(cwd: string): BackgroundBashJobStore {
		return new BackgroundBashJobStore(cwd);
	}

	async start(command: string, cwd: string): Promise<BackgroundBashJob> {
		const { shell, args } = getShellConfig();
		const store = this.storeFor(cwd);
		let job = await store.createJob(command, shell, args);

		await createOutputLog(job.meta.logPath);

		const child = spawn(shell, [...args, createRunnerCommand()], {
			cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				PI_BG_COMMAND: command,
				PI_BG_INFO_PATH: job.meta.infoPath,
				PI_BG_NODE: process.execPath,
				PI_BG_OUTPUT_PATH: job.meta.logPath,
				PI_BG_SHELL: shell,
			},
			stdio: "ignore",
			windowsHide: true,
		});

		child.on("error", async (error) => {
			await store.markStatus(job.meta.id, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				exitCode: null,
				signal: null,
			});
		});

		if (!child.pid) {
			await store.markStatus(job.meta.id, {
				status: "failed",
				error: "Process did not report a pid.",
				exitCode: null,
				signal: null,
			});
			throw new Error("Failed to start background bash process: no pid returned.");
		}

		child.unref();
		job = (await store.updatePid(job.meta.id, child.pid)) ?? job;
		return job;
	}

	async list(cwd: string, status: BackgroundBashStatusFilter = "all"): Promise<BackgroundBashJob[]> {
		return this.storeFor(cwd).listJobs(status);
	}

	async get(cwd: string, id: string): Promise<BackgroundBashJob> {
		const job = await this.storeFor(cwd).readJob(id);
		if (!job) throw new Error(`Background bash job not found: ${id}`);
		return job;
	}

	async wait(cwd: string, id: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<WaitBackgroundBashResult> {
		const deadline = timeoutSeconds === undefined ? undefined : Date.now() + Math.max(0, timeoutSeconds) * 1000;

		while (true) {
			const job = await this.get(cwd, id);
			if (isTerminalStatus(job.status.status)) {
				return { job, timedOut: false };
			}

			if (deadline !== undefined && Date.now() >= deadline) {
				return { job, timedOut: true };
			}

			const delay = deadline === undefined ? WAIT_POLL_MS : Math.max(0, Math.min(WAIT_POLL_MS, deadline - Date.now()));
			await sleep(delay, signal);
		}
	}

	async stop(cwd: string, id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<BackgroundBashJob> {
		const store = this.storeFor(cwd);
		const job = await this.get(cwd, id);
		if (isTerminalStatus(job.status.status)) return job;

		const pid = job.status.pid ?? job.meta.pid;
		if (!pid || !isProcessAlive(pid)) {
			const unknown = await store.markStatus(id, {
				status: "unknown",
				pid,
				exitCode: null,
				signal: null,
				error: pid ? "Process is no longer alive." : "No process id was recorded.",
			});
			if (!unknown) throw new Error(`Background bash job not found: ${id}`);
			return unknown;
		}

		killProcessGroup(pid, signal);
		const killed = await store.markStatus(id, {
			status: "killed",
			pid,
			exitCode: null,
			signal,
		});
		if (!killed) throw new Error(`Background bash job not found: ${id}`);
		return killed;
	}

	async tail(cwd: string, id: string, lines = 80): Promise<string> {
		const job = await this.get(cwd, id);
		return readLogTail(job.meta.logPath, lines);
	}
}
