# pi-showboat

Create executable Showboat demo artifacts from pi sessions.

`pi-showboat` wraps Simon Willison's `showboat` CLI as a pi tool and slash command. Agents can use it to build Markdown demos with real captured command output and images, then verify those demos before handing work back.

## What it does

The extension adds:

- A `showboat` tool for agents with actions: `status`, `init`, `note`, `exec`, `image`, `pop`, `verify`, and `extract`.
- A `/showboat` slash command for users to check status and run common commands manually.
- An automatic post-task showcase trigger. After a work-producing task ends, the extension asks the agent to create a Showboat demo if it did not already do so.

It does not reimplement Showboat. It uses the real CLI so captured output and verification behavior come from Showboat itself.

## Requirements

Install one of these before use:

- `showboat` on your `PATH`, or
- `uv`, so the extension can run `uvx showboat`.

The extension checks `showboat --help` first, then falls back to `uvx showboat --help`. It does not install Showboat automatically.

## Local usage

From this repository:

```bash
pi -e ./packages/pi-showboat
```

Then check availability inside pi:

```text
/showboat status
```

## Automatic showcase flow

Use pi normally:

```text
Fix the failing parser test.
```

If the task looks like implementation, debugging, investigation, build, test, or feature work, `pi-showboat` watches for the end of the agent run. If the agent has not already used the `showboat` tool, the extension sends a follow-up instruction asking it to create a concise demo.

The follow-up tells the agent to:

1. Create a task-specific demo file, such as `demo.md` or `demos/<slug>.md`.
2. Add a note summarizing the work.
3. Capture key verification or demonstration commands with `showboat action=exec`.
4. Add screenshots with `showboat action=image` when UI evidence is relevant.
5. Run `showboat action=verify` when practical.
6. Mention the demo file path in the final response.

Pure Q&A and simple slash-command turns are ignored. If a task has no executable or visible behavior to demonstrate, the agent can say so instead of creating a demo.

## Manual slash commands

```text
/showboat status
/showboat init <file> <title>
/showboat verify <file>
/showboat extract <file>
```

Manual commands are useful for smoke testing the extension or working with an existing demo file yourself. The automatic flow does not require enabling a mode or selecting a demo file first.

## Agent tool actions

The agent gets one `showboat` tool with an `action` parameter.

| Action | Required fields | Purpose |
| --- | --- | --- |
| `status` | none | Check CLI availability and automatic showcase status. |
| `init` | `file`, `title` | Create a new demo Markdown file. |
| `note` | `file`, `text` | Append commentary. |
| `exec` | `file`, `lang`, `code` | Run code and append captured output. |
| `image` | `file`, `path` | Append an image or screenshot. Optional `text` is used as alt text. |
| `pop` | `file` | Remove the most recent Showboat entry. |
| `verify` | `file` | Re-run captured code blocks and compare output. Optional `output` writes an updated copy. |
| `extract` | `file` | Print commands that recreate the demo. Optional `filename` substitutes a different output filename. |

Optional `workdir` is passed through as Showboat's `--workdir <dir>` global option.

## Example agent workflow

A typical agent-created demo looks like this:

```text
showboat action=init file=demos/parser-fix.md title="Parser fix demo"
showboat action=note file=demos/parser-fix.md text="This demo captures the parser test after the fix."
showboat action=exec file=demos/parser-fix.md lang=bash code="bun test parser.test.ts"
showboat action=verify file=demos/parser-fix.md
```

If a command produces bad or noisy output, the agent should use:

```text
showboat action=pop file=demos/parser-fix.md
```

Do not manually edit captured Showboat output blocks. Use Showboat commands so the demo reflects what actually ran.

## UI evidence

`pi-showboat` does not include browser automation. When UI evidence is needed, the agent should use whatever browser or project tooling is already available, save screenshots, then append them:

```text
showboat action=image file=demos/homepage-fix.md path=artifacts/screenshot.png text="Homepage after the fix"
```

Good options can include project Playwright scripts, Playwright CLI, `agent-browser`, `rodney`, or any existing tool that can exercise the UI and produce screenshots.
