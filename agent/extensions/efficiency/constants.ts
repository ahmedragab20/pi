import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPRESS_MAX_BYTES = 12 * 1024;
export const COMPRESS_MAX_LINES = 200;
export const ERROR_SKIP_BYTES = 2 * 1024;
export const FOLD_KEEP_TURNS = 2;
export const FOLD_TAIL_LINES = 6;
export const MEMORY_MAX_BYTES = 4 * 1024;
export const SMALL_RESULT_BYTES = 2 * 1024;

export const CORE_ALWAYS = [
	"read",
	"bash",
	"edit",
	"write",
	"ls",
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"tool_search",
] as const;

export const CORE_IF_PRESENT = [
	"find",
	"grep",
	"ask_user_question",
	"todo",
	"goal",
	"agent_browser",
] as const;

export const COMPRESSIBLE_TOOLS = new Set([
	"bash",
	"read",
	"grep",
	"find",
	"ls",
]);

export const CHEAP_COMPACT_MODELS: Array<[string, string]> = [
	["opencode", "deepseek-v4-flash-free"],
	["opencode-go", "deepseek-v4-flash"],
];

export const FOLDED_MARKER = "[folded]";
export const COMPRESSED_MARKER = "[compressed]";

export function dumpDir(): string {
	return join(getAgentDir(), "tmp", "tool-dumps");
}

export function dumpPath(toolCallId: string): string {
	const safe = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(dumpDir(), `${safe}.txt`);
}

export function memoryDir(): string {
	const dir = join(getAgentDir(), "memory");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function isCompressibleTool(name: string): boolean {
	const n = name.toLowerCase();
	if (n === "agent" || n === "get_subagent_result" || n === "steer_subagent")
		return false;
	if (COMPRESSIBLE_TOOLS.has(n)) return true;
	return [...COMPRESSIBLE_TOOLS].some(
		(t) => n.endsWith(`_${t}`) || n.endsWith(`-${t}`),
	);
}
