import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export interface GitUpstream {
	name?: string;
	ahead: number;
	behind: number;
}

export interface GitDetails {
	branch?: string;
	sha?: string;
	dirty: boolean;
	changedFiles: number;
	operation?: string;
	tag?: string;
	timeSinceCommit?: string;
	stashCount: number;
	upstream?: GitUpstream;
	repoName?: string;
	refreshedAt: number;
}

const GIT_TIMEOUT_MS = 1_200;

export class GitCache {
	private details: GitDetails | undefined;
	private inFlight: Promise<void> | undefined;
	private disposed = false;

	constructor(private readonly cwd: string) {}

	get(): GitDetails | undefined {
		return this.details;
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.refreshNow().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	dispose(): void {
		this.disposed = true;
	}

	private async refreshNow(): Promise<void> {
		const root = await runGit(["rev-parse", "--show-toplevel"], this.cwd);
		if (this.disposed) return;
		if (!root) {
			this.details = undefined;
			return;
		}

		const [sha, status, tag, commitTimestamp, stashList, gitDir] = await Promise.all([
			runGit(["rev-parse", "--short", "HEAD"], this.cwd),
			runGit(["status", "--porcelain=v1", "--branch"], this.cwd),
			runGit(["describe", "--tags", "--exact-match"], this.cwd),
			runGit(["log", "-1", "--format=%ct"], this.cwd),
			runGit(["stash", "list", "--format=%gd"], this.cwd),
			runGit(["rev-parse", "--git-dir"], this.cwd),
		]);
		if (this.disposed) return;

		const parsedStatus = parseStatus(status);
		const operation = gitDir ? detectOperation(resolveGitPath(this.cwd, gitDir)) : undefined;
		this.details = {
			branch: parsedStatus.branch,
			sha,
			dirty: parsedStatus.changedFiles > 0,
			changedFiles: parsedStatus.changedFiles,
			operation,
			tag,
			timeSinceCommit: commitTimestamp ? formatAge(Number.parseInt(commitTimestamp, 10)) : undefined,
			stashCount: stashList ? stashList.split("\n").filter(Boolean).length : 0,
			upstream: parsedStatus.upstream,
			repoName: basename(root),
			refreshedAt: Date.now(),
		};
	}
}

function runGit(args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;

		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		timer = setTimeout(() => {
			finish(undefined);
			if (child.exitCode === null) child.kill("SIGKILL");
		}, GIT_TIMEOUT_MS);

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < 65_536) stdout += chunk;
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? stdout.trim() || undefined : undefined));
	});
}

function parseStatus(status: string | undefined): {
	branch?: string;
	changedFiles: number;
	upstream?: GitUpstream;
} {
	if (!status) return { changedFiles: 0 };

	const lines = status.split("\n").filter(Boolean);
	const header = lines.find((line) => line.startsWith("## "));
	const changedFiles = lines.filter((line) => !line.startsWith("## ")).length;
	if (!header) return { changedFiles };

	const branchPart = header.slice(3);
	const upstream: GitUpstream | undefined = parseUpstream(branchPart);
	let branch = branchPart.split("...")[0]?.split(" ")[0]?.trim();
	if (branch === "HEAD") branch = "detached";

	return { branch: branch || undefined, changedFiles, upstream };
}

function parseUpstream(branchPart: string): GitUpstream | undefined {
	const upstreamMatch = branchPart.match(/\.\.\.([^\s\[]+)/);
	const aheadMatch = branchPart.match(/ahead (\d+)/);
	const behindMatch = branchPart.match(/behind (\d+)/);
	if (!upstreamMatch && !aheadMatch && !behindMatch) return undefined;
	return {
		name: upstreamMatch?.[1],
		ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
		behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
	};
}

function resolveGitPath(cwd: string, gitDir: string): string {
	return isAbsolute(gitDir) ? gitDir : join(cwd, gitDir);
}

function detectOperation(gitDir: string): string | undefined {
	if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
	if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
	if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
	if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
	return undefined;
}

function formatAge(commitUnixSeconds: number): string | undefined {
	if (!Number.isFinite(commitUnixSeconds)) return undefined;
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - commitUnixSeconds);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;
	return `${Math.floor(months / 12)}y`;
}
