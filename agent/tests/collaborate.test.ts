/**
 * Collaboration ledger.
 *
 *   bun test --preload tests/goal-stubs.ts tests/collaborate.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import collaborateExtension, {
	MAX_PARALLEL,
	addTaskToState,
	addTasksToState,
	findPathConflict,
	finishBlockers,
	formatReviewCard,
	kickoffStart,
	lintBrief,
	nextAction,
	nextPanePlacement,
	parseAddArgs,
	parseBranch,
	parseEditorAdd,
	statusLabel,
	takeReady,
	taskReady,
	widgetLines,
	type CollaborationState,
} from "../extensions/collaborate.ts";
import { TEST_AGENT_DIR } from "./goal-stubs.ts";

function errorMessage(run: () => unknown): string {
	try {
		run();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("parseAddArgs", () => {
	test("parses worker with paths, dependsOn, and brief", () => {
		const result = parseAddArgs(
			"worker --paths=src/a.ts,src/b.ts --after=T1,T2 -- implement the exact change",
		);
		expect(result.type).toBe("worker");
		expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.dependsOn).toEqual(["T1", "T2"]);
		expect(result.description).toBe("implement the exact change");
	});

	test("rejects a missing -- brief", () => {
		expect(errorMessage(() => parseAddArgs("worker --paths=src/a.ts"))).toBe(
			"Add a complete worker brief after --",
		);
	});

	test("rejects an unknown worker type", () => {
		expect(errorMessage(() => parseAddArgs("boss -- do the thing"))).toBe(
			"Unknown worker type: boss",
		);
	});
});

describe("findPathConflict", () => {
	const conflictTask = {
		id: "T1",
		type: "worker" as const,
		description: "",
		paths: ["src/a.ts"],
		dependsOn: [] as string[],
		status: "running" as const,
	};
	const freeTask = {
		id: "T2",
		type: "worker" as const,
		description: "",
		paths: ["src/other.ts"],
		dependsOn: [] as string[],
		status: "running" as const,
	};

	test("reports an exact-path conflict", () => {
		const conflict = findPathConflict(
			{ type: "worker", description: "", paths: ["src/a.ts"], dependsOn: [] },
			[conflictTask],
		);
		expect(conflict).toBe("src/a.ts overlaps src/a.ts, owned by T1");
	});

	test("reports directory ownership overlap", () => {
		const conflict = findPathConflict(
			{
				type: "worker",
				description: "",
				paths: ["src/nested/b.ts"],
				dependsOn: [],
			},
			[
				{
					id: "T1",
					type: "worker",
					description: "",
					paths: ["src"],
					dependsOn: [],
					status: "running" as const,
				},
			],
		);
		expect(conflict).toBe("src/nested/b.ts overlaps src, owned by T1");
	});

	test("allows distinct paths", () => {
		const conflict = findPathConflict(
			{ type: "worker", description: "", paths: ["src/new.ts"], dependsOn: [] },
			[conflictTask, freeTask],
		);
		expect(conflict).toBeUndefined();
	});

	test("accepted and dropped tasks release the path lock", () => {
		expect(
			findPathConflict(
				{ type: "worker", description: "", paths: ["src/a.ts"], dependsOn: [] },
				[
					{ ...conflictTask, status: "accepted" },
					{ ...freeTask, status: "dropped", paths: ["src/a.ts"] },
				],
			),
		).toBeUndefined();
	});

	test("failed and rejected tasks keep the path lock", () => {
		expect(
			findPathConflict(
				{ type: "worker", description: "", paths: ["src/a.ts"], dependsOn: [] },
				[{ ...conflictTask, status: "failed" }],
			),
		).toBe("src/a.ts overlaps src/a.ts, owned by T1");
		expect(
			findPathConflict(
				{ type: "worker", description: "", paths: ["src/a.ts"], dependsOn: [] },
				[{ ...conflictTask, status: "rejected" }],
			),
		).toBe("src/a.ts overlaps src/a.ts, owned by T1");
	});
});

describe("nextPanePlacement", () => {
	test("0 peers: new tab at index 0", () => {
		expect(nextPanePlacement(0)).toEqual({ newTab: true, anchorIndex: 0 });
	});

	test("1 peer: split peer 0 down", () => {
		expect(nextPanePlacement(1)).toEqual({
			newTab: false,
			anchorIndex: 0,
			direction: "down",
		});
	});

	test("2 peers: split peer 0 right", () => {
		expect(nextPanePlacement(2)).toEqual({
			newTab: false,
			anchorIndex: 0,
			direction: "right",
		});
	});

	test("3 peers: split peer 1 right", () => {
		expect(nextPanePlacement(3)).toEqual({
			newTab: false,
			anchorIndex: 1,
			direction: "right",
		});
	});

	test("4 peers: new tab at index 4", () => {
		expect(nextPanePlacement(4)).toEqual({ newTab: true, anchorIndex: 4 });
	});
});

function emptyState(
	overrides: Partial<CollaborationState> = {},
): CollaborationState {
	return {
		version: 1,
		id: "ship-the-page",
		goal: "ship the page",
		cwd: "/tmp/proj",
		sessionId: "sess-1",
		paused: false,
		createdAt: 1,
		updatedAt: 1,
		tasks: [],
		peers: [],
		...overrides,
	};
}

describe("statusLabel / widgetLines / nextAction", () => {
	test("empty ledger asks for tasks, not team 0/0", () => {
		const state = emptyState();
		expect(statusLabel(state)).toBe("collab · add tasks");
		expect(widgetLines(state)).toEqual(["next · add tasks", "no tasks yet"]);
		expect(nextAction(state)).toBe("add tasks");
	});

	test("review beats running in the next-action footer", () => {
		const state = emptyState({
			tasks: [
				{
					id: "T1",
					type: "worker",
					description: "a",
					paths: ["a.ts"],
					dependsOn: [],
					status: "review",
				},
				{
					id: "T2",
					type: "tests",
					description: "b",
					paths: ["b.ts"],
					dependsOn: [],
					status: "running",
				},
			],
		});
		expect(statusLabel(state)).toBe("collab 0/2 · accept T1");
		expect(nextAction(state)).toBe("accept T1");
	});

	test("kickoff tells the lead the ledger is empty and to add then run", () => {
		const text = kickoffStart(emptyState());
		expect(text).toContain("nothing runs until you add exact worker tasks");
		expect(text).toContain("Goal: ship the page");
		expect(text).toContain("collaborate add");
		expect(text).toContain("collaborate run");
		expect(text).toContain("collaborate accept");
		expect(text).toContain("Call `collaborate status` now");
	});
});

const workerBrief = (text = "src/a.ts") =>
	`1. Change ${text}.\n2. Run bun test ${text.replace(/\.ts$/, ".test.ts")}.`;

describe("lintBrief", () => {
	test("rejects a dumped goal with no paths or steps", () => {
		expect(
			lintBrief({
				type: "worker",
				description: "implement the page",
				paths: [],
				dependsOn: [],
			}),
		).toBe("Write tasks need --paths=...");
		expect(
			lintBrief({
				type: "worker",
				description: "implement the page",
				paths: ["src/page.ts"],
				dependsOn: [],
			}),
		).toBe("Write tasks need numbered steps");
		expect(
			lintBrief({
				type: "worker",
				description: "1. Implement the page.",
				paths: ["src/page.ts"],
				dependsOn: [],
			}),
		).toBe("Worker/tests/lint tasks need a named check in the brief");
	});

	test("allows a strict worker brief and a read-only explorer", () => {
		expect(
			lintBrief({
				type: "worker",
				description: workerBrief(),
				paths: ["src/a.ts"],
				dependsOn: [],
			}),
		).toBeUndefined();
		expect(
			lintBrief({
				type: "explorer",
				description: "map the prototype",
				paths: [],
				dependsOn: [],
			}),
		).toBeUndefined();
	});
});

describe("taskReady / takeReady / finishBlockers", () => {
	test("dependents wait for accept, not review", () => {
		const t1 = {
			id: "T1",
			type: "worker" as const,
			description: workerBrief(),
			paths: ["a.ts"],
			dependsOn: [],
			status: "review" as const,
		};
		const t2 = {
			id: "T2",
			type: "tests" as const,
			description: "1. Cover a.\n2. Run bun test a.test.ts.",
			paths: ["a.test.ts"],
			dependsOn: ["T1"],
			status: "waiting" as const,
		};
		expect(taskReady(t2, [t1, t2])).toBe(false);
		expect(taskReady(t2, [{ ...t1, status: "accepted" }, t2])).toBe(true);
	});

	test("takeReady respects the parallel cap", () => {
		const tasks = Array.from({ length: 5 }, (_, index) => ({
			id: `T${index + 1}`,
			type: "explorer" as const,
			description: `map ${index}`,
			paths: [] as string[],
			dependsOn: [] as string[],
			status: "ready" as const,
		}));
		const running = {
			...tasks[0],
			id: "T9",
			status: "running" as const,
		};
		const state = emptyState({ tasks: [...tasks, running] });
		expect(takeReady(state).map((task) => task.id)).toEqual(["T1", "T2"]);
		expect(MAX_PARALLEL).toBe(3);
	});

	test("finish is blocked until every live task is accepted or dropped", () => {
		const state = emptyState({
			tasks: [
				{
					id: "T1",
					type: "worker",
					description: workerBrief(),
					paths: ["a.ts"],
					dependsOn: [],
					status: "review",
					branch: "pi-agent-1",
				},
			],
		});
		expect(finishBlockers(state)).toEqual(["T1 needs accept"]);
		state.tasks[0].status = "accepted";
		state.tasks[0].merged = true;
		expect(finishBlockers(state)).toEqual([]);
	});
});

describe("parseBranch / parseEditorAdd / formatReviewCard", () => {
	test("reads the worktree branch note", () => {
		expect(
			parseBranch("Changes saved to branch `pi-agent-abc`."),
		).toBe("pi-agent-abc");
		expect(parseBranch("no note", "explicit")).toBe("explicit");
	});

	test("parses editor blocks", () => {
		const inputs = parseEditorAdd(
			[
				"# comment",
				"explorer --",
				"1. Map the files.",
				"",
				"worker --paths=src/a.ts --",
				"1. Change src/a.ts.",
				"2. Run bun test src/a.test.ts.",
			].join("\n"),
		);
		expect(inputs).toHaveLength(2);
		expect(inputs[0]?.type).toBe("explorer");
		expect(inputs[1]?.paths).toEqual(["src/a.ts"]);
	});

	test("review card tells the lead to accept before dependents", () => {
		const card = formatReviewCard({
			id: "T1",
			type: "worker",
			description: workerBrief(),
			paths: ["a.ts"],
			dependsOn: [],
			status: "review",
			branch: "pi-agent-1",
			result: "changed a.ts",
		});
		expect(card).toContain("Dependents will not start until you accept");
		expect(card).toContain("Branch: pi-agent-1");
		expect(card).toContain("collaborate accept T1");
	});
});

describe("addTaskToState", () => {
	test("assigns T1 ready with no deps", () => {
		const state = emptyState();
		const task = addTaskToState(state, {
			type: "explorer",
			description: "map the prototype",
			paths: [],
			dependsOn: [],
		});
		expect(task.id).toBe("T1");
		expect(task.status).toBe("ready");
		expect(state.tasks).toHaveLength(1);
	});

	test("rejects unknown dependency after lint", () => {
		expect(
			errorMessage(() =>
				addTaskToState(emptyState(), {
					type: "worker",
					description: workerBrief(),
					paths: ["a.ts"],
					dependsOn: ["T9"],
				}),
			),
		).toBe("Unknown dependency: T9");
	});

	test("batch add conflict-checks as a set and waits on unaccepted deps", () => {
		const state = emptyState();
		const created = addTasksToState(state, [
			{
				type: "worker",
				description: workerBrief(),
				paths: ["src/a.ts"],
				dependsOn: [],
			},
			{
				type: "tests",
				description: "1. Cover a.\n2. Run bun test src/a.test.ts.",
				paths: ["src/a.test.ts"],
				dependsOn: ["T1"],
			},
		]);
		expect(created.map((task) => `${task.id}:${task.status}`)).toEqual([
			"T1:ready",
			"T2:waiting",
		]);
	});
});

type Handler = (args: string, ctx: unknown) => Promise<void>;
type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
	signal: unknown,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function makeHarness(options: { sessionId?: string; confirm?: boolean } = {}) {
	const commands = new Map<string, { handler: Handler }>();
	const tools = new Map<string, { execute: ToolExecute }>();
	const eventHandlers = new Map<string, Array<(raw: unknown) => void>>();
	const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const execCalls: Array<{ cmd: string; args: string[] }> = [];
	const sessionStart: Array<(event: unknown, ctx: unknown) => unknown> = [];
	const beforeAgentStart: Array<(event: unknown, ctx: unknown) => unknown> =
		[];
	let agentSeq = 0;
	let mergeCode = 0;

	const events = {
		on(channel: string, handler: (raw: unknown) => void) {
			const list = eventHandlers.get(channel) ?? [];
			list.push(handler);
			eventHandlers.set(channel, list);
			return () => {
				eventHandlers.set(
					channel,
					(eventHandlers.get(channel) ?? []).filter((item) => item !== handler),
				);
			};
		},
		emit(channel: string, data: Record<string, unknown>) {
			if (channel.endsWith(":reply:") || channel.includes(":reply:")) {
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
				return;
			}
			if (channel === "worker-model:rpc:resolve") {
				events.emit(`worker-model:rpc:resolve:reply:${data.requestId}`, {
					success: true,
					data: "opencode-go/glm-5.3-flash",
				});
				return;
			}
			if (channel === "subagents:rpc:spawn") {
				agentSeq += 1;
				events.emit(`subagents:rpc:spawn:reply:${data.requestId}`, {
					success: true,
					data: { id: `agent-${agentSeq}` },
				});
				return;
			}
			if (
				channel === "subagents:rpc:stop" ||
				channel === "subagents:rpc:consume"
			) {
				events.emit(`${channel}:reply:${data.requestId}`, { success: true });
				return;
			}
			for (const handler of eventHandlers.get(channel) ?? []) handler(data);
		},
	};

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "before_agent_start") beforeAgentStart.push(handler);
			if (event === "session_start") sessionStart.push(handler);
		},
		registerCommand(name: string, def: { handler: Handler }) {
			commands.set(name, def);
		},
		registerTool(def: { name: string; execute: ToolExecute }) {
			tools.set(def.name, def);
		},
		sendUserMessage(text: string, options?: Record<string, unknown>) {
			sent.push({ text, options });
		},
		events,
		exec: async (cmd: string, args: string[] = []) => {
			execCalls.push({ cmd, args });
			if (cmd === "git" && args[0] === "merge") {
				return {
					code: mergeCode,
					stdout: "",
					stderr: mergeCode === 0 ? "" : "merge conflict",
					killed: false,
				};
			}
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};

	collaborateExtension(pi as never);

	const ctx = {
		hasUI: true,
		mode: "print",
		cwd: "/tmp/proj",
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-collab-test",
		},
		ui: {
			notify(message: string, type?: string) {
				notices.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			setWidget(key: string, lines: string[] | undefined) {
				widgets.push({ key, lines });
			},
			confirm: async () => options.confirm ?? true,
		},
	};

	return {
		commands,
		tools,
		sent,
		notices,
		statuses,
		widgets,
		ctx,
		beforeAgentStart,
		sessionStart,
		execCalls,
		events,
		setMergeCode(code: number) {
			mergeCode = code;
		},
	};
}

describe("/collaborate start", () => {
	test("kicks the lead instead of sitting on an empty ledger", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler(
			"start implement the second page",
			harness.ctx,
		);
		expect(harness.notices.at(-1)?.message).toBe(
			"Collaboration open. Lead is planning — nothing is running yet.",
		);
		expect(harness.statuses.at(-1)).toEqual({
			key: "collaborate",
			text: "collab · add tasks",
		});
		expect(harness.widgets.at(-1)?.lines).toEqual([
			"next · add tasks",
			"no tasks yet",
		]);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.text).toContain("Goal: implement the second page");
		expect(harness.sent[0]?.text).toContain("collaborate add");
		const file = join(
			TEST_AGENT_DIR,
			"collaborations",
			"sess-collab-test.json",
		);
		expect(existsSync(file)).toBe(true);
		const saved = JSON.parse(readFileSync(file, "utf8")) as CollaborationState;
		expect(saved.tasks).toEqual([]);
		expect(saved.peers).toEqual([]);
		const appendix = (await harness.beforeAgentStart[0]?.(
			{ systemPrompt: "base" },
			harness.ctx,
		)) as { systemPrompt: string };
		expect(appendix.systemPrompt.startsWith("base\n\n")).toBe(true);
		expect(appendix.systemPrompt).toContain("A /collaborate ledger is active");
		expect(appendix.systemPrompt).toContain("Goal: implement the second page");
	});

	test("rejects a missing goal without sending a kickoff", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler("start", harness.ctx);
		expect(harness.notices.at(-1)).toEqual({
			message: "Usage: /collaborate start <goal>",
			type: "error",
		});
		expect(harness.sent).toHaveLength(0);
	});

	test("confirms before overwriting a ledger that has tasks", async () => {
		const harness = makeHarness({ confirm: false });
		await harness.commands.get("collaborate")!.handler("start first", harness.ctx);
		await harness.tools.get("collaborate")!.execute(
			"t1",
			{ action: "add", type: "explorer", description: "map it" },
			undefined,
			undefined,
			harness.ctx,
		);
		await harness.commands.get("collaborate")!.handler(
			"start second",
			harness.ctx,
		);
		const status = await harness.tools.get("collaborate")!.execute(
			"t2",
			{ action: "status" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(status.content[0]?.text).toContain("Collaboration: first");
		expect(harness.sent.filter((item) => item.text.includes("Goal: second"))).toHaveLength(0);
	});

	test("reload of an open ledger kicks the lead with current next action", async () => {
		const first = makeHarness({ sessionId: "sess-resume" });
		await first.commands.get("collaborate")!.handler(
			"start resume me",
			first.ctx,
		);
		const second = makeHarness({ sessionId: "sess-resume" });
		await second.sessionStart[0]?.({}, second.ctx);
		expect(second.sent[0]?.text).toContain("Collaboration still open");
		expect(second.sent[0]?.text).toContain("Goal: resume me");
		expect(second.sent[0]?.text).toContain("Next: add tasks");
	});
});

describe("collaborate tool", () => {
	test("add writes a ready task the lead can run", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler(
			"start ship the page",
			harness.ctx,
		);
		const result = await harness.tools.get("collaborate")!.execute(
			"t1",
			{
				action: "add",
				type: "explorer",
				description: "map design-system/prototype.html",
				paths: ["design-system/prototype.html"],
			},
			undefined,
			undefined,
			harness.ctx,
		);
		expect(result.content[0]?.text).toContain("T1 added · ready");
		const status = await harness.tools.get("collaborate")!.execute(
			"t2",
			{ action: "status" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(status.content[0]?.text).toContain("1 ready");
		expect(status.content[0]?.text).toContain("T1 explorer");
	});

	test("add without an open ledger fails", async () => {
		const harness = makeHarness();
		const result = await harness.tools.get("collaborate")!.execute(
			"t1",
			{ action: "add", type: "worker", description: "x" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(result.content[0]?.text).toBe(
			"Error: Start with /collaborate start <goal>",
		);
	});

	test("rejects a dumped worker brief", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler("start ship", harness.ctx);
		const result = await harness.tools.get("collaborate")!.execute(
			"t1",
			{ action: "add", type: "worker", description: "implement the page" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(result.content[0]?.text).toBe("Error: Write tasks need --paths=...");
	});

	test("settle sends a review card and does not auto-run dependents", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler("start ship", harness.ctx);
		await harness.tools.get("collaborate")!.execute(
			"t1",
			{
				action: "add",
				tasks: [
					{
						type: "explorer",
						description: "1. Map a.ts.",
					},
					{
						type: "worker",
						description: workerBrief("src/a.ts"),
						paths: ["src/a.ts"],
						dependsOn: ["T1"],
					},
				],
			},
			undefined,
			undefined,
			harness.ctx,
		);
		await harness.tools.get("collaborate")!.execute(
			"t2",
			{ action: "run" },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.events.emit("subagents:completed", {
			id: "agent-1",
			result: "mapped\n\nChanges saved to branch `pi-agent-1`.",
		});
		const status = await harness.tools.get("collaborate")!.execute(
			"t3",
			{ action: "status" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(status.content[0]?.text).toContain("T1 explorer — review");
		expect(status.content[0]?.text).toContain("T2 worker — waiting");
		expect(harness.sent.at(-1)?.text).toContain("T1 explorer is ready for review");
		expect(harness.sent.at(-1)?.text).toContain("pi-agent-1");
	});

	test("accept merges the worktree and unblocks dependents", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler("start ship", harness.ctx);
		await harness.tools.get("collaborate")!.execute(
			"t1",
			{
				action: "add",
				tasks: [
					{
						type: "explorer",
						description: "1. Map a.ts.",
					},
					{
						type: "worker",
						description: workerBrief("src/a.ts"),
						paths: ["src/a.ts"],
						dependsOn: ["T1"],
					},
				],
			},
			undefined,
			undefined,
			harness.ctx,
		);
		await harness.tools.get("collaborate")!.execute(
			"t2",
			{ action: "run" },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.events.emit("subagents:completed", {
			id: "agent-1",
			result: "Changes saved to branch `pi-agent-1`.",
		});
		const accepted = await harness.tools.get("collaborate")!.execute(
			"t3",
			{ action: "accept", id: "T1" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(accepted.content[0]?.text).toContain("T1 accepted and merged pi-agent-1");
		expect(accepted.content[0]?.text).toContain("T2 worker — ready");
		expect(harness.execCalls.some((call) => call.args[0] === "merge")).toBe(true);
	});

	test("failed merge keeps the task in review", async () => {
		const harness = makeHarness();
		harness.setMergeCode(1);
		await harness.commands.get("collaborate")!.handler("start ship", harness.ctx);
		await harness.tools.get("collaborate")!.execute(
			"t1",
			{ action: "add", type: "explorer", description: "1. Map it." },
			undefined,
			undefined,
			harness.ctx,
		);
		await harness.tools.get("collaborate")!.execute(
			"t2",
			{ action: "run" },
			undefined,
			undefined,
			harness.ctx,
		);
		harness.events.emit("subagents:completed", {
			id: "agent-1",
			result: "Changes saved to branch `pi-agent-1`.",
		});
		const accepted = await harness.tools.get("collaborate")!.execute(
			"t3",
			{ action: "accept", id: "T1" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(accepted.content[0]?.text).toContain("Error: merge conflict");
		const status = await harness.tools.get("collaborate")!.execute(
			"t4",
			{ action: "status" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(status.content[0]?.text).toContain("T1 explorer — review");
	});

	test("finish is rejected while a task still needs accept", async () => {
		const harness = makeHarness();
		await harness.commands.get("collaborate")!.handler("start ship", harness.ctx);
		await harness.tools.get("collaborate")!.execute(
			"t1",
			{ action: "add", type: "explorer", description: "1. Map it." },
			undefined,
			undefined,
			harness.ctx,
		);
		const finished = await harness.tools.get("collaborate")!.execute(
			"t2",
			{ action: "finish" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(finished.content[0]?.text).toBe("Error: T1 not done");
	});
});
