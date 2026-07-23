import { isAbsolute, posix, win32 } from "node:path";
import type {
  CompileResult,
  CompiledPath,
  CompiledReference,
  CompiledStep,
  CompiledWorkflow,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowSource,
  WorkflowStep,
  WorkflowValue,
} from "../types.js";
import {
  analyzeTemplate,
  analyzeValue,
  inferValueKind,
  stepReferenceShape,
  type ReferenceContext,
} from "./references.js";

export const DEFAULT_MAX_NESTED_DEPTH = 16;
export const DEFAULT_MAX_PROCESS_ATTEMPTS = 3;

export interface WorkflowDefinitionEntry {
  definition: WorkflowDefinition;
  source: WorkflowSource;
}

export function compileWorkflow(
  entry: WorkflowDefinitionEntry,
  definitions: ReadonlyMap<string, WorkflowDefinitionEntry>,
  options: { maxDepth?: number; maxProcessAttempts?: number } = {},
): CompileResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  const references: CompiledReference[] = [];
  const compiledSteps: CompiledStep[] = [];
  const definitionMap = new Map([...definitions].map(([id, item]) => [id, item.definition]));
  const inputs = new Map(Object.entries(entry.definition.inputs ?? {}).map(([name, input]) => [name, input.type]));
  const vars = new Map<string, CompiledReference["valueKind"]>();
  const steps = new Map<string, ReturnType<typeof stepReferenceShape>>();
  const context: ReferenceContext = { inputs, vars, steps };
  const seenStepIds = new Set<string>();

  const workflowCwd = compilePath(entry.definition.cwd ?? ".", "invocation", entry.source.path, "cwd", diagnostics);

  for (const [index, step] of entry.definition.steps.entries()) {
    const stepPath = `steps.${index}`;
    if (seenStepIds.has(step.id)) {
      diagnostics.push(diagnostic(
        "step-duplicate-id",
        `Duplicate step id "${step.id}"`,
        entry.source.path,
        `${stepPath}.id`,
      ));
    }
    seenStepIds.add(step.id);

    const stepReferences: CompiledReference[] = [];
    if (typeof step.if === "string") {
      addAnalysis(analyzeTemplate(step.if, context, entry.source.path, `${stepPath}.if`, { condition: true }), stepReferences, diagnostics);
    }

    validateProcessPolicy(step, entry.source.path, stepPath, diagnostics, options.maxProcessAttempts ?? DEFAULT_MAX_PROCESS_ATTEMPTS);
    const compiled = compileStep(step, stepPath, entry.source.path, context, stepReferences, diagnostics);
    compiledSteps.push(compiled);
    references.push(...stepReferences);

    if (step.type === "workflow") {
      validateNestedInputs(step, stepPath, entry.source.path, context, definitionMap, diagnostics);
    }
    if (step.type === "set") {
      for (const [name, value] of Object.entries(step.values)) vars.set(name, inferValueKind(value, context));
    }
    steps.set(step.id, stepReferenceShape(step, definitionMap));
  }

  const outputAnalysis = analyzeValue(entry.definition.outputs ?? {}, context, entry.source.path, "outputs");
  diagnostics.push(...outputAnalysis.diagnostics);
  references.push(...outputAnalysis.references);

  validateNestedGraph(
    entry.definition.id,
    definitions,
    options.maxDepth ?? DEFAULT_MAX_NESTED_DEPTH,
    entry.source.path,
    diagnostics,
  );

  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics: dedupe(diagnostics) };
  const nestedWorkflowIds = entry.definition.steps
    .filter((step): step is Extract<WorkflowStep, { type: "workflow" }> => step.type === "workflow")
    .map((step) => step.workflow);
  const plan: CompiledWorkflow = {
    id: entry.definition.id,
    source: entry.source,
    cwd: workflowCwd,
    definition: entry.definition,
    steps: compiledSteps,
    outputReferences: outputAnalysis.references,
    nestedWorkflowIds,
  };
  return { plan, diagnostics: dedupe(diagnostics) };
}

