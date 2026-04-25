import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { DESCRIPTION, PROMPT } from "./prompt.js";

interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

interface TodoDetails {
	oldTodos: TodoItem[];
	newTodos: TodoItem[];
}

const TOOL_NAME = "todo_write";

const TodoWriteParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1, description: "Imperative form: what needs to be done" }),
			status: StringEnum(["pending", "in_progress", "completed"] as const, {
				description: "Task status",
			}),
			activeForm: Type.String({
				minLength: 1,
				description: "Present continuous form shown during execution",
			}),
		}),
		{ description: "The updated todo list" },
	),
});

function statusIcon(status: TodoItem["status"], theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "◐");
		case "pending":
			return theme.fg("dim", "○");
	}
}

function todoLabel(todo: TodoItem, theme: Theme): string {
	switch (todo.status) {
		case "completed":
			return theme.fg("dim", todo.content);
		case "in_progress":
			return theme.fg("text", todo.activeForm);
		case "pending":
			return theme.fg("muted", todo.content);
	}
}

class TodoListOverlay {
	private todos: TodoItem[];
	private theme: Theme;
	private onClose: () => void;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoItem[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, Key.ctrlShift("t"))) {
			this.onClose();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollOffset++;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const done = this.todos.filter((t) => t.status === "completed").length;
		const title = th.fg("accent", ` Todos ${th.fg("muted", `${done}/${this.todos.length}`)} `);
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 18)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet.")}`, width));
		} else {
			// Clamp scroll offset
			const maxScroll = Math.max(0, this.todos.length - 10);
			if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

			const visible = this.todos.slice(this.scrollOffset, this.scrollOffset + 10);
			for (let i = 0; i < visible.length; i++) {
				const todo = visible[i];
				const idx = this.scrollOffset + i + 1;
				const num = th.fg("dim", `${String(idx).padStart(2)}.`);
				const icon = statusIcon(todo.status, th);
				const label = todoLabel(todo, th);
				lines.push(truncateToWidth(`  ${num} ${icon} ${label}`, width));
			}

			if (this.todos.length > 10) {
				lines.push("");
				lines.push(
					truncateToWidth(
						`  ${th.fg("dim", `Showing ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + 10, this.todos.length)} of ${this.todos.length} · ↑/↓ to scroll`)}`,
						width,
					),
				);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Esc or Ctrl+T to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let currentCtx: ExtensionContext | undefined;

	function updateWidget() {
		if (!currentCtx) return;
		const ctx = currentCtx;

		if (todos.length === 0) {
			ctx.ui.setWidget("todo-status", undefined);
			return;
		}

		const th = ctx.ui.theme;
		const done = todos.filter((t) => t.status === "completed").length;
		const inProgress = todos.find((t) => t.status === "in_progress");

		const parts: string[] = [];
		parts.push(th.fg("muted", "📋"));
		parts.push(th.fg("accent", `${done}/${todos.length}`));
		if (inProgress) {
			parts.push(th.fg("accent", "▸ ") + th.fg("text", inProgress.activeForm));
		} else if (done === todos.length) {
			parts.push(th.fg("success", "✓ All done"));
		}
		parts.push(th.fg("dim", "Ctrl+Shift+T"));

		ctx.ui.setWidget("todo-status", [parts.join("  ")]);
	}

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.newTodos) {
				todos = details.newTodos;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		reconstructState(ctx);
		updateWidget();
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		reconstructState(ctx);
		updateWidget();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + PROMPT,
		};
	});

	pi.registerShortcut(Key.ctrlShift("t"), {
		description: "Toggle todo list",
		handler: async (ctx) => {
			if (todos.length === 0) {
				ctx.ui.notify("No todos yet", "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListOverlay(todos, theme, () => done());
			});
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "TodoWrite",
		description: DESCRIPTION,

		promptSnippet: "Create and manage a structured task checklist for the current coding session",
		promptGuidelines: [
			"Use todo_write proactively for tasks with 3+ steps, when the user provides multiple tasks, or when explicitly asked.",
			"Do not use todo_write for single trivial tasks, informational questions, or tasks completable in under 3 steps.",
			"When using todo_write, keep exactly one task as in_progress at a time. Mark tasks complete immediately after finishing.",
			"Each todo_write call sends the ENTIRE updated list — not incremental changes.",
		],

		parameters: TodoWriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const oldTodos = [...todos];
			const newTodos = [...params.todos];

			const allCompleted = newTodos.length > 0 && newTodos.every((t) => t.status === "completed");
			if (allCompleted) {
				newTodos.length = 0;
			}

			todos = newTodos;
			updateWidget();

			return {
				content: [
					{
						type: "text",
						text: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.",
					},
				],
				details: { oldTodos, newTodos } as TodoDetails,
			};
		},

		renderCall(args, theme, _context) {
			const items = args.todos ?? [];
			const done = items.filter((t: TodoItem) => t.status === "completed").length;
			const inProgress = items.find((t: TodoItem) => t.status === "in_progress");
			let text = theme.fg("toolTitle", theme.bold("TodoWrite "));
			text += theme.fg("muted", `${done}/${items.length}`);
			if (inProgress) {
				text += "  " + theme.fg("accent", `▸ ${inProgress.activeForm}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.newTodos.length === 0) {
				return new Text(theme.fg("success", "✓ All tasks completed"), 0, 0);
			}

			const done = details.newTodos.filter((t) => t.status === "completed").length;
			const current = details.newTodos.find((t) => t.status === "in_progress");
			let text = theme.fg("muted", `${done}/${details.newTodos.length} completed`);
			if (current) {
				text += "  " + theme.fg("accent", `▸ ${current.activeForm}`);
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListOverlay(todos, theme, () => done());
			});
		},
	});
}
