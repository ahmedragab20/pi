import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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
	// IDs can repeat across sessions/providers. Reuse immutable content-addressed
	// files without mkdir/write syscalls on the hot context-folding path.
	const hash = createHash("sha256").update(text).digest("hex");
	const path = dumpPath(`${id.slice(0, 100)}-${hash}`);
	const matches = () => {
		try {
			const existing = lstatSync(path);
			if (
				!existing.isFile() ||
				existing.size !== Buffer.byteLength(text, "utf8")
			) {
				throw new Error("Existing tool dump is not a matching regular file");
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	};
	if (matches()) return path;
	mkdirSync(dumpDir(), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !matches())
			throw error;
	}
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
			const st = lstatSync(path);
			if (st.isFile() && now - st.mtimeMs > DUMP_MAX_AGE_MS) {
				unlinkSync(path);
				removed++;
			}
		} catch {
			// skip
		}
	}
	return removed;
}
