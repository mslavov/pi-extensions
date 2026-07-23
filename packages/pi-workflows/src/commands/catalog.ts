import { basename } from "node:path";
import { discoverWorkflowCatalog, type CatalogOptions } from "../catalog/index.js";
import type { CatalogWorkflow, WorkflowCatalog, WorkflowDiagnostic, WorkflowSource } from "../types.js";

export interface ListResult {
  command: "list";
  version: 1;
  cwd: string;
  workflows: Array<{
    id: string;
    status: "effective" | "blocked";
    effective?: WorkflowSource;
    blockedBy: WorkflowSource[];
    shadowed: WorkflowSource[];
  }>;
  diagnostics: WorkflowDiagnostic[];
}

export interface ValidateResult {
  command: "validate";
  version: 1;
  cwd: string;
  valid: boolean;
  workflowId?: string;
  workflows: Array<{ id: string; valid: boolean; source?: WorkflowSource }>;
  diagnostics: WorkflowDiagnostic[];
}

export async function listWorkflows(options: CatalogOptions = {}): Promise<ListResult> {
  const catalog = await discoverWorkflowCatalog(options);
  return {
    command: "list",
    version: 1,
    cwd: catalog.cwd,
    workflows: catalog.workflows.map((workflow) => ({
      id: workflow.id,
      status: workflow.effective ? "effective" : "blocked",
      effective: workflow.effective?.source,
      blockedBy: workflow.blocking.map((candidate) => candidate.source),
      shadowed: workflow.shadowed.map((candidate) => candidate.source),
    })),
    diagnostics: catalog.diagnostics,
  };
}

export async function validateWorkflows(
  workflowId: string | undefined,
  options: CatalogOptions = {},
): Promise<ValidateResult> {
  const catalog = await discoverWorkflowCatalog(options);
  let diagnostics = catalog.diagnostics;
  let workflows = catalog.workflows;
  if (workflowId) {
    const workflow = catalog.workflows.find((candidate) => candidate.id === workflowId);
    if (!workflow) {
      diagnostics = [{
        code: "catalog-missing-id",
        message: `Workflow "${workflowId}" was not found`,
        source: catalog.cwd,
        severity: "error",
      }];
      workflows = [];
    } else {
      const sources = new Set([
        workflow.effective?.source.path,
        ...workflow.blocking.map((candidate) => candidate.source.path),
        ...workflow.shadowed.map((candidate) => candidate.source.path),
      ].filter((path): path is string => path !== undefined));
      diagnostics = diagnostics.filter((diagnostic) => sources.has(diagnostic.source));
      workflows = [workflow];
    }
  }
  return {
    command: "validate",
    version: 1,
    cwd: catalog.cwd,
    valid: workflows.every((workflow) => workflow.effective !== undefined) &&
      !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    workflowId,
    workflows: workflows.map((workflow) => ({
      id: workflow.id,
      valid: workflow.effective !== undefined,
      source: workflow.effective?.source,
    })),
    diagnostics,
  };
}

export function formatList(result: ListResult): string {
  const lines = result.workflows.map((workflow) => {
    const source = workflow.effective
      ? `${workflow.effective.scope} ${workflow.effective.path}`
      : `blocked by ${workflow.blockedBy.map((item) => `${item.scope} ${item.path}`).join(", ") || "invalid definition"}`;
    const shadowed = workflow.shadowed.length > 0
      ? `; shadows ${workflow.shadowed.map((item) => `${item.scope} ${item.path}`).join(", ")}`
      : "";
    return `${workflow.id}\t${source}${shadowed}`;
  });
  if (lines.length === 0) lines.push("No workflows found.");
  lines.push(...result.diagnostics.map(formatDiagnostic));
  return `${lines.join("\n")}\n`;
}

export function formatValidation(result: ValidateResult): string {
  const lines = result.workflows.map((workflow) =>
    `${workflow.valid ? "valid" : "invalid"}\t${workflow.id}${workflow.source ? `\t${workflow.source.path}` : ""}`,
  );
  for (const diagnostic of result.diagnostics) lines.push(formatDiagnostic(diagnostic));
  if (lines.length === 0) lines.push("No workflows found.");
  lines.push(result.valid ? "Validation succeeded." : "Validation failed.");
  return `${lines.join("\n")}\n`;
}

export function catalogHasErrors(catalog: WorkflowCatalog | ListResult | ValidateResult): boolean {
  return catalog.diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function formatDiagnostic(diagnostic: WorkflowDiagnostic): string {
  const position = diagnostic.line
    ? `:${diagnostic.line}:${diagnostic.column ?? 1}`
    : diagnostic.path ? ` (${diagnostic.path})` : "";
  return `${basename(diagnostic.source)}${position}: ${diagnostic.message} [${diagnostic.code}]`;
}

export function workflowStatus(workflow: CatalogWorkflow): "effective" | "blocked" {
  return workflow.effective ? "effective" : "blocked";
}
