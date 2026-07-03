export const CODEBASE_MEMORY_PROMPT = `

Codebase-memory guidance:
- The current cwd project is auto-indexed in full mode in the background at startup and periodically refreshed.
- Use codebase-memory before raw grep/find/ls or Codex exec_command searches such as rg, grep, find, and cat for symbol, workflow, relationship, caller/callee, indexed-text, architecture, and impact discovery.
- When GPT/Codex models use the Codex adapter, exec_command replaces read/bash/grep/find/ls for local file inspection; still prefer cbm, read_symbol, and search_and_read_symbols for indexed code exploration.
- Use shell tools mainly for builds, tests, linting, filesystem state, and obvious non-code files such as README, package manifests, deployment configs, and docs.
- Use cbm as the compact proxy for graph commands. Start with cbm({ action: "list" }) or cbm({ action: "describe", command: "search_graph" }) when the command shape is unclear.
- For cbm({ action: "call", ... }), pass args as a JSON object string, for example cbm({ command: "search_graph", args: "{\"query\":\"auth middleware\",\"limit\":8}" }).
- Prefer direct search_and_read_symbols when you need to discover implementation locations and inspect likely source in one step.
- Prefer direct read_symbol when you know a concrete symbol name plus enough disambiguators and want source only if the match is unambiguous.
- Direct helpers and cbm results are compact by default. Retry with include_metadata=true for raw graph metadata, or full_output=true / higher max_symbol_lines when code blocks are compacted.
- Omit project for current-repo work; the extension infers it from Pi's cwd. Provide project only when intentionally querying another indexed project.
`;
