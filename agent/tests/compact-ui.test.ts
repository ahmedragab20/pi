import { describe, expect, test } from "bun:test";
import compactFooterExtension, {
	formatGitStatus,
	latestCacheHitPercent,
} from "../extensions/compact-footer.ts";
import todoExtension from "../extensions/todo.ts";
import { visibleWidth } from "../npm/node_modules/@earendil-works/pi-tui/dist/index.js";

type EventHandler = (
	event: unknown,
	ctx: unknown,
) => unknown | Promise<unknown>;
type TestTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

const plainTheme: TestTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function makePi() {
	const handlers = new Map<string, EventHandler[]>();
	const listeners = new Map<string, ((event: unknown) => void)[]>();
	const tools: Record<string, { execute: Function; renderResult: Function }> = {};
	let eventsApi: {
		on: (name: string, fn: (event: unknown) => void) => () => void;
		emit: (name: string, event: unknown) => void;
	};
	eventsApi = {
		on(name, fn) {
			const list = listeners.get(name) ?? [];
			list.push(fn);
			listeners.set(name, list);
			return () => { listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== fn)); };
		},
		emit(name, event) {
			for (const fn of listeners.get(name) ?? []) fn(event);
		},
	};
	const pi = {
		on(name: string, handler: EventHandler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		events: eventsApi,
		registerTool(tool: { name: string; execute: Function; renderResult: Function }) {
			tools[tool.name] = tool;
		},
		registerCommand() {},
		appendEntry() {},
	};
	const emit = eventsApi.emit;
	return { pi, handlers, tools, emit };
}

function makeTodoCtx(widgets: Map<string, unknown>) {
	return {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] },
		appendEntry() {},
		ui: {
			setWidget(name: string, factory: unknown) {
				widgets.set(name, factory);
			},
		},
	};
}

describe("todo presentation ownership", () => {
	test("publishes task progress without creating a second activity widget", async () => {
		const { pi, handlers, tools, emit } = makePi();
		const progress: unknown[] = [];
		pi.events.on("harness-ui:tasks", (event) => progress.push(event));
		todoExtension(pi as never);
		const widgets = new Map<string, unknown>();
		const ctx = makeTodoCtx(widgets);

		await handlers.get("session_start")![0]({}, ctx);
		// Empty branch -> no widget yet.
		expect(widgets.get("todos")).toBeUndefined();

		const todo = tools["todo"];
		expect(todo).toBeDefined();
		await todo.execute(
			"call-1",
			{ action: "add", text: "Inspect workspace" },
			undefined,
			undefined,
			ctx,
		);

		expect(widgets.get("todos")).toBeUndefined();
		expect(progress.at(-1)).toEqual({ done: 0, total: 1, next: "Inspect workspace" });
		emit("harness-ui:snapshot-request", {});
		expect(progress.at(-1)).toEqual({ done: 0, total: 1, next: "Inspect workspace" });
		await todo.execute("call-2", { action: "toggle", id: 1 }, undefined, undefined, ctx);
		expect(progress.at(-1)).toEqual({ done: 1, total: 1, next: undefined });
		expect(widgets.get("todos")).toBeUndefined();
	});
});

test("todo cards expand full state, preserve results, and distinguish errors and partial updates", async () => {
	const { pi, handlers, tools } = makePi();
	todoExtension(pi as never);
	const ctx = makeTodoCtx(new Map());
	await handlers.get("session_start")![0]({}, ctx);
	try {
		for (let i = 1; i <= 6; i++) {
			await tools.todo.execute(String(i), { action: "add", text: `Task ${i}: ${"path/".repeat(20)}TAIL-${i}` }, undefined, undefined, ctx);
		}
		const result = await tools.todo.execute("list", { action: "list" }, undefined, undefined, ctx);
		const before = JSON.stringify(result);
		const render = (value: unknown, expanded: boolean, isPartial = false, isError = false): string[] =>
			tools.todo.renderResult(value, { expanded, isPartial }, plainTheme, { isError }).render(30);
		expect(render(result, false).join(" ")).toContain("1 more");
		expect(render(result, false).join("")).not.toContain("TAIL-6");
		const expanded = render(result, true);
		expect(expanded.join("")).toContain("TAIL-6");
		expect(expanded.every((line) => visibleWidth(line) <= 30)).toBe(true);
		expect(JSON.stringify(result)).toBe(before);
		const failure = await tools.todo.execute("missing", { action: "toggle", id: 99 }, undefined, undefined, ctx);
		expect(render(failure, false).join("")).toContain("✗ #99 not found");
		expect(render(result, false, true).join("")).toContain("Updating tasks");
		expect(render({ content: [{ type: "text", text: "failure detail" }] }, false, false, true).join("")).toContain("failure detail");
	} finally { await handlers.get("session_shutdown")![0]({}, ctx); }
});

