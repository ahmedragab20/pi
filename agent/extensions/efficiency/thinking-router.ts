/**
 * Route thinking level from the user prompt. Shift+Tab locks until /thinking-router on.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HIGH =
	/\b(debug|why|root[- ]?cause|hang|design|architecture|review)\b/i;
const LOW =
	/\b(commit|format|rename|show|list|explain briefly)\b/i;

function classify(text: string): ThinkingLevel {
	if (HIGH.test(text)) return "high";
	if (LOW.test(text)) return "low";
	return "medium";
}

export function registerThinkingRouter(pi: ExtensionAPI): void {
	let enabled = true;
	let locked = false;
	let autoSetting = false;
	let armed = false;

	pi.on("session_start", (event) => {
		if (event.reason === "new" || event.reason === "startup") {
			locked = false;
			armed = false;
		}
	});

	pi.on("thinking_level_select", () => {
		if (autoSetting || !armed) return;
		if (enabled) locked = true;
	});

	pi.on("input", (event, ctx) => {
		if (!enabled || locked) {
			armed = true;
			return;
		}
		if (event.source !== "interactive") return;
		if (!ctx.model?.reasoning) {
			armed = true;
			return;
		}
		const level = classify(event.text);
		if (level !== pi.getThinkingLevel()) {
			autoSetting = true;
			try {
				pi.setThinkingLevel(level);
			} finally {
				autoSetting = false;
			}
		}
		armed = true;
	});

	pi.registerCommand("thinking-router", {
		description: "Auto thinking from the prompt (on|off|status)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const cmd = args.trim().toLowerCase() || "status";
			if (cmd === "on") {
				enabled = true;
				locked = false;
				ctx.ui.notify("thinking-router on", "info");
				return;
			}
			if (cmd === "off") {
				enabled = false;
				ctx.ui.notify("thinking-router off", "info");
				return;
			}
			ctx.ui.notify(
				`thinking-router ${enabled ? "on" : "off"}${locked ? " · locked (Shift+Tab)" : ""} · ${pi.getThinkingLevel()}`,
				"info",
			);
		},
	});
}
