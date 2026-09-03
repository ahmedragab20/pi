import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const VERSION = 1;
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

type WorkerType = (typeof WORKER_TYPES)[number];
type TaskStatus = "ready" | "waiting" | "running" | "review" | "failed";

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
};

type CollaborationPeer = {
	name: string;
	cwd: string;
	tabId: string;
	paneId: string;
};

type CollaborationState = {
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
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"collaborations",
	);
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

function taskReady(
	task: CollaborationTask,
	tasks: CollaborationTask[],
): boolean {
	if (task.status !== "waiting" && task.status !== "ready") return false;
	return task.dependsOn.every(
		(id) => tasks.find((candidate) => candidate.id === id)?.status === "review",
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
		if (task.status === "failed") continue;
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

function formatState(state: CollaborationState): string {
	const counts = new Map<string, number>();
	for (const task of state.tasks)
		counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const summary = ["running", "ready", "waiting", "review", "failed"]
		.map((key) => `${counts.get(key) ?? 0} ${key}`)
		.join(" · ");
	const rows = state.tasks.map(
		(task) =>
			`${task.status === "review" ? "✓" : task.status === "failed" ? "!" : "•"} ${task.id} ${task.type} — ${task.description.split("\n")[0]}`,
	);
	return [`Collaboration: ${state.goal}`, summary, ...rows].join("\n");
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

async function runReady(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: CollaborationState,
	onlyId?: string,
): Promise<void> {
	if (state.paused) throw new Error("Collaboration is paused");
	const ready = state.tasks.filter(
		(task) => (!onlyId || task.id === onlyId) && taskReady(task, state.tasks),
	);
	if (ready.length === 0) throw new Error("No ready tasks");
	await Promise.all(ready.map((task) => spawnTask(pi, ctx, state, task)));
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

async function createPeer(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
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
		"Use pi-intercom for direct session messages. Wait for an exact task contract from the orchestrator before editing.",
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

function completions(
	prefix: string,
	state?: CollaborationState,
): Completion[] | null {
	const subcommands: Completion[] = [
		{ value: "start", label: "start", description: "Start a collaboration" },
		{
			value: "status",
			label: "status",
			description: "Show team and task status",
		},
		{
			value: "add",
			label: "add",
			description: "Add a fully specified worker task",
		},
		{ value: "run", label: "run", description: "Run ready tasks" },
		{
			value: "peer",
			label: "peer",
			description: "Open a peer in a balanced Herdr team tab",
		},
		{ value: "pause", label: "pause", description: "Pause new task starts" },
		{ value: "resume", label: "resume", description: "Allow task starts" },
		{
			value: "finish",
			label: "finish",
			description: "Close the collaboration ledger",
		},
	];
	const parts = prefix.trimStart().split(/\s+/);
	if (parts.length <= 1) {
		const value = parts[0]?.toLowerCase() ?? "";
		return subcommands.filter((item) => item.value.startsWith(value));
	}
	if (parts[0] === "add" && parts.length === 2) {
		return WORKER_TYPES.filter((type) => type.startsWith(parts[1] as string)).map(
			(type) => ({
				value: `add ${type}`,
				label: type,
				description: `Add a ${type} task`,
			}),
		);
	}
	if (parts[0] === "run" && parts.length === 2) {
		const ids = ["all", ...(state?.tasks.map((task) => task.id) ?? [])];
		return ids
			.filter((id) => id.toLowerCase().startsWith(parts[1].toLowerCase()))
			.map((id) => ({
				value: `run ${id}`,
				label: id,
				description:
					id === "all" ? "Run every ready task" : "Run this task when ready",
			}));
	}
	return null;
}

export default function collaborate(pi: ExtensionAPI) {
	let state: CollaborationState | undefined;
	let sessionCtx: ExtensionContext | undefined;

	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!state) {
			ctx.ui.setStatus("collaborate", undefined);
			ctx.ui.setWidget("collaborate", undefined);
			return;
		}
		const active = state.tasks.filter((task) => task.status === "running").length;
		const review = state.tasks.filter((task) => task.status === "review").length;
		ctx.ui.setStatus(
			"collaborate",
			`team ${review}/${state.tasks.length}${active ? ` · ${active} working` : ""}`,
		);
		ctx.ui.setWidget(
			"collaborate",
			state.tasks
				.slice(0, 6)
				.map(
					(task) =>
						`${task.status === "review" ? "✓" : task.status === "failed" ? "!" : "•"} ${task.id} ${task.type} · ${task.status}`,
				),
		);
	};

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		state = loadState(ctx);
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
	});

	const settle = (raw: unknown, failed: boolean) => {
		const event = raw as AgentEvent;
		if (!state || !event.id) return;
		const task = state.tasks.find((candidate) => candidate.agentId === event.id);
		if (!task) return;
		void rpc<void>(
			pi,
			"subagents:rpc:consume",
			{ agentId: event.id },
			5_000,
		).catch(() => {});
		task.status = failed ? "failed" : "review";
		task.result = event.result;
		task.error = event.error;
		task.branch = event.branch;
		for (const waiting of state.tasks) {
			if (taskReady(waiting, state.tasks)) waiting.status = "ready";
		}
		saveState(state);
		if (sessionCtx) {
			refreshWidget(sessionCtx);
			notify(
				sessionCtx,
				failed ? `${task.id} failed` : `${task.id} is ready for lead review`,
				failed ? "error" : "info",
			);
			if (!state.paused && !failed)
				void runReady(pi, sessionCtx, state).catch(() => {});
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

	pi.registerCommand("collaborate", {
		description: "Coordinate cheap workers and visible Herdr peer sessions",
		getArgumentCompletions: (prefix: string) => completions(prefix, state),
		handler: async (args, ctx) => {
			try {
				const raw = args.trim();
				const [sub = "status", ...rest] = raw.split(/\s+/);
				const tail = rest.join(" ").trim();
				if (sub === "start") {
					if (!tail) throw new Error("Usage: /collaborate start <goal>");
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
					notify(ctx, `Started collaboration: ${tail}`);
					return;
				}
				if (!state) throw new Error("Start with /collaborate start <goal>");
				if (sub === "status") {
					notify(ctx, formatState(state));
					return;
				}
				if (sub === "add") {
					const input = parseAddArgs(raw.slice(sub.length).trim());
					for (const dependency of input.dependsOn) {
						if (!state.tasks.some((task) => task.id === dependency))
							throw new Error(`Unknown dependency: ${dependency}`);
					}
					const conflict = findPathConflict(input, state.tasks);
					if (conflict) throw new Error(conflict);
					const task: CollaborationTask = {
						id: `T${state.tasks.length + 1}`,
						...input,
						status: input.dependsOn.length > 0 ? "waiting" : "ready",
					};
					state.tasks.push(task);
					saveState(state);
					refreshWidget(ctx);
					notify(ctx, `${task.id} added · ${task.status}`);
					return;
				}
				if (sub === "run") {
					await runReady(
						pi,
						ctx,
						state,
						!tail || tail === "all" ? undefined : tail.toUpperCase(),
					);
					refreshWidget(ctx);
					return;
				}
				if (sub === "peer") {
					const [name, cwd] = rest;
					if (!name) throw new Error("Usage: /collaborate peer <name> [cwd]");
					await createPeer(pi, ctx, state, name, cwd);
					return;
				}
				if (sub === "pause" || sub === "resume") {
					state.paused = sub === "pause";
					saveState(state);
					notify(
						ctx,
						state.paused ? "Collaboration paused" : "Collaboration resumed",
					);
					if (!state.paused) await runReady(pi, ctx, state).catch(() => {});
					return;
				}
				if (sub === "finish") {
					const unfinished = state.tasks.filter((task) => task.status !== "review");
					if (unfinished.length > 0)
						throw new Error(`${unfinished.length} tasks are not ready for review`);
					unlinkSync(statePath(state.sessionId));
					state = undefined;
					refreshWidget(ctx);
					notify(
						ctx,
						"Collaboration ledger closed; lead review and integration remain",
					);
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
