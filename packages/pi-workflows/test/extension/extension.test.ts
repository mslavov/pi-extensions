import { afterEach, describe, expect, test, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerWorkflowCatalogTool } from "../../src/extension/catalog-tool.js";
import { registerWorkflowCommand } from "../../src/extension/command.js";
import {
  NO_UI_EXECUTION_MESSAGE,
  WORKFLOW_DIAGNOSTIC_MESSAGE,
  WORKFLOW_REPORT_MESSAGE,
  WORKFLOW_RESULT_MESSAGE,
} from "../../src/extension/mode.js";
import {
  WORKFLOW_SNAPSHOT_ENTRY,
  type WorkflowRunSnapshot,
} from "../../src/extension/persistence.js";
import {
  registerWorkflowPromptGuidance,
  workflowAuthoringSkillPath,
} from "../../src/extension/prompt.js";
import type {
  WorkflowChildSession,
  WorkflowChildSessionFactory,
} from "../../src/runtime/child-session.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow extension command", () => {
  test("collects typed inputs and approval through bounded dialogs, reports progress, and persists only compact snapshots", async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "headed.yaml"), `version: 1
id: headed
inputs:
  count: { type: number, required: true }
steps:
  - id: gate
    type: approval
    message: Approve count processing?
  - id: save
    type: set
    values: { count: "\${{ inputs.count }}" }
outputs:
  count: "\${{ vars.count }}"
  decision: "\${{ steps.gate.output.decision }}"
`);
    const harness = extensionHarness();
    const ui = fakeUi({ select: ["Run workflow", "Approve"], input: ["7"] });
    const ctx = commandContext(fixture.cwd, ui);
    const factory = vi.fn<WorkflowChildSessionFactory>();
    registerWorkflowCommand(harness.pi, factory, 100);

    const result = await harness.commands.get("workflow")!.handler("run headed", ctx);

    expect(result).toBeUndefined();
    expect(ui.select).not.toHaveBeenCalled();
    await waitForMessage(harness, WORKFLOW_RESULT_MESSAGE);
    expect(factory).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledWith(
      expect.stringContaining(join(fixture.workflows, "headed.yaml")),
      ["Run workflow", "Cancel"],
      expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 100 }),
    );
    expect(ui.select).toHaveBeenCalledWith(
      expect.stringContaining("Approval required at gate"),
      ["Approve", "Deny"],
      expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 100 }),
    );
    expect(ui.setStatus).toHaveBeenCalledWith("pi-workflows", expect.stringContaining("headed"));
    expect(ui.setWidget).toHaveBeenCalledWith("pi-workflows", expect.any(Array));
    expect(ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", undefined);
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-workflows", undefined);
    expect(ui.setStatus.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(1);
    expect(ui.setWidget.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(1);

    const resultMessage = harness.messages.find((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE);
    expect(resultMessage).toMatchObject({ options: { triggerTurn: false } });
    expect(resultMessage?.message.details).toMatchObject({
      workflowId: "headed",
      status: "succeeded",
      outputs: { count: 7, decision: "accepted" },
    });
    for (const message of harness.messages) expect(message.options).toEqual({ triggerTurn: false });

    const snapshots = harness.entries
      .filter((entry) => entry.customType === WORKFLOW_SNAPSHOT_ENTRY)
      .map((entry) => entry.data as WorkflowRunSnapshot);
    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots.at(-1)).toMatchObject({ workflowId: "headed", status: "succeeded" });
    for (const snapshot of snapshots) {
      expect(snapshot.definitionHash).toMatch(/^[a-f0-9]{16}$/);
      expect(snapshot.provenance).toEqual({ scope: "project", path: join(fixture.workflows, "headed.yaml") });
      expectForbiddenKeys(snapshot, ["inputs", "vars", "env", "prompt", "stdout", "stderr", "output"]);
    }
  });

  test.each([
    { answer: "Deny", status: "failed", label: "explicit denial" },
    { answer: undefined, status: "cancelled", label: "dialog cancellation" },
    { answer: HOLD, status: "cancelled", label: "dialog timeout" },
  ])("keeps approval $label distinct and terminal", async ({ answer, status }) => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "approval.yaml"), `version: 1
id: approval
steps:
  - id: gate
    type: approval
    message: Continue?
`);
    const harness = extensionHarness();
    const ui = fakeUi({ select: ["Run workflow", answer] });
    const ctx = commandContext(fixture.cwd, ui);
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 10);

    await harness.commands.get("workflow")!.handler("approval", ctx);

    await waitForMessage(harness, WORKFLOW_RESULT_MESSAGE);
    expect(harness.messages.find((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)?.message.details)
      .toMatchObject({ workflowId: "approval", status });
  });

  test("fails closed without UI before creating a child or process", async () => {
    const fixture = await fixtureRoot();
    const marker = join(fixture.root, "must-not-exist");
    await writeFile(join(fixture.workflows, "danger.yaml"), `version: 1
id: danger
steps:
  - id: write
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`)}]
`);
    const harness = extensionHarness();
    const factory = vi.fn<WorkflowChildSessionFactory>();
    registerWorkflowCommand(harness.pi, factory, 20);
    const ctx = commandContext(fixture.cwd, fakeUi(), false);

    await harness.commands.get("workflow")!.handler("run danger", ctx);
    await harness.commands.get("workflow")!.handler("create dangerous authoring", ctx);

    expect(factory).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.messages.filter((message) => message.message.customType === WORKFLOW_DIAGNOSTIC_MESSAGE))
      .toHaveLength(2);
    expect(harness.messages[0]).toMatchObject({
      message: { content: NO_UI_EXECUTION_MESSAGE },
      options: { triggerTurn: false },
    });
  });

  test("keeps process stdout out of parent snapshots and terminal messages by default", async () => {
    const fixture = await fixtureRoot();
    const sentinel = "RAW_PROCESS_OUTPUT_MUST_NOT_APPEAR";
    await writeFile(join(fixture.workflows, "quiet.yaml"), `version: 1
