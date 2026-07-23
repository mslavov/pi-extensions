import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowChildSession,
  WORKFLOW_CHILD_TOOL_NAMES,
} from "../../src/runtime/child-session.js";
import {
  deferredTextResponse,
  errorResponse,
  registerControlledProvider,
  textResponse,
  toolResponse,
  writeControlledAgentConfig,
} from "./fixtures.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workflow child session feasibility", () => {
  test("loads standard resources while excluding extensions and custom tools", async () => {
    const { root, cwd, agentDir } = await fixtureRoot();
    await writeFile(join(cwd, "AGENTS.md"), "project context");
    await mkdir(join(cwd, ".pi", "skills", "project-skill"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\ndescription: fixture\n---\nfixture",
    );
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    await writeFile(join(cwd, ".pi", "prompts", "fixture.md"), "Fixture prompt");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "must-not-load.ts"),
      `throw new Error("isolated extension executed from ${root}");`,
    );

    const child = await createWorkflowChildSession({ cwd, agentDir });
    try {
      const inspection = child.inspect();
      expect(inspection.sessionFile).toBeNull();
      expect(inspection.extensionCount).toBe(0);
      expect(inspection.activeTools).toEqual(WORKFLOW_CHILD_TOOL_NAMES);
      expect(inspection.allToolSources).toHaveLength(WORKFLOW_CHILD_TOOL_NAMES.length);
      expect(inspection.allToolSources.every((tool) => tool.source === "builtin")).toBe(true);
      expect(inspection.contextFiles).toContain(join(cwd, "AGENTS.md"));
      expect(inspection.skillCount).toBeGreaterThanOrEqual(1);
      expect(inspection.promptCount).toBeGreaterThanOrEqual(1);
    } finally {
      child.dispose();
    }
  });

  test("awaits retry, a real built-in tool turn, and the final response across two prompts", async () => {
    const { cwd, agentDir } = await fixtureRoot();
    await writeControlledAgentConfig(agentDir);
    await writeFile(join(cwd, "tool-input.txt"), "controlled tool result");
    const finalTurnStarted = Promise.withResolvers<void>();
    const releaseFinal = Promise.withResolvers<void>();
    const provider = registerControlledProvider((_context, call) => {
      if (call === 1) return errorResponse("503 service unavailable");
      if (call === 2) return toolResponse("read", { path: "tool-input.txt" });
      if (call === 3) {
        finalTurnStarted.resolve();
        return deferredTextResponse("first prompt complete", releaseFinal.promise);
      }
      return textResponse("second prompt retained context");
    });
    const child = await createWorkflowChildSession({ cwd, agentDir });
    const events: string[] = [];
    child.session.subscribe((event) => events.push(event.type));

    try {
      expect(child.inspect().model).toBe("controlled/controlled-model");
      let firstResolved = false;
      const firstPrompt = child.session.prompt("first prompt").then(() => {
        firstResolved = true;
      });
      await finalTurnStarted.promise;
      await Promise.resolve();
      expect(firstResolved).toBe(false);
      releaseFinal.resolve();
      await firstPrompt;

      expect(events).toContain("auto_retry_start");
      expect(events).toContain("tool_execution_end");
      expect(child.session.getLastAssistantText()).toBe("first prompt complete");

      await child.session.prompt("second prompt");
      expect(child.session.getLastAssistantText()).toBe("second prompt retained context");
      expect(provider.contexts).toHaveLength(4);
      const secondPromptContext = provider.contexts[3].messages;
      expect(secondPromptContext.some((message) => message.role === "assistant" &&
        message.content.some((content) => content.type === "text" && content.text === "first prompt complete"))).toBe(true);
      expect(secondPromptContext.some((message) => message.role === "user" &&
        JSON.stringify(message.content).includes("second prompt"))).toBe(true);
    } finally {
      child.dispose();
      provider.unregister();
    }
  });

  test("awaits abort and disposes the SDK session exactly once", async () => {
    const { cwd, agentDir } = await fixtureRoot();
    const child = await createWorkflowChildSession({ cwd, agentDir });
    const abortRelease = Promise.withResolvers<void>();
    const abortSpy = vi.spyOn(child.session, "abort").mockImplementation(async () => {
      await abortRelease.promise;
    });
    const disposeSpy = vi.spyOn(child.session, "dispose");

    let abortResolved = false;
    const abort = child.abort().then(() => {
      abortResolved = true;
    });
    await Promise.resolve();
    expect(abortResolved).toBe(false);
    abortRelease.resolve();
    await abort;
    expect(abortSpy).toHaveBeenCalledOnce();

    child.dispose();
    child.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});

async function fixtureRoot(): Promise<{ root: string; cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-feasibility-"));
  temporaryRoots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}
