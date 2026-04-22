# pi-todo-write

A [pi](https://github.com/badlogic/pi) extension that adds a **TodoWrite** tool — a structured task list for coding sessions. Replicates the behavior of Claude Code's TodoWrite tool.

The LLM uses it to track multi-step tasks with a visual checklist in the TUI.

## Installation

```bash
pi install npm:pi-todo-write
```

Or try it without installing:

```bash
pi -e npm:pi-todo-write
```

## What it does

Registers a `todo_write` tool that the LLM calls to manage a todo list:

- **Replace-all semantics** — each call sends the entire updated list
- **Three states** — `pending` (○), `in_progress` (◐), `completed` (✓)
- **Dual labels** — `content` (imperative: "Run tests") and `activeForm` (continuous: "Running tests")
- **Auto-clear** — list clears when all items are completed
- **Branch-safe** — state persists in tool result details, survives branching and session restore
- **Rich TUI rendering** — progress checklist with status icons

### Tool Schema

```typescript
{
  todos: Array<{
    content: string;      // "Fix login bug"
    status: "pending" | "in_progress" | "completed";
    activeForm: string;   // "Fixing login bug"
  }>
}
```

### When the LLM uses it

The extension injects guidelines into the system prompt. The LLM uses `todo_write` for:

- Tasks with 3+ steps
- Multiple tasks from the user
- Complex, non-trivial work
- When the user explicitly asks for a todo list

It skips `todo_write` for trivial single-step tasks or informational questions.

## Commands

| Command | Description |
|---------|-------------|
| `/todos` | Show all todos in a full-screen view |

## License

MIT
