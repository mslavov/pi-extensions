import type { CbmClient } from "../cbm/client.js";
import { isRecord } from "../shared/object.js";
import type { ProjectService, ToolExecutionContext } from "../domain/project.js";

const AUGMENT_TIMEOUT_MS = 1_500;
const RESULT_LIMIT = 5;
const MIN_TOKEN_LENGTH = 4;
const MAX_TOKEN_LENGTH = 96;
const MAX_CONTEXT_CHARS = 2_000;

const STANDARD_SEARCH_TOOLS = new Set(["grep", "find"]);
const SHELL_SEARCH_TOOLS = new Set(["bash", "exec_command"]);
const CBM_TOOLS = new Set(["cbm", "read_symbol", "search_and_read_symbols"]);
const SHELL_SEARCH_COMMANDS = new Set(["rg", "grep", "find", "fd"]);
const STOP_TOKENS = new Set([
  "async",
  "await",
  "bash",
  "class",
  "const",
  "export",
  "false",
  "find",
  "from",
  "function",
  "grep",
  "import",
  "interface",
  "null",
  "packages",
  "return",
  "true",
  "type",
  "undefined",
]);

type TextContent = { type: "text"; text: string };
type ToolContent = TextContent | { type: string; [key: string]: unknown };

export type AugmentableToolResult = {
  toolName: string;
  input: unknown;
  content: ToolContent[];
  isError: boolean;
};

export type AugmentationOutcome =
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string }
  | { status: "matched"; token: string; addedContext: string; estimatedTokens: number; content: ToolContent[] };

type SearchRequest = {
  token: string;
  source: string;
};

type SearchCandidate = {
  qualified_name?: unknown;
  name?: unknown;
  file_path?: unknown;
  label?: unknown;
  start_line?: unknown;
  end_line?: unknown;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function commandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return stringValue(input.command) ?? stringValue(input.cmd);
}

function isTextContent(content: ToolContent): content is TextContent {
  return content.type === "text" && typeof (content as { text?: unknown }).text === "string";
}

function basename(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words.filter(Boolean);
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function extractToken(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;

  let best = "";
  for (const match of pattern.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const token = match[0]!.slice(0, MAX_TOKEN_LENGTH);
    if (token.length < MIN_TOKEN_LENGTH || STOP_TOKENS.has(token.toLowerCase())) continue;
    if (token.length > best.length) best = token;
  }
  return best || undefined;
}

function patternFromStandardTool(toolName: string, input: unknown): string | undefined {
  if (!STANDARD_SEARCH_TOOLS.has(toolName) || !isRecord(input)) return undefined;
  return stringValue(input.pattern);
}

function patternFromShellCommand(command: string): string | undefined {
  const words = shellWords(command);
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const commandName = basename(word);
    if (!SHELL_SEARCH_COMMANDS.has(commandName)) continue;

    if (commandName === "find") return findPattern(words.slice(index + 1));
    return grepLikePattern(words.slice(index + 1));
  }
  return undefined;
}

function grepLikePattern(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "-e" || word === "--regexp") return words[index + 1];
    if (word.startsWith("-e") && word.length > 2) return word.slice(2);
    if (word.startsWith("-")) continue;
    if (looksLikePath(word)) continue;
    return word;
  }
  return undefined;
}

function findPattern(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "-name" || word === "-iname" || word === "-path" || word === "-ipath") return words[index + 1];
  }
  return undefined;
}

function classifySearch(event: AugmentableToolResult): SearchRequest | undefined {
  if (event.isError || CBM_TOOLS.has(event.toolName) || event.toolName === "read") return undefined;

  const standardPattern = patternFromStandardTool(event.toolName, event.input);
  const standardToken = extractToken(standardPattern);
  if (standardToken) return { token: standardToken, source: event.toolName };

  if (!SHELL_SEARCH_TOOLS.has(event.toolName)) return undefined;
  const command = commandFromInput(event.input);
  const shellToken = extractToken(patternFromShellCommand(command ?? ""));
  return shellToken ? { token: shellToken, source: event.toolName } : undefined;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchResults(data: unknown): SearchCandidate[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  return data.results.filter(isRecord);
}

function displayString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayNumber(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function formatContext(token: string, results: SearchCandidate[]): string {
  const lines = [`[codebase-memory] ${results.length} graph symbol(s) match "${token}" (structured context; original search result preserved):`];
  for (const result of results.slice(0, RESULT_LIMIT)) {
    const name = displayString(result.qualified_name) ?? displayString(result.name) ?? "unknown";
    const filePath = displayString(result.file_path);
    const label = displayString(result.label);
    const startLine = displayNumber(result.start_line);
    const endLine = displayNumber(result.end_line);
    const location = filePath ? `${filePath}${startLine ? `:${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ""}` : ""}` : "";
    lines.push(`- ${name}${location ? `  ${location}` : ""}${label ? `  ${label}` : ""}`);
  }
  return lines.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function appendContext(content: ToolContent[], context: string): ToolContent[] | undefined {
  const index = content.findLastIndex(isTextContent);
  if (index === -1) return undefined;

  return content.map((item, itemIndex) => {
    if (itemIndex !== index || !isTextContent(item)) return item;
    return { ...item, text: `${item.text}\n\n---\n${context}` };
  });
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class CbmAugmentService {
  constructor(
    private readonly cbm: CbmClient,
    private readonly projects: ProjectService,
  ) {}

  async augmentResult(event: AugmentableToolResult, ctx: ToolExecutionContext): Promise<AugmentationOutcome> {
    try {
      const request = classifySearch(event);
      if (!request) return { status: "skipped", reason: "not a supported regular search" };

      const project = await this.projects.inferProject(ctx.cwd, ctx.signal);
      const result = await this.cbm.callTool(
        "search_graph",
        { project, name_pattern: `.*${regexEscape(request.token)}.*`, limit: RESULT_LIMIT },
        { signal: ctx.signal, timeoutMs: AUGMENT_TIMEOUT_MS, allowError: true },
      );

      if (!result.ok) return { status: "skipped", reason: "search_graph unavailable" };

      const results = searchResults(result.data).slice(0, RESULT_LIMIT);
      if (results.length === 0) return { status: "skipped", reason: "no graph matches" };

      const addedContext = formatContext(request.token, results);
      const content = appendContext(event.content, addedContext);
      if (!content) return { status: "skipped", reason: "no text result to augment" };

      return { status: "matched", token: request.token, addedContext, estimatedTokens: estimateTokens(addedContext), content };
    } catch (error) {
      return { status: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
