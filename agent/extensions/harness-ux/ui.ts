/**
 * Shared render helpers for overlay panels.
 *
 * Every returned line is padded/truncated to exactly `width` visible columns so
 * box borders align and no line overflows the overlay width.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Pad/truncate a styled string to exactly `width` visible columns. */
export function fit(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return truncateToWidth(s, width);
	return s + " ".repeat(Math.max(0, width - w));
}

function rule(theme: any, width: number, fill: string): string {
	const inner = Math.max(0, width - 2);
	return fit(theme.fg("borderMuted", `├${fill.repeat(inner)}┤`), width);
}

export function topBorder(theme: any, width: number): string {
	const inner = Math.max(0, width - 2);
	return fit(theme.fg("borderAccent", `┌${"─".repeat(inner)}┐`), width);
}

export function midBorder(theme: any, width: number): string {
	return rule(theme, width, "─");
}

export function bottomBorder(theme: any, width: number): string {
	const inner = Math.max(0, width - 2);
	return fit(theme.fg("borderAccent", `└${"─".repeat(inner)}┘`), width);
}
