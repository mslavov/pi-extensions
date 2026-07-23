# pi-extensions

Monorepo for [pi](https://github.com/earendil-works/pi-mono) extensions.

Remote: `git@github.com:mslavov/pi-extensions.git`

## Packages

| Package | Description |
|---------|-------------|
| [pi-autocomplete](packages/pi-autocomplete/) | Includes gitignored files in pi's `@` file autocomplete |
| [pi-claude-code](packages/pi-claude-code/) | Loads Claude Code slash commands as skills and Claude Code subagents as pi subagents |
| [pi-context](packages/pi-context/) | Displays current pi context window usage with `/context` |
| [pi-headroom](packages/pi-headroom/) | Transparent LLM context compression using Headroom |
| [pi-markitdown](packages/pi-markitdown/) | Reads PDFs, Office files, images, and other non-text files as Markdown via MarkItDown |
| [pi-plan-mode](packages/pi-plan-mode/) | Adaptive HTML planning with cost-aware delegation, review, and Beads execution handoff |
| [pi-prewalk](packages/pi-prewalk/) | Plans and starts with the current model, then hands completion to Luna in the same session |
| [pi-powerline](packages/pi-powerline/) | Configurable Powerline-style footer for pi |
| [pi-prompt-history](packages/pi-prompt-history/) | Ctrl+R prompt history picker across projects, project, or session |
| [pi-progressive-context](packages/pi-progressive-context/) | Lazy nested AGENTS.md / CLAUDE.md context loading for pi |
| [pi-workflows](packages/pi-workflows/) | Strict YAML workflows for interactive pi, RPC clients, and a standalone Node CLI |
| [pi-subagents](packages/pi-subagents/) | Patched fork of `@tintinweb/pi-subagents` for autonomous sub-agents in pi |
| [pi-beads](packages/pi-beads/) | Display current-project Beads task status in the TUI |
| [pi-casper](packages/pi-casper/) | Slack Socket Mode bridge that maps local pi sessions to Slack channels |
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
    "../../workspace/pi-extensions/packages/pi-claude-code",
    "../../workspace/pi-extensions/packages/pi-context",
    "../../workspace/pi-extensions/packages/pi-headroom",
    "../../workspace/pi-extensions/packages/pi-beads",
    "../../workspace/pi-extensions/packages/pi-casper",
    "../../workspace/pi-extensions/packages/pi-plan-mode",
    "../../workspace/pi-extensions/packages/pi-powerline",
    "../../workspace/pi-extensions/packages/pi-prompt-history",
    "../../workspace/pi-extensions/packages/pi-markitdown",
    "../../workspace/pi-extensions/packages/pi-autocomplete",
    "../../workspace/pi-extensions/packages/pi-progressive-context",
    "../../workspace/pi-extensions/packages/pi-workflows"
  ]
}
```

See [`packages/pi-workflows/README.md`](packages/pi-workflows/README.md) for its Node CLI setup, workflow directories, YAML contract, and security boundaries.

## Publishing

Each publishable package has `"keywords": ["pi-package"]` and a `"pi"` field, making it installable via:

```bash
pi install npm:<package-name>
```

## Agent instructions

Repository-level coding-agent instructions live in [`AGENTS.md`](AGENTS.md).

## License

MIT
