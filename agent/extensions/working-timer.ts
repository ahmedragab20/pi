import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "working-timer";

const THINKING_FG = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const satisfies Record<string, Parameters<Theme["fg"]>[0]>;

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	const clock = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${clock}` : clock;
}

export function formatThinking(theme: Theme, level: string): string {
	const color =
		THINKING_FG[level as keyof typeof THINKING_FG] ?? ("muted" as const);
	return theme.fg(color, level);
}

function requestThinkingLevel(payload: unknown, fallback: string): string {
	if (!payload || typeof payload !== "object") return fallback;
	const request = payload as {
		reasoning?: { effort?: unknown };
		reasoning_effort?: unknown;
		thinking?: { type?: unknown };
	};
	if (request.thinking?.type === "disabled") return "off";
	const effort = request.reasoning?.effort ?? request.reasoning_effort;
	if (effort === "none") return "off";
	return typeof effort === "string" && effort in THINKING_FG ? effort : fallback;
}

export default function workingTimer(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let requestThinking: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: ExtensionContext | undefined;

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const refresh = () => {
		if (!currentCtx || startedAt === undefined) return;
		const elapsed = formatElapsed(Date.now() - startedAt);
		const thinking = formatThinking(
			currentCtx.ui.theme,
			requestThinking ?? "pending",
		);
		currentCtx.ui.setWorkingMessage(`Working... ${elapsed} · ${thinking}`);
	};

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		startedAt = undefined;
		requestThinking = undefined;
		currentCtx = ctx;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("agent_start", (_event, ctx) => {
		currentCtx = ctx;
		if (startedAt === undefined) {
			startedAt = Date.now();
			requestThinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
		refresh();
		if (!timer) timer = setInterval(refresh, 1000);
	});

	// Latch at dispatch; editor changes must not relabel an in-flight request.
	pi.on("before_provider_request", (event, ctx) => {
		if (startedAt === undefined) return;
		requestThinking = requestThinkingLevel(
			event.payload,
			ctx.thinkingLevel ?? pi.getThinkingLevel(),
		);
		currentCtx = ctx;
		refresh();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		currentCtx = ctx;
		refresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (startedAt === undefined) return;
		const elapsed = formatElapsed(Date.now() - startedAt);
		stopTimer();
		startedAt = undefined;
		requestThinking = undefined;
		currentCtx = ctx;
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `last ${elapsed}`));
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		startedAt = undefined;
		requestThinking = undefined;
		currentCtx = undefined;
	});
}
