import { afterEach, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
const packageRoot = resolve(import.meta.dirname, "../..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release tarball", () => {
  test("installs only the tarball and passes Node, SDK, extension, skill, RPC, and no-UI smoke", { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflows-release-pack-"));
    roots.push(root);
    const packDir = join(root, "pack");
    const installDir = join(root, "install");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const npmCache = join(root, "npm-cache");
    await Promise.all([
      mkdir(packDir),
      mkdir(installDir),
      mkdir(cwd),
      mkdir(agentDir),
    ]);

    const packed = run("npm", ["pack", "--silent", "--json", "--pack-destination", packDir], packageRoot, {
      npm_config_cache: npmCache,
    });
    const packRecords = JSON.parse(packed.stdout) as PackRecord[];
    expect(packRecords).toHaveLength(1);
    const packRecord = packRecords[0];
    const tarball = join(packDir, packRecord.filename);
    const files = new Map(packRecord.files.map((file) => [file.path, file]));

    expect([...files.keys()]).toEqual(expect.arrayContaining([
      "README.md",
      "LICENSE",
      "package.json",
      "src/index.ts",
      "src/cli.ts",
      "dist/cli.js",
      "skills/workflow-authoring/SKILL.md",
      "skills/workflow-authoring/references/v1-contract.md",
      "skills/workflow-authoring/examples/deterministic.yaml",
      "examples/deterministic.yaml",
      "examples/nested-parent.yaml",
      "examples/safe-agent-review.yaml",
      "examples/scripts/summarize.mjs",
    ]));
    expect(files.get("dist/cli.js")!.mode & 0o111).not.toBe(0);
    expect([...files.keys()].some((path) => path.startsWith("test/") || path.includes("/fixtures/"))).toBe(false);
    expect([...files.keys()].some((path) =>
      path.startsWith("node_modules/") || path.startsWith(".turbo/") || path.startsWith(".pi/") ||
      path.startsWith(".test-dist-") || path.endsWith(".jsonl") || path.endsWith(".tgz") ||
      path === "auth.json" || path === "settings.json",
    )).toBe(false);

    run("npm", ["init", "--yes"], installDir, { npm_config_cache: npmCache });
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDir, {
      npm_config_cache: npmCache,
    });

    const installedPackage = join(installDir, "node_modules", "pi-workflows");
    const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
    expect(installedManifest.dependencies).toEqual({
      "@earendil-works/pi-coding-agent": expect.any(String),
      typebox: expect.any(String),
      yaml: expect.any(String),
    });
    expect(installedManifest.pi).toEqual({ extensions: ["./src/index.ts"], skills: ["./skills"] });
    expect((await readFile(join(installedPackage, "dist", "cli.js"), "utf8")).startsWith("#!/usr/bin/env node\n"))
      .toBe(true);

    const cli = executable(installDir, "pi-workflows");
    if (process.platform !== "win32") {
      expect((await lstat(cli)).mode & 0o111).not.toBe(0);
    }
    const workflows = join(cwd, ".pi", "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, "release-smoke.yaml"), `version: 1
id: release-smoke
inputs:
  name: { type: string, required: true }
steps:
  - id: configure
    type: set
    values: { prefix: hello }
  - id: emit
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", "process.stdout.write(process.argv[1])", "\${{ vars.prefix }} \${{ inputs.name }}"]
outputs:
  text: "\${{ steps.emit.output.stdout }}"
`);

    expect(JSON.parse(runExecutable(cli, ["list", "--cwd", cwd, "--agent-dir", agentDir, "--json"], installDir).stdout))
      .toMatchObject({ workflows: [{ id: "release-smoke", status: "effective" }] });
    expect(JSON.parse(runExecutable(cli, ["validate", "release-smoke", "--cwd", cwd, "--agent-dir", agentDir, "--json"], installDir).stdout))
      .toMatchObject({ workflowId: "release-smoke", valid: true });
    expect(JSON.parse(runExecutable(cli, [
      "run", "release-smoke", "--cwd", cwd, "--agent-dir", agentDir,
      "--input", "name=Node", "--json",
    ], installDir).stdout)).toMatchObject({
      workflowId: "release-smoke",
      status: "succeeded",
      outputs: { text: "hello Node" },
    });

    for (const file of ["deterministic.yaml", "nested-child.yaml", "nested-parent.yaml", "safe-agent-review.yaml"]) {
      await writeFile(
        join(workflows, file),
        await readFile(join(installedPackage, "examples", file), "utf8"),
      );
    }
    expect(JSON.parse(runExecutable(cli, ["validate", "--cwd", cwd, "--agent-dir", agentDir, "--json"], installDir).stdout))
      .toMatchObject({ valid: true });

    const directInspection = JSON.parse(run(process.execPath, [
      join(installedPackage, "dist", "cli.js"), "inspect", "--cwd", cwd, "--agent-dir", agentDir,
    ], installDir).stdout);
    expect(directInspection).toMatchObject({
      runtime: { bun: false, name: "node" },
      extensionCount: 0,
      sessionFile: null,
    });

    await writeFile(join(cwd, "AGENTS.md"), "installed package context");
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    await writeFile(join(cwd, ".pi", "prompts", "release-smoke.md"), "Installed prompt");
    await writeFile(join(cwd, "tool-input.txt"), "installed tool result");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        controlled: {
          baseUrl: "http://127.0.0.1/unused",
          api: "pi-workflows-pack-controlled",
          apiKey: "controlled-test-key",
          models: [{ id: "controlled-model", contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      packages: [installedPackage],
      enableSkillCommands: true,
      defaultProjectTrust: "yes",
      defaultProvider: "controlled",
      defaultModel: "controlled-model",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    }));

    const controlledSmoke = join(installDir, "controlled-smoke.mjs");
    await writeFile(controlledSmoke, controlledProviderSmoke(
      pathToFileURL(join(installedPackage, "dist", "runtime", "child-session.js")).href,
      cwd,
      agentDir,
    ));
    const controlled = JSON.parse(run(process.execPath, [controlledSmoke], installDir).stdout);
    expect(controlled).toMatchObject({
      calls: 3,
      text: "installed prompt complete",
      inspection: {
        activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        extensionCount: 0,
        sessionFile: null,
        runtime: { bun: false, name: "node" },
      },
    });
    expect(controlled.inspection.contextFiles).toContain(join(cwd, "AGENTS.md"));
    expect(controlled.inspection.skillCount).toBeGreaterThan(0);
    expect(controlled.inspection.promptCount).toBeGreaterThan(0);

    await writeFile(join(workflows, "rpc-smoke.yaml"), `version: 1
id: rpc-smoke
steps:
  - id: gate
    type: approval
    message: Continue installed RPC smoke?
  - id: done
    type: set
    values: { ok: true }
outputs:
  ok: "\${{ vars.ok }}"
`);
    const pi = executable(installDir, "pi");
    const commands = await rpcRequest(pi, cwd, agentDir, { id: "commands", type: "get_commands" });
    const discovered = commands.events.find((event) => event.type === "response" && event.id === "commands");
    expect(discovered?.data.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workflow", source: "extension" }),
      expect.objectContaining({ name: "skill:workflow-authoring", source: "skill" }),
    ]));

    const rpc = await runApprovedRpcWorkflow(pi, cwd, agentDir);
    expect(rpc.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "extension_ui_request", method: "setStatus", statusKey: "pi-workflows" }),
      expect.objectContaining({ type: "extension_ui_request", method: "setWidget", widgetKey: "pi-workflows" }),
      expect.objectContaining({
        type: "extension_ui_request",
        method: "select",
        title: expect.stringContaining("Approval required at gate"),
      }),
    ]));
    expect(rpc.events.find((event) => event.type === "message_end" && event.message?.customType === "pi-workflows:result")?.message.details)
      .toMatchObject({ workflowId: "rpc-smoke", status: "succeeded", outputs: { ok: true } });

    const marker = join(root, "no-ui-process-started");
    await writeFile(join(workflows, "no-ui-smoke.yaml"), `version: 1
id: no-ui-smoke
steps:
  - id: write
    type: run
    command: ${JSON.stringify(process.execPath)}
    args: ["-e", ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`)}]
`);
    const noUi = runExecutable(pi, [
      "--mode", "json", "--no-session", "--no-prompt-templates", "--no-themes",
      "-p", "/workflow run no-ui-smoke",
    ], cwd, { PI_CODING_AGENT_DIR: agentDir });
    const noUiEvents = noUi.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(noUiEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({
          customType: "pi-workflows:diagnostic",
          content: "Workflows are not executable in pi print/JSON mode. Use pi-workflows run <id>.",
        }),
      }),
    ]));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface PackRecord {
  filename: string;
  files: Array<{ path: string; mode: number; size: number }>;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runExecutable(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string } {
  if (process.platform !== "win32" || !command.endsWith(".cmd")) return run(command, args, cwd, extraEnv);
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], cwd, extraEnv);
}

