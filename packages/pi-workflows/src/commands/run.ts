import { discoverWorkflowCatalog, type CatalogOptions } from "../catalog/index.js";
import type {
  CatalogWorkflow,
  CompiledWorkflow,
  WorkflowCatalog,
  WorkflowDefinition,
  WorkflowValue,
} from "../types.js";
import { compileWorkflow, type WorkflowDefinitionEntry } from "../validation/compiler.js";
import {
  normalizeInputs,
  parseCliInput,
  runWorkflow,
  WorkflowRuntimeError,
  type ApprovalRequest,
  type ApprovalDecision,
  type StepSummary,
  type WorkflowRunResult,
} from "../runner/index.js";
import type { WorkflowChildSessionFactory } from "../runtime/child-session.js";

export interface RunCommandOptions extends CatalogOptions {
  inputs?: string[];
  inputValues?: Record<string, unknown>;
  approvals?: string[];
  signal?: AbortSignal;
  onProgress?: (path: string, status: string) => void;
  onTransition?: (step: StepSummary) => void;
  decideApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  createChildSession?: WorkflowChildSessionFactory;
  agentTimeoutMs?: number;
  maxAgentOutputBytes?: number;
}

export interface PreparedWorkflowRun {
  catalog: WorkflowCatalog;
  workflow: CatalogWorkflow & { effective: NonNullable<CatalogWorkflow["effective"]> };
  plan: CompiledWorkflow;
  plans: ReadonlyMap<string, CompiledWorkflow>;
}

export async function prepareWorkflowCommand(
  workflowId: string,
  options: CatalogOptions,
): Promise<PreparedWorkflowRun> {
  const catalog = await discoverWorkflowCatalog(options);
  const record = catalog.workflows.find((workflow) => workflow.id === workflowId);
  if (!record) throw new WorkflowRuntimeError("workflow-missing", `Workflow "${workflowId}" was not found`);
  if (!record.effective?.definition) {
    throw new WorkflowRuntimeError("workflow-invalid", `Workflow "${workflowId}" is blocked by validation errors`);
  }

  const entries = new Map<string, WorkflowDefinitionEntry>();
  for (const workflow of catalog.workflows) {
    if (workflow.effective?.definition) {
      entries.set(workflow.id, { definition: workflow.effective.definition, source: workflow.effective.source });
    }
  }
  const plans = compilePlans(entries);
  const plan = plans.get(workflowId);
  if (!plan) throw new WorkflowRuntimeError("workflow-invalid", `Workflow "${workflowId}" could not be compiled`);

  return {
    catalog,
    workflow: record as PreparedWorkflowRun["workflow"],
    plan,
    plans,
  };
}

export async function runPreparedWorkflowCommand(
  prepared: PreparedWorkflowRun,
  options: RunCommandOptions,
): Promise<WorkflowRunResult> {
  if (options.inputs !== undefined && options.inputValues !== undefined) {
    throw new WorkflowRuntimeError("input-syntax", "Use either CLI inputs or typed input values, not both");
  }
  const approvals = new Set(options.approvals ?? []);
  const approvalPaths = collectApprovalPaths(prepared.plan, prepared.plans);
  for (const path of approvals) {
    if (!approvalPaths.has(path)) {
      throw new WorkflowRuntimeError(
        "approval-path",
        `Approval path "${path}" does not exist in workflow "${prepared.plan.id}"`,
      );
    }
  }
  const inputs = options.inputValues ?? parseInputs(prepared.plan.definition, options.inputs ?? []);
  normalizeInputs(prepared.plan.definition, inputs);

  return runWorkflow(prepared.plan, {
    invocationCwd: prepared.catalog.cwd,
    plans: prepared.plans,
    inputs,
    signal: options.signal,
    agentDir: options.agentDir,
    createChildSession: options.createChildSession,
    agentTimeoutMs: options.agentTimeoutMs,
    maxAgentOutputBytes: options.maxAgentOutputBytes,
    decideApproval: options.decideApproval ?? (async ({ path, signal }) =>
      signal.aborted ? "cancelled" : approvals.has(path) ? "accepted" : "denied"),
    onTransition: (step) => {
      options.onProgress?.(step.path, step.status);
      options.onTransition?.(step);
    },
  });
}

export async function runWorkflowCommand(workflowId: string, options: RunCommandOptions): Promise<WorkflowRunResult> {
  const prepared = await prepareWorkflowCommand(workflowId, options);
  return runPreparedWorkflowCommand(prepared, options);
}

export function formatRunResult(result: WorkflowRunResult): string {
  const lines = [`${result.workflowId}\t${result.status}\t${result.elapsedMs}ms`];
  for (const step of result.steps) {
    lines.push(`${step.status}\t${step.path}${step.error ? `\t${step.error.code}: ${step.error.message}` : ""}`);
  }
  lines.push(`outputs\t${JSON.stringify(result.outputs)}`);
  if (result.resultTruncated) lines.push("result\ttruncated");
  return `${lines.join("\n")}\n`;
}

function compilePlans(entries: ReadonlyMap<string, WorkflowDefinitionEntry>): Map<string, CompiledWorkflow> {
  const plans = new Map<string, CompiledWorkflow>();
  for (const [id, entry] of entries) {
    const result = compileWorkflow(entry, entries);
    if (result.plan) plans.set(id, result.plan);
  }
  return plans;
}

function parseInputs(definition: WorkflowDefinition, values: string[]): Record<string, WorkflowValue> {
  const supplied: Record<string, WorkflowValue> = {};
  for (const item of values) {
    const separator = item.indexOf("=");
    if (separator <= 0) throw new WorkflowRuntimeError("input-syntax", "Input must use key=value");
    const name = item.slice(0, separator);
    const value = item.slice(separator + 1);
    const input = definition.inputs?.[name];
    if (!input) throw new WorkflowRuntimeError("input-unknown", `Workflow "${definition.id}" has no input named "${name}"`);
    if (Object.hasOwn(supplied, name)) throw new WorkflowRuntimeError("input-duplicate", `Input "${name}" was supplied more than once`);
    supplied[name] = parseCliInput(value, input, name);
  }
  return supplied;
}

function collectApprovalPaths(
  plan: CompiledWorkflow,
  plans: ReadonlyMap<string, CompiledWorkflow>,
  prefix = "",
  paths = new Set<string>(),
): Set<string> {
  for (const step of plan.steps) {
    const path = prefix ? `${prefix}.${step.id}` : step.id;
    if (step.sourceKind === "approval") paths.add(path);
    if (step.sourceKind === "workflow" && step.definition.type === "workflow") {
      const nested = plans.get(step.definition.workflow);
      if (nested) collectApprovalPaths(nested, plans, path, paths);
    }
  }
  return paths;
}
