# pi-progressive-context

Lazy nested `AGENTS.md` / `CLAUDE.md` context loading for pi.

Pi loads context files from the session cwd and its ancestors at startup. This extension adds Claude Code-style progressive loading for nested folders: after the agent successfully reads a file, or the user submits a CLI `@file` block, the extension discovers context files between the session cwd and that file's directory and injects them into subsequent model calls.

## Usage

Install or load the package as a pi extension:

```bash
pi install /path/to/pi-extensions/packages/pi-progressive-context
```

For local development:

```bash
pi -e ./packages/pi-progressive-context
```

Use `/progressive-context` to see which nested context files have been loaded in the current session.

## Behavior

For each observed path inside `ctx.cwd`, the extension walks from the session cwd down to the file's directory. In each nested directory it loads at most one file, using pi's precedence:

1. `AGENTS.md`
2. `CLAUDE.md`

The session cwd itself is skipped because pi already handles cwd and ancestor context files at startup. Loaded files are deduped for the session and injected as one hidden custom context message before each LLM call.

## Limitations

- Progressive context affects subsequent LLM calls, not the exact call that chose to read a file.
- Images do not expose original filesystem paths through `InputEvent.images`.
- Interactive `@` completion inserts paths; it is not a general attachment API. CLI `@file` blocks and successful `read` tool results are the reliable triggers.
- Arbitrary `bash cat file` reads are not visible as structured file reads.

## Local check

From the `pi-extensions` repo:

```bash
bun run check
```