id: quiet
steps:
  - id: process
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(sentinel)})`)}]
`);
    const harness = extensionHarness();
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 100);

    await harness.commands.get("workflow")!.handler(
      "run quiet",
      commandContext(fixture.cwd, fakeUi({ select: ["Run workflow"] })),
    );

    await waitForMessage(harness, WORKFLOW_RESULT_MESSAGE);
    expect(JSON.stringify(harness.messages)).not.toContain(sentinel);
    expect(JSON.stringify(harness.entries)).not.toContain(sentinel);
    expect(harness.messages.find((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)?.message.details)
      .toMatchObject({ workflowId: "quiet", status: "succeeded", outputs: {} });
  });

  test("puts only explicitly mapped workflow output into the parent result", async () => {
    const fixture = await fixtureRoot();
    const mapped = "MAPPED_OUTPUT_ENTERS_PARENT_CONTEXT";
    const unmapped = "UNMAPPED_STDERR_STAYS_CHILD_ONLY";
    await writeFile(join(fixture.workflows, "mapped.yaml"), `version: 1
id: mapped
steps:
  - id: process
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(mapped)}); process.stderr.write(${JSON.stringify(unmapped)})`)}]
outputs:
  selected: "\${{ steps.process.output.stdout }}"
`);
    const harness = extensionHarness();
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 100);

    await harness.commands.get("workflow")!.handler(
      "run mapped",
      commandContext(fixture.cwd, fakeUi({ select: ["Run workflow"] })),
    );
    await waitForMessage(harness, WORKFLOW_RESULT_MESSAGE);

    const terminal = harness.messages.find((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)!;
    expect(terminal.message.content).toContain(mapped);
    expect(terminal.message.details).toMatchObject({ outputs: { selected: mapped } });
    expect(JSON.stringify(terminal)).not.toContain(unmapped);
    expect(JSON.stringify(harness.entries)).not.toContain(mapped);
    expect(JSON.stringify(harness.entries)).not.toContain(unmapped);
  });

  test("lists, validates, and selects an exact workflow ID without returning command payloads", async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "selectable.yaml"), "version: 1\nid: selectable\nsteps: [{id: done, type: set, values: {ok: true}}]\n");
    const harness = extensionHarness();
    const ui = fakeUi({ select: ["selectable", "Run workflow"] });
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 100);
    const command = harness.commands.get("workflow")!;
    const ctx = commandContext(fixture.cwd, ui);

    expect(await command.handler("list", ctx)).toBeUndefined();
    expect(await command.handler("validate selectable", ctx)).toBeUndefined();
    expect(await command.handler("", ctx)).toBeUndefined();

    await vi.waitFor(() => expect(ui.select).toHaveBeenCalled());
    await waitForMessage(harness, WORKFLOW_RESULT_MESSAGE);

    expect(ui.select).toHaveBeenNthCalledWith(
      1,
      "Select a workflow",
      expect.arrayContaining(["selectable"]),
      expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 100 }),
    );
    expect(harness.messages.filter((message) => message.message.customType === WORKFLOW_REPORT_MESSAGE))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ details: expect.objectContaining({ command: "list" }) }) }),
        expect.objectContaining({ message: expect.objectContaining({ details: expect.objectContaining({ command: "validate" }) }) }),
      ]));
    expect(harness.messages.find((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)?.message.details)
      .toMatchObject({ workflowId: "selectable", status: "succeeded" });
  });

  test("reserves exclusivity before bare selection and cancels that selection", async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "selectable.yaml"), "version: 1\nid: selectable\nsteps: [{id: done, type: set, values: {ok: true}}]\n");
    const harness = extensionHarness();
    const ui = fakeUi({ select: [HOLD] });
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 1_000);
    const command = harness.commands.get("workflow")!;
    const ctx = commandContext(fixture.cwd, ui);

    expect(await command.handler("", ctx)).toBeUndefined();
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledWith(
      "Select a workflow",
      ["selectable"],
      expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 1_000 }),
    ));
    await command.handler("run selectable", ctx);
    expect(harness.messages.some((message) =>
      message.message.customType === WORKFLOW_REPORT_MESSAGE && String(message.message.content).includes("already active"),
    )).toBe(true);

    await command.handler("cancel", ctx);

    expect(harness.messages.some((message) =>
      message.message.customType === WORKFLOW_REPORT_MESSAGE && String(message.message.content).includes("selection cancelled"),
    )).toBe(true);
    expect(harness.messages.some((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)).toBe(false);
    expect(ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", undefined);
    expect(ui.setWidget).toHaveBeenLastCalledWith("pi-workflows", undefined);
    expect(ui.setStatus.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(1);
    expect(ui.setWidget.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(1);
  });

  test("terminalizes an unexpected post-snapshot infrastructure error without leaking it", async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "infrastructure.yaml"), "version: 1\nid: infrastructure\nsteps: [{id: done, type: set, values: {ok: true}}]\n");
    const harness = extensionHarness();
    const append = harness.pi.appendEntry.bind(harness.pi);
    let appendCalls = 0;
    harness.pi.appendEntry = ((customType: string, data: unknown) => {
      appendCalls += 1;
      if (appendCalls === 4) throw new Error("RAW_INFRASTRUCTURE_SECRET");
      append(customType, data);
    }) as typeof harness.pi.appendEntry;
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 100);

    await harness.commands.get("workflow")!.handler(
      "run infrastructure",
      commandContext(fixture.cwd, fakeUi({ select: ["Run workflow"] })),
    );
    await waitForMessage(harness, WORKFLOW_RESULT_MESSAGE);

    expect(harness.entries.at(-1)?.data).toMatchObject({ workflowId: "infrastructure", status: "failed" });
    const terminal = harness.messages.find((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)!;
    expect(terminal.message.details).toMatchObject({
      workflowId: "infrastructure",
      status: "failed",
      outputs: {},
      failure: { code: "infrastructure-error" },
    });
    expect(JSON.stringify(harness.messages)).not.toContain("RAW_INFRASTRUCTURE_SECRET");
    expectForbiddenKeys(harness.entries.at(-1)?.data, ["inputs", "vars", "env", "prompt", "stdout", "stderr", "output"]);
  });

  test("enforces one active operation and cancels owned process work", { timeout: 10_000 }, async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "slow.yaml"), `version: 1
