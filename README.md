# pi-extensions

Monorepo for [pi](https://github.com/mariozechner/pi-coding-agent) extensions.

Remote: `git@github.com:mslavov/pi-extensions.git`

## Packages

| Package | Description |
|---------|-------------|
| [pi-autocomplete](packages/pi-autocomplete/) | Includes gitignored files in pi's `@` file autocomplete |
| [pi-context](packages/pi-context/) | Displays current pi context window usage with `/context` |
| [pi-headroom](packages/pi-headroom/) | Transparent LLM context compression using Headroom |
| [pi-markitdown](packages/pi-markitdown/) | Reads PDFs, Office files, images, and other non-text files as Markdown via MarkItDown |
| [pi-plan-mode](packages/pi-plan-mode/) | Structured planning via scout/planner subagents with task tracking |
| [pi-powerline](packages/pi-powerline/) | Configurable Powerline-style footer for pi |
| [pi-progressive-context](packages/pi-progressive-context/) | Lazy nested AGENTS.md / CLAUDE.md context loading for pi |
| [pi-subagents](packages/pi-subagents/) | Patched fork of `@tintinweb/pi-subagents` for autonomous sub-agents in pi |
| [pi-todo-write](packages/pi-todo-write/) | TodoWrite tool for structured task list management in coding sessions |

## Setup

```bash
bun install
```

## Scripts

```bash
bun run check   # Type-check all packages
bun run build   # Build all packages (pi compiles TypeScript directly)
bun run clean   # Clean package build artifacts
```

## Development

Each package is an independent pi extension with a `pi.extensions` entry in its `package.json`.

Load a package directly during development:

```bash
pi -e ./packages/pi-plan-mode
```

Or add local packages to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../workspace/pi-extensions/packages/pi-subagents",
    "../../workspace/pi-extensions/packages/pi-context",
    "../../workspace/pi-extensions/packages/pi-headroom",
    "../../workspace/pi-extensions/packages/pi-todo-write",
    "../../workspace/pi-extensions/packages/pi-plan-mode",
    "../../workspace/pi-extensions/packages/pi-powerline",
    "../../workspace/pi-extensions/packages/pi-markitdown",
    "../../workspace/pi-extensions/packages/pi-autocomplete",
    "../../workspace/pi-extensions/packages/pi-progressive-context"
  ]
}
```

## Publishing

Each publishable package has `"keywords": ["pi-package"]` and a `"pi"` field, making it installable via:

```bash
pi install npm:<package-name>
```

## Agent instructions

Repository-level coding-agent instructions live in [`AGENTS.md`](AGENTS.md).

## License

MIT
