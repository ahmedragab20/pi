/**
 * Live subagent task registry + shared formatting helpers.
 *
 * Populated from the `task` tool's lifecycle events (tool_execution_start /
 * tool_execution_update / tool_execution_end), rendered by the Task Center
 * overlay and surfaced as a footer status segment. Decoupled from the
 * subagent extension itself — we only observe its events.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;

const EMPTY_USAGE = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

export interface LiveWorker {
	agent: string;
	agentSource: string;
	task: string;
	/** -1 = still running */
	exitCode: number;
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: AnyRecord;
	messages: any[];
	doneAt?: number;
}

export interface LiveTask {
	id: string;
	mode: "single" | "parallel" | "chain";
	agentScope: string;
	label: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	results: LiveWorker[];
}

function workerFrom(agent: string, task: string, r?: AnyRecord): LiveWorker {
	return {
		agent,
		agentSource: r?.agentSource ?? "unknown",
		task,
		exitCode: typeof r?.exitCode === "number" ? r.exitCode : -1,
		stderr: r?.stderr ?? "",
		model: r?.model ?? agentModel(agent),
		stopReason: r?.stopReason,
		errorMessage: r?.errorMessage,
		usage: r?.usage ?? EMPTY_USAGE(),
		messages: Array.isArray(r?.messages) ? r.messages : [],
		doneAt: r?.doneAt,
	};
}

let agentModelCache: Map<string, string> | undefined;

function agentModel(name: string): string | undefined {
	if (!agentModelCache) {
		agentModelCache = new Map();
		try {
			const dir = path.join(getAgentDir(), "agents");
			for (const file of fs.readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const text = fs.readFileSync(path.join(dir, file), "utf8");
				const nameMatch = text.match(/^name:\s*(.+)$/m);
				const modelMatch = text.match(/^model:\s*(.+)$/m);
				if (nameMatch?.[1] && modelMatch?.[1]) {
					agentModelCache.set(nameMatch[1].trim(), modelMatch[1].trim());
				}
			}
		} catch {
			/* agent dir is best-effort */
		}
	}
	return agentModelCache.get(name);
}

function mergeWorker(dst: LiveWorker, r: AnyRecord): void {
	if (!r) return;
	dst.agentSource = r.agentSource ?? dst.agentSource;
	dst.exitCode = typeof r.exitCode === "number" ? r.exitCode : dst.exitCode;
	dst.stderr = r.stderr ?? dst.stderr;
	dst.model = r.model ?? dst.model;
	dst.stopReason = r.stopReason ?? dst.stopReason;
	dst.errorMessage = r.errorMessage ?? dst.errorMessage;
	if (r.usage) dst.usage = r.usage;
	if (Array.isArray(r.messages)) dst.messages = r.messages;
}

class TaskRegistry {
	private tasks = new Map<string, LiveTask>();
	private order: string[] = [];
	private listeners = new Set<() => void>();

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit() {
		for (const fn of this.listeners) fn();
	}

	private touch(id: string) {
		const i = this.order.indexOf(id);
		if (i !== -1) this.order.splice(i, 1);
		this.order.unshift(id);
	}

	start(id: string, args: AnyRecord) {
		const hasChain = Array.isArray(args?.chain) && args.chain.length > 0;
		const hasTasks = Array.isArray(args?.tasks) && args.tasks.length > 0;
		const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const label =
			args?.agent ||
			(hasTasks
				? `parallel ×${args.tasks.length}`
				: hasChain
					? `chain ×${args.chain.length}`
					: "task");

		const results: LiveWorker[] = [];
		if (args?.agent && args?.task) {
			results.push(workerFrom(args.agent, args.task));
		} else if (hasTasks) {
			for (const t of args.tasks) results.push(workerFrom(t.agent, t.task));
		} else if (hasChain) {
			for (const c of args.chain) {
				results.push(
					workerFrom(
						c.agent,
						String(c.task ?? "")
							.replace(/\{previous\}/g, "")
							.trim(),
					),
				);
			}
		}

		this.tasks.set(id, {
			id,
			mode,
			agentScope: args?.agentScope ?? "user",
			label,
			startedAt: Date.now(),
			results,
		});
		this.touch(id);
		this.emit();
	}

	update(id: string, partial: AnyRecord) {
		const task = this.tasks.get(id);
		if (!task) return;
		const results = partial?.details?.results;
		if (Array.isArray(results) && results.length > 0) {
			for (let i = 0; i < results.length; i++) {
				if (i < task.results.length) mergeWorker(task.results[i], results[i]);
				else
					task.results.push(
						workerFrom(
							results[i]?.agent ?? "?",
							results[i]?.task ?? "",
							results[i],
						),
					);
			}
		}
		this.emit();
	}

