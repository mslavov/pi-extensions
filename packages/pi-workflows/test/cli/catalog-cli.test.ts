import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("catalog CLI", () => {
  test("lists and validates through stable JSON without creating a child session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflows-cli-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const workflows = join(cwd, ".pi", "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, "valid.yaml"), `version: 1
id: valid
steps:
  - id: done
    type: set
    values: { ok: true }
`);
    const childFactory = () => {
      throw new Error("catalog commands must not create an agent session");
    };

    const listOutput: string[] = [];
    const listCode = await runCli(
      ["list", "--cwd", cwd, "--agent-dir", agentDir, "--json"],
      { stdout: (text) => listOutput.push(text), stderr: (text) => listOutput.push(text) },
      childFactory,
    );
    expect(listCode).toBe(0);
    expect(JSON.parse(listOutput.join(""))).toMatchObject({
      command: "list",
      version: 1,
      workflows: [{ id: "valid", status: "effective" }],
    });

    const validateOutput: string[] = [];
    const validateCode = await runCli(
      ["validate", "valid", "--cwd", cwd, "--agent-dir", agentDir, "--json"],
      { stdout: (text) => validateOutput.push(text), stderr: (text) => validateOutput.push(text) },
      childFactory,
    );
    expect(validateCode).toBe(0);
    expect(JSON.parse(validateOutput.join(""))).toMatchObject({
      command: "validate",
      version: 1,
      workflowId: "valid",
      valid: true,
    });
  });

  test("returns validation failure for an invalid project workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflows-cli-invalid-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const workflows = join(cwd, ".pi", "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, "invalid.yaml"), "version: 1\nid: invalid\nsteps: []\n");
    const output: string[] = [];

    const code = await runCli(
      ["validate", "invalid", "--cwd", cwd, "--agent-dir", agentDir],
      { stdout: (text) => output.push(text), stderr: (text) => output.push(text) },
    );
    expect(code).toBe(2);
    expect(output.join("")).toContain("Validation failed.");
  });
});
