import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveTemplate, resolveValue } from "../runner/references.js";
import { WorkflowCancelledError, WorkflowRuntimeError } from "../runner/types.js";
import type { HandlerContext, HandlerResult } from "./types.js";

export async function runProcessStep(context: HandlerContext): Promise<HandlerResult> {
  const definition = context.step.definition;
  if (definition.type !== "run" && definition.type !== "shell") {
    throw new Error("process handler received another step type");
  }

  const stepCwd = definition.cwd === undefined
    ? context.workflowCwd
    : await canonicalDescendant(
      context.workflowCwd,
      requireString(resolveTemplate(definition.cwd, context.values, `${context.path}.cwd`), `${context.path}.cwd`),
      "directory",
      `${context.path}.cwd`,
    );
  const env = resolveStringRecord(definition.env ?? {}, context, `${context.path}.env`);
  const command = requireString(resolveTemplate(definition.command, context.values, `${context.path}.command`), `${context.path}.command`);
  const retry = definition.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  const started = Date.now();
  let last: HandlerResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (context.signal.aborted) throw new WorkflowCancelledError("Workflow process cancelled", context.path);
    const elapsed = Date.now() - started;
    const remaining = context.timeoutMs - elapsed;
    if (remaining <= 0) {
      return {
        output: last?.output ?? null,
        attempts: attempt - 1,
        error: { code: "timeout", message: `Process timed out at ${context.path}` },
      };
    }

    let executable = command;
    let args: string[];
    let verifiedFiles: string[] | undefined;
    if (context.step.script) {
      const fileValue = requireString(
        resolveTemplate(context.step.script.file.value, context.values, `${context.path}.file`),
        `${context.path}.file`,
      );
      const scriptFile = await canonicalDescendant(stepCwd, fileValue, "file", `${context.path}.file`);
      executable = requireString(
        resolveTemplate(context.step.script.interpreter, context.values, `${context.path}.interpreter`),
        `${context.path}.interpreter`,
      );
      args = [scriptFile, ...resolveStringArray(definition.type === "run" ? definition.args?.slice(1) ?? [] : [], context, `${context.path}.args`)];
      verifiedFiles = [scriptFile];
    } else if (definition.type === "shell") {
      const shell = platformShell(command);
      executable = shell.command;
      args = shell.args;
    } else {
      args = resolveStringArray(definition.args ?? [], context, `${context.path}.args`);
    }

    try {
      const result = await context.spawnProcess({
        command: executable,
        args,
        cwd: stepCwd,
        expectedCwd: stepCwd,
        verifiedFiles,
        env,
        signal: context.signal,
        timeoutMs: remaining,
        maxStreamBytes: context.maxStreamBytes,
        killGraceMs: context.killGraceMs,
      });
      const output = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        killed: result.killed,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      };
      const error = result.timedOut
        ? { code: "timeout", message: `Process timed out at ${context.path}` }
        : result.exitCode === 0
          ? undefined
          : { code: "process-exit", message: `Process exited with code ${result.exitCode ?? "signal"}` };
      last = { output, attempts: attempt, error };
      if (!error) return last;
    } catch (error) {
      if (context.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new WorkflowCancelledError("Workflow process cancelled", context.path);
      }
      last = {
        output: null,
        attempts: attempt,
        error: {
          code: error instanceof WorkflowRuntimeError ? error.code : "process-spawn",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    if (attempt < maxAttempts) await abortableDelay(retry?.delayMs ?? 0, context.signal, context.path);
  }
  return last ?? { output: null, attempts: 0, error: { code: "process-failed", message: "Process failed" } };
}

export async function resolveWorkflowCwd(
  invocationRoot: string,
  cwd: string,
  context: HandlerContext["values"],
  path: string,
): Promise<string> {
  const value = requireString(resolveTemplate(cwd, context, path), path);
  return canonicalDescendant(invocationRoot, value, "directory", path);
}

async function canonicalDescendant(
  base: string,
  value: string,
  kind: "directory" | "file",
  path: string,
): Promise<string> {
  if (isAbsolute(value)) throw new WorkflowRuntimeError("path-escape", `Path at ${path} must be relative`, path);
  const canonicalBase = await realpath(base);
  const unresolved = resolve(canonicalBase, value);
  const unresolvedStats = await lstat(unresolved).catch((error: unknown) => {
    throw new WorkflowRuntimeError("path-invalid", `Path at ${path} is unavailable`, path, { cause: error });
  });
  if (unresolvedStats.isSymbolicLink() || (kind === "directory" ? !unresolvedStats.isDirectory() : !unresolvedStats.isFile())) {
    throw new WorkflowRuntimeError("path-type", `Path at ${path} must be a non-symlink ${kind}`, path);
  }
  const candidate = await realpath(unresolved).catch((error: unknown) => {
    throw new WorkflowRuntimeError("path-invalid", `Path at ${path} is unavailable`, path, { cause: error });
  });
  const child = relative(canonicalBase, candidate);
  if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new WorkflowRuntimeError("path-escape", `Canonical path at ${path} escapes its base`, path);
  }
  return candidate;
}

function resolveStringRecord(values: Record<string, string>, context: HandlerContext, path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    requireString(resolveTemplate(value, context.values, `${path}.${key}`), `${path}.${key}`),
  ]));
}

function resolveStringArray(values: string[], context: HandlerContext, path: string): string[] {
  const resolved = resolveValue(values, context.values, path);
  if (!Array.isArray(resolved) || !resolved.every((value) => typeof value === "string")) {
    throw new WorkflowRuntimeError("process-argv", `Arguments at ${path} must resolve to strings`, path);
  }
  return resolved;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new WorkflowRuntimeError("value-type", `Value at ${path} must resolve to a string`, path);
  return value;
}

function platformShell(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { command: "/bin/sh", args: ["-lc", command] };
}

async function abortableDelay(ms: number, signal: AbortSignal, path: string): Promise<void> {
  if (ms <= 0) return;
  if (signal.aborted) throw new WorkflowCancelledError("Workflow process cancelled", path);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WorkflowCancelledError("Workflow process cancelled", path));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
