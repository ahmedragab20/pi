import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { DUMP_MAX_AGE_MS, dumpDir, dumpPath } from "./constants.ts";

export { formatSize };

export function contentText(
	content: string | (TextContent | ImageContent)[] | undefined,
): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export function lastLines(text: string, n: number): string {
	if (!text) return "";
	const lines = text.split("\n");
	if (lines.length <= n) return text;
	return lines.slice(-n).join("\n");
}

export function writeDump(id: string, text: string): string {
	mkdirSync(dumpDir(), { recursive: true });
	const path = dumpPath(id);
	writeFileSync(path, text, "utf8");
	return path;
}

export function pruneOldDumps(now = Date.now()): number {
	let removed = 0;
	let dir: string[];
	try {
		dir = readdirSync(dumpDir());
	} catch {
		return 0;
	}
	for (const name of dir) {
		const path = join(dumpDir(), name);
		try {
			const st = statSync(path);
			if (now - st.mtimeMs > DUMP_MAX_AGE_MS) {
				unlinkSync(path);
				removed++;
			}
		} catch {
			// skip
		}
	}
	return removed;
}
