import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolDefinitions, type CbmServices } from "./definitions.js";
import { createCbmProxyToolDefinition } from "./proxy.js";

const DIRECT_TOOL_NAMES = new Set(["read_symbol", "search_and_read_symbols"]);

export function registerCodebaseMemoryTools(pi: ExtensionAPI, services: CbmServices) {
  for (const definition of [createCbmProxyToolDefinition(), ...toolDefinitions.filter((tool) => DIRECT_TOOL_NAMES.has(tool.name))]) {
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: definition.promptGuidelines,
      parameters: definition.parameters as any,
      async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
        return definition.execute(params, services, { cwd: ctx.cwd, signal: ctx.signal });
      },
      renderCall: definition.renderCall as any,
      renderResult: definition.renderResult as any,
    });
  }
}
