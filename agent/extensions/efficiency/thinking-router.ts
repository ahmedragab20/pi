/**
 * Raise the thinking level from the user prompt. It only ever raises — an
 * explicit Shift+Tab or `--thinking` choice always wins, and Shift+Tab locks
 * the router until `/thinking-router on`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Prompts that earn a bump to `high`. Everything else keeps the current level. */
const WANTS_HIGH =
	/\b(debug|why|root[- ]?cause|hang|deadlock|race condition|regression|design|architecture)\b/i;

const RANK: Record<string, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

function envDisabled(): boolean {
	const v = (process.env.PI_THINKING_ROUTER || "").trim().toLowerCase();
	return v === "0" || v === "off" || v === "false";
}

export function registerThinkingRouter(pi: ExtensionAPI): void {
	let enabled = !envDisabled();
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
		if (!WANTS_HIGH.test(event.text)) {
			armed = true;
			return;
		}
		// Never auto-lower. CLI `--thinking xhigh` must survive a matching prompt.
		const current = pi.getThinkingLevel();
		if ((RANK.high ?? 0) > (RANK[current] ?? 0)) {
			autoSetting = true;
			try {
				pi.setThinkingLevel("high");
			} finally {
				autoSetting = false;
			}
		}
		armed = true;
	});

	pi.registerCommand("thinking-router", {
		description: "Raise thinking from the prompt (on|off|status)",
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
