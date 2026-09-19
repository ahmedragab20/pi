import { afterEach, describe, expect, test } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../npm/node_modules/@earendil-works/pi-tui/dist/index.js";
import pasteChips from "../extensions/00-paste-chips.ts";
import { registerPaste, resetPasteRegistry, type SavedPaste } from "../extensions/paste-images.ts";

type Factory = (tui: unknown, theme: unknown, keybindings: unknown) => any;

// Mirrors the installed pi-vim editor's public CustomEditor contract. The
// extension under test owns the composition; this injected factory keeps the
// test independent from pi-vim's Node-only dependency graph under Bun 1.0.
class InjectedVimEditor {
	private text = "";
	constructor(
		readonly tui: unknown,
		readonly theme: unknown,
		readonly keybindings: unknown,
	) {}
	getText() { return this.text; }
	setText(text: string) { this.text = text; }
	insertTextAtCursor(text: string) { this.text += text; }
	getExpandedText() { return this.text; }
}

type Harness = {
	handlers: Map<string, Function[]>;
	factory?: Factory;
	fire(name: string, event?: unknown): Promise<void>;
	ctx: any;
};

function harness(): Harness {
	const handlers = new Map<string, Function[]>();
	let factory: Factory | undefined;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ui = {
		theme,
		setEditorComponent(next: Factory) {
			factory = next;
		},
		notify() {},
	};
	const ctx = {
		hasUI: true,
		cwd: "/workspace/project",
		ui,
		shutdown() {},
	};
	const pi = {
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { emit() {} },
		getCommands: () => [],
	};
	// paste-chips installs its setter hook before the installed pi-vim
	// session-start factory, matching the extension's documented order.
	pasteChips(pi as never);
	pi.on("session_start", () => {
		ui.setEditorComponent((tui: unknown, receivedTheme: unknown, keybindings: unknown) =>
			new InjectedVimEditor(tui, receivedTheme, keybindings));
	});
	return {
		handlers,
		get factory() { return factory; },
		ctx,
		async fire(name, event = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function editorArgs() {
	return [
		{ terminal: { rows: 24, columns: 80 }, requestRender() {} },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		new KeybindingsManager(TUI_KEYBINDINGS),
	] as const;
}

function image(id: number, base64: string, filePath: string): SavedPaste {
	return { id, base64, filePath, mimeType: "image/png", hash: `${id}`.repeat(64), bytes: 3, name: `synthetic-${id}.png` };
}

afterEach(() => resetPasteRegistry());

describe("paste chips with the installed pi-vim editor contract", () => {
	test("composes around an injected pi-vim factory and preserves arguments", async () => {
		const h = harness();
		await h.fire("session_start");
		expect(h.factory).toBeDefined();
		const args = editorArgs();
		const editor = h.factory!(...args);
		expect(editor instanceof InjectedVimEditor).toBe(true);
		expect(editor.tui).toBe(args[0]);
		expect(editor.theme).toBe(args[1]);
		expect(editor.keybindings).toBe(args[2]);
		expect(editor.getText()).toBe("");
		expect(editor.getExpandedText()).toBe("");
	});

	test("expands a multiline text chip through the real editor contract", async () => {
		const h = harness();
		await h.fire("session_start");
		const editor = h.factory!(...editorArgs());
		const longText = Array.from({ length: 11 }, (_, i) => `line-${i + 1}`).join("\n");
		editor.insertTextAtCursor(longText);
		expect(editor.getText()).toBe("[Paste #1 · 11 lines]");
		expect(editor.getExpandedText()).toBe(longText);
		const input = h.handlers.get("input")![0];
		const result = await input({ text: editor.getText() }, h.ctx);
		expect(result).toEqual({ action: "transform", text: longText, images: [] });
	});

	test("image chips use only images named in the current turn", async () => {
		const h = harness();
		await h.fire("session_start");
		registerPaste(image(1, "YWJj", "/sandbox/one.png"));
		registerPaste(image(2, "ZGVm", "/sandbox/two.png"));
		const input = h.handlers.get("input")![0];
		const first = await input({ text: "first [Image #1]" }, h.ctx);
		expect(first.action).toBe("transform");
		expect(first.images).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
		expect(first.text).toContain("[pasted image #1: synthetic-1.png → /sandbox/one.png]");
		const second = await input({ text: "second" }, h.ctx);
		expect(second).toEqual({ action: "continue" });
		const third = await input({ text: "third [Image #2]" }, h.ctx);
		expect(third.images).toEqual([{ type: "image", data: "ZGVm", mimeType: "image/png" }]);
		expect(first.images).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
	});

	test("each local UI factory invocation retains the chip wrapper", async () => {
		const h = harness();
		await h.fire("session_start");
		const first = h.factory!(...editorArgs());
		const second = h.factory!(...editorArgs());
		const text = "x".repeat(1001);
		first.insertTextAtCursor(text);
		second.insertTextAtCursor(text);
		expect(first.getText()).toBe("[Paste #1 · 1001 chars]");
		expect(second.getText()).toBe("[Paste #2 · 1001 chars]");
		expect(first.getExpandedText()).toBe(text);
		expect(second.getExpandedText()).toBe(text);
	});
});
