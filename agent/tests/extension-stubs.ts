/**
 * Virtual modules for `bun test` so extensions load outside pi.
 *
 * pi aliases these four specifiers itself at extension-load time
 * (dist/core/extensions/loader.js), so nothing resolves them from disk. The
 * stubs only need the handful of symbols extensions touch at module scope.
 *
 * Run with:  bun test --preload agent/tests/extension-stubs.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import { parseFrontmatter } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js";
import { SettingsManager } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";

/** Every test run gets its own agent dir, so tests never touch ~/.pi/agent. */
export const TEST_AGENT_DIR =
	process.env.PI_TEST_AGENT_DIR ?? mkdtempSync(join(tmpdir(), "pi-test-"));
// Survive a second evaluation of this module (preload + import).
process.env.PI_TEST_AGENT_DIR = TEST_AGENT_DIR;

const schema = (kind: string, rest: Record<string, unknown> = {}) => ({
	kind,
	...rest,
});

const Type = {
	Object: (properties: Record<string, unknown>) =>
		schema("object", { properties }),
	Optional: (inner: unknown) => schema("optional", { inner }),
	String: (options?: unknown) => schema("string", { options }),
	Literal: (value: unknown) => schema("literal", { value }),
	Union: (items: unknown[], options?: unknown) =>
		schema("union", { items, options }),
	Number: (options?: unknown) => schema("number", { options }),
	Boolean: (options?: unknown) => schema("boolean", { options }),
	Array: (items: unknown, options?: unknown) =>
		schema("array", { items, options }),
};

class Text {
	constructor(
		public text: string,
		public x = 0,
		public y = 0,
	) {}
}

function matchesKey(data: string, key: string): boolean {
	if (key === "escape") return data === "\x1b" || data === "escape";
	if (key === "ctrl+c") return data === "\x03" || data === "ctrl+c";
	return data === key;
}

function truncateToWidth(text: string, width: number): string {
	const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.length <= width) return text;
	return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

plugin({
	name: "pi-extension-stubs",
	setup(build) {
		build.module("@earendil-works/pi-ai", () => ({
			exports: {
				StringEnum: (values: readonly string[], options?: unknown) =>
					schema("enum", { values, options }),
			},
			loader: "object",
		}));
		build.module("@earendil-works/pi-coding-agent", () => ({
			exports: {
				getAgentDir: () => TEST_AGENT_DIR,
				parseFrontmatter,
				SettingsManager,
				createCodingTools: () => [],
				createReadOnlyTools: () => [],
				formatSize: (bytes: number) => `${bytes} B`,
				CONFIG_DIR_NAME: ".pi",
			},
			loader: "object",
		}));
		build.module("@earendil-works/pi-tui", () => ({
			exports: { Text, matchesKey, truncateToWidth },
			loader: "object",
		}));
		build.module("typebox", () => ({
			exports: { Type },
			loader: "object",
		}));
	},
});
