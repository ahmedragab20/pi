/**
 * Regression tests for project-memory injection and resume refresh.
 *
 *   bun test --preload ./agent/tests/goal-stubs.ts ./agent/tests/project-memory.test.ts
 *
 * Covers:
 *  - resuming a branch that already carries a project-memory message must not
 *    duplicate it on session_start, but agent_settled must re-inject when the
 *    MEMORY.md file was rewritten (mtime bumped)
 *  - a second registerProjectMemory factory must not inherit lastInjected
 *    state from the first (fresh resume, not a mid-session refresh)
 *  - session_tree rechecks the current branch: injects when missing, does not
 *    duplicate identical content
 */

import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { registerProjectMemory } from "../extensions/efficiency/project-memory.ts";
import { TEST_AGENT_DIR } from "./goal-stubs.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface SentMessage {
	customType: string;
	content: string;
	details?: { path: string; updated?: boolean };
}

interface BranchEntry {
	type: string;
	customType?: string;
	content?: string;
}

function makeHarness() {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	const branch: BranchEntry[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage(message: SentMessage) {
			sent.push(message);
			branch.push({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
			});
		},
	};
	const cwd = mkdtempSync(join(TEST_AGENT_DIR, "project-memory-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const ctx = {
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => branch },
	};
	const fire = (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	return { pi, ctx, sent, branch, fire, cwd };
}

let fixtureClock = 1_700_000_000_000;

function writeMemory(cwd: string, text: string) {
	const path = join(cwd, ".pi", "MEMORY.md");
	writeFileSync(path, text, "utf8");
	fixtureClock += 60_000;
	utimesSync(path, new Date(fixtureClock), new Date(fixtureClock));
	return path;
}

describe("project memory", () => {
	test("resuming a branch with existing memory: no duplicate on session_start, agent_settled injects the rewritten file", () => {
		const h = makeHarness();
		registerProjectMemory(h.pi as never);
		const memPath = writeMemory(h.cwd, "project notes v1");
		h.branch.push({
			type: "custom_message",
			customType: "project-memory",
			content: `Project memory (${memPath}):\n\nproject notes v1`,
		});

		h.fire("session_start");
		expect(h.sent).toHaveLength(0);

		writeMemory(h.cwd, "project notes v2 — freshly rewritten");
		h.fire("agent_settled");

		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].details?.updated).toBe(true);
		expect(h.sent[0].content).toContain("project notes v2 — freshly rewritten");
	});

	test("a second registerProjectMemory factory does not inherit state from the first", () => {
		const a = makeHarness();
		registerProjectMemory(a.pi as never);
		writeMemory(a.cwd, "factory a memory");
		a.fire("session_start");
		expect(a.sent).toHaveLength(1);
		expect(a.sent[0].details?.updated).toBe(false);

		writeMemory(a.cwd, "factory a memory — rewritten after the fact");

		const b = makeHarness();
		registerProjectMemory(b.pi as never);
		writeMemory(b.cwd, "factory b memory — its own fixture");
		b.fire("agent_settled");

		expect(b.sent).toHaveLength(1);
		expect(b.sent[0].details?.updated).toBe(false);
		expect(b.sent[0].content).toContain("factory b memory — its own fixture");
	});

	test("session_tree rechecks the current branch without duplicating identical content", () => {
		const h = makeHarness();
		registerProjectMemory(h.pi as never);
		const memPath = writeMemory(h.cwd, "tree memory v1");

		// Branch already carries identical memory content — no duplicate.
		h.branch.push({
			type: "custom_message",
			customType: "project-memory",
			content: `Project memory (${memPath}):\n\ntree memory v1`,
		});
		h.fire("session_tree");
		expect(h.sent).toHaveLength(0);

		// Navigating the same session to a branch without memory restores it.
		h.branch.length = 0;
		h.fire("session_tree");
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].content).toContain("tree memory v1");
		h.fire("session_tree");
		expect(h.sent).toHaveLength(1);
	});
});
