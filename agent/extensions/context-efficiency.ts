/**
 * Window-aware context efficiency.
 *
 * Small context windows (< 500k): early auto-compact around ~70% usage so
 * thinking + tools still have headroom.
 *
 * Large windows (500k / 1M+): no early trigger — stock compaction still runs
 * near `contextWindow - reserveTokens`, so this is not a barrier for big models.
 *
 * Commands:
 *   /context-efficiency  — show current window mode + usage
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** At/above this, leave compaction to stock near-limit behavior. */
const LARGE_CONTEXT_WINDOW = 500_000;

/**
 * For smaller windows, compact once usage crosses this percent of the window.
 * Example: 256k @ 70% ≈ 179k → leaves ~77k for continued work.
 */
const SMALL_WINDOW_COMPACT_PERCENT = 70;

const COMPACT_INSTRUCTIONS =
	"Preserve: goal, constraints, key decisions, file paths touched, failing tests/errors, next steps. Drop: raw tool dumps, repeated reads, verbose chatter.";

export default function (pi: ExtensionAPI) {
	let previousPercent: number | null = null;

	const trigger = (ctx: ExtensionContext) => {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Context efficiency: compacting at ≥${SMALL_WINDOW_COMPACT_PERCENT}% (small window)`,
				"info",
			);
		}
		ctx.compact({
			customInstructions: COMPACT_INSTRUCTIONS,
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.percent === null) {
			return;
		}

		// Large windows: never early-compact via this extension.
		if (usage.contextWindow >= LARGE_CONTEXT_WINDOW) {
			previousPercent = usage.percent;
			return;
		}

		const crossed =
			previousPercent !== null &&
			previousPercent < SMALL_WINDOW_COMPACT_PERCENT &&
			usage.percent >= SMALL_WINDOW_COMPACT_PERCENT;

		previousPercent = usage.percent;
		if (crossed) {
			trigger(ctx);
		}
	});

	pi.registerCommand("context-efficiency", {
		description: "Show context-efficiency mode for the current model window",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const usage = ctx.getContextUsage();
			if (!usage) {
				ctx.ui.notify("No context usage yet", "info");
				return;
			}
			const mode =
				usage.contextWindow >= LARGE_CONTEXT_WINDOW
					? "large-window · early compact OFF (stock near-limit only)"
					: `small-window · early compact at ${SMALL_WINDOW_COMPACT_PERCENT}%`;
			const tokens = usage.tokens ?? "?";
			const percent = usage.percent ?? "?";
			ctx.ui.notify(
				`${mode} · ${tokens}/${usage.contextWindow} (${percent}%)`,
				"info",
			);
		},
	});
}
