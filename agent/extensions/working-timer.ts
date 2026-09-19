import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { elapsedText } from "./ui/activity.ts";
import { UI_SNAPSHOT_REQUEST, UI_TIMING } from "./ui/events.ts";

const STATUS_KEY = "working-timer";
export const formatElapsed = elapsedText;

export default function workingTimer(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let lastElapsed: number | undefined;
	let unsubscribe: (() => void) | undefined;
	const publish = () => pi.events.emit(UI_TIMING, { startedAt, lastElapsed });

	pi.on("session_start", (_event, ctx) => {
		startedAt = undefined;
		lastElapsed = undefined;
		// Clear status left by older versions of this extension after /reload.
		ctx.ui.setStatus(STATUS_KEY, undefined);
		unsubscribe?.();
		unsubscribe = pi.events.on(UI_SNAPSHOT_REQUEST, publish);
		publish();
	});

	pi.on("agent_start", () => {
		if (startedAt === undefined) startedAt = Date.now();
		publish();
	});

	pi.on("agent_settled", () => {
		if (startedAt === undefined) return;
		lastElapsed = Date.now() - startedAt;
		startedAt = undefined;
		publish();
	});

	pi.on("session_shutdown", () => {
		startedAt = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
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
