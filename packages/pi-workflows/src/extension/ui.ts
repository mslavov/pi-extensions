import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalDecision, StepSummary } from "../runner/index.js";
import type { InputDefinition, WorkflowDefinition, WorkflowSource, WorkflowValue } from "../types.js";

export const DEFAULT_WORKFLOW_DIALOG_TIMEOUT_MS = 60_000;
export const WORKFLOW_STATUS_KEY = "pi-workflows";
export const WORKFLOW_WIDGET_KEY = "pi-workflows";

export type DialogOutcome<T> =
  | { status: "answered"; value: T }
  | { status: "cancelled" | "timed-out" };

export type InputCollectionOutcome =
  | { status: "collected"; values: Record<string, WorkflowValue> }
  | { status: "cancelled" | "timed-out" };

export function configuredDialogTimeoutMs(): number {
  const configured = Number(process.env.PI_WORKFLOWS_DIALOG_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_WORKFLOW_DIALOG_TIMEOUT_MS;
}

export async function previewWorkflowTrust(
  ui: ExtensionUIContext,
  workflowId: string,
  source: WorkflowSource,
  shadowed: WorkflowSource[],
  definitionHash: string,
  signal: AbortSignal,
  timeoutMs: number,
  projectTrusted?: boolean,
): Promise<DialogOutcome<"run">> {
  const lines = [
    `Source: ${source.scope} ${source.path}`,
    `Definition: ${definitionHash}`,
    source.scope === "project"
      ? `Project trust: ${projectTrusted === true ? "trusted" : projectTrusted === false ? "not trusted by host" : "verify before running"}`
      : "Scope: user workflow",
    ...(shadowed.length > 0 ? [`Shadows: ${shadowed.map((item) => `${item.scope} ${item.path}`).join(", ")}`] : []),
    "Workflows may start processes and isolated coding-agent sessions with your local permissions.",
  ];
  const selected = await selectWithDeadline(
    ui,
    `Run workflow ${workflowId}?\n\n${lines.join("\n")}`,
    ["Run workflow", "Cancel"],
    signal,
    timeoutMs,
  );
  if (selected.status !== "answered") return selected;
  return selected.value === "Run workflow" ? { status: "answered", value: "run" } : { status: "cancelled" };
}

export async function collectWorkflowInputs(
  ui: ExtensionUIContext,
  definition: WorkflowDefinition,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<InputCollectionOutcome> {
  const values: Record<string, WorkflowValue> = {};
  for (const [name, input] of Object.entries(definition.inputs ?? {})) {
    const collected = input.type === "boolean"
      ? await collectBooleanInput(ui, name, input, signal, timeoutMs)
      : await collectTextInput(ui, name, input, signal, timeoutMs);
    if (collected.status !== "answered") return collected;
    if (collected.value !== undefined) values[name] = collected.value;
  }
  return { status: "collected", values };
}

export async function decideWorkflowApproval(
  ui: ExtensionUIContext,
  path: string,
  message: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  const selected = await selectWithDeadline(
    ui,
    `Approval required at ${path}\n\n${message}`,
    ["Approve", "Deny"],
    signal,
    timeoutMs,
  );
  if (selected.status !== "answered") return "cancelled";
  return selected.value === "Approve" ? "accepted" : "denied";
}

export function showWorkflowProgress(
  ui: ExtensionUIContext,
  workflowId: string,
  steps: ReadonlyMap<string, StepSummary>,
  currentStep?: string,
): void {
  ui.setStatus(
    WORKFLOW_STATUS_KEY,
    currentStep ? `${workflowId}: ${currentStep}` : `${workflowId}: preparing`,
  );
  const lines = [...steps.values()].slice(-10).map((step) => `${step.status.padEnd(9)} ${step.path}`);
  ui.setWidget(
    WORKFLOW_WIDGET_KEY,
    [`Workflow: ${workflowId}`, ...(lines.length > 0 ? lines : ["Preparing workflow..."])],
  );
}

export function clearWorkflowProgress(ui: ExtensionUIContext): void {
  let failure: unknown;
  try {
    ui.setStatus(WORKFLOW_STATUS_KEY, undefined);
  } catch (error) {
    failure = error;
  }
  try {
    ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

export async function selectWithDeadline(
  ui: ExtensionUIContext,
  title: string,
  options: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DialogOutcome<string>> {
  return dialogWithDeadline(
    (dialogSignal) => ui.select(title, options, { signal: dialogSignal, timeout: timeoutMs }),
    signal,
    timeoutMs,
  );
}

export async function inputWithDeadline(
  ui: ExtensionUIContext,
  title: string,
  placeholder: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DialogOutcome<string>> {
  return dialogWithDeadline(
    (dialogSignal) => ui.input(title, placeholder, { signal: dialogSignal, timeout: timeoutMs }),
    signal,
    timeoutMs,
  );
}

async function collectBooleanInput(
  ui: ExtensionUIContext,
  name: string,
  input: InputDefinition & { type: "boolean" },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DialogOutcome<WorkflowValue | undefined>> {
  const options = ["true", "false"];
  if (input.required !== true || input.default !== undefined) options.push("Use declared default");
  const selected = await selectWithDeadline(ui, inputTitle(name, input), options, signal, timeoutMs);
  if (selected.status !== "answered") return selected;
  if (selected.value === "Use declared default") return { status: "answered", value: undefined };
  return { status: "answered", value: selected.value === "true" };
}

async function collectTextInput(
  ui: ExtensionUIContext,
  name: string,
  input: Exclude<InputDefinition, { type: "boolean" }>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DialogOutcome<WorkflowValue | undefined>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entered = await inputWithDeadline(ui, inputTitle(name, input), inputPlaceholder(input), signal, timeoutMs);
    if (entered.status !== "answered") return entered;
    if (entered.value === "" && (input.default !== undefined || input.required !== true)) {
      return { status: "answered", value: undefined };
    }
    try {
      if (input.type === "string") return { status: "answered", value: entered.value };
      if (input.type === "number") {
        const number = Number(entered.value);
        if (!Number.isFinite(number)) throw new Error("Enter a finite number.");
        return { status: "answered", value: number };
      }
      const json: unknown = JSON.parse(entered.value);
      if (!isWorkflowValue(json)) throw new Error("Enter valid JSON data.");
      return { status: "answered", value: json };
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  }
  return { status: "cancelled" };
}

function inputTitle(name: string, input: InputDefinition): string {
  const required = input.required === true && input.default === undefined ? "required" : "optional";
  return `${name} (${input.type}, ${required})${input.description ? `\n\n${input.description}` : ""}`;
}

function inputPlaceholder(input: Exclude<InputDefinition, { type: "boolean" }>): string {
  if (input.default !== undefined) return `Default: ${JSON.stringify(input.default)} (leave empty to use it)`;
  return input.required === true ? `Enter ${input.type} value` : "Leave empty to omit";
}

async function dialogWithDeadline<T>(
  invoke: (signal: AbortSignal) => Promise<T | undefined>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<DialogOutcome<T>> {
  if (parentSignal.aborted) return { status: "cancelled" };
  const controller = new AbortController();
  let termination: "cancelled" | "timed-out" | undefined;
  const abort = (reason: "cancelled" | "timed-out") => {
    if (termination !== undefined) return;
    termination = reason;
    controller.abort(reason);
  };
  const onParentAbort = () => abort("cancelled");
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => abort("timed-out"), timeoutMs);
  try {
    const value = await invoke(controller.signal);
    if (value === undefined) return { status: termination ?? "cancelled" };
    return { status: "answered", value };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

function isWorkflowValue(value: unknown): value is WorkflowValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWorkflowValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isWorkflowValue);
}
