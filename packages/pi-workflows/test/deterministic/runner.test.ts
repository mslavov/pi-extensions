import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../../src/runner/index.js";
import type { SpawnProcessOptions, SpawnProcessResult } from "../../src/runtime/spawn-process.js";
import { compilePlans, workflow } from "../helpers/workflows.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic workflow runner", () => {
  test("resolves typed/defaulted inputs, exact values, interpolation, vars, conditions, and declared outputs", async () => {
    const root = await fixtureRoot();
    const definition = workflow("values", [
      { id: "assign", type: "set", values: { config: "${{ inputs.config }}", label: "n=${{ inputs.count }}" } },
      { id: "skip", type: "set", if: "${{ !inputs.enabled }}", values: { ignored: true } },
      { id: "run", type: "run", command: "fixture", args: ["${{ vars.label }}"] },
    ], {
      inputs: {
        count: { type: "number", default: 2 },
        enabled: { type: "boolean", default: true },
        config: { type: "json", required: true },
      },
      outputs: {
        config: "${{ vars.config }}",
        text: "${{ steps.run.output.stdout }}",
        skipped: "${{ steps.skip.status }}",
      },
    });
    const plans = compilePlans([definition], root);
    const spawn = vi.fn(async (options: SpawnProcessOptions) => processResult(options.args?.[0] ?? ""));

    const result = await runWorkflow(plans.get("values")!, {
      invocationCwd: root,
      plans,
      inputs: { config: { mode: "safe" } },
      spawnProcess: spawn,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      outputs: { config: { mode: "safe" }, text: "n=2", skipped: "skipped" },
      steps: [
        { path: "assign", status: "succeeded" },
        { path: "skip", status: "skipped", ok: false },
        { path: "run", status: "succeeded" },
      ],
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ args: ["n=2"] }));
  });

  test("keeps a continued process failure terminal while allowing later steps and retries only bounded idempotent work", async () => {
    const root = await fixtureRoot();
    const definition = workflow("continued", [
      {
        id: "unstable",
        type: "run",
        command: "fixture",
        idempotent: true,
        retry: { maxAttempts: 3, delayMs: 1 },
        continueOnError: true,
      },
      { id: "after", type: "set", values: { reached: true } },
    ], { outputs: { reached: "${{ vars.reached }}", exit: "${{ steps.unstable.output.exitCode }}" } });
    const plans = compilePlans([definition], root);
    const spawn = vi.fn(async () => processResult("failure", 7));

    const result = await runWorkflow(plans.get("continued")!, { invocationCwd: root, plans, spawnProcess: spawn });

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: "failed",
      outputs: { reached: true, exit: 7 },
      steps: [
        { path: "unstable", status: "failed", attempts: 3 },
        { path: "after", status: "succeeded" },
      ],
      failure: { code: "process-exit", path: "unstable" },
    });
  });

  test("uses qualified nested paths and keeps approval accepted, denied, and cancelled distinct", async () => {
    const root = await fixtureRoot();
    const child = workflow("child", [
      { id: "gate", type: "approval", message: "Continue?" },
      { id: "done", type: "set", values: { value: "accepted" } },
    ], { outputs: { value: "${{ steps.gate.output.decision }}", decision: "${{ steps.gate.output.decision }}" } });
    const parent = workflow("parent", [{ id: "nested", type: "workflow", workflow: "child" }], {
      outputs: { value: "${{ steps.nested.output.value }}", decision: "${{ steps.nested.output.decision }}" },
    });
    const plans = compilePlans([parent, child], root);

    const accepted = await runWorkflow(plans.get("parent")!, {
      invocationCwd: root,
      plans,
      decideApproval: async ({ path }) => path === "nested.gate" ? "accepted" : "denied",
    });
    expect(accepted).toMatchObject({
      status: "succeeded",
      outputs: { value: "accepted", decision: "accepted" },
      steps: [
        { path: "nested", status: "succeeded" },
        { path: "nested.gate", status: "succeeded" },
        { path: "nested.done", status: "succeeded" },
      ],
    });

    const denied = await runWorkflow(plans.get("parent")!, {
      invocationCwd: root,
      plans,
      decideApproval: async () => "denied",
    });
    expect(denied.status).toBe("failed");
    expect(denied.failure).toMatchObject({ code: "approval-denied", path: "nested.gate" });
    expect(denied.steps.find((step) => step.path === "nested.gate")).toMatchObject({ status: "failed" });

    const cancelled = await runWorkflow(plans.get("parent")!, {
      invocationCwd: root,
      plans,
      decideApproval: async () => "cancelled",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outputs).toMatchObject({ decision: "cancelled" });
    expect(cancelled.steps.find((step) => step.path === "nested.gate")).toMatchObject({ status: "cancelled" });
  });

  test("fails skipped output resolution and preserves monotonic transitions", async () => {
    const root = await fixtureRoot();
    const definition = workflow("skipped-output", [
      { id: "optional", type: "run", command: "unused", if: false },
      { id: "consume", type: "set", values: { value: "${{ steps.optional.output.stdout }}" } },
    ]);
    const plans = compilePlans([definition], root);
    const transitions = new Map<string, string[]>();
    const result = await runWorkflow(plans.get("skipped-output")!, {
      invocationCwd: root,
      plans,
      onTransition: ({ path, status }) => transitions.set(path, [...(transitions.get(path) ?? []), status]),
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "reference-skipped-output", path: "consume" });
    expect(transitions.get("optional")).toEqual(["skipped"]);
    expect(transitions.get("consume")).toEqual(["running", "failed"]);
  });

  test("distinguishes deadline failure from external cancellation", async () => {
    const root = await fixtureRoot();
    const definition = workflow("deadline", [{ id: "wait", type: "run", command: "fixture", timeoutMs: 10 }]);
    const plans = compilePlans([definition], root);
    const blockingSpawn = ({ signal }: SpawnProcessOptions) => new Promise<SpawnProcessResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const timeout = await runWorkflow(plans.get("deadline")!, {
      invocationCwd: root,
      plans,
      spawnProcess: blockingSpawn,
    });
    expect(timeout).toMatchObject({ status: "failed", failure: { code: "timeout", path: "wait" } });

    const controller = new AbortController();
    const cancelledPromise = runWorkflow(plans.get("deadline")!, {
      invocationCwd: root,
      plans,
      signal: controller.signal,
      processTimeoutMs: 10_000,
      spawnProcess: blockingSpawn,
    });
    controller.abort();
    expect(await cancelledPromise).toMatchObject({ status: "cancelled", failure: { code: "cancelled" } });
  });

  test("honors already-aborted signals and cancellation during handler completion", async () => {
    const root = await fixtureRoot();
    const definition = workflow("cancel-races", [{ id: "run", type: "run", command: "fixture", timeoutMs: 20 }]);
    const plans = compilePlans([definition], root);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(await runWorkflow(plans.get("cancel-races")!, {
      invocationCwd: root,
      plans,
      signal: alreadyAborted.signal,
    })).toMatchObject({ status: "cancelled", failure: { code: "cancelled" } });

    const duringCompletion = new AbortController();
    const completed = await runWorkflow(plans.get("cancel-races")!, {
      invocationCwd: root,
      plans,
      signal: duringCompletion.signal,
      spawnProcess: async () => {
        duringCompletion.abort();
        return processResult("completed");
      },
    });
    expect(completed).toMatchObject({
      status: "cancelled",
      failure: { code: "cancelled", path: "run" },
      steps: [{ path: "run", status: "cancelled" }],
    });
  });

  test("preserves an earlier external cancellation when the timeout elapses before handler cleanup", async () => {
    const root = await fixtureRoot();
    const definition = workflow("cancel-first", [{ id: "run", type: "run", command: "fixture", timeoutMs: 10 }]);
    const plans = compilePlans([definition], root);
    const controller = new AbortController();
    const running = runWorkflow(plans.get("cancel-first")!, {
      invocationCwd: root,
      plans,
      signal: controller.signal,
      spawnProcess: ({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          setTimeout(() => reject(new DOMException("aborted", "AbortError")), 30);
        }, { once: true });
      }),
    });
    setTimeout(() => controller.abort(), 2);

    expect(await running).toMatchObject({ status: "cancelled", failure: { code: "cancelled", path: "run" } });
  });

  test("classifies a nested workflow deadline as timeout and an external abort as cancellation", async () => {
    const root = await fixtureRoot();
    const child = workflow("nested-child", [{ id: "gate", type: "approval", message: "Wait" }]);
    const timedParent = workflow("nested-timeout", [{
      id: "nested",
      type: "workflow",
      workflow: "nested-child",
      timeoutMs: 10,
    }]);
    const cancelledParent = workflow("nested-cancel", [{
      id: "nested",
      type: "workflow",
      workflow: "nested-child",
      timeoutMs: 1_000,
    }]);
    const plans = compilePlans([child, timedParent, cancelledParent], root);
    const decideApproval = async () => new Promise<"accepted">(() => {});

    const timeout = await runWorkflow(plans.get("nested-timeout")!, {
      invocationCwd: root,
      plans,
      decideApproval,
    });
    expect(timeout).toMatchObject({
      status: "failed",
      failure: { code: "timeout", path: "nested" },
    });
    expect(timeout.steps.find((step) => step.path === "nested")).toMatchObject({ status: "failed", error: { code: "timeout" } });

    const controller = new AbortController();
    const cancelledPromise = runWorkflow(plans.get("nested-cancel")!, {
      invocationCwd: root,
      plans,
      signal: controller.signal,
      decideApproval,
    });
    setTimeout(() => controller.abort(), 2);
    expect(await cancelledPromise).toMatchObject({ status: "cancelled", failure: { code: "cancelled" } });
  });

  test("enforces an approval deadline even when the decision adapter does not settle", async () => {
    const root = await fixtureRoot();
    const definition = workflow("approval-timeout", [{
      id: "gate",
      type: "approval",
      message: "Continue?",
      timeoutMs: 10,
    }]);
    const plans = compilePlans([definition], root);
    const result = await runWorkflow(plans.get("approval-timeout")!, {
      invocationCwd: root,
      plans,
      decideApproval: async () => new Promise(() => {}),
    });
    expect(result).toMatchObject({ status: "failed", failure: { code: "timeout", path: "gate" } });
  });

  test("caps mapped terminal output without copying raw step output into summaries", async () => {
    const root = await fixtureRoot();
    const definition = workflow("capped", [{ id: "emit", type: "run", command: "fixture" }], {
      outputs: { text: "${{ steps.emit.output.stdout }}" },
    });
    const plans = compilePlans([definition], root);
    const result = await runWorkflow(plans.get("capped")!, {
      invocationCwd: root,
      plans,
      spawnProcess: async () => processResult("sensitive".repeat(1_000)),
      maxOutputValueBytes: 128,
      maxResultBytes: 1_024,
    });

    expect(result.truncatedOutputs).toEqual(["text"]);
    expect(result.outputs.text).toContain("[truncated]");
    expect(JSON.stringify(result.steps)).not.toContain("sensitive");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_024);
  });

  test("guarantees the total result cap with hundreds of outputs and step summaries", async () => {
    const root = await fixtureRoot();
    const definition = workflow(
      "many-values",
      Array.from({ length: 250 }, (_, index) => ({ id: `step-${index}`, type: "set" as const, values: { [`value-${index}`]: index } })),
      { outputs: Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`output-${index}`, `value-${index}`])) },
    );
    const plans = compilePlans([definition], root);
    const result = await runWorkflow(plans.get("many-values")!, {
      invocationCwd: root,
      plans,
      maxResultBytes: 256,
      maxOutputValueBytes: 32,
    });

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256);
    expect(result).toMatchObject({ command: "run", version: 1, workflowId: "many-values", status: "succeeded", resultTruncated: true });
    expect(result.steps).toEqual([]);
    expect(result.outputs).toEqual({});
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-runner-"));
  roots.push(root);
  await mkdir(join(root, ".pi", "workflows"), { recursive: true });
  return root;
}

function processResult(stdout: string, exitCode = 0): SpawnProcessResult {
  return {
    stdout,
    stderr: "",
    exitCode,
    signal: null,
    killed: false,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
