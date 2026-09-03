import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface CompactionRequest {
	reason: string;
	customInstructions: string;
	minPercent?: number;
	onComplete?: () => void;
	onError?: (error: Error) => void;
}

type PendingRequest = {
	reasons: Set<string>;
	instructions: Set<string>;
	minPercent?: number;
	onComplete: Set<() => void>;
	onError: Set<(error: Error) => void>;
};

let pending: PendingRequest | null = null;
let running = false;
let drainScheduled = false;
let generation = 0;

function clearState(): void {
	generation += 1;
	pending = null;
	running = false;
	drainScheduled = false;
}

export function resetCompactionCoordinatorForTests(): void {
	clearState();
}

function mergeRequest(request: CompactionRequest): void {
	if (!pending) {
		pending = {
			reasons: new Set(),
			instructions: new Set(),
			minPercent: request.minPercent,
			onComplete: new Set(),
			onError: new Set(),
		};
	}
	pending.reasons.add(request.reason);
	if (request.customInstructions.trim()) {
		pending.instructions.add(request.customInstructions.trim());
	}
	if (typeof request.minPercent === "number") {
		pending.minPercent =
			typeof pending.minPercent === "number"
				? Math.min(pending.minPercent, request.minPercent)
				: request.minPercent;
	}
	if (request.onComplete) pending.onComplete.add(request.onComplete);
	if (request.onError) pending.onError.add(request.onError);
}

function runCallbacks(callbacks: Iterable<() => void>): void {
	for (const callback of callbacks) {
		try {
			callback();
		} catch {
			// One extension callback must not block the other requesters.
		}
	}
}

function runErrorCallbacks(
	callbacks: Iterable<(error: Error) => void>,
	error: Error,
): void {
	for (const callback of callbacks) {
		try {
			callback(error);
		} catch {
			// One extension callback must not block the other requesters.
		}
	}
}

function requestText(request: PendingRequest): string {
	const reasons = [...request.reasons].join(", ");
	const instructions = [...request.instructions].join("\n\n");
	return [`Compaction reasons: ${reasons}`, instructions]
		.filter(Boolean)
		.join("\n\n");
}

function scheduleDrain(ctx: ExtensionContext): void {
	if (drainScheduled) return;
	drainScheduled = true;
	queueMicrotask(() => {
		drainScheduled = false;
		drain(ctx);
	});
}

function drain(ctx: ExtensionContext): void {
	if (running || !pending) return;
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

	const request = pending;
	const percent = ctx.getContextUsage()?.percent;
	if (
		typeof request.minPercent === "number" &&
		typeof percent === "number" &&
		percent < request.minPercent
	) {
		pending = null;
		runCallbacks(request.onComplete);
		return;
	}

	pending = null;
	running = true;
	const runGeneration = generation;
	const finish = (error?: Error) => {
		if (runGeneration !== generation) return;
		running = false;
		if (error) runErrorCallbacks(request.onError, error);
		else runCallbacks(request.onComplete);
		if (pending) scheduleDrain(ctx);
	};

	try {
		ctx.compact({
			customInstructions: requestText(request),
			onComplete: () => finish(),
			onError: (error) => finish(error),
		});
	} catch (error) {
		finish(error instanceof Error ? error : new Error(String(error)));
	}
}

export function requestCompaction(
	ctx: ExtensionContext,
	request: CompactionRequest,
): void {
	mergeRequest(request);
	scheduleDrain(ctx);
}

export function registerCompactionCoordinator(pi: ExtensionAPI): void {
	pi.on("session_start", () => clearState());
	pi.on("session_shutdown", () => clearState());
	pi.on("agent_settled", (_event, ctx) => scheduleDrain(ctx));
}
