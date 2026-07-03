# pi-prompt-history

Ctrl+R prompt history picker for pi.

- Opens with current-session prompts only.
- Press Cmd/Ctrl+R in the picker to cycle scope: current session → current project → all projects.
- Current project and all-project searches load lazily and show up to 50 matches.
- Press Enter to replace the editor text with the selected prompt.
- Press Escape to cancel.

## Development

```bash
pi -e ./packages/pi-prompt-history
```
