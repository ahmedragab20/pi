/**
 * Inject a MEMORY.md packet at session start; re-inject when the file changes
 * mid-session (memory worker refresh) or after compaction wipes it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { MEMORY_MAX_BYTES, memoryDir } from "./constants.ts";

type MemoryDetails = { path: string; updated?: boolean };
type MemoryFile = { text?: string; size: number };

function cwdSlug(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const base = (slug.slice(-60) || "root").toLowerCase();
	const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 6);
	return `${base}-${hash}`;
}

export function resolveMemoryPath(ctx: ExtensionContext): string {
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "MEMORY.md");
	if (ctx.isProjectTrusted() && existsSync(projectPath)) {
		return projectPath;
	}
	return join(memoryDir(), `${cwdSlug(ctx.cwd)}.md`);
}

function truncateUtf8(text: string, maxBytes: number): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const b = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + b > maxBytes) break;
		out.push(line);
		bytes += b;
	}
	return out.join("\n");
}

function readMemoryFile(path: string): MemoryFile {
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size === 0) return { size: 0 };
		const text = readFileSync(path, "utf8").trim();
		if (!text) return { size: st.size };
		if (st.size <= MEMORY_MAX_BYTES) return { text, size: st.size };
		const cut = truncateUtf8(text, MEMORY_MAX_BYTES);
		return {
			text: `${cut}\n\n[truncated: ${st.size} bytes total, budget is ${MEMORY_MAX_BYTES} — have the memory worker trim it]`,
			size: st.size,
		};
	} catch {
		return { size: 0 };
	}
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function alreadyInBranch(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some(
		(entry) =>
			entry.type === "custom_message" && entry.customType === "project-memory",
	);
}

let lastInjected: { path: string; hash: string; mtime: number } | null = null;

function injectMemory(pi: ExtensionAPI, ctx: ExtensionContext, updated: boolean): void {
	const path = resolveMemoryPath(ctx);
	let mtime = 0;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		lastInjected = null;
		return;
	}
	const { text } = readMemoryFile(path);
	if (!text) {
		lastInjected = null;
		return;
	}
	lastInjected = { path, hash: hashText(text), mtime };
	pi.sendMessage({
		customType: "project-memory",
		content: `Project memory (${path})${updated ? " — updated since last injection" : ""}:\n\n${text}`,
		display: true,
		details: { path, updated } satisfies MemoryDetails,
	});
}

export function registerProjectMemory(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("project-memory", (message, _opts, theme) => {
		const details = message.details as MemoryDetails | undefined;
		const path = details?.path ?? "";
		const updated = details?.updated ? " (updated)" : "";
		return new Text(theme.fg("muted", `memory${updated} · ${path}`), 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		if (alreadyInBranch(ctx)) return;
		injectMemory(pi, ctx, false);
	});

	// Mid-session refresh: the memory worker rewrote the file — re-inject.
	// Also bootstraps a file that only appeared after session start.
	pi.on("agent_settled", (_event, ctx) => {
		if (!lastInjected) {
			if (alreadyInBranch(ctx)) return;
			injectMemory(pi, ctx, false);
			return;
		}
		const path = lastInjected.path;
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			return;
		}
		if (mtime === lastInjected.mtime) return;
		const { text } = readMemoryFile(path);
		if (!text) return;
		const hash = hashText(text);
		if (hash === lastInjected.hash) {
			lastInjected = { ...lastInjected, mtime };
			return;
		}
		lastInjected = { path, hash, mtime };
		pi.sendMessage({
			customType: "project-memory",
			content: `Project memory (${path}) — updated since last injection:\n\n${text}`,
			display: true,
			details: { path, updated: true } satisfies MemoryDetails,
		});
	});

	// Compaction can summarize the injected packet away — restore it.
	pi.on("session_compact", (_event, ctx) => {
		injectMemory(pi, ctx, false);
	});

	pi.registerCommand("memory", {
		description: "Show project memory path, or `refresh` for the spawn brief",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const path = resolveMemoryPath(ctx);
			if (args.trim().toLowerCase() === "refresh") {
				ctx.ui.notify(
					[
						`Memory file: ${path} (keep it ≤${MEMORY_MAX_BYTES} bytes)`,
						"",
						"Spawn the memory worker with this brief:",
						'Agent({ subagent_type: "memory", description: "refresh project memory", prompt:',
						`  "Refresh the memory file at ${path}. Read it first and merge — don't rewrite from scratch. Keep it ≤${MEMORY_MAX_BYTES} bytes (verify with wc -c). Return: file path + what changed + anything you could not verify." })`,
					].join("\n"),
					"info",
				);
				return;
			}
			const { text, size } = readMemoryFile(path);
			const status = text
				? size > MEMORY_MAX_BYTES
					? `(${size} bytes — over the ${MEMORY_MAX_BYTES} budget, injected truncated)`
					: `(${size} bytes)`
				: "(missing or empty)";
			const preview = text ? text.split("\n").slice(0, 8).join("\n") : "";
			ctx.ui.notify(`${path} ${status}\n${preview}`, "info");
		},
	});
}
