/**
 * Core coding tools stay on. Package extras start off; tool_search activates them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CORE_ALWAYS, CORE_IF_PRESENT } from "./constants.ts";

function coreTools(pi: ExtensionAPI): string[] {
	const available = new Set(pi.getAllTools().map((t) => t.name));
	const names = [...CORE_ALWAYS];
	for (const extra of CORE_IF_PRESENT) {
		if (available.has(extra)) names.push(extra);
	}
	return names.filter((n) => available.has(n) || n === "tool_search");
}

function applyCore(pi: ExtensionAPI): string[] {
	const names = coreTools(pi);
	pi.setActiveTools(names);
	return names;
}

export function registerDeferredTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description:
			"Find and activate deferred tools (LSP, ast-grep, reports, package extras). Core tools (read/bash/edit/write/ls/Agent/find/grep) are already on. Call this when you need a capability that is not in the active tool list.",
		promptSnippet:
			"Search for additional tools when the active tools cannot perform the task (LSP, ast-grep, project reports).",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Capability to search for, e.g. lsp, ast-grep, symbol, diagnostics",
			}),
		}),
		async execute(_id, params) {
			const q = params.query.trim().toLowerCase();
			if (!q) {
				return {
					content: [
						{ type: "text", text: "Pass a query such as lsp, ast-grep, or symbol." },
					],
					details: { matches: [], added: [] },
				};
			}

			const active = new Set(pi.getActiveTools());
			const matches = pi
				.getAllTools()
				.filter((t) => {
					const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
					return q.split(/\s+/).every((term) => hay.includes(term));
				})
				.map((t) => t.name);

			const added = matches.filter((n) => !active.has(n));
			if (added.length > 0) {
				pi.setActiveTools([...active, ...added]);
			}

			const text =
				matches.length === 0
					? `No tools matched "${params.query}".`
					: added.length === 0
						? `Already active: ${matches.join(", ")}`
						: `Activated: ${added.join(", ")}`;

			return {
				content: [{ type: "text", text }],
				details: { matches, added },
			};
		},
	});

	pi.on("session_start", () => {
		applyCore(pi);
	});

	pi.registerCommand("tools", {
		description: "List deferred tools, or `reset` to restore the core set",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (args.trim().toLowerCase() === "reset") {
				const names = applyCore(pi);
				ctx.ui.notify(`tools reset · ${names.length} core`, "info");
				return;
			}

			const active = new Set(pi.getActiveTools());
			const deferred = pi
				.getAllTools()
				.map((t) => t.name)
				.filter((n) => !active.has(n));
			const activeList = [...active].sort().join(", ") || "(none)";
			const deferredList = deferred.sort().join(", ") || "(none)";
			ctx.ui.notify(`active: ${activeList}\ndeferred: ${deferredList}`, "info");
		},
	});
}
