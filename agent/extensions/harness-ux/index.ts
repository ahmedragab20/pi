/**
 * harness-ux — navigation + live subagent visibility for the pi TUI.
 *
 * - /tasks   → Task Center overlay (navigable list + live worker detail)
 * - /palette → fuzzy command palette (sessions, actions, models, message jump)
 * - footer   → live "◐ N tasks" status segment while workers run
 *
 * Built purely on pi's extension API; observes the `task` tool's
 * tool_execution_* events so it never patches the subagent extension.
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

	// ---- Task Center ----
	const openTaskCenter = (ctx: any): Promise<null> => {
		if (!ctx.hasUI) return Promise.resolve(null);
		return ctx.ui.custom<null>(
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
					dispose: () => {
						clearInterval(interval);
						unsub();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					width: "60%",
					minWidth: 56,
					maxWidth: 132,
					maxHeight: "85%",
					anchor: "right-center",
					margin: 1,
				},
			},
		);
	};

	pi.registerCommand("tasks", {
		description: "Live Task Center for subagent workers",
		handler: async (_args, ctx) => {
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
		add("a:tasks", "Task Center", "live subagent workers", () =>
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
