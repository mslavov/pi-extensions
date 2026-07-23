import { afterEach, describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflowCatalog } from "../../src/catalog/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workflow catalog", () => {
  test("scans direct yaml files only and keeps effective plus shadowed provenance", async () => {
    const fixture = await setup();
    await writeWorkflow(fixture.user, "shared.yaml", "shared", "user");
    await writeWorkflow(fixture.project, "shared.yaml", "shared", "project");
    await mkdir(join(fixture.project, "nested"));
    await writeWorkflow(join(fixture.project, "nested"), "ignored.yaml", "ignored", "nested");

    const catalog = await discoverWorkflowCatalog(fixture.options);
    expect(catalog.workflows).toHaveLength(1);
    expect(catalog.workflows[0]).toMatchObject({
      id: "shared",
      blocked: false,
      effective: { source: { scope: "project", path: join(fixture.project, "shared.yaml") } },
      shadowed: [{ source: { scope: "user", path: join(fixture.user, "shared.yaml") } }],
    });
  });

  test("blocks user fallback when a project override is invalid", async () => {
    const fixture = await setup();
    await writeWorkflow(fixture.user, "shared.yaml", "shared", "user");
    await writeFile(join(fixture.project, "shared.yaml"), `version: 1
id: shared
unknown: true
steps:
  - id: done
    type: set
    values: { source: project }
`);

    const catalog = await discoverWorkflowCatalog(fixture.options);
    expect(catalog.workflows[0]).toMatchObject({
      id: "shared",
      blocked: true,
      effective: undefined,
      blocking: [{ source: { scope: "project", path: join(fixture.project, "shared.yaml") } }],
    });
    expect(catalog.workflows[0].shadowed[0].source.scope).toBe("user");
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({
      code: "schema-unknown-field",
      source: join(fixture.project, "shared.yaml"),
      line: 3,
    }));
  });

  test("rejects duplicate IDs within one scope", async () => {
    const fixture = await setup();
    await writeWorkflow(fixture.project, "one.yaml", "duplicate", "one");
    await writeWorkflow(fixture.project, "two.yaml", "duplicate", "two");

    const catalog = await discoverWorkflowCatalog(fixture.options);
    expect(catalog.workflows[0]).toMatchObject({ id: "duplicate", blocked: true });
    expect(catalog.diagnostics.filter((item) => item.code === "catalog-duplicate-id")).toHaveLength(2);
  });

  test("blocks callers when their effective nested workflow fails semantic validation", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.project, "child.yaml"), `version: 1
id: child
steps:
  - id: broken
    type: set
    values: { value: "\${{ steps.future.status }}" }
`);
    await writeFile(join(fixture.project, "parent.yaml"), `version: 1
id: parent
steps:
  - id: child
    type: workflow
    workflow: child
`);

    const catalog = await discoverWorkflowCatalog(fixture.options);
    expect(catalog.workflows.find((workflow) => workflow.id === "child")?.blocked).toBe(true);
    expect(catalog.workflows.find((workflow) => workflow.id === "parent")?.blocked).toBe(true);
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: "workflow-nested-invalid" }));
  });

  test.skipIf(process.platform === "win32")("rejects symlinked definitions without executing their commands", async () => {
    const fixture = await setup();
    const marker = join(fixture.root, "must-not-exist");
    const outside = join(fixture.root, "outside.yaml");
    await writeFile(outside, `version: 1
id: linked
steps:
  - id: command
    type: shell
    command: touch ${marker}
`);
    await symlink(outside, join(fixture.project, "linked.yaml"));

    const catalog = await discoverWorkflowCatalog(fixture.options);
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: "catalog-symlink" }));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.platform === "win32")("rejects a symlinked catalog root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflows-root-link-"));
    roots.push(root);
    const cwd = join(root, "project-root");
    const agentDir = join(root, "agent");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(join(cwd, ".pi"), { recursive: true }),
      mkdir(join(agentDir, "workflows"), { recursive: true }),
      mkdir(outside),
    ]);
    await symlink(outside, join(cwd, ".pi", "workflows"));

    const catalog = await discoverWorkflowCatalog({ cwd, agentDir });
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: "catalog-root-symlink" }));
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-catalog-"));
  roots.push(root);
  const cwd = join(root, "project-root");
  const agentDir = join(root, "agent");
  const user = join(agentDir, "workflows");
  const project = join(cwd, ".pi", "workflows");
  await Promise.all([mkdir(user, { recursive: true }), mkdir(project, { recursive: true })]);
  return { root, cwd, agentDir, user, project, options: { cwd, agentDir } };
}

async function writeWorkflow(directory: string, file: string, id: string, value: string): Promise<void> {
  await writeFile(join(directory, file), `version: 1
id: ${id}
steps:
  - id: done
    type: set
    values: { source: ${value} }
`);
}
