import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const ALIAS_ID = "gpt-5.6-sol-1m";
const UPSTREAM_ID = "gpt-5.6-sol";

export default function sol1mAlias(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || ctx.model.id !== ALIAS_ID) return;
		if (!event.payload || typeof event.payload !== "object") return;

		return {
			...event.payload,
			model: UPSTREAM_ID,
		};
	});
}
