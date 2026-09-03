/**
 * OpenCode usage-limit detection shared by worker-model and vision-router.
 * Does not switch the lead — callers decide what to spawn next.
 */
const USAGE_LIMIT_RE = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"quota.?limit",
		"402 Payment Required",
	].join("|"),
	"i",
);

const exhaustedProviders = new Set<string>();
const exhaustedModels = new Set<string>();

function modelKey(providerOrSpec: string, id?: string): string {
	const raw = id ? `${providerOrSpec}/${id}` : providerOrSpec;
	return raw.trim().toLowerCase();
}

export function isUsageLimitError(text: string): boolean {
	return USAGE_LIMIT_RE.test(text);
}

export function markProviderExhausted(provider: string): void {
	if (!provider) return;
	exhaustedProviders.add(provider.toLowerCase());
}

export function markModelExhausted(providerOrSpec: string, id?: string): void {
	const key = modelKey(providerOrSpec, id);
	if (!key.includes("/")) return;
	exhaustedModels.add(key);
}

export function isProviderExhausted(provider: string): boolean {
	return exhaustedProviders.has(provider.toLowerCase());
}

export function isModelExhausted(providerOrSpec: string, id?: string): boolean {
	const key = modelKey(providerOrSpec, id);
	const provider = key.split("/")[0] ?? "";
	return isProviderExhausted(provider) || exhaustedModels.has(key);
}

export function resetProviderExhaustion(): void {
	exhaustedProviders.clear();
	exhaustedModels.clear();
}

export default function opencodeFallbackLib() {
	// Shared module discovered as `extensions/*.ts`; not a real extension.
}

/** Map an error to the exact model when known, otherwise to its provider. */
export function markExhaustedFromError(text: string, modelSpec?: string): void {
	if (!isUsageLimitError(text)) return;
	if (modelSpec?.includes("/")) {
		markModelExhausted(modelSpec);
		return;
	}
	if (/FreeUsageLimitError/i.test(text) || /\bopencode\/(?!go)/i.test(text)) {
		markProviderExhausted("opencode");
		return;
	}
	markProviderExhausted("opencode-go");
}
