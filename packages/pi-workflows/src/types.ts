export type WorkflowScope = "user" | "project";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorkflowValue = JsonValue;

export interface WorkflowDiagnostic {
  code: string;
  message: string;
  source: string;
  path?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
}

export interface WorkflowSource {
  scope: WorkflowScope;
  path: string;
  canonicalPath: string;
}

interface InputBase {
  description?: string;
  required?: boolean;
}

export interface StringInputDefinition extends InputBase {
  type: "string";
  default?: string;
}

export interface NumberInputDefinition extends InputBase {
  type: "number";
  default?: number;
}

export interface BooleanInputDefinition extends InputBase {
  type: "boolean";
  default?: boolean;
}

export interface JsonInputDefinition extends InputBase {
  type: "json";
  default?: JsonValue;
}

export type InputDefinition =
  | StringInputDefinition
  | NumberInputDefinition
  | BooleanInputDefinition
  | JsonInputDefinition;

export interface RetryDefinition {
  maxAttempts: number;
  delayMs?: number;
}

interface StepBase {
  id: string;
  if?: boolean | string;
}

interface TimedStep extends StepBase {
  timeoutMs?: number;
}

interface ContinuingStep extends TimedStep {
  continueOnError?: boolean;
}

interface ProcessStep extends ContinuingStep {
  cwd?: string;
  env?: Record<string, string>;
  idempotent?: boolean;
  retry?: RetryDefinition;
}

export interface AgentStep extends ContinuingStep {
  type: "agent";
  prompt: string;
}

export interface RunStep extends ProcessStep {
  type: "run";
  command: string;
  args?: string[];
}

export interface ShellStep extends ProcessStep {
  type: "shell";
  command: string;
}

export interface ScriptStep extends ProcessStep {
  type: "script";
  interpreter: string;
  file: string;
  args?: string[];
}

export interface SetStep extends StepBase {
  type: "set";
  values: Record<string, WorkflowValue>;
}

export interface ApprovalStep extends TimedStep {
  type: "approval";
  message: string;
}

export interface NestedWorkflowStep extends ContinuingStep {
  type: "workflow";
  workflow: string;
  inputs?: Record<string, WorkflowValue>;
}

export type WorkflowStep =
  | AgentStep
  | RunStep
  | ShellStep
  | ScriptStep
  | SetStep
  | ApprovalStep
  | NestedWorkflowStep;

export interface WorkflowDefinition {
  version: 1;
  id: string;
  name?: string;
  description?: string;
  cwd?: string;
  inputs?: Record<string, InputDefinition>;
  steps: WorkflowStep[];
  outputs?: Record<string, WorkflowValue>;
}

export interface WorkflowCandidate {
  source: WorkflowSource;
  id?: string;
  definition?: WorkflowDefinition;
  diagnostics: WorkflowDiagnostic[];
  valid: boolean;
}

export interface CatalogWorkflow {
  id: string;
  effective?: WorkflowCandidate;
  blocking: WorkflowCandidate[];
  shadowed: WorkflowCandidate[];
  blocked: boolean;
}

export interface WorkflowCatalog {
  cwd: string;
  roots: Record<WorkflowScope, string>;
  workflows: CatalogWorkflow[];
  unassigned: WorkflowCandidate[];
  diagnostics: WorkflowDiagnostic[];
}

export interface CompiledReference {
  expression: string;
  exact: boolean;
  path: string[];
  valueKind: "scalar" | "json" | "unknown";
  skippedOutput: "error" | "not-applicable";
}

export interface CompiledPath {
  base: "invocation" | "workflow" | "step";
  value: string;
  dynamic: boolean;
}

export interface CompiledStep {
  id: string;
  type: WorkflowStep["type"];
  sourceKind: WorkflowStep["type"];
  definition: WorkflowStep | RunStep;
  references: CompiledReference[];
  cwd?: CompiledPath;
  script?: {
    interpreter: string;
    file: CompiledPath;
  };
}

export interface CompiledWorkflow {
  id: string;
  source: WorkflowSource;
  cwd: CompiledPath;
  definition: WorkflowDefinition;
  steps: CompiledStep[];
  outputReferences: CompiledReference[];
  nestedWorkflowIds: string[];
}

export interface CompileResult {
  plan?: CompiledWorkflow;
  diagnostics: WorkflowDiagnostic[];
}
