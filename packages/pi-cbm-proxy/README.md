# pi-cbm-proxy

Local Pi package copied from `pi-cbm` and adapted for a smaller tool prompt.

It keeps the useful Pi-native lifecycle from `pi-cbm`:

- auto-index the current git root, or a safe non-git cwd when enabled;
- refresh the current project periodically;
- infer the current project from Pi's cwd;
- compact codebase-memory output by default;
- inject concise codebase-memory guidance.

It exposes only three tools:

- `cbm` — one compact proxy for upstream codebase-memory commands;
- `read_symbol` — resolve and read a symbol only when unambiguous;
- `search_and_read_symbols` — search likely symbols and read the top matches in one call.

The proxy supports:

```js
cbm({ action: "list" })
cbm({ action: "describe", command: "search_graph" })
cbm({ action: "call", command: "search_graph", args: "{\"query\":\"auth\",\"limit\":8}" })
```

`args` is a JSON object string.

## Requirements

Install `codebase-memory-mcp` first:

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

If the binary is not on `PATH`, set:

```sh
export CODEBASE_MEMORY_MCP_BIN="$HOME/.local/bin/codebase-memory-mcp"
```

## Install locally from this monorepo

```sh
pi install ./packages/pi-cbm-proxy
```

Avoid installing this package together with `pi-cbm`, `pi-codebase-memory-mcp`, or another codebase-memory Pi adapter in the same session, otherwise duplicate tools and conflicting guidance may appear.

## Commands

`/cbm` opens the copied `pi-cbm` settings menu for auto-index behavior.

