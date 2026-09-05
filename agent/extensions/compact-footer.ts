import { basename } from "node:path";

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

function formatContext(
	ctx: ExtensionContext,
	theme: Theme,
): string | undefined {
	const percent = ctx.getContextUsage()?.percent;
	if (percent === null || percent === undefined) return undefined;
	const value =
		percent < 10 ? percent.toFixed(1) : Math.round(percent).toString();
	const color = percent >= 90 ? "error" : percent >= 70 ? "warning" : "muted";
	return theme.fg(color, `${value}%`);
}

function compactStatuses(
	statuses: ReadonlyMap<string, string>,
	theme: Theme,
): string[] {
	const compact: string[] = [];
	for (const [key, text] of statuses) {
		if (key === "subagents") continue;
		if (key === "pi-lens-lsp") {
			compact.push(theme.fg("accent", "TS"));
			continue;
		}
		if (key === "diffing") {
			if (!text.includes("no server")) compact.push(theme.fg("accent", "diffing"));
			continue;
		}
		compact.push(text);
	}
	return compact;
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
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
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
			dispose() {
				disposed = true;
				clearInterval(timer);
				controller.abort();
				unsubscribe();
			},
			invalidate() {},
			render(width: number): string[] {
				const branch = footerData.getGitBranch();
				const location = branch
					? `${basename(ctx.cwd)} (${branch})`
					: basename(ctx.cwd);
				const parts = [
					theme.fg("muted", location),
					gitStatus
						? theme.fg(gitStatus === "✓" ? "success" : "warning", gitStatus)
						: undefined,
					formatContext(ctx, theme),
					ctx.model?.id ? theme.fg("muted", ctx.model.id) : undefined,
					...compactStatuses(footerData.getExtensionStatuses(), theme),
				].filter((part): part is string => part !== undefined);
				const separator = theme.fg("dim", " · ");
				return [truncateToWidth(parts.join(separator), width)];
			},
		};
	});
}

export default function compactFooter(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => installFooter(pi, ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});
}
