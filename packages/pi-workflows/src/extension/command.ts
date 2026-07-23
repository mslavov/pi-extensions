import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { discoverWorkflowCatalog } from "../catalog/index.js";
import {
  formatList,
  formatValidation,
  listWorkflows,
  validateWorkflows,
} from "../commands/catalog.js";
import {
  prepareWorkflowCommand,
  runPreparedWorkflowCommand,
  type PreparedWorkflowRun,
} from "../commands/run.js";
import type { StepSummary, WorkflowRunResult } from "../runner/index.js";
import {
  createWorkflowChildSession,
  type WorkflowChildSessionFactory,
} from "../runtime/child-session.js";
import type { WorkflowScope } from "../types.js";
import {
  appendWorkflowSnapshot,
  hashWorkflowDefinition,
  latestWorkflowSnapshot,
  restoreInterruptedSnapshots,
  type WorkflowRunSnapshot,
} from "./persistence.js";
import { runWorkflowAuthoringChild } from "./prompt.js";
import {
  NO_UI_EXECUTION_MESSAGE,
  refuseNoUiExecution,
  sendWorkflowMessage,
  WORKFLOW_REPORT_MESSAGE,
  WORKFLOW_RESULT_MESSAGE,
} from "./mode.js";
import {
  clearWorkflowProgress,
  collectWorkflowInputs,
  configuredDialogTimeoutMs,
  decideWorkflowApproval,
  inputWithDeadline,
  previewWorkflowTrust,
  selectWithDeadline,
  showWorkflowProgress,
} from "./ui.js";

const REPORT_BYTES = 64 * 1024;
const SUBCOMMANDS = ["list", "validate", "run", "status", "cancel", "create"] as const;
type WorkflowSnapshotBase = Omit<
  WorkflowRunSnapshot,
  "status" | "currentStep" | "steps" | "updatedAt" | "completedAt"
>;

interface ActiveOperation {
  kind: "run" | "create";
  runId: string;
  workflowId?: string;
  sessionId: string;
  startedAt: number;
  controller: AbortController;
  done: Promise<void>;
  steps: Map<string, StepSummary>;
  currentStep?: string;
  snapshotBase?: WorkflowSnapshotBase;
}

export interface WorkflowCommandController {
  isActive(): boolean;
  sessionStart(ctx: ExtensionContext): void;
  shutdown(): Promise<void>;
}

