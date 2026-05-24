import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type BackgroundBashStatus = "running" | "completed" | "failed" | "killed" | "unknown";
export type BackgroundBashStatusFilter = BackgroundBashStatus | "all";

export interface BackgroundBashInfo {
	id: string;
	command: string;
	cwd: string;
	jobDir: string;
	logPath: string;
	infoPath: string;
	shell: string;
	shellArgs: string[];
	startedAt: number;
	updatedAt: number;
	status: BackgroundBashStatus;
	pid?: number;
	creatorPid: number;
	exitCode?: number | null;
	signal?: string | null;
	completedAt?: number;
	error?: string;
}

export interface BackgroundBashMeta {
	id: string;
	command: string;
	cwd: string;
	jobDir: string;
	logPath: string;
	infoPath: string;
	shell: string;
	shellArgs: string[];
	startedAt: number;
	pid?: number;
	creatorPid: number;
}

export interface BackgroundBashStatusFile {
	id: string;
	status: BackgroundBashStatus;
	startedAt: number;
	updatedAt: number;
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	completedAt?: number;
	error?: string;
}

export interface BackgroundBashJob {
	meta: BackgroundBashMeta;
	status: BackgroundBashStatusFile;
	info: BackgroundBashInfo;
}

const TERMINAL_STATUSES = new Set<BackgroundBashStatus>(["completed", "failed", "killed", "unknown"]);
const PID_STARTUP_GRACE_MS = 5000;

export function getBackgroundBashRoot(cwd: string): string {
	return resolve(cwd, ".pi", "background-bash");
}

export function getBackgroundBashJobsDir(cwd: string): string {
	return join(getBackgroundBashRoot(cwd), "jobs");
}

export function isTerminalStatus(status: BackgroundBashStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

function generateJobId(): string {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `bash-${stamp}-${randomBytes(3).toString("hex")}`;
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tmpPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmpPath, path);
}

function jobFromInfo(info: BackgroundBashInfo): BackgroundBashJob {
	return {
		info,
		meta: {
			id: info.id,
			command: info.command,
			cwd: info.cwd,
			jobDir: info.jobDir,
			logPath: info.logPath,
			infoPath: info.infoPath,
			shell: info.shell,
			shellArgs: info.shellArgs,
			startedAt: info.startedAt,
			pid: info.pid,
			creatorPid: info.creatorPid,
		},
		status: {
			id: info.id,
			status: info.status,
			startedAt: info.startedAt,
			updatedAt: info.updatedAt,
			pid: info.pid,
			exitCode: info.exitCode,
			signal: info.signal,
			completedAt: info.completedAt,
			error: info.error,
		},
	};
}

function infoFromJob(job: BackgroundBashJob): BackgroundBashInfo {
	return {
		...job.info,
		pid: job.status.pid ?? job.meta.pid,
		status: job.status.status,
		updatedAt: job.status.updatedAt,
		exitCode: job.status.exitCode,
		signal: job.status.signal,
		completedAt: job.status.completedAt,
		error: job.status.error,
	};
}

type LegacyMeta = BackgroundBashMeta & {
	metaPath?: string;
	statusPath?: string;
	commandPath?: string;
	runnerPath?: string;
};

export class BackgroundBashJobStore {
	readonly rootDir: string;
	readonly jobsDir: string;

	constructor(readonly cwd: string) {
		this.rootDir = getBackgroundBashRoot(cwd);
		this.jobsDir = getBackgroundBashJobsDir(cwd);
	}

