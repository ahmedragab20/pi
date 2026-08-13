/**
 * Cap huge bash/read/grep/find/ls results at ingest.
 * Full text is written to ~/.pi/agent/tmp/tool-dumps/<id>.txt.
 */
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	COMPRESSED_MARKER,
	COMPRESS_MAX_BYTES,
	COMPRESS_MAX_LINES,
	ERROR_SKIP_BYTES,
	isCompressibleTool,
} from "./constants.ts";
import { contentText, formatSize, writeDump } from "./dumps.ts";

function shouldCompress(event: ToolResultEvent, text: string): boolean {
	if (!isCompressibleTool(event.toolName)) return false;
	if (text.includes(COMPRESSED_MARKER)) return false;
	if (event.isError && Buffer.byteLength(text, "utf8") < ERROR_SKIP_BYTES) {
		return false;
	}
	const bytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n").length;
	return bytes > COMPRESS_MAX_BYTES || lines > COMPRESS_MAX_LINES;
}

export function registerAutoCompress(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		const text = contentText(event.content);
		if (!shouldCompress(event, text)) return;

		const dump = writeDump(event.toolCallId, text);
		const bytes = Buffer.byteLength(text, "utf8");
		const lines = text.split("\n").length;
		const keep =
			event.toolName === "bash"
				? truncateTail(text, {
						maxBytes: COMPRESS_MAX_BYTES,
						maxLines: COMPRESS_MAX_LINES,
					})
				: truncateHead(text, {
						maxBytes: COMPRESS_MAX_BYTES,
						maxLines: COMPRESS_MAX_LINES,
					});

		const header = [
			`${COMPRESSED_MARKER} ${event.toolName} ${formatSize(bytes)} / ${lines} lines → ${dump}`,
			`Kept ${keep.outputLines} lines / ${formatSize(keep.outputBytes)}. Read the dump file for the full output.`,
			"",
			keep.content,
		].join("\n");

		return {
			content: [{ type: "text" as const, text: header }],
		};
	});
}
