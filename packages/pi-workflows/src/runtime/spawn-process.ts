import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";

export const DEFAULT_PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_PROCESS_STREAM_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_KILL_GRACE_MS = 2_000;
const FORCED_PROCESS_EXIT_TIMEOUT_MS = 5_000;

const INHERITED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface SpawnProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  expectedCwd?: string;
  verifiedFiles?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStreamBytes?: number;
  killGraceMs?: number;
}

export interface SpawnProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export class ProcessSpawnError extends Error {
  readonly code = "process-spawn";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessSpawnError";
  }
}

export function operationalEnvironment(explicit: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...explicit };
}

export async function spawnProcess(options: SpawnProcessOptions): Promise<SpawnProcessResult> {
  if (options.signal?.aborted) throw abortError();

  await verifyDispatchPath(options.cwd, "directory", options.expectedCwd);
  for (const file of options.verifiedFiles ?? []) await verifyDispatchPath(file, "file", file);
  if (options.signal?.aborted) throw abortError();

  const stdout = new BoundedOutput(options.maxStreamBytes ?? DEFAULT_PROCESS_STREAM_BYTES);
  const stderr = new BoundedOutput(options.maxStreamBytes ?? DEFAULT_PROCESS_STREAM_BYTES);
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: operationalEnvironment(options.env),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  let killed = false;
  let terminationReason: "timeout" | "abort" | undefined;
  let terminating: Promise<void> | undefined;
  const terminate = (reason: "timeout" | "abort"): Promise<void> => {
    terminationReason ??= reason;
    killed = true;
    if (!terminating) {
      terminating = terminateProcessTree(child, options.killGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS);
      void terminating.catch(() => undefined);
    }
    return terminating;
  };

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const timer = setTimeout(() => void terminate("timeout"), timeoutMs);
  timer.unref();
  const onAbort = () => void terminate("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", (error) => reject(new ProcessSpawnError(`Failed to start process: ${error.message}`, { cause: error })));
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await terminating;
    if (terminationReason === "abort") throw abortError();
    return {
      ...result,
      stdout: stdout.text(),
      stderr: stderr.text(),
      killed,
      timedOut: terminationReason === "timeout",
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await runTaskkill(child.pid, false);
    if (await waitForExit(child, graceMs)) return;
    await runTaskkill(child.pid, true);
    await waitForExit(child, graceMs);
    return;
  }

  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  signalProcessGroup(child.pid, "SIGKILL");
  if (!await waitForLiveProcessGroupExit(child.pid, FORCED_PROCESS_EXIT_TIMEOUT_MS)) {
    throw new ProcessSpawnError("Process group remained live after SIGKILL");
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    const args = ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
    const killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true, shell: false });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, ms);
    timer.unref();
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

async function waitForProcessGroupExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return !processGroupExists(pid);
}

async function waitForLiveProcessGroupExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processGroupHasLiveMembers(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  return !processGroupHasLiveMembers(pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") return false;
    throw error;
  }
}

function processGroupHasLiveMembers(pid: number): boolean {
  const result = spawnSync("ps", ["-eo", "pgid=,stat="], {
    encoding: "utf8",
    env: operationalEnvironment(),
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return processGroupExists(pid);
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/, 2);
    return Number(group) === pid && state !== undefined && !state.startsWith("Z");
  });
}

async function verifyDispatchPath(
  path: string,
  kind: "directory" | "file",
  expectedCanonical?: string,
): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || (kind === "directory" ? !stats.isDirectory() : !stats.isFile())) {
      throw new ProcessSpawnError(`Process ${kind} changed before dispatch`);
    }
    const canonical = await realpath(path);
    if (expectedCanonical !== undefined && canonical !== expectedCanonical) {
      throw new ProcessSpawnError(`Process ${kind} changed before dispatch`);
    }
  } catch (error) {
    if (error instanceof ProcessSpawnError) throw error;
    throw new ProcessSpawnError(`Process ${kind} is unavailable at dispatch`, { cause: error });
  }
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    const kept = chunk.subarray(0, remaining);
    this.chunks.push(kept);
    this.size += kept.byteLength;
    if (kept.byteLength < chunk.byteLength) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }
}

function abortError(): Error {
  return new DOMException("Workflow process cancelled", "AbortError");
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
