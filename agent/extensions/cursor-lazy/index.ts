/**
 * Cached Cursor provider loader.
 *
 * Cursor registers at startup so `enabledModels` can resolve Cursor entries.
 * Warm starts use pi-cursor-sdk's disk-cached catalog and avoid network I/O.
 *
 *   /cursor-load             confirm the provider is loaded
 *   /cursor-load --refresh   fetch Cursor's live catalog and replace the cache
 *   /cursor-unload           unregister the provider
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const SDK_ROOT = fileURLToPath(
	new URL(path.join("node_modules", "pi-cursor-sdk", "src"), import.meta.url),
);
const SDK_ENTRY = path.join(SDK_ROOT, "index.ts");

let loaded = false;

async function refreshCursorProvider(
	pi: ExtensionAPI,
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
): Promise<void> {
	const [{ discoverModels }, { streamCursorLazy }, apiKeyModule] =
		await Promise.all([
			import(path.join(SDK_ROOT, "model-discovery.ts")),
			import(path.join(SDK_ROOT, "cursor-provider-lazy.ts")),
			import(path.join(SDK_ROOT, "cursor-api-key.ts")),
		]);
	const apiKey = apiKeyModule.resolveCursorApiKey(
		await ctx.modelRegistry.getApiKeyForProvider("cursor"),
	);
	let fallbackMessage: string | undefined;
	const models: ProviderModelConfig[] = await discoverModels({
		apiKey,
		forceRefresh: true,
		onFallback: (issue: { message: string }) => {
			fallbackMessage = issue.message;
		},
	});
	const config: ProviderConfig = {
		name: "Cursor",
		baseUrl: "https://cursor.com",
		apiKey: apiKeyModule.CURSOR_API_KEY_CONFIG_VALUE,
		api: "cursor-sdk",
		models,
		streamSimple: streamCursorLazy,
	};
	pi.registerProvider("cursor", config);
	if (fallbackMessage) {
		ctx.ui.notify(
			`Cursor refresh used a fallback catalog: ${fallbackMessage}`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(
		`Cursor catalog refreshed with ${models.length} models. Start a new session to refresh scoped models.`,
		"info",
	);
}

export default async function (pi: ExtensionAPI) {
	const sdk = await import(SDK_ENTRY);
	await sdk.default(pi);
	loaded = true;

	pi.registerCommand("cursor-load", {
		description: "Confirm Cursor is loaded, or refresh with --refresh",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim() === "--refresh") {
				try {
					await refreshCursorProvider(pi, ctx);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					ctx.ui.notify(
						`Failed to refresh Cursor provider: ${message}`,
						"error",
					);
				}
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /cursor-load [--refresh]", "warning");
				return;
			}
			ctx.ui.notify(
				loaded
					? "Cursor provider already loaded"
					: "Cursor provider is unloaded",
				"info",
			);
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
