import { beforeEach, describe, expect, test } from "bun:test";
import {
	registerCompactionCoordinator,
	requestCompaction,
	resetCompactionCoordinatorForTests,
} from "../extensions/efficiency/compaction-coordinator.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CompactOptions = {
	customInstructions?: string;
	onComplete?: () => void;
	onError?: (error: Error) => void;
};

function makeHarness() {
	const handlers = new Map<string, Handler[]>();
	const calls: CompactOptions[] = [];
	let idle = true;
	let hasPending = false;
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	const ctx = {
		isIdle: () => idle,
		hasPendingMessages: () => hasPending,
		getContextUsage: () => ({ percent: 80 }),
		compact: (options: CompactOptions) => calls.push(options),
	};
	registerCompactionCoordinator(pi as never);
	return {
		ctx,
		calls,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPending: (value: boolean) => {
			hasPending = value;
		},
		emit: (event: string) => {
			for (const handler of handlers.get(event) ?? []) handler({}, ctx);
		},
	};
}

function request(overrides: Record<string, unknown> = {}) {
	return {
		reason: "test",
		customInstructions: "test instructions",
		...overrides,
	};
}

async function flush(): Promise<void> {
	await Promise.resolve();
}

describe("compaction coordinator", () => {
	beforeEach(() => resetCompactionCoordinatorForTests());

	test("request while busy waits for agent_settled", async () => {
		const h = makeHarness();
		h.setIdle(false);
		requestCompaction(h.ctx as never, request());
		await flush();
		expect(h.calls).toHaveLength(0);
		h.setIdle(true);
		h.emit("agent_settled");
		await flush();
		expect(h.calls).toHaveLength(1);
	});

	test("pending parent messages keep compaction queued", async () => {
		const h = makeHarness();
		h.setPending(true);
		requestCompaction(h.ctx as never, request());
		await flush();
		expect(h.calls).toHaveLength(0);
		h.setPending(false);
		h.emit("agent_settled");
		await flush();
		expect(h.calls).toHaveLength(1);
	});

	test("pending requests coalesce with both instruction strings", async () => {
		const h = makeHarness();
		h.setIdle(false);
		requestCompaction(
			h.ctx as never,
			request({ reason: "alpha", customInstructions: "alpha instructions" }),
		);
		requestCompaction(
			h.ctx as never,
			request({ reason: "beta", customInstructions: "beta instructions" }),
		);
		h.setIdle(true);
		h.emit("agent_settled");
		await flush();
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].customInstructions).toContain("alpha instructions");
		expect(h.calls[0].customInstructions).toContain("beta instructions");
	});

	test("a running compaction serializes a later request", async () => {
		const h = makeHarness();
		requestCompaction(
			h.ctx as never,
			request({ customInstructions: "first run" }),
		);
		await flush();
		expect(h.calls).toHaveLength(1);
		requestCompaction(
			h.ctx as never,
			request({ customInstructions: "queued run" }),
		);
		await flush();
		expect(h.calls).toHaveLength(1);
		h.calls[0].onComplete?.();
		await flush();
		expect(h.calls).toHaveLength(2);
		expect(h.calls[1].customInstructions).toContain("queued run");
	});

	test("error clears running state and reaches the requester", async () => {
		const h = makeHarness();
		const errors: Error[] = [];
		requestCompaction(
			h.ctx as never,
			request({ onError: (error: Error) => errors.push(error) }),
		);
		await flush();
		h.calls[0].onError?.(new Error("boom"));
		expect(errors.map((error) => error.message)).toEqual(["boom"]);
		requestCompaction(h.ctx as never, request({ reason: "retry" }));
		await flush();
		expect(h.calls).toHaveLength(2);
	});

	test("session_start clears a pending request", async () => {
		const h = makeHarness();
		h.setIdle(false);
		requestCompaction(h.ctx as never, request());
		h.emit("session_start");
		h.setIdle(true);
		h.emit("agent_settled");
		await flush();
		expect(h.calls).toHaveLength(0);
	});

	test("session_shutdown clears a pending request", async () => {
		const h = makeHarness();
		h.setIdle(false);
		requestCompaction(h.ctx as never, request());
		h.emit("session_shutdown");
		h.setIdle(true);
		h.emit("agent_settled");
		await flush();
		expect(h.calls).toHaveLength(0);
	});

	test("a dropped watermark completes without compacting", async () => {
		const h = makeHarness();
		let completed = 0;
		h.ctx.getContextUsage = () => ({ percent: 40 });
		requestCompaction(
			h.ctx as never,
			request({ minPercent: 55, onComplete: () => completed++ }),
		);
		await flush();
		expect(h.calls).toHaveLength(0);
		expect(completed).toBe(1);
	});
});