export function registerWorkflowCommand(
  pi: ExtensionAPI,
  createChildSession: WorkflowChildSessionFactory = createWorkflowChildSession,
  dialogTimeoutMs = configuredDialogTimeoutMs(),
): WorkflowCommandController {
  let cwd = process.cwd();
  let active: ActiveOperation | undefined;
  let shuttingDown = false;

  pi.registerCommand("workflow", {
    description: "List, validate, run, inspect, cancel, or author workflows",
    getArgumentCompletions: async (prefix) => workflowCompletions(prefix, cwd),
    handler: async (args, ctx) => {
      await handleWorkflowCommand(args, ctx).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        sendReport(pi, `Workflow command failed: ${message}`, { status: "failed" });
      });
    },
  });

  async function handleWorkflowCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    cwd = ctx.cwd;
    const trimmed = args.trim();
    if (!trimmed) {
      scheduleWorkflowSelection(ctx);
      return;
    }

    const space = trimmed.indexOf(" ");
    const command = space === -1 ? trimmed : trimmed.slice(0, space);
    const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
    switch (command) {
      case "list":
        await reportList(ctx, rest);
        return;
      case "validate":
        await reportValidation(ctx, rest);
        return;
      case "run":
        if (!rest || rest.includes(" ")) {
          sendReport(pi, "Usage: /workflow run <id>", { status: "invalid-arguments" });
          return;
        }
        scheduleWorkflowRun(ctx, rest);
        return;
      case "status":
        reportStatus(ctx);
        return;
      case "cancel":
        await cancelActive();
        return;
      case "create":
        scheduleWorkflowAuthoring(ctx, rest);
        return;
      default:
        if (space === -1) {
          scheduleWorkflowRun(ctx, command);
          return;
        }
        sendReport(pi, `Unknown workflow command: ${command}`, { status: "invalid-arguments" });
    }
  }

  async function reportList(ctx: ExtensionCommandContext, rest: string): Promise<void> {
    if (rest) {
      sendReport(pi, "Usage: /workflow list", { status: "invalid-arguments" });
      return;
    }
    const result = await listWorkflows({ cwd: ctx.cwd });
    sendReport(pi, formatList(result), {
      command: "list",
      workflowCount: result.workflows.length,
      diagnosticCount: result.diagnostics.length,
    });
  }

  async function reportValidation(ctx: ExtensionCommandContext, workflowId: string): Promise<void> {
    if (workflowId.includes(" ")) {
      sendReport(pi, "Usage: /workflow validate [id]", { status: "invalid-arguments" });
      return;
    }
    const result = await validateWorkflows(workflowId || undefined, { cwd: ctx.cwd });
    sendReport(pi, formatValidation(result), {
      command: "validate",
      workflowId: workflowId || undefined,
      valid: result.valid,
      workflowCount: result.workflows.length,
      diagnosticCount: result.diagnostics.length,
    });
  }

  function scheduleWorkflowSelection(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      refuseNoUiExecution(pi);
      return;
    }
    scheduleExclusive(ctx, "run", undefined, (operation) => selectAndRun(ctx, operation));
  }

  async function selectAndRun(ctx: ExtensionCommandContext, operation: ActiveOperation): Promise<void> {
    showWorkflowProgress(ctx.ui, "workflow selection", operation.steps, "selecting workflow");
    const catalog = await discoverWorkflowCatalog({ cwd: ctx.cwd });
    const ids = catalog.workflows.filter((workflow) => workflow.effective).map((workflow) => workflow.id);
    if (ids.length === 0) {
      sendReport(pi, "No runnable workflows found. Use /workflow validate for diagnostics.", {
        command: "list",
        workflowCount: 0,
      });
      return;
    }
    const selected = await selectWithDeadline(
      ctx.ui,
      "Select a workflow",
      ids,
      operation.controller.signal,
      dialogTimeoutMs,
    );
    if (selected.status !== "answered") {
      sendReport(pi, `Workflow selection ${selected.status}.`, { status: selected.status });
      return;
    }
    operation.workflowId = selected.value;
    await executeWorkflowRun(ctx, selected.value, operation);
  }

  function scheduleWorkflowRun(ctx: ExtensionCommandContext, workflowId: string): void {
    if (!ctx.hasUI) {
      refuseNoUiExecution(pi);
      return;
    }
    scheduleExclusive(ctx, "run", workflowId, (operation) => executeWorkflowRun(ctx, workflowId, operation));
  }

  async function executeWorkflowRun(
    ctx: ExtensionCommandContext,
    workflowId: string,
    operation: ActiveOperation,
  ): Promise<void> {
    showWorkflowProgress(ctx.ui, workflowId, operation.steps);
    const prepared = await prepareWorkflowCommand(workflowId, { cwd: ctx.cwd });
    const source = prepared.workflow.effective.source;
    const definitionHash = hashWorkflowDefinition(prepared.plan.definition);
    const trust = await previewWorkflowTrust(
      ctx.ui,
      workflowId,
      source,
      prepared.workflow.shadowed.map((candidate) => candidate.source),
      definitionHash,
      operation.controller.signal,
      dialogTimeoutMs,
      projectTrust(ctx),
    );
    if (trust.status !== "answered") {
      sendReport(pi, `Workflow ${workflowId} was not started (${trust.status}).`, {
        workflowId,
        status: trust.status,
      });
      return;
    }

    const inputs = await collectWorkflowInputs(
      ctx.ui,
      prepared.plan.definition,
      operation.controller.signal,
      dialogTimeoutMs,
    );
    if (inputs.status !== "collected") {
      sendReport(pi, `Workflow ${workflowId} was not started (input ${inputs.status}).`, {
        workflowId,
        status: inputs.status,
      });
      return;
    }

    const snapshotBase = snapshotBaseFor(operation, prepared, definitionHash);
    operation.snapshotBase = snapshotBase;
    appendWorkflowSnapshot(pi, snapshotFor(snapshotBase, operation, "running"));
    const result = await runPreparedWorkflowCommand(prepared, {
      cwd: ctx.cwd,
      inputValues: inputs.values,
      signal: operation.controller.signal,
      createChildSession,
      decideApproval: ({ path, message, signal }) =>
        decideWorkflowApproval(ctx.ui, path, message, signal, dialogTimeoutMs),
      onTransition: (step) => {
        operation.steps.set(step.path, step);
        operation.currentStep = step.status === "running" || step.status === "waiting"
          ? step.path
          : operation.currentStep === step.path ? undefined : operation.currentStep;
        showWorkflowProgress(ctx.ui, workflowId, operation.steps, operation.currentStep);
        appendWorkflowSnapshot(pi, snapshotFor(snapshotBase, operation, "running"));
      },
    });
    appendWorkflowSnapshot(pi, snapshotFor(snapshotBase, operation, result.status, Date.now()));
    sendTerminalResult(pi, result);
  }

  function scheduleWorkflowAuthoring(ctx: ExtensionCommandContext, request: string): void {
    if (!ctx.hasUI) {
      refuseNoUiExecution(pi);
      return;
    }
    scheduleExclusive(ctx, "create", undefined, async (operation) => {
      let authoringRequest = request;
      if (!authoringRequest) {
        const entered = await inputWithDeadline(
          ctx.ui,
          "Describe the reusable workflow to create",
          "What should the workflow automate?",
          operation.controller.signal,
          dialogTimeoutMs,
        );
        if (entered.status !== "answered" || !entered.value.trim()) {
          sendReport(pi, `Workflow authoring ${entered.status === "answered" ? "cancelled" : entered.status}.`, {
            status: entered.status === "answered" ? "cancelled" : entered.status,
          });
          return;
        }
        authoringRequest = entered.value.trim();
      }

      const selectedScope = await selectWithDeadline(
        ctx.ui,
        "Where should the workflow be stored?",
        ["Project workflow", "User workflow"],
        operation.controller.signal,
        dialogTimeoutMs,
      );
      if (selectedScope.status !== "answered") {
        sendReport(pi, `Workflow authoring ${selectedScope.status}.`, { status: selectedScope.status });
        return;
      }
      const scope: WorkflowScope = selectedScope.value === "Project workflow" ? "project" : "user";
      showWorkflowProgress(ctx.ui, "authoring", operation.steps, "authoring child session");
      await runWorkflowAuthoringChild({
        cwd: ctx.cwd,
        scope,
        request: authoringRequest,
        signal: operation.controller.signal,
        createChildSession,
      });
      const validation = await validateWorkflows(undefined, { cwd: ctx.cwd });
      sendReport(
        pi,
        `Workflow authoring completed. Created workflows were not run.\n\n${formatValidation(validation)}`,
        {
          command: "create",
          scope,
          valid: validation.valid,
          workflowCount: validation.workflows.length,
          diagnosticCount: validation.diagnostics.length,
        },
      );
    });
  }

  function reportStatus(ctx: ExtensionCommandContext): void {
    if (active) {
      const lines = [
        `${active.kind} ${operationLabel(active)} is active.`,
        `Run: ${active.runId}`,
        `Elapsed: ${Math.max(0, Date.now() - active.startedAt)}ms`,
        ...(active.currentStep ? [`Current: ${active.currentStep}`] : []),
        ...[...active.steps.values()].map((step) => `${step.status}\t${step.path}`),
      ];
      sendReport(pi, lines.join("\n"), {
        status: "active",
        kind: active.kind,
        workflowId: active.workflowId,
        runId: active.runId,
      });
      return;
    }
    const snapshot = latestWorkflowSnapshot(ctx.sessionManager.getBranch());
    sendReport(
      pi,
      snapshot
        ? `No workflow is active. Last run ${snapshot.workflowId}: ${snapshot.status}.`
        : "No workflow is active in this parent session.",
      snapshot
        ? { status: snapshot.status, workflowId: snapshot.workflowId, runId: snapshot.runId }
        : { status: "idle" },
    );
  }

  async function cancelActive(): Promise<void> {
    const operation = active;
    if (!operation) {
      sendReport(pi, "No workflow operation is active.", { status: "idle" });
      return;
    }
    operation.controller.abort("cancelled by user");
    await operation.done;
    sendReport(pi, "Workflow cancellation completed.", {
      status: "cancelled",
      workflowId: operation.workflowId,
      runId: operation.runId,
    });
  }

  function scheduleExclusive(
    ctx: ExtensionCommandContext,
    kind: ActiveOperation["kind"],
    workflowId: string | undefined,
    task: (operation: ActiveOperation) => Promise<void>,
  ): void {
    if (shuttingDown) {
      sendReport(pi, "Workflow extension is shutting down.", { status: "shutting-down" });
      return;
    }
    if (active) {
      sendReport(pi, `Another workflow operation is already active (${active.workflowId ?? active.kind}).`, {
        status: "active",
        workflowId: active.workflowId,
        runId: active.runId,
      });
      return;
    }
    const operation: ActiveOperation = {
      kind,
      runId: randomUUID(),
      workflowId,
      sessionId: ctx.sessionManager.getSessionId(),
      startedAt: Date.now(),
      controller: new AbortController(),
      done: Promise.resolve(),
      steps: new Map(),
    };
    active = operation;
    operation.done = nextEventLoopTurn()
      .then(() => executeScheduledOperation(ctx, operation, task))
      .catch(() => undefined);
  }

  async function executeScheduledOperation(
    ctx: ExtensionCommandContext,
    operation: ActiveOperation,
    task: (operation: ActiveOperation) => Promise<void>,
  ): Promise<void> {
    try {
      await task(operation);
    } catch (error) {
      handleScheduledOperationError(operation, error);
    } finally {
      try {
        clearWorkflowProgress(ctx.ui);
      } catch {
        sendReport(pi, "Workflow UI cleanup failed.", {
          status: "failed",
          workflowId: operation.workflowId,
          runId: operation.runId,
        });
      } finally {
        if (active === operation) active = undefined;
      }
    }
  }

  function handleScheduledOperationError(operation: ActiveOperation, error: unknown): void {
    const cancelled = operation.controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    const status = cancelled ? "cancelled" : "failed";
    if (operation.snapshotBase) {
      try {
        appendWorkflowSnapshot(pi, snapshotFor(operation.snapshotBase, operation, status, Date.now()));
      } catch {
        sendReport(pi, "Workflow terminal snapshot could not be persisted.", {
          status: "failed",
          workflowId: operation.workflowId,
          runId: operation.runId,
        });
      }
    }
    if (cancelled) {
      sendReport(pi, `${operationLabel(operation)} was cancelled.`, {
        status,
        workflowId: operation.workflowId,
        runId: operation.runId,
      });
      return;
    }
    if (operation.snapshotBase && operation.workflowId) {
      sendUnexpectedTerminalFailure(pi, operation);
      return;
    }
    sendReport(pi, `${operationLabel(operation)} failed unexpectedly.`, {
      status,
      workflowId: operation.workflowId,
      runId: operation.runId,
    });
  }

  return {
    isActive: () => active !== undefined,
    sessionStart(ctx) {
      cwd = ctx.cwd;
      restoreInterruptedSnapshots(pi, ctx.sessionManager.getBranch());
    },
    async shutdown() {
      shuttingDown = true;
      const operation = active;
      if (!operation) return;
      operation.controller.abort("parent session shutdown");
      await operation.done;
    },
  };
}

