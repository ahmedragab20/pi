import { beforeEach, describe, expect, test } from "bun:test";
import contextEfficiency from "../extensions/context-efficiency.ts";
import { resetCompactionCoordinatorForTests } from "../extensions/efficiency/compaction-coordinator.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CompactOptions = {
	customInstructions?: string;
	onComplete?: () => void;
	onError?: (error: Error) => void;
};

function makeHarness(options: {
	contextWindow: number;
	tokens: number;
	percent: number;
	tier?: number;
}) {
	const handlers = new Map<string, Handler[]>();
	const compactCalls: CompactOptions[] = [];
	let usage = { ...options };
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand() {},
	};
	const ctx = {
		hasUI: false,
		model: options.tier
			? { cost: { tiers: [{ inputTokensAbove: options.tier }] } }
			: { cost: {} },
		getContextUsage: () => usage,
		isIdle: () => true,
		hasPendingMessages: () => false,
		compact: (compactOptions: CompactOptions) => {
			compactCalls.push(compactOptions);
			queueMicrotask(() => compactOptions.onComplete?.());
		},
	};
	contextEfficiency(pi as never);
	return {
		compactCalls,
		setUsage(next: { tokens: number; percent: number }) {
			usage = { ...usage, ...next };
		},
		async fire(event: string) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe("context efficiency watermark", () => {
	beforeEach(() => resetCompactionCoordinatorForTests());

	test("requests immediately when the first observed turn is already above 70 percent", async () => {
		const h = makeHarness({
			contextWindow: 100_000,
			tokens: 75_000,
			percent: 75,
		});
		await h.fire("turn_end");
		expect(h.compactCalls).toHaveLength(1);
		expect(h.compactCalls[0].customInstructions).toContain(
			"Compaction reasons: context-capacity",
		);
	});

	test("ordinary windows wait until the 70 percent capacity target", async () => {
		const h = makeHarness({
			contextWindow: 100_000,
			tokens: 69_999,
			percent: 69.999,
		});
		await h.fire("turn_end");
		expect(h.compactCalls).toHaveLength(0);
		h.setUsage({ tokens: 70_000, percent: 70 });
		await h.fire("turn_end");
		expect(h.compactCalls).toHaveLength(1);
	});

	test("large tiered windows compact at 88 percent of the first price boundary", async () => {
		const h = makeHarness({
			contextWindow: 1_050_000,
			tokens: 239_359,
			percent: (239_359 / 1_050_000) * 100,
			tier: 272_000,
		});
		await h.fire("turn_end");
		expect(h.compactCalls).toHaveLength(0);
		h.setUsage({ tokens: 239_360, percent: (239_360 / 1_050_000) * 100 });
		await h.fire("turn_end");
		expect(h.compactCalls).toHaveLength(1);
		expect(h.compactCalls[0].customInstructions).toContain(
			"Compaction reasons: context-price-tier",
		);
	});

	test("repeated turns above the watermark queue only one compaction", async () => {
		const h = makeHarness({
			contextWindow: 100_000,
			tokens: 80_000,
			percent: 80,
		});
		await h.fire("turn_end");
		await h.fire("turn_end");
		expect(h.compactCalls).toHaveLength(1);
	});
});
