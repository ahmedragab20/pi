/**
 * harness-ux — navigation + live subagent visibility for the pi TUI.
 *
 * - /tasks   → fullscreen worker session (↑/Esc parent, ←→ siblings)
 * - /palette → fuzzy command palette (sessions, actions, models, message jump)
 * - footer   → live "◐ N tasks" status segment while workers run
 *
 * The worker view never auto-opens. Use /tasks or ctrl+shift+t.
 *
 * Built purely on pi's extension API; observes the `task` tool's
 * tool_execution_* events and `pi.events` `task:*` job updates so
 * background workers stay visible after the parent tool returns.
 *
 * Wheel scrolling needs one small patch to the installed pi-tui
 * (tui-alt-screen.js `routeWheel`): forward wheel events to the focused
 * overlay when it implements `handleWheel`, instead of only scrolling
 * layout scroll views behind the overlay. Re-apply after pi updates:
 *   https://pi.dev (see README → wheel patch note)
 *
 * alt+up / alt+down (jump between user messages) lives in the alt-screen
 * (non-destructive viewport scroll, not a session re-root), which needs
 * two small patches to the installed pi: tui-alt-screen.js `scrollToPrompt`
 * plus alt+up/alt+down bindings, and assistant-message.js dropping its OSC
 * 133 prompt markers so only user rows are jump targets. Re-apply after pi
 * updates: README → user-message jump patch.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PaletteComponent, type PaletteItem } from "./palette.ts";
import { TaskCenterComponent } from "./task-center.ts";
import { taskRegistry } from "./tasks.ts";

function textPreview(content: any): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((c: any) =>
				c?.type === "text" && typeof c?.text === "string" ? c.text : "",
			)
			.join(" ");
	}
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 56 ? `${flat.slice(0, 56)}…` : flat || "(empty)";
}

export default function harnessUx(pi: ExtensionAPI) {
	let ui: any;
	let taskViewOpen = false;

	// ---- Track the `task` tool lifecycle → registry ----
	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "task") return;
		taskRegistry.start(event.toolCallId, event.args ?? {});
	});
	pi.on("tool_execution_update", (event) => {
		if (event.toolName !== "task") return;
		taskRegistry.update(event.toolCallId, event.partialResult);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "task") return;
		taskRegistry.finish(event.toolCallId, event.result, event.isError);
	});
	pi.events.on("task:start", (job) => {
		taskRegistry.applyJob(job as Record<string, any>);
	});
	pi.events.on("task:update", (job) =>
		taskRegistry.applyJob(job as Record<string, any>),
	);
	pi.events.on("task:end", (job) =>
		taskRegistry.applyJob(job as Record<string, any>),
	);

	// ---- Footer status segment ----
	const refreshStatus = () => {
		if (!ui) return;
		const n = taskRegistry.activeCount();
		ui.setStatus(
			"tasks",
			n > 0
				? ui.theme.fg("warning", `◐ ${n} task${n > 1 ? "s" : ""}`)
				: undefined,
		);
	};
	taskRegistry.subscribe(refreshStatus);

	pi.on("session_start", (_event, ctx) => {
		taskRegistry.reset();
		if (ctx.hasUI) {
			ui = ctx.ui;
			refreshStatus();
		}
	});
	pi.on("session_shutdown", () => {
		ui = undefined;
		taskRegistry.reset();
	});

	// ---- Fullscreen worker session ----
	const openTaskCenter = async (ctx: any): Promise<null> => {
		if (!ctx?.hasUI || taskViewOpen) return null;
		taskViewOpen = true;
		try {
			return await ctx.ui.custom<null>(
				(tui: any, theme: any, _kb: any, done: any) => {
					const comp = new TaskCenterComponent(
						theme,
						() => done(null),
						tui,
						(msg, level) => ctx.ui.notify(msg, level),
					);
					const dirty = { value: true };
					const unsub = taskRegistry.subscribe(() => {
						dirty.value = true;
						tui.requestRender();
					});
					const interval = setInterval(() => {
						if (dirty.value || taskRegistry.activeCount() > 0) {
							dirty.value = false;
							tui.requestRender();
						}
					}, 500);
					return {
						render: (w: number) => comp.render(w),
						invalidate: () => comp.invalidate(),
						handleInput: (d: string) => {
							comp.handleInput(d);
							tui.requestRender();
						},
						handleWheel: (direction: number, x?: number, y?: number) => {
							comp.handleWheel(direction, x, y);
							tui.requestRender();
						},
						dispose: () => {
							clearInterval(interval);
							unsub();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						anchor: "center",
						// Herdr paints a left pane rail on the same terminal.
						// Start the overlay after it so 1/2/3 never sit on our text.
						margin:
							process.env.HERDR_ENV === "1"
								? { left: 5, top: 0, right: 0, bottom: 0 }
								: 0,
					},
				},
			);
		} finally {
			taskViewOpen = false;
		}
	};

	pi.registerCommand("tasks", {
		description: "Fullscreen worker session",
		handler: async (_args, ctx) => {
			await openTaskCenter(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open fullscreen worker session",
		handler: async (ctx) => {
			await openTaskCenter(ctx);
		},
	});

	// ---- Command palette ----
	const openPalette = async (ctx: any) => {
		if (!ctx.hasUI) return;
		const items: PaletteItem[] = [];
		const add = (
			value: string,
			label: string,
			description: string,
			action: () => void | Promise<void>,
		) => {
			items.push({ value, label, description, action });
		};

		// Actions
		add("a:new", "New session", "start a fresh session", () =>
			ctx.newSession({
				withSession: (c: any) => c.ui?.notify("New session", "info"),
			}),
		);
		add("a:tasks", "Worker session", "fullscreen subagent view", () =>
			openTaskCenter(ctx),
		);
		add("a:compact", "Compact context", "summarize + free context", () =>
			ctx.compact({
				onComplete: () => ctx.ui.notify("Compacted", "info"),
				onError: (e: any) =>
					ctx.ui.notify(`Compact failed: ${e.message}`, "error"),
			}),
		);
		add("a:rename", "Rename session", "set display name", async () => {
			const name = await ctx.ui.input("Session name");
			if (name) pi.setSessionName(name);
		});
		add("a:reload", "Reload extensions", "hot-reload config", () =>
			ctx.reload(),
		);

		// Sessions
		try {
			const sessions = await SessionManager.list(ctx.cwd);
			for (const s of sessions) {
				const name = s.name || path.basename(s.path) || s.id;
				add(
					`s:${s.path}`,
					`session  ${name}`,
					`${s.messageCount ?? 0} msgs`,
					() =>
						ctx.switchSession(s.path, {
							withSession: (c: any) => c.ui?.notify("Switched session", "info"),
						}),
				);
			}
		} catch {
			/* session list is best-effort */
		}

		// Models
		for (const m of ctx.scopedModels ?? []) {
			const id = `${m.model?.provider}/${m.model?.id}`;
			add(
				`m:${id}`,
				`model  ${id}`,
				m.thinkingLevel ? `thinking ${m.thinkingLevel}` : "",
				() => pi.setModel(m.model),
			);
		}

		// Jump: user messages on the current branch
		try {
			const branch =
				ctx.sessionManager.getBranch() ?? ctx.sessionManager.getEntries() ?? [];
			const userEntries = branch.filter(
				(e: any) => e?.type === "message" && e?.message?.role === "user",
			);
			for (const e of userEntries.slice(-60)) {
				const preview = textPreview(e.message?.content);
				add(`j:${e.id}`, `jump  ${preview}`, "go to this message", () =>
					ctx.navigateTree(e.id, { summarize: false }),
				);
			}
		} catch {
			/* branch read is best-effort */
		}

		const value = await ctx.ui.custom<string | null>(
			(tui: any, theme: any, _kb: any, done: any) => {
				const comp = new PaletteComponent(
					theme,
					items,
					(item) => done(item.value),
					() => done(null),
					() => tui.requestRender(),
				);
				return {
					render: (w: number) => comp.render(w),
					invalidate: () => comp.invalidate(),
					handleInput: (d: string) => comp.handleInput(d),
				};
			},
			{
				overlay: true,
				overlayOptions: {
					width: "80%",
					minWidth: 44,
					maxWidth: 120,
					maxHeight: "80%",
					anchor: "top-center",
					margin: 1,
				},
			},
		);

		if (!value) return;
		const item = items.find((it) => it.value === value);
		if (item) {
			try {
				await item.action();
			} catch (e: any) {
				ctx.ui.notify(`Error: ${e?.message ?? e}`, "error");
			}
		}
	};

	pi.registerCommand("palette", {
		description:
			"Command palette — fuzzy jump to sessions, commands, tasks, models",
		handler: async (_args, ctx) => {
			await openPalette(ctx);
		},
	});
}