async function workflowCompletions(prefix: string, cwd: string) {
  const catalog = await discoverWorkflowCatalog({ cwd }).catch(() => undefined);
  const ids = catalog?.workflows.filter((workflow) => workflow.effective).map((workflow) => workflow.id) ?? [];
  const trimmedStart = prefix.trimStart();
  const firstSpace = trimmedStart.indexOf(" ");
  if (firstSpace === -1) {
    return [...SUBCOMMANDS, ...ids]
      .filter((value) => value.startsWith(trimmedStart))
      .map((value) => ({ value, label: value }));
  }
  const command = trimmedStart.slice(0, firstSpace);
  const idPrefix = trimmedStart.slice(firstSpace + 1).trimStart();
  if (command !== "run" && command !== "validate") return null;
  const items = ids
    .filter((id) => id.startsWith(idPrefix))
    .map((id) => ({ value: `${command} ${id}`, label: id }));
  return items.length > 0 ? items : null;
}

function snapshotBaseFor(
  operation: ActiveOperation,
  prepared: PreparedWorkflowRun,
  definitionHash: string,
): WorkflowSnapshotBase {
  return {
    version: 1,
    runId: operation.runId,
    workflowId: prepared.plan.id,
    definitionHash,
    provenance: {
      scope: prepared.workflow.effective.source.scope,
      path: prepared.workflow.effective.source.path,
    },
    startedAt: operation.startedAt,
  };
}

