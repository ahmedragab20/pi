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

function installFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const branch = footerData.getGitBranch();
				const location = branch
					? `${basename(ctx.cwd)} (${branch})`
					: basename(ctx.cwd);
				const parts = [
					theme.fg("muted", location),
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
	pi.on("session_start", (_event, ctx) => installFooter(ctx));
}
