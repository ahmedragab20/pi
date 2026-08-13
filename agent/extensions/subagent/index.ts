/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatAgentList,
	visibleAgents,
} from "./agents.ts";
import {
	TASK_EVENT_END,
	TASK_EVENT_START,
	TASK_EVENT_UPDATE,
	addWorktree,
	capStub,
	isGitRepo,
	isRetryableFailure,
	isWriterAgent,
	jobRegistry,
	packetPathFor,
	pidAlive,
	pruneTmp,
	removeWorktreeIfClean,
	type TaskJob,
	worktreeDiffStat,
	worktreeIsClean,
	writePacket,
} from "./jobs.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	jobId?: string;
	packetPath?: string;
	worktree?: string;
	worktreeWarn?: string;
	retriedWith?: string;
	stub?: string;
}

function pendingResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
): SingleResult {
	const agent = agents.find((a) => a.name === agentName);
	return {
		agent: agentName,
		agentSource: agent?.source ?? "unknown",
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent?.model,
	};
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	background?: boolean;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	if (result.exitCode === -1) return false;
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function isRunningResult(result: SingleResult): boolean {
	return result.exitCode === -1;
}

function formatElapsed(
	startedAt: number | undefined,
	endedAt?: number,
): string {
	if (!startedAt) return "";
	const ms = Math.max(0, (endedAt ?? Date.now()) - startedAt);
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) {
		workers.push(
			(async () => {
				while (true) {
					const current = nextIndex++;
					if (current >= items.length) return;
					results[current] = await fn(items[current], current);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

type RunOpts = {
	modelOverride?: string;
	ignoreAbort?: boolean;
	onPid?: (pid: number) => void;
};

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	opts?: RunOpts,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available =
			visibleAgents(agents)
				.map((a) => `"${a.name}"`)
				.join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	const model = opts?.modelOverride || agent.model;

	// Child pi runs are lean: no extensions (prevents recursion), no skills /
	// prompt-templates (the brief is the whole context), no context files (the
	// lead passes everything in the brief; workers are depth-1, never re-read
	// global lead rules).
	// `--models` overrides settings.json `enabledModels` so workers don't warn
	// about Cursor lead patterns that aren't registered without extensions.
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--models",
		model || "*",
	];
	if (agent.noTools) args.push("--no-tools");
	if (model) args.push("--model", model);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		emitUpdate();
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (proc.pid) opts?.onPid?.(proc.pid);
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start") {
					const name = (event.toolName || event.name || "tool") as string;
					const args = (event.args || {}) as Record<string, unknown>;
					currentResult.messages.push({
						role: "assistant",
						content: [{ type: "toolCall", name, arguments: args }],
					} as Message);
					emitUpdate();
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model)
							currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal && !opts?.ignoreAbort) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

function failureBlob(result: SingleResult): string {
	return [result.stderr, result.errorMessage, getFinalOutput(result.messages)]
		.filter(Boolean)
		.join("\n");
}

function shouldRetry(result: SingleResult): boolean {
	if (result.stopReason === "aborted") return false;
	return isRetryableFailure(failureBlob(result));
}

function packetBody(
	job: TaskJob,
	result: SingleResult,
	diffstat: string,
): string {
	const output = getFinalOutput(result.messages) || "(no output)";
	const lines = [
		`# ${job.jobId}`,
		"",
		`- agent: ${result.agent}`,
		`- model: ${result.model ?? ""}`,
		`- exit: ${result.exitCode}`,
		`- stopReason: ${result.stopReason ?? ""}`,
		`- retriedWith: ${result.retriedWith ?? ""}`,
		`- worktree: ${job.worktree ?? ""}`,
		`- usage: input=${result.usage.input} output=${result.usage.output} cost=${result.usage.cost} turns=${result.usage.turns}`,
		"",
		"## diffstat",
		diffstat || "(none)",
		"",
		"## output",
		output,
	];
	if (result.stderr.trim()) {
		lines.push("", "## stderr", result.stderr.trim());
	}
	return `${lines.join("\n")}\n`;
}

function leadVisible(result: SingleResult): string {
	const parts: string[] = [];
	if (result.packetPath) parts.push(`Packet: ${result.packetPath}`);
	if (result.worktree) parts.push(`Worktree: ${result.worktree}`);
	if (result.worktreeWarn) parts.push(`Warning: ${result.worktreeWarn}`);
	if (result.retriedWith) parts.push(`Retried with: ${result.retriedWith}`);
	parts.push(
		"",
		result.stub || capStub(getFinalOutput(result.messages)) || "(no output)",
	);
	return parts.join("\n");
}

function previousForChain(
	result: SingleResult,
	agent: AgentConfig | undefined,
): string {
	const stub = result.stub || capStub(getFinalOutput(result.messages));
	if (agent?.noTools) return stub;
	if (result.packetPath) return `Packet: ${result.packetPath}\n\n${stub}`;
	return stub;
}

function availableAgentText(agents: AgentConfig[]): string {
	return formatAgentList(agents, 20).text;
}

function shouldUseWorktree(
	agent: AgentConfig | undefined,
	worktreeFlag: boolean | undefined,
	parallelWriterCount: number,
	inGit: boolean,
): boolean {
	if (!inGit || !agent || !isWriterAgent(agent)) return false;
	if (worktreeFlag === true) return true;
	if (worktreeFlag === false) return false;
	return parallelWriterCount >= 2;
}

type JobPublish = (kind: "start" | "update" | "end", job: TaskJob) => void;

type AgentJobSpec = {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	background: boolean;
	useWorktree: boolean;
	repo: string;
	publish: JobPublish;
};

type PreparedJob = {
	job: TaskJob;
	worktree?: string;
	worktreeWarn?: string;
};

function prepareJob(spec: AgentJobSpec): PreparedJob {
	const jobId = crypto.randomUUID();
	let worktree: string | undefined;
	let worktreeWarn: string | undefined;
	if (spec.useWorktree) {
		const dir = addWorktree(jobId, spec.repo);
		if (dir) worktree = dir;
		else worktreeWarn = "worktree add failed; running in session cwd";
	}
	const job = jobRegistry.start({
		jobId,
		agent: spec.agentName,
		task: spec.task,
		packetPath: packetPathFor(jobId),
		worktree,
		status: "running",
		startedAt: Date.now(),
	});
	spec.publish("start", job);
	return { job, worktree, worktreeWarn };
}

function pendingFromJob(
	agents: AgentConfig[],
	spec: AgentJobSpec,
	prepared: PreparedJob,
): SingleResult {
	const pending = pendingResult(agents, spec.agentName, spec.task);
	pending.jobId = prepared.job.jobId;
	pending.packetPath = prepared.job.packetPath;
	pending.worktree = prepared.worktree;
	pending.worktreeWarn = prepared.worktreeWarn;
	return pending;
}

async function executePreparedJob(
	spec: AgentJobSpec,
	prepared: PreparedJob,
): Promise<SingleResult> {
	const { job, worktree, worktreeWarn } = prepared;
	const jobId = job.jobId;
	const agent = spec.agents.find((a) => a.name === spec.agentName);

	const runOpts = (modelOverride?: string): RunOpts => ({
		modelOverride,
		ignoreAbort: spec.background,
		onPid: (pid) => {
			jobRegistry.patch(jobId, { pid });
			const updated = jobRegistry.get(jobId);
			if (updated?.status === "cancelled") {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					/* ignore */
				}
			} else if (updated) {
				spec.publish("update", updated);
			}
		},
	});

	const run = (name: string, modelOverride?: string) =>
		runSingleAgent(
			spec.defaultCwd,
			spec.agents,
			name,
			spec.task,
			worktree ?? spec.cwd,
			spec.step,
			spec.background ? undefined : spec.signal,
			spec.onUpdate,
			spec.makeDetails,
			runOpts(modelOverride),
		);

	let result: SingleResult;
	if (jobRegistry.get(jobId)?.status === "cancelled") {
		result = {
			agent: spec.agentName,
			agentSource: agent?.source ?? "unknown",
			task: spec.task,
			exitCode: 1,
			messages: [],
			stderr: "cancelled",
			usage: emptyUsage(),
			stopReason: "aborted",
			step: spec.step,
		};
	} else
		try {
			result = await run(spec.agentName);
		} catch (err) {
			result = {
				agent: spec.agentName,
				agentSource: agent?.source ?? "unknown",
				task: spec.task,
				exitCode: 1,
				messages: [],
				stderr: err instanceof Error ? err.message : String(err),
				usage: emptyUsage(),
				stopReason: "aborted",
				step: spec.step,
			};
		}

	if (
		shouldRetry(result) &&
		agent &&
		jobRegistry.get(jobId)?.status !== "cancelled"
	) {
		if (
			agent.fallbackModel &&
			agent.fallbackModel !== (result.model || agent.model)
		) {
			result = await run(spec.agentName, agent.fallbackModel);
			result.retriedWith = agent.fallbackModel;
		} else if (
			agent.fallbackAgent &&
			spec.agents.some((a) => a.name === agent.fallbackAgent)
		) {
			result = await run(agent.fallbackAgent);
			result.retriedWith = agent.fallbackAgent;
			result.agent = spec.agentName;
		}
	}

	const cancelled = jobRegistry.get(jobId)?.status === "cancelled";
	if (cancelled) result.stopReason = "aborted";

	result.jobId = jobId;
	result.packetPath = job.packetPath;
	result.worktree = worktree;
	result.worktreeWarn = worktreeWarn;
	result.stub = capStub(
		getFinalOutput(result.messages) ||
			result.errorMessage ||
			result.stderr ||
			"(no output)",
	);

	let diffstat = "";
	if (worktree) {
		diffstat = worktreeDiffStat(worktree);
		if (worktreeIsClean(worktree)) {
			removeWorktreeIfClean(worktree, spec.repo);
			result.worktree = undefined;
		} else {
			result.stub = capStub(
				`${result.stub}\n\nWorktree left dirty: ${worktree}${diffstat ? `\n${diffstat}` : ""}`,
			);
		}
	}

	writePacket(jobId, packetBody(job, result, diffstat));

	const status = cancelled
		? "cancelled"
		: isFailedResult(result)
			? "failed"
			: "done";
	const finished = jobRegistry.patch(jobId, {
		status,
		endedAt: Date.now(),
		stub: result.stub,
		retriedWith: result.retriedWith,
		worktree: result.worktree,
	});
	if (finished) spec.publish("end", finished);
	return result;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return a job id immediately and keep running after Esc. Cancel with /task-cancel. Cannot combine with chain. Default: false.",
			default: false,
		}),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Run writers in a detached git worktree. Auto-on for parallel 2+ writers. Default: false.",
			default: false,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate chores and scoped work to specialized workers with isolated context windows.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Agents: worker, tests, lint, docs, git, memory, explorer, terminal-reader, log-reader, diff-reader, vision.",
			"background: true returns a job id immediately; result arrives as a task-result follow-up. Chain cannot be backgrounded.",
			"Parallel writers auto-use git worktrees; the lead merges. Spawn retries quota/rate-limit/auth once.",
			"Follow the AI Engineering System anti-bloat task contract: one-line deliverable, all inputs upfront,",
			"capped return shape, one task per call, right agent, compact prompt.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const liveLabel =
				params.agent ||
				(params.tasks?.length
					? `parallel ×${params.tasks.length}`
					: params.chain?.length
						? `chain ×${params.chain.length}`
						: "task");
			const liveStarted = Date.now();
			const paintChrome = (msg: string) => {
				if (!ctx.hasUI) return;
				try {
					ctx.ui.setWidget("task", [msg], { placement: "aboveEditor" });
					ctx.ui.setStatus("task", msg);
					ctx.ui.setWorkingMessage(msg);
				} catch {
					/* ignore */
				}
			};
			const clearChrome = () => {
				if (!ctx.hasUI) return;
				try {
					ctx.ui.setWidget("task", undefined);
					ctx.ui.setStatus("task", undefined);
					ctx.ui.setWorkingMessage();
				} catch {
					/* ignore */
				}
			};
			paintChrome(`◐ ${liveLabel} starting`);
			onUpdate?.({
				content: [{ type: "text", text: `(running ${liveLabel})` }],
				details: makeDetails(
					hasChain ? "chain" : hasTasks ? "parallel" : "single",
				)(
					params.agent && params.task
						? [pendingResult(agents, params.agent, params.task)]
						: (params.tasks?.map((t) =>
								pendingResult(agents, t.agent, t.task),
							) ??
								params.chain?.map((c) =>
									pendingResult(agents, c.agent, c.task),
								) ??
								[]),
				),
			});
			const beat = setInterval(() => {
				paintChrome(`◐ ${liveLabel}  ${formatElapsed(liveStarted)}`);
			}, 1000);

			try {
				const background = params.background === true;
				if (background && hasChain) {
					return {
						content: [
							{
								type: "text",
								text: "background cannot be combined with chain.",
							},
						],
						details: makeDetails("chain")([]),
						isError: true,
					};
				}

				if (modeCount !== 1) {
					const available = availableAgentText(agents);
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				if (
					(agentScope === "project" || agentScope === "both") &&
					confirmProjectAgents &&
					ctx.hasUI
				) {
					const requestedAgentNames = new Set<string>();
					if (params.chain)
						for (const step of params.chain)
							requestedAgentNames.add(step.agent);
					if (params.tasks)
						for (const t of params.tasks) requestedAgentNames.add(t.agent);
					if (params.agent) requestedAgentNames.add(params.agent);

					const projectAgentsRequested = Array.from(requestedAgentNames)
						.map((name) => agents.find((a) => a.name === name))
						.filter((a): a is AgentConfig => a?.source === "project");

					if (projectAgentsRequested.length > 0) {
						const names = projectAgentsRequested.map((a) => a.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok)
							return {
								content: [
									{
										type: "text",
										text: "Canceled: project-local agents not approved.",
									},
								],
								details: makeDetails(
									hasChain ? "chain" : hasTasks ? "parallel" : "single",
								)([]),
							};
					}
				}

				const inGit = isGitRepo(ctx.cwd);
				const parallelWriterCount =
					params.tasks && params.tasks.length > 0
						? params.tasks.filter((t) => {
								const a = agents.find((x) => x.name === t.agent);
								return a ? isWriterAgent(a) : false;
							}).length
						: 0;
				const publish: JobPublish = (kind, job) => {
					const name =
						kind === "start"
							? TASK_EVENT_START
							: kind === "end"
								? TASK_EVENT_END
								: TASK_EVENT_UPDATE;
					pi.events.emit(name, job);
					pi.appendEntry("task-job", {
						jobId: job.jobId,
						agent: job.agent,
						pid: job.pid,
						packetPath: job.packetPath,
						worktree: job.worktree,
						status: job.status,
					});
				};
				const deliver = (result: SingleResult) => {
					try {
						const idle = ctx.isIdle();
						pi.sendMessage(
							{
								customType: "task-result",
								content: leadVisible(result),
								display: true,
								details: result,
							},
							{ triggerTurn: idle, deliverAs: "followUp" },
						);
					} catch {
						/* session gone */
					}
				};
				const specFor = (
					agentName: string,
					task: string,
					cwd: string | undefined,
					step: number | undefined,
					jobOnUpdate: OnUpdateCallback | undefined,
					mode: "single" | "parallel" | "chain",
				): AgentJobSpec => ({
					defaultCwd: ctx.cwd,
					agents,
					agentName,
					task,
					cwd,
					step,
					signal,
					onUpdate: jobOnUpdate,
					makeDetails: makeDetails(mode),
					background,
					useWorktree: shouldUseWorktree(
						agents.find((a) => a.name === agentName),
						params.worktree,
						mode === "parallel" ? parallelWriterCount : 0,
						inGit,
					),
					repo: ctx.cwd,
					publish,
				});

				if (params.chain && params.chain.length > 0) {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const taskWithContext = step.task.replace(
							/\{previous\}/g,
							previousOutput,
						);

						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const spec = specFor(
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							chainUpdate,
							"chain",
						);
						const result = await executePreparedJob(spec, prepareJob(spec));
						results.push(result);

						const isError = isFailedResult(result);
						if (isError) {
							return {
								content: [
									{
										type: "text",
										text: `Chain stopped at step ${i + 1} (${step.agent}): ${leadVisible(result)}`,
									},
								],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = previousForChain(
							result,
							agents.find((a) => a.name === step.agent),
						);
					}
					return {
						content: [
							{ type: "text", text: leadVisible(results[results.length - 1]) },
						],
						details: makeDetails("chain")(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS)
						return {
							content: [
								{
									type: "text",
									text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
								},
							],
							details: makeDetails("parallel")([]),
						};

					const allResults: SingleResult[] = new Array(params.tasks.length);
					const prepared: PreparedJob[] = [];

					for (let i = 0; i < params.tasks.length; i++) {
						const t = params.tasks[i];
						const spec = specFor(
							t.agent,
							t.task,
							t.cwd,
							undefined,
							undefined,
							"parallel",
						);
						prepared[i] = prepareJob(spec);
						allResults[i] = pendingFromJob(agents, spec, prepared[i]);
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							const running = allResults.filter(
								(r) => r.exitCode === -1,
							).length;
							const done = allResults.filter((r) => r.exitCode !== -1).length;
							onUpdate({
								content: [
									{
										type: "text",
										text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
									},
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					if (background) {
						for (let i = 0; i < params.tasks.length; i++) {
							const t = params.tasks[i];
							const spec = specFor(
								t.agent,
								t.task,
								t.cwd,
								undefined,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[i] = {
											...allResults[i],
											...partial.details.results[0],
										};
									}
								},
								"parallel",
							);
							void executePreparedJob(spec, prepared[i]).then((result) => {
								allResults[i] = result;
								deliver(result);
							});
						}
						const ids = prepared.map((p) => p.job.jobId);
						return {
							content: [
								{
									type: "text",
									text: `Background jobs: ${ids.join(", ")}. Results arrive as task-result. Cancel with /task-cancel <id>.`,
								},
							],
							details: {
								...makeDetails("parallel")(allResults),
								background: true,
							},
						};
					}

					const results = await mapWithConcurrencyLimit(
						params.tasks,
						MAX_CONCURRENCY,
						async (t, index) => {
							const spec = specFor(
								t.agent,
								t.task,
								t.cwd,
								undefined,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = {
											...allResults[index],
											...partial.details.results[0],
										};
										emitParallelUpdate();
									}
								},
								"parallel",
							);
							const result = await executePreparedJob(spec, prepared[index]);
							allResults[index] = result;
							emitParallelUpdate();
							return result;
						},
					);

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => {
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						return `### [${r.agent}] ${status}\n\n${leadVisible(r)}`;
					});
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results),
					};
				}

				if (params.agent && params.task) {
					const spec = specFor(
						params.agent,
						params.task,
						params.cwd,
						undefined,
						onUpdate,
						"single",
					);
					const prepared = prepareJob(spec);
					if (background) {
						const pending = pendingFromJob(agents, spec, prepared);
						void executePreparedJob(spec, prepared).then(deliver);
						return {
							content: [
								{
									type: "text",
									text: `Background job ${prepared.job.jobId} (${params.agent}). Result arrives as task-result. Cancel with /task-cancel ${prepared.job.jobId}.`,
								},
							],
							details: {
								...makeDetails("single")([pending]),
								background: true,
							},
						};
					}
					const result = await executePreparedJob(spec, prepared);
					const isError = isFailedResult(result);
					if (isError) {
						return {
							content: [
								{
									type: "text",
									text: `Agent ${result.stopReason || "failed"}: ${leadVisible(result)}`,
								},
							],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: leadVisible(result) }],
						details: makeDetails("single")([result]),
					};
				}

				const available = availableAgentText(agents);
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Available agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			} finally {
				clearInterval(beat);
				clearChrome();
			}
		},

		renderCall(args, theme, context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const state = context.state as {
				startedAt?: number;
				interval?: ReturnType<typeof setInterval>;
			};
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
			}
			const live = context.isPartial && context.executionStarted;
			if (live && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			const elapsed = live ? formatElapsed(state.startedAt) : "";
			const runningSuffix = live
				? theme.fg("warning", `  ◐ ${elapsed || "starting"}`)
				: "";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("task ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					runningSuffix;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("task ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					runningSuffix;
				for (const t of args.tasks.slice(0, 3)) {
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("task ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				runningSuffix;
			text += `\n  ${theme.fg("dim", preview)}`;
			const node =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			node.setText(text);
			return node;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			const state = context.state as {
				startedAt?: number;
				endedAt?: number;
				interval?: ReturnType<typeof setInterval>;
			};
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
			}
			const running =
				isPartial || Boolean(details?.results.some((r) => isRunningResult(r)));
			if (running && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!running) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}

			if (!details || details.results.length === 0) {
				const status = running
					? theme.fg(
							"warning",
							`◐ running${formatElapsed(state.startedAt) ? `  ${formatElapsed(state.startedAt)}` : ""}`,
						)
					: theme.fg(
							"muted",
							result.content[0]?.type === "text"
								? result.content[0].text
								: "(no output)",
						);
				const text =
					context.lastComponent instanceof Text
						? context.lastComponent
						: new Text("", 0, 0);
				text.setText(status);
				return text;
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped =
					limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0)
					text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded
							? item.text
							: item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const stillRunning = running || isRunningResult(r);
				const elapsed = formatElapsed(
					state.startedAt,
					stillRunning ? undefined : state.endedAt,
				);
				const icon = stillRunning
					? theme.fg("warning", "◐")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (stillRunning)
						header += ` ${theme.fg("warning", `running${elapsed ? `  ${elapsed}` : ""}`)}`;
					if (isError && r.stopReason)
						header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "─── Output ───"), 0, 0),
					);
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(
							new Text(theme.fg("muted", "(no output)"), 0, 0),
						);
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (stillRunning)
					text += ` ${theme.fg("warning", `running${elapsed ? `  ${elapsed}` : ""}`)}`;
				if (isError && r.stopReason)
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", stillRunning ? "(starting worker...)" : "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(/tasks fullscreen)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter(
					(r) => r.exitCode === 0,
				).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg(
									"accent",
									`${successCount}/${details.results.length} steps`,
								),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage)
							container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(/tasks fullscreen)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage)
							container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(/tasks fullscreen)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	pi.registerMessageRenderer("task-result", (message, _opts, theme) => {
		const result = message.details as SingleResult | undefined;
		const agent = result?.agent ?? "worker";
		const jobId = result?.jobId
			? theme.fg("dim", ` ${result.jobId.slice(0, 8)}`)
			: "";
		const icon =
			result && isFailedResult(result)
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const body =
			typeof message.content === "string"
				? message.content
				: leadVisible(result ?? pendingResult([], agent, ""));
		return new Text(
			`${icon} ${theme.fg("toolTitle", "task-result")} ${theme.fg("accent", agent)}${jobId}\n${theme.fg("toolOutput", body)}`,
			0,
			0,
		);
	});

	pi.registerEntryRenderer("task-job", (entry, _opts, theme) => {
		const data = (entry.data ?? {}) as TaskJob;
		return new Text(
			theme.fg(
				"muted",
				`job ${data.status ?? "?"} ${data.agent ?? ""} ${data.jobId ?? ""}`,
			),
			0,
			0,
		);
	});

	let poller: ReturnType<typeof setInterval> | undefined;
	const syncPoller = () => {
		if (jobRegistry.running().length > 0 && !poller) {
			poller = setInterval(() => jobRegistry.reapDead(), 2000);
		} else if (jobRegistry.running().length === 0 && poller) {
			clearInterval(poller);
			poller = undefined;
		}
	};
	jobRegistry.subscribe(syncPoller);

	pi.on("session_start", (_event, ctx) => {
		pruneTmp(ctx.cwd);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "task-job") continue;
			const data = entry.data as TaskJob | undefined;
			if (!data?.jobId || jobRegistry.get(data.jobId)) continue;
			if (data.status === "running" && pidAlive(data.pid)) {
				jobRegistry.start({ ...data, status: "running" });
			}
		}
		syncPoller();
	});

	pi.on("session_shutdown", () => {
		jobRegistry.cancelAll();
		if (poller) {
			clearInterval(poller);
			poller = undefined;
		}
	});

	pi.registerCommand("task-await", {
		description: "Wait for a background task job (or all running jobs)",
		handler: async (args, ctx) => {
			const id = args.trim() || undefined;
			if (id && !jobRegistry.get(id)) {
				ctx.hasUI && ctx.ui.notify(`Unknown job ${id}`, "error");
				return;
			}
			const done = await jobRegistry.wait(id);
			if (ctx.hasUI) {
				const summary = done
					.map((j) => `${j.jobId.slice(0, 8)} ${j.agent} ${j.status}`)
					.join("\n");
				ctx.ui.notify(summary || "no jobs", "info");
			}
		},
	});

	pi.registerCommand("task-cancel", {
		description: "Cancel a background task job (or all running jobs)",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (id) {
				const ok = jobRegistry.cancel(id);
				if (ctx.hasUI)
					ctx.ui.notify(
						ok ? `Cancelled ${id}` : `Cannot cancel ${id}`,
						ok ? "info" : "error",
					);
				return;
			}
			const n = jobRegistry.running().length;
			jobRegistry.cancelAll();
			if (ctx.hasUI)
				ctx.ui.notify(`Cancelled ${n} job${n === 1 ? "" : "s"}`, "info");
		},
	});
}
