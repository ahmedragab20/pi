import { describe, expect, test } from "bun:test";
import compactFooterExtension from "../extensions/compact-footer.ts";
import todoExtension from "../extensions/todo.ts";
import workingTimerExtension, {
	formatElapsed,
} from "../extensions/working-timer.ts";

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
	const tools: Record<string, { execute: Function }> = {};
	let eventsApi: {
		on: (name: string, fn: (event: unknown) => void) => void;
		emit: (name: string, event: unknown) => void;
	};
	eventsApi = {
		on(name, fn) {
			const list = listeners.get(name) ?? [];
			list.push(fn);
			listeners.set(name, list);
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
		registerTool(tool: { name: string; execute: Function }) {
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

describe("todo/agent widget (balanced compact UI)", () => {
	test("renders one task line, tracks agent lifecycle, and drops settled agents", async () => {
		const { pi, handlers, tools, emit } = makePi();
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

		let factory = widgets.get("todos") as (
			tui: unknown,
			theme: TestTheme,
		) => { render: (width: number) => string[] };
		expect(typeof factory).toBe("function");
		let lines = factory(undefined, plainTheme).render(200);
		const taskLine = lines.find((l) => l.includes("Tasks 0/1"));
		expect(taskLine).toBeDefined();
		expect(taskLine).toContain("next #1 Inspect workspace");
		expect(taskLine).toContain("/todos");

		emit("subagents:started", { id: "a1" });
		factory = widgets.get("todos") as typeof factory;
		lines = factory(undefined, plainTheme).render(200);
		const agentLine = lines[1];
		expect(agentLine).toContain("Agents 1 running");
		expect(agentLine).toContain("/agents");

		// created after started must not downgrade running -> queued
		emit("subagents:created", { id: "a1" });
		factory = widgets.get("todos") as typeof factory;
		lines = factory(undefined, plainTheme).render(200);
		expect(lines[1]).toContain("Agents 1 running");
		expect(lines[1]).not.toContain("queued");

		emit("subagents:completed", { id: "a1" });
		factory = widgets.get("todos") as typeof factory;
		lines = factory(undefined, plainTheme).render(200);
		expect(lines.some((l) => l.includes("Agents"))).toBe(false);
		expect(lines.some((l) => l.includes("Tasks 0/1"))).toBe(true);
	});
});

describe("working timer", () => {
	test("formatElapsed renders mm:ss and h:mm:ss", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(65_000)).toBe("01:05");
		expect(formatElapsed(3_723_000)).toBe("1:02:03");
	});

	test("shows elapsed while working and final duration on settle", async () => {
		const { pi, handlers } = makePi();
		workingTimerExtension(pi as never);

		const workingMessages: (string | undefined)[] = [];
		const statuses = new Map<string, string | undefined>();
		const ctx = {
			hasUI: true,
			ui: {
				setWorkingMessage(message?: string) {
					workingMessages.push(message);
				},
				setStatus(key: string, text?: string) {
					statuses.set(key, text);
				},
				theme: plainTheme,
			},
		};

		let now = 0;
		const realNow = Date.now;
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		let intervalCb: (() => void) | undefined;
		let intervalCleared = false;
		try {
			Date.now = () => now;
			(globalThis as Record<string, unknown>).setInterval = (cb: () => void) => {
				intervalCb = cb;
				return 123 as unknown as ReturnType<typeof setInterval>;
			};
			(globalThis as Record<string, unknown>).clearInterval = () => {
				intervalCleared = true;
			};

			handlers.get("session_start")![0]({}, ctx);
			now = 1_000;
			await handlers.get("agent_start")![0]({}, ctx);
			expect(workingMessages.at(-1)).toBe("Working... 00:00");

			now += 65_000;
			intervalCb!();
			expect(workingMessages.at(-1)).toBe("Working... 01:05");

			await handlers.get("agent_settled")![0]({}, ctx);
			expect(workingMessages.at(-1)).toBeUndefined();
			expect(statuses.get("working-timer")).toBe("last 01:05");
			expect(intervalCleared).toBe(true);

			intervalCleared = false;
			await handlers.get("agent_start")![0]({}, ctx);
			handlers.get("session_shutdown")![0]({}, ctx);
			expect(intervalCleared).toBe(true);
		} finally {
			Date.now = realNow;
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
	});
});

describe("compact footer", () => {
	test("renders a single balanced line and wires branch subscription as dispose", () => {
		const { pi, handlers } = makePi();
		compactFooterExtension(pi as never);

		let footerFactory: unknown;
		const ctx = {
			hasUI: true,
			cwd: "/Users/test/.pi",
			model: { id: "gpt-test" },
			getContextUsage: () => ({ percent: 7.3 }),
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
					["diffing", "diffing: no server"],
					["fast-mode", "fast"],
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
		expect(lines[0]).toBe(".pi (main) · 7.3% · gpt-test · TS · fast");

		footer.dispose();
		expect(unsubscribed).toBe(true);
	});
});
