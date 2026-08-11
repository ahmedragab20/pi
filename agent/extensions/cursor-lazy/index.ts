/**
 * Lazy Cursor provider loader.
 *
 * pi-cursor-sdk is deliberately NOT in settings `packages`: loading it at
 * startup costs ~0.64s (~44% of pi startup) because it statically imports the
 * 25MB Cursor SDK and registers the whole Cursor model catalog (~280 models).
 * This extension keeps startup fast and hydrates the provider on demand:
 *
 *   /cursor-load    register the Cursor provider + models (immediate, no restart)
 *   /cursor-unload  unregister it again
 *
 * The SDK lives in this extension's own node_modules (see package.json), so
 * `pi update` does not manage it. Update it with `npm install` in this dir.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SDK_ENTRY = fileURLToPath(
	new URL(
		path.join("node_modules", "pi-cursor-sdk", "src", "index.ts"),
		import.meta.url,
	),
);

let loaded = false;

export default async function (pi: ExtensionAPI) {
	pi.registerCommand("cursor-load", {
		description: "Load the Cursor provider and models on demand",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (loaded) {
				ctx.ui.notify("Cursor provider already loaded", "info");
				return;
			}
			try {
				const mod = await import(SDK_ENTRY);
				await mod.default(pi);
				loaded = true;
				ctx.ui.notify(
					"Cursor provider loaded — cursor models now in Ctrl+P",
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to load Cursor provider: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("cursor-unload", {
		description: "Unregister the Cursor provider",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				pi.unregisterProvider("cursor");
				loaded = false;
				ctx.ui.notify("Cursor provider unloaded", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to unload Cursor provider: ${message}`, "error");
			}
		},
	});
}
