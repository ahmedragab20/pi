/**
 * Fullscreen worker session — OpenCode-style child view for subagents.
 *
 * ↑ / Esc → parent (close). ← → cycle sibling workers. j/k / ↓ scroll.
 * Live follow sticks to the bottom while a worker is running.
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
	fmtTokens,
	formatElapsed,
	formatWorkerUsage,
	splitModel,
	taskRegistry,
	toolCode,
	toolCommand,
	toolPath,
	workerOutputText,
	workerStderrLines,
	workerTranscript,
	type LiveWorker,
	type TranscriptItem,
	type WorkerSlot,
} from "./tasks.ts";
import { bottomBorder, fit, fitEnds, midBorder, topBorder } from "./ui.ts";

export type TaskCenterNotify = (
	message: string,
	level?: "info" | "warning" | "error",
) => void;

const CODE_PREVIEW_LINES = 16;
const GUTTER = 4;

export class TaskCenterComponent {
	private selectedId: string | undefined;
	private workerIndex = 0;
	private thoughtOpen = false;
	private detailScroll = 0;
	private followEnd = true;
	private lastViewport = 12;
	/** Content overflowed the body on the last render (drives the scrollbar). */
	private lastOverflow = false;
	private lastMaxScroll = 0;

	constructor(
		private theme: any,
		private onClose: () => void,
		private tui?: TUI,
		private onNotify?: TaskCenterNotify,
	) {}

	handleInput(data: string) {
		const kb = getKeybindings();
		const slots = taskRegistry.listSlots();

		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, "q") ||
			matchesKey(data, Key.up)
		) {
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.cycleSlot(slots, -1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.cycleSlot(slots, 1);
			return;
		}

		if (matchesKey(data, "t") || kb.matches(data, "tui.select.confirm")) {
			this.thoughtOpen = !this.thoughtOpen;
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollDetail(1);
			return;
		}
		if (matchesKey(data, "k")) {
			this.scrollDetail(-1);
			return;
		}
		if (
			kb.matches(data, "tui.select.pageUp") ||
			matchesKey(data, Key.ctrl("u"))
		) {
			this.scrollDetail(-(this.lastViewport - 1 || 8));
			return;
		}
		if (
			kb.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.ctrl("d"))
		) {
			this.scrollDetail(this.lastViewport - 1 || 8);
			return;
		}
		if (matchesKey(data, "g") || matchesKey(data, Key.home)) {
			this.followEnd = false;
			this.detailScroll = 0;
			return;
		}
		if (matchesKey(data, Key.shift("g")) || matchesKey(data, Key.end)) {
			this.followEnd = true;
			return;
		}
		if (matchesKey(data, "f")) {
			this.followEnd = true;
			return;
		}
		if (matchesKey(data, "y")) {
			void this.copySelected();
		}
	}

	/** Mouse/trackpad wheel from pi-tui's alt-screen (patched to forward wheel to focused overlays). */
	handleWheel(direction: number, _x?: number, _y?: number) {
		if (direction === 0) return;
		this.scrollDetail(direction * 3);
	}

	invalidate() {}

	render(width: number): string[] {
		const theme = this.theme;
		const height = this.panelHeight();
		const slots = taskRegistry.listSlots();
		this.clampSelection(slots);
		const slot = this.currentSlot(slots);
		const chrome = 6; // top, header, mid, mid, footer, bottom
		const bodyHeight = Math.max(4, height - chrome);
		this.lastViewport = bodyHeight;

		const lines: string[] = [];
		lines.push(topBorder(theme, width));
		lines.push(this.renderHeader(slot, width));
		lines.push(midBorder(theme, width));
		lines.push(...this.renderBody(slot, width, bodyHeight));
		lines.push(midBorder(theme, width));
		lines.push(this.renderFooter(slot, slots.length, width));
		lines.push(bottomBorder(theme, width));

		while (lines.length < height) lines.push(fit("", width));
		// Paint every cell so parent chrome cannot show through the overlay.
		return lines.slice(0, height).map((line) => this.paint(line, width));
	}

	private paint(line: string, width: number): string {
		const fitted = fit(line, width);
		return typeof this.theme.bg === "function"
			? this.theme.bg("customMessageBg", fitted)
			: fitted;
	}

	private panelHeight(): number {
		const rows = this.tui?.terminal?.rows ?? 24;
		return Math.max(12, rows);
	}

	private currentSlot(slots: WorkerSlot[]): WorkerSlot | undefined {
		return slots.find(
			(s) =>
				s.task.id === this.selectedId && s.workerIndex === this.workerIndex,
		);
	}

	private clampSelection(slots: WorkerSlot[]) {
		if (slots.length === 0) {
			this.selectedId = undefined;
			this.workerIndex = 0;
			return;
		}
		const found = this.currentSlot(slots);
		if (found) return;
		const running = slots.findLast(
			(s) => s.worker?.exitCode === -1 || s.task.endedAt === undefined,
		);
		const pick = running ?? slots[0];
		this.selectedId = pick.task.id;
		this.workerIndex = pick.workerIndex;
		this.followEnd = true;
		this.detailScroll = 0;
	}

	private cycleSlot(slots: WorkerSlot[], delta: number) {
		if (slots.length <= 1) return;
		this.clampSelection(slots);
		const i = slots.findIndex(
			(s) =>
				s.task.id === this.selectedId && s.workerIndex === this.workerIndex,
		);
		const next = slots[(i + delta + slots.length) % slots.length];
		if (!next) return;
		this.selectedId = next.task.id;
		this.workerIndex = next.workerIndex;
		this.followEnd = true;
		this.detailScroll = 0;
		this.thoughtOpen = false;
	}

	private scrollDetail(delta: number) {
		this.followEnd = false;
		this.detailScroll = Math.max(0, this.detailScroll + delta);
	}

	private async copySelected() {
		const slot = this.currentSlot(taskRegistry.listSlots());
		const worker = slot?.worker;
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

	private renderHeader(slot: WorkerSlot | undefined, width: number): string {
		const theme = this.theme;
		if (!slot) {
			return fit(` ${theme.fg("muted", "no workers")}`, width);
		}
		const w = slot.worker;
		const running = !w || w.exitCode === -1;
		const failed = Boolean(w && w.exitCode > 0);
		const icon = running
			? theme.fg("warning", "◐")
			: failed
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const name = theme.bold(theme.fg("toolTitle", w?.agent ?? slot.task.label));
		const parsed = splitModel(w?.model);
		const model = parsed.full
			? theme.fg("dim", ` · ${parsed.full}`)
			: running
				? theme.fg("dim", " · …")
				: "";
		const elapsed = formatElapsed(
			slot.task.startedAt,
			running ? undefined : (w?.doneAt ?? slot.task.endedAt),
		);
		const status = running
			? theme.fg("warning", elapsed ? `running  ${elapsed}` : "running")
			: failed
				? theme.fg(
						"error",
						`exit ${w?.exitCode}${elapsed ? `  ${elapsed}` : ""}`,
					)
				: theme.fg("success", elapsed || "done");
		return fitEnds(` ${icon} ${name}${model}`, ` ${status} `, width);
	}

	private renderFooter(
		slot: WorkerSlot | undefined,
		total: number,
		width: number,
	): string {
		const theme = this.theme;
		const slots = taskRegistry.listSlots();
		const idx = slot
			? slots.findIndex(
					(s) =>
						s.task.id === slot.task.id && s.workerIndex === slot.workerIndex,
				)
			: -1;
		const pos = idx >= 0 ? idx + 1 : 0;
		const label = slot?.worker?.agent ?? slot?.task.label ?? "worker";
		const tokens = this.tokenLabel(slot?.worker);
		const scroll = this.scrollLabel();
		const left = `${theme.bold(label)} ${theme.fg("dim", `(${pos} of ${total})`)}${tokens ? theme.fg("muted", `  ${tokens}`) : ""}${scroll ? theme.fg("muted", `  ${scroll}`) : ""}`;
		const many = total > 1;
		const parent = keycap(theme, "Parent", "↑", true);
		const prev = keycap(theme, "Prev", "←", many);
		const next = keycap(theme, "Next", "→", many);
		const right = `${parent}  ${prev}  ${next}`;
		return fitEnds(` ${left}`, ` ${right} `, width);
	}

	private scrollLabel(): string {
		if (!this.lastOverflow || this.lastMaxScroll <= 0) return "";
		const pct = Math.min(
			100,
			Math.round((this.detailScroll / this.lastMaxScroll) * 100),
		);
		return `▮ ${pct}%`;
	}

	private tokenLabel(w: LiveWorker | undefined): string {
		if (!w?.usage) return "";
		const used =
			(w.usage.input ?? 0) + (w.usage.output ?? 0) + (w.usage.cacheRead ?? 0);
		if (!used) return "";
		const ctx = w.usage.contextTokens ?? 0;
		const pct =
			ctx > 0 ? ` (${Math.min(99, Math.round((used / ctx) * 100))}%)` : "";
		return `${fmtTokens(used)}${pct}`;
	}

	private renderBody(
		slot: WorkerSlot | undefined,
		width: number,
		bodyHeight: number,
	): string[] {
		const theme = this.theme;
		const contentW = Math.max(24, width - 4);
		const raw = slot ? this.buildTranscript(slot, contentW) : this.emptyBody();
		const wrapped: string[] = [];
		for (const line of raw) {
			if (line === "") {
				wrapped.push("");
				continue;
			}
			const chunks = wrapTextWithAnsi(line, contentW);
			if (chunks.length === 0) wrapped.push("");
			else wrapped.push(...chunks);
		}

		const maxScroll = Math.max(0, wrapped.length - bodyHeight);
		if (this.followEnd) this.detailScroll = maxScroll;
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
		if (this.detailScroll >= maxScroll) this.followEnd = true;
		this.lastOverflow = wrapped.length > bodyHeight;
		this.lastMaxScroll = maxScroll;

		const view = wrapped.slice(
			this.detailScroll,
			this.detailScroll + bodyHeight,
		);
		const thumb = this.scrollThumb(this.detailScroll, maxScroll, bodyHeight);
		const lines: string[] = [];
		for (let i = 0; i < bodyHeight; i++) {
			const text = view[i];
			let line =
				text === undefined ? fit("", width - 1) : fit(` ${text}`, width - 1);
			if (thumb) {
				line +=
					i >= thumb.top && i < thumb.top + thumb.height
						? theme.fg("accent", "▐")
						: theme.fg("borderMuted", "╎");
			} else {
				line += " ";
			}
			lines.push(line);
		}
		return lines;
	}

	private scrollThumb(
		scroll: number,
		maxScroll: number,
		bodyHeight: number,
	): { top: number; height: number } | undefined {
		if (maxScroll <= 0 || bodyHeight <= 0) return undefined;
		const height = Math.max(
			1,
			Math.round((bodyHeight * bodyHeight) / (bodyHeight + maxScroll)),
		);
		const top =
			maxScroll > 0
				? Math.round((scroll / maxScroll) * (bodyHeight - height))
				: 0;
		return { top, height };
	}

	private emptyBody(): string[] {
		const theme = this.theme;
		return [
			theme.fg(
				"muted",
				"No workers yet — spawn a task and this view opens live.",
			),
			"",
			theme.fg(
				"dim",
				"↑ / Esc  parent    ← →  siblings    j / ↓  scroll    t  thought    y  copy",
			),
		];
	}

	private buildTranscript(slot: WorkerSlot, width: number): string[] {
		const theme = this.theme;
		const w = slot.worker;
		const running = !w || w.exitCode === -1;
		const failed = Boolean(w && w.exitCode > 0);
		const items = workerTranscript(w?.messages);
		const steps = this.stepsFor(items, running, failed);
		const out: string[] = [];
		const inner = Math.max(16, width - GUTTER);

		this.pushStep(
			out,
			steps,
			0,
			this.quoteBlock(w?.task || slot.task.label, inner),
		);

		items.forEach((item, i) => {
			const n = i + 1;
			if (item.type === "thought") {
				this.pushStep(out, steps, n, this.thoughtBlock(item.text, inner));
				return;
			}
			if (item.type === "tool") {
				this.pushStep(out, steps, n, this.toolBlock(item, inner));
				return;
			}
			this.pushStep(out, steps, n, this.textBlock(item.text, inner));
		});

		if (items.length === 0) {
			out.push("");
			out.push(
				gutterCont(theme) +
					theme.fg("muted", running ? "starting worker…" : "(no output)"),
			);
		}

		if (failed) {
			out.push("");
			const err =
				w?.errorMessage ||
				w?.stopReason ||
				(w ? `exit ${w.exitCode}` : "failed");
			out.push(
				gutterCont(theme) +
					theme.fg("error", `exit ${w?.exitCode ?? 1} · ${err}`),
			);
			for (const line of workerStderrLines(w?.stderr)) {
				out.push(gutterCont(theme) + theme.fg("error", line));
			}
		}

		const usage = formatWorkerUsage(w);
		if (usage.length > 0 || w?.model) {
			out.push("");
			const parsed = splitModel(w?.model);
			const meta = [
				w?.agent ?? slot.task.label,
				parsed.full || undefined,
				...usage,
			].filter(Boolean);
			out.push(gutterBlank() + theme.fg("dim", `■  ${meta.join("  ·  ")}`));
		}

		return out;
	}

	private stepsFor(
		items: TranscriptItem[],
		running: boolean,
		failed: boolean,
	): StepMark[] {
		const count = 1 + items.length;
		return Array.from({ length: Math.max(1, count) }, (_, i) => {
			const last = i === count - 1;
			if (failed && last) return "error";
			if (running && last) return "current";
			return "done";
		});
	}

	private pushStep(
		out: string[],
		marks: StepMark[],
		index: number,
		block: string[],
	) {
		if (block.length === 0) return;
		if (out.length > 0) out.push("");
		const mark = marks[index] ?? "done";
		block.forEach((line, i) => {
			out.push(
				(i === 0
					? gutterNum(this.theme, index + 1, mark)
					: gutterCont(this.theme)) + line,
			);
		});
	}

	private quoteBlock(task: string, width: number): string[] {
		const theme = this.theme;
		const bar = theme.fg("accent", "│ ");
		const raw = task.trim() || "(no task)";
		const lines: string[] = [];
		for (const src of raw.split("\n")) {
			const chunks = wrapTextWithAnsi(src, Math.max(8, width - 2));
			if (chunks.length === 0) lines.push(bar);
			else for (const c of chunks) lines.push(bar + c);
		}
		return lines;
	}

	private thoughtBlock(text: string, width: number): string[] {
		const theme = this.theme;
		const label = this.thoughtOpen ? "− Thought" : "+ Thought";
		const lines = [theme.fg("warning", label)];
		if (this.thoughtOpen) {
			for (const l of text.split("\n")) {
				lines.push(...wrapTextWithAnsi(theme.fg("muted", l), width));
			}
		}
		return lines;
	}

	private textBlock(text: string, width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		for (const l of text.replace(/\s+$/g, "").split("\n")) {
			lines.push(...wrapTextWithAnsi(theme.fg("toolOutput", l), width));
		}
		return lines;
	}

	private toolBlock(
		item: Extract<TranscriptItem, { type: "tool" }>,
		width: number,
	): string[] {
		const theme = this.theme;
		const name = item.name;
		const args = item.args;
		const file = toolPath(args);
		const cmd = toolCommand(args);
		const code = toolCode(args);
		const lines: string[] = [];

		if (name === "bash") {
			const preview = cmd || name;
			lines.push(...wrapTextWithAnsi(theme.fg("muted", `$ ${preview}`), width));
			return lines;
		}
		if (name === "read") {
			lines.push(theme.fg("muted", `# Read ${shortPath(file) || "…"}`));
			return lines;
		}
		if (name === "write" || name === "edit" || code) {
			const title =
				name === "read"
					? `# Read ${shortPath(file)}`
					: `# Wrote ${shortPath(file) || name}`;
			lines.push(theme.fg("muted", title));
			if (code) lines.push(...this.codeLines(code));
			return lines;
		}
		lines.push(
			theme.fg("muted", `→ ${name}${file ? `  ${shortPath(file)}` : ""}`),
		);
		return lines;
	}

	private codeLines(code: string): string[] {
		const theme = this.theme;
		const all = code.replace(/\n$/, "").split("\n");
		const extra = Math.max(0, all.length - CODE_PREVIEW_LINES);
		const slice = all.slice(0, CODE_PREVIEW_LINES);
		const pad = String(slice.length).length;
		const out = slice.map((line, i) => {
			const n = theme.fg("dim", String(i + 1).padStart(pad, " "));
			return ` ${n} ${tintCode(theme, line)}`;
		});
		if (extra > 0) out.push(theme.fg("dim", `    … +${extra} lines`));
		return out;
	}
}

