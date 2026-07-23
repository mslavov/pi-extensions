import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

export const WORKFLOW_CHILD_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface WorkflowChildSessionOptions {
  cwd: string;
  agentDir?: string;
}

export interface WorkflowChildSessionInspection {
  activeTools: string[];
  allToolSources: Array<{ name: string; source: string }>;
  contextFiles: string[];
  extensionCount: number;
  model: string | null;
  promptCount: number;
  runtime: { bun: boolean; name: string };
  sessionFile: string | null;
  skillCount: number;
}

export interface WorkflowChildSession {
  readonly session: AgentSession;
  abort(): Promise<void>;
  dispose(): void;
  inspect(): WorkflowChildSessionInspection;
}

export type WorkflowChildSessionFactory = (
  options: WorkflowChildSessionOptions,
) => Promise<WorkflowChildSession>;

export const createWorkflowChildSession: WorkflowChildSessionFactory = async ({ cwd, agentDir }) => {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(agentDir ?? getAgentDir());
  const settingsManager = SettingsManager.create(resolvedCwd, resolvedAgentDir);
  const authStorage = AuthStorage.create(join(resolvedAgentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(resolvedAgentDir, "models.json"));
  const resourceLoader = new DefaultResourceLoader({
    cwd: resolvedCwd,
    agentDir: resolvedAgentDir,
    settingsManager,
    noExtensions: true,
    extensionsOverride: (loaded) => ({ ...loaded, extensions: [] }),
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd: resolvedCwd,
    agentDir: resolvedAgentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(resolvedCwd),
    settingsManager,
    tools: [...WORKFLOW_CHILD_TOOL_NAMES],
    customTools: [],
  });

  if (created.extensionsResult.extensions.length !== 0) {
    created.session.dispose();
    throw new Error("Workflow child sessions must not load extensions");
  }

  const activeTools = created.session.getActiveToolNames();
  if (activeTools.join("\0") !== WORKFLOW_CHILD_TOOL_NAMES.join("\0")) {
    created.session.dispose();
    throw new Error(`Workflow child tool isolation failed: ${activeTools.join(", ")}`);
  }

  let disposed = false;

  return {
    session: created.session,
    async abort() {
      await created.session.abort();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      created.session.dispose();
    },
    inspect() {
      const model = created.session.model;
      return {
        activeTools: created.session.getActiveToolNames(),
        allToolSources: created.session.getAllTools().map((tool) => ({
          name: tool.name,
          source: tool.sourceInfo.source,
        })),
        contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path),
        extensionCount: created.extensionsResult.extensions.length,
        model: model ? `${model.provider}/${model.id}` : null,
        promptCount: resourceLoader.getPrompts().prompts.length,
        runtime: { bun: process.versions.bun !== undefined, name: process.release.name },
        sessionFile: created.session.sessionFile ?? null,
        skillCount: resourceLoader.getSkills().skills.length,
      };
    },
  };
};
