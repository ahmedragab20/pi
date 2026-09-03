/**
 * Collaboration ledger
 *
 * `/collaborate start <goal>` opens the ledger and kicks the lead. Nothing
 * runs until the lead adds exact worker chores and `run`s them. A finished
 * worker is `review` until the lead `accept`s (merge) or `reject`s / `retry`s.
 * Dependents wait for accept. Cheap Flash workers execute through
 * pi-subagents; visible Herdr peers are a separate lead-tier path.
 * Reload with `/reload`.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const VERSION = 1;
export const MAX_PARALLEL = 3;
const WORKER_TYPES = [
	"worker",
	"tests",
	"lint",
	"docs",
	"explorer",
	"terminal-reader",
	"log-reader",
	"diff-reader",
	"git",
	"memory",
] as const;
const WRITE_TYPES = new Set<WorkerType>([
	"worker",
	"tests",
	"lint",
	"docs",
	"git",
	"memory",
]);
const STRICT_CHECK_TYPES = new Set<WorkerType>(["worker", "tests", "lint"]);
const FREE_STATUSES = new Set<TaskStatus>(["accepted", "dropped"]);
const TOOL_ACTIONS = [
	"status",
	"add",
	"run",
	"peer",
	"accept",
	"reject",
	"retry",
	"drop",
	"cancel",
	"steer",
	"assign",
	"pause",
	"resume",
	"finish",
] as const;

type WorkerType = (typeof WORKER_TYPES)[number];
type TaskStatus =
	| "ready"
	| "waiting"
	| "running"
	| "review"
	| "accepted"
	| "rejected"
	| "failed"
	| "dropped";

type CollaborationTask = {
	id: string;
	type: WorkerType;
	description: string;
	paths: string[];
	dependsOn: string[];
	status: TaskStatus;
	agentId?: string;
	branch?: string;
	result?: string;
	error?: string;
	assignedTo?: string;
	merged?: boolean;
};

type CollaborationPeer = {
	name: string;
	cwd: string;
	tabId: string;
	paneId: string;
};

export type CollaborationState = {
	version: number;
	id: string;
	goal: string;
	cwd: string;
	sessionId: string;
	paused: boolean;
	createdAt: number;
	updatedAt: number;
	tasks: CollaborationTask[];
	peers: CollaborationPeer[];
};

const TaskInputSchema = Type.Object({
	type: StringEnum(WORKER_TYPES),
	description: Type.String({
		description:
			"Complete worker brief — numbered steps, exact files, named checks",
	}),
	paths: Type.Optional(Type.Array(Type.String())),
	dependsOn: Type.Optional(Type.Array(Type.String())),
});

const CollaborateParams = Type.Object({
	action: StringEnum(TOOL_ACTIONS, {
		description:
			"status; add; run; accept/reject/retry/drop; cancel/steer; assign; peer; pause/resume; finish",
	}),
	type: Type.Optional(StringEnum(WORKER_TYPES, { description: "add: worker type" })),
	description: Type.Optional(
		Type.String({
			description:
				"add: complete worker brief — numbered steps, exact files, named checks",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "add: exclusive writable paths; omit for read-only tasks",
		}),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description: "add: task ids that must be accepted first",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskInputSchema, {
			description: "add: batch of chores, conflict-checked as a set",
		}),
	),
	id: Type.Optional(
		Type.String({
			description: "task id (T1) for run/accept/reject/retry/drop/cancel/steer/assign",
		}),
	),
	name: Type.Optional(
		Type.String({ description: "peer: Herdr agent name; assign: peer name" }),
	),
	cwd: Type.Optional(
		Type.String({ description: "peer: working directory relative to the session" }),
	),
	message: Type.Optional(
		Type.String({ description: "steer: mid-run redirect; reject: why" }),
	),
});

type AgentEvent = {
	id?: string;
	status?: string;
	result?: string;
	error?: string;
	branch?: string;
};

type RpcReply<T> = { success: boolean; data?: T; error?: string };

type Completion = { value: string; label: string; description?: string };

export type AddTaskInput = {
	type: WorkerType;
	description: string;
	paths: string[];
	dependsOn: string[];
};

const EDITOR_TEMPLATE = [
	"# One task per blank-line block. Same syntax as /collaborate add.",
	"# Save to accept, close without saving to cancel.",
	"",
	"explorer --",
	"1. Map the files this goal touches.",
	"2. Return the exact paths a worker would own.",
	"",
	"worker --paths=src/example.ts --",
	"1. Make the exact change in src/example.ts.",
	"2. Run bun test src/example.test.ts.",
].join("\n");

const SECURITY_BRIEF = [
	"Hard constraints (never violate):",
	"- No sudo, rm -rf/-f, chmod/chown 777 or -R, curl|sh, git push --force, git reset --hard, git clean -f, kill -9/pkill/killall, disk/system-destructive commands.",
	"- Never read or write secrets: .env, auth.json, credentials.json, *.pem/*.key, .ssh, .netrc, .npmrc.",
	"- No merges, pushes, or git destructive commands. The lead integrates on accept.",
].join("\n");

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

type SubagentManager = {
	getRecord?: (id: string) =>
		| {
				session?: { steer?: (message: string) => Promise<void> };
				worktreeResult?: { hasChanges?: boolean; branch?: string };
		  }
		| undefined;
};

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 28) || "team"
	);
}

function stateRoot(): string {
	return join(getAgentDir(), "collaborations");
}

function statePath(sessionId: string): string {
	return join(stateRoot(), `${sessionId}.json`);
}

function currentSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function normalizeTask(
	raw: Partial<CollaborationTask>,
	index: number,
): CollaborationTask {
	return {
		id: raw.id ?? `T${index + 1}`,
		type: WORKER_TYPES.includes(raw.type as WorkerType)
			? (raw.type as WorkerType)
			: "worker",
		description: raw.description ?? "",
		paths: raw.paths ?? [],
		dependsOn: raw.dependsOn ?? [],
		status: raw.status ?? "ready",
		agentId: raw.agentId,
		branch: raw.branch,
		result: raw.result,
		error: raw.error,
		assignedTo: raw.assignedTo,
		merged: raw.merged,
	};
}

function loadState(ctx: ExtensionContext): CollaborationState | undefined {
	const file = statePath(currentSessionId(ctx));
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(
			readFileSync(file, "utf8"),
		) as Partial<CollaborationState>;
		return {
			version: VERSION,
			id: raw.id ?? slug(raw.goal ?? "team"),
			goal: raw.goal ?? "",
			cwd: raw.cwd ?? ctx.cwd,
			sessionId: currentSessionId(ctx),
			paused: raw.paused ?? false,
			createdAt: raw.createdAt ?? Date.now(),
			updatedAt: raw.updatedAt ?? Date.now(),
			tasks: (raw.tasks ?? []).map(normalizeTask),
			peers: raw.peers ?? [],
		};
	} catch {
		return undefined;
	}
}

function saveState(state: CollaborationState): void {
	state.updatedAt = Date.now();
	mkdirSync(stateRoot(), { recursive: true });
	const file = statePath(state.sessionId);
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
	renameSync(tmp, file);
}

export function taskReady(
	task: CollaborationTask,
	tasks: CollaborationTask[],
): boolean {
	if (task.status !== "waiting" && task.status !== "ready") return false;
	return task.dependsOn.every(
		(id) =>
			tasks.find((candidate) => candidate.id === id)?.status === "accepted",
	);
}

export function findPathConflict(
	candidate: AddTaskInput,
	tasks: CollaborationTask[],
): string | undefined {
	const normalize = (path: string) =>
		path.replace(/^\.\//, "").replace(/\/$/, "");
	const overlaps = (left: string, right: string) =>
		left === right ||
		left.startsWith(`${right}/`) ||
		right.startsWith(`${left}/`);
	for (const task of tasks) {
		if (FREE_STATUSES.has(task.status)) continue;
		for (const rawOwned of task.paths) {
			const owned = normalize(rawOwned);
			for (const rawCandidate of candidate.paths) {
				const requested = normalize(rawCandidate);
				if (overlaps(owned, requested)) {
					return `${rawCandidate} overlaps ${rawOwned}, owned by ${task.id}`;
				}
			}
		}
	}
	return undefined;
}

export function parseAddArgs(args: string): AddTaskInput {
	const separator = args.search(/\s+--\s+/);
	const head = separator >= 0 ? args.slice(0, separator) : args;
	const description =
		separator >= 0 ? args.slice(separator).replace(/^\s+--\s+/, "") : "";
	const tokens = head.trim().split(/\s+/).filter(Boolean);
	const type = tokens.shift() as WorkerType;
	if (!WORKER_TYPES.includes(type)) {
		throw new Error(`Unknown worker type: ${type || "(missing)"}`);
	}
	const paths: string[] = [];
	const dependsOn: string[] = [];
	for (const token of tokens) {
		if (token.startsWith("--paths=")) {
			paths.push(
				...token
					.slice(8)
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean),
			);
		} else if (token.startsWith("--after=")) {
			dependsOn.push(
				...token
					.slice(8)
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean),
			);
		} else {
			throw new Error(`Unknown option: ${token}`);
		}
	}
	if (!description.trim()) {
		throw new Error("Add a complete worker brief after --");
	}
	return { type, description: description.trim(), paths, dependsOn };
}

export function parseEditorAdd(text: string): AddTaskInput[] {
	const blocks = text
		.split(/\n{2,}/)
		.map((block) =>
			block
				.split("\n")
				.filter((line) => !line.trim().startsWith("#"))
				.join("\n")
				.trim(),
		)
		.filter(Boolean);
	if (blocks.length === 0) throw new Error("Add at least one task");
	return blocks.map(parseAddArgs);
}

export function nextPanePlacement(peerCount: number): {
	newTab: boolean;
	anchorIndex: number;
	direction?: "right" | "down";
} {
	const slot = peerCount % 4;
	if (slot === 0) return { newTab: true, anchorIndex: peerCount };
	if (slot === 1)
		return { newTab: false, anchorIndex: peerCount - 1, direction: "down" };
	if (slot === 2)
		return { newTab: false, anchorIndex: peerCount - 2, direction: "right" };
	return { newTab: false, anchorIndex: peerCount - 2, direction: "right" };
}

export function lintBrief(input: AddTaskInput): string | undefined {
	if (!input.description.trim()) return "Add a complete worker brief";
	if (WRITE_TYPES.has(input.type) && input.paths.length === 0)
		return "Write tasks need --paths=...";
	if (WRITE_TYPES.has(input.type) && !/\d+[.)]/.test(input.description))
		return "Write tasks need numbered steps";
	if (
		STRICT_CHECK_TYPES.has(input.type) &&
		!/\b(test|lint|typecheck|tsc|pytest|check)\b/i.test(input.description)
	) {
		return "Worker/tests/lint tasks need a named check in the brief";
	}
	return undefined;
}

export function parseBranch(
	result?: string,
	explicit?: string,
): string | undefined {
	if (explicit?.trim()) return explicit.trim();
	const match = result?.match(/Changes saved to branch `([^`]+)`/);
	return match?.[1];
}

export function nextAction(state: CollaborationState): string {
	if (state.paused) return "paused";
	if (state.tasks.length === 0) return "add tasks";
	const review = state.tasks.find((task) => task.status === "review");
	if (review) return `accept ${review.id}`;
	const blocked = state.tasks.find(
		(task) => task.status === "failed" || task.status === "rejected",
	);
	if (blocked) return `retry ${blocked.id}`;
	const running = state.tasks.filter((task) => task.status === "running").length;
	if (running > 0) return `${running} working`;
	const ready = state.tasks.find((task) => taskReady(task, state.tasks));
	if (ready) return `run ${ready.id}`;
	if (state.tasks.some((task) => task.status === "waiting"))
		return "waiting on deps";
	if (
		state.tasks.every(
			(task) => task.status === "accepted" || task.status === "dropped",
		)
	) {
		return "finish";
	}
	return "planning";
}

export function statusLabel(state: CollaborationState): string {
	const live = state.tasks.filter((task) => task.status !== "dropped");
	if (live.length === 0) return `collab · ${nextAction(state)}`;
	const accepted = live.filter((task) => task.status === "accepted").length;
	return `collab ${accepted}/${live.length} · ${nextAction(state)}`;
}

function taskMark(status: TaskStatus): string {
	if (status === "accepted") return "✓";
	if (status === "failed" || status === "rejected") return "!";
	if (status === "dropped") return "·";
	if (status === "review") return "?";
	if (status === "running") return "▶";
	return "•";
}

export function widgetLines(state: CollaborationState): string[] {
	const lines = [`next · ${nextAction(state)}`];
	if (state.tasks.length === 0) {
		lines.push("no tasks yet");
		return lines;
	}
	for (const task of state.tasks.slice(0, 8)) {
		lines.push(
			`${taskMark(task.status)} ${task.id} ${task.type} · ${task.status}`,
		);
	}
	return lines;
}

function formatState(state: CollaborationState): string {
	const counts = new Map<string, number>();
	for (const task of state.tasks)
		counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const summary = [
		"running",
		"ready",
		"waiting",
		"review",
		"accepted",
		"rejected",
		"failed",
		"dropped",
	]
		.map((key) => `${counts.get(key) ?? 0} ${key}`)
		.join(" · ");
	const rows = state.tasks.map(
		(task) =>
			`${taskMark(task.status)} ${task.id} ${task.type} — ${task.status} — ${task.description.split("\n")[0]}`,
	);
	return [
		`Collaboration: ${state.goal}`,
		`Next: ${nextAction(state)}`,
		summary,
		...rows,
	].join("\n");
}

export function formatReviewCard(task: CollaborationTask): string {
	const lines = [
		`${task.id} ${task.type} is ready for review. Dependents will not start until you accept.`,
		task.branch ? `Branch: ${task.branch}` : "Branch: none (no worktree changes)",
		task.assignedTo ? `Peer: ${task.assignedTo}` : "",
		"",
		task.result?.trim() || "(no result text)",
		"",
		`Accept with collaborate accept ${task.id} (merges the worktree). Reject or retry to keep the path lock.`,
	];
	return lines.filter((line) => line !== "").join("\n");
}

export function kickoffStart(state: CollaborationState): string {
	return [
		"Collaboration started. You are the orchestrator. The ledger is empty — nothing runs until you add exact worker tasks.",
		"",
		`Goal: ${state.goal}`,
		`Cwd: ${state.cwd}`,
		"",
		"1. Explore only what you cannot already specify (`Agent` explorer for a named search).",
		"2. Split the goal into chores with exclusive paths and complete briefs (numbered steps, exact files, named checks).",
		"3. Call `collaborate add` for each chore (or batch `tasks`), then `collaborate run`. At most 3 run at once.",
		"4. You own planning, non-chore code, review, and integration. Do not dump the whole goal on one worker.",
		"5. A finished worker is status `review`. Read the diff, then `collaborate accept` (merges the worktree) or `reject` / `retry`. Dependents do not start until you accept.",
		"6. `collaborate peer` is only for a visible second lead-tier Herdr session. `assign` sends a ready task's contract to that peer.",
		"7. `collaborate finish` only when every task is accepted or dropped.",
		"",
		"Call `collaborate status` now, then begin.",
	].join("\n");
}

export function kickoffContinue(state: CollaborationState): string {
	return [
		"Collaboration still open. Anything above this line is leftover — the ledger is the record.",
		"",
		`Goal: ${state.goal}`,
		`Next: ${nextAction(state)}`,
		"",
		formatState(state),
		"",
		"A `review` task is not done. Accept (merge), reject, or retry it before dependents run.",
	].join("\n");
}

function systemAppendix(state: CollaborationState): string {
	const taskLine =
		state.tasks.length === 0
			? "none yet"
			: state.tasks
					.map((task) => `${task.id} ${task.type} ${task.status}`)
					.join("; ");
	return [
		"A /collaborate ledger is active. You are the orchestrator.",
		`Goal: ${state.goal}`,
		`Next: ${nextAction(state)}`,
		`Tasks: ${taskLine}`,
		"Use the collaborate tool to add exact worker chores and run them. Do not spawn Agent() for chores that belong on the ledger.",
		"A finished worker is review — read the diff, then accept (merge) or reject/retry. Dependents wait for accept.",
	].join("\n");
}

export function addTasksToState(
	state: CollaborationState,
	inputs: AddTaskInput[],
): CollaborationTask[] {
	if (inputs.length === 0) throw new Error("Add at least one task");
	for (const input of inputs) {
		const lint = lintBrief(input);
		if (lint) throw new Error(lint);
	}
	const imagined = [...state.tasks];
	const created: CollaborationTask[] = [];
	for (const input of inputs) {
		for (const dependency of input.dependsOn) {
			if (!imagined.some((task) => task.id === dependency))
				throw new Error(`Unknown dependency: ${dependency}`);
		}
		const conflict = findPathConflict(input, imagined);
		if (conflict) throw new Error(conflict);
		const waiting =
			input.dependsOn.length > 0 && !taskReady(
				{ ...input, id: "pending", status: "waiting" },
				imagined,
			);
		const task: CollaborationTask = {
			id: `T${imagined.length + 1}`,
			...input,
			status: waiting ? "waiting" : "ready",
		};
		imagined.push(task);
		created.push(task);
	}
	state.tasks.push(...created);
	return created;
}

export function addTaskToState(
	state: CollaborationState,
	input: AddTaskInput,
): CollaborationTask {
	return addTasksToState(state, [input])[0];
}

export function finishBlockers(state: CollaborationState): string[] {
	const blockers: string[] = [];
	for (const task of state.tasks) {
		if (task.status === "dropped" || task.status === "accepted") {
			if (
				task.status === "accepted" &&
				task.paths.length > 0 &&
				task.branch &&
				!task.merged
			) {
				blockers.push(`${task.id} accepted but not merged`);
			}
			continue;
		}
		if (task.status === "running") blockers.push(`${task.id} still running`);
		else if (task.status === "review")
			blockers.push(`${task.id} needs accept`);
		else if (task.status === "failed" || task.status === "rejected")
			blockers.push(`${task.id} is ${task.status} — retry or drop`);
		else blockers.push(`${task.id} not done`);
	}
	return blockers;
}

function workerBrief(
	state: CollaborationState,
	task: CollaborationTask,
): string {
	return [
		`Goal: complete collaboration task ${task.id} for “${state.goal}”.`,
		"",
		"Steps:",
		`1. Work only on this exact task: ${task.description}`,
		task.paths.length > 0
			? `2. Writable paths: ${task.paths.join(", ")}. Treat every other path as read-only.`
			: "2. This is a read-only task. Do not modify files.",
		"3. Run only the targeted checks explicitly named in the task description.",
		"",
		`Inputs: repository ${state.cwd}; dependencies ${task.dependsOn.join(", ") || "none"}.`,
		"Out of scope: no architecture decisions, broad refactors, dependency changes, merges, pushes, or drive-by cleanup.",
		SECURITY_BRIEF,
		"Done criteria: every requested step is complete and every named check passes.",
		"Return under 180 words: files changed, commands with results, branch name, and anything incomplete.",
	].join("\n");
}

function rpc<T>(
	pi: ExtensionAPI,
	channel: string,
	params: Record<string, unknown>,
	timeoutMs = 15_000,
): Promise<T> {
	const requestId = randomUUID();
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`${channel} timed out`));
		}, timeoutMs);
		const off = pi.events.on(`${channel}:reply:${requestId}`, (raw) => {
			clearTimeout(timer);
			off();
			const reply = raw as RpcReply<T>;
			if (reply.success) resolvePromise(reply.data as T);
			else reject(new Error(reply.error ?? `${channel} failed`));
		});
		pi.events.emit(channel, { requestId, ...params });
	});
}

async function resolveWorkerModel(
	pi: ExtensionAPI,
): Promise<string | undefined> {
	try {
		return await rpc<string | undefined>(pi, "worker-model:rpc:resolve", {});
	} catch {
		return undefined;
	}
}

function notify(
	ctx: ExtensionContext,
	text: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(text, type);
}

function requireTask(
	state: CollaborationState,
	id: string | undefined,
): CollaborationTask {
	if (!id?.trim()) throw new Error("Task id required");
	const task = state.tasks.find(
		(candidate) => candidate.id === id.trim().toUpperCase(),
	);
	if (!task) throw new Error(`Unknown task: ${id}`);
	return task;
}

function refreshWaiting(state: CollaborationState): void {
	for (const task of state.tasks) {
		if (task.status === "waiting" && taskReady(task, state.tasks))
			task.status = "ready";
	}
}

async function spawnTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: CollaborationState,
	task: CollaborationTask,
): Promise<void> {
	if (!taskReady(task, state.tasks)) return;
	const model = await resolveWorkerModel(pi);
	const spawned = await rpc<{ id: string }>(pi, "subagents:rpc:spawn", {
		type: task.type,
		prompt: workerBrief(state, task),
		options: {
			description: `${state.id} ${task.id}`,
			name: `${state.id}-${task.id.toLowerCase()}`,
			model,
			isBackground: true,
			isolated: true,
			inheritContext: false,
			isolation: task.paths.length > 0 ? "worktree" : undefined,
			cwd: state.cwd,
		},
	});
	if (!spawned.id) throw new Error("Worker spawn returned no agent id");
	task.status = "running";
	task.agentId = spawned.id;
	task.assignedTo = undefined;
	task.error = undefined;
	saveState(state);
	pi.events.emit("worker-model:track-background", {
		agentId: spawned.id,
		input: {
			subagent_type: task.type,
			prompt: workerBrief(state, task),
			description: `${state.id} ${task.id}`,
			name: `${state.id}-${task.id.toLowerCase()}`,
			model,
			isolated: true,
			inherit_context: false,
			isolation: task.paths.length > 0 ? "worktree" : undefined,
		},
		model: model ?? "",
	});
	notify(ctx, `${task.id} started on ${model ?? "the active model"}`);
}

export function takeReady(
	state: CollaborationState,
	onlyId?: string,
): CollaborationTask[] {
	const ready = state.tasks.filter(
		(task) => (!onlyId || task.id === onlyId) && taskReady(task, state.tasks),
	);
	const running = state.tasks.filter((task) => task.status === "running").length;
	const slots = Math.max(0, MAX_PARALLEL - running);
	return ready.slice(0, slots);
}

async function runReady(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: CollaborationState,
	onlyId?: string,
): Promise<CollaborationTask[]> {
	if (state.paused) throw new Error("Collaboration is paused");
	const chosen = takeReady(state, onlyId);
	if (chosen.length === 0) {
		const running = state.tasks.filter(
			(task) => task.status === "running",
		).length;
		if (running >= MAX_PARALLEL)
			throw new Error(`Parallel cap ${MAX_PARALLEL} reached`);
		throw new Error("No ready tasks");
	}
	await Promise.all(chosen.map((task) => spawnTask(pi, ctx, state, task)));
	return chosen;
}

function parseJson(stdout: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
		return parsed.result ?? {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Herdr returned invalid JSON: ${message}`);
	}
}

async function mergeBranch(
	pi: ExtensionAPI,
	cwd: string,
	branch: string,
): Promise<void> {
	const merged = await pi.exec("git", ["merge", "--no-edit", branch], {
		cwd,
		timeout: 30_000,
	});
	if (merged.killed || merged.code !== 0) {
		throw new Error(
			merged.stderr.trim() || `git merge ${branch} failed (exit ${merged.code})`,
		);
	}
}

async function createPeer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: CollaborationState,
	name: string,
	cwdArg?: string,
): Promise<void> {
	if (process.env.HERDR_ENV !== "1")
		throw new Error("This session is not running inside Herdr");
	if (state.peers.some((peer) => peer.name === name))
		throw new Error(`Peer ${name} already exists`);
	const cwd = resolve(ctx.cwd, cwdArg || ".");
	const placement = nextPanePlacement(state.peers.length);
	let tabId: string;
	let paneId: string;
	if (placement.newTab) {
		const page = Math.floor(state.peers.length / 4) + 1;
		const label = `collab:${state.id}${page > 1 ? `-${page}` : ""}`;
		const created = await pi.exec("herdr", [
			"tab",
			"create",
			"--workspace",
			process.env.HERDR_WORKSPACE_ID || "",
			"--cwd",
			cwd,
			"--label",
			label,
			"--no-focus",
		]);
		if (created.code !== 0)
			throw new Error(created.stderr || "Could not create Herdr team tab");
		const result = parseJson(created.stdout);
		const tab = result.tab as { tab_id?: string } | undefined;
		const pane = result.root_pane as { pane_id?: string } | undefined;
		tabId = tab?.tab_id ?? "";
		paneId = pane?.pane_id ?? "";
	} else {
		const anchor = state.peers[placement.anchorIndex];
		if (!anchor || !placement.direction)
			throw new Error("Invalid Herdr pane placement");
		tabId = anchor.tabId;
		const created = await pi.exec("herdr", [
			"pane",
			"split",
			anchor.paneId,
			"--direction",
			placement.direction,
			"--ratio",
			"0.5",
			"--cwd",
			cwd,
			"--no-focus",
		]);
		if (created.code !== 0)
			throw new Error(created.stderr || "Could not split Herdr team pane");
		const pane = parseJson(created.stdout).pane as
			| { pane_id?: string }
			| undefined;
		paneId = pane?.pane_id ?? "";
	}
	if (!tabId || !paneId) throw new Error("Herdr returned no tab or pane id");
	const started = await pi.exec("herdr", [
		"agent",
		"start",
		name,
		"--kind",
		"pi",
		"--pane",
		paneId,
	]);
	if (started.code !== 0)
		throw new Error(started.stderr || `Could not start ${name}`);
	const aliased = await pi.exec("herdr", [
		"pane",
		"run",
		paneId,
		`/alias ${name}`,
	]);
	if (aliased.code !== 0)
		throw new Error(aliased.stderr || `Could not alias ${name}`);
	const kickoff = [
		`You are the ${name} peer in collaboration “${state.goal}”.`,
		"Use pi-intercom for direct session messages. Wait for an exact task contract from the orchestrator (`collaborate assign`) before editing.",
	].join(" ");
	const prompted = await pi.exec("herdr", ["agent", "prompt", name, kickoff]);
	if (prompted.code !== 0)
		throw new Error(prompted.stderr || `Could not brief ${name}`);
	state.peers.push({ name, cwd, tabId, paneId });
	saveState(state);
	notify(
		ctx,
		`${name} started in ${tabId} (${state.peers.length % 4 || 4}/4 panes)`,
	);
}

async function assignTask(
	pi: ExtensionAPI,
	state: CollaborationState,
	task: CollaborationTask,
	name: string,
): Promise<void> {
	if (process.env.HERDR_ENV !== "1")
		throw new Error("This session is not running inside Herdr");
	const peer = state.peers.find((candidate) => candidate.name === name);
	if (!peer) throw new Error(`Unknown peer: ${name}`);
	if (!taskReady(task, state.tasks))
		throw new Error(`${task.id} is not ready to assign`);
	const running = state.tasks.filter(
		(candidate) => candidate.status === "running",
	).length;
	if (running >= MAX_PARALLEL)
		throw new Error(`Parallel cap ${MAX_PARALLEL} reached`);
	const prompted = await pi.exec("herdr", [
		"agent",
		"prompt",
		name,
		[
			`Exact task contract for ${task.id}.`,
			workerBrief(state, task),
			"You write in the live tree. Stay inside the writable paths. Stop when the named check passes and report back.",
		].join("\n"),
	]);
	if (prompted.code !== 0)
		throw new Error(prompted.stderr || `Could not assign ${task.id} to ${name}`);
	task.status = "running";
	task.assignedTo = name;
	task.error = undefined;
}

async function steerTask(task: CollaborationTask, message: string): Promise<void> {
	if (!message.trim()) throw new Error("steer needs a message");
	if (task.status !== "running") throw new Error(`${task.id} is not running`);
	if (task.assignedTo) {
		throw new Error(
			`${task.id} is on peer ${task.assignedTo} — prompt that pane directly`,
		);
	}
	if (!task.agentId) throw new Error(`${task.id} has no agent id`);
	const manager = (globalThis as Record<symbol, SubagentManager | undefined>)[
		MANAGER_KEY
	];
	const record = manager?.getRecord?.(task.agentId);
	if (!record?.session?.steer) {
		throw new Error(
			`Cannot steer ${task.id} here — use steer_subagent with agent id ${task.agentId}`,
		);
	}
	await record.session.steer(message.trim());
}

class BoardComponent {
	constructor(
		private state: CollaborationState,
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [""];
		const title = th.fg("accent", " Collaborate ");
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) +
					title +
					th.fg("borderMuted", "─".repeat(Math.max(0, width - 16))),
				width,
			),
		);
		lines.push("");
		lines.push(
			truncateToWidth(`  ${th.fg("muted", this.state.goal)}`, width),
		);
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "next")} ${th.fg("accent", nextAction(this.state))}`,
				width,
			),
		);
		lines.push("");
		if (this.state.tasks.length === 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "No tasks yet. The lead will add exact chores.")}`,
					width,
				),
			);
		} else {
			for (const task of this.state.tasks) {
				const mark = th.fg(
					task.status === "accepted"
						? "success"
						: task.status === "failed" || task.status === "rejected"
							? "error"
							: task.status === "review"
								? "warning"
								: "dim",
					taskMark(task.status),
				);
				lines.push(
					truncateToWidth(
						`  ${mark} ${th.fg("accent", task.id)} ${th.fg("muted", task.type)} ${th.fg("dim", task.status)}  ${th.fg("text", task.description.split("\n")[0])}`,
						width,
					),
				);
			}
		}
		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("dim", "accept / reject / retry / run via the collaborate tool · Esc closes")}`,
				width,
			),
		);
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}

function completions(
	prefix: string,
	state?: CollaborationState,
): Completion[] | null {
	const subcommands: Completion[] = [
		{ value: "start", label: "start", description: "Start a collaboration" },
		{ value: "status", label: "status", description: "Show the live board" },
		{ value: "add", label: "add", description: "Add a fully specified worker task" },
		{ value: "run", label: "run", description: "Run ready tasks (cap 3)" },
		{ value: "accept", label: "accept", description: "Accept a review task and merge" },
		{ value: "reject", label: "reject", description: "Reject a review task" },
		{ value: "retry", label: "retry", description: "Retry a failed or rejected task" },
		{ value: "drop", label: "drop", description: "Drop a task and release its paths" },
		{ value: "cancel", label: "cancel", description: "Stop a running task" },
		{ value: "steer", label: "steer", description: "Redirect a running worker" },
		{ value: "assign", label: "assign", description: "Send a ready task to a Herdr peer" },
		{ value: "peer", label: "peer", description: "Open a peer in a Herdr team tab" },
		{ value: "pause", label: "pause", description: "Pause new task starts" },
		{ value: "resume", label: "resume", description: "Allow task starts" },
		{ value: "finish", label: "finish", description: "Close the ledger after accept" },
	];
	const parts = prefix.trimStart().split(/\s+/);
	if (parts.length <= 1) {
		const value = parts[0]?.toLowerCase() ?? "";
		return subcommands.filter((item) => item.value.startsWith(value));
	}
	if (parts[0] === "add" && parts.length === 2) {
		return WORKER_TYPES.filter((type) =>
			type.startsWith(parts[1] as string),
		).map((type) => ({
			value: `add ${type}`,
			label: type,
			description: `Add a ${type} task`,
		}));
	}
	const idCommands = new Set([
		"run",
		"accept",
		"reject",
		"retry",
		"drop",
		"cancel",
		"steer",
		"assign",
	]);
	if (idCommands.has(parts[0]) && parts.length === 2) {
		const ids = ["all", ...(state?.tasks.map((task) => task.id) ?? [])];
		return ids
			.filter((id) => id.toLowerCase().startsWith(parts[1].toLowerCase()))
			.map((id) => ({
				value: `${parts[0]} ${id}`,
				label: id,
				description: id === "all" ? "Every matching task" : "This task",
			}));
	}
	return null;
}

export default function collaborate(pi: ExtensionAPI) {
	let state: CollaborationState | undefined;
	let sessionCtx: ExtensionContext | undefined;

	const send = (ctx: ExtensionContext, text: string) => {
		if (ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!state) {
			ctx.ui.setStatus("collaborate", undefined);
			ctx.ui.setWidget("collaborate", undefined);
			return;
		}
		ctx.ui.setStatus("collaborate", statusLabel(state));
		ctx.ui.setWidget("collaborate", widgetLines(state));
	};

	const toolOk = (action: string, text: string) => ({
		content: [{ type: "text" as const, text }],
		details: { action },
	});

	const toolFail = (action: string, error: string) => ({
		content: [{ type: "text" as const, text: `Error: ${error}` }],
		details: { action, error },
	});

	const persist = (ctx: ExtensionContext) => {
		if (!state) return;
		saveState(state);
		refreshWidget(ctx);
	};

	const showBoard = async (ctx: ExtensionContext) => {
		if (!state) throw new Error("Start with /collaborate start <goal>");
		if (ctx.mode === "tui" && ctx.hasUI) {
			const snapshot = state;
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new BoardComponent(snapshot, theme, () => done());
			});
			return;
		}
		notify(ctx, formatState(state));
	};

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		state = loadState(ctx);
		refreshWidget(ctx);
		if (state && !state.paused && ctx.isIdle()) {
			notify(
				ctx,
				`Collaboration resumed · ${nextAction(state)}`,
				"info",
			);
			send(ctx, kickoffContinue(state));
		} else if (state && ctx.hasUI) {
			notify(ctx, `Collaboration ${state.paused ? "paused" : "open"} · ${nextAction(state)}`);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!state) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${systemAppendix(state)}` };
	});

	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
	});

	const settle = (raw: unknown, failed: boolean) => {
		const event = raw as AgentEvent;
		if (!state || !event.id) return;
		const task = state.tasks.find((candidate) => candidate.agentId === event.id);
		if (!task || task.status !== "running") return;
		void rpc<void>(
			pi,
			"subagents:rpc:consume",
			{ agentId: event.id },
			5_000,
		).catch(() => {});
		task.status = failed ? "failed" : "review";
		task.result = event.result;
		task.error = event.error;
		task.branch = parseBranch(event.result, event.branch);
		if (!failed) {
			const manager = (
				globalThis as Record<symbol, SubagentManager | undefined>
			)[MANAGER_KEY];
			const record = task.agentId
				? manager?.getRecord?.(task.agentId)
				: undefined;
			if (record?.worktreeResult?.branch)
				task.branch = record.worktreeResult.branch;
		}
		saveState(state);
		if (sessionCtx) {
			refreshWidget(sessionCtx);
			notify(
				sessionCtx,
				failed ? `${task.id} failed` : `${task.id} is ready for lead review`,
				failed ? "error" : "warning",
			);
			if (!failed) send(sessionCtx, formatReviewCard(task));
		}
	};

	const offCompleted = pi.events.on("subagents:completed", (raw) =>
		settle(raw, false),
	);
	const offFailed = pi.events.on("subagents:failed", (raw) => settle(raw, true));
	pi.on("session_shutdown", () => {
		offCompleted();
		offFailed();
	});

	const acceptTask = async (task: CollaborationTask): Promise<string> => {
		if (!state) throw new Error("Start with /collaborate start <goal>");
		if (task.status !== "review")
			throw new Error(`${task.id} is ${task.status}, not review`);
		if (task.branch) {
			await mergeBranch(pi, state.cwd, task.branch);
			task.merged = true;
		} else {
			task.merged = true;
		}
		task.status = "accepted";
		refreshWaiting(state);
		return task.branch
			? `${task.id} accepted and merged ${task.branch}`
			: `${task.id} accepted`;
	};

	const rejectTask = (task: CollaborationTask, reason?: string): string => {
		if (task.status !== "review")
			throw new Error(`${task.id} is ${task.status}, not review`);
		task.status = "rejected";
		task.error = reason?.trim() || "rejected by lead";
		return `${task.id} rejected — path lock held. retry or drop.`;
	};

	const retryTask = (task: CollaborationTask): string => {
		if (task.status !== "failed" && task.status !== "rejected")
			throw new Error(`${task.id} is ${task.status}, not failed/rejected`);
		task.status = task.dependsOn.length > 0 ? "waiting" : "ready";
		if (taskReady(task, state?.tasks ?? [])) task.status = "ready";
		task.agentId = undefined;
		task.assignedTo = undefined;
		task.merged = undefined;
		task.error = undefined;
		return `${task.id} ${task.status} — run it again`;
	};

	const dropTask = async (task: CollaborationTask): Promise<string> => {
		if (task.status === "running") {
			if (task.agentId) {
				await rpc<void>(pi, "subagents:rpc:stop", { agentId: task.agentId }).catch(
					() => {},
				);
			}
		}
		task.status = "dropped";
		return `${task.id} dropped — paths released`;
	};

	const cancelTask = async (task: CollaborationTask): Promise<string> => {
		if (task.status !== "running")
			throw new Error(`${task.id} is not running`);
		if (task.agentId) {
			await rpc<void>(pi, "subagents:rpc:stop", { agentId: task.agentId });
		}
		task.status = "failed";
		task.error = "cancelled";
		return `${task.id} cancelled`;
	};

	const finishLedger = (ctx: ExtensionContext): string => {
		if (!state) throw new Error("Start with /collaborate start <goal>");
		const blockers = finishBlockers(state);
		if (blockers.length > 0) throw new Error(blockers.join("; "));
		unlinkSync(statePath(state.sessionId));
		state = undefined;
		refreshWidget(ctx);
		return "Collaboration ledger closed; lead review and integration remain";
	};

	pi.registerTool({
		name: "collaborate",
		label: "Collaborate",
		description:
			"Orchestrate the active /collaborate ledger. Actions: status; add (type+description or tasks[]); run; accept/reject/retry/drop; cancel; steer; assign; peer; pause/resume; finish. Start with /collaborate start. Workers need exact briefs. Dependents wait for accept.",
		promptSnippet:
			"When a /collaborate ledger is active, add exact worker chores, run them, and accept/reject the result. Chat is not the ledger.",
		promptGuidelines: [
			"A collaboration ledger is empty until you add tasks. Nothing runs on start.",
			"Call collaborate add with a complete worker brief, exclusive paths, and named checks. Then collaborate run. Cap is 3.",
			"A finished worker is status review. Read the diff, then accept (merge) or reject/retry. Dependents do not start until you accept.",
			"You own planning, non-chore code, review, and integration. Do not spawn Agent() for chores that belong on the ledger.",
		],
		parameters: CollaborateParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state && params.action !== "status")
				return toolFail(params.action, "Start with /collaborate start <goal>");
			sessionCtx = ctx;
			try {
				if (params.action === "status") {
					if (!state) return toolFail("status", "Start with /collaborate start <goal>");
					return toolOk("status", formatState(state));
				}
				if (!state)
					return toolFail(params.action, "Start with /collaborate start <goal>");
				if (params.action === "add") {
					const inputs: AddTaskInput[] = params.tasks?.length
						? params.tasks.map((item) => ({
								type: item.type,
								description: item.description,
								paths: item.paths ?? [],
								dependsOn: item.dependsOn ?? [],
							}))
						: [
								{
									type: params.type as WorkerType,
									description: params.description ?? "",
									paths: params.paths ?? [],
									dependsOn: params.dependsOn ?? [],
								},
							];
					if (!params.tasks?.length && !params.type)
						return toolFail("add", "add requires type or tasks[]");
					const created = addTasksToState(state, inputs);
					persist(ctx);
					notify(
						ctx,
						created.map((task) => `${task.id} added · ${task.status}`).join(" · "),
					);
					return toolOk(
						"add",
						`${created.map((task) => `${task.id} added · ${task.status}`).join("\n")}\n${formatState(state)}`,
					);
				}
				if (params.action === "run") {
					const onlyId =
						!params.id || params.id === "all"
							? undefined
							: params.id.toUpperCase();
					const started = await runReady(pi, ctx, state, onlyId);
					persist(ctx);
					return toolOk(
						"run",
						`${started.map((task) => task.id).join(", ")} started\n${formatState(state)}`,
					);
				}
				if (params.action === "peer") {
					if (!params.name?.trim())
						return toolFail("peer", "Usage: collaborate peer with name");
					await createPeer(pi, ctx, state, params.name.trim(), params.cwd);
					return toolOk(
						"peer",
						`${params.name} started (${state.peers.length} peer${state.peers.length === 1 ? "" : "s"})`,
					);
				}
				if (params.action === "accept") {
					const message = await acceptTask(requireTask(state, params.id));
					persist(ctx);
					notify(ctx, message);
					return toolOk("accept", `${message}\n${formatState(state)}`);
				}
				if (params.action === "reject") {
					const message = rejectTask(
						requireTask(state, params.id),
						params.message,
					);
					persist(ctx);
					notify(ctx, message, "warning");
					return toolOk("reject", `${message}\n${formatState(state)}`);
				}
				if (params.action === "retry") {
					const message = retryTask(requireTask(state, params.id));
					persist(ctx);
					notify(ctx, message);
					return toolOk("retry", `${message}\n${formatState(state)}`);
				}
				if (params.action === "drop") {
					const message = await dropTask(requireTask(state, params.id));
					persist(ctx);
					notify(ctx, message);
					return toolOk("drop", `${message}\n${formatState(state)}`);
				}
				if (params.action === "cancel") {
					const message = await cancelTask(requireTask(state, params.id));
					persist(ctx);
					notify(ctx, message, "warning");
					return toolOk("cancel", `${message}\n${formatState(state)}`);
				}
				if (params.action === "steer") {
					await steerTask(requireTask(state, params.id), params.message ?? "");
					return toolOk("steer", `${params.id} steered`);
				}
				if (params.action === "assign") {
					if (!params.name?.trim())
						return toolFail("assign", "assign needs a peer name");
					await assignTask(
						pi,
						state,
						requireTask(state, params.id),
						params.name.trim(),
					);
					persist(ctx);
					notify(ctx, `${params.id} assigned to ${params.name}`);
					return toolOk(
						"assign",
						`${params.id} assigned to ${params.name}\n${formatState(state)}`,
					);
				}
				if (params.action === "pause" || params.action === "resume") {
					state.paused = params.action === "pause";
					persist(ctx);
					notify(
						ctx,
						state.paused ? "Collaboration paused" : "Collaboration resumed",
					);
					return toolOk(params.action, state.paused ? "paused" : "resumed");
				}
				if (params.action === "finish") {
					const message = finishLedger(ctx);
					notify(ctx, message);
					return toolOk("finish", message);
				}
				return toolFail(params.action, `Unknown action: ${String(params.action)}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, message, "error");
				return toolFail(params.action, message);
			}
		},
	});

	pi.registerCommand("collaborate", {
		description: "Coordinate cheap workers and visible Herdr peer sessions",
		getArgumentCompletions: (prefix: string) => completions(prefix, state),
		handler: async (args, ctx) => {
			try {
				const raw = args.trim();
				const [sub = "", ...rest] = raw.split(/\s+/);
				const tail = rest.join(" ").trim();
				if (!sub || sub === "status") {
					if (!state) throw new Error("Start with /collaborate start <goal>");
					await showBoard(ctx);
					return;
				}
				if (sub === "start") {
					if (!tail) throw new Error("Usage: /collaborate start <goal>");
					if (state && state.tasks.length > 0 && ctx.hasUI) {
						const okReplace = await ctx.ui.confirm(
							"Replace collaboration?",
							`Active: ${state.goal}\n${state.tasks.length} tasks — the current ledger is overwritten.`,
						);
						if (!okReplace) return;
					}
					state = {
						version: VERSION,
						id: slug(tail),
						goal: tail,
						cwd: ctx.cwd,
						sessionId: currentSessionId(ctx),
						paused: false,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						tasks: [],
						peers: [],
					};
					saveState(state);
					refreshWidget(ctx);
					notify(
						ctx,
						"Collaboration open. Lead is planning — nothing is running yet.",
					);
					send(ctx, kickoffStart(state));
					return;
				}
				if (!state) throw new Error("Start with /collaborate start <goal>");
				if (sub === "add") {
					let inputs: AddTaskInput[];
					if (!tail && ctx.hasUI && ctx.mode === "tui") {
						const edited = await ctx.ui.editor(
							"Add collaboration tasks (save to accept)",
							EDITOR_TEMPLATE,
						);
						if (edited === undefined) {
							notify(ctx, "Add cancelled");
							return;
						}
						inputs = parseEditorAdd(edited);
					} else {
						if (!tail) throw new Error("Usage: /collaborate add <type> --paths=... -- <brief>");
						inputs = [parseAddArgs(tail)];
					}
					const created = addTasksToState(state, inputs);
					persist(ctx);
					notify(
						ctx,
						created.map((task) => `${task.id} added · ${task.status}`).join(" · "),
					);
					return;
				}
				if (sub === "run") {
					await runReady(
						pi,
						ctx,
						state,
						!tail || tail === "all" ? undefined : tail.toUpperCase(),
					);
					persist(ctx);
					return;
				}
				if (sub === "peer") {
					const [name, cwd] = rest;
					if (!name) throw new Error("Usage: /collaborate peer <name> [cwd]");
					await createPeer(pi, ctx, state, name, cwd);
					return;
				}
				if (sub === "accept") {
					notify(ctx, await acceptTask(requireTask(state, rest[0])));
					persist(ctx);
					return;
				}
				if (sub === "reject") {
					notify(
						ctx,
						rejectTask(requireTask(state, rest[0]), rest.slice(1).join(" ")),
						"warning",
					);
					persist(ctx);
					return;
				}
				if (sub === "retry") {
					notify(ctx, retryTask(requireTask(state, rest[0])));
					persist(ctx);
					return;
				}
				if (sub === "drop") {
					notify(ctx, await dropTask(requireTask(state, rest[0])));
					persist(ctx);
					return;
				}
				if (sub === "cancel") {
					notify(ctx, await cancelTask(requireTask(state, rest[0])), "warning");
					persist(ctx);
					return;
				}
				if (sub === "steer") {
					const [id, ...message] = rest;
					await steerTask(requireTask(state, id), message.join(" "));
					notify(ctx, `${id} steered`);
					return;
				}
				if (sub === "assign") {
					const [id, name] = rest;
					if (!name) throw new Error("Usage: /collaborate assign <id> <peer>");
					await assignTask(pi, state, requireTask(state, id), name);
					persist(ctx);
					notify(ctx, `${id} assigned to ${name}`);
					return;
				}
				if (sub === "pause" || sub === "resume") {
					state.paused = sub === "pause";
					persist(ctx);
					notify(
						ctx,
						state.paused ? "Collaboration paused" : "Collaboration resumed",
					);
					return;
				}
				if (sub === "finish") {
					notify(ctx, finishLedger(ctx));
					return;
				}
				throw new Error(`Unknown subcommand: ${sub}`);
			} catch (error) {
				notify(
					ctx,
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
