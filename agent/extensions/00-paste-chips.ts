/**
 * Chip pasted images and large text, OpenCode-style, without remounting the editor.
 *
 * Hooks ctx.ui.setEditorComponent on session_start *before* pi-vim
 * install, so chips attach in-place. A delayed setEditorComponent was causing
 * the default editor to flash for a frame.
 *
 * Image chips are session-scoped: persist to ~/.pi/agent/vision at paste time
 * and do NOT reset the registry on submit (that made `[Image #2]` a dead chip).
 */
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ImageContent,
} from "@earendil-works/pi-coding-agent";
import {
	IMAGE_CHIP,
	chipLabel as imageChipLabel,
	getPaste,
	nextImageId,
	pastedMarker,
	persistImageFile,
	registerPaste,
	resetPasteRegistry,
	toImageContent,
	type SavedPaste,
} from "./paste-images.ts";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PASTE_CHIP = /\[Paste #(\d+)(?: · [^\]]+)?\]/g;
const LONG_LINES = 10;
const LONG_CHARS = 1000;
const HOOKED = Symbol.for("pi-paste-chips.ui-hooked");
const CHIPPED = Symbol.for("pi-paste-chips.editor");

type TextDraft = { id: number; text: string };

function expandHome(p: string): string {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function looksLikeImagePath(text: string): string | null {
	const trimmed = text.trim().replace(/^['"]|['"]$/g, "");
	if (!IMAGE_EXT.test(trimmed)) return null;
	if (
		!(
			trimmed.startsWith("/") ||
			trimmed.startsWith("~") ||
			trimmed.startsWith("file:")
		)
	) {
		return null;
	}
	const filePath = trimmed.startsWith("file:")
		? trimmed.slice("file://".length)
		: expandHome(trimmed);
	return filePath;
}

function isLongInsert(text: string): boolean {
	return text.split("\n").length > LONG_LINES || text.length > LONG_CHARS;
}

function chipLabel(text: string, id: number): string {
	const lines = text.split("\n").length;
	return lines > 1
		? `[Paste #${id} · ${lines} lines]`
		: `[Paste #${id} · ${text.length} chars]`;
}

export default function pasteChips(pi: ExtensionAPI) {
	let pastes: TextDraft[] = [];
	let pasteSeq = 0;

	const resetText = () => {
		pastes = [];
		pasteSeq = 0;
	};

	const attachChips = (editor: any) => {
		if (!editor || editor[CHIPPED]) return editor;
		editor[CHIPPED] = true;

		const insert =
			typeof editor.insertTextAtCursor === "function"
				? editor.insertTextAtCursor.bind(editor)
				: null;
		if (insert) {
			editor.insertTextAtCursor = (text: string) => {
				const imagePath = looksLikeImagePath(text);
				if (imagePath) {
					const persisted = persistImageFile(imagePath);
					if (!persisted) {
						insert(text);
						return;
					}
					const paste: SavedPaste = { id: nextImageId(), ...persisted };
					registerPaste(paste);
					insert(imageChipLabel(paste));
					return;
				}
				if (isLongInsert(text)) {
					pasteSeq += 1;
					pastes.push({ id: pasteSeq, text });
					insert(chipLabel(text, pasteSeq));
					return;
				}
				insert(text);
			};
		}

		const expanded =
			typeof editor.getExpandedText === "function"
				? editor.getExpandedText.bind(editor)
				: null;
		editor.getExpandedText = () => {
			let text = expanded ? expanded() : editor.getText();
			text = text.replace(
				new RegExp(PASTE_CHIP.source, "g"),
				(_m: string, id: string) => {
					const hit = pastes.find((p) => p.id === Number(id));
					return hit ? hit.text : _m;
				},
			);
			return text;
		};

		return editor;
	};

	const hookUi = (ui: {
		setEditorComponent: (factory: any) => void;
		getEditorComponent: () => any;
		[key: symbol]: unknown;
	}) => {
		if (ui[HOOKED]) return;
		ui[HOOKED] = true;
		const original = ui.setEditorComponent.bind(ui);
		ui.setEditorComponent = (factory: any) => {
			if (!factory) return original(undefined);
			return original((tui: unknown, theme: unknown, keybindings: unknown) =>
				attachChips(factory(tui, theme, keybindings)),
			);
		};
	};

	const onSession = (_event: unknown, ctx: { hasUI?: boolean; ui?: any }) => {
		if (!ctx.hasUI || !ctx.ui) return;
		hookUi(ctx.ui);
	};

	pi.on("session_start", onSession);
	pi.on("session_switch", (event, ctx) => {
		resetPasteRegistry();
		resetText();
		onSession(event, ctx);
	});
	pi.on("session_shutdown", () => {
		resetPasteRegistry();
		resetText();
	});

	pi.on("input", async (event) => {
		let text = event.text ?? "";
		const extraImages: ImageContent[] = [];

		text = text.replace(new RegExp(IMAGE_CHIP.source, "g"), (_m, id) => {
			const hit = getPaste(Number(id));
			if (!hit) return _m;
			extraImages.push(toImageContent(hit));
			return pastedMarker(hit);
		});

		text = text.replace(new RegExp(PASTE_CHIP.source, "g"), (_m, id) => {
			const hit = pastes.find((p) => p.id === Number(id));
			return hit ? hit.text : _m;
		});

		resetText();

		// Chips in this submit are the only attachments. Concatenating
		// `event.images` re-attached the first clipboard paste on later turns.
		if (extraImages.length === 0 && text === (event.text ?? "")) {
			return { action: "continue" as const };
		}
		return {
			action: "transform" as const,
			text: text.replace(/\n{3,}/g, "\n\n").trim(),
			images: extraImages,
		};
	});
}
