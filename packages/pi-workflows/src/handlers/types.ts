import type { CompiledStep, CompiledWorkflow, WorkflowValue } from "../types.js";
import type { RuntimeValues } from "../runner/references.js";
import type {
  ApprovalDecision,
  StepError,
  WorkflowCancelledError,
} from "../runner/types.js";
import type { SpawnProcessOptions, SpawnProcessResult } from "../runtime/spawn-process.js";
import type { WorkflowRuntime } from "../runtime/workflow-runtime.js";

export interface HandlerResult {
  output: WorkflowValue;
  attempts?: number;
  error?: StepError;
  errorPath?: string;
  cancelled?: WorkflowCancelledError;
}

export interface HandlerContext {
  step: CompiledStep;
  path: string;
  values: RuntimeValues;
  invocationRoot: string;
  workflowCwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  runtime: WorkflowRuntime;
  maxStreamBytes?: number;
  killGraceMs?: number;
  decideApproval(request: { path: string; message: string; signal: AbortSignal }): Promise<ApprovalDecision>;
  spawnProcess(options: SpawnProcessOptions): Promise<SpawnProcessResult>;
  runNested(plan: CompiledWorkflow, inputs: Record<string, WorkflowValue>, path: string, signal: AbortSignal): Promise<HandlerResult>;
  plans: ReadonlyMap<string, CompiledWorkflow>;
}
