import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildToolTextResult, type ToolTextResult } from "../cbm/result.js";
import { indexTimeoutMs, queryTimeoutMs } from "../cbm/timeouts.js";
import { isRecord, removeUndefined } from "../shared/object.js";
import type { ToolExecutionContext } from "../domain/project.js";
import type { CbmServices, ToolDefinition } from "./definitions.js";
import { toolDefinitions } from "./definitions.js";
import { renderCall, renderResult } from "./render.js";

const PROXY_COMMANDS = [
  "list_projects",
  "index_status",
  "index_repository",
  "search_graph",
  "search_code",
  "trace_path",
  "query_graph",
  "get_graph_schema",
  "get_code_snippet",
  "get_architecture",
  "detect_changes",
] as const;

type ProxyCommand = (typeof PROXY_COMMANDS)[number];

const COMMAND_SET = new Set<string>(PROXY_COMMANDS);

const UPSTREAM_TOOL_TITLES: Record<ProxyCommand, string> = {
  list_projects: "Indexed projects",
  index_status: "Index status",
  index_repository: "Index repository",
  search_graph: "Graph search results",
  search_code: "Code search results",
  trace_path: "Trace path results",
  query_graph: "Cypher query results",
  get_graph_schema: "Graph schema",
  get_code_snippet: "Code snippet",
  get_architecture: "Architecture overview",
  detect_changes: "Change impact results",
};

const DIRECT_DEFINITION_BY_NAME = new Map(toolDefinitions.map((definition) => [definition.name, definition]));

const COMMAND_DESCRIPTIONS: Record<ProxyCommand, string> = {
  list_projects: "List indexed codebase-memory projects.",
  index_status: "Show indexing status for a project. Omits project to infer the current cwd project.",
  index_repository: "Index a repository. Requires args.repo_path and accepts upstream indexing options.",
  search_graph: DIRECT_DEFINITION_BY_NAME.get("search_graph")?.description ?? "Search graph symbols and structural relationships.",
  search_code: DIRECT_DEFINITION_BY_NAME.get("search_code")?.description ?? "Search indexed source text with graph enrichment.",
  trace_path: DIRECT_DEFINITION_BY_NAME.get("trace_path")?.description ?? "Trace callers, callees, data flow, or cross-service paths.",
  query_graph: DIRECT_DEFINITION_BY_NAME.get("query_graph")?.description ?? "Run a read-only Cypher-like graph query.",
  get_graph_schema: DIRECT_DEFINITION_BY_NAME.get("get_graph_schema")?.description ?? "Inspect graph labels, edge types, and properties.",
  get_code_snippet: DIRECT_DEFINITION_BY_NAME.get("get_code_snippet")?.description ?? "Read source for a known qualified_name.",
  get_architecture: DIRECT_DEFINITION_BY_NAME.get("get_architecture")?.description ?? "Get a high-level architecture overview.",
  detect_changes: DIRECT_DEFINITION_BY_NAME.get("detect_changes")?.description ?? "Analyze local git changes and affected symbols.",
};

function parseArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (isRecord(value)) return value;
  if (typeof value !== "string") throw new Error("cbm args must be a JSON object string.");

  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error("cbm args JSON must parse to an object.");
  return parsed;
}

function requireCommand(value: unknown): ProxyCommand {
  if (typeof value !== "string" || !COMMAND_SET.has(value)) {
    throw new Error(`cbm command must be one of: ${PROXY_COMMANDS.join(", ")}`);
  }
  return value as ProxyCommand;
}

function listCommands(): Record<string, unknown> {
  return {
    commands: PROXY_COMMANDS.map((command) => ({ command, description: COMMAND_DESCRIPTIONS[command] })),
    usage: "cbm({ action: 'describe', command: 'search_graph' }) then cbm({ action: 'call', command: 'search_graph', args: '{\"query\":\"auth\",\"limit\":8}' })",
    direct_helpers: ["read_symbol", "search_and_read_symbols"],
  };
}

function describeCommand(command: ProxyCommand): Record<string, unknown> {
  const direct = DIRECT_DEFINITION_BY_NAME.get(command);
  return removeUndefined({
    command,
    description: COMMAND_DESCRIPTIONS[command],
    input_schema: direct?.parameters,
    notes:
      command === "index_repository"
        ? "Indexing writes to the codebase-memory cache by default. args.persistence=true also writes a portable repo artifact upstream."
        : undefined,
  });
}

