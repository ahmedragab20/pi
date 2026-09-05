/**
 * Regression tests for writeDump idempotence and permissions.
 *
 *   bun test --preload ./agent/tests/goal-stubs.ts ./agent/tests/dumps.test.ts
 *
 * Covers:
 *  - same id + different text yields distinct dump paths, both contents retained
 *  - same id + identical text reuses the file without touching an old mtime
 *  - freshly written dump files are 0600
 *
 * All fixtures are dummy strings; nothing is cleaned up (no rm/force).
 */

import { readFileSync, statSync, utimesSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { writeDump } from "../extensions/efficiency/dumps.ts";
import { TEST_AGENT_DIR } from "./goal-stubs.ts";

describe("writeDump", () => {
	test("same id + different text returns distinct paths retaining both contents", () => {
		const p1 = writeDump("dump-id-alpha", "alpha dummy payload");
		const p2 = writeDump("dump-id-alpha", "beta dummy payload");
		expect(p1.startsWith(TEST_AGENT_DIR)).toBe(true);
		expect(p2.startsWith(TEST_AGENT_DIR)).toBe(true);
		expect(p2).not.toBe(p1);
		expect(readFileSync(p1, "utf8")).toBe("alpha dummy payload");
		expect(readFileSync(p2, "utf8")).toBe("beta dummy payload");
	});

	test("identical id + text reuses the same file without changing an old mtime", () => {
		const p = writeDump("dump-id-stable", "stable dummy payload");
		const oldTime = new Date(Date.now() - 86_400_000);
		utimesSync(p, oldTime, oldTime);
		const p2 = writeDump("dump-id-stable", "stable dummy payload");
		expect(p2).toBe(p);
		expect(statSync(p).mtimeMs).toBe(oldTime.getTime());
	});

	test("new dump file has mode 0600", () => {
		const p = writeDump("dump-id-mode", "mode dummy payload");
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});
});
