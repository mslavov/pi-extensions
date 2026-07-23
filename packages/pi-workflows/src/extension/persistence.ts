import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { WorkflowDefinition, WorkflowScope } from "../types.js";

export const WORKFLOW_SNAPSHOT_ENTRY = "pi-workflows:run-snapshot";

export type SnapshotStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted";

export type SnapshotRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkflowRunSnapshot {
  version: 1;
  runId: string;
  workflowId: string;
  definitionHash: string;
  provenance: {
    scope: WorkflowScope;
    path: string;
  };
  status: SnapshotRunStatus;
  currentStep?: string;
  steps: Array<{ path: string; status: SnapshotStepStatus }>;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export function hashWorkflowDefinition(definition: WorkflowDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
}

export function appendWorkflowSnapshot(pi: ExtensionAPI, snapshot: WorkflowRunSnapshot): void {
  pi.appendEntry(WORKFLOW_SNAPSHOT_ENTRY, snapshot);
}

export function latestWorkflowSnapshot(entries: readonly unknown[]): WorkflowRunSnapshot | undefined {
  let latest: WorkflowRunSnapshot | undefined;
  for (const entry of entries) {
    const snapshot = snapshotFromEntry(entry);
    if (snapshot) latest = snapshot;
  }
  return latest;
}

export function restoreInterruptedSnapshots(
  pi: ExtensionAPI,
  entries: readonly unknown[],
  timestamp = Date.now(),
): WorkflowRunSnapshot[] {
  const latestByRun = new Map<string, WorkflowRunSnapshot>();
  for (const entry of entries) {
    const snapshot = snapshotFromEntry(entry);
    if (snapshot) latestByRun.set(snapshot.runId, snapshot);
  }

  const interrupted: WorkflowRunSnapshot[] = [];
  for (const snapshot of latestByRun.values()) {
    if (snapshot.status !== "running") continue;
    const restored: WorkflowRunSnapshot = {
      version: 1,
      runId: snapshot.runId,
      workflowId: snapshot.workflowId,
      definitionHash: snapshot.definitionHash,
      provenance: { ...snapshot.provenance },
      status: "interrupted",
      steps: snapshot.steps.map((step) => ({
        path: step.path,
        status: step.status === "running" || step.status === "waiting" || step.status === "pending"
          ? "interrupted"
          : step.status,
      })),
      startedAt: snapshot.startedAt,
      updatedAt: timestamp,
      completedAt: timestamp,
    };
    appendWorkflowSnapshot(pi, restored);
    interrupted.push(restored);
  }
  return interrupted;
}

function snapshotFromEntry(entry: unknown): WorkflowRunSnapshot | undefined {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKFLOW_SNAPSHOT_ENTRY) return undefined;
  const data = entry.data;
  if (!isRecord(data) || data.version !== 1 || typeof data.runId !== "string" ||
    typeof data.workflowId !== "string" || typeof data.definitionHash !== "string" ||
    !isRecord(data.provenance) || (data.provenance.scope !== "user" && data.provenance.scope !== "project") ||
    typeof data.provenance.path !== "string" || !isSnapshotRunStatus(data.status) ||
    !Array.isArray(data.steps) || typeof data.startedAt !== "number" || typeof data.updatedAt !== "number") {
    return undefined;
  }
  const steps = data.steps.flatMap((step) => {
    if (!isRecord(step) || typeof step.path !== "string" || !isSnapshotStepStatus(step.status)) return [];
    return [{ path: step.path, status: step.status }];
  });
  return {
    version: 1,
    runId: data.runId,
    workflowId: data.workflowId,
    definitionHash: data.definitionHash,
    provenance: { scope: data.provenance.scope, path: data.provenance.path },
    status: data.status,
    currentStep: typeof data.currentStep === "string" ? data.currentStep : undefined,
    steps,
    startedAt: data.startedAt,
    updatedAt: data.updatedAt,
    completedAt: typeof data.completedAt === "number" ? data.completedAt : undefined,
  };
}

function isSnapshotRunStatus(value: unknown): value is SnapshotRunStatus {
  return value === "running" || value === "succeeded" || value === "failed" ||
    value === "cancelled" || value === "interrupted";
}

function isSnapshotStepStatus(value: unknown): value is SnapshotStepStatus {
  return value === "pending" || value === "running" || value === "waiting" ||
    value === "succeeded" || value === "failed" || value === "skipped" ||
    value === "cancelled" || value === "interrupted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

