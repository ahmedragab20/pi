/**
 * Todo Extension
 *
 * Live task list the user inspects with /todos.
 * State lives in tool-result details plus custom session entries so
 * branching, reload, and compaction keep the same snapshot.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PANEL_OVERLAY, ScrollPanel } from "./ui/panel.ts";
import { liveText, singleLine, statusText, toolHeader } from "./ui/presentation.ts";
import { UI_SNAPSHOT_REQUEST, UI_TASKS, type TaskProgress } from "./ui/events.ts";

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
const TODO_REMINDER = "todo-reminder";

const TodoParams = Type.Object({
	action: Type.Union([
		Type.Literal("list"),
		Type.Literal("add"),
		Type.Literal("toggle"),
		Type.Literal("update"),
		Type.Literal("clear"),
	]),
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

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	let currentCtx: ExtensionContext | undefined;
	let lastReminder: string | undefined;
	let unsubscribeSnapshot: (() => void) | undefined;

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

	const refreshWidget = (ctx: ExtensionContext | undefined = currentCtx) => {
		if (!ctx?.hasUI) return;
		currentCtx = ctx;
		const progress: TaskProgress = {
			done: todos.filter((todo) => todo.done).length,
			total: todos.length,
			next: todos.find((todo) => !todo.done)?.text,
		};
		pi.events.emit(UI_TASKS, progress);
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
			const list = cloneTodos(todos);
			await ctx.ui.custom<void>((tui, theme, keys, done) => new ScrollPanel({
				title: "Tasks", tui, theme, keys, onClose: done,
				body: (_width, th) => list.length === 0
					? [th.fg("muted", "No tasks yet.")]
					: [th.fg("muted", progressLine(list)), "", ...list.map((todo) =>
						statusText(th, todo.done ? "success" : "queued", `#${todo.id} ${todo.text}`))],
			}), PANEL_OVERLAY);
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(formatList(todos), "info");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		lastReminder = undefined;
		unsubscribeSnapshot?.();
		unsubscribeSnapshot = pi.events.on(UI_SNAPSHOT_REQUEST, () => refreshWidget());
		ctx.ui.setWidget(TODO_WIDGET, undefined);
		reconstructState(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		lastReminder = undefined;
		reconstructState(ctx);
	});
	pi.on("session_compact", async (_event, ctx) => {
		lastReminder = undefined;
		if (todos.length > 0) persist();
		refreshWidget(ctx);
	});
	pi.on("session_shutdown", async () => {
		unsubscribeSnapshot?.();
		unsubscribeSnapshot = undefined;
		currentCtx = undefined;
	});

	// A hidden history message, not a system-prompt edit: changing the system
	// prompt invalidates the provider prompt cache for the whole conversation.
	pi.on("before_agent_start", async () => {
		if (todos.length === 0) {
			lastReminder = undefined;
			return;
		}
		const reminder = [
			"TODO PROGRESS (user-visible via /todos — must match reality right now):",
			formatList(todos),
			"After you finish a step, call todo toggle on that id before the next step or your final reply. Add newly discovered steps immediately. Use update if a step's text changed. Never leave finished work unmarked. clear only when the whole task is done.",
		].join("\n");
		if (reminder === lastReminder) return;
		lastReminder = reminder;
		return {
			message: { customType: TODO_REMINDER, content: reminder, display: false },
		};
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
			return liveText(() => {
				let text = toolHeader(theme, "Tasks", args.action);
				if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
				if (args.text) text += ` ${theme.fg("muted", singleLine(args.text))}`;
				return [text];
			});
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const render = () => {
				if (context.isError) {
					const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
					return new Text(statusText(theme, "error", "Task operation failed") + "\n" + text, 0, 0);
				}
				if (isPartial) return new Text(statusText(theme, "running", "Updating tasks"), 0, 0);
				const details = result.details as TodoDetails | undefined;
				if (!details) {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}

				if (details.error) {
					return new Text(statusText(theme, "error", details.error), 0, 0);
				}

				const todoList = details.todos;
				const renderItems = (limit?: number) => {
					if (todoList.length === 0) return theme.fg("dim", "No todos");
					const display = limit && !expanded ? todoList.slice(0, limit) : todoList;
					let listText = theme.fg("muted", `${progressLine(todoList)}:`);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = theme.fg(t.done ? "dim" : "muted", t.text);
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
						const added = todoList.at(-1);
						if (!added || expanded) return new Text(renderItems(), 0, 0);
						return new Text(
							theme.fg("success", "✓ Added ") + theme.fg("accent", `#${added.id}`) +
								" " + theme.fg("muted", added.text), 0, 0,
						);
					}
					case "toggle":
					case "update": {
						const text = result.content[0];
						const msg = text?.type === "text" ? text.text.split("\n")[0] : "";
						return new Text(expanded ? renderItems() : statusText(theme, "success", msg), 0, 0);
					}
					case "clear":
						return new Text(statusText(theme, "success", "Cleared all todos"), 0, 0);
					default:
						return new Text(renderItems(), 0, 0);
				}
			};
			return liveText((width) => render().render(width));
		},
	});

	const command = {
		description: "Show live task progress on the current branch",
		handler: async (_args: string, ctx: ExtensionContext) => showTodos(ctx),
	};

	pi.registerCommand("todos", command);
}
