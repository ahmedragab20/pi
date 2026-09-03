/**
 * Virtual modules for `bun test` so visualise.ts loads outside pi.
 *
 * pi aliases these specifiers itself at extension-load time, so nothing
 * resolves them from disk. The stubs cover exactly the symbols visualise.ts
 * touches. `visibleWidth` / `truncateToWidth` mirror the pi-tui helpers:
 * strip ANSI escapes, count code points (wide chars = 2), truncate with "…".
 *
 * Run with:  bun test --preload tests/visualise-stubs.ts tests/visualise.test.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";

/** Every test run gets its own agent dir, so nothing touches ~/.pi/agent. */
export const TEST_AGENT_DIR =
	process.env.VISUALISE_TEST_AGENT_DIR ??
	mkdtempSync(join(tmpdir(), "visualise-stub-"));
process.env.VISUALISE_TEST_AGENT_DIR = TEST_AGENT_DIR;

const schema = (kind: string, rest: Record<string, unknown> = {}) => ({
	kind,
	...rest,
});

const Type = {
	Object: (properties: Record<string, unknown>) =>
		schema("object", { properties }),
	Optional: (inner: unknown) => schema("optional", { inner }),
	String: (options?: unknown) => schema("string", { options }),
	Array: (items: unknown, options?: unknown) =>
		schema("array", { items, options }),
};

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleWidth(text: string): number {
	const stripped = text.replace(ANSI, "");
	let width = 0;
	for (const ch of stripped) {
		width += ch.codePointAt(0)! > 0xffff ? 2 : 1;
	}
	return width;
}

export function truncateToWidth(
	text: string,
	width: number,
	ellipsis = "…",
): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const ch of text.replace(ANSI, "")) {
		const cw = ch.codePointAt(0)! > 0xffff ? 2 : 1;
		if (used + cw > width - visibleWidth(ellipsis)) break;
		out += ch;
		used += cw;
	}
	return out + ellipsis;
}

plugin({
	name: "visualise-extension-stubs",
	setup(build) {
		build.module("@earendil-works/pi-ai", () => ({
			exports: {
				StringEnum: (values: readonly string[], options?: unknown) =>
					schema("enum", { values, options }),
			},
			loader: "object",
		}));
		build.module("@earendil-works/pi-coding-agent", () => ({
			exports: { getAgentDir: () => TEST_AGENT_DIR },
			loader: "object",
		}));
		build.module("@earendil-works/pi-tui", () => ({
			exports: { visibleWidth, truncateToWidth },
			loader: "object",
		}));
		build.module("typebox", () => ({
			exports: { Type },
			loader: "object",
		}));
	},
});