async function callRawCbm(
  command: ProxyCommand,
  args: Record<string, unknown>,
  services: CbmServices,
  ctx: ToolExecutionContext,
): Promise<ToolTextResult> {
  const result = await services.cbm.callTool(command, args, {
    signal: ctx.signal,
    timeoutMs: command === "index_repository" ? indexTimeoutMs(args.timeout_ms) : queryTimeoutMs(args.timeout_ms),
    allowError: command === "list_projects",
  });
  return services.output.buildCompactableToolResult(UPSTREAM_TOOL_TITLES[command], result.data, args, {
    tool: command,
    args,
    stderr: result.stderr,
  });
}

async function callCommand(
  command: ProxyCommand,
  args: Record<string, unknown>,
  services: CbmServices,
  ctx: ToolExecutionContext,
): Promise<ToolTextResult> {
  switch (command) {
    case "list_projects":
    case "index_repository":
      return callRawCbm(command, args, services, ctx);

    case "index_status": {
      const withProject = typeof args.project === "string" && args.project.trim()
        ? args
        : { ...args, project: await services.projects.inferProject(ctx.cwd, ctx.signal) };
      return callRawCbm(command, withProject, services, ctx);
    }

    case "query_graph":
      return services.query.queryGraph(args, ctx);

    case "trace_path":
      return services.trace.trace(args, ctx);

    case "search_graph":
      return services.query.executeQueryTool(UPSTREAM_TOOL_TITLES[command], command, { limit: 25, ...args }, ctx);

    case "search_code":
      return services.query.executeQueryTool(UPSTREAM_TOOL_TITLES[command], command, { mode: "compact", context: 2, limit: 10, ...args }, ctx);

    case "get_graph_schema":
    case "get_code_snippet":
    case "get_architecture":
    case "detect_changes":
      return services.query.executeQueryTool(UPSTREAM_TOOL_TITLES[command], command, args, ctx);
  }
}

export function createCbmProxyToolDefinition(): ToolDefinition {
  const describedCommands = new Set<ProxyCommand>();

  return {
    name: "cbm",
    label: "CBM Proxy",
    description: "Proxy to codebase-memory commands without exposing every upstream command as a separate Pi tool.",
    promptSnippet: "Call codebase-memory commands through one compact proxy: list, describe, or call a command with JSON args",
    promptGuidelines: [
      "Use cbm for codebase-memory graph commands that are not exposed as direct helper tools.",
      "Use cbm action='list' to see available commands and action='describe' before calling an unfamiliar command.",
      "For cbm action='call', pass args as a JSON object string, for example args: '{\"query\":\"auth\",\"limit\":8}'.",
      "Prefer direct read_symbol and search_and_read_symbols for symbol source workflows; use cbm for graph search, traces, architecture, schema, exact text search, Cypher, and change impact.",
    ],
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["list", "describe", "call"] as const, { default: "call" })),
      command: Type.Optional(StringEnum(PROXY_COMMANDS, { description: "codebase-memory command to describe or call." })),
      args: Type.Optional(Type.String({ description: "JSON object string passed as command arguments. Omit or use '{}' for no args." })),
    }),
    async execute(params, services, ctx) {
      const action = typeof params.action === "string" ? params.action : params.command ? "call" : "list";

      if (action === "list") {
        return buildToolTextResult("codebase-memory commands", listCommands(), { tool: "cbm", action });
      }

      const command = requireCommand(params.command);
      if (action === "describe") {
        describedCommands.add(command);
        return buildToolTextResult("codebase-memory command", describeCommand(command), { tool: "cbm", action, command });
      }

      if (action !== "call") throw new Error("cbm action must be list, describe, or call.");

      try {
        return await callCommand(command, parseArgs(params.args), services, ctx);
      } catch (error) {
        if (describedCommands.has(command)) throw error;
        describedCommands.add(command);

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n\nCommand description:\n${JSON.stringify(describeCommand(command), null, 2)}`);
      }
    },
    renderCall: renderCall("cbm", (args) => `${String(args.action ?? "call")} ${String(args.command ?? "")}`.trim()),
    renderResult: renderResult("cbm"),
  };
}
