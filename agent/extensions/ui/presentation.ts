import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

export type UiTheme = Pick<Theme, "fg" | "bold">;
export type UiState = "queued" | "running" | "waiting" | "success" | "error" | "cancelled" | "info";

export const SPINNER_INTERVAL_MS = 80;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const STATES = {
	queued: ["○", "muted"],
	running: [SPINNER_FRAMES[0], "accent"],
	waiting: ["?", "warning"],
	success: ["✓", "success"],
	error: ["✗", "error"],
	cancelled: ["–", "muted"],
	info: ["·", "muted"],
} as const;

/** Titles are data, not terminal control sequences. Never apply this to model context. */
export function singleLine(value: string): string {
	return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function statusText(theme: UiTheme, state: UiState, label: string, now = Date.now()): string {
	const [symbol, color] = STATES[state];
	const glyph = state === "running"
		? SPINNER_FRAMES[Math.floor(Math.max(0, now) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]
		: symbol;
	return theme.fg(color, `${glyph} ${singleLine(label)}`);
}

export function toolHeader(theme: UiTheme, name: string, target?: string): string {
	return theme.fg("toolTitle", theme.bold(singleLine(name))) +
		(target ? ` ${theme.fg("muted", singleLine(target))}` : "");
}

/** Recompute styles on every render, including after theme invalidation. */
export function liveText(render: (width: number) => string[]): Component {
	return {
		render: (width) => render(Math.max(0, width)).map((line) => truncateToWidth(line, Math.max(0, width))),
		invalidate() {},
	};
}

export interface Segment {
	text: string;
	/** Higher priority survives a narrow terminal. Output order is unchanged. */
	priority: number;
}

export function fitSegments(segments: Segment[], width: number, separator = " · "): string {
	if (width <= 0) return "";
	const visible = segments.filter((part) => part.text.length > 0);
	const join = () => visible.map((part) => part.text).join(separator);
	while (visible.length > 1 && visibleWidth(join()) > width) {
		let least = 0;
		for (let i = 1; i < visible.length; i++) {
			if (visible[i].priority <= visible[least].priority) least = i;
		}
		visible.splice(least, 1);
	}
	return truncateToWidth(join(), width);
}