function compileStep(
  step: WorkflowStep,
  stepPath: string,
  source: string,
  context: ReferenceContext,
  references: CompiledReference[],
  diagnostics: WorkflowDiagnostic[],
): CompiledStep {
  const fields: Array<[string, unknown]> = [];
  switch (step.type) {
    case "agent": fields.push(["prompt", step.prompt]); break;
    case "run": fields.push(["command", step.command], ["args", step.args], ["env", step.env]); break;
    case "shell": fields.push(["command", step.command], ["env", step.env]); break;
    case "script": fields.push(["interpreter", step.interpreter], ["file", step.file], ["args", step.args], ["env", step.env]); break;
    case "set": fields.push(["values", step.values]); break;
    case "approval": fields.push(["message", step.message]); break;
    case "workflow": fields.push(["inputs", step.inputs]); break;
  }
  if ("cwd" in step && step.cwd !== undefined) fields.push(["cwd", step.cwd]);
  for (const [field, value] of fields) {
    if (value === undefined) continue;
    addAnalysis(analyzeValue(value, context, source, `${stepPath}.${field}`), references, diagnostics);
  }

  const cwd = "cwd" in step && step.cwd !== undefined
    ? compilePath(step.cwd, "workflow", source, `${stepPath}.cwd`, diagnostics)
    : undefined;

  if (step.type === "script") {
    const file = compilePath(step.file, "step", source, `${stepPath}.file`, diagnostics);
    return {
      id: step.id,
      type: "script",
      sourceKind: "script",
      definition: {
        id: step.id,
        type: "run",
        command: step.interpreter,
        args: [step.file, ...(step.args ?? [])],
        if: step.if,
        timeoutMs: step.timeoutMs,
        continueOnError: step.continueOnError,
        cwd: step.cwd,
        env: step.env,
        idempotent: step.idempotent,
        retry: step.retry,
      },
      references,
      cwd,
      script: { interpreter: step.interpreter, file },
    };
  }
  return { id: step.id, type: step.type, sourceKind: step.type, definition: step, references, cwd };
}

function validateProcessPolicy(
  step: WorkflowStep,
  source: string,
  path: string,
  diagnostics: WorkflowDiagnostic[],
  maxAttempts: number,
): void {
  if (step.type !== "run" && step.type !== "shell" && step.type !== "script") return;
  if (step.retry && step.idempotent !== true) {
    diagnostics.push(diagnostic(
      "retry-idempotent",
      "Process retry requires idempotent: true",
      source,
      `${path}.retry`,
    ));
  }
  if (step.retry && step.retry.maxAttempts > maxAttempts) {
    diagnostics.push(diagnostic(
      "retry-limit",
      `retry.maxAttempts exceeds the configured maximum of ${maxAttempts}`,
      source,
      `${path}.retry.maxAttempts`,
    ));
  }
}

function validateNestedInputs(
  step: Extract<WorkflowStep, { type: "workflow" }>,
  stepPath: string,
  source: string,
  context: ReferenceContext,
  definitions: ReadonlyMap<string, WorkflowDefinition>,
  diagnostics: WorkflowDiagnostic[],
): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(step.workflow)) {
    diagnostics.push(diagnostic(
      "workflow-static-id",
      "Nested workflow must use a static workflow id",
      source,
      `${stepPath}.workflow`,
    ));
    return;
  }
  const nested = definitions.get(step.workflow);
  if (!nested) {
    diagnostics.push(diagnostic(
      "workflow-missing",
      `Nested workflow "${step.workflow}" was not found in the effective catalog`,
      source,
      `${stepPath}.workflow`,
    ));
    return;
  }
  const declared = nested.inputs ?? {};
  for (const name of Object.keys(step.inputs ?? {})) {
    if (!(name in declared)) {
      diagnostics.push(diagnostic(
        "workflow-input-unknown",
        `Nested workflow "${step.workflow}" has no input named "${name}"`,
        source,
        `${stepPath}.inputs.${name}`,
      ));
    }
  }
  for (const [name, input] of Object.entries(declared)) {
    const supplied = step.inputs?.[name];
    if (supplied === undefined && input.required === true && input.default === undefined) {
      diagnostics.push(diagnostic(
        "workflow-input-required",
        `Nested workflow "${step.workflow}" requires input "${name}"`,
        source,
        `${stepPath}.inputs`,
      ));
      continue;
    }
    if (supplied !== undefined && isStaticValue(supplied) && !matchesInputType(supplied, input.type)) {
      diagnostics.push(diagnostic(
        "workflow-input-type",
        `Input "${name}" for nested workflow "${step.workflow}" must be ${input.type}`,
        source,
        `${stepPath}.inputs.${name}`,
      ));
    }
  }

  const analysis = analyzeValue(step.inputs ?? {}, context, source, `${stepPath}.inputs`);
  diagnostics.push(...analysis.diagnostics);
}

