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

/** Left + right-aligned suffix, padded to `width`. */
export function fitEnds(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw >= width) {
		const keep = Math.max(0, width - rw);
		return (
			truncateToWidth(left, keep) +
			(rw > width ? truncateToWidth(right, width) : right)
		);
	}
	return left + " ".repeat(width - lw - rw) + right;
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

/** Mid rule with a left label and optional right-aligned hint, e.g. `├─ output ── live┤`. */
export function labeledMidBorder(
	theme: any,
	width: number,
	label: string,
	extra = "",
): string {
	const inner = Math.max(0, width - 2);
	const left = label ? `─ ${label} ` : "─";
	const right = extra ? ` ${extra} ` : "";
	let body = left;
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	if (leftW + rightW <= inner) {
		body = `${left}${"─".repeat(Math.max(0, inner - leftW - rightW))}${right}`;
	} else if (leftW <= inner) {
		body = `${left}${"─".repeat(Math.max(0, inner - leftW))}`;
	} else {
		body = "─".repeat(inner);
	}
	if (visibleWidth(body) > inner) body = "─".repeat(inner);
	else if (visibleWidth(body) < inner)
		body += "─".repeat(inner - visibleWidth(body));
	return fit(theme.fg("borderMuted", `├${body}┤`), width);
}

export function bottomBorder(theme: any, width: number): string {
	const inner = Math.max(0, width - 2);
	return fit(theme.fg("borderAccent", `└${"─".repeat(inner)}┘`), width);
}
