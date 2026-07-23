import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { WorkflowChildSession, WorkflowChildSessionFactory } from "../runtime/child-session.js";
import type { WorkflowScope } from "../types.js";

export function workflowAuthoringSkillPath(): string {
  return fileURLToPath(new URL("../../skills/workflow-authoring/SKILL.md", import.meta.url));
}

export function buildWorkflowAuthoringPrompt(options: {
  cwd: string;
  scope: WorkflowScope;
  request: string;
}): string {
  const skillPath = workflowAuthoringSkillPath();
  const target = options.scope === "project"
    ? join(options.cwd, ".pi", "workflows")
    : join(getAgentDir(), "workflows");
  return `Author a pi-workflows definition for this request:

${options.request}

Before inspecting or changing workflow files, use the read tool to read and follow the packaged workflow-authoring skill at this literal path:
${skillPath}

This is a literal file path. Do not rely on slash-command or skill-command expansion. The workflow scope is already chosen: ${options.scope}. Write under ${target}. Follow the skill's validation procedure after every write. Never run the authored workflow. Stop after validation and summarize what was authored.`;
}

export async function runWorkflowAuthoringChild(options: {
  cwd: string;
  scope: WorkflowScope;
  request: string;
  signal: AbortSignal;
  createChildSession: WorkflowChildSessionFactory;
}): Promise<void> {
  const child = await options.createChildSession({ cwd: options.cwd });
  try {
    if (!child.session.model) {
      throw new Error("No model is available for workflow authoring. Configure a pi model and provider credentials, then retry.");
    }
    await promptWithAbort(
      child,
      buildWorkflowAuthoringPrompt(options),
      options.signal,
    );
  } finally {
    child.dispose();
  }
}

export function shouldInjectWorkflowGuidance(prompt: string, active: boolean): boolean {
  return active || /\b(workflow|workflows|automate|automation|repeatable|pipeline|runbook)\b/i.test(prompt);
}

export function workflowSystemPromptGuidance(): string {
  return `## Reusable workflows
- Use pi-workflows when the user needs a reusable, explicit multi-step automation rather than a one-off action.
- Treat workflow definitions as trusted-author code. Before authoring or revising one, read and follow the workflow-authoring skill at ${workflowAuthoringSkillPath()}, review the definition, then validate every write.
- workflow_catalog is read-only: use it only to list or validate. Never auto-run a workflow; execution requires an explicit user /workflow command or pi-workflows CLI invocation.`;
}

export function registerWorkflowPromptGuidance(
  pi: ExtensionAPI,
  isActive: () => boolean,
): void {
  pi.on("before_agent_start", (event) => {
    if (!shouldInjectWorkflowGuidance(event.prompt, isActive())) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${workflowSystemPromptGuidance()}` };
  });
}

async function promptWithAbort(
  child: WorkflowChildSession,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  let abortPromise: Promise<void> | undefined;
  const onAbort = () => {
    abortPromise ??= child.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    if (abortPromise) await abortPromise;
    if (signal.aborted) throw new DOMException("Workflow authoring cancelled", "AbortError");
    await child.session.prompt(prompt);
    if (signal.aborted) throw new DOMException("Workflow authoring cancelled", "AbortError");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (abortPromise) await abortPromise;
  }
}
