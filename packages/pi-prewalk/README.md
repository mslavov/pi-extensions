# pi-prewalk

Same-session Prewalk for [Pi](https://github.com/earendil-works/pi-mono): the current model plans the work, creates a validated checklist, and makes one focused mutation. Pi then switches the next model request to `openai-codex/gpt-5.6-luna`, which finishes and verifies the task with the full conversation and tool history intact.

After the run settles, Pi restores the original planner model and thinking level by default.

## Requirements

- `@earendil-works/pi-coding-agent` 0.80.10 or newer
- An authenticated target model (Luna by default)
- An active `todo_write` tool from [`pi-todo-write`](../pi-todo-write/), or an active shell tool when the current working directory has a Beads workspace
- At least one active mutation tool: `edit`, `write`, or `apply_patch`

When `/prewalk` is armed, it checks the current working directory with `bd status`. A configured Beads workspace makes Beads the task tracker for that run; otherwise Prewalk uses `todo_write`. Prewalk refuses to arm and names the missing capability when the selected tracker or mutation tools are unavailable.

## Commands

```text
/prewalk <task>  Arm Prewalk and start the task immediately
/prewalk         Arm Prewalk for the next ordinary prompt
/prewalk status  Show the phase, target model, and restoration setting
/prewalk off     Cancel Prewalk
```

`status` and `off` are handled locally and do not make a provider request. Turning Prewalk off after handoff restores the original planner when restoration is enabled. A manual model selection cancels Prewalk and keeps the model selected by the user.

## Lifecycle

1. The planner writes a concrete prose plan.
2. The planner records the task and validation work. It uses direct `bd` CLI commands to create or claim and start a Bead when Beads is configured, or calls `todo_write` with 5–9 items and exactly one `in_progress` item otherwise.
3. The planner performs one focused successful `edit`, `write`, or `apply_patch` after the task-tracking gate opens.
4. At that turn boundary, Pi switches to the configured target model.
5. The target model completes and closes the existing Bead, or completes the existing checklist, and runs the full relevant test module.
6. Once the agent run has fully settled, Pi restores the planner model and thinking level.

Tool-call order controls the handoff even when tools execute in parallel: a successful Beads task update or todo checklist followed by a mutation can qualify in the same turn, while a mutation before task tracking cannot. Failed tracking or mutation calls do not qualify. If the planner stops after prose or partial tool progress, Prewalk can queue a bounded hidden continuation, with a maximum of three per run.

The handoff does not fork, summarize, or replace the session. Planning guidance and implementation guidance are transient context messages; user messages, assistant responses, task-tracking results, mutations, and verification results remain in one Pi trajectory.

## Configuration

No configuration file is required. The defaults are equivalent to:

```json
{
  "targetModel": "openai-codex/gpt-5.6-luna",
  "restorePlanner": true
}
```

To override them, create `~/.pi/agent/prewalk.json`. `targetModel` must contain a provider and model ID separated by `/`, and `restorePlanner` must be a boolean. Configuration is read when the extension loads; use `/reload` after changing it. Invalid configuration produces one warning and falls back to the defaults.

## Failure behavior

- Missing target model or authentication: cancel the handoff and let the planner continue with the existing trajectory.
- Failed model switch: cancel the handoff, report the failure once, and keep the current model.
- Failed planner restoration: clear Prewalk, report the failure once, and keep the current model.
- Session quit, reload, replacement, or fork while Luna is active: attempt planner restoration as a graceful shutdown backstop.
- Automatic continuation limit reached: let the run settle normally without forcing more work.

## Installation

From this monorepo:

```bash
pi install C:/pi-extensions/packages/pi-todo-write
pi install C:/pi-extensions/packages/pi-prewalk
pi list
```

Load both packages without installing while developing:

```bash
pi --no-extensions \
  -e C:/pi-extensions/packages/pi-todo-write \
  -e C:/pi-extensions/packages/pi-prewalk
```

Remove the global Prewalk package entry with:

```bash
pi remove C:/pi-extensions/packages/pi-prewalk
```

The optional `~/.pi/agent/prewalk.json` file is not created or removed by package installation commands.
