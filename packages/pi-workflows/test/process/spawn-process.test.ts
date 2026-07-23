import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runWorkflow } from "../../src/runner/index.js";
import { operationalEnvironment, spawnProcess } from "../../src/runtime/spawn-process.js";
import { compilePlans, workflow } from "../helpers/workflows.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.PI_WORKFLOWS_TEST_SECRET;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("spawn process adapter", () => {
  test("preserves argv spacing, uses an explicit shell, reports nonzero exits, and truncates streams", async () => {
    const root = await fixtureRoot();
    const argv = await spawnProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "two words", "'quoted'"],
      cwd: root,
    });
    expect(JSON.parse(argv.stdout)).toEqual(["two words", "'quoted'"]);

    const definitions = [
      workflow("shell", [{
        id: "shell",
        type: "shell",
        command: process.platform === "win32" ? "echo|set /p=shell-ok" : "printf shell-ok",
      }], {
        outputs: { text: "${{ steps.shell.output.stdout }}" },
      }),
      workflow("nonzero", [{ id: "bad", type: "run", command: process.execPath, args: ["-e", "process.exit(9)"] }]),
    ];
    const plans = compilePlans(definitions, root);
    const shell = await runWorkflow(plans.get("shell")!, { invocationCwd: root, plans });
    expect(shell.outputs).toEqual({ text: "shell-ok" });
    const nonzero = await runWorkflow(plans.get("nonzero")!, { invocationCwd: root, plans });
    expect(nonzero).toMatchObject({ status: "failed", failure: { code: "process-exit" } });

    const truncated = await spawnProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(100)); process.stderr.write('y'.repeat(100))"],
      cwd: root,
      maxStreamBytes: 16,
    });
    expect(Buffer.byteLength(truncated.stdout)).toBe(16);
    expect(Buffer.byteLength(truncated.stderr)).toBe(16);
    expect(truncated).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  test("inherits only operational environment keys and applies explicit values", async () => {
    const root = await fixtureRoot();
    process.env.PI_WORKFLOWS_TEST_SECRET = "must-not-leak";
    expect(operationalEnvironment()).not.toHaveProperty("PI_WORKFLOWS_TEST_SECRET");
    const result = await spawnProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({secret:process.env.PI_WORKFLOWS_TEST_SECRET, explicit:process.env.EXPLICIT}))"],
      cwd: root,
      env: { EXPLICIT: "visible" },
    });
    expect(JSON.parse(result.stdout)).toEqual({ explicit: "visible" });
  });

  test.skipIf(process.platform === "win32")("enforces canonical cwd and script descendants", async () => {
    const root = await fixtureRoot();
    const outside = await mkdtemp(join(tmpdir(), "pi-workflows-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "escape.mjs"), "process.stdout.write('escaped')");
    await symlink(outside, join(root, "linked"));
    const definitions = [workflow("escape", [{ id: "script", type: "script", interpreter: process.execPath, file: "linked/escape.mjs" }])];
    const plans = compilePlans(definitions, root);
    const result = await runWorkflow(plans.get("escape")!, { invocationCwd: root, plans });
    expect(result).toMatchObject({ status: "failed", failure: { code: "path-escape" } });
  });

  test.skipIf(process.platform === "win32")("rejects cwd symlink replacement immediately before dispatch", async () => {
    const root = await fixtureRoot();
    const cwd = join(root, "workspace");
    const outside = await mkdtemp(join(tmpdir(), "pi-workflows-dispatch-outside-"));
    roots.push(outside);
    await mkdir(cwd);
    const marker = join(outside, "executed");
    const definition = workflow("dispatch-cwd", [{
      id: "run",
      type: "run",
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
    }], { cwd: "workspace" });
    const plans = compilePlans([definition], root);
    let replaced = false;

    const result = await runWorkflow(plans.get("dispatch-cwd")!, {
      invocationCwd: root,
      plans,
      spawnProcess: async (options) => {
        if (!replaced) {
          replaced = true;
          await rename(options.cwd, `${options.cwd}-original`);
          await symlink(outside, options.cwd);
        }
        return spawnProcess(options);
      },
    });

    expect(result).toMatchObject({ status: "failed", failure: { code: "process-spawn" } });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.platform === "win32")("rejects script symlink replacement immediately before dispatch", async () => {
    const root = await fixtureRoot();
    const scripts = join(root, "scripts");
    const outside = await mkdtemp(join(tmpdir(), "pi-workflows-script-outside-"));
    roots.push(outside);
    await mkdir(scripts);
    const script = join(scripts, "task.mjs");
    const marker = join(outside, "executed");
    const replacement = join(outside, "task.mjs");
    await writeFile(script, "process.stdout.write('safe')");
    await writeFile(replacement, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`);
    const definition = workflow("dispatch-script", [{
      id: "script",
      type: "script",
      interpreter: process.execPath,
      file: "scripts/task.mjs",
    }]);
    const plans = compilePlans([definition], root);
    let replaced = false;

    const result = await runWorkflow(plans.get("dispatch-script")!, {
      invocationCwd: root,
      plans,
      spawnProcess: async (options) => {
        if (!replaced) {
          replaced = true;
          const verified = options.verifiedFiles?.[0];
          if (!verified) throw new Error("compiled scripts must register their dispatch path");
          await rename(verified, `${verified}.original`);
          await symlink(replacement, verified);
        }
        return spawnProcess(options);
      },
    });

    expect(result).toMatchObject({ status: "failed", failure: { code: "process-spawn" } });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("runs a compiled script and applies workflow, step, and nested cwd bases", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "workspace", "tools", "scripts"), { recursive: true });
    await mkdir(join(root, "nested-root"), { recursive: true });
    await writeFile(
      join(root, "workspace", "tools", "scripts", "cwd.mjs"),
      "process.stdout.write(JSON.stringify({cwd:process.cwd(), arg:process.argv[2]}))",
    );
    const child = workflow("child-cwd", [{
      id: "cwd",
      type: "run",
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
    }], { cwd: "nested-root", outputs: { cwd: "${{ steps.cwd.output.stdout }}" } });
    const parent = workflow("script-cwd", [
      {
        id: "script",
        type: "script",
        interpreter: process.execPath,
        file: "scripts/cwd.mjs",
        args: ["two words"],
        cwd: "tools",
      },
      { id: "nested", type: "workflow", workflow: "child-cwd" },
    ], {
      cwd: "workspace",
      outputs: {
        script: "${{ steps.script.output.stdout }}",
        nestedCwd: "${{ steps.nested.output.cwd }}",
      },
    });
    const plans = compilePlans([parent, child], root);
    const result = await runWorkflow(plans.get("script-cwd")!, { invocationCwd: root, plans });

    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.outputs.script as string)).toEqual({
      cwd: await realpath(join(root, "workspace", "tools")),
      arg: "two words",
    });
    expect(result.outputs.nestedCwd).toBe(await realpath(join(root, "nested-root")));
  });

  test.skipIf(process.platform === "win32")("kills a real child and grandchild on timeout", { timeout: 10_000 }, async () => {
    const root = await fixtureRoot();
    const parentPid = join(root, "parent.pid");
    const childPid = join(root, "child.pid");
    const heartbeat = join(root, "heartbeat.log");
    const fixture = resolve(import.meta.dirname, "fixtures/process-tree-parent.mjs");
    const result = await spawnProcess({
      command: process.execPath,
      args: [fixture, parentPid, childPid, heartbeat],
      cwd: root,
      timeoutMs: 500,
      killGraceMs: 100,
    });
    expect(result).toMatchObject({ killed: true, timedOut: true });
    await waitForFile(childPid);
    const pids = [Number(await readFile(parentPid, "utf8")), Number(await readFile(childPid, "utf8"))];
    for (const pid of pids) expect(isLiveProcessInGroup(pid, pids[0])).toBe(false);
    const before = await readFile(heartbeat, "utf8");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    expect(await readFile(heartbeat, "utf8")).toBe(before);
  });

  test.skipIf(process.platform === "win32")("kills a real process tree on AbortSignal cancellation", { timeout: 10_000 }, async () => {
    const root = await fixtureRoot();
    const parentPid = join(root, "parent.pid");
    const childPid = join(root, "child.pid");
    const fixture = resolve(import.meta.dirname, "fixtures/process-tree-parent.mjs");
    const controller = new AbortController();
    const running = spawnProcess({
      command: process.execPath,
      args: [fixture, parentPid, childPid, join(root, "heartbeat.log")],
      cwd: root,
      signal: controller.signal,
      killGraceMs: 100,
    });
    await waitForFile(childPid);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const pids = [Number(await readFile(parentPid, "utf8")), Number(await readFile(childPid, "utf8"))];
    for (const pid of pids) expect(isLiveProcessInGroup(pid, pids[0])).toBe(false);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-process-"));
  roots.push(root);
  await mkdir(join(root, ".pi", "workflows"), { recursive: true });
  return root;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function isLiveProcessInGroup(pid: number, processGroup: number): boolean {
  try {
    const [group, state] = execFileSync("ps", ["-o", "pgid=,stat=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/, 2);
    return Number(group) === processGroup && state !== undefined && !state.startsWith("Z");
  } catch {
    return false;
  }
}
