import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createWorkflowChildSession } from "../../src/runtime/child-session.js";

const temporaryRoots: string[] = [];
const packageRoot = resolve(import.meta.dirname, "../..");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("packed Node CLI", () => {
  test("packs, installs cleanly, and executes the installed bin without Bun", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflows-pack-"));
    temporaryRoots.push(root);
    const packDir = join(root, "pack");
    const installDir = join(root, "install");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const npmCache = join(root, "npm-cache");
    await Promise.all([mkdir(packDir), mkdir(installDir), mkdir(cwd), mkdir(agentDir)]);

    run("npm", ["pack", "--silent", "--pack-destination", packDir], packageRoot, npmCache);
    const tarball = join(packDir, "pi-workflows-0.1.0.tgz");
    run("npm", ["init", "--yes"], installDir, npmCache);
    run("npm", ["install", "--ignore-scripts", tarball], installDir, npmCache);

    const cli = join(installDir, "node_modules", ".bin", process.platform === "win32" ? "pi-workflows.cmd" : "pi-workflows");
    if (process.platform !== "win32") await chmod(cli, 0o755);
    const result = run(cli, ["inspect", "--cwd", cwd, "--agent-dir", agentDir], installDir, npmCache);
    const inspection = JSON.parse(result.stdout);

    expect(inspection.runtime).toEqual({ bun: false, name: "node" });
    expect(inspection.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(inspection.extensionCount).toBe(0);
    expect(inspection.sessionFile).toBeNull();

    const installedPackage = join(installDir, "node_modules", "pi-workflows");
    const builtCli = await readFile(join(installedPackage, "dist", "cli.js"), "utf8");
    expect(builtCli.startsWith("#!/usr/bin/env node")).toBe(true);

    const manifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
    expect(manifest.pi.skills).toEqual(["./skills"]);
    expect(await readFile(join(installedPackage, "skills", "workflow-authoring", "SKILL.md"), "utf8"))
      .toContain("name: workflow-authoring");

    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [installedPackage] }));
    const child = await createWorkflowChildSession({ cwd, agentDir });
    try {
      expect(child.inspect()).toMatchObject({
        activeTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        extensionCount: 0,
      });
      expect(child.inspect().skillCount).toBeGreaterThan(0);
      expect(child.inspect().activeTools).not.toContain("workflow_catalog");
    } finally {
      child.dispose();
    }

    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionsOverride: (loaded) => ({ ...loaded, extensions: [] }),
    });
    await loader.reload();
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toContainEqual(expect.objectContaining({
      name: "workflow-authoring",
      filePath: join(installedPackage, "skills", "workflow-authoring", "SKILL.md"),
    }));
  }, 120_000);
});

function run(command: string, args: string[], cwd: string, npmCache: string): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
