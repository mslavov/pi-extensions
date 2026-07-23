#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkflowChildSession,
  type WorkflowChildSessionFactory,
} from "./runtime/child-session.js";
import {
  formatList,
  formatValidation,
  listWorkflows,
  validateWorkflows,
} from "./commands/catalog.js";
import { formatRunResult, runWorkflowCommand } from "./commands/run.js";
import { WorkflowRuntimeError } from "./runner/index.js";

interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const usage = `Usage:
  pi-workflows list [--cwd <path>] [--agent-dir <path>] [--json]
  pi-workflows validate [workflow-id] [--cwd <path>] [--agent-dir <path>] [--json]
  pi-workflows run <workflow-id> [--cwd <path>] [--agent-dir <path>] [--input key=value]... [--approve qualified.path]... [--json]
  pi-workflows inspect [--cwd <path>] [--agent-dir <path>]

Workflow execution is explicit and sequential.
`;

interface CliRuntime {
  signal?: AbortSignal;
}

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  createChildSession: WorkflowChildSessionFactory = createWorkflowChildSession,
  runtime: CliRuntime = {},
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.stdout(usage);
    return 0;
  }

  const [command, ...args] = argv;
  if (command !== "inspect" && command !== "list" && command !== "validate" && command !== "run") {
    io.stderr(`Unknown command: ${command}\n${usage}`);
    return 2;
  }

  let cwd = process.cwd();
  let agentDir: string | undefined;
  let json = false;
  const runJsonRequested = command === "run" && args.includes("--json");
  const positional: string[] = [];
  const inputs: string[] = [];
  const approvals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if ((arg === "--cwd" || arg === "--agent-dir") && value && !value.startsWith("--")) {
      if (arg === "--cwd") cwd = resolve(value);
      else agentDir = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--json" && command !== "inspect") {
      json = true;
      continue;
    }
    if ((arg === "--input" || arg === "--approve") && value && !value.startsWith("--") && command === "run") {
      (arg === "--input" ? inputs : approvals).push(value);
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && (command === "validate" || command === "run")) {
      positional.push(arg);
      continue;
    }
    io.stderr(`Unknown or incomplete option: ${arg}\n`);
    if (command === "run" && runJsonRequested) writeRunError(io, positional[0], "usage", `Unknown or incomplete option: ${arg}`);
    return 2;
  }

  if ((command === "validate" && positional.length > 1) || (command === "run" && positional.length !== 1)) {
    const message = command === "run" ? "run requires exactly one workflow id" : "validate accepts at most one workflow id";
    io.stderr(`${message}\n`);
    if (command === "run" && runJsonRequested) writeRunError(io, positional[0], "usage", message);
    return 2;
  }

  if (command === "list") {
    const result = await listWorkflows({ cwd, agentDir });
    io.stdout(json ? `${JSON.stringify(result)}\n` : formatList(result));
    return 0;
  }

  if (command === "validate") {
    const result = await validateWorkflows(positional[0], { cwd, agentDir });
    io.stdout(json ? `${JSON.stringify(result)}\n` : formatValidation(result));
    return result.valid ? 0 : 2;
  }

  if (command === "run") {
    try {
      const result = await runWorkflowCommand(positional[0], {
        cwd,
        agentDir,
        inputs,
        approvals,
        signal: runtime.signal,
        createChildSession,
        onProgress: (path, status) => io.stderr(`${path}\t${status}\n`),
      });
      if (result.failure && isRunSetupCode(result.failure.code)) {
        io.stderr(`${result.failure.message}\n`);
        if (runJsonRequested) writeRunError(io, positional[0], result.failure.code, result.failure.message);
        return 2;
      }
      io.stdout(json ? `${JSON.stringify(result)}\n` : formatRunResult(result));
      if (result.status === "cancelled") return 130;
      if (result.failure?.code === "approval-denied") return 3;
      return result.ok ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`${message}\n`);
      const code = runErrorExitCode(error, runtime.signal);
      if (runJsonRequested) {
        writeRunError(
          io,
          positional[0],
          runtime.signal?.aborted ? "cancelled" : error instanceof WorkflowRuntimeError ? error.code : "runtime",
          message,
          code === 130,
        );
      }
      return code;
    }
  }

  const child = await createChildSession({ cwd, agentDir });
  try {
    io.stdout(`${JSON.stringify(child.inspect())}\n`);
    return 0;
  } finally {
    child.dispose();
  }
}

function runErrorExitCode(error: unknown, signal: AbortSignal | undefined): number {
  if (signal?.aborted) return 130;
  if (error instanceof WorkflowRuntimeError && isRunSetupCode(error.code)) return 2;
  return 1;
}

function isRunSetupCode(code: string): boolean {
  return code.startsWith("workflow-") || code.startsWith("input-") ||
    code === "approval-path" || code === "cwd-invalid" || code === "result-limit" ||
    code === "agent-model-unavailable" || code === "agent-provider-config";
}

function writeRunError(
  io: CliIo,
  workflowId: string | undefined,
  code: string,
  message: string,
  cancelled = false,
): void {
  io.stdout(`${JSON.stringify({
    command: "run",
    version: 1,
    workflowId: workflowId ?? null,
    status: cancelled ? "cancelled" : "error",
    ok: false,
    error: { code, message },
  })}\n`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  runCli(process.argv.slice(2), defaultIo, createWorkflowChildSession, { signal: controller.signal }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      defaultIo.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  ).finally(() => {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  });
}