id: slow
steps:
  - id: wait
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", "setInterval(() => {}, 1000)"]
`);
    const harness = extensionHarness();
    const ui = fakeUi({ select: ["Run workflow"] });
    const ctx = commandContext(fixture.cwd, ui);
    registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 100);
    const command = harness.commands.get("workflow")!;

    const running = command.handler("run slow", ctx);
    await vi.waitFor(() => expect(harness.entries.some((entry) =>
      entry.customType === WORKFLOW_SNAPSHOT_ENTRY && (entry.data as WorkflowRunSnapshot).steps.some((step) => step.path === "wait"),
    )).toBe(true));

    await command.handler("status", ctx);
    expect(harness.messages.some((message) =>
      message.message.customType === WORKFLOW_REPORT_MESSAGE && String(message.message.content).includes("slow is active"),
    )).toBe(true);
    await command.handler("run slow", ctx);
    expect(harness.messages.some((message) =>
      message.message.customType === WORKFLOW_REPORT_MESSAGE && String(message.message.content).includes("already active"),
    )).toBe(true);

    await command.handler("cancel", ctx);
    await running;
    expect(harness.messages.find((message) =>
      message.message.customType === WORKFLOW_RESULT_MESSAGE &&
      (message.message.details as { workflowId?: string }).workflowId === "slow",
    )?.message.details).toMatchObject({ status: "cancelled" });
    expect(harness.entries.at(-1)?.data).toMatchObject({ status: "cancelled" });
  });

  test("restores unfinished parent snapshots as interrupted without resuming", () => {
    const harness = extensionHarness();
    const factory = vi.fn<WorkflowChildSessionFactory>();
    const controller = registerWorkflowCommand(harness.pi, factory, 100);
    const unfinished: WorkflowRunSnapshot = {
      version: 1,
      runId: "run-1",
      workflowId: "restore-me",
      definitionHash: "0123456789abcdef",
      provenance: { scope: "project", path: "/project/.pi/workflows/restore.yaml" },
      status: "running",
      currentStep: "work",
      steps: [{ path: "work", status: "running" }],
      startedAt: 10,
      updatedAt: 20,
    };
    const ctx = commandContext("/project", fakeUi(), true, [{
      type: "custom",
      customType: WORKFLOW_SNAPSHOT_ENTRY,
      data: { ...unfinished, prompt: "must not survive" },
    }]);

    controller.sessionStart(ctx);

    expect(factory).not.toHaveBeenCalled();
    expect(harness.entries).toHaveLength(1);
    expect(harness.entries[0].data).toMatchObject({
      runId: "run-1",
      status: "interrupted",
      steps: [{ path: "work", status: "interrupted" }],
    });
    expectForbiddenKeys(harness.entries[0].data, ["prompt", "inputs", "vars", "env", "output"]);
  });

  test("authors in a separate child using the literal packaged skill, validates, and never runs", async () => {
    const fixture = await fixtureRoot();
    const prompt = vi.fn(async (_authoringPrompt: string) => {
      await writeFile(join(fixture.workflows, "created.yaml"), `version: 1
