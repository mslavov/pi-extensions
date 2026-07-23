import { afterEach, describe, expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const roots: string[] = [];
const extensionPath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const adjacentPi = join(dirname(process.execPath), "pi");
const piExecutable = process.env.PI_WORKFLOWS_TEST_PI_BIN ?? findInstalledPi();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("spawned pi RPC extension", () => {
  test("emits valid RPC UI, snapshot, result, and response events for an approved run", { timeout: 15_000 }, async () => {
    const fixture = await rpcFixture(`version: 1
id: rpc-approved
steps:
  - id: gate
    type: approval
    message: Continue safely?
  - id: done
    type: set
    values: { ok: true }
outputs:
  ok: "\${{ vars.ok }}"
`);

    const result = await runRpc(fixture, "/workflow run rpc-approved", (event, respond) => {
      if (event.type !== "extension_ui_request" || event.method !== "select") return;
      respond(event.title.includes("Run workflow") ? "Run workflow" : "Approve");
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const responseIndex = result.events.findIndex((event) => event.type === "response" && event.id === "command-1");
    const firstUiIndex = result.events.findIndex((event) => event.type === "extension_ui_request");
    expect(result.events[responseIndex]).toMatchObject({
      id: "command-1",
      type: "response",
      command: "prompt",
      success: true,
    });
    expect(responseIndex).toBeLessThan(firstUiIndex);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "extension_ui_request", method: "setStatus", statusKey: "pi-workflows" }),
      expect.objectContaining({ type: "extension_ui_request", method: "setWidget", widgetKey: "pi-workflows" }),
      expect.objectContaining({
        type: "extension_ui_request",
        method: "select",
        title: expect.stringContaining("Project trust:"),
        options: ["Run workflow", "Cancel"],
      }),
      expect.objectContaining({
        type: "extension_ui_request",
        method: "select",
        title: expect.stringContaining("Approval required at gate"),
        options: ["Approve", "Deny"],
      }),
    ]));

    const snapshots = result.events
      .filter((event) => event.type === "entry_appended" && event.entry?.customType === "pi-workflows:run-snapshot")
      .map((event) => event.entry.data);
    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots.at(-1)).toMatchObject({ workflowId: "rpc-approved", status: "succeeded" });
    for (const snapshot of snapshots) {
      expectForbiddenKeys(snapshot, ["inputs", "vars", "env", "prompt", "stdout", "stderr", "output"]);
    }

    const terminal = result.events.find((event) =>
      event.type === "message_end" && event.message?.customType === "pi-workflows:result",
    );
    expect(terminal?.message.details).toMatchObject({
      workflowId: "rpc-approved",
      status: "succeeded",
      outputs: { ok: true },
    });
  });

  test("times out an unanswered RPC approval without hanging", { timeout: 15_000 }, async () => {
    const fixture = await rpcFixture(`version: 1
id: rpc-timeout
steps:
  - id: gate
    type: approval
    message: This dialog will be ignored.
`);

    const result = await runRpc(fixture, "/workflow rpc-timeout", (event, respond) => {
      if (event.type === "extension_ui_request" && event.method === "select" &&
        event.title.includes("Run workflow")) {
        respond("Run workflow");
      }
    }, { PI_WORKFLOWS_DIALOG_TIMEOUT_MS: "25" });

    expect(result.code).toBe(0);
    const approval = result.events.find((event) =>
      event.type === "extension_ui_request" && event.method === "select" && event.title.includes("Approval required"),
    );
    expect(approval).toMatchObject({ timeout: 25 });
    const terminal = result.events.find((event) =>
      event.type === "message_end" && event.message?.customType === "pi-workflows:result",
    );
    expect(terminal?.message.details).toMatchObject({ workflowId: "rpc-timeout", status: "cancelled" });
    expect(result.events.filter((event) => event.type === "entry_appended").at(-1)?.entry.data)
      .toMatchObject({ status: "cancelled" });
  });

  test("acknowledges run before a sequential RPC client sends status and cancel", { timeout: 15_000 }, async () => {
    const fixture = await rpcFixture(`version: 1
id: rpc-sequential
steps:
  - id: wait
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", "setInterval(() => {}, 1000)"]
`);
    let runAcknowledged = false;
    let statusAcknowledged = false;
    let runningObserved = false;
    let cancelSent = false;
    let uiArrivedBeforeRunAcknowledgement = false;

    const result = await runRpcConversation(
      fixture,
      (client) => client.prompt("run-command", "/workflow run rpc-sequential"),
      (event, client) => {
        if (event.type === "response" && event.id === "run-command") {
          runAcknowledged = true;
          client.prompt("status-command", "/workflow status");
        }
        if (event.type === "extension_ui_request" && event.method === "select") {
          if (!runAcknowledged) uiArrivedBeforeRunAcknowledgement = true;
          client.respond(event.id, "Run workflow");
        }
        if (event.type === "response" && event.id === "status-command") {
          statusAcknowledged = true;
        }
        if (event.type === "entry_appended" && event.entry?.customType === "pi-workflows:run-snapshot" &&
          event.entry.data.steps?.some((step: { path: string; status: string }) => step.path === "wait" && step.status === "running")) {
          runningObserved = true;
        }
        if (statusAcknowledged && runningObserved && !cancelSent) {
          cancelSent = true;
          client.prompt("cancel-command", "/workflow cancel");
        }
        if (event.type === "response" && event.id === "cancel-command") client.close();
      },
    );

    expect(result.code).toBe(0);
    const runResponseIndex = result.events.findIndex((event) => event.type === "response" && event.id === "run-command");
    const firstUiIndex = result.events.findIndex((event) => event.type === "extension_ui_request");
    expect(runResponseIndex).toBeGreaterThanOrEqual(0);
    expect(runResponseIndex).toBeLessThan(firstUiIndex);
    expect(uiArrivedBeforeRunAcknowledgement).toBe(false);
    expect(result.events.find((event) =>
      event.type === "message_end" && event.message?.customType === "pi-workflows:report" &&
      event.message.details?.status === "active",
    )?.message.details).toMatchObject({ workflowId: "rpc-sequential", status: "active" });
    expect(result.events.find((event) =>
      event.type === "message_end" && event.message?.customType === "pi-workflows:result",
    )?.message.details).toMatchObject({ workflowId: "rpc-sequential", status: "cancelled" });
    expect(result.events.find((event) => event.type === "response" && event.id === "cancel-command"))
      .toMatchObject({ success: true });
  });

  test("JSON mode refuses execution before a child or process starts", { timeout: 15_000 }, async () => {
    const fixture = await rpcFixture(`version: 1
id: json-refusal
steps:
  - id: write
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify("MARKER_PATH")}, 'bad')`)}]
`);
    const marker = join(fixture.root, "process-started");
    const workflowPath = join(fixture.cwd, ".pi", "workflows", "workflow.yaml");
    const definition = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, definition.replace("MARKER_PATH", marker));

    const output = await execPi([
      "--mode", "json",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "-e", extensionPath,
      "-p", "/workflow run json-refusal",
    ], fixture.cwd, { PI_CODING_AGENT_DIR: fixture.agentDir });
    const events = output.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

    expect(output.code).toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          customType: "pi-workflows:diagnostic",
          content: "Workflows are not executable in pi print/JSON mode. Use pi-workflows run <id>.",
        }),
      }),
    ]));
    expect(events.some((event) => event.message?.customType === "pi-workflows:result")).toBe(false);
  });
});

async function runRpc(
  fixture: RpcFixture,
  message: string,
  onEvent: (event: any, respond: (value: string) => void) => void,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; events: any[]; stderr: string }> {
  return runRpcConversation(
    fixture,
    (client) => client.prompt("command-1", message),
    (event, client) => {
      onEvent(event, (value) => client.respond(event.id, value));
      if (event.type === "message_end" && event.message?.customType === "pi-workflows:result") client.close();
    },
    extraEnv,
  );
}

interface RpcClient {
  prompt(id: string, message: string): void;
  respond(id: string, value: string): void;
  close(): void;
}

async function runRpcConversation(
  fixture: RpcFixture,
  start: (client: RpcClient) => void,
  onEvent: (event: any, client: RpcClient) => void,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; events: any[]; stderr: string }> {
  const child = spawn(piExecutable, [
    "--mode", "rpc",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e", extensionPath,
  ], {
    cwd: fixture.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: fixture.agentDir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client: RpcClient = {
    prompt(id, promptMessage) {
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: promptMessage, id })}\n`);
    },
    respond(id, value) {
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, value })}\n`);
    },
    close() {
      child.stdin.end();
    },
  };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    onEvent(event, client);
  });
  start(client);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { code, events, stderr };
}

interface RpcFixture {
  root: string;
  cwd: string;
  agentDir: string;
}

async function rpcFixture(definition: string): Promise<RpcFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-rpc-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const workflowPath = join(cwd, ".pi", "workflows", "workflow.yaml");
  await Promise.all([mkdir(dirname(workflowPath), { recursive: true }), mkdir(agentDir, { recursive: true })]);
  await writeFile(workflowPath, definition);
  return { root, cwd, agentDir };
}

function execPi(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(piExecutable, args, { cwd, env: { ...process.env, ...env }, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && error.code === "ENOENT") {
        reject(error);
        return;
      }
      resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
    });
    child.stdin?.end();
  });
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

function findInstalledPi(): string {
  if (existsSync(adjacentPi)) return adjacentPi;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.includes(`${sep}node_modules${sep}.bin`)) continue;
    const candidate = join(directory, "pi");
    if (existsSync(candidate)) return candidate;
  }
  return "pi";
}
