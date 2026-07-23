import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseWorkflowYaml } from "../schema.js";
import type {
  CatalogWorkflow,
  WorkflowCandidate,
  WorkflowCatalog,
  WorkflowDiagnostic,
  WorkflowScope,
  WorkflowSource,
} from "../types.js";
import { compileWorkflow, type WorkflowDefinitionEntry } from "../validation/compiler.js";

export interface CatalogOptions {
  cwd?: string;
  agentDir?: string;
  maxDepth?: number;
  maxProcessAttempts?: number;
}

export async function discoverWorkflowCatalog(options: CatalogOptions = {}): Promise<WorkflowCatalog> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const roots: Record<WorkflowScope, string> = {
    user: join(agentDir, "workflows"),
    project: join(cwd, ".pi", "workflows"),
  };
  const [user, project] = await Promise.all([
    scanRoot("user", roots.user),
    scanRoot("project", roots.project),
  ]);
  const candidates = [...user, ...project];
  rejectSameScopeDuplicates(candidates);

  const ids = [...new Set(candidates.flatMap((candidate) => candidate.id ? [candidate.id] : []))].sort();
  const preliminary = new Map<string, WorkflowCandidate>();
  const records = new Map<string, CatalogWorkflow>();

  for (const id of ids) {
    const userCandidates = candidates.filter((candidate) => candidate.id === id && candidate.source.scope === "user");
    const projectCandidates = candidates.filter((candidate) => candidate.id === id && candidate.source.scope === "project");
    const selected = projectCandidates.length > 0 ? onlyValid(projectCandidates) : onlyValid(userCandidates);
    if (selected) preliminary.set(id, selected);
    records.set(id, {
      id,
      effective: selected,
      blocking: selected ? [] : (projectCandidates.length > 0 ? projectCandidates : userCandidates),
      shadowed: projectCandidates.length > 0 ? userCandidates : [],
      blocked: selected === undefined,
    });
  }

  const definitionEntries = new Map<string, WorkflowDefinitionEntry>();
  for (const [id, candidate] of preliminary) {
    if (candidate.definition) definitionEntries.set(id, { definition: candidate.definition, source: candidate.source });
  }
  for (const [id, candidate] of preliminary) {
    if (!candidate.definition) continue;
    const result = compileWorkflow(
      { definition: candidate.definition, source: candidate.source },
      definitionEntries,
      { maxDepth: options.maxDepth, maxProcessAttempts: options.maxProcessAttempts },
    );
    candidate.diagnostics.push(...result.diagnostics);
    if (!result.plan) {
      candidate.valid = false;
      const record = records.get(id);
      if (record) {
        record.effective = undefined;
        record.blocking = [candidate];
        record.blocked = true;
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, candidate] of preliminary) {
      if (!candidate.valid || !candidate.definition) continue;
      const invalidNested = candidate.definition.steps.find((step) =>
        step.type === "workflow" && preliminary.get(step.workflow)?.valid === false,
      );
      if (!invalidNested || invalidNested.type !== "workflow") continue;
      candidate.valid = false;
      candidate.diagnostics.push({
        code: "workflow-nested-invalid",
        message: `Nested workflow "${invalidNested.workflow}" is invalid`,
        source: candidate.source.path,
        path: `steps.${candidate.definition.steps.indexOf(invalidNested)}.workflow`,
        severity: "error",
      });
      const record = records.get(id);
      if (record) {
        record.effective = undefined;
        record.blocking = [candidate];
        record.blocked = true;
      }
      changed = true;
    }
  }

  const unassigned = candidates.filter((candidate) => candidate.id === undefined);
  const workflows = [...records.values()];
  return {
    cwd,
    roots,
    workflows,
    unassigned,
    diagnostics: candidates.flatMap((candidate) => candidate.diagnostics),
  };
}

async function scanRoot(scope: WorkflowScope, root: string): Promise<WorkflowCandidate[]> {
  try {
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink()) {
      return [invalidCandidate(scope, root, "catalog-root-symlink", "Workflow catalog roots must not be symbolic links")];
    }
    if (!rootStats.isDirectory()) {
      return [invalidCandidate(scope, root, "catalog-root-type", "Workflow catalog roots must be directories")];
    }
  } catch (error) {
    if (isMissing(error)) return [];
    return [invalidCandidate(scope, root, "catalog-root", errorMessage(error))];
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    return [invalidCandidate(scope, root, "catalog-root", errorMessage(error))];
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    return [invalidCandidate(scope, root, "catalog-root", errorMessage(error))];
  }

  const yamlEntries = entries.filter((entry) => entry.name.endsWith(".yaml"));
  return Promise.all(yamlEntries.map(async (entry) => {
    const path = join(root, entry.name);
    const provisionalSource: WorkflowSource = { scope, path, canonicalPath: path };
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        return candidateWithDiagnostic(provisionalSource, "catalog-symlink", "Workflow definitions must not be symbolic links");
      }
      if (!stats.isFile()) {
        return candidateWithDiagnostic(provisionalSource, "catalog-file-type", "Workflow definitions must be regular files");
      }
      const canonicalPath = await realpath(path);
      if (!isWithin(canonicalRoot, canonicalPath)) {
        return candidateWithDiagnostic(
          { ...provisionalSource, canonicalPath },
          "catalog-path-escape",
          "Canonical workflow path escapes its catalog root",
        );
      }
      const source = await readFile(canonicalPath, "utf8");
      const parsed = parseWorkflowYaml(source, path);
      return {
        source: { scope, path, canonicalPath },
        id: parsed.id,
        definition: parsed.definition,
        diagnostics: parsed.diagnostics,
        valid: parsed.definition !== undefined,
      };
    } catch (error) {
      return candidateWithDiagnostic(provisionalSource, "catalog-read", errorMessage(error));
    }
  }));
}

function rejectSameScopeDuplicates(candidates: WorkflowCandidate[]): void {
  for (const scope of ["user", "project"] as const) {
    const groups = new Map<string, WorkflowCandidate[]>();
    for (const candidate of candidates) {
      if (candidate.source.scope !== scope || !candidate.id) continue;
      const group = groups.get(candidate.id) ?? [];
      group.push(candidate);
      groups.set(candidate.id, group);
    }
    for (const [id, group] of groups) {
      if (group.length < 2) continue;
      for (const candidate of group) {
        candidate.valid = false;
        candidate.diagnostics.push({
          code: "catalog-duplicate-id",
          message: `Duplicate ${scope} workflow id "${id}"`,
          source: candidate.source.path,
          path: "id",
          severity: "error",
        });
      }
    }
  }
}

function onlyValid(candidates: WorkflowCandidate[]): WorkflowCandidate | undefined {
  return candidates.length === 1 && candidates[0].valid && candidates[0].definition
    ? candidates[0]
    : undefined;
}

function invalidCandidate(
  scope: WorkflowScope,
  path: string,
  code: string,
  message: string,
): WorkflowCandidate {
  return candidateWithDiagnostic({ scope, path, canonicalPath: path }, code, message);
}

function candidateWithDiagnostic(source: WorkflowSource, code: string, message: string): WorkflowCandidate {
  const diagnostic: WorkflowDiagnostic = { code, message, source: source.path, severity: "error" };
  return { source, diagnostics: [diagnostic], valid: false };
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