type StepMark = "done" | "current" | "error";

function gutterNum(theme: any, n: number, mark: StepMark): string {
	const label = String(n).padStart(2, " ");
	const painted =
		mark === "current"
			? theme.fg("accent", label)
			: mark === "error"
				? theme.fg("error", label)
				: theme.fg("dim", label);
	return `${painted} `;
}

function gutterCont(theme: any): string {
	return `${theme.fg("dim", "  │")} `;
}

function gutterBlank(): string {
	return " ".repeat(GUTTER);
}

function keycap(theme: any, label: string, key: string, on: boolean): string {
	// Unicode arrows only — never the words up/left/right.
	const text = `${label} ${key}`;
	return on ? theme.fg("text", text) : theme.fg("dim", text);
}

function shortPath(p: string): string {
	if (!p) return "";
	const home = process.env.HOME;
	if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function tintCode(theme: any, line: string): string {
	const t = line.trimStart();
	if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) {
		return theme.fg("dim", line);
	}
	if (/\b(true|false|null)\b/.test(t) && /[{}[\],:]/.test(t)) {
		return theme.fg("accent", line);
	}
	if (t.startsWith('"') || t.startsWith("'") || t.startsWith("`")) {
		return theme.fg("warning", line);
	}
	return theme.fg("toolOutput", line);
}
