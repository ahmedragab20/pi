import { readFileSync } from "node:fs";
import {
	getAgentDir,
	parseFrontmatter,
	SettingsManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadCustomAgents } from "../../git/github.com/ahmedragab20/pi-subagents/dist/custom-agents.js";
import { resolveModel } from "../../git/github.com/ahmedragab20/pi-subagents/dist/model-resolver.js";

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function validateThinkingLevel(
	value: unknown,
	origin: string,
): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !LEVELS.has(value)) {
		throw new Error(
			`${origin}: invalid thinking level; use off, minimal, low, medium, high, xhigh, or max`,
		);
	}
	return value as ThinkingLevel;
}

/** Snapshot the selected policy, not the lead's live level. Providers clamp it. */
export function resolveAgentThinking(
	ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">,
	type: string,
	requested?: unknown,
	modelInput?: unknown,
): ThinkingLevel {
	const explicit = validateThinkingLevel(requested, "Agent.thinking");
	const config = loadCustomAgents(ctx.cwd).get(type);
	let pinned: ThinkingLevel | undefined;
	if (config?.sourcePath) {
		// The package coerces non-string frontmatter to undefined. Validate the
		// original value so a typo or malformed value cannot silently become off.
		const { frontmatter } = parseFrontmatter<{ thinking?: unknown }>(
			readFileSync(config.sourcePath, "utf8"),
		);
		pinned = validateThinkingLevel(
			frontmatter.thinking,
			`${config.sourcePath}: thinking`,
		);
	}
	if (pinned !== undefined) return pinned;
	if (explicit !== undefined) return explicit;

	const settings = SettingsManager.create(ctx.cwd, getAgentDir());
	const input = config?.model ?? modelInput;
	let model = ctx.model;
	if (typeof input === "string" && input.trim()) {
		const resolved = resolveModel(input, ctx.modelRegistry);
		if (typeof resolved === "string") throw new Error(resolved);
		model = resolved;
	}
	const perModel = model
		? settings.getModelThinkingLevel(model.provider, model.id)
		: undefined;
	return (
		validateThinkingLevel(perModel, "modelThinkingLevels") ??
		validateThinkingLevel(
			settings.getDefaultThinkingLevel(),
			"defaultThinkingLevel",
		) ??
		"medium"
	);
}
