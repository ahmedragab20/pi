/**
 * Window- and price-aware context efficiency.
 *
 * Compaction is requested at 70% of an ordinary context window. When a model
 * has a higher-price input tier before the context limit, request before that
 * boundary instead. The shared coordinator waits for `agent_settled`, so this
 * extension never aborts a turn or races another compaction caller.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { requestCompaction } from "./efficiency/compaction-coordinator.ts";

const DEFAULT_COMPACT_PERCENT = 70;
const PRICE_TIER_HEADROOM = 0.88;
const COMPACT_INSTRUCTIONS =
	"Preserve: goal, constraints, key decisions, file paths touched, failing tests/errors, background agent handles, and the next concrete action. Drop: raw tool dumps, repeated reads, and verbose chatter.";

type TieredModel = {
	cost?: { tiers?: { inputTokensAbove?: number }[] };
};

type Watermark = {
	tokens: number;
	percent: number;
	mode: "capacity" | "price-tier";
};

function watermark(ctx: ExtensionContext, contextWindow: number): Watermark {
	const tiers = (ctx.model as TieredModel | undefined)?.cost?.tiers ?? [];
	const firstTier = tiers
		.map((tier) => tier.inputTokensAbove)
		.filter(
			(value): value is number =>
				typeof value === "number" && value > 0 && value < contextWindow,
		)
		.sort((a, b) => a - b)[0];
	const capacityTarget = Math.floor(
		contextWindow * (DEFAULT_COMPACT_PERCENT / 100),
	);
	const tokens = firstTier
		? Math.min(capacityTarget, Math.floor(firstTier * PRICE_TIER_HEADROOM))
		: capacityTarget;
	return {
		tokens,
		percent: (tokens / contextWindow) * 100,
		mode: firstTier && tokens < capacityTarget ? "price-tier" : "capacity",
	};
}

export default function contextEfficiency(pi: ExtensionAPI) {
	let requested = false;

	const reset = () => {
		requested = false;
	};
	pi.on("session_start", reset);
	pi.on("session_compact", reset);

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number") return;
		const target = watermark(ctx, usage.contextWindow);
		if (usage.tokens < target.tokens) {
			requested = false;
			return;
		}
		if (requested) return;
		requested = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Context efficiency: queued ${target.mode} compaction at ${Math.round(target.percent)}%`,
				"info",
			);
		}
		requestCompaction(ctx, {
			reason: `context-${target.mode}`,
			customInstructions: COMPACT_INSTRUCTIONS,
			minPercent: target.percent,
			onError: (error) => {
				requested = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	});

	pi.registerCommand("context-efficiency", {
		description: "Show the active capacity/price compaction watermark",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const usage = ctx.getContextUsage();
			if (!usage) {
				ctx.ui.notify("No context usage yet", "info");
				return;
			}
			const target = watermark(ctx, usage.contextWindow);
			const tokens = usage.tokens ?? "?";
			const percent = usage.percent ?? "?";
			ctx.ui.notify(
				`${target.mode} compact at ${target.tokens} tokens (${Math.round(target.percent)}%) · ${tokens}/${usage.contextWindow} (${percent}%)`,
				"info",
			);
		},
	});
}
