/**
 * Task Center — navigable overlay for live + recent subagent workers.
 *
 * Split pane: task list on top, selected worker detail below.
 * Keys: ↑↓/jk move · tab worker · enter expand · pgup/pgdn scroll · y copy · r running · esc/q close
 */
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	Key,
	matchesKey,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	formatElapsed,
	formatProviderLabel,
	formatWorkerUsage,
	splitModel,
	taskRegistry,
	workerLogLines,
	workerOutputText,
	workerStderrLines,
	type LiveTask,
	type LiveWorker,
} from "./tasks.ts";
import { bottomBorder, fit, labeledMidBorder, midBorder, topBorder } from "./ui.ts";

export type TaskCenterNotify = (
	message: string,
	level?: "info" | "warning" | "error",
) => void;

export class TaskCenterComponent {
	private selectedId: string | undefined;
	private workerIndex = 0;
	private filter: "all" | "running" = "all";
	private expanded = false;
	private detailScroll = 0;
	private followEnd = true;
	private lastDetailViewport = 8;

	constructor(
		private theme: any,
		private onClose: () => void,
		private tui?: TUI,
		private onNotify?: TaskCenterNotify,
	) {}

	handleInput(data: string) {
		const kb = getKeybindings();
		const tasks = this.visibleTasks();

		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}

		if (matchesKey(data, "k") && this.expanded) {
			this.scrollDetail(-1);
			return;
		}
		if (matchesKey(data, "j") && this.expanded) {
			this.scrollDetail(1);
			return;
		}
		if (kb.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.moveSelection(tasks, -1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.moveSelection(tasks, 1);
			return;
		}
		if (matchesKey(data, "g") || matchesKey(data, Key.home)) {
			if (this.expanded) {
				this.followEnd = false;
				this.detailScroll = 0;
			} else {
				this.selectAt(tasks, 0);
			}
			return;
		}
		if (matchesKey(data, Key.shift("g")) || matchesKey(data, Key.end)) {
			if (this.expanded) this.followEnd = true;
			else this.selectAt(tasks, tasks.length - 1);
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.cycleWorker(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.cycleWorker(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.cycleWorker(1);
			return;
		}

		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.space)) {
			this.expanded = !this.expanded;
			if (this.expanded) {
				const task = tasks.find((t) => t.id === this.selectedId);
				const running = task?.endedAt === undefined;
				this.followEnd = Boolean(running);
				if (!running) this.detailScroll = 0;
			}
			return;
		}

		if (
			kb.matches(data, "tui.select.pageUp") ||
			matchesKey(data, Key.ctrl("u"))
		) {
			this.scrollDetail(-(this.lastDetailViewport - 1 || 8));
			return;
		}
		if (
			kb.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.ctrl("d"))
		) {
			this.scrollDetail(this.lastDetailViewport - 1 || 8);
			return;
		}
		if (matchesKey(data, Key.ctrl("b"))) {
			this.scrollDetail(-1);
			return;
		}
		if (matchesKey(data, Key.ctrl("f"))) {
			this.scrollDetail(1);
			return;
		}
		if (matchesKey(data, "f")) {
			this.followEnd = true;
			this.detailScroll = 0;
			return;
		}

		if (matchesKey(data, "r")) {
			this.filter = this.filter === "all" ? "running" : "all";
			this.clampSelection();
			return;
		}