describe("todo reminder", () => {
	type ReminderResult =
		| {
				message?: { customType: string; content: string; display: boolean };
				systemPrompt?: string;
		  }
		| undefined;

	test("injects a hidden deduped reminder message instead of editing the system prompt", async () => {
		const { pi, handlers, tools } = makePi();
		todoExtension(pi as never);
		const ctx = makeTodoCtx(new Map());

		await handlers.get("session_start")![0]({}, ctx);
		const before = handlers.get("before_agent_start")![0];
		const noTodos = (await before({ systemPrompt: "base" }, ctx)) as ReminderResult;
		expect(noTodos).toBeUndefined();

		await tools["todo"].execute(
			"call-1",
			{ action: "add", text: "Inspect workspace" },
			undefined,
			undefined,
			ctx,
		);
		const first = (await before({}, ctx)) as ReminderResult;
		expect(first?.systemPrompt).toBeUndefined();
		expect(first?.message?.customType).toBe("todo-reminder");
		expect(first?.message?.display).toBe(false);
		expect(first?.message?.content).toContain("#1: Inspect workspace");

		const second = await before({}, ctx);
		expect(second).toBeUndefined();

		await tools["todo"].execute(
			"call-2",
			{ action: "toggle", id: 1 },
			undefined,
			undefined,
			ctx,
		);
		const afterToggle = (await before({}, ctx)) as ReminderResult;
		expect(afterToggle?.message?.content).toContain("[x] #1");

		await handlers.get("session_compact")![0]({}, ctx);
		const afterCompact = (await before({}, ctx)) as ReminderResult;
		expect(afterCompact?.message).toBeDefined();
	});
});

describe("compact footer", () => {
	test("formats git state with compact symbols", () => {
		expect(formatGitStatus("")).toBe("✓");
		expect(
			formatGitStatus("M  staged.ts\0 M modified.ts\0?? new.ts\0UU conflict.ts\0"),
		).toBe("+1 ~1 ?1 !1");
		expect(formatGitStatus("R  renamed.ts\0old.ts\0 M next.ts\0")).toBe("+1 ~1");
	});

	test("computes latest usable request cache percentage", () => {
		const assistant = (input: number, cacheRead: number, cacheWrite: number) => ({
			type: "message",
			message: {
				role: "assistant",
				usage: { input, cacheRead, cacheWrite },
			},
		});
		expect(latestCacheHitPercent([])).toBeUndefined();
		expect(latestCacheHitPercent([assistant(20, 80, 0)])).toBe(80);
		expect(latestCacheHitPercent([assistant(100, 0, 0)])).toBe(0);
		expect(
			latestCacheHitPercent([assistant(20, 80, 0), assistant(0, 0, 0)]),
		).toBe(80);
	});

	test("renders a single balanced line and wires branch subscription as dispose", () => {
		const { pi, handlers } = makePi();
		compactFooterExtension(pi as never);

		let footerFactory: unknown;
		const ctx = {
			hasUI: true,
			mode: "tui",
			cwd: "/Users/test/.pi",
			model: { id: "gpt-test" },
			getContextUsage: () => ({ percent: 7.3 }),
			sessionManager: {
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 20, cacheRead: 80, cacheWrite: 0 },
						},
					},
				],
			},
			ui: {
				setFooter(factory: unknown) {
					footerFactory = factory;
				},
			},
		};

		handlers.get("session_start")![0]({}, ctx);
		expect(typeof footerFactory).toBe("function");

		let unsubscribed = false;
		const footerData = {
			onBranchChange(_cb: () => void) {
				return () => {
					unsubscribed = true;
				};
			},
			getGitBranch: () => "main",
			getExtensionStatuses: () =>
				new Map<string, string>([
					["subagents", "1 running agent"],
					["pi-lens-lsp", "LSP Active: typescript"],
					["diffing", "diffing: reviewing"],
					["fast-mode", "fast"],
					["build-warning", "blocked: tests failing"],
				]),
		};

		const footer = (footerFactory as Function)(
			undefined,
			plainTheme,
			footerData,
		) as {
			dispose: () => void;
			render: (width: number) => string[];
		};

		const lines = footer.render(200);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(
			"blocked: tests failing · .pi (main) · gpt-test · ctx 7.3% · cache 80.0% · fast · /ui",
		);

		footerData.getExtensionStatuses = () => new Map();
		expect(footer.render(200)[0]).toBe(
			".pi (main) · gpt-test · ctx 7.3% · cache 80.0% · /ui",
		);

		footer.dispose();
		expect(unsubscribed).toBe(true);
	});
});
