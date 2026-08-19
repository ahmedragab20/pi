/**
 * Inject a tiny MEMORY.md packet once per session.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { MEMORY_MAX_BYTES, memoryDir } from "./constants.ts";

type MemoryDetails = { path: string };

function cwdSlug(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return (slug.slice(-80) || "root").toLowerCase();
}

export function resolveMemoryPath(ctx: ExtensionContext): string {
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "MEMORY.md");
	if (ctx.isProjectTrusted() && existsSync(projectPath)) {
		return projectPath;
	}
	return join(memoryDir(), `${cwdSlug(ctx.cwd)}.md`);
}

function readMemoryFile(path: string): string | undefined {
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size === 0 || st.size > MEMORY_MAX_BYTES) return undefined;
		const text = readFileSync(path, "utf8").trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

function alreadyInjected(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "project-memory",
	);
}

export function registerProjectMemory(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("project-memory", (message, _opts, theme) => {
		const path = (message.details as MemoryDetails | undefined)?.path ?? "";
		return new Text(theme.fg("muted", `memory · ${path}`), 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		if (alreadyInjected(ctx)) return;
		const path = resolveMemoryPath(ctx);
		const text = readMemoryFile(path);
		if (!text) return;
		pi.sendMessage({
			customType: "project-memory",
			content: `Project memory (${path}):\n\n${text}`,
			display: true,
			details: { path } satisfies MemoryDetails,
		});
	});

	pi.registerCommand("memory", {
		description: "Show project memory path, or `refresh` for how to update it",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const path = resolveMemoryPath(ctx);
			if (args.trim().toLowerCase() === "refresh") {
				ctx.ui.notify(
					`Refresh: Agent the memory worker to rewrite ${path} (≤4KB). Not auto-run.`,
					"info",
				);
				return;
			}
			const text = readMemoryFile(path);
			const preview = text ? text.split("\n").slice(0, 8).join("\n") : "(missing or too large)";
			ctx.ui.notify(`${path}\n${preview}`, "info");
		},
	});
}