function validateNestedGraph(
  rootId: string,
  definitions: ReadonlyMap<string, WorkflowDefinitionEntry>,
  maxDepth: number,
  source: string,
  diagnostics: WorkflowDiagnostic[],
): void {
  const visit = (id: string, stack: string[]): void => {
    const entry = definitions.get(id);
    if (!entry) return;
    if (stack.length > maxDepth) {
      diagnostics.push(diagnostic(
        "workflow-depth",
        `Nested workflow depth exceeds the configured maximum of ${maxDepth}: ${stack.join(" -> ")}`,
        source,
        "steps",
      ));
      return;
    }
    for (const [index, step] of entry.definition.steps.entries()) {
      if (step.type !== "workflow") continue;
      const cycleAt = stack.indexOf(step.workflow);
      if (cycleAt !== -1) {
        diagnostics.push(diagnostic(
          "workflow-cycle",
          `Nested workflow cycle: ${[...stack.slice(cycleAt), step.workflow].join(" -> ")}`,
          entry.source.path,
          `steps.${index}.workflow`,
        ));
        continue;
      }
      visit(step.workflow, [...stack, step.workflow]);
    }
  };
  visit(rootId, [rootId]);
}

function compilePath(
  value: string,
  base: CompiledPath["base"],
  source: string,
  path: string,
  diagnostics: WorkflowDiagnostic[],
): CompiledPath {
  const dynamic = value.includes("${{");
  const structuralValue = value.replace(/\$\{\{[^{}]+\}\}/g, "dynamic-segment");
  if (escapesBase(structuralValue)) {
    diagnostics.push(diagnostic(
      "path-escape",
      `Path must be relative and remain beneath its ${base} base`,
      source,
      path,
    ));
  }
  return { base, value, dynamic };
}

function escapesBase(value: string): boolean {
  if (isAbsolute(value) || win32.isAbsolute(value)) return true;
  const normalizedPosix = posix.normalize(value.replaceAll("\\", "/"));
  const normalizedWindows = win32.normalize(value);
  return normalizedPosix === ".." || normalizedPosix.startsWith("../") ||
    normalizedWindows === ".." || normalizedWindows.startsWith(`..${win32.sep}`);
}

function isStaticValue(value: WorkflowValue): boolean {
  if (typeof value === "string") return !value.includes("${{");
  if (Array.isArray(value)) return value.every(isStaticValue);
  if (value && typeof value === "object") return Object.values(value).every(isStaticValue);
  return true;
}

function matchesInputType(value: WorkflowValue, type: string): boolean {
  if (type === "json") return true;
  return typeof value === type;
}

function addAnalysis(
  analysis: { references: CompiledReference[]; diagnostics: WorkflowDiagnostic[] },
  references: CompiledReference[],
  diagnostics: WorkflowDiagnostic[],
): void {
  references.push(...analysis.references);
  diagnostics.push(...analysis.diagnostics);
}

function diagnostic(code: string, message: string, source: string, path: string): WorkflowDiagnostic {
  return { code, message, source, path, severity: "error" };
}

function dedupe(diagnostics: WorkflowDiagnostic[]): WorkflowDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = `${item.code}\0${item.source}\0${item.path}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
