/**
 * Goal loop state machine.
 *
 *   bun test --preload agent/tests/goal-stubs.ts agent/tests/goal.test.ts
 *
 * The gates are the whole point of the feature, so they are what is tested:
 * evidence quality, evidence survival across a criteria rewrite, plan before
 * code, stall detection, review freshness, background-agent handles, and
 * reload from disk.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import goalExtension from "../extensions/goal.ts";
import { resetCompactionCoordinatorForTests } from "../extensions/efficiency/compaction-coordinator.ts";
import { TEST_AGENT_DIR } from "./goal-stubs.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = {
	content: { type: string; text: string }[];
	details: unknown;
};
type CompactOptions = {
	customInstructions?: string;
	onComplete?: () => void;
	onError?: (error: Error) => void;
};
type HarnessGoalState = {
	criteria: unknown[];
	phase: string;
	autoContinue: boolean;
	planApproved: boolean;
	[key: string]: unknown;
};

let cwdSeq = 0;

function makeHarness(
	options: {
		criteria?: string;
		percent?: number | null;
		cwd?: string;
		sessionId?: string;
		branch?: { type: string; customType: string; data: unknown }[];
		gitCode?: number;
	} = {},
) {
	const cwd = options.cwd ?? `/tmp/goal-project-${++cwdSeq}`;
	// Stable by default (so a reopened harness is the same session), overridable
	// for tests that simulate a second session in the same working directory.
	const sessionId =
		options.sessionId ??
		`sess-${createHash("sha1").update(cwd).digest("hex").slice(0, 8)}`;
	const branch = options.branch ?? [];
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const notices: string[] = [];
	const compactCalls: CompactOptions[] = [];
	let porcelain = "";
	let diff = "";
	let tool: {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<ToolResult>;
		renderCall: (
			args: Record<string, unknown>,
			theme: unknown,
		) => { text: string };
		renderResult: (
			result: unknown,
			options: { expanded: boolean },
			theme: unknown,
		) => { text: string };
	} | null = null;
	let command: {
		handler: (args: string, ctx: unknown) => Promise<void>;
	} | null = null;
	let activeTools = ["read", "bash", "edit", "write"];
	let confirmAnswer = true;
	let widgetFactory:
		| ((tui: unknown, theme: unknown) => { render: () => string[] })
		| null = null;

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (definition: unknown) => {
			tool = definition as typeof tool;
		},
		registerCommand: (_name: string, options: unknown) => {
			command = options as typeof command;
		},
		// Session entries are serialized in pi, so snapshot rather than alias.
		appendEntry: (customType: string, data: unknown) => {
			branch.push({
				type: "custom",
				customType,
				data: JSON.parse(JSON.stringify(data)),
			});
		},
		setSessionName: () => {},
		exec: async (
			_command: string,
			args: string[] = [],
		): Promise<{ stdout: string; stderr: string; code: number }> => {
			const isDiff = args.some(
				(a) => typeof a === "string" && a.startsWith("diff"),
			);
			return {
				stdout: isDiff ? diff : porcelain,
				stderr: "",
				code: options.gitCode ?? 0,
			};
		},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		sendUserMessage: (text: string) => sent.push(text),
		sendMessage: () => {},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		ui: {
			notify: (message: string) => notices.push(message),
			confirm: async () => confirmAnswer,
			editor: async () => options.criteria ?? "",
			input: async () => "",
			setWidget: (_name: string, factory: unknown) => {
				widgetFactory = factory as typeof widgetFactory;
			},
			setStatus: () => {},
			theme: { fg: (_c: string, s: string) => s },
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => `${cwd}/session.jsonl`,
			getSessionId: () => sessionId,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({
			tokens: 1000,
			contextWindow: 100000,
			percent: options.percent === undefined ? 10 : options.percent,
		}),
		compact: (compactOptions: CompactOptions) => {
			compactCalls.push(compactOptions);
			queueMicrotask(() => compactOptions.onComplete?.());
		},
	};

	goalExtension(pi as never);

	const fire = async (event: string, payload: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	};

	/** Record a successful `bash` tool result; returns its toolCallId for `source`. */
	const recordBashProof = async (output: string) => {
		proofSeq += 1;
		const toolCallId = `bash-${proofSeq}`;
		await fire("tool_result", {
			toolCallId,
			toolName: "bash",
			input: { command: "bun test" },
			content: [{ type: "text", text: output }],
			details: undefined,
		});
		return toolCallId;
	};

	const call = async (params: Record<string, unknown>): Promise<ToolResult> => {
		if (!tool) throw new Error("goal tool was never registered");
		return tool.execute("call-1", params, undefined, undefined, ctx);
	};

	const text = async (params: Record<string, unknown>) =>
		(await call(params)).content[0].text;

	const start = async (task: string) => {
		if (!command) throw new Error("goal command was never registered");
		await command.handler(task, ctx);
	};

	let proofSeq = 0;

	return {
		cwd,
		sessionId,
		sent,
		notices,
		compactCalls,
		branch,
		fire,
		call,
		text,
		start,
		recordBashProof,
		setPorcelain: (value: string) => {
			porcelain = value;
		},
		setDiff: (value: string) => {
			diff = value;
		},
		setConfirm: (value: boolean) => {
			confirmAnswer = value;
		},
		run: async (args: string) => {
			if (!command) throw new Error("goal command was never registered");
			await command.handler(args, ctx);
		},
		goalFile: () => {
			const status = branch[branch.length - 1]?.data as { file: string };
			return status.file;
		},
		state: () => branch[branch.length - 1]?.data as HarnessGoalState,
		tool: () => tool,
		widget: () => widgetFactory,
	};
}

