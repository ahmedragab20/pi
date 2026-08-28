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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import goalExtension from "../extensions/goal.ts";
import { TEST_AGENT_DIR } from "./goal-stubs.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = { content: { type: string; text: string }[]; details: unknown };

let cwdSeq = 0;

function makeHarness(
	options: { criteria?: string; percent?: number | null; cwd?: string } = {},
) {
	const cwd = options.cwd ?? `/tmp/goal-project-${++cwdSeq}`;
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const notices: string[] = [];
	const branch: { type: string; customType: string; data: unknown }[] = [];
	let porcelain = "";
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
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | null =
		null;
	let activeTools = ["read", "bash", "edit", "write"];
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
		exec: async () => ({ stdout: porcelain, stderr: "", code: 0 }),
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
			confirm: async () => true,
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
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({
			tokens: 1000,
			contextWindow: 100000,
			percent: options.percent === undefined ? 10 : options.percent,
		}),
		compact: () => {},
	};

	goalExtension(pi as never);

	const fire = async (event: string, payload: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
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

	return {
		cwd,
		sent,
		notices,
		branch,
		fire,
		call,
		text,
		start,
		setPorcelain: (value: string) => {
			porcelain = value;
		},
		goalFile: () => {
			const status = branch[branch.length - 1]?.data as { file: string };
			return status.file;
		},
		state: () => branch[branch.length - 1]?.data as Record<string, never>,
		tool: () => tool,
		widget: () => widgetFactory,
	};
}

const THREE = "- [ ] tests pass\n- [ ] docs updated\n- [ ] no lint errors\n";

const theme = {
	fg: (_color: string, s: string) => s,
	bold: (s: string) => s,
};

describe("goal loop", () => {
	let h: ReturnType<typeof makeHarness>;

	beforeEach(async () => {
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

	test("evidence rejects a claim and accepts real proof", async () => {
		const weak = await h.text({ action: "evidence", id: "C1", evidence: "works" });
		expect(weak).toContain("Error");
		expect(weak).toContain("claim, not evidence");

		const stamp = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "all tests pass",
		});
		expect(stamp).toContain("claim, not evidence");

		const short = await h.text({ action: "evidence", id: "C1", evidence: "x=1" });
		expect(short).toContain("too short");

		const good = await h.text({
			action: "evidence",
			id: "C1",
			evidence: "bun test → 12 pass, 0 fail",
		});
		expect(good).toContain("C1 evidenced");
		expect(good).toContain("1/3 evidenced");

		const unknown = await h.text({
			action: "evidence",
			id: "C9",
			evidence: "bun test → 12 pass, 0 fail",
		});
		expect(unknown).toContain("unknown id C9");
	});

	test("evidence survives a criteria rewrite, and a silent drop is refused", async () => {
		await h.call({
			action: "evidence",
			id: "C1",
			evidence: "bun test → 12 pass, 0 fail",
		});

		// Same text, reordered and extended: the proof must come with it.
		const kept = await h.text({
			action: "set_criteria",
			criteria: ["docs updated", "tests pass", "ships behind a flag"],
		});
		expect(kept).toContain("3 criteria recorded");
		expect(kept).toContain("[x] C1 tests pass — bun test → 12 pass, 0 fail");

		const dropped = await h.text({
			action: "set_criteria",
			criteria: ["docs updated"],
		});
		expect(dropped).toContain("Error");
		expect(dropped).toContain("drop evidenced criteria (C1)");

		const forced = await h.text({
			action: "set_criteria",
			criteria: ["docs updated"],
			force: true,
		});
		expect(forced).toContain("dropped C1");
		expect(forced).toContain("0/1 evidenced");
	});

	test("product code is blocked until the plan is approved", async () => {
		const blocked = await h.fire("tool_call", {
			toolName: "write",
			input: { path: "src/thing.ts" },
		});
		expect(blocked.some((r) => (r as { block?: boolean })?.block)).toBe(true);

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

	test("done needs every criterion evidenced and a review newer than the evidence", async () => {
		const early = await h.text({ action: "done" });
		expect(early).toContain("not evidenced: C1, C2, C3");

		const tooEarly = await h.text({ action: "reviewed" });
		expect(tooEarly).toContain("still unmet: C1, C2, C3");

		for (const id of ["C1", "C2", "C3"]) {
			await h.call({
				action: "evidence",
				id,
				evidence: `checked ${id} with bun test → 12 pass, 0 fail`,
			});
		}

		const noReview = await h.text({ action: "done" });
		expect(noReview).toContain("no human review recorded");

		await h.call({ action: "reviewed" });

		// A late change invalidates the review rather than sneaking past it.
		await h.call({
			action: "evidence",
			id: "C2",
			evidence: "regressed: docs section is missing again",
			met: false,
		});
		const stale = await h.text({ action: "done" });
		expect(stale).toContain("not evidenced: C2");

		await h.call({
			action: "evidence",
			id: "C2",
			evidence: "README section restored, checked at README.md:40",
		});
		const staleReview = await h.text({ action: "done" });
		expect(staleReview).toContain("evidence changed after the human review");

		await h.call({ action: "reviewed" });
		const done = await h.text({ action: "done" });
		expect(done).toContain("Goal complete");

		const closed = await h.text({ action: "cycle", summary: "more", next: "more" });
		expect(closed).toContain("already done");
	});

	test("background agent handles survive the cycle boundary", async () => {
		await h.fire("tool_result", {
			toolName: "Agent",
			input: { description: "map the auth files", subagent_type: "explorer" },
			content: [{ type: "text", text: "started" }],
			details: { status: "background", agentId: "ag-77" },
		});
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
					text: "Agent: ag-77\nType: Explorer | Status: completed | Tool uses: 9\n\nFound them.",
				},
			],
			details: undefined,
		});
		expect(await h.text({ action: "status" })).not.toContain("ag-77");
	});

	test("a fresh session reloads the goal from disk", async () => {
		await h.call({
			action: "evidence",
			id: "C1",
			evidence: "bun test → 12 pass, 0 fail",
		});
		await h.call({ action: "set_roadmap", roadmap: ["parse", "render", "ship"] });
		await h.call({ action: "step", id: "S2", state: "active" });

		// New process, same project: nothing in session memory, everything on disk.
		const restarted = makeHarness({ cwd: h.cwd });
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
