import { execFile } from "node:child_process";
import { truncateTail, type TruncationResult } from "@mariozechner/pi-coding-agent";

const DETECT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

type ShowboatCommand = "init" | "note" | "exec" | "image" | "pop" | "verify" | "extract";

export interface ShowboatInvocation {
	cmd: string;
	args: string[];
	display: string;
}

export interface TruncatedOutput extends TruncationResult {}

export interface ShowboatAttempt {
	backend: ShowboatInvocation;
	exitCode: number | null;
	stdout: TruncatedOutput;
	stderr: TruncatedOutput;
	error?: string;
}

export interface ShowboatStatus {
	available: boolean;
	backend: ShowboatInvocation | null;
	attempts: ShowboatAttempt[];
}

export interface ShowboatRunOptions {
	cwd: string;
	workdir?: string;
	signal?: AbortSignal;
}

export interface ShowboatRunResult {
	available: boolean;
	backend: ShowboatInvocation | null;
	command: string[];
	exitCode: number | null;
	stdout: TruncatedOutput;
	stderr: TruncatedOutput;
	attempts: ShowboatAttempt[];
	error?: string;
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

let cachedStatus: Promise<ShowboatStatus> | undefined;

export async function resolveShowboat(): Promise<ShowboatStatus> {
	cachedStatus ??= detectShowboat();
	return cachedStatus;
}

export async function init(file: string, title: string, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	return runShowboat("init", [file, title], options);
}

export async function note(file: string, text: string, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	return runShowboat("note", [file, text], options);
}

export async function exec(file: string, lang: string, code: string, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	return runShowboat("exec", [file, lang, code], options);
}

export async function image(file: string, input: string, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	return runShowboat("image", [file, input], options);
}

export async function pop(file: string, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	return runShowboat("pop", [file], options);
}

export async function verify(file: string, output: string | undefined, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	const args = output ? [file, "--output", output] : [file];
	return runShowboat("verify", args, options);
}

export async function extract(file: string, filename: string | undefined, options: ShowboatRunOptions): Promise<ShowboatRunResult> {
	const args = filename ? [file, "--filename", filename] : [file];
	return runShowboat("extract", args, options);
}

async function detectShowboat(): Promise<ShowboatStatus> {
	const candidates: ShowboatInvocation[] = [
		{ cmd: "showboat", args: [], display: "showboat" },
		{ cmd: "uvx", args: ["showboat"], display: "uvx showboat" },
	];
	const attempts: ShowboatAttempt[] = [];

	for (const backend of candidates) {
		const result = await execFileCapture(backend.cmd, [...backend.args, "--help"], {
			cwd: process.cwd(),
			timeoutMs: DETECT_TIMEOUT_MS,
		});
		const attempt: ShowboatAttempt = {
			backend,
			exitCode: result.exitCode,
			stdout: truncateOutput(result.stdout),
			stderr: truncateOutput(result.stderr),
			error: result.error,
		};
		attempts.push(attempt);

		if (result.exitCode === 0) {
			return { available: true, backend, attempts };
		}
	}

	return { available: false, backend: null, attempts };
}

async function runShowboat(
	command: ShowboatCommand,
	commandArgs: string[],
	options: ShowboatRunOptions,
): Promise<ShowboatRunResult> {
	const status = await resolveShowboat();

	if (!status.available || !status.backend) {
		return {
			available: false,
			backend: null,
			command: [],
			exitCode: null,
			stdout: truncateOutput(""),
			stderr: truncateOutput("Showboat CLI unavailable. Install `showboat` or `uv`, then try again."),
			attempts: status.attempts,
			error: "Showboat CLI unavailable",
		};
	}

	const args = [...status.backend.args];
	if (options.workdir) args.push("--workdir", options.workdir);
	args.push(command, ...commandArgs);

	const result = await execFileCapture(status.backend.cmd, args, {
		cwd: options.cwd,
		signal: options.signal,
		timeoutMs: COMMAND_TIMEOUT_MS,
	});

	return {
		available: true,
		backend: status.backend,
		command: [status.backend.cmd, ...args],
		exitCode: result.exitCode,
		stdout: truncateOutput(result.stdout),
		stderr: truncateOutput(result.stderr),
		attempts: status.attempts,
		error: result.error,
	};
}

function execFileCapture(
	cmd: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{
				cwd: options.cwd,
				signal: options.signal,
				timeout: options.timeoutMs,
				maxBuffer: MAX_BUFFER_BYTES,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				const err = error as (Error & { code?: number | string; signal?: string }) | null;
				resolve({
					exitCode: exitCodeFromError(err),
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					error: err?.message,
				});
			},
		);
	});
}

function exitCodeFromError(error: (Error & { code?: number | string; signal?: string }) | null): number | null {
	if (!error) return 0;
	if (typeof error.code === "number") return error.code;
	if (typeof error.code === "string" && /^-?\d+$/.test(error.code)) return Number(error.code);
	return null;
}

function truncateOutput(output: string): TruncatedOutput {
	return truncateTail(output);
}
