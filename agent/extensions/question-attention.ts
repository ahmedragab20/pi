import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Public rpiv-ask-user-question event: paired around the actual input wait.
const QUESTION_BLOCKED = "rpiv:ask-user:blocked";

export default function questionAttention(pi: ExtensionAPI): void {
	let waiting = 0;
	let unsubscribe: (() => void) | undefined;

	const report = (active: boolean) => {
		try {
			// Let herdr's managed bridge handle transport and notification settings.
			// Never forward question text, options, or answers.
			pi.events.emit("herdr:blocked", active
				? { active: true, label: "Question awaiting answer" }
				: { active: false });
		} catch {
			// Attention is best-effort; it must never interfere with answering.
		}
	};

	const cleanup = () => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (waiting > 0) report(false);
		waiting = 0;
	};

	pi.on("session_start", (_event, ctx) => {
		cleanup();
		// RPC has hasUI=true but no local pane awaiting input.
		if (ctx.mode !== "tui") return;
		unsubscribe = pi.events.on(QUESTION_BLOCKED, (data) => {
			if (!data || typeof data !== "object" || !("active" in data)) return;
			if (data.active === true) {
				if (waiting++ === 0) report(true);
			} else if (data.active === false && waiting > 0) {
				if (--waiting === 0) report(false);
			}
		});
	});
	pi.on("session_shutdown", cleanup);
}
