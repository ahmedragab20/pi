/**
 * Background job registry, packets, and git worktrees for the task tool.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export const TASK_EVENT_START = "task:start";
export const TASK_EVENT_UPDATE = "task:update";
export const TASK_EVENT_END = "task:end";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STUB_MAX_BYTES = 2048;
const STUB_MAX_LINES = 40;

const RETRYABLE =
	/quota|rate limit|429|resource has been exhausted|no api key|unknown model/i;

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface TaskJob {
	jobId: string;
	agent: string;
	task: string;
	pid?: number;
	packetPath: string;
	worktree?: string;
	status: JobStatus;
	retriedWith?: string;
	startedAt: number;
	endedAt?: number;
	stub?: string;
}

export function tmpRoot(): string {
	return path.join(getAgentDir(), "tmp");
}

export function packetPathFor(jobId: string): string {
	return path.join(tmpRoot(), "packets", `${jobId}.md`);
}

export function worktreePathFor(jobId: string): string {
	return path.join(tmpRoot(), "worktrees", jobId);
}

export function pidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function isWriterAgent(agent: AgentConfig): boolean {
	if (agent.noTools) return false;
	const tools = agent.tools ?? [];
	return tools.includes("edit") || tools.includes("write");
}

export function isGitRepo(cwd: string): boolean {
	const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		encoding: "utf8",
	});
	return r.status === 0 && r.stdout.trim() === "true";
}

export function isRetryableFailure(blob: string): boolean {
	return RETRYABLE.test(blob);
}

export function addWorktree(jobId: string, repo: string): string | undefined {
	const dir = worktreePathFor(jobId);
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const r = spawnSync("git", ["worktree", "add", "--detach", dir, "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	});
	if (r.status !== 0) return undefined;
	return dir;
}

export function worktreeDiffStat(worktree: string): string {
	const r = spawnSync("git", ["diff", "--stat"], {
		cwd: worktree,
		encoding: "utf8",
	});
	return (r.stdout || "").trim();
}

export function worktreeIsClean(worktree: string): boolean {
	const r = spawnSync("git", ["status", "--porcelain"], {
		cwd: worktree,
		encoding: "utf8",
	});
	return r.status === 0 && r.stdout.trim() === "";
}

export function removeWorktreeIfClean(worktree: string, repo: string): boolean {
	if (!worktreeIsClean(worktree)) return false;
	spawnSync("git", ["worktree", "remove", "--force", worktree], {
		cwd: repo,
		encoding: "utf8",
	});
	return true;
}

function pruneDir(dir: string, onOld: (full: string, st: fs.Stats) => void): void {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		const full = path.join(dir, name);
		try {
			const st = fs.statSync(full);
			if (now - st.mtimeMs > TTL_MS) onOld(full, st);
		} catch {
			/* skip */
		}
	}
}

export function pruneTmp(repo?: string): void {
	pruneDir(path.join(tmpRoot(), "packets"), (full) => {
		try {
			fs.unlinkSync(full);
		} catch {
			/* skip */
		}
	});
	pruneDir(path.join(tmpRoot(), "worktrees"), (full) => {
		if (repo) removeWorktreeIfClean(full, repo);
	});
}

export function capStub(text: string): string {
	const lines = text.split("\n").slice(0, STUB_MAX_LINES).join("\n");
	if (Buffer.byteLength(lines, "utf8") <= STUB_MAX_BYTES) return lines;
	let out = lines;
	while (Buffer.byteLength(out, "utf8") > STUB_MAX_BYTES) {
		out = out.slice(0, -1);
	}
	return out;
}

export function writePacket(jobId: string, body: string): string {
	const file = packetPathFor(jobId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body, "utf8");
	return file;
}

export class JobRegistry {
	private jobs = new Map<string, TaskJob>();
	private waiters = new Set<(job: TaskJob) => void>();

	list(): TaskJob[] {
		return [...this.jobs.values()];
	}

	get(id: string): TaskJob | undefined {
		return this.jobs.get(id);
	}

	running(): TaskJob[] {
		return this.list().filter((j) => j.status === "running");
	}

	start(job: TaskJob): TaskJob {
		this.jobs.set(job.jobId, job);
		this.emit(job);
		return job;
	}

	patch(id: string, patch: Partial<TaskJob>): TaskJob | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		Object.assign(job, patch);
		this.emit(job);
		return job;
	}

	subscribe(fn: (job: TaskJob) => void): () => void {
		this.waiters.add(fn);
		return () => this.waiters.delete(fn);
	}

	private emit(job: TaskJob) {
		for (const fn of this.waiters) fn(job);
	}

	wait(id?: string): Promise<TaskJob[]> {
		const done = () => {
			if (id) {
				const job = this.jobs.get(id);
				return job && job.status !== "running" ? [job] : null;
			}
			const running = this.running();
			return running.length === 0 ? this.list() : null;
		};
		const already = done();
		if (already) return Promise.resolve(already);
		return new Promise((resolve) => {
			const off = this.subscribe(() => {
				const ready = done();
				if (ready) {
					off();
					resolve(ready);
				}
			});
		});
	}

	cancel(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job || job.status !== "running") return false;
		if (job.pid && pidAlive(job.pid)) {
			try {
				process.kill(job.pid, "SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				if (job.pid && pidAlive(job.pid)) {
					try {
						process.kill(job.pid, "SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}, 5000);
		}
		job.status = "cancelled";
		job.endedAt = Date.now();
		this.emit(job);
		return true;
	}

	cancelAll(): void {
		for (const job of this.running()) this.cancel(job.jobId);
	}

	reapDead(): void {
		for (const job of this.running()) {
			if (job.pid && !pidAlive(job.pid)) {
				job.status = "failed";
				job.endedAt = Date.now();
				this.emit(job);
			}
		}
	}
}

export const jobRegistry = new JobRegistry();
