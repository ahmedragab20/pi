/**
 * Fold older bash/read/grep/find/ls results in outgoing LLM context.
 * Session JSONL is unchanged. Stubs always include a dump path.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	COMPRESSED_MARKER,
	FOLDED_MARKER,
	FOLD_KEEP_TURNS,
	FOLD_TAIL_LINES,
	SMALL_RESULT_BYTES,
	isCompressibleTool,
} from "./constants.ts";
import { contentText, formatSize, lastLines, writeDump } from "./dumps.ts";

let enabled = true;
let lastFolded = 0;

function isToolResult(m: AgentMessage): m is ToolResultMessage {
	return m.role === "toolResult";
}

function isBashExecution(
	m: AgentMessage,
): m is AgentMessage & { role: "bashExecution"; output: string; command: string } {
	return m.role === "bashExecution";
}

function lastTwoTurnStart(messages: AgentMessage[]): number {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			seen++;
			if (seen === FOLD_KEEP_TURNS) return i;
		}
	}
	return 0;
}

function readPathFromCalls(messages: AgentMessage[]): Map<string, string> {
	const paths = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			if (part.type !== "toolCall") continue;
			if (part.name !== "read" && !part.name.toLowerCase().includes("read")) {
				continue;
			}
			const path = part.arguments?.path ?? part.arguments?.file_path;
			if (typeof path === "string" && path) {
				paths.set(part.id, path);
			}
		}
	}
	return paths;
}

function foldStub(name: string, id: string, text: string): string {
	const dump = writeDump(id, text);
	const bytes = Buffer.byteLength(text, "utf8");
	const tail = lastLines(text, FOLD_TAIL_LINES);
	return `${FOLDED_MARKER} ${name} ${formatSize(bytes)} → ${dump} — last ${FOLD_TAIL_LINES} lines:\n${tail}`;
}

function alreadyFolded(text: string): boolean {
	return text.startsWith(FOLDED_MARKER) || text.startsWith(COMPRESSED_MARKER);
}

export function registerMicrocompact(pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		if (!enabled) {
			lastFolded = 0;
			return;
		}

		const messages = event.messages;
		const keepStart = lastTwoTurnStart(messages);
		const readPaths = readPathFromCalls(messages);
		const seenReads = new Set<string>();
		const dropIds = new Set<string>();

		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (!isToolResult(m) || m.toolName !== "read") continue;
			const path = readPaths.get(m.toolCallId);
			if (!path) continue;
			if (seenReads.has(path)) dropIds.add(m.toolCallId);
			else seenReads.add(path);
		}

		let folded = 0;
		const next = messages.map((m, index) => {
			if (isBashExecution(m)) {
				if (index >= keepStart) return m;
				const text = m.output ?? "";
				if (alreadyFolded(text) || Buffer.byteLength(text, "utf8") < SMALL_RESULT_BYTES) {
					return m;
				}
				folded++;
				return {
					...m,
					output: foldStub("bash", `bash-${m.timestamp}`, text),
					truncated: true,
					fullOutputPath: writeDump(`bash-${m.timestamp}`, text),
				};
			}

			if (!isToolResult(m)) return m;
			if (m.isError) return m;
			if (!isCompressibleTool(m.toolName)) return m;

			const text = contentText(m.content);
			if (alreadyFolded(text)) return m;

			const superseded = dropIds.has(m.toolCallId);
			const old = index < keepStart;
			if (!old && !superseded) return m;
			if (
				!superseded &&
				Buffer.byteLength(text, "utf8") < SMALL_RESULT_BYTES
			) {
				return m;
			}

			folded++;
			return {
				...m,
				content: [
					{
						type: "text" as const,
						text: foldStub(m.toolName, m.toolCallId, text),
					},
				],
			};
		});

		lastFolded = folded;
		if (folded === 0) return;
		return { messages: next };
	});

	pi.registerCommand("microcompact", {
		description: "Fold old tool dumps in outgoing context (on|off|status)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const cmd = args.trim().toLowerCase() || "status";
			if (cmd === "on") {
				enabled = true;
				ctx.ui.notify("microcompact on", "info");
				return;
			}
			if (cmd === "off") {
				enabled = false;
				ctx.ui.notify("microcompact off", "info");
				return;
			}
			ctx.ui.notify(
				`microcompact ${enabled ? "on" : "off"} · last fold ${lastFolded} result${lastFolded === 1 ? "" : "s"}`,
				"info",
			);
		},
	});
}
