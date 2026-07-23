import type { CompiledWorkflow, WorkflowValue } from "../types.js";
import type { SpawnProcessOptions, SpawnProcessResult } from "../runtime/spawn-process.js";
import type { WorkflowChildSessionFactory } from "../runtime/child-session.js";

export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped" | "cancelled";
export type WorkflowStatus = "succeeded" | "failed" | "cancelled";
export type ApprovalDecision = "accepted" | "denied" | "cancelled";

export interface StepError {
  code: string;
  message: string;
}

export interface StepResult {
  path: string;
  id: string;
  type: string;
  status: StepStatus;
  ok: boolean;
  output: WorkflowValue;
  attempts: number;
  error?: StepError;
}

export interface StepSummary {
  path: string;
  id: string;
  type: string;
  status: StepStatus;
  ok: boolean;
  attempts: number;
  error?: StepError;
}

export interface WorkflowRunResult {
  command: "run";
  version: 1;
  workflowId: string;
  status: WorkflowStatus;
  ok: boolean;
  elapsedMs: number;
  steps: StepSummary[];
  outputs: Record<string, WorkflowValue>;
  truncatedOutputs: string[];
  resultTruncated: boolean;
  failure?: StepError & { path?: string };
}

export interface ApprovalRequest {
  path: string;
  message: string;
  signal: AbortSignal;
}

export interface WorkflowRunnerOptions {
  invocationCwd: string;
  plans: ReadonlyMap<string, CompiledWorkflow>;
  inputs?: Record<string, unknown>;
  signal?: AbortSignal;
  decideApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  spawnProcess?: (options: SpawnProcessOptions) => Promise<SpawnProcessResult>;
  onTransition?: (step: StepSummary) => void;
  maxStreamBytes?: number;
  killGraceMs?: number;
  processTimeoutMs?: number;
  agentTimeoutMs?: number;
  agentDir?: string;
  createChildSession?: WorkflowChildSessionFactory;
  maxAgentOutputBytes?: number;
  maxOutputValueBytes?: number;
  maxResultBytes?: number;
}

export class WorkflowRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowRuntimeError";
  }
}

export class WorkflowCancelledError extends WorkflowRuntimeError {
  constructor(message = "Workflow cancelled", path?: string) {
    super("cancelled", message, path);
    this.name = "WorkflowCancelledError";
  }
}

export class WorkflowTimeoutError extends WorkflowRuntimeError {
  constructor(message = "Workflow step timed out", path?: string) {
    super("timeout", message, path);
    this.name = "WorkflowTimeoutError";
  }
}
