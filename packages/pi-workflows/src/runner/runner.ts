import { realpath } from "node:fs/promises";
import type { CompiledStep, CompiledWorkflow, WorkflowValue } from "../types.js";
import { runAgentStep } from "../handlers/agent.js";
import { runApprovalStep } from "../handlers/approval.js";
import { runProcessStep, resolveWorkflowCwd } from "../handlers/process.js";
import { runSetStep } from "../handlers/set.js";
import type { HandlerContext, HandlerResult } from "../handlers/types.js";
import { runNestedWorkflowStep } from "../handlers/workflow.js";
import {
  DEFAULT_PROCESS_KILL_GRACE_MS,
  DEFAULT_PROCESS_STREAM_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
  spawnProcess,
} from "../runtime/spawn-process.js";
import {
  DEFAULT_AGENT_OUTPUT_BYTES,
  DEFAULT_AGENT_TIMEOUT_MS,
  WorkflowRuntime,
} from "../runtime/workflow-runtime.js";
import { normalizeInputs } from "./inputs.js";
import { resolveCondition, resolveValue, type RuntimeValues } from "./references.js";
import {
  WorkflowCancelledError,
  WorkflowRuntimeError,
  type StepError,
  type StepResult,
  type StepStatus,
  type StepSummary,
  type WorkflowRunResult,
  type WorkflowRunnerOptions,
} from "./types.js";

export const DEFAULT_OUTPUT_VALUE_BYTES = 16 * 1024;
export const DEFAULT_TERMINAL_RESULT_BYTES = 64 * 1024;
export const MIN_TERMINAL_RESULT_BYTES = 160;

interface WorkflowExecution {
  status: "succeeded" | "failed" | "cancelled";
  outputs: Record<string, WorkflowValue>;
  failure?: StepError & { path?: string };
}

interface RunnerState {
  options: Required<Pick<WorkflowRunnerOptions,
    "invocationCwd" | "plans" | "spawnProcess" | "decideApproval" |
    "maxStreamBytes" | "killGraceMs" | "processTimeoutMs" |
    "agentTimeoutMs" | "maxAgentOutputBytes" | "maxOutputValueBytes" | "maxResultBytes"
  >> & Pick<WorkflowRunnerOptions, "signal" | "onTransition" | "agentDir" | "createChildSession">;
  invocationRoot: string;
  runtime: WorkflowRuntime;
  allSteps: StepResult[];
}

export async function runWorkflow(plan: CompiledWorkflow, options: WorkflowRunnerOptions): Promise<WorkflowRunResult> {
  if (options.maxResultBytes !== undefined && options.maxResultBytes < MIN_TERMINAL_RESULT_BYTES) {
    throw new WorkflowRuntimeError(
      "result-limit",
      `maxResultBytes must be at least ${MIN_TERMINAL_RESULT_BYTES}`,
    );
  }
  const started = Date.now();
  const invocationRoot = await realpath(options.invocationCwd).catch((error: unknown) => {
    throw new WorkflowRuntimeError("cwd-invalid", "Invocation cwd is unavailable", "cwd", { cause: error });
  });
  const configuredOptions: RunnerState["options"] = {
    invocationCwd: options.invocationCwd,
    plans: options.plans,
    signal: options.signal,
    onTransition: options.onTransition,
    spawnProcess: options.spawnProcess ?? spawnProcess,
    decideApproval: options.decideApproval ?? (async () => "denied"),
    maxStreamBytes: options.maxStreamBytes ?? DEFAULT_PROCESS_STREAM_BYTES,
    killGraceMs: options.killGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS,
    processTimeoutMs: options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
    agentTimeoutMs: options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    agentDir: options.agentDir,
    createChildSession: options.createChildSession,
    maxAgentOutputBytes: options.maxAgentOutputBytes ?? DEFAULT_AGENT_OUTPUT_BYTES,
    maxOutputValueBytes: options.maxOutputValueBytes ?? DEFAULT_OUTPUT_VALUE_BYTES,
    maxResultBytes: options.maxResultBytes ?? DEFAULT_TERMINAL_RESULT_BYTES,
  };
  const state: RunnerState = {
    options: configuredOptions,
    invocationRoot,
    runtime: new WorkflowRuntime({
      cwd: invocationRoot,
      agentDir: configuredOptions.agentDir,
      createChildSession: configuredOptions.createChildSession,
      maxAgentOutputBytes: configuredOptions.maxAgentOutputBytes,
    }),
    allSteps: [],
  };

  let execution: WorkflowExecution;
  try {
    execution = await executeWorkflow(state, plan, options.inputs ?? {}, "", options.signal);
  } catch (error) {
    const runtime = runtimeError(error);
    execution = {
      status: runtime instanceof WorkflowCancelledError || options.signal?.aborted ? "cancelled" : "failed",
      outputs: {},
      failure: { code: runtime.code, message: runtime.message, path: runtime.path },
    };
  }
  if (execution.status === "cancelled") {
    await state.runtime.abort().catch(() => undefined);
  }
  try {
    await state.runtime.dispose();
  } catch (error) {
    const runtime = runtimeError(error);
    execution = {
      status: "failed",
      outputs: {},
      failure: { code: "agent-dispose", message: runtime.message, path: runtime.path },
    };
  }

  return capTerminalResult({
    command: "run",
    version: 1,
    workflowId: plan.id,
    status: execution.status,
    ok: execution.status === "succeeded",
    elapsedMs: Math.max(0, Date.now() - started),
    steps: state.allSteps.map(summary),
    outputs: execution.outputs,
    truncatedOutputs: [],
    resultTruncated: false,
    failure: execution.failure,
  }, state.options.maxOutputValueBytes, state.options.maxResultBytes);
}

