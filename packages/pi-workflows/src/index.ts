import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCatalogTool } from "./extension/catalog-tool.js";
import { registerWorkflowCommand } from "./extension/command.js";
import { registerWorkflowPromptGuidance } from "./extension/prompt.js";
import {
  createWorkflowChildSession,
  type WorkflowChildSessionFactory,
} from "./runtime/child-session.js";

export { createWorkflowChildSession } from "./runtime/child-session.js";

export function createPiWorkflowsExtension(
  createChildSession: WorkflowChildSessionFactory = createWorkflowChildSession,
) {
  return function piWorkflows(pi: ExtensionAPI): void {
    let cwd = process.cwd();
    const commands = registerWorkflowCommand(pi, createChildSession);
    registerWorkflowCatalogTool(pi, () => cwd);
    registerWorkflowPromptGuidance(pi, () => commands.isActive());

    pi.on("session_start", (_event, ctx) => {
      cwd = ctx.cwd;
      commands.sessionStart(ctx);
    });

    pi.on("session_shutdown", async () => {
      await commands.shutdown();
    });
  };
}

export default createPiWorkflowsExtension();
