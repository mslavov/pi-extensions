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
- Opens the task overlay immediately and shows a loading label while Beads data loads.
- Provides a selectable task overlay with list, detail, and dependency graph modes.
- Loads task details and dependency graph data progressively when those views are requested.
- Shows task metadata, descriptions, acceptance criteria, notes, labels, counts, and dependency relationships.
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
| `/beads` | Show the Beads task overlay immediately, then refresh task data |
| `/beads status` | Refresh and show a compact status notification |
| `/beads refresh` | Refresh cached Beads task status |

## Overlay controls

| Key | Description |
|-----|-------------|
| `↑` / `↓` or `k` / `j` | Move selection or scroll the current view |
| `Home` / `End` | Jump to the start or end of the current view |
| `Enter` / `→` | Open details for the selected task |
| `g` | Show the dependency graph |
| `Backspace` / `←` | Return from details or graph to the task list |
| `Esc` / `Ctrl+C` | Close the overlay |

## Shortcut

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Shift+B` | Toggle the Beads status overlay; closes it while focused |
| `Ctrl+Shift+D` | Legacy toggle shortcut |

## License

MIT