		if (matchesKey(data, "y")) {
			void this.copySelected();
		}
	}

	invalidate() {}

	render(width: number): string[] {
		const theme = this.theme;
		const height = this.panelHeight();
		const all = taskRegistry.list();
		const tasks = this.visibleTasks();
		this.clampSelection();
		const selected = tasks.find((t) => t.id === this.selectedId);
		const running = all.filter((t) => t.endedAt === undefined).length;
		const done = all.filter((t) => t.endedAt !== undefined).length;

		const chrome = 10; // top, title, 2 mids, 3 meta, output rule, bottom, hints
		const remaining = Math.max(6, height - chrome);
		const listCap = this.expanded
			? Math.max(2, Math.floor(remaining * 0.25))
			: Math.max(3, Math.floor(remaining * 0.4));
		const listHeight = Math.min(Math.max(tasks.length, 1), listCap);
		const detailBody = Math.max(3, remaining - listHeight);
		this.lastDetailViewport = detailBody;

		const lines: string[] = [];
		lines.push(topBorder(theme, width));

		const live = running > 0;
		const dot = live
			? theme.fg("warning", "●")
			: theme.fg("success", "●");
		const filterHint =
			this.filter === "running" ? theme.fg("warning", "  running") : "";
		const expandHint = this.expanded ? theme.fg("dim", "  expanded") : "";
		const pos =
			tasks.length > 0
				? theme.fg("dim", `  ${this.selectedIndex(tasks) + 1}/${tasks.length}`)
				: "";
		lines.push(
			fit(
				` ${dot} ${theme.bold(theme.fg("accent", "Tasks"))}   ${theme.fg("muted", `${running} running · ${done} done`)}${pos}${filterHint}${expandHint}`,
				width,
			),
		);
		lines.push(midBorder(theme, width));

		if (tasks.length === 0) {
			const empty =
				this.filter === "running"
					? "No running tasks."
					: "No tasks yet — worker runs appear here live.";
			lines.push(fit(` ${theme.fg("muted", empty)}`, width));
			for (let i = 1; i < listHeight; i++) lines.push(fit("", width));
		} else {
			const { slice, offset } = windowed(
				tasks,
				this.selectedIndex(tasks),
				listHeight,
			);
			for (let i = 0; i < listHeight; i++) {
				const task = slice[i];
				if (!task) {
					lines.push(fit("", width));
					continue;
				}
				lines.push(
					this.renderTaskRow(
						task,
						offset + i === this.selectedIndex(tasks),
						width,
					),
				);
			}
		}

		const workerExtra = selected
			? selected.results.length > 1
				? `${this.workerIndex + 1}/${selected.results.length}`
				: selected.endedAt === undefined
					? "live"
					: "done"
			: "";
		lines.push(labeledMidBorder(theme, width, "worker", workerExtra));
		lines.push(...this.renderDetail(selected, width, detailBody));
		lines.push(bottomBorder(theme, width));
		lines.push(
			fit(
				` ${theme.fg("dim", this.expanded ? "↑↓ list  jk scroll  tab worker  enter  y copy  r  f follow  esc" : "jk/↑↓  tab worker  enter expand  pgup/dn  y copy  r running  esc")}`,
				width,
			),
		);

		while (lines.length < height) lines.push(fit("", width));
		return lines.slice(0, height);
	}

	private panelHeight(): number {
		const rows = this.tui?.terminal?.rows ?? 24;
		return Math.max(14, Math.min(Math.floor(rows * 0.85), rows - 2));
	}

	private visibleTasks(): LiveTask[] {
		const all = taskRegistry.list();
		return this.filter === "running"
			? all.filter((t) => t.endedAt === undefined)
			: all;
	}

	private selectedIndex(tasks: LiveTask[]): number {
		const i = tasks.findIndex((t) => t.id === this.selectedId);
		return i < 0 ? 0 : i;
	}

	private clampSelection() {
		const tasks = this.visibleTasks();
		if (tasks.length === 0) {
			this.selectedId = undefined;
			this.workerIndex = 0;
			return;
		}
		if (!this.selectedId || !tasks.some((t) => t.id === this.selectedId)) {
			this.selectedId = tasks[0].id;
			this.workerIndex = 0;
			this.followEnd = true;
			this.detailScroll = 0;
		}
		const task = tasks.find((t) => t.id === this.selectedId);
		const n = task?.results.length ?? 0;
		if (n === 0) this.workerIndex = 0;
		else if (this.workerIndex >= n) this.workerIndex = n - 1;
		else if (this.workerIndex < 0) this.workerIndex = 0;
	}

	private moveSelection(tasks: LiveTask[], delta: number) {
		if (tasks.length === 0) return;
		const next = (this.selectedIndex(tasks) + delta + tasks.length) % tasks.length;
		this.selectAt(tasks, next);
	}

	private selectAt(tasks: LiveTask[], index: number) {
		if (tasks.length === 0) return;
		const i = Math.max(0, Math.min(index, tasks.length - 1));
		const id = tasks[i].id;
		if (id !== this.selectedId) {
			this.selectedId = id;
			this.workerIndex = 0;
			this.followEnd = true;
			this.detailScroll = 0;
		}
	}

	private cycleWorker(delta: number) {
		const task = this.visibleTasks().find((t) => t.id === this.selectedId);
		const n = task?.results.length ?? 0;
		if (n <= 1) return;
		this.workerIndex = (this.workerIndex + delta + n) % n;
		this.followEnd = true;
		this.detailScroll = 0;
	}

	private scrollDetail(delta: number) {
		this.followEnd = false;
		this.detailScroll = Math.max(0, this.detailScroll + delta);
	}

	private async copySelected() {
		const task = this.visibleTasks().find((t) => t.id === this.selectedId);
		const worker = task?.results[this.workerIndex];
		if (!worker) {
			this.onNotify?.("Nothing to copy", "warning");
			return;
		}
		const text = workerOutputText(worker);
		if (!text.trim()) {
			this.onNotify?.("Worker has no output yet", "warning");
			return;
		}
		try {
			await copyToClipboard(text);
			this.onNotify?.("Copied worker output", "info");
		} catch (err) {
			this.onNotify?.(
				`Copy failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	private renderTaskRow(task: LiveTask, selected: boolean, width: number): string {
		const theme = this.theme;
		const running = task.endedAt === undefined;
		const icon = running
			? theme.fg("warning", "◐")
			: task.isError
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const elapsed = formatElapsed(task.startedAt, task.endedAt);
		const caret = selected ? theme.fg("accent", "→") : " ";
		const workers =
			task.results.length > 1
				? theme.fg("dim", ` ×${task.results.length}`)
				: "";
		const agentHint =
			task.mode === "single"
				? ""
				: taskAgentHint(task, selected ? this.workerIndex : 0);
		const brief = taskBrief(task);
		const row = ` ${caret} ${icon} ${theme.fg("toolTitle", theme.bold(task.label))}${workers}${agentHint ? `  ${theme.fg("accent", agentHint)}` : ""}  ${theme.fg("muted", elapsed)}  ${theme.fg("dim", brief)}`;
		const line = fit(row, width);
		if (!selected) return line;
		try {
			return theme.bg("selectedBg", line);
		} catch {
			return line;
		}
	}

	private renderDetail(
		task: LiveTask | undefined,
		width: number,
		bodyHeight: number,
	): string[] {
		const theme = this.theme;
		if (!task) {
			const lines = [
				fit(` ${theme.fg("muted", "Select a task to inspect its worker.")}`, width),
			];
			while (lines.length < bodyHeight + 4) lines.push(fit("", width));
			return lines.slice(0, bodyHeight + 4);
		}

		const workers = task.results;
		const w = workers[this.workerIndex] ?? workers[0];
		const running = !w || w.exitCode === -1;
		const wIcon = !w
			? theme.fg("muted", "·")
			: running
				? theme.fg("warning", "◐")
				: w.exitCode === 0
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
		const elapsed = formatElapsed(task.startedAt, running ? undefined : task.endedAt);
		const workerLabel = w?.agent ?? task.label;
		const pager =
			workers.length > 1
				? theme.fg("accent", `${this.workerIndex + 1}/${workers.length}`)
				: "";
		const status = running
			? theme.fg("warning", "running")
			: w?.exitCode === 0
				? theme.fg("success", "done")
				: theme.fg("error", w?.stopReason || "failed");

		const parsed = splitModel(w?.model);
		const provider = formatProviderLabel(parsed.provider);
		const modelLabel = parsed.full
			? theme.fg("text", parsed.full)
			: running
				? theme.fg("dim", "resolving…")
				: theme.fg("dim", "—");

		const usageParts = formatWorkerUsage(w);
		const metaBits = [
			provider,
			elapsed,
			...usageParts,
			task.agentScope,
			w?.agentSource && w.agentSource !== "unknown" ? w.agentSource : "",
			task.mode !== "single" ? task.mode : "",
		].filter(Boolean);

		const log = this.detailLog(w);
		const inner = Math.max(8, width - 4);
		const wrapped: string[] = [];
		for (const raw of log) {
			if (!raw) {
				wrapped.push("");
				continue;
			}
			const chunks = wrapTextWithAnsi(raw, inner);
			if (chunks.length === 0) wrapped.push("");
			else wrapped.push(...chunks);
		}

		const maxScroll = Math.max(0, wrapped.length - bodyHeight);
		if (this.followEnd) this.detailScroll = maxScroll;
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
		if (this.detailScroll >= maxScroll) this.followEnd = true;

		const view = wrapped.slice(this.detailScroll, this.detailScroll + bodyHeight);
		const above = this.detailScroll;
		const below = Math.max(0, wrapped.length - this.detailScroll - bodyHeight);
		const scrollHint = wrapped.length > bodyHeight
			? `${above > 0 ? `↑${above}` : ""}${above && below ? " " : ""}${below > 0 ? `↓${below}` : this.followEnd ? "live" : ""}`.trim()
			: running
				? "live"
				: "";

		const header = fit(
			` ${wIcon} ${theme.fg("toolTitle", theme.bold(workerLabel))}  ${status}${pager ? `  ${pager}` : ""}`,
			width,
		);
		const modelRow = fit(
			` ${this.metaKey("model")} ${modelLabel}`,
			width,
		);
		const usageRow = fit(
			` ${this.metaKey("meta")} ${theme.fg("muted", metaBits.join("  ·  ") || "—")}`,
			width,
		);
		const outputRule = labeledMidBorder(theme, width, "output", scrollHint);

		const lines = [header, modelRow, usageRow, outputRule];
		for (let i = 0; i < bodyHeight; i++) {
			const text = view[i];
			if (text === undefined) {
				lines.push(fit("", width));
				continue;
			}
			const color =
				text.startsWith("→ ")
					? "accent"
					: text.startsWith("Error:") || text.startsWith("✗")
						? "error"
						: text.startsWith("Warning:")
							? "warning"
							: "toolOutput";
			lines.push(fit(`  ${theme.fg(color, text)}`, width));
		}
		return lines;
	}

	private metaKey(label: string): string {
		return this.theme.fg("dim", label.padEnd(5));
	}

	private detailLog(w: LiveWorker | undefined): string[] {
		if (!w) return ["(no worker yet)"];
		const lines = workerLogLines(w.messages);
		if (w.errorMessage) lines.push(`Error: ${w.errorMessage}`);
		for (const s of workerStderrLines(w.stderr)) lines.push(s);
		if (lines.length === 0) {
			if (w.exitCode === -1) return ["starting…"];
			return ["(no output)"];
		}
		return lines;
	}
}

function taskBrief(task: LiveTask): string {
	const first = task.results[0]?.task ?? "";
	const flat = first.replace(/\s+/g, " ").trim();
	if (!flat) return task.mode === "single" ? "" : task.mode;
	return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

function taskAgentHint(task: LiveTask, workerIndex: number): string {
	const names = task.results.map((r) => r.agent).filter(Boolean);
	if (names.length === 0) return "";
	const i = Math.max(0, Math.min(workerIndex, names.length - 1));
	return names[i] ?? "";
}

function windowed<T>(
	items: T[],
	selected: number,
	size: number,
): { slice: T[]; offset: number } {
	if (items.length <= size) return { slice: items, offset: 0 };
	let offset = selected - Math.floor((size - 1) / 2);
	offset = Math.max(0, Math.min(offset, items.length - size));
	return { slice: items.slice(offset, offset + size), offset };
}
