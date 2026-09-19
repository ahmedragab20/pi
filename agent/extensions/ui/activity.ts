import type { ActivityUpdate, RunTiming, TaskProgress } from "./events.ts";
import { fitSegments, singleLine, statusText, type Segment, type UiTheme } from "./presentation.ts";

export function elapsedText(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes >= 60
		? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
		: `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const TOOL_LABELS: Record<string, string> = {
	read: "Reading files", grep: "Searching", find: "Finding files", ls: "Listing files",
	edit: "Editing files", write: "Writing files", bash: "Running command", powershell: "Running command",
	Agent: "Starting worker", agent_browser: "Browser action", ask_user_question: "Question",
};

/** Pure presentation state. It never controls tools, prompts, or the agent loop. */
export class ActivityState {
	active = false;
	outcome: "error" | "cancelled" | undefined;
	toolErrors = 0;
	workerFailures = 0;
	readonly tools = new Map<string, string>();
	readonly workers = new Map<string, "queued" | "running">();
	readonly external = new Map<string, Exclude<ActivityUpdate, { remove: true }>>();
	readonly prompts: { kind: string; title?: string }[] = [];
	readonly blocked: string[] = [];
	tasks: TaskProgress = { done: 0, total: 0 };
	timing: RunTiming = {};

	get needsAnimation(): boolean {
		return this.active || [...this.workers.values()].includes("running") ||
			[...this.external.values()].some((item) => item.state === "running");
	}

	start(): void {
		if (!this.active) {
			this.outcome = undefined;
			this.toolErrors = 0;
			this.workerFailures = 0;
		}
		this.active = true;
	}

	settle(): void {
		this.active = false;
		this.tools.clear();
	}

	render(theme: UiTheme, width: number, now = Date.now()): string {
		const parts: Segment[] = [];
		const add = (text: string, priority: number) => parts.push({ text, priority });
		const prompt = this.prompts.at(-1);
		if (this.blocked.length) add(statusText(theme, "waiting", this.blocked.at(-1) ?? "Approval needed"), 110);
		else if (prompt) add(statusText(theme, prompt.kind === "custom" ? "info" : "waiting", prompt.title || (prompt.kind === "custom" ? "Dialog open" : "Waiting for input")), 110);
		else if (this.active) {
			const firstTool = this.tools.values().next().value;
			const label = firstTool ? TOOL_LABELS[firstTool] ?? `Running ${singleLine(firstTool)}` : "Working";
			add(statusText(theme, "running", label + (this.tools.size > 1 ? ` +${this.tools.size - 1}` : ""), now), 80);
		} else if (this.outcome) add(statusText(theme, this.outcome, this.outcome === "error" ? "Run failed · /ui" : "Cancelled"), 100);
		else if (this.toolErrors) add(statusText(theme, "error", `Run had ${this.toolErrors} tool error${this.toolErrors === 1 ? "" : "s"}`), 100);

		if (this.active && this.timing.startedAt !== undefined) add(theme.fg("dim", elapsedText(now - this.timing.startedAt)), 15);
		for (const item of this.external.values()) {
			add(statusText(theme, item.state, item.label, now), item.state === "error" || item.state === "waiting" ? 105 : 70);
		}
		const running = [...this.workers.values()].filter((state) => state === "running").length;
		const queued = this.workers.size - running;
		if (running) add(statusText(theme, "running", `${running} worker${running === 1 ? "" : "s"} running`, now), 65);
		if (queued) add(statusText(theme, "queued", `${queued} worker${queued === 1 ? "" : "s"} queued`), 60);
		if (this.workerFailures) add(statusText(theme, "error", `${this.workerFailures} worker failure${this.workerFailures === 1 ? "" : "s"} · /agents`), 105);
		if (this.tasks.total) add(theme.fg("muted", `tasks ${this.tasks.done}/${this.tasks.total} · /todos`), 50);
		return fitSegments(parts, width, theme.fg("dim", " · "));
	}
}