id: created
steps:
  - id: done
    type: set
    values: { ok: true }
`);
    });
    const child = fakeChild(prompt);
    const factory = vi.fn(async () => child) as WorkflowChildSessionFactory;
    const harness = extensionHarness();
    const ui = fakeUi({ select: ["Project workflow"] });
    const ctx = commandContext(fixture.cwd, ui);
    registerWorkflowCommand(harness.pi, factory, 100);

    const returned = await harness.commands.get("workflow")!.handler("create make a reusable project check", ctx);

    expect(returned).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.messages.some((message) =>
      message.message.customType === WORKFLOW_REPORT_MESSAGE &&
      String(message.message.content).includes("Workflow authoring completed"),
    )).toBe(true));
    expect(factory).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    const authoringPrompt = prompt.mock.calls[0][0];
    expect(authoringPrompt).toContain(workflowAuthoringSkillPath());
    expect(authoringPrompt).toContain("literal file path");
    expect(authoringPrompt).toContain("Never run the authored workflow");
    expect(authoringPrompt).not.toContain("/skill:workflow-authoring");
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(harness.messages.some((message) =>
      message.message.customType === WORKFLOW_REPORT_MESSAGE &&
      String(message.message.content).includes("Validation succeeded"),
    )).toBe(true);
    expect(harness.messages.some((message) => message.message.customType === WORKFLOW_RESULT_MESSAGE)).toBe(false);
    expect(harness.entries).toEqual([]);
  });

  test("shutdown aborts and disposes an active authoring child", async () => {
    const fixture = await fixtureRoot();
    let release!: () => void;
    const promptStarted = Promise.withResolvers<void>();
    const prompt = vi.fn(async (_authoringPrompt: string) => {
      promptStarted.resolve();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const child = fakeChild(prompt);
    child.abort = vi.fn(async () => release());
    const harness = extensionHarness();
    const controller = registerWorkflowCommand(
      harness.pi,
      vi.fn(async () => child) as WorkflowChildSessionFactory,
      100,
    );
    const ctx = commandContext(fixture.cwd, fakeUi({ select: ["Project workflow"] }));
    const running = harness.commands.get("workflow")!.handler("create wait for shutdown", ctx);
    await promptStarted.promise;

    await controller.shutdown();
    await running;

    expect(child.abort).toHaveBeenCalledOnce();
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  test("completes subcommands and effective catalog IDs", async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "deploy.yaml"), "version: 1\nid: deploy\nsteps: [{id: done, type: set, values: {ok: true}}]\n");
    const harness = extensionHarness();
    const controller = registerWorkflowCommand(harness.pi, vi.fn<WorkflowChildSessionFactory>(), 100);
    controller.sessionStart(commandContext(fixture.cwd, fakeUi()));
    const complete = harness.commands.get("workflow")!.getArgumentCompletions!;

    await expect(complete("r")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "run" }),
    ]));
    await expect(complete("run d")).resolves.toEqual([
      expect.objectContaining({ value: "run deploy", label: "deploy" }),
    ]);
    await expect(complete("d")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "deploy" }),
    ]));
  });
});

describe("workflow model authority", () => {
  test("registers only bounded list/validate catalog actions", async () => {
    const fixture = await fixtureRoot();
    await writeFile(join(fixture.workflows, "valid.yaml"), "version: 1\nid: valid\nsteps: [{id: done, type: set, values: {ok: true}}]\n");
    const harness = extensionHarness();
    registerWorkflowCatalogTool(harness.pi, () => fixture.cwd);
    const tool = harness.tools.get("workflow_catalog")!;

    expect((tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum)
      .toEqual(["list", "validate"]);
    expect(JSON.stringify(tool.parameters)).not.toContain("run");
    const listed = await tool.execute("call", { action: "list" }, undefined, undefined, commandContext(fixture.cwd, fakeUi()));
    const validated = await tool.execute("call", { action: "validate", workflowId: "valid" }, undefined, undefined, commandContext(fixture.cwd, fakeUi()));
    expect(listed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("valid") });
    expect(validated.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Validation succeeded") });
    expect(Buffer.byteLength((listed.content[0] as { text: string }).text)).toBeLessThanOrEqual(32 * 1024);
  });

  test("injects concise authoring guidance only for relevant or active turns", async () => {
    const harness = extensionHarness();
    registerWorkflowPromptGuidance(harness.pi, () => false);
    const beforeAgent = harness.events.get("before_agent_start")![0];

    expect(await beforeAgent({ prompt: "fix a typo", systemPrompt: "base" }, {})).toBeUndefined();
    const relevant = await beforeAgent({ prompt: "create a repeatable workflow", systemPrompt: "base" }, {});
    expect(relevant.systemPrompt).toContain("workflow-authoring");
    expect(relevant.systemPrompt).toContain("trusted-author code");
    expect(relevant.systemPrompt).toContain("review the definition");
    expect(relevant.systemPrompt).toContain("validate every write");
    expect(relevant.systemPrompt).toContain("Never auto-run");
    expect(relevant.systemPrompt).not.toContain("version: 1");
  });
});

const HOLD = Symbol("hold-dialog");

function extensionHarness() {
  const commands = new Map<string, {
    handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
    getArgumentCompletions?: (prefix: string) => Promise<Array<{ value: string; label: string }> | null> | Array<{ value: string; label: string }> | null;
  }>();
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, Array<(event: any, ctx: any) => any>>();
  const messages: Array<{ message: any; options: any }> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, events, messages, entries };
}

async function waitForMessage(harness: ReturnType<typeof extensionHarness>, customType: string): Promise<void> {
  await vi.waitFor(() => expect(harness.messages.some((message) => message.message.customType === customType)).toBe(true));
}

function commandContext(
  cwd: string,
  ui: ExtensionUIContext,
  hasUI = true,
  entries: unknown[] = [],
): ExtensionCommandContext {
  return {
    cwd,
    ui,
    hasUI,
    sessionManager: {
      getSessionId: () => "parent-session",
      getBranch: () => entries,
    },
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
}

function fakeUi(answers: { select?: unknown[]; input?: unknown[] } = {}): ExtensionUIContext & {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
} {
  const selectAnswers = [...(answers.select ?? [])];
  const inputAnswers = [...(answers.input ?? [])];
  const select = vi.fn((_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
    dialogAnswer(selectAnswers.shift(), opts?.signal));
  const input = vi.fn((_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) =>
    dialogAnswer(inputAnswers.shift(), opts?.signal));
  return {
    select,
    input,
    confirm: vi.fn(),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  } as unknown as ReturnType<typeof fakeUi>;
}

function dialogAnswer(answer: unknown, signal?: AbortSignal): Promise<any> {
  if (answer !== HOLD) return Promise.resolve(answer);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

function fakeChild(prompt: (prompt: string) => Promise<void> = vi.fn(async () => {})): WorkflowChildSession {
  return {
    session: {
      model: { provider: "test", id: "test" },
      messages: [],
      prompt,
    } as never,
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    inspect: vi.fn(() => ({
      activeTools: [],
      allToolSources: [],
      contextFiles: [],
      extensionCount: 0,
      model: "test/test",
      promptCount: 0,
      runtime: { bun: false, name: "node" },
      sessionFile: null,
      skillCount: 0,
    })),
  };
}

async function fixtureRoot(): Promise<{ root: string; cwd: string; agentDir: string; workflows: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-extension-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const workflows = join(cwd, ".pi", "workflows");
  await Promise.all([mkdir(workflows, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  return { root, cwd, agentDir, workflows };
}

function expectForbiddenKeys(value: unknown, forbidden: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) expectForbiddenKeys(item, forbidden);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    expect(forbidden).not.toContain(key);
    expectForbiddenKeys(item, forbidden);
  }
}
