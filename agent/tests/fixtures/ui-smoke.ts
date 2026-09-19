/** Synthetic, credential-free PTY fixture. Never loaded by normal Pi discovery. */
import type { ExtensionAPI } from "../../npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import ui from "../../extensions/ui/index.ts";
import todo from "../../extensions/todo.ts";
import footer from "../../extensions/compact-footer.ts";
import timer from "../../extensions/working-timer.ts";
import { PANEL_OVERLAY, ScrollPanel } from "../../extensions/ui/panel.ts";
import { liveText } from "../../extensions/ui/presentation.ts";
import { UI_ACTIVITY } from "../../extensions/ui/events.ts";
import pasteChips from "../../extensions/00-paste-chips.ts";

const SYNTHETIC_PASTE = Array.from({ length: 12 }, (_, i) => `synthetic paste line ${i + 1}`).join("\n");

export default function smoke(pi: ExtensionAPI): void {
	pasteChips(pi);
	// Consume the paste test locally: even a broken expansion cannot invoke a model.
	pi.on("input", (event, ctx) => {
		ctx.ui.notify(event.text === SYNTHETIC_PASTE ? "PASTE_EXPANSION_OK" : "PASTE_EXPANSION_FAILED", "info");
		return { action: "handled" };
	});
	pi.on("session_start", () => {
		pi.appendEntry("todos", { nextId: 31, todos: Array.from({ length: 30 }, (_, i) => ({
			id: i + 1, done: false, text: `SYNTHETIC task ${i + 1}: ${"long-segment/".repeat(5)} END-${i + 1}`,
		})) });
	});
	todo(pi); timer(pi); footer(pi); ui(pi);
	pi.registerEntryRenderer("ui-smoke-card", (_entry, { expanded }) => liveText(() => [
		"SYNTHETIC_CARD_SUMMARY", ...(expanded ? ["SYNTHETIC_CARD_DETAILS_VISIBLE"] : []),
	]));
	pi.registerCommand("ui-smoke-activity", {
		description: "Synthetic spinner fixture; no work is executed",
		handler: async (args, ctx) => {
			if (args.trim() === "start") {
				pi.events.emit(UI_ACTIVITY, { id: "synthetic", state: "running", label: "SYNTHETIC_WORK" });
			} else {
				pi.events.emit(UI_ACTIVITY, { id: "synthetic", remove: true });
				ctx.ui.notify("UI_SMOKE_ACTIVITY_STOPPED", "info");
			}
		},
	});
	pi.registerCommand("ui-smoke-card", {
		description: "Synthetic expansion fixture",
		handler: async () => { pi.appendEntry("ui-smoke-card", {}); },
	});
	pi.registerShortcut("f7", {
		description: "Insert a synthetic multiline paste",
		handler: async (ctx) => { ctx.ui.pasteToEditor(SYNTHETIC_PASTE); },
	});
	pi.registerShortcut("f8", {
		description: "Synthetic input-preservation dialog",
		handler: async (ctx) => {
			await ctx.ui.custom<void>((tui, theme, keys, done) => new ScrollPanel({
				title: "SYNTHETIC_INPUT_DIALOG", tui, theme, keys, onClose: done,
				body: () => ["Close this panel; the draft must survive."],
			}), PANEL_OVERLAY);
		},
	});
	pi.registerShortcut("f9", {
		description: "Check synthetic editor draft",
		handler: async (ctx) => { ctx.ui.notify(ctx.ui.getEditorText() === "PRESERVED_DRAFT" ? "EDITOR_DRAFT_OK" : "EDITOR_DRAFT_FAILED", "info"); },
	});
	pi.on("ui_prompt_end", (_event, ctx) => { ctx.ui.notify("UI_SMOKE_DIALOG_CLOSED", "info"); });
	pi.on("session_start", (_event, ctx) => {
		const unsubscribe = pi.events.on("pi-vim:mode-change", (data) => {
			const mode = (data as { mode?: string }).mode;
			ctx.ui.notify(mode === "normal" ? "VIM_NORMAL" : "VIM_INSERT", "info");
		});
		pi.on("session_shutdown", unsubscribe);
		ctx.ui.notify("UI_SMOKE_READY — synthetic data only", "info");
	});
}
