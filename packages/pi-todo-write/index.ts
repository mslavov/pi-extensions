import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
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

class TodoListComponent {
	private todos: TodoItem[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoItem[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.status === "completed").length;
			const inProgress = this.todos.find((t) => t.status === "in_progress");
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.todos.length} completed`)}`, width));
			if (inProgress) {
				lines.push(truncateToWidth(`  ${th.fg("accent", `▸ ${inProgress.activeForm}`)}`, width));
			}
			lines.push("");

			for (const todo of this.todos) {
				const icon = statusIcon(todo.status, th);
				const label = todoLabel(todo, th);
				lines.push(truncateToWidth(`  ${icon} ${label}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
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

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Inject the full prompt into the system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + PROMPT,
		};
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

			// Clear list if all completed
			const allCompleted = newTodos.length > 0 && newTodos.every((t) => t.status === "completed");
			if (allCompleted) {
				newTodos.length = 0;
			}

			todos = newTodos;

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
			const inProgress = items.find((t: TodoItem) => t.status === "in_progress");
			let text = theme.fg("toolTitle", theme.bold("TodoWrite "));
			text += theme.fg("muted", `${items.length} item(s)`);
			if (inProgress) {
				text += " " + theme.fg("accent", `▸ ${inProgress.activeForm}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const items = details.newTodos;
			if (items.length === 0) {
				return new Text(theme.fg("success", "✓ All tasks completed"), 0, 0);
			}

			const done = items.filter((t) => t.status === "completed").length;
			const current = items.find((t) => t.status === "in_progress");
			let text = theme.fg("muted", `${done}/${items.length} completed`);
			if (current) {
				text += " " + theme.fg("accent", `▸ ${current.activeForm}`);
			}

			const display = expanded ? items : items.slice(0, 8);
			for (const todo of display) {
				const icon = statusIcon(todo.status, theme);
				const label = todoLabel(todo, theme);
				text += `\n${icon} ${label}`;
			}
			if (!expanded && items.length > 8) {
				text += `\n${theme.fg("dim", `... ${items.length - 8} more`)}`;
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
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
