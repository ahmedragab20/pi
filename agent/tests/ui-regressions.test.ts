import { expect, test } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "../npm/node_modules/@earendil-works/pi-tui/dist/index.js";
import todoExtension from "../extensions/todo.ts";
import compactFooterExtension from "../extensions/compact-footer.ts";

test("footer keeps actionable status ahead of optional metadata on narrow terminals", async () => {
	const handlers = new Map<string, Function>();
	let factory: Function | undefined;
	const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), events: { on: () => () => {}, emit() {} }, exec: async () => ({ code: 0, stdout: "" }) };
	compactFooterExtension(pi as never);
	const ctx = {
		hasUI: true, mode: "tui", cwd: "/workspace/a-very-long-project-name-that-cannot-fit",
		model: { id: "a-long-model-name" }, getContextUsage: () => ({ percent: 10 }),
		sessionManager: { getEntries: () => [] },
		ui: { setFooter: (fn: Function) => { factory = fn; } },
	};
	await handlers.get("session_start")!({}, ctx);
	const footer = factory!(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		{ getGitBranch: () => "feature/long-branch", onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map([["external-attention", "BLOCKED: approval needed"]]) },
	);
	try {
		const lines = footer.render(40);
		expect(lines.every((line: string) => visibleWidth(line) <= 40)).toBe(true);
		expect(lines.join("\n")).toContain("BLOCKED: approval needed");
	} finally { footer.dispose(); }
});

test("todos stays within the viewport and scrolls to all of a long task list", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		on: (name: string, handler: Function) => handlers.set(name, handler),
		events: { on() {}, emit() {} },
		registerTool() {}, appendEntry() {},
		registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
	};
	todoExtension(pi as never);
	let panel: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui", hasUI: true,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "todos", data: {
			nextId: 41, todos: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, done: false, text: `Task ${i + 1}: ${"long-path-".repeat(8)} END-${i + 1}` })),
		} }] },
		ui: {
			setWidget() {},
			custom: async (factory: Function) => {
				panel = factory({ requestRender() {}, terminal: { rows: 12, columns: 30 } }, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
			},
		},
	};
	await handlers.get("session_start")!({}, ctx);
	await commands.get("todos")!.handler("", ctx);
	const first = panel!.render(30);
	expect(first.length <= 12).toBe(true);
	expect(first.every((line) => visibleWidth(line) <= 30)).toBe(true);
	panel!.handleInput("\x1b[F");
	const last = panel!.render(30);
	expect(last.join("\n")).toContain("END-40");
	expect(last.join("\n")).not.toContain("Task 1:");
});