async function executeWorkflow(
  state: RunnerState,
  plan: CompiledWorkflow,
  suppliedInputs: Record<string, unknown>,
  prefix: string,
  parentSignal?: AbortSignal,
): Promise<WorkflowExecution> {
  if (parentSignal?.aborted) return cancelledExecution(prefix || undefined);
  const inputs = normalizeInputs(plan.definition, suppliedInputs, prefix ? `${prefix}.inputs` : "inputs");
  const values: RuntimeValues = { inputs, vars: {}, steps: new Map() };
  const workflowCwd = await resolveWorkflowCwd(
    state.invocationRoot,
    plan.cwd.value,
    values,
    prefix ? `${prefix}.cwd` : "cwd",
  );
  let failure: (StepError & { path?: string }) | undefined;
  let cancelled = false;

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const path = prefix ? `${prefix}.${step.id}` : step.id;
    const result = createPending(step, path);
    state.allSteps.push(result);
    values.steps.set(step.id, result);

    if (parentSignal?.aborted) {
      transition(state, result, "cancelled", { code: "cancelled", message: "Workflow cancelled" });
      failure = { code: "cancelled", message: "Workflow cancelled", path };
      cancelled = true;
      markRemainingSkipped(state, plan, index + 1, prefix, values);
      break;
    }

    let shouldRun: boolean;
    try {
      shouldRun = resolveCondition(step.definition.if, values, `${path}.if`);
    } catch (error) {
      const runtime = runtimeError(error);
      transition(state, result, "failed", toStepError(runtime));
      failure = { ...toStepError(runtime), path };
      markRemainingSkipped(state, plan, index + 1, prefix, values);
      break;
    }
    if (!shouldRun) {
      transition(state, result, "skipped");
      continue;
    }

    transition(state, result, "running");
    const timeoutMs = timeoutForStep(step, state.options.processTimeoutMs, state.options.agentTimeoutMs);
    const deadline = deadlineSignal(parentSignal, timeoutMs);
    if (step.definition.type === "approval") transition(state, result, "waiting");

    try {
      const handled = await executeStep(state, step, path, values, workflowCwd, deadline.signal, timeoutMs);
      result.attempts = handled.attempts ?? 1;
      result.output = handled.output;
      const termination = deadline.reason();
      if (termination === "timeout") {
        const error = { code: "timeout", message: `Step timed out at ${path}` };
        transition(state, result, "failed", error);
        failure ??= { ...error, path };
        if (!continuesAfterError(step.definition)) {
          markRemainingSkipped(state, plan, index + 1, prefix, values);
          break;
        }
        continue;
      }
      if (termination === "parent") {
        const error = { code: "cancelled", message: "Workflow cancelled" };
        transition(state, result, "cancelled", error);
        failure = { ...error, path };
        cancelled = true;
        markRemainingSkipped(state, plan, index + 1, prefix, values);
        break;
      }
      if (handled.cancelled) {
        transition(state, result, "cancelled", toStepError(handled.cancelled));
        failure = { ...toStepError(handled.cancelled), path: handled.cancelled.path ?? path };
        cancelled = true;
        markRemainingSkipped(state, plan, index + 1, prefix, values);
        break;
      }
      if (handled.error) {
        transition(state, result, "failed", handled.error);
        failure ??= { ...handled.error, path: handled.errorPath ?? path };
        if (!continuesAfterError(step.definition)) {
          markRemainingSkipped(state, plan, index + 1, prefix, values);
          break;
        }
      } else {
        transition(state, result, "succeeded");
      }
    } catch (error) {
      const termination = deadline.reason();
      const runtime = termination === "timeout"
        ? new WorkflowRuntimeError("timeout", `Step timed out at ${path}`, path)
        : termination === "parent"
          ? new WorkflowCancelledError("Workflow cancelled", path)
          : runtimeError(error, path);
      const isCancelled = runtime instanceof WorkflowCancelledError;
      transition(state, result, isCancelled ? "cancelled" : "failed", toStepError(runtime));
      if (isCancelled) failure = { ...toStepError(runtime), path };
      else failure ??= { ...toStepError(runtime), path };
      if (isCancelled) cancelled = true;
      if (isCancelled || !continuesAfterError(step.definition)) {
        markRemainingSkipped(state, plan, index + 1, prefix, values);
        break;
      }
    } finally {
      deadline.cleanup();
    }
  }

  let outputs: Record<string, WorkflowValue> = {};
  try {
    const resolved = resolveValue(plan.definition.outputs ?? {}, values, prefix ? `${prefix}.outputs` : "outputs");
    if (resolved !== null && !Array.isArray(resolved) && typeof resolved === "object") outputs = resolved;
  } catch (error) {
    const runtime = runtimeError(error);
    failure ??= { ...toStepError(runtime), path: runtime.path };
  }

  return {
    status: cancelled ? "cancelled" : failure ? "failed" : "succeeded",
    outputs,
    failure,
  };
}