function snapshotFor(
  base: WorkflowSnapshotBase,
  operation: ActiveOperation,
  status: WorkflowRunSnapshot["status"],
  completedAt?: number,
): WorkflowRunSnapshot {
  const updatedAt = completedAt ?? Date.now();
  return {
    ...base,
    status,
    currentStep: status === "running" ? operation.currentStep : undefined,
    steps: [...operation.steps.values()].map((step) => ({ path: step.path, status: step.status })),
    updatedAt,
    completedAt,
  };
}

function sendTerminalResult(pi: ExtensionAPI, result: WorkflowRunResult): void {
  const details = {
    workflowId: result.workflowId,
    status: result.status,
    elapsedMs: result.elapsedMs,
    steps: result.steps,
    outputs: result.outputs,
  };
  const lines = [
    `Workflow ${result.workflowId}: ${result.status} (${result.elapsedMs}ms)`,
    ...result.steps.map((step) => `${step.status}\t${step.path}${step.error ? `\t${step.error.code}: ${step.error.message}` : ""}`),
    `Outputs: ${JSON.stringify(result.outputs)}`,
    ...(result.resultTruncated ? ["Result summary was capped."] : []),
  ];
  sendWorkflowMessage(pi, WORKFLOW_RESULT_MESSAGE, lines.join("\n"), details);
}