function executable(project: string, name: string): string {
  return join(project, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

async function rpcRequest(
  pi: string,
  cwd: string,
  agentDir: string,
  request: Record<string, unknown>,
): Promise<{ events: any[]; stderr: string }> {
  return rpcConversation(pi, cwd, agentDir, (child) => {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }, (event, child) => {
    if (event.type === "response" && event.id === request.id) child.stdin.end();
  });
}

async function runApprovedRpcWorkflow(
  pi: string,
  cwd: string,
  agentDir: string,
): Promise<{ events: any[]; stderr: string }> {
  return rpcConversation(pi, cwd, agentDir, (child) => {
    child.stdin.write(`${JSON.stringify({ id: "run", type: "prompt", message: "/workflow run rpc-smoke" })}\n`);
  }, (event, child) => {
    if (event.type === "extension_ui_request" && event.method === "select") {
      const value = event.title.includes("Approval required") ? "Approve" : "Run workflow";
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value })}\n`);
    }
    if (event.type === "message_end" && event.message?.customType === "pi-workflows:result") child.stdin.end();
  });
}

async function rpcConversation(
  pi: string,
  cwd: string,
  agentDir: string,
  start: (child: ChildProcessWithoutNullStreams) => void,
  onEvent: (event: any, child: ChildProcessWithoutNullStreams) => void,
): Promise<{ events: any[]; stderr: string }> {
  const command = process.platform === "win32" && pi.endsWith(".cmd") ? process.env.ComSpec ?? "cmd.exe" : pi;
  const prefix = command === pi ? [] : ["/d", "/s", "/c", pi];
  const child = spawn(command, [
    ...prefix,
    "--mode", "rpc", "--no-session", "--no-prompt-templates", "--no-themes",
  ], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const events: any[] = [];
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline === -1) break;
      const line = stdout.slice(0, newline).replace(/\r$/u, "");
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      onEvent(event, child);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  start(child);
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", resolveCode);
  });
  if (code !== 0) throw new Error(`installed pi RPC failed (${code}):\n${stderr}`);
  return { events, stderr };
}

function controlledProviderSmoke(childSessionModule: string, cwd: string, agentDir: string): string {
  return `import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { createWorkflowChildSession } from ${JSON.stringify(childSessionModule)};

const api = "pi-workflows-pack-controlled";
const source = "pi-workflows-pack-smoke";
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let calls = 0;

function message(stopReason, content, errorMessage) {
  return {
    role: "assistant",
    api,
    provider: "controlled",
    model: "controlled-model",
    content,
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function respond() {
  calls += 1;
  const stream = createAssistantMessageEventStream();
  if (calls === 1) {
    const assistant = message("error", [], "503 service unavailable");
    stream.push({ type: "start", partial: assistant });
    stream.push({ type: "error", reason: "error", error: assistant });
  } else if (calls === 2) {
    const toolCall = { type: "toolCall", id: "installed-read", name: "read", arguments: { path: "tool-input.txt" } };
    const assistant = message("toolUse", [toolCall]);
    stream.push({ type: "start", partial: assistant });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: assistant });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant });
    stream.push({ type: "done", reason: "toolUse", message: assistant });
  } else {
    const text = "installed prompt complete";
    const assistant = message("stop", [{ type: "text", text }]);
    stream.push({ type: "start", partial: assistant });
    stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant });
    stream.push({ type: "done", reason: "stop", message: assistant });
  }
  stream.end();
  return stream;
}

registerApiProvider({ api, stream: respond, streamSimple: respond }, source);
const child = await createWorkflowChildSession({ cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(agentDir)} });
try {
  await child.session.prompt("Read tool-input.txt, then report completion.");
  process.stdout.write(JSON.stringify({
    calls,
    text: child.session.getLastAssistantText(),
    inspection: child.inspect(),
  }));
} finally {
  child.dispose();
  unregisterApiProviders(source);
}
`;
}
