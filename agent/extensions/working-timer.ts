import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "working-timer";

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	const clock = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${clock}` : clock;
}

export default function workingTimer(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let lastElapsed: number | undefined;

	pi.on("session_start", (_event, ctx) => {
		startedAt = undefined;
		lastElapsed = undefined;
		// Clear status left by older versions of this extension after /reload.
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("agent_start", () => {
		if (startedAt === undefined) startedAt = Date.now();
	});

	pi.on("agent_settled", () => {
		if (startedAt === undefined) return;
		lastElapsed = Date.now() - startedAt;
		startedAt = undefined;
	});

	pi.on("session_shutdown", () => {
		startedAt = undefined;
	});

	pi.registerCommand("timing", {
		description: "Show current or most recent main-agent run time",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const message =
				startedAt !== undefined
					? `Working for ${formatElapsed(Date.now() - startedAt)}`
					: lastElapsed !== undefined
						? `Last run ${formatElapsed(lastElapsed)}`
						: "No run timing yet";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
		},
	});
}
