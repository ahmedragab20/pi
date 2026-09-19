import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	liveText,
	statusText,
	toolHeader,
	type UiTheme,
} from "../ui/presentation.ts";

type BrowserArgs = {
	action?: string;
	args?: string[];
	steps?: Array<{ action?: string; args?: string[] }>;
	session?: string;
};

type BrowserResult = {
	content: Array<{ type: string; text?: string }>;
};

type RenderOptions = { expanded: boolean; isPartial: boolean };
type RenderContext = {
	argsComplete: boolean;
	isError: boolean;
};

function keyHint(): string {
	const keys = getKeybindings().getKeys("app.tools.expand" as never);
	return keys.length > 0 ? ` (${keys.join("/")} to expand)` : " (expand for more)";
}

function safeTarget(action: string, args: string[]): string | undefined {
	if (action !== "open" && action !== "read") return undefined;
	const value = args[0];
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return `${url.origin}${url.pathname}`;
	} catch {
		return undefined;
	}
}

function callLabel(args: BrowserArgs, readOnly: boolean): string {
	const action = args.action ?? (args.steps ? "batch" : "browser");
	const session = args.session ? ` · session ${args.session}` : "";
	if (action === "batch") {
		const count = args.steps?.length ?? 0;
		return `${action} · ${count} step${count === 1 ? "" : "s"}${session}`;
	}
	const target = safeTarget(action, args.args ?? []);
	return `${action}${target ? ` · ${target}` : ""}${session}${!readOnly && action === "upload" ? " · upload" : ""}`;
}

function textContent(result: BrowserResult): string {
	return result.content.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function resultLines(
	result: BrowserResult,
	theme: UiTheme,
	options: RenderOptions,
	context: RenderContext,
	width: number,
): string[] {
	// Result bodies retain indentation and spacing. Only terminal controls are
	// removed from the display copy; evidence passed to the model is untouched.
	const text = stripTerminalSequences(textContent(result)).replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	const imageCount = result.content.filter((part) => part.type === "image").length;
	const lines = text ? new Text(text, 0, 0).render(Math.max(1, width)) : [];
	const shown = options.expanded || context.isError ? lines : lines.slice(0, 4);
	const output = shown.map((line) => theme.fg("toolOutput", line));
	if (imageCount > 0) output.push(theme.fg("muted", `· ${imageCount} image${imageCount === 1 ? "" : "s"}`));
	if (!options.expanded && !context.isError && lines.length > shown.length)
		output.push(theme.fg("muted", `… ${lines.length - shown.length} more${keyHint()}`));
	if (context.isError) {
		if (output.length === 0) output.push(theme.fg("error", "Browser action failed"));
		else output[0] = theme.fg("error", output[0]);
	}
	if (options.isPartial) output.unshift(statusText(theme, "running", "running"));
	else output.unshift(statusText(theme, context.isError ? "error" : "success", context.isError ? "failed" : "done"));
	if (!context.argsComplete) output.unshift(theme.fg("muted", "arguments incomplete"));
	return output;
}

export function createBrowserRenderers(
	readOnly: boolean,
): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const label = callLabel(args as BrowserArgs, readOnly);
			return liveText(() => [
				toolHeader(theme, readOnly ? "browser_verify" : "agent_browser", label),
				...(context.argsComplete ? [] : [theme.fg("muted", "arguments incomplete")]),
			]);
		},
		renderResult(result, options, theme, context) {
			return liveText((width) => ["", ...resultLines(result as BrowserResult, theme, options, context, width)]);
		},
	};
}

export const agentBrowserRenderers = createBrowserRenderers(false);
export const browserVerifyRenderers = createBrowserRenderers(true);