	finish(id: string, result: AnyRecord, isError: boolean) {
		const task = this.tasks.get(id);
		if (!task) return;
		task.endedAt = Date.now();
		task.isError = isError;
		const results = result?.details?.results;
		if (Array.isArray(results) && results.length > 0) {
			task.results = results.map((r: AnyRecord) => ({
				...workerFrom(r?.agent ?? "?", r?.task ?? "", r),
				doneAt: Date.now(),
			}));
		} else {
			for (const w of task.results) w.doneAt = Date.now();
		}
		this.emit();
	}

	list(): LiveTask[] {
		return this.order
			.map((id) => this.tasks.get(id))
			.filter(Boolean) as LiveTask[];
	}

	activeCount(): number {
		return this.order.reduce(
			(n, id) => (this.tasks.get(id)?.endedAt === undefined ? n + 1 : n),
			0,
		);
	}

	reset() {
		this.tasks.clear();
		this.order = [];
		agentModelCache = undefined;
		this.emit();
	}
}

export const taskRegistry = new TaskRegistry();

export function formatElapsed(startedAt?: number, endedAt?: number): string {
	if (!startedAt) return "";
	const end = endedAt ?? Date.now();
	const s = Math.max(0, Math.floor((end - startedAt) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function fmtTokens(n?: number): string {
	if (!n || n <= 0) return "0";
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	cursor: "Cursor",
	gemini: "Google",
	google: "Google",
	ollama: "Ollama",
	openai: "OpenAI",
	"openai-codex": "OpenAI",
	opencode: "Opencode",
	"opencode-go": "Opencode Go",
};

export function splitModel(model?: string): {
	provider: string;
	id: string;
	full: string;
} {
	const full = (model ?? "").trim();
	if (!full) return { provider: "", id: "", full: "" };
	const i = full.indexOf("/");
	if (i <= 0) return { provider: "", id: full, full };
	return { provider: full.slice(0, i), id: full.slice(i + 1), full };
}

export function formatProviderLabel(provider?: string): string {
	if (!provider) return "";
	return (
		PROVIDER_LABELS[provider] ??
		provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}

/** Status-bar-style usage chips: turns, tokens, cache, context, cost. */
export function formatWorkerUsage(w: LiveWorker | undefined): string[] {
	if (!w) return [];
	const u = w.usage ?? {};
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns}t`);
	if (u.input || u.output)
		parts.push(`↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${fmtTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${fmtTokens(u.cacheWrite)}`);
	if (u.contextTokens) parts.push(`${fmtTokens(u.contextTokens)} ctx`);
	if (typeof u.cost === "number" && u.cost > 0)
		parts.push(`$${Number(u.cost).toFixed(3)}`);
	return parts;
}

const STDERR_NOISE = /No models match pattern "cursor\//;

export function workerStderrLines(stderr?: string): string[] {
	if (!stderr?.trim()) return [];
	return stderr
		.trim()
		.split("\n")
		.filter((line) => !STDERR_NOISE.test(line));
}

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				c && c.type === "text" && typeof c.text === "string" ? c.text : "",
			)
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/** Last non-empty text emitted by a worker — used as a live activity tail. */
export function tailText(messages: any[], maxLen = 320): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = contentText(messages[i]?.content);
		if (text) {
			const flat = text.replace(/\s+/g, " ").trim();
			return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
		}
	}
	return "";
}

function toolArgPreview(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const first =
		args.path ??
		args.filePath ??
		args.command ??
		args.query ??
		args.pattern ??
		args.task;
	if (typeof first !== "string" || !first.trim()) return "";
	const flat = first.replace(/\s+/g, " ").trim();
	return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** Flatten a worker's assistant messages into log lines (text + tool calls). */
export function workerLogLines(messages: any[]): string[] {
	const lines: string[] = [];
	for (const msg of messages) {
		if (msg?.role && msg.role !== "assistant") continue;
		const content = msg?.content;
		if (typeof content === "string") {
			if (content) lines.push(...content.split("\n"));
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				if (part.text) lines.push(...String(part.text).split("\n"));
			} else if (part?.type === "toolCall") {
				const name = part.name ?? "tool";
				const preview = toolArgPreview(part.arguments ?? part.args);
				lines.push(`→ ${name}${preview ? `  ${preview}` : ""}`);
			}
		}
	}
	return lines;
}

/** Plain text for clipboard copy — error/stderr, else the worker log. */
export function workerOutputText(w: LiveWorker): string {
	const log = workerLogLines(w.messages).join("\n").trim();
	const stderr = workerStderrLines(w.stderr).join("\n").trim();
	if (w.errorMessage && !log) return w.errorMessage;
	if (stderr && !log) return stderr;
	const extra = [w.errorMessage, stderr].filter(Boolean);
	if (extra.length && log) return `${log}\n\n${extra.join("\n")}`;
	return log;
}
