# pi-claude-code

Load Claude Code configuration into pi:

- custom slash commands from `.claude/commands/` and `~/.claude/commands/` as pi skills
- custom subagents from `.claude/agents/` and `~/.claude/agents/` as `pi-subagents` agent definitions

## Usage

Install or load this package with pi:

```bash
pi -e ./packages/pi-claude-code
```

For subagents, also load `pi-subagents`.

## Slash commands as skills

Claude Code command files are converted into generated skills cached under `~/.pi/agent/cache/pi-claude-code/`.

A command such as `.claude/commands/review-pr.md` becomes:

```text
review-pr
```

Nested commands use `-` as the path separator, so `.claude/commands/frontend/component.md` becomes:

```text
frontend-component
```

Pi skill names only allow lowercase letters, digits, and hyphens, so imported skill names never include scope prefixes or colons.

Use it with pi's skill command:

```text
/skill:review-pr 123
```

The generated skill preserves the original command body and describes Claude Code conventions like `$ARGUMENTS`, `$1`, `$ARGUMENTS[0]`, inline `!` bash snippets, and `@` file references.

## Subagents

Claude Code subagents are discovered recursively from:

- `.claude/agents/`
- `~/.claude/agents/`

Project subagents override user subagents with the same `name`. Supported frontmatter fields are mapped to pi-subagents: `description`, `model`, `tools`, `disallowedTools`, `maxTurns`, `skills`, `memory`, `background`, `isolation`, and `effort`.

Tool names are mapped to pi built-ins where possible:

| Claude Code | pi |
|-------------|----|
| `Read` | `read` |
| `Edit`, `MultiEdit` | `edit` |
| `Write` | `write` |
| `Bash` | `bash` |
| `Grep` | `grep` |
| `Glob` | `find` |

## Limitations

- Slash commands are loaded as skills, not as top-level `/command` aliases.
- Claude Code `allowed-tools` command frontmatter is informational; pi still enforces the active pi tool set.
- Inline `!` command snippets are not pre-executed by the extension.
- Claude-specific subagent fields such as `hooks`, `mcpServers`, `permissionMode`, `color`, and `initialPrompt` are ignored.
