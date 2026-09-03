/**
 * Summarize with Flash instead of the lead. Keeps stock cut point + file lists.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	isModelExhausted,
	isUsageLimitError,
	markExhaustedFromError,
} from "../opencode-fallback.ts";
import { CHEAP_COMPACT_MODELS } from "./constants.ts";

function fileOpsXml(fileOps: {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}): { xml: string; readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	let xml = "";
	if (readFiles.length > 0) {
		xml += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
	}
	if (modifiedFiles.length > 0) {
		xml += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
	}
	return { xml, readFiles, modifiedFiles };
}

export function registerCheapCompact(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const all = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		];
		if (all.length === 0) return;

		let model: Model<any> | undefined;
		let apiKey: string | undefined;
		let headers: Record<string, string> | undefined;
		let env: Record<string, string> | undefined;

		for (const [provider, id] of CHEAP_COMPACT_MODELS) {
			if (isModelExhausted(provider, id)) continue;
			const candidate = ctx.modelRegistry.find(provider, id);
			if (!candidate) continue;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
			if (!auth.ok) continue;
			model = candidate;
			apiKey = auth.apiKey;
			headers = auth.headers as Record<string, string> | undefined;
			env = auth.env;
			break;
		}
		if (!model) return;

		if (ctx.hasUI) {
			ctx.ui.notify(`Compacting with ${model.provider}/${model.id} …`, "info");
		}

		try {
			const result = await generateSummaryWithUsage(
				all,
				model,
				preparation.settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				preparation.previousSummary,
				"off",
				undefined,
				env,
			);
			if (!result.text.trim() || signal.aborted) return;

			const files = fileOpsXml(preparation.fileOps);
			return {
				compaction: {
					summary: `${result.text.trim()}${files.xml}`,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: result.usage,
					details: {
						readFiles: files.readFiles,
						modifiedFiles: files.modifiedFiles,
					},
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (model && isUsageLimitError(message)) {
				markExhaustedFromError(message, `${model.provider}/${model.id}`);
			}
			if (ctx.hasUI && !signal.aborted) {
				ctx.ui.notify(`Cheap compact failed, using stock: ${message}`, "warning");
			}
		}
	});
}
