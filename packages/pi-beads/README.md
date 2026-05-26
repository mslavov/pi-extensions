# pi-beads

A [pi](https://github.com/earendil-works/pi-mono) extension that displays current-project Beads task status in the TUI.

`pi-beads` is display-only. Agents still use the Beads skill and the preinstalled `bd` CLI directly to create, update, link, and close tasks.

## Installation

```bash
pi install npm:pi-beads
```

Or try it without installing:

```bash
pi -e npm:pi-beads
```

## What it does

- Reads Beads status with read-only `bd` CLI calls.
- Shows active, ready, in-progress, blocked, and deferred task state in a TUI widget.
- Provides a scrollable task overlay similar to `pi-todo-write`.
- Refreshes periodically and after agent bash/exec tool calls that run Beads mutation commands.
- Handles projects without a `.beads` database without creating anything.

## Boundaries

- Provides read-only status visibility.
- Leaves all task changes to the Beads skill and direct `bd` CLI commands.
- Exposes commands, shortcuts, and a widget; no model-facing Beads mutation tools.

Use the Beads skill and `bd` CLI for task management.

## Commands

| Command | Description |
|---------|-------------|
| `/beads` | Refresh and show the Beads task overlay |
| `/beads status` | Refresh and show a compact status notification |
| `/beads refresh` | Refresh cached Beads task status |

## Shortcut

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Shift+B` | Toggle the Beads status overlay |
| `Ctrl+Shift+D` | Legacy toggle shortcut |

## License

MIT
