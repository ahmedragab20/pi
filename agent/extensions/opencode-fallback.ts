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

const exhausted = new Set<string>();

export function isUsageLimitError(text: string): boolean {
	return USAGE_LIMIT_RE.test(text);
}

export function markProviderExhausted(provider: string): void {
	if (!provider) return;
	exhausted.add(provider.toLowerCase());
}

export function isProviderExhausted(provider: string): boolean {
	return exhausted.has(provider.toLowerCase());
}

export function resetProviderExhaustion(): void {
	exhausted.clear();
}

export default function opencodeFallbackLib() {
	// Shared module discovered as `extensions/*.ts`; not a real extension.
}

/** Map an error string to the bill that ran out. */
export function markExhaustedFromError(text: string): void {
	if (!isUsageLimitError(text)) return;
	if (/cline/i.test(text)) {
		markProviderExhausted("clinepass");
		return;
	}
	if (/FreeUsageLimitError/i.test(text) || /\bopencode\/(?!go)/i.test(text)) {
		markProviderExhausted("opencode");
		return;
	}
	markProviderExhausted("opencode-go");
}
