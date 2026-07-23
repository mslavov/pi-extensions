import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import { runCli } from "../../src/cli.js";

const roots: string[] = [];
const packageRoot = resolve(import.meta.dirname, "../..");
let builtRoot: string;
let builtCli: string;

beforeAll(async () => {
  builtRoot = await mkdtemp(join(packageRoot, ".test-dist-"));
  builtCli = join(builtRoot, "cli.js");
  const built = spawnSync(process.execPath, [
    join(packageRoot, "..", "..", "node_modules", "typescript", "bin", "tsc"),
    "-p", join(packageRoot, "tsconfig.build.json"),
    "--outDir", builtRoot,
  ], { cwd: packageRoot, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`${built.stdout}\n${built.stderr}`);
});

afterAll(async () => {
  if (builtRoot) await rm(builtRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow run CLI", () => {
  test("keeps JSON stdout stable, progress on stderr, and raw process output unmapped", async () => {
    const fixture = await setup();
    await writeWorkflow(fixture.workflows, "raw", [{
      id: "emit",
      type: "run",
      command: process.execPath,
      args: ["-e", "process.stdout.write('RAW-MUST-STAY-INTERNAL')"],
    }]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(
      ["run", "raw", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--json"],
      { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    );

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).not.toContain("RAW-MUST-STAY-INTERNAL");
    expect(JSON.parse(stdout[0])).toMatchObject({ command: "run", workflowId: "raw", status: "succeeded", outputs: {} });
    expect(stderr.join("")).toContain("emit\trunning");
    expect(stderr.join("")).not.toContain("RAW-MUST-STAY-INTERNAL");
  });

  test("parses repeated typed inputs and exposes process output only through declared outputs", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.workflows, "typed.yaml"), `version: 1
id: typed
inputs:
  count: { type: number, required: true }
  enabled: { type: boolean, default: false }
  config: { type: json, required: true }
steps:
  - id: emit
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ${JSON.stringify(["-e", "process.stdout.write(process.argv[1])", "value=${{ inputs.count }}"])}
outputs:
  text: "\${{ steps.emit.output.stdout }}"
  config: "\${{ inputs.config }}"
  enabled: "\${{ inputs.enabled }}"
`);
    const stdout: string[] = [];
    const code = await runCli([
      "run", "typed",
      "--cwd", fixture.cwd,
      "--agent-dir", fixture.agentDir,
      "--input", "count=4",
      "--input", "config={\"mode\":\"safe\"}",
      "--json",
    ], { stdout: (text) => stdout.push(text), stderr: () => {} });

    expect(code).toBe(0);
    expect(JSON.parse(stdout[0])).toMatchObject({
      status: "succeeded",
      outputs: { text: "value=4", config: { mode: "safe" }, enabled: false },
    });
  });

  test("returns approval and usage exit codes without starting the next side effect", async () => {
    const fixture = await setup();
    const marker = join(fixture.root, "marker");
    await writeWorkflow(fixture.workflows, "gated", [
      { id: "gate", type: "approval", message: "Continue?" },
      { id: "write", type: "run", command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'written')`] },
    ]);

    const deniedOutput: string[] = [];
    const denied = await runCli(
      ["run", "gated", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--json"],
      { stdout: (text) => deniedOutput.push(text), stderr: () => {} },
    );
    expect(denied).toBe(3);
    expect(JSON.parse(deniedOutput[0])).toMatchObject({ status: "failed", failure: { code: "approval-denied" } });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const invalidOutput: string[] = [];
    const invalid = await runCli(
      ["run", "gated", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--approve", "wrong.path", "--json"],
      { stdout: (text) => invalidOutput.push(text), stderr: () => {} },
    );
    expect(invalid).toBe(2);
    expect(JSON.parse(invalidOutput.join(""))).toMatchObject({
      command: "run",
      status: "error",
      error: { code: "approval-path" },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const accepted = await runCli(
      ["run", "gated", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--approve", "gate", "--json"],
      { stdout: () => {}, stderr: () => {} },
    );
    expect(accepted).toBe(0);
    await expect(access(marker)).resolves.toBeUndefined();
  });

  test("emits one structured JSON error envelope for setup, validation, and input errors", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.workflows, "invalid.yaml"), "version: 1\nid: invalid\nsteps: []\n");
    await writeFile(join(fixture.workflows, "input.yaml"), `version: 1
id: input
inputs:
  count: { type: number, required: true }
steps:
  - id: done
    type: set
    values: { ok: true }
`);

    const cases = [
      { args: ["run", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--json"], code: "usage" },
      { args: ["run", "missing", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--json"], code: "workflow-missing" },
      { args: ["run", "invalid", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--json"], code: "workflow-invalid" },
      { args: ["run", "input", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--input", "count=no", "--json"], code: "input-type" },
      { args: ["run", "input", "--cwd", fixture.cwd, "--agent-dir", fixture.agentDir, "--input", "--json"], code: "usage" },
    ];

    for (const item of cases) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(item.args, {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      expect(code).toBe(2);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toMatchObject({
        command: "run",
        version: 1,
        status: "error",
        ok: false,
        error: { code: item.code },
      });
      expect(stderr.join("")).not.toBe("");
    }
  });

  test("runs nested exact approvals through the built Node CLI", async () => {
    const fixture = await setup();
    await writeWorkflow(fixture.workflows, "child", [
      { id: "gate", type: "approval", message: "Nested?" },
      { id: "done", type: "set", values: { accepted: true } },
    ], { accepted: "${{ vars.accepted }}" });
    await writeWorkflow(fixture.workflows, "parent", [{ id: "child", type: "workflow", workflow: "child" }], {
      accepted: "${{ steps.child.output.accepted }}",
    });
    const result = spawnSync(process.execPath, [
      builtCli,
      "run", "parent",
      "--cwd", fixture.cwd,
      "--agent-dir", fixture.agentDir,
      "--approve", "child.gate",
      "--json",
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("child.gate\twaiting");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      outputs: { accepted: true },
      steps: expect.arrayContaining([{ path: "child.gate", status: "succeeded", ok: true, id: "gate", type: "approval", attempts: 1 }]),
    });
  });

  test("keeps the built Node CLI alive across a referenced retry delay", async () => {
    const fixture = await setup();
    const marker = join(fixture.root, "attempted");
    await writeWorkflow(fixture.workflows, "retry", [{
      id: "retry",
      type: "run",
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');const p=${JSON.stringify(marker)};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exit(7)}process.stdout.write('retried')`,
      ],
      idempotent: true,
      retry: { maxAttempts: 2, delayMs: 200 },
    }], { text: "${{ steps.retry.output.stdout }}" });

    const result = spawnSync(process.execPath, [
      builtCli,
      "run", "retry",
      "--cwd", fixture.cwd,
      "--agent-dir", fixture.agentDir,
      "--json",
    ], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      outputs: { text: "retried" },
      steps: [{ path: "retry", attempts: 2, status: "succeeded" }],
    });
  });

  test("emits a structured setup error through the built Node CLI", async () => {
    const fixture = await setup();
    const result = spawnSync(process.execPath, [
      builtCli,
      "run", "missing",
      "--cwd", fixture.cwd,
      "--agent-dir", fixture.agentDir,
      "--json",
    ], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).not.toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "run",
      status: "error",
      error: { code: "workflow-missing" },
    });
  });

  test("maps SIGINT to cancellation exit 130 in the built Node CLI", { timeout: 10_000 }, async () => {
    const fixture = await setup();
    await writeWorkflow(fixture.workflows, "wait", [{
      id: "wait",
      type: "run",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }]);
    const child = spawn(process.execPath, [
      builtCli,
      "run", "wait",
      "--cwd", fixture.cwd,
      "--agent-dir", fixture.agentDir,
      "--json",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let interrupted = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!interrupted && stderr.includes("wait\trunning")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    const stdoutPromise = streamText(child.stdout);
    const codePromise = new Promise<number | null>((resolveCode) => child.once("close", resolveCode));
    const [stdout, code] = await Promise.all([stdoutPromise, codePromise]);

    expect(code, `${stderr}\n${stdout}`).toBe(130);
    expect(JSON.parse(stdout)).toMatchObject({ status: "cancelled", failure: { code: "cancelled" } });
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-run-cli-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const workflows = join(cwd, ".pi", "workflows");
  await Promise.all([mkdir(workflows, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  return { root, cwd, agentDir, workflows };
}

async function writeWorkflow(
  directory: string,
  id: string,
  steps: unknown[],
  outputs?: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(directory, `${id}.yaml`), `version: 1
id: ${id}
steps: ${JSON.stringify(steps)}
${outputs ? `outputs: ${JSON.stringify(outputs)}\n` : ""}`);
}

async function streamText(stream: Readable): Promise<string> {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
  });
  await new Promise<void>((resolveStream, reject) => {
    stream.once("end", resolveStream);
    stream.once("error", reject);
  });
  return text;
}
