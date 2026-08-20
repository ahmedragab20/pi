/**
 * Todo Extension
 *
 * Live task list the user inspects with /todos.
 * State lives in tool-result details plus custom session entries so
 * branching, reload, and compaction keep the same snapshot.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

type TodoAction = "list" | "add" | "toggle" | "update" | "clear";

interface TodoDetails {
	action: TodoAction;
	todos: Todo[];
	nextId: number;
	error?: string;
}

interface TodoSnapshot {
	todos: Todo[];
	nextId: number;
}

const TODO_ENTRY = "todos";
const TODO_WIDGET = "todos";
const WIDGET_CAP = 8;

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "update", "clear"] as const),
	text: Type.Optional(
		Type.String({ description: "Todo text (for add / update)" }),
	),
	id: Type.Optional(
		Type.Number({ description: "Todo ID (for toggle / update)" }),
	),
});

function cloneTodos(list: Todo[]): Todo[] {
	return list.map((t) => ({ id: t.id, text: t.text, done: t.done }));
}

function formatList(list: Todo[]): string {
	if (list.length === 0) return "No todos";
	const done = list.filter((t) => t.done).length;
	const lines = list.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`);
	return `${done}/${list.length} completed\n${lines.join("\n")}`;
}

function progressLine(list: Todo[]): string {
	const done = list.filter((t) => t.done).length;
	return `${done}/${list.length} completed`;
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
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
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`,
					width,
				),
			);
		} else {
			lines.push(
				truncateToWidth(`  ${th.fg("muted", progressLine(this.todos))}`, width),
			);
			lines.push("");

			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width),
		);
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
	let todos: Todo[] = [];
	let nextId = 1;

	const snapshot = (): TodoSnapshot => ({ todos: cloneTodos(todos), nextId });

	const applySnapshot = (data: Partial<TodoSnapshot> | undefined) => {
		if (!data?.todos) return;
		todos = cloneTodos(data.todos);
		nextId =
			typeof data.nextId === "number"
				? data.nextId
				: Math.max(0, ...todos.map((t) => t.id)) + 1;
	};

	const persist = () => {
		pi.appendEntry(TODO_ENTRY, snapshot());
	};

	const refreshWidget = (ctx?: ExtensionContext) => {
		if (!ctx?.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget(TODO_WIDGET, undefined);
			return;
		}
		const list = cloneTodos(todos);
		ctx.ui.setWidget(TODO_WIDGET, (_tui, theme) => {
			const header = theme.fg("muted", `${progressLine(list)}  /todos`);
			const visible = list.slice(0, WIDGET_CAP);
			const rows = visible.map((t) => {
				const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
				const text = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
				return `${check} ${theme.fg("accent", `#${t.id}`)} ${text}`;
			});
			if (list.length > WIDGET_CAP) {
				rows.push(theme.fg("dim", `… ${list.length - WIDGET_CAP} more`));
			}
			const lines = [header, ...rows];
			return {
				render: () => lines,
				invalidate: () => {},
			};
		});
	};

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === TODO_ENTRY) {
				applySnapshot(entry.data as Partial<TodoSnapshot> | undefined);
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.todos) {
				applySnapshot(details);
			}
		}

		refreshWidget(ctx);
	};

	const detailsOf = (
		action: TodoAction,
		extra?: { error?: string },
	): TodoDetails => ({
		action,
		...snapshot(),
		...extra,
	});

	const ok = (action: TodoAction, text: string) => ({
		content: [{ type: "text" as const, text: `${text}\n\n${formatList(todos)}` }],
		details: detailsOf(action),
	});

	const fail = (action: TodoAction, error: string) => ({
		content: [
			{ type: "text" as const, text: `Error: ${error}\n\n${formatList(todos)}` },
		],
		details: detailsOf(action, { error }),
	});

	const showTodos = async (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(cloneTodos(todos), theme, () => done());
			});
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(formatList(todos), "info");
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_compact", async (_event, ctx) => {
		if (todos.length > 0) persist();
		refreshWidget(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (todos.length === 0) return;
		const reminder = [
			"TODO PROGRESS (user-visible via /todos — must match reality right now):",
			formatList(todos),
			"After you finish a step, call todo toggle on that id before the next step or your final reply. Add newly discovered steps immediately. Use update if a step's text changed. Never leave finished work unmarked. clear only when the whole task is done.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Maintain the user-visible task list (/todos). Actions: list, add (text), toggle (id), update (id, text), clear. MUST stay truthful: toggle an item the moment that step finishes; add newly discovered steps immediately; update text when a step changes. The user inspects this list at any time.",
		promptSnippet: "Keep the /todos list truthful as you work",
		promptGuidelines: [
			"This list is the user's live /todos progress. Stale items are a bug.",
			"After finishing a step, call todo toggle on that id immediately — never in advance, never batched at the end.",
			"Add a new item as soon as you discover a new step. Use update to rewrite an item if remaining work changed.",
			"clear only when every item is done and the user-facing task is finished.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: formatList(todos) }],
						details: detailsOf("list"),
					};

				case "add": {
					if (!params.text?.trim()) return fail("add", "text required for add");
					const newTodo: Todo = {
						id: nextId++,
						text: params.text.trim(),
						done: false,
					};
					todos.push(newTodo);
					persist();
					refreshWidget(ctx);
					return ok("add", `Added todo #${newTodo.id}: ${newTodo.text}`);
				}

				case "toggle": {
					if (params.id === undefined)
						return fail("toggle", "id required for toggle");
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) return fail("toggle", `#${params.id} not found`);
					todo.done = !todo.done;
					persist();
					refreshWidget(ctx);
					return ok(
						"toggle",
						`Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`,
					);
				}

				case "update": {
					if (params.id === undefined)
						return fail("update", "id required for update");
					if (!params.text?.trim())
						return fail("update", "text required for update");
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) return fail("update", `#${params.id} not found`);
					todo.text = params.text.trim();
					persist();
					refreshWidget(ctx);
					return ok("update", `Updated todo #${todo.id}: ${todo.text}`);
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					persist();
					refreshWidget(ctx);
					return ok("clear", `Cleared ${count} todos`);
				}

				default:
					return fail("list", `unknown action: ${String(params.action)}`);
			}
		},

		renderCall(args, theme, _context) {
			let text =
				theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;
			const renderItems = (limit?: number) => {
				if (todoList.length === 0) {
					return theme.fg("dim", "No todos");
				}
				const display = limit && !expanded ? todoList.slice(0, limit) : todoList;
				let listText = theme.fg("muted", `${progressLine(todoList)}:`);
				for (const t of display) {
					const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
					const itemText = t.done
						? theme.fg("dim", t.text)
						: theme.fg("muted", t.text);
					listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
				}
				if (limit && !expanded && todoList.length > limit) {
					listText += `\n${theme.fg("dim", `... ${todoList.length - limit} more`)}`;
				}
				return listText;
			};

			switch (details.action) {
				case "list":
					return new Text(renderItems(5), 0, 0);

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle":
				case "update": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text.split("\n")[0] : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(
						theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"),
						0,
						0,
					);
			}
		},
	});

	const command = {
		description: "Show live task progress on the current branch",
		handler: async (_args: string, ctx: ExtensionContext) => showTodos(ctx),
	};

	pi.registerCommand("todos", command);
}