async function executeStep(
  state: RunnerState,
  step: CompiledStep,
  path: string,
  values: RuntimeValues,
  workflowCwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<HandlerResult> {
  const context: HandlerContext = {
    step,
    path,
    values,
    invocationRoot: state.invocationRoot,
    workflowCwd,
    signal,
    timeoutMs,
    runtime: state.runtime,
    maxStreamBytes: state.options.maxStreamBytes,
    killGraceMs: state.options.killGraceMs,
    decideApproval: state.options.decideApproval,
    spawnProcess: state.options.spawnProcess,
    plans: state.options.plans,
    runNested: async (plan, inputs, nestedPath, nestedSignal) => {
      const nested = await executeWorkflow(state, plan, inputs, nestedPath, nestedSignal);
      if (nested.status === "cancelled") {
        return {
          output: nested.outputs,
          cancelled: new WorkflowCancelledError(nested.failure?.message, nested.failure?.path),
        };
      }
      return {
        output: nested.outputs,
        error: nested.status === "failed"
          ? { code: nested.failure?.code ?? "workflow-failed", message: nested.failure?.message ?? `Nested workflow "${plan.id}" failed` }
          : undefined,
        errorPath: nested.failure?.path,
      };
    },
  };

  switch (step.sourceKind) {
    case "set": return runSetStep(context);
    case "approval": return runApprovalStep(context);
    case "run":
    case "shell":
    case "script": return runProcessStep(context);
    case "workflow": return runNestedWorkflowStep(context);
    case "agent": return runAgentStep(context);
  }
}

function createPending(step: CompiledStep, path: string): StepResult {
  return { path, id: step.id, type: step.sourceKind, status: "pending", ok: false, output: null, attempts: 0 };
}

function transition(state: RunnerState, step: StepResult, status: StepStatus, error?: StepError): void {
  const allowed: Record<StepStatus, StepStatus[]> = {
    pending: ["running", "skipped", "cancelled"],
    running: ["waiting", "succeeded", "failed", "cancelled"],
    waiting: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    skipped: [],
    cancelled: [],
  };
  if (!allowed[step.status].includes(status)) {
    throw new Error(`Invalid workflow transition ${step.status} -> ${status} at ${step.path}`);
  }
  step.status = status;
  step.ok = status === "succeeded";
  if (error) step.error = error;
  state.options.onTransition?.(summary(step));
}

function markRemainingSkipped(
  state: RunnerState,
  plan: CompiledWorkflow,
  start: number,
  prefix: string,
  values: RuntimeValues,
): void {
  for (const step of plan.steps.slice(start)) {
    const path = prefix ? `${prefix}.${step.id}` : step.id;
    const result = createPending(step, path);
    state.allSteps.push(result);
    values.steps.set(step.id, result);
    transition(state, result, "skipped");
  }
}

function timeoutForStep(step: CompiledStep, processDefault: number, agentDefault: number): number {
  if ("timeoutMs" in step.definition && step.definition.timeoutMs !== undefined) return step.definition.timeoutMs;
  if (step.sourceKind === "agent") return agentDefault;
  if (step.sourceKind === "run" || step.sourceKind === "shell" || step.sourceKind === "script") return processDefault;
  return Number.MAX_SAFE_INTEGER;
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let termination: "parent" | "timeout" | undefined;
  const terminate = (reason: "parent" | "timeout", detail?: unknown) => {
    if (termination !== undefined) return;
    termination = reason;
    controller.abort(detail);
  };
  const onAbort = () => terminate("parent", parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = termination === undefined && timeoutMs < Number.MAX_SAFE_INTEGER
    ? setTimeout(() => {
      terminate("timeout", new Error("timeout"));
    }, timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    reason: () => termination,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function continuesAfterError(step: CompiledStep["definition"]): boolean {
  return "continueOnError" in step && step.continueOnError === true;
}

function runtimeError(error: unknown, path?: string): WorkflowRuntimeError {
  if (error instanceof WorkflowRuntimeError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new WorkflowCancelledError(error.message, path);
  return new WorkflowRuntimeError("runtime", error instanceof Error ? error.message : String(error), path, {
    cause: error instanceof Error ? error : undefined,
  });
}

function toStepError(error: WorkflowRuntimeError): StepError {
  return { code: error.code, message: error.message };
}

function summary(step: StepResult): StepSummary {
  return {
    path: step.path,
    id: step.id,
    type: step.type,
    status: step.status,
    ok: step.ok,
    attempts: step.attempts,
    error: step.error,
  };
}

function cancelledExecution(path?: string): WorkflowExecution {
  return {
    status: "cancelled",
    outputs: {},
    failure: { code: "cancelled", message: "Workflow cancelled", path },
  };
}

function capTerminalResult(result: WorkflowRunResult, valueLimit: number, totalLimit: number): WorkflowRunResult {
  for (const [name, value] of Object.entries(result.outputs)) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) <= valueLimit) continue;
    result.outputs[name] = `${truncateUtf8(encoded, Math.max(0, valueLimit - 14))}\n[truncated]`;
    result.truncatedOutputs.push(name);
  }
  if (serializedBytes(result) <= totalLimit) return result;

  result.resultTruncated = true;
  if (Object.keys(result.outputs).length > 0) result.truncatedOutputs = ["*"];
  result.outputs = {};
  while (Buffer.byteLength(JSON.stringify(result)) > totalLimit && result.steps.length > 0) {
    result.steps.pop();
  }
  if (serializedBytes(result) <= totalLimit) return result;

  if (result.failure?.path !== undefined) delete result.failure.path;
  if (result.failure) result.failure.message = "[truncated]";
  if (serializedBytes(result) <= totalLimit) return result;

  delete result.failure;
  if (serializedBytes(result) <= totalLimit) return result;

  result.workflowId = truncateUtf8(result.workflowId, Math.min(32, Buffer.byteLength(result.workflowId)));
  result.elapsedMs = 0;
  if (serializedBytes(result) <= totalLimit) return result;

  result.workflowId = "";
  result.truncatedOutputs = [];
  if (serializedBytes(result) > totalLimit) {
    throw new WorkflowRuntimeError("result-limit", `Terminal result cannot fit within ${totalLimit} bytes`);
  }
  return result;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function truncateUtf8(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= bytes) return value;
  return buffer.subarray(0, bytes).toString("utf8").replace(/\uFFFD$/u, "");
}
