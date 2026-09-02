import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "fast-mode";
const STATUS_KEY = "fast-mode";
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);

type FastState = {
	enabled: boolean;
};

function supportsFastMode(ctx: ExtensionContext): boolean {
	return SUPPORTED_PROVIDERS.has(ctx.model?.provider ?? "");
}

export default function fastMode(pi: ExtensionAPI) {
	let enabled = false;

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			enabled ? ctx.ui.theme.fg("accent", "fast") : undefined,
		);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const state = entry.data as Partial<FastState> | undefined;
			if (typeof state?.enabled === "boolean") enabled = state.enabled;
		}
		refreshStatus(ctx);
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext) => {
		enabled = next;
		pi.appendEntry<FastState>(ENTRY_TYPE, { enabled });
		refreshStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("model_select", async (_event, ctx) => refreshStatus(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx)) return;
		if (!event.payload || typeof event.payload !== "object") return;

		return {
			...event.payload,
			service_tier: "priority",
		};
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI priority processing (on|off|status)",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command && !["on", "off", "status"].includes(command)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			if (command !== "status") {
				setEnabled(command === "on" || (command === "" && !enabled), ctx);
			}

			const compatibility = supportsFastMode(ctx)
				? "current model supported"
				: "applies when an OpenAI model is selected";
			ctx.ui.notify(
				`fast mode ${enabled ? "on" : "off"} · ${compatibility}`,
				enabled ? "info" : "warning",
			);
		},
	});
}