	async createJob(command: string, shell: string, shellArgs: string[]): Promise<BackgroundBashJob> {
		await mkdir(this.jobsDir, { recursive: true });

		let id = generateJobId();
		let jobDir = join(this.jobsDir, id);
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				await mkdir(jobDir);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw error;
				id = generateJobId();
				jobDir = join(this.jobsDir, id);
			}
		}

		const now = Date.now();
		const info: BackgroundBashInfo = {
			id,
			command,
			cwd: this.cwd,
			jobDir,
			logPath: join(jobDir, "output.log"),
			infoPath: join(jobDir, "info.json"),
			shell,
			shellArgs,
			startedAt: now,
			updatedAt: now,
			status: "running",
			creatorPid: process.pid,
		};

		await this.writeInfo(info);
		return jobFromInfo(info);
	}

	async readJob(id: string): Promise<BackgroundBashJob | undefined> {
		const job = await this.readJobWithoutNormalization(id);
		return job ? this.normalizeJob(job) : undefined;
	}

	async listJobs(status: BackgroundBashStatusFilter = "all"): Promise<BackgroundBashJob[]> {
		await mkdir(this.jobsDir, { recursive: true });
		const entries = await readdir(this.jobsDir, { withFileTypes: true });
		const jobs: BackgroundBashJob[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const job = await this.readJob(entry.name);
			if (!job) continue;
			if (status !== "all" && job.status.status !== status) continue;
			jobs.push(job);
		}

		jobs.sort((a, b) => b.meta.startedAt - a.meta.startedAt);
		return jobs;
	}

	async updatePid(id: string, pid: number): Promise<BackgroundBashJob | undefined> {
		const job = await this.readJobWithoutNormalization(id);
		if (!job) return undefined;

		const info: BackgroundBashInfo = {
			...infoFromJob(job),
			pid,
			status: isTerminalStatus(job.status.status) ? job.status.status : "running",
			updatedAt: Date.now(),
		};
		await this.writeInfo(info);
		return this.normalizeJob(jobFromInfo(info));
	}

	async markStatus(id: string, patch: Partial<BackgroundBashStatusFile> & { status: BackgroundBashStatus }): Promise<BackgroundBashJob | undefined> {
		const job = await this.readJobWithoutNormalization(id);
		if (!job) return undefined;
		const now = Date.now();
		const info: BackgroundBashInfo = {
			...infoFromJob(job),
			...patch,
			id,
			status: patch.status,
			startedAt: job.status.startedAt ?? job.meta.startedAt,
			updatedAt: now,
			completedAt: patch.completedAt ?? (isTerminalStatus(patch.status) ? now : job.status.completedAt),
		};
		await this.writeInfo(info);
		return jobFromInfo(info);
	}

	private async writeInfo(info: BackgroundBashInfo): Promise<void> {
		await writeJsonAtomic(info.infoPath, info);
	}

	private async readJobWithoutNormalization(id: string): Promise<BackgroundBashJob | undefined> {
		const jobDir = join(this.jobsDir, id);
		const info = await readJson<BackgroundBashInfo>(join(jobDir, "info.json"));
		if (info) return jobFromInfo(info);

		const legacyMeta = await readJson<LegacyMeta>(join(jobDir, "meta.json"));
		if (!legacyMeta) return undefined;
		const legacyStatus =
			(await readJson<BackgroundBashStatusFile>(join(jobDir, "status.json"))) ??
			({
				id: legacyMeta.id,
				status: "unknown",
				startedAt: legacyMeta.startedAt,
				updatedAt: Date.now(),
				pid: legacyMeta.pid,
				error: "Missing status.json",
			} satisfies BackgroundBashStatusFile);

		return jobFromInfo({
			id: legacyMeta.id,
			command: legacyMeta.command,
			cwd: legacyMeta.cwd,
			jobDir: legacyMeta.jobDir,
			logPath: legacyMeta.logPath,
			infoPath: join(jobDir, "info.json"),
			shell: legacyMeta.shell,
			shellArgs: legacyMeta.shellArgs,
			startedAt: legacyMeta.startedAt,
			updatedAt: legacyStatus.updatedAt,
			status: legacyStatus.status,
			pid: legacyStatus.pid ?? legacyMeta.pid,
			creatorPid: legacyMeta.creatorPid,
			exitCode: legacyStatus.exitCode,
			signal: legacyStatus.signal,
			completedAt: legacyStatus.completedAt,
			error: legacyStatus.error,
		});
	}

	private async normalizeJob(job: BackgroundBashJob): Promise<BackgroundBashJob> {
		if (job.status.status !== "running") return job;

		const pid = job.status.pid ?? job.meta.pid;
		const now = Date.now();
		if (!pid && now - job.status.startedAt <= PID_STARTUP_GRACE_MS) return job;
		if (pid && isProcessAlive(pid)) return job;

		const info: BackgroundBashInfo = {
			...infoFromJob(job),
			pid,
			status: "unknown",
			completedAt: now,
			updatedAt: now,
			error: pid
				? "Process is no longer alive and no terminal status was written."
				: "No process id was recorded and no terminal status was written.",
		};
		await this.writeInfo(info);
		return jobFromInfo(info);
	}
}