function sendUnexpectedTerminalFailure(pi: ExtensionAPI, operation: ActiveOperation): void {
  const elapsedMs = Math.max(0, Date.now() - operation.startedAt);
  const steps = [...operation.steps.values()];
  const message = "Workflow infrastructure failed unexpectedly; run data was omitted.";
  sendWorkflowMessage(
    pi,
    WORKFLOW_RESULT_MESSAGE,
    [
      `Workflow ${operation.workflowId}: failed (${elapsedMs}ms)`,
      ...steps.map((step) => `${step.status}\t${step.path}`),
      message,
    ].join("\n"),
    {
      workflowId: operation.workflowId,
      status: "failed",
      elapsedMs,
      steps,
      outputs: {},
      failure: { code: "infrastructure-error", message },
    },
  );
}

function sendReport(pi: ExtensionAPI, content: string, details?: unknown): void {
  sendWorkflowMessage(pi, WORKFLOW_REPORT_MESSAGE, boundText(content, REPORT_BYTES), details);
}

function boundText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const marker = "\n[report truncated]";
  const kept = Buffer.from(value).subarray(0, bytes - Buffer.byteLength(marker)).toString("utf8").replace(/\uFFFD$/u, "");
  return `${kept}${marker}`;
}

function projectTrust(ctx: ExtensionCommandContext): boolean | undefined {
  const candidate = ctx as ExtensionCommandContext & { isProjectTrusted?: () => boolean };
  return typeof candidate.isProjectTrusted === "function" ? candidate.isProjectTrusted() : undefined;
}

function operationLabel(operation: ActiveOperation): string {
  if (operation.workflowId) return operation.workflowId;
  return operation.kind === "run" ? "workflow selection" : "workflow authoring";
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export { NO_UI_EXECUTION_MESSAGE };
