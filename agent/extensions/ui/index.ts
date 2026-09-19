import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { latestCacheHitPercent } from "../compact-footer.ts";
import { ActivityState, elapsedText } from "./activity.ts";
import {
	UI_ACTIVITY, UI_FOOTER, UI_SNAPSHOT_REQUEST, UI_TASKS, UI_TIMING,
	type ActivityUpdate, type FooterSnapshot,
} from "./events.ts";
import { keyLabel, PANEL_OVERLAY, ScrollPanel } from "./panel.ts";
import { singleLine, SPINNER_INTERVAL_MS, statusText, toolHeader } from "./presentation.ts";

const WIDGET = "harness-activity";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export default function unifiedUi(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let state = new ActivityState();
	let footer: FooterSnapshot | undefined;
	let host: TUI | undefined;
	let mounted = false;
	let beat: ReturnType<typeof setInterval> | undefined;
	const subscriptions: (() => void)[] = [];

	const refresh = () => {
		if (!ctx || ctx.mode !== "tui") return;
		const visible = Boolean(state.render(ctx.ui.theme, 120));
		if (visible && !mounted) {
			mounted = true;
			ctx.ui.setWidget(WIDGET, (tui, theme) => {
				host = tui;
				return {
					render: (width) => { const line = state.render(theme, width); return line ? [line] : []; },
					invalidate() {},
				};
			});
		} else if (!visible && mounted) {
			ctx.ui.setWidget(WIDGET, undefined);
			mounted = false;
			host = undefined;
		}
		const ticking = state.needsAnimation;
		if (ticking && !beat) {
			beat = setInterval(() => host?.requestRender(), SPINNER_INTERVAL_MS);
			beat.unref?.();
		} else if (!ticking && beat) {
			clearInterval(beat);
			beat = undefined;
		}
		host?.requestRender();
	};

	const listen = (channel: string, handler: (data: Record<string, unknown>) => void) => {
		subscriptions.push(pi.events.on(channel, (data) => { handler(record(data)); refresh(); }));
	};
	const subscribe = () => {
		listen(UI_TASKS, (data) => {
			if (finite(data.done) && finite(data.total) && data.done <= data.total) {
				state.tasks = { done: data.done, total: data.total, next: typeof data.next === "string" ? data.next : undefined };
			}
		});
		listen(UI_TIMING, (data) => {
			state.timing = {
				startedAt: finite(data.startedAt) ? data.startedAt : undefined,
				lastElapsed: finite(data.lastElapsed) ? data.lastElapsed : undefined,
			};
		});
		listen(UI_FOOTER, (data) => {
			if (typeof data.location === "string" && Array.isArray(data.statuses)) {
				footer = {
					location: data.location,
					branch: typeof data.branch === "string" ? data.branch : undefined,
					git: typeof data.git === "string" ? data.git : undefined,
					statuses: data.statuses.filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string")),
				};
			}
		});
		listen(UI_ACTIVITY, (data) => {
			if (typeof data.id !== "string") return;
			if (data.remove === true) state.external.delete(data.id);
			else if (typeof data.label === "string" && ["queued", "running", "waiting", "success", "error", "cancelled"].includes(String(data.state))) {
				state.external.set(data.id, {
					id: data.id, label: data.label, state: data.state,
					startedAt: finite(data.startedAt) ? data.startedAt : undefined,
				} as Exclude<ActivityUpdate, { remove: true }>);
			}
		});
		listen("subagents:created", (data) => {
			if (typeof data.id === "string" && !state.workers.has(data.id)) state.workers.set(data.id, "queued");
		});
		listen("subagents:started", (data) => {
			if (typeof data.id === "string") state.workers.set(data.id, "running");
		});
		listen("subagents:completed", (data) => { if (typeof data.id === "string") state.workers.delete(data.id); });
		listen("subagents:failed", (data) => {
			if (typeof data.id === "string") { state.workers.delete(data.id); state.workerFailures++; }
		});
		listen("subagents:cancelled", (data) => { if (typeof data.id === "string") state.workers.delete(data.id); });
		listen("herdr:blocked", (data) => {
			if (data.active === true) state.blocked.push(typeof data.label === "string" ? data.label : "Approval needed");
			else if (data.active === false) state.blocked.pop();
		});
	};

	const cleanup = () => {
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		if (beat) clearInterval(beat);
		beat = undefined;
		if (ctx?.mode === "tui") {
			ctx.ui.setWidget(WIDGET, undefined);
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setWorkingIndicator();
		}
		ctx = undefined;
		host = undefined;
		mounted = false;
		footer = undefined;
		state = new ActivityState();
	};

	pi.on("session_start", (event, current) => {
		cleanup();
		if (current.mode !== "tui") return;
		ctx = current;
		state.active = !current.isIdle();
		subscribe();
		// One owner for normal activity; native retry/compaction loaders stay intact.
		current.ui.setWorkingVisible(false);
		current.ui.setWorkingIndicator({ frames: [] });
		if (event.reason === "startup" || event.reason === "new") current.ui.setToolsExpanded(false);
		pi.events.emit(UI_SNAPSHOT_REQUEST, {});
		refresh();
	});
	pi.on("session_shutdown", cleanup);
	pi.on("session_tree", (_event, current) => {
		if (!ctx) return;
		if (current.isIdle()) { state.settle(); state.outcome = undefined; state.toolErrors = 0; }
		pi.events.emit(UI_SNAPSHOT_REQUEST, {});
		refresh();
	});
	pi.on("agent_start", () => { if (ctx) { state.start(); refresh(); } });
	pi.on("agent_settled", (_event, current) => { if (ctx && current.isIdle()) { state.settle(); refresh(); } });
	pi.on("tool_execution_start", (event) => {
		if (ctx) { state.tools.set(event.toolCallId, event.toolName); refresh(); }
	});
	pi.on("tool_execution_end", (event) => {
		if (!ctx) return;
		state.tools.delete(event.toolCallId);
		if (event.isError) state.toolErrors++;
		refresh();
	});
	pi.on("message_end", (event) => {
		if (!ctx || event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted") state.outcome = "cancelled";
		else if (event.message.stopReason === "error") state.outcome = "error";
		else if (event.message.stopReason === "stop") state.outcome = undefined;
		refresh();
	});
	pi.on("ui_prompt_start", (event) => {
		if (ctx) { state.prompts.push({ kind: event.kind, title: event.title }); refresh(); }
	});
	pi.on("ui_prompt_end", () => { if (ctx) { state.prompts.pop(); refresh(); } });

	pi.registerCommand("ui", {
		description: "UI details and controls; /ui preview shows synthetic component examples",
		handler: async (args, current) => {
			const preview = args.trim() === "preview";
			if (args.trim() && !preview) {
				if (current.hasUI) current.ui.notify("Usage: /ui [preview]", "info");
				return;
			}
			if (current.mode !== "tui") {
				if (current.hasUI) current.ui.notify("UI details and preview are available in the terminal UI.", "info");
				return;
			}
			pi.events.emit(UI_SNAPSHOT_REQUEST, {});
			const usage = current.getContextUsage();
			const cache = latestCacheHitPercent(current.sessionManager.getEntries());
			await current.ui.custom<void>((tui, theme, keys, done) => new ScrollPanel({
				title: preview ? "UI preview — synthetic data" : "UI details", tui, theme, keys, onClose: done, animate: preview,
				body: (_width, th) => preview ? [
					th.fg("muted", "Synthetic examples only. No tools or model calls run."), "",
					toolHeader(th, "Read", "sample/long-directory/example.ts"),
					statusText(th, "queued", "Queued"), statusText(th, "running", "Reading file"),
					statusText(th, "waiting", "Waiting for approval"), statusText(th, "success", "Completed"),
					statusText(th, "error", "Command failed — inspect its output"), statusText(th, "cancelled", "Cancelled"),
					th.fg("warning", "Warning: sample context usage is high"), "",
					th.fg("text", "Unicode: 日本語 · café · 👩‍💻 — long content wraps without losing its tail."),
					th.fg("muted", "sample/" + "long-directory/".repeat(8) + "final-file.ts"), "",
					th.fg("dim", "Resize the terminal; use Home/End and page keys to inspect all content."),
				] : [
					toolHeader(th, "Workspace", footer?.location ?? current.cwd),
					`Branch: ${singleLine(footer?.branch ?? "unavailable")}`,
					`Git state: ${footer?.git ?? "unavailable"}`,
					`Model: ${singleLine(current.model ? `${current.model.provider}/${current.model.id}` : "not selected")}`,
					`Context: ${usage?.percent == null ? "unknown" : `${usage.percent.toFixed(1)}% (estimate)`}`,
					`Latest request cache: ${cache === undefined ? "unknown" : `${cache.toFixed(1)}%`}`,
					`Last run: ${state.timing.lastElapsed === undefined ? "not recorded" : elapsedText(state.timing.lastElapsed)}`,
					`Tasks: ${state.tasks.done}/${state.tasks.total}${state.tasks.next ? ` · next: ${singleLine(state.tasks.next)}` : ""}`,
					`Run tool errors: ${state.toolErrors} · worker failures: ${state.workerFailures}`, "",
					th.fg("accent", "Controls"),
					`${keyLabel(keys, "app.tools.expand", "ctrl+o")} expand/collapse tool output`,
					`${keyLabel(keys, "app.thinking.toggle", "ctrl+t")} toggle thinking blocks`,
					`${keyLabel(keys, "app.interrupt", "escape")} interrupt (editor/Vim may handle keys first)`,
					`${keyLabel(keys, "app.message.followUp", "alt+enter")} queue a follow-up`,
					"/todos tasks · /agents workers · /timing elapsed · /ui preview", "",
					th.fg("accent", "Integration statuses"),
					...(footer?.statuses.length ? footer.statuses.map(([key, text]) => `${key}: ${text}`) : ["No reported statuses"]),
				],
			}), PANEL_OVERLAY);
		},
	});
}
