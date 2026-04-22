# pi-extensions

Monorepo for [pi](https://github.com/mariozechner/pi-coding-agent) extensions.

## Packages

| Package | Description |
|---------|-------------|
| [pi-plan-mode](packages/pi-plan-mode/) | Structured planning via scout/planner subagents with task tracking |
| [pi-todo-write](packages/pi-todo-write/) | TodoWrite tool – structured task list management for coding sessions |
| [pi-headroom](packages/pi-headroom/) | Transparent LLM context compression using Headroom |

## Setup

```bash
bun install
```

## Scripts

```bash
bun run check   # Type-check all packages
bun run build   # Build all packages
bun run clean   # Clean build artifacts
```

## Development

Each package can be loaded directly into pi during development:

```bash
# Load a single extension
pi -e ./packages/pi-plan-mode

# Or symlink into ~/.pi/agent/extensions/
ln -s "$(pwd)/packages/pi-plan-mode/src" ~/.pi/agent/extensions/plan-mode
```

## Publishing

Each package has `"keywords": ["pi-package"]` and a `"pi"` field in its `package.json`, making it installable via:

```bash
pi install npm:<package-name>
```

## License

MIT
