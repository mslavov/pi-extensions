import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatList,
  formatValidation,
  listWorkflows,
  validateWorkflows,
} from "../commands/catalog.js";

const MAX_CATALOG_TOOL_BYTES = 32 * 1024;

const CatalogToolParameters = Type.Object({
  action: Type.String({
    enum: ["list", "validate"],
    description: "Read-only catalog action.",
  }),
  workflowId: Type.Optional(Type.String({ description: "Optional workflow ID for validate." })),
}, { additionalProperties: false });

interface CatalogToolDetails {
  action: "list" | "validate";
  workflowId: string | null;
  valid: boolean | null;
  workflowCount: number;
  diagnosticCount: number;
  truncated: boolean;
}

export function registerWorkflowCatalogTool(
  pi: ExtensionAPI,
  getCwd: () => string,
): void {
  const tool: ToolDefinition<typeof CatalogToolParameters, CatalogToolDetails> = {
    name: "workflow_catalog",
    label: "Workflow Catalog",
    description: "List or validate pi-workflows definitions. This tool is read-only and cannot execute workflows.",
    promptSnippet: "List or validate reusable workflows without executing them",
    promptGuidelines: [
      "Use workflow_catalog only to inspect or validate workflows; it cannot run them.",
    ],
    parameters: CatalogToolParameters,
    async execute(_toolCallId, params) {
      const action = params.action as "list" | "validate";
      if (action === "list") {
        if (params.workflowId !== undefined) throw new Error("workflowId is only valid for the validate action");
        const result = await listWorkflows({ cwd: getCwd() });
        const bounded = boundToolText(formatList(result));
        return {
          content: [{ type: "text", text: bounded.text }],
          details: {
            action: "list" as "list" | "validate",
            workflowId: null,
            valid: null,
            workflowCount: result.workflows.length,
            diagnosticCount: result.diagnostics.length,
            truncated: bounded.truncated,
          },
        };
      }

      const result = await validateWorkflows(params.workflowId, { cwd: getCwd() });
      const bounded = boundToolText(formatValidation(result));
      return {
        content: [{ type: "text", text: bounded.text }],
        details: {
          action: "validate" as "list" | "validate",
          workflowId: params.workflowId ?? null,
          valid: result.valid,
          workflowCount: result.workflows.length,
          diagnosticCount: result.diagnostics.length,
          truncated: bounded.truncated,
        },
      };
    },
  };
  pi.registerTool(tool);
}

function boundToolText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_CATALOG_TOOL_BYTES) return { text, truncated: false };
  const marker = "\n[workflow catalog output truncated]\n";
  const bytes = MAX_CATALOG_TOOL_BYTES - Buffer.byteLength(marker);
  return {
    text: `${truncateUtf8(text, bytes)}${marker}`,
    truncated: true,
  };
}

function truncateUtf8(value: string, bytes: number): string {
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/\uFFFD$/u, "");
}
