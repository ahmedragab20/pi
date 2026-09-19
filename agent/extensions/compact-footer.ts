import { basename } from "node:path";

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { fitSegments, singleLine, type Segment } from "./ui/presentation.ts";
import { UI_FOOTER, UI_SNAPSHOT_REQUEST, type FooterSnapshot } from "./ui/events.ts";

function formatContext(ctx: ExtensionContext, theme: Theme): string {
	const percent = ctx.getContextUsage()?.percent;
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return theme.fg("dim", "ctx —");
	const value =
		percent < 10 ? percent.toFixed(1) : Math.round(percent).toString();
	let color: "error" | "warning" | "muted" = "muted";
	if (percent >= 90) color = "error";
	else if (percent >= 70) color = "warning";
	return theme.fg(color, `ctx ${value}%`);
}

function usageValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

export function latestCacheHitPercent(
	entries: readonly unknown[],
): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			type?: unknown;
			message?: { role?: unknown; usage?: unknown };
		};
		if (candidate.type !== "message" || candidate.message?.role !== "assistant")
			continue;
		const usage = candidate.message.usage;
		if (!usage || typeof usage !== "object") continue;
		const values = usage as {
			input?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
		};
		const input = usageValue(values.input);
		const cacheRead = usageValue(values.cacheRead);
		const cacheWrite = usageValue(values.cacheWrite);
		const promptTokens = input + cacheRead + cacheWrite;
		if (promptTokens > 0) return (cacheRead / promptTokens) * 100;
	}
	return undefined;
}

function formatGitState(
	gitStatus: string | undefined,
	theme: Theme,
): string | undefined {
	if (!gitStatus) return undefined;
	const color = gitStatus === "✓" ? "success" : "warning";
	return theme.fg(color, gitStatus);
}

const INFORMATIONAL_STATUS_KEYS = new Set([
	"btw",
	"diffing",
	"fast-mode",
	"github-pr",
	"pi-lens-lsp",
	"subagents",
	"working-timer",
	"vision",
]);

function actionableStatuses(statuses: ReadonlyMap<string, string>): string[] {
	const actionable: string[] = [];
	for (const [key, text] of statuses) {
		if (!INFORMATIONAL_STATUS_KEYS.has(key)) actionable.push(text);
	}
	return actionable;
}

export function formatGitStatus(output: string): string {
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicts = 0;
	const entries = output.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const status = entry.slice(0, 2);
		if (status === "??") {
			untracked++;
			continue;
		}
		if (status === "!!") continue;
		if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status)) {
			conflicts++;
		} else {
			if (status[0] !== " ") staged++;
			if (status[1] !== " ") modified++;
		}
		// With -z, renames/copies include a second NUL-delimited pathname.
		if (/[RC]/.test(status)) i++;
	}
	return (
		[
			staged ? `+${staged}` : "",
			modified ? `~${modified}` : "",
			untracked ? `?${untracked}` : "",
			conflicts ? `!${conflicts}` : "",
		]
			.filter(Boolean)
			.join(" ") || "✓"
	);
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const gitStatus = createGitStatusMonitor(pi, ctx, tui, footerData);
		const publish = () => {
			const snapshot: FooterSnapshot = {
				location: ctx.cwd,
				branch: footerData.getGitBranch() ?? undefined,
				git: gitStatus.current(),
				statuses: [...footerData.getExtensionStatuses()].map(([key, text]) => [singleLine(key), singleLine(text)]),
			};
			pi.events.emit(UI_FOOTER, snapshot);
		};
		const unsubscribe = pi.events.on(UI_SNAPSHOT_REQUEST, publish);
		return {
			dispose: () => { gitStatus.dispose(); unsubscribe(); },
			invalidate() {},
			render: (width: number) =>
				renderFooter({
					ctx,
					theme,
					footerData,
					gitStatus: gitStatus.current(),
					width,
				}),
		};
	});
}

function createGitStatusMonitor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tui: TUI,
	footerData: ReadonlyFooterDataProvider,
): { current: () => string | undefined; dispose: () => void } {
	let gitStatus: string | undefined;
	let disposed = false;
	let refreshing = false;
	const controller = new AbortController();
	const refresh = async () => {
		if (disposed || refreshing) return;
		refreshing = true;
		let next: string | undefined;
		try {
			const result = await pi.exec(
				"git",
				[
					"-C",
					ctx.cwd,
					"--no-optional-locks",
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=normal",
				],
				{ timeout: 4000, signal: controller.signal },
			);
			if (result.code === 0 && !result.killed)
				next = formatGitStatus(result.stdout);
		} catch {
			// Git may be unavailable or the directory may not be a repository.
		} finally {
			refreshing = false;
		}
		if (!disposed && next !== gitStatus) {
			gitStatus = next;
			tui.requestRender();
		}
	};
	const unsubscribe = footerData.onBranchChange(() => {
		tui.requestRender();
		void refresh();
	});
	const timer = setInterval(() => void refresh(), 5000);
	timer.unref?.();
	void refresh();
	return {
		current: () => gitStatus,
		dispose: () => {
			disposed = true;
			clearInterval(timer);
			controller.abort();
			unsubscribe();
		},
	};
}

type FooterRenderOptions = {
	ctx: ExtensionContext;
	theme: Theme;
	footerData: ReadonlyFooterDataProvider;
	gitStatus: string | undefined;
	width: number;
};

function renderFooter({
	ctx,
	theme,
	footerData,
	gitStatus,
	width,
}: FooterRenderOptions): string[] {
	const branch = footerData.getGitBranch();
	const location = branch
		? `${basename(ctx.cwd)} (${branch})`
		: basename(ctx.cwd);
	const statuses = footerData.getExtensionStatuses();
	const pr = statuses.get("github-pr");
	const attention = actionableStatuses(statuses);
	const percent = ctx.getContextUsage()?.percent;
	const separator = theme.fg("dim", " · ");
	const cache = latestCacheHitPercent(ctx.sessionManager.getEntries());
	const usage = formatContext(ctx, theme) + separator + theme.fg(
		cache === undefined ? "dim" : "muted",
		cache === undefined ? "cache —" : `cache ${cache.toFixed(1)}%`,
	);
	const parts: Segment[] = [
		{ text: attention[0] ? theme.fg("text", singleLine(attention[0])) : "", priority: 100 },
		{ text: attention.length > 1 ? theme.fg("warning", `+${attention.length - 1} /ui`) : "", priority: 99 },
		{ text: theme.fg("muted", singleLine(location)), priority: 70 },
		{ text: pr ? theme.fg("accent", singleLine(pr)) : "", priority: 30 },
		{ text: formatGitState(gitStatus, theme) ?? "", priority: 65 },
		{ text: ctx.model?.id ? theme.fg("muted", singleLine(ctx.model.id)) : "", priority: 80 },
		{ text: usage, priority: percent != null && percent >= 70 ? 95 : 75 },
		{ text: statuses.get("fast-mode") ?? "", priority: 90 },
		{ text: attention.length > 1 ? "" : theme.fg("dim", "/ui"), priority: 10 },
	];
	return [fitSegments(parts, width, separator)];
}

export default function compactFooter(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => installFooter(pi, ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}