const THREE = "- [ ] tests pass\n- [ ] docs updated\n- [ ] no lint errors\n";

/**
 * Reopen a closed goal on disk. Auto-close means a satisfied gate can only be
 * seen by a later session if that session's state file predates it, which is
 * exactly the upgrade case the cycle/`/goal done` fallbacks exist for.
 */
function diskStatePath(cwd: string, sessionId: string) {
	return join(
		TEST_AGENT_DIR,
		"goals",
		createHash("sha1").update(cwd).digest("hex").slice(0, 12),
		createHash("sha1").update(sessionId).digest("hex").slice(0, 12),
		"state.json",
	);
}

function reopenOnDisk(cwd: string, sessionId: string) {
	const path = diskStatePath(cwd, sessionId);
	const raw = JSON.parse(readFileSync(path, "utf8"));
	raw.phase = "running";
	raw.autoContinue = true;
	writeFileSync(path, JSON.stringify(raw), "utf8");
}

const theme = {
	fg: (_color: string, s: string) => s,
	bold: (s: string) => s,
};

describe("goal loop", () => {
	let h: ReturnType<typeof makeHarness>;

	/** Record a successful bash proof and cite it as evidence for a criterion. */
	const prove = async (id: string, output: string) => {
		const source = await h.recordBashProof(output);
		return h.text({ action: "evidence", id, evidence: output, source });
	};

	beforeEach(async () => {
		resetCompactionCoordinatorForTests();
		h = makeHarness({ criteria: THREE });
		await h.start("make the thing work");
	});

	test("start records the task, criteria and goal file", async () => {
		const status = await h.text({ action: "status" });
		expect(status).toContain("make the thing work");
		expect(status).toContain("C1 tests pass");
		expect(status).toContain("phase draft");

		const file = h.goalFile();
		expect(existsSync(file)).toBe(true);
		const markdown = readFileSync(file, "utf8");
		expect(markdown).toContain("# Goal");
		expect(markdown).toContain("- [ ] **C2** docs updated");
		expect(existsSync(join(TEST_AGENT_DIR, "goals"))).toBe(true);
		// The kickoff must reach the model, or the loop never starts.
		expect(h.sent[0]).toContain("Start a goal loop");
	});

	test("state is scoped by cwd and session id", async () => {
		const firstPath = (h.state() as unknown as { stateFile: string }).stateFile;
		expect(firstPath).toBe(diskStatePath(h.cwd, h.sessionId));

		const other = makeHarness({
			cwd: h.cwd,
			sessionId: "another-session",
			criteria: THREE,
		});
		await other.fire("session_start", { reason: "startup" });
		await other.run("status");
		expect(other.notices.at(-1)).toBe("No active goal");

		await other.start("ship the other session");
		const otherPath = (other.state() as unknown as { stateFile: string })
			.stateFile;
		expect(otherPath).not.toBe(firstPath);
		expect(existsSync(firstPath)).toBe(true);
		expect(existsSync(otherPath)).toBe(true);
		expect(await h.text({ action: "status" })).toContain("make the thing work");
		expect(await other.text({ action: "status" })).toContain(
			"ship the other session",
		);
	});

	test("selected branch state wins over newer disk state", async () => {
		const selectedBranch = JSON.parse(
			JSON.stringify(h.branch),
		) as typeof h.branch;
		const path = diskStatePath(h.cwd, h.sessionId);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		raw.task = "disk state from a sibling branch";
		raw.updatedAt = Date.now() + 60_000;
		writeFileSync(path, JSON.stringify(raw), "utf8");

		const restarted = makeHarness({
			cwd: h.cwd,
			sessionId: h.sessionId,
			branch: selectedBranch,
		});
		await restarted.fire("session_tree", {});
		const status = await restarted.text({ action: "status" });
		expect(status).toContain("make the thing work");
		expect(status).not.toContain("disk state from a sibling branch");
	});

	test("a non-empty selected branch does not import disk-only goal state", async () => {
		const switched = makeHarness({
			cwd: h.cwd,
			sessionId: h.sessionId,
			branch: [{ type: "message", customType: "", data: {} }],
		});
		await switched.fire("session_tree", {});
		await switched.run("status");
		expect(switched.notices.at(-1)).toBe("No active goal");
	});

	test("criteria and roadmap rewrites remove normalized duplicates", async () => {
		await h.call({
			action: "set_criteria",
			criteria: [
				"tests pass",
				" Tests   pass ",
				"docs updated",
				"DOCS UPDATED",
				"no lint errors",
			],
		});
		await h.call({
			action: "set_roadmap",
			roadmap: ["parse", " Parse ", "render", "RENDER"],
		});
		const state = h.state() as unknown as {
			criteria: { text: string }[];
			roadmap: { text: string }[];
		};
		expect(state.criteria.map((criterion) => criterion.text)).toEqual([
			"tests pass",
			"docs updated",
			"no lint errors",
		]);
		expect(state.roadmap.map((step) => step.text)).toEqual(["parse", "render"]);
	});

	test("evidence rejects a claim and accepts real proof", async () => {
		const weak = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "works",
		});
		expect(weak).toContain("Error");
		expect(weak).toContain("claim, not evidence");

		const stamp = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "all tests pass",
			source: await h.recordBashProof("unrelated"),
		});
		expect(stamp).toContain("claim, not evidence");

		const short = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "x=1",
			source: await h.recordBashProof("unrelated"),
		});
		expect(short).toContain("too short");

		const good = await prove("C1", "bun test → 12 pass, 0 fail");
		expect(good).toContain("C1 evidenced");
		expect(good).toContain("1/3 evidenced");

		const unknown = await h.text({
			action: "evidence",
			id: "C9",
			evidence: "bun test → 12 pass, 0 fail",
		});
		expect(unknown).toContain("unknown id C9");
	});

	test("met evidence must cite a recent successful tool result", async () => {
		// Quality rejections still surface the text problem (valid source given).
		const weak = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "works",
			source: await h.recordBashProof("unrelated"),
		});
		expect(weak).toContain("claim, not evidence");

		// No source at all is rejected.
		const missing = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "bun test → 12 pass, 0 fail",
		});
		expect(missing).toContain("Error");
		expect(missing).toContain("source");

		// A source that was never a tool result is rejected.
		const unknownSource = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "bun test → 12 pass, 0 fail",
			source: "tool-404",
		});
		expect(unknownSource).toContain("Error");

		// A failed tool result is not a proof.
		await h.fire("tool_result", {
			toolCallId: "bash-err-1",
			toolName: "bash",
			input: { command: "bun test" },
			content: [{ type: "text", text: "3 fail" }],
			isError: true,
			details: undefined,
		});
		const errored = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "bun test → 12 pass, 0 fail",
			source: "bash-err-1",
		});
		expect(errored).toContain("Error");

		// goal, Agent and get_subagent_result results are not proofs either.
		for (const toolName of ["goal", "Agent", "get_subagent_result"]) {
			const toolCallId = `noproof-${toolName}`;
			await h.fire("tool_result", {
				toolCallId,
				toolName,
				input: {},
				content: [{ type: "text", text: "bun test → 12 pass, 0 fail" }],
				details: undefined,
			});
			const refused = await h.text({
				action: "evidence",
				id: "C1",
				evidence: "bun test → 12 pass, 0 fail",
				source: toolCallId,
			});
			expect(refused).toContain("Error");
		}

		// A real, successful bash result proves it.
		const good = await prove("C1", "bun test → 12 pass, 0 fail");
		expect(good).toContain("C1 evidenced");

		// Retractions stay allowed without a source.
		const retracted = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "regressed: tests fail again after the refactor",
			met: false,
		});
		expect(retracted).toContain("retracted");
	});

	test("evidence survives a criteria rewrite, and a silent drop is refused", async () => {
		await prove("C1", "bun test → 12 pass, 0 fail");

		// Same text, reordered and extended: the proof must come with it.
		const kept = await h.text({
			action: "set_criteria",
			criteria: [
				"docs updated",
				"tests pass",
				"no lint errors",
				"ships behind a flag",
			],
		});
		expect(kept).toContain("4 criteria recorded");
		expect(kept).toContain("[x] C1 tests pass — bun test → 12 pass, 0 fail");

		const dropped = await h.text({
			action: "set_criteria",
			criteria: ["docs updated"],
		});
		expect(dropped).toContain("Error");
		expect(dropped).toContain("drop accepted criteria (C1");

		const forced = await h.text({
			action: "set_criteria",
			criteria: ["docs updated"],
			force: true,
			note: "the human approved dropping obsolete criteria",
		});
		expect(forced).toContain("dropped C1");
		expect(forced).toContain("0/1 evidenced");
	});

	test("removing an unmet criterion also needs force", async () => {
		// All three criteria are unmet here; silently dropping one is still a
		// silent narrowing of the goal, so force is required either way.
		const dropped = await h.text({
			action: "set_criteria",
			criteria: ["tests pass"],
		});
		expect(dropped).toContain("Error");
		expect(dropped).toContain("C2");
		expect(h.state().criteria.length).toBe(3);

		const forced = await h.text({
			action: "set_criteria",
			criteria: ["tests pass"],
			force: true,
			note: "the user approved narrowing the criteria",
		});
		expect(forced).toContain("dropped C2");
		expect(h.state().criteria.length).toBe(1);
	});

	test("product code is blocked until the plan is approved", async () => {
		const blocked = await h.fire("tool_call", {
			toolName: "write",
			input: { path: "src/thing.ts" },
		});
		expect(blocked.some((r) => (r as { block?: boolean })?.block)).toBe(true);

		const dotDotName = await h.fire("tool_call", {
			toolName: "write",
			input: { path: "..cache/generated.ts" },
		});
		expect(dotDotName.some((r) => (r as { block?: boolean })?.block)).toBe(true);

		// Outside the project (a diffing plan, a scratch file) is never gated.
		const outside = await h.fire("tool_call", {
			toolName: "write",
			input: { path: "/tmp/elsewhere/notes.md" },
		});
		expect(outside.every((r) => r === undefined)).toBe(true);

		const read = await h.fire("tool_call", {
			toolName: "read",
			input: { path: "src/thing.ts" },
		});
		expect(read.every((r) => r === undefined)).toBe(true);

		const noNote = await h.text({ action: "plan_approved" });
		expect(noNote).toContain("note required");

		await h.call({ action: "plan_approved", note: "human approved plan #7" });
		const after = await h.fire("tool_call", {
			toolName: "write",
			input: { path: "src/thing.ts" },
		});
		expect(after.every((r) => r === undefined)).toBe(true);
	});

	test("the pre-plan gate also covers side-effect tools and write-capable agents", async () => {
		const gated = [
			{
				toolName: "bash",
				input: { command: "echo hi > src/thing.ts" },
			},
			{
				toolName: "bash",
				input: { command: "rm src/obsolete.ts" },
			},
			{
				toolName: "bash",
				input: { command: "git tag v1.0.0" },
			},
			{
				toolName: "bash",
				input: { command: "npm --prefix app install" },
			},
			{
				toolName: "ast_grep_replace",
				input: { path: "src/thing.ts", pattern: "a", replacement: "b" },
			},
			{
				toolName: "lsp_navigation",
				input: {
					operation: "rename",
					path: "src/thing.ts",
					newName: "b",
					apply: true,
				},
			},
			{
				toolName: "Agent",
				input: {
					description: "rewrite the parser",
					subagent_type: "coder",
				},
			},
			{
				toolName: "multi_tool_use.parallel",
				input: {
					tool_uses: [
						{
							recipient_name: "functions.write",
							parameters: { path: "src/generated.ts", content: "x" },
						},
					],
				},
			},
		];
		for (const event of gated) {
			const blocked = await h.fire("tool_call", event);
			expect(blocked.some((r) => (r as { block?: boolean })?.block)).toBe(true);
		}

		// Read-only recon agents stay open before the plan is approved.
		const explorer = await h.fire("tool_call", {
			toolName: "Agent",
			input: { description: "map the auth files", subagent_type: "explorer" },
		});
		expect(explorer.every((r) => r === undefined)).toBe(true);

		await h.call({
			action: "plan_approved",
			note: "https://example.com/reviews/plan-1",
		});
		for (const event of gated) {
			const allowed = await h.fire("tool_call", event);
			expect(allowed.every((r) => r === undefined)).toBe(true);
		}
	});

	test("plan approval and review provenance: a URL or an explicit human verdict", async () => {
		// A bare opinion is not approval provenance.
		const vaguePlan = await h.text({
			action: "plan_approved",
			note: "looks fine to me",
		});
		expect(vaguePlan).toContain("Error");
		const stillBlocked = await h.fire("tool_call", {
			toolName: "write",
			input: { path: "src/thing.ts" },
		});
		expect(stillBlocked.some((r) => (r as { block?: boolean })?.block)).toBe(
			true,
		);

		await h.call({
			action: "plan_approved",
			note: "https://example.com/reviews/plan-1",
		});

		for (const id of ["C1", "C2", "C3"]) {
			await prove(id, `checked ${id} with bun test → 12 pass, 0 fail`);
		}

		const vagueReview = await h.text({
			action: "reviewed",
			note: "looks done to me",
		});
		expect(vagueReview).toContain("Error");

		// An explicit waiver/approval phrase counts as provenance too.
		const waived = await h.text({
			action: "reviewed",
			note: "the user approved the result in chat",
		});
		expect(waived).toContain("closed itself");
	});

	test("await states park the loop and /goal continue resumes it", async () => {
		const waitingPlan = await h.text({ action: "await_plan" });
		expect(waitingPlan).toContain("Parked on plan approval");
		expect(h.state().phase).toBe("await_plan");
		expect(h.state().autoContinue).toBe(false);

		await h.run("continue");
		expect(h.state().phase).toBe("draft");
		expect(h.state().autoContinue).toBe(true);
		expect(h.sent.at(-1)).toContain("Phase: draft");

		await h.call({
			action: "plan_approved",
			note: "the human approved the implementation plan",
		});
		const waitingReview = await h.text({ action: "await_review" });
		expect(waitingReview).toContain("Parked on human /review");
		expect(h.state().phase).toBe("await_review");
		expect(h.state().autoContinue).toBe(false);

		await h.run("continue");
		expect(h.state().phase).toBe("running");
		expect(h.state().autoContinue).toBe(true);
	});

	test("a startup pauses auto-continue until the user resumes", async () => {
		const restarted = makeHarness({ cwd: h.cwd, sessionId: h.sessionId });
		await restarted.fire("session_start", { reason: "startup" });
		expect(restarted.state().autoContinue).toBe(false);
		expect(restarted.notices.at(-1)).toContain("/goal continue to resume");

		await restarted.run("continue");
		expect(restarted.state().autoContinue).toBe(true);
		expect(restarted.sent).toHaveLength(1);
	});

	test("criteria and roadmap changes revoke plan approval", async () => {
		await h.call({
			action: "plan_approved",
			note: "https://example.com/reviews/plan-1",
		});
		await h.call({ action: "set_roadmap", roadmap: ["parse", "render"] });
		expect(h.state().planApproved).toBe(false);

		await h.call({
			action: "plan_approved",
			note: "the user approved the revised roadmap",
		});
		await h.call({ action: "set_roadmap", roadmap: ["parse", "render"] });
		expect(h.state().planApproved).toBe(true);
		await h.call({
			action: "set_criteria",
			criteria: ["docs updated", "tests pass", "no lint errors"],
		});
		expect(h.state().planApproved).toBe(false);
	});

	test("session_compact persists the authoritative state", async () => {
		const before = h.branch.length;
		await h.fire("session_compact", {});
		expect(h.branch.length).toBe(before + 1);
		expect(existsSync(diskStatePath(h.cwd, h.sessionId))).toBe(true);
	});

	test("a hot cycle compacts through the coordinator at 55 percent", async () => {
		resetCompactionCoordinatorForTests();
		const hot = makeHarness({ criteria: THREE, percent: 55 });
		await hot.start("compact the long goal safely");
		await hot.text({ action: "cycle", summary: "first slice", next: "second" });
		await hot.fire("agent_settled", {});
		await Promise.resolve();
		await Promise.resolve();
		expect(hot.compactCalls).toHaveLength(1);
		expect(hot.compactCalls[0].customInstructions).toContain(
			"Compaction reasons: goal-cycle-2",
		);
		expect(hot.compactCalls[0].customInstructions).toContain(
			"compact the long goal safely",
		);
	});

	test("cycle logs the slice and blocks after three stalled cycles", async () => {
		const missing = await h.text({ action: "cycle", summary: "did things" });
		expect(missing).toContain("summary and next required");

		h.setPorcelain(" M src/thing.ts");
		const first = await h.text({
			action: "cycle",
			summary: "wired the parser",
			next: "cover the error path",
		});
		expect(first).toContain("Cycle recorded");
		expect(first).toContain("cycle 1/50");
		expect(first).toContain("next: cover the error path");
		expect(readFileSync(h.goalFile(), "utf8")).toContain("wired the parser");

		await h.call({ action: "cycle", summary: "nothing moved", next: "retry" });
		const stalled = await h.text({
			action: "cycle",
			summary: "nothing moved again",
			next: "retry",
		});
		expect(stalled).toContain("stalled");
		expect(stalled).toContain("phase blocked");
	});

	test("missing Git metadata does not falsely trigger the stall breaker", async () => {
		const nonGit = makeHarness({ criteria: THREE, gitCode: 128 });
		await nonGit.start("run outside a Git repository");
		let result = "";
		for (let cycle = 1; cycle <= 4; cycle += 1) {
			result = await nonGit.text({
				action: "cycle",
				summary: `slice ${cycle}`,
				next: `slice ${cycle + 1}`,
			});
		}
		expect(result).not.toContain("stalled");
		expect(nonGit.state().phase).toBe("draft");
	});

	test("a changed git diff resets the stall detector even when status is identical", async () => {
		h.setPorcelain(" M src/thing.ts");
		h.setDiff("diff --git a/src/thing.ts b/src/thing.ts\n+first attempt");
		await h.text({ action: "cycle", summary: "one", next: "two" });
		// Identical status AND identical diff content: one stall step.
		await h.text({ action: "cycle", summary: "two", next: "three" });

		// The tree moved underneath (diff content changed) even though
		// `git status --porcelain` prints the exact same line: not a stall.
		h.setDiff("diff --git a/src/thing.ts b/src/thing.ts\n+second attempt");
		const reset = await h.text({
			action: "cycle",
			summary: "three",
			next: "four",
		});
		expect(reset).toContain("Cycle recorded");
		expect(reset).not.toContain("stalled");

		// The detector still fires once the tree is quiet again: two quiet
		// cycles is one stall step, the third closes the gate.
		await h.text({ action: "cycle", summary: "four", next: "five" });
		const stalled = await h.text({
			action: "cycle",
			summary: "five",
			next: "six",
		});
		expect(stalled).toContain("stalled");
	});

	test("done needs every criterion evidenced and a review newer than the evidence", async () => {
		const early = await h.text({ action: "done" });
		expect(early).toContain("not evidenced: C1, C2, C3");

		const tooEarly = await h.text({ action: "reviewed" });
		expect(tooEarly).toContain("still unmet: C1, C2, C3");

		for (const id of ["C1", "C2", "C3"]) {
			await prove(id, `checked ${id} with bun test → 12 pass, 0 fail`);
		}

		const noReview = await h.text({ action: "done" });
		expect(noReview).toContain("no human review recorded");

		// The last gate closing is the goal ending: reviewed shuts the loop down.
		const auto = await h.text({
			action: "reviewed",
			note: "the human reviewed and approved the result",
		});
		expect(auto).toContain("closed itself");
		expect(auto).toContain("phase done");
		expect(h.state().phase).toBe("done");
		expect(h.state().autoContinue).toBe(false);

		// done after an auto-close confirms rather than errors.
		const done = await h.text({ action: "done" });
		expect(done).toContain("Goal complete already");

		const closed = await h.text({
			action: "cycle",
			summary: "more",
			next: "more",
		});
		expect(closed).toContain("already done");
	});

	test("a late change invalidates the review rather than sneaking past it", async () => {
		for (const id of ["C1", "C2", "C3"]) {
			await prove(id, `checked ${id} with bun test → 12 pass, 0 fail`);
		}
		await h.call({
			action: "reviewed",
			note: "the human reviewed and approved the result",
		});
		reopenOnDisk(h.cwd, h.sessionId);

		const re = makeHarness({ cwd: h.cwd, sessionId: h.sessionId });
		await re.fire("session_start", { reason: "startup" });
		await re.call({
			action: "evidence",
			id: "C2",
			evidence: "regressed: docs section is missing again",
			met: false,
		});
		expect(await re.text({ action: "done" })).toContain("not evidenced: C2");

		const restoredSource = await re.recordBashProof(
			"README section restored, checked at README.md:40",
		);
		await re.call({
			action: "evidence",
			id: "C2",
			evidence: "README section restored, checked at README.md:40",
			source: restoredSource,
		});
		expect(await re.text({ action: "done" })).toContain(
			"evidence changed after the human review",
		);

		expect(
			await re.text({
				action: "reviewed",
				note: "the human reviewed and approved the restored evidence",
			}),
		).toContain("closed itself");
	});

	test("a satisfied gate closes the loop at the next cycle too", async () => {
		for (const id of ["C1", "C2", "C3"]) {
			await prove(id, `checked ${id} with bun test → 12 pass, 0 fail`);
		}
		await h.call({
			action: "reviewed",
			note: "the human reviewed and approved the result",
		});

		reopenOnDisk(h.cwd, h.sessionId);
		const restarted = makeHarness({ cwd: h.cwd, sessionId: h.sessionId });
		await restarted.fire("session_start", { reason: "startup" });
		const cycled = await restarted.text({
			action: "cycle",
			summary: "nothing left",
			next: "nothing",
		});
		expect(cycled).toContain("closed itself");
		expect(restarted.state().phase).toBe("done");
	});

	test("/goal done closes the goal and records what was skipped", async () => {
		h.setConfirm(false);
		await h.run("done");
		expect(h.state().phase).not.toBe("done");

		h.setConfirm(true);
		await h.run("done");
		const s = h.state() as unknown as { phase: string; doneNote: string };
		expect(s.phase).toBe("done");
		expect(s.doneNote).toContain("not evidenced: C1, C2, C3");
		expect(s.doneNote).toContain("no human review recorded");
		expect(readFileSync(h.goalFile(), "utf8")).toContain("## Closed");
		expect(h.notices.at(-1)).toContain("closed by you");

		await h.run("done");
		expect(h.notices.at(-1)).toContain("already done");
	});

	test("/goal done on a met gate closes without a note", async () => {
		for (const id of ["C1", "C2", "C3"]) {
			await prove(id, `checked ${id} with bun test → 12 pass, 0 fail`);
		}
		await h.call({
			action: "reviewed",
			note: "the human reviewed and approved the result",
		});
		reopenOnDisk(h.cwd, h.sessionId);

		const restarted = makeHarness({ cwd: h.cwd, sessionId: h.sessionId });
		await restarted.fire("session_start", { reason: "startup" });
		await restarted.run("done");
		const s = restarted.state() as unknown as {
			phase: string;
			doneNote?: string;
		};
		expect(s.phase).toBe("done");
		expect(s.doneNote).toBeUndefined();
		expect(restarted.notices.at(-1)).toContain("every criterion evidenced");
	});

	test("background agent handles survive the cycle boundary", async () => {
		await h.fire("tool_result", {
			toolName: "Agent",
			input: { description: "map the auth files", subagent_type: "explorer" },
			content: [{ type: "text", text: "started" }],
			details: { status: "background", agentId: "ag-77" },
		});
		for (let cycle = 1; cycle <= 8; cycle += 1) {
			h.setDiff(`diff --git a/src/thing.ts b/src/thing.ts\n+cycle ${cycle}`);
			await h.text({
				action: "cycle",
				summary: `completed slice ${cycle}`,
				next: `run slice ${cycle + 1}`,
			});
		}
		const withAgent = await h.text({ action: "status" });
		expect(withAgent).toContain("ag-77 (map the auth files)");

		// A still-running readback must not clear the handle.
		await h.fire("tool_result", {
			toolName: "get_subagent_result",
			input: { agent_id: "ag-77" },
			content: [
				{
					type: "text",
					text: "Agent: ag-77\nType: Explorer | Status: running | Tool uses: 3",
				},
			],
			details: undefined,
		});
		expect(await h.text({ action: "status" })).toContain("ag-77");

		await h.fire("tool_result", {
			toolName: "get_subagent_result",
			input: { agent_id: "ag-77" },
			content: [
				{
					type: "text",
					text:
						"Agent: ag-77\nType: Explorer | Status: completed | Tool uses: 9\n\nFound them.",
				},
			],
			details: undefined,
		});
		expect(await h.text({ action: "status" })).not.toContain("ag-77");
	});

	test("a fresh session reloads the goal from disk", async () => {
		await prove("C1", "bun test → 12 pass, 0 fail");
		await h.call({ action: "set_roadmap", roadmap: ["parse", "render", "ship"] });
		await h.call({ action: "step", id: "S2", state: "active" });

		// New process, same project: nothing in session memory, everything on disk.
		const restarted = makeHarness({ cwd: h.cwd, sessionId: h.sessionId });
		await restarted.fire("session_start", { reason: "startup" });

		const status = await restarted.text({ action: "status" });
		expect(status).toContain("make the thing work");
		expect(status).toContain("[x] C1 tests pass");
		expect(status).toContain("active S2 render");
		expect(status).toContain("1/3 evidenced");
	});

	test("renderers and the widget survive a render", async () => {
		await h.call({ action: "set_roadmap", roadmap: ["parse", "render"] });
		await h.call({ action: "step", id: "S1", state: "active" });

		const factory = h.widget();
		expect(factory).not.toBeNull();
		const lines = factory!(null, theme).render();
		const widget = lines.join("\n");
		expect(widget).toContain("goal 0/3");
		expect(widget).toContain("S1 parse");

		const tool = h.tool()!;
		const callRow = tool.renderCall({ action: "evidence", id: "C1" }, theme);
		expect(callRow.text).toContain("goal");
		expect(callRow.text).toContain("C1");

		const result = await h.call({ action: "status" });
		const resultRow = tool.renderResult(result, { expanded: false }, theme);
		expect(resultRow.text).toContain("✓");
	});

	test("the system prompt carries the live goal state", async () => {
		const [patched] = (await h.fire("before_agent_start", {
			systemPrompt: "BASE PROMPT",
		})) as { systemPrompt: string }[];
		expect(patched.systemPrompt).toContain("BASE PROMPT");
		expect(patched.systemPrompt).toContain("GOAL LOOP ACTIVE");
		expect(patched.systemPrompt).toContain("GOAL.md");
		expect(patched.systemPrompt).toContain("C1 tests pass");
	});
});
