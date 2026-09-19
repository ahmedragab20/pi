import { describe, expect, test } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "../npm/node_modules/@earendil-works/pi-tui/dist/index.js";
import uiExtension from "../extensions/ui/index.ts";
import todoExtension from "../extensions/todo.ts";
import timerExtension from "../extensions/working-timer.ts";
import footerExtension from "../extensions/compact-footer.ts";
import { ActivityState } from "../extensions/ui/activity.ts";
import { fitSegments, liveText, singleLine, statusText } from "../extensions/ui/presentation.ts";
import { framePanel, ScrollPanel } from "../extensions/ui/panel.ts";
import { UI_ACTIVITY, UI_SNAPSHOT_REQUEST, UI_TASKS } from "../extensions/ui/events.ts";

type Component = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function harness(uiFirst = false, mode = "tui") {
	const handlers = new Map<string, Function[]>();
	const listeners = new Map<string, Set<Function>>();
	const commands = new Map<string, { handler: Function }>();
	const tools = new Map<string, { execute: Function; parameters: unknown }>();
	const widgets = new Map<string, Component>();
	const entries: unknown[] = [];
	const statuses = new Map<string, string>([["pi-lens-lsp", "ready"], ["external-warning", "Inspect build output"]]);
	const expansion: boolean[] = [];
	const working: boolean[] = [];
	let renders = 0;
	const host = { terminal: { rows: 20, columns: 80 }, requestRender() { renders++; } };
	const bus = {
		on(name: string, fn: Function) {
			const set = listeners.get(name) ?? new Set();
			set.add(fn); listeners.set(name, set);
			return () => { set.delete(fn); };
		},
		emit(name: string, data: unknown) { for (const fn of listeners.get(name) ?? []) fn(data); },
	};
	let footer: Component | undefined;
	let panel: Component | undefined;
	let idle = true;
	let editorText = "unfinished user draft";
	let apiWrites = 0;
	const pi = {
		on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		events: bus,
		registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: Function; parameters: unknown }) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		exec: async () => ({ code: 0, stdout: "", killed: false }),
	};
	const ctx = {
		mode, hasUI: mode !== "print", cwd: "/workspace/project", model: { id: "test-model", provider: "test" },
		isIdle: () => idle, getContextUsage: () => ({ percent: 9.5, tokens: 950, contextWindow: 10000 }),
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
		ui: {
			theme: plainTheme,
			setWidget(key: string, value: Function | string[] | undefined) {
				if (!value) widgets.delete(key);
				else if (typeof value === "function") widgets.set(key, value(host, plainTheme));
			},
			setFooter(factory?: Function) {
				footer?.dispose?.();
				footer = factory?.(host, plainTheme, { getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {} });
			},
			setStatus(key: string, text?: string) { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
			setWorkingVisible: (value: boolean) => working.push(value),
			setWorkingIndicator() {},
			setToolsExpanded: (value: boolean) => expansion.push(value),
			notify() {},
			getEditorText: () => editorText,
			setEditorText: (text: string) => { apiWrites++; editorText = text; },
			setEditorComponent: () => { apiWrites++; },
			custom: async (factory: Function) => {
				panel?.dispose?.();
				panel = factory(host, plainTheme, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
			},
		},
	};
	for (const extension of uiFirst ? [uiExtension, todoExtension, timerExtension, footerExtension] : [todoExtension, timerExtension, footerExtension, uiExtension]) extension(pi as never);
	const fire = async (name: string, event: unknown = {}) => {
		if (name === "agent_start") idle = false;
		if (name === "agent_settled") idle = true;
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	return {
		ctx, tools, commands, widgets, entries, bus, expansion, working,
		fire, host,
		line: (width = 120) => plain(widgets.get("harness-activity")?.render(width) ?? []),
		panel: () => panel!,
		writes: () => apiWrites,
		renders: () => renders,
		listeners: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
		async start(reason = "startup") { await fire("session_start", { reason }); },
		async stop() { panel?.dispose?.(); await fire("session_shutdown"); },
	};
}

describe("unified activity", () => {
	for (const uiFirst of [false, true]) test(`one activity widget regardless of extension order (${uiFirst})`, async () => {
		const h = harness(uiFirst);
		await h.start();
		try {
			await h.tools.get("todo")!.execute("add", { action: "add", text: "Inspect UI" }, undefined, undefined, h.ctx);
			expect(h.line()).toContain("tasks 0/1");
			h.bus.emit("subagents:started", { id: "a" });
			h.bus.emit("subagents:created", { id: "a" });
			expect(h.line()).toContain("1 worker running");
			expect(h.line()).not.toContain("queued");
			h.bus.emit(UI_ACTIVITY, { id: "vision", state: "running", label: "Describing images" });
			expect(h.line()).toContain("Describing images");
			expect([...h.widgets.keys()]).toEqual(["harness-activity"]);
			h.bus.emit("subagents:completed", { id: "a" });
			h.bus.emit(UI_ACTIVITY, { id: "vision", remove: true });
			expect(h.line()).not.toContain("worker");
			expect(h.line()).not.toContain("images");
			await h.tools.get("todo")!.execute("done", { action: "toggle", id: 1 }, undefined, undefined, h.ctx);
			expect(h.line()).toContain("tasks 1/1");
			expect([...h.tools.keys()]).toEqual(["todo"]); // UI does not replace built-ins/third-party tools.
		} finally { await h.stop(); }
		expect(h.listeners()).toBe(0);
	});

	test("nested prompts, parallel completion and cancellation remain truthful", async () => {
		const h = harness(); await h.start();
		try {
			await h.fire("agent_start");
			await h.fire("tool_execution_start", { toolCallId: "1", toolName: "bash" });
			await h.fire("tool_execution_start", { toolCallId: "2", toolName: "read" });
			expect(h.line()).toContain("Running command +1");
			await h.fire("ui_prompt_start", { kind: "confirm", title: "Approve command?" });
			await h.fire("ui_prompt_start", { kind: "custom" });
			expect(h.line()).toContain("Dialog open");
			await h.fire("ui_prompt_end");
			expect(h.line(25)).toContain("Approve command?");
			await h.fire("ui_prompt_end");
			await h.fire("tool_execution_end", { toolCallId: "2", isError: false });
			expect(h.line()).toContain("Running command");
			expect(h.line()).not.toContain("+1");
			await h.fire("tool_execution_end", { toolCallId: "1", isError: true });
			await h.fire("message_end", { message: { role: "assistant", stopReason: "aborted" } });
			await h.fire("agent_settled");
			expect(h.line()).toContain("Cancelled");
			expect(h.line()).not.toContain("success");
			await h.fire("agent_start");
			await h.fire("message_end", { message: { role: "assistant", stopReason: "error" } });
			await h.fire("message_end", { message: { role: "assistant", stopReason: "stop" } });
			await h.fire("agent_settled");
			expect(h.line()).not.toContain("failed"); // A successful provider retry clears its earlier failure.
		} finally { await h.stop(); }
	});

	test("reload cleans listeners, reconstructs tasks and preserves expansion choice", async () => {
		const h = harness(); await h.start();
		await h.tools.get("todo")!.execute("1", { action: "add", text: "Keep task" }, undefined, undefined, h.ctx);
		const subscriptions = h.listeners();
		await h.stop();
		expect(h.listeners()).toBe(0);
		await h.start("reload");
		try {
			expect(h.listeners()).toBe(subscriptions);
			expect(h.line()).toContain("tasks 0/1");
			expect(h.expansion).toEqual([false]);
			h.bus.emit(UI_TASKS, { done: -1, total: 99 });
			expect(h.line()).toContain("tasks 0/1");
			h.entries.length = 0;
			await h.fire("session_tree");
			expect(h.line()).not.toContain("tasks");
		} finally { await h.stop(); }
	});

	test("details and synthetic preview leave editor, execution and task state alone", async () => {
		const h = harness(); await h.start();
		try {
			h.bus.emit(UI_SNAPSHOT_REQUEST, {});
			await h.commands.get("ui")!.handler("", h.ctx);
			const details = plain(h.panel().render(120));
			expect(details).toContain("/workspace/project");
			await h.commands.get("ui")!.handler("preview", h.ctx);
			const preview = h.panel();
			for (const width of [0, 1, 12, 40, 80, 120]) {
				const lines = preview.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.length <= h.host.terminal.rows).toBe(true);
			}
			expect(plain(preview.render(120))).toContain("Synthetic examples only");
			preview.handleInput?.("\x1b");
			expect(h.ctx.ui.getEditorText()).toBe("unfinished user draft");
			expect(h.writes()).toBe(0);
			expect(h.entries).toEqual([]);
			expect(h.line()).toBe("");
		} finally { await h.stop(); }
	});

	test("RPC and print do not install terminal components or register execution overrides", async () => {
		for (const mode of ["rpc", "print"]) {
			const h = harness(false, mode); await h.start();
			try {
				await h.fire("agent_start");
				await h.commands.get("ui")!.handler("preview", h.ctx);
				expect(h.widgets.size).toBe(0);
				expect(h.expansion).toEqual([]);
				expect(h.working).toEqual([]);
			} finally { await h.stop(); }
		}
	});
});

test("animation ticks for background work and preview, then stops on completion and disposal", async () => {
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	const timers = new Map<object, { callback: () => void; ms: number }>();
	globalThis.setInterval = ((callback: () => void, ms: number) => {
		const handle = { unref() {} };
		timers.set(handle, { callback, ms });
		return handle;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((handle: object) => { timers.delete(handle); }) as unknown as typeof clearInterval;
	const animationTimers = () => [...timers.values()].filter((timer) => timer.ms === 80);
	const h = harness();
	try {
		await h.start();
		expect(animationTimers()).toHaveLength(0);
		h.bus.emit("subagents:created", { id: "worker" });
		expect(animationTimers()).toHaveLength(0);
		h.bus.emit("subagents:started", { id: "worker" });
		expect(animationTimers()).toHaveLength(1);
		const before = h.renders();
		animationTimers()[0].callback();
		expect(h.renders()).toBe(before + 1);
		h.bus.emit("subagents:completed", { id: "worker" });
		expect(animationTimers()).toHaveLength(0);
		h.bus.emit(UI_ACTIVITY, { id: "vision", state: "running", label: "Describing" });
		expect(animationTimers()).toHaveLength(1);
		h.bus.emit(UI_ACTIVITY, { id: "vision", state: "success", label: "Ready" });
		expect(animationTimers()).toHaveLength(0);
		await h.commands.get("ui")!.handler("preview", h.ctx);
		expect(animationTimers()).toHaveLength(1);
		h.panel().handleInput?.("\x1b");
		expect(animationTimers()).toHaveLength(0);
		await h.fire("agent_start");
		expect(animationTimers()).toHaveLength(1);
		await h.stop();
		expect(timers.size).toBe(0);
	} finally {
		await h.stop();
		globalThis.setInterval = originalSet;
		globalThis.clearInterval = originalClear;
	}
});

describe("real terminal primitives", () => {
	test("running indicators cycle the exact Braille sequence and leave settled states static", () => {
		const state = new ActivityState();
		state.start();
		const frames = Array.from({ length: 11 }, (_, frame) => stripTerminalSequences(state.render(plainTheme, 80, frame * 80))[0]);
		expect(frames).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋"]);
		state.settle();
		state.workers.set("worker", "running");
		expect(state.render(plainTheme, 80, 80)).toContain("⠙ 1 worker running");
		state.workers.clear();
		state.external.set("vision", { id: "vision", state: "running", label: "Vision" });
		expect(state.render(plainTheme, 80, 160)).toContain("⠹ Vision");
		state.external.clear();
		state.outcome = "cancelled";
		expect(state.render(plainTheme, 80, 0)).toBe(state.render(plainTheme, 80, 80));
	});

	test("popup borders are square, continuous, and ANSI/Unicode width-safe", () => {
		const lines = framePanel(24, 20, plainTheme, "Details", ["Body"], "esc close");
		expect(lines[0]).toBe(`┌─ Details ${"─".repeat(12)}┐`);
		expect(lines.at(-1)).toBe("└──────────────────────┘");
		expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
		const colored = { ...plainTheme, fg: (_key: string, text: string) => `\x1b[32m${text}\x1b[0m` };
		for (const width of [0, 1, 3, 4, 5, 12, 40, 80]) {
			const output = framePanel(width, 12, colored, "日本語👩‍💻".repeat(20), ["long body ".repeat(20)], "esc close");
			expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(/[╭╮╰╯]/.test(plain(output))).toBe(false);
		}
	});
	test("priority, Unicode width and control-safe titles", () => {
		expect(singleLine("file\x1b[31m.ts\nnext")).toBe("file.ts next");
		const line = fitSegments([{ text: "low ".repeat(30), priority: 1 }, { text: "approval needed", priority: 100 }], 20);
		expect(stripTerminalSequences(line)).toBe("approval needed");
		const state = new ActivityState();
		state.start(); state.tools.set("1", "日本語👩‍💻".repeat(20));
		for (const width of [1, 2, 12, 40, 80]) expect(visibleWidth(state.render(plainTheme, width)) <= width).toBe(true);
	});

	test("theme invalidation recomputes colored content", () => {
		let color = 31;
		const theme = { ...plainTheme, fg: (_name: string, text: string) => `\x1b[${color}m${text}\x1b[0m` };
		const component = liveText(() => [statusText(theme, "running", "Working")]);
		expect(component.render(40)[0]).toContain("\x1b[31m");
		color = 32; component.invalidate();
		expect(component.render(40)[0]).toContain("\x1b[32m");
		expect(component.render(40)[0]).not.toContain("\x1b[31m");
	});

	test("panel uses configured keys and wraps every part of long Unicode content", () => {
		let closed = 0;
		const panel = new ScrollPanel({
			title: "Details", theme: plainTheme, tui: { terminal: { rows: 10 }, requestRender() {} },
			keys: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+q", "tui.select.down": "j" }),
			body: () => ["日本語👩‍💻".repeat(30) + "THE-END"], onClose: () => { closed++; },
		});
		panel.render(40); panel.handleInput("\x1b[F");
		expect(plain(panel.render(40))).toContain("THE-END");
		expect(plain(panel.render(40))).toContain("ctrl+q");
		panel.handleInput("\x11");
		expect(closed).toBe(1);
	});
});
