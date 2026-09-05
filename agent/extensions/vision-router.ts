/**
 * vision-router.ts — port of opencode's `image-router` plugin for pi.
 *
 * Primary leads on this harness (default: opencode-go/deepseek-v4-pro) have NO native
 * vision. When the user pastes an image (Ctrl+V) and the active model cannot
 * see images, this extension:
 *
 *   1. decodes the pasted image(s) to `~/.pi/agent/vision/`
 *   2. auto-runs a vision-capable model in a child pi process
 *      (Codex Luna → Go Luna → free MiMo → Go MiMo)
 *   3. transforms the user input to inject a `[VISION DESCRIPTION]` block and
 *      strips the raw image parts from the lead's message
 *
 * The lead keeps full tool access and can still `Agent` the `vision` worker
 * (which can `read` the saved image file) if the description is missing or
 * wrong. Vision child processes are lean: no extensions/skills/templates,
 * no tools, no session.
 *
 * TUI: do NOT await the child on `input`. That event runs before the user
 * message is appended, so a blocking wait leaves a new session blank until
 * vision finishes. Start the child on `input`, paint live chrome + a
 * transcript card, then await + inject on `message_end` (user message already
 * visible, working indicator already up).
 */

import { runChild } from "./process/child.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, VStack } from "@earendil-works/pi-tui";
import {
	IMAGE_CHIP,
	PASTED_MARKER,
	VISION_DIR,
	filesForTurn,
	pastedMarker,
	pruneOldPastes,
	type SavedPaste,
} from "./paste-images.ts";
import {
	isModelExhausted,
	isUsageLimitError,
	markExhaustedFromError,
} from "./opencode-fallback.ts";

const VISION_MODELS = [
	"openai-codex/gpt-5.6-luna",
	"opencode-go/gpt-5.6-luna",
	"opencode/mimo-v2.5-free",
	"opencode-go/mimo-v2.5",
] as const;
const VISION_TIMEOUT_MS = 90_000;
const ENTRY_TYPE = "vision-job";
const JOB_TOKEN = /\[vision-job:(\d+)\]/g;

type VisionJob = {
	id: number;
	files: SavedPaste[];
	userText: string;
	cwd: string;
	startedAt: number;
	abort: AbortController;
	promise: Promise<{ text: string; model: string } | null>;
	result?: { text: string; model: string } | null;
	error?: string;
	status: "running" | "done" | "error";
	entryAppended?: boolean;
	consumed?: boolean;
};

type VisionEntryData = {
	id: number;
	startedAt: number;
	files: { name: string; path: string }[];
};

/** Only the two theme helpers visionCard uses — kept narrow, but sourced from
 * the real Theme so the parameter types stay in step with pi. */
type ThemeFg = Pick<Theme, "fg" | "bold">;

const jobs = new Map<number, VisionJob>();
let jobSeq = 0;
let beat: ReturnType<typeof setInterval> | null = null;
let uiRef: ExtensionContext["ui"] | undefined;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function modelSupportsImages(model: { input?: string[] } | undefined): boolean {
	return !!model && Array.isArray(model.input) && model.input.includes("image");
}

function formatElapsed(startedAt: number, endedAt?: number): string {
	const ms = Math.max(0, (endedAt ?? Date.now()) - startedAt);
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function describeImages(
	cwd: string,
	files: SavedPaste[],
	userText: string,
	signal: AbortSignal | undefined,
): Promise<{ text: string; model: string } | null> {
	const markers = files
		.map(
			(f) =>
				`- [Image #${f.id}] ${f.name} (${f.mimeType}, sha256 ${f.hash.slice(0, 12)}) at ${f.filePath}`,
		)
		.join("\n");
	const prompt = [
		"Describe ONLY the pasted image(s) attached to THIS message. Do not reuse or recall any earlier screenshot.",
		"The image files are attached — look at them directly.",
		"Only use the read tool if you cannot see an attachment; then read the absolute paths from the markers.",
		'Identify each image by its [Image #N] chip exactly as it appears in the user message — describe them in chip order so the user\'s wording ("this"/"that") maps correctly. Images without a chip in the message: describe last, in marker order.',
		"Return only the description. No preamble about being a vision agent.",
		"",
		"Markers:",
		markers,
		userText.trim() ? `\nUser message:\n${userText.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const deadline = Date.now() + VISION_TIMEOUT_MS;
	for (const model of VISION_MODELS) {
		if (signal?.aborted) throw new Error("vision aborted");
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		if (isModelExhausted(model)) continue;
		const args = [
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-tools",
			"--model",
			model,
			...files.map((f) => `@${f.filePath}`),
			prompt,
		];
		try {
			const invocation = getPiInvocation(args);
			const text = await runChild(invocation.command, invocation.args, {
				cwd,
				timeoutMs: remaining,
				signal,
				onFailure: (stderr) => {
					if (isUsageLimitError(stderr)) markExhaustedFromError(stderr, model);
				},
			});
			if (text && !/VISION_FALLBACK_NEEDED/i.test(text)) {
				return { text, model };
			}
		} catch (err) {
			if (signal?.aborted) throw err;
			const summary = err instanceof Error ? err.message : String(err);
			console.error(`[vision-router] ${model} failed: ${summary}`);
			if (isUsageLimitError(summary)) markExhaustedFromError(summary, model);
		}
	}
	return null;
}

function chromeLine(job: VisionJob): string {
	const elapsed = formatElapsed(job.startedAt);
	if (job.status === "running") return `◐ vision  describing  ${elapsed}`;
	if (job.status === "done")
		return `✓ vision  ${job.result?.model ?? ""}  ${elapsed}`.trim();
	return `✗ vision  ${elapsed}`;
}

function paintChrome(job: VisionJob | undefined): void {
	const ui = uiRef;
	if (!ui) return;
	try {
		if (!job || job.consumed) {
			ui.setWidget("vision", undefined);
			ui.setStatus("vision", undefined);
			ui.setWorkingMessage();
			return;
		}
		const msg = chromeLine(job);
		ui.setWidget("vision", [msg], { placement: "aboveEditor" });
		ui.setStatus("vision", msg);
		if (job.status === "running") ui.setWorkingMessage(msg);
	} catch {
		/* ignore */
	}
}

function startBeat(): void {
	if (beat) return;
	beat = setInterval(() => {
		const active = [...jobs.values()].find((j) => !j.consumed);
		if (!active) {
			stopBeat();
			paintChrome(undefined);
			return;
		}
		paintChrome(active);
	}, 1000);
}

function stopBeat(): void {
	if (!beat) return;
	clearInterval(beat);
	beat = null;
}

function abortJob(job: VisionJob): void {
	try {
		job.abort.abort();
	} catch {
		/* ignore */
	}
}

function userTextOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && part.type === "text" && typeof part.text === "string"
				? part.text
				: "",
		)
		.join("\n");
}

function stripPasteMarkup(text: string): string {
	return text
		.replace(new RegExp(JOB_TOKEN.source, "g"), "")
		.replace(new RegExp(IMAGE_CHIP.source, "g"), "")
		.replace(new RegExp(PASTED_MARKER.source, "g"), "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Chip-preserving variant for vision prompts and lead text: job tokens and
 * pasted markers go, but `[Image #N]` chips stay (normalized to bare form) so
 * sentence position ↔ image binding survives the round trip. */
function keepChipsText(text: string): string {
	return text
		.replace(new RegExp(JOB_TOKEN.source, "g"), "")
		.replace(new RegExp(PASTED_MARKER.source, "g"), "")
		.replace(new RegExp(IMAGE_CHIP.source, "g"), (_m, id) => `[Image #${id}]`)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function matchJob(text: string): VisionJob | undefined {
	const token = [...text.matchAll(new RegExp(JOB_TOKEN.source, "g"))].pop();
	if (token) {
		const job = jobs.get(Number(token[1]));
		if (job && !job.consumed) return job;
	}
	const pending = [...jobs.values()].filter((j) => !j.consumed);
	for (let i = pending.length - 1; i >= 0; i--) {
		const job = pending[i];
		if (job.files.some((f) => text.includes(f.filePath) || text.includes(f.hash)))
			return job;
	}
	return undefined;
}

function visibleUserText(job: VisionJob): string {
	const chips = job.files.map((f) => pastedMarker(f)).join("\n");
	return [`[vision-job:${job.id}]`, stripPasteMarkup(job.userText), chips]
		.filter(Boolean)
		.join("\n\n");
}

function leadText(job: VisionJob): string {
	const paths = job.files.map((f) => f.filePath).join(", ");
	const chips = job.files
		.filter((f) => f.id > 0)
		.map((f) => `[Image #${f.id}] = ${f.filePath}`)
		.join("; ");
	if (job.result?.text) {
		return [
			`[VISION DESCRIPTION from ${job.result.model}:\n${job.result.text}]`,
			"",
			keepChipsText(job.userText),
			"",
			`[SYSTEM: vision-router already described THIS turn's image(s) and injected the description above. The [Image #N] chips in the message refer to the described images, described in chip order. Prefer it over any earlier [VISION DESCRIPTION] in the session. There is no vision subagent — do not try to spawn one. Image files (this turn only): ${chips || paths}]`,
		].join("\n");
	}
	const markers = job.files
		.map(
			(f) =>
				`[IMAGE DETECTED: ${path.basename(f.filePath)} (${f.mimeType}) at ${f.filePath}]`,
		)
		.join(" ");
	return [
		`${stripPasteMarkup(job.userText)} ${markers}`.trim(),
		"",
		`[SYSTEM: Pasted image(s) were decoded to ${VISION_DIR}. Describing them failed: ${job.error ?? "unknown error"}. There is no vision subagent — do not try to spawn one. If you can read images, read the paths directly (${paths}). Otherwise say the image could not be read and ask the user to re-paste or switch to a multimodal lead with Ctrl+P.]`,
	].join("\n");
}

function preview(text: string, max = 240): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function visionCard(theme: ThemeFg, id: number, expanded: boolean): Component {
	const job = jobs.get(id);
	if (!job) return new VStack();
	const elapsed = formatElapsed(job.startedAt);
	const names = job.files.map((f) => path.basename(f.filePath)).join(", ");
	let header: string;
	if (job.status === "running") {
		header = `${theme.fg("warning", "◐")} ${theme.fg("toolTitle", theme.bold("vision"))} ${theme.fg("warning", `describing  ${elapsed}`)}`;
	} else if (job.status === "done") {
		header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("vision"))}${theme.fg("muted", ` (${job.result?.model ?? ""})`)} ${theme.fg("dim", elapsed)}`;
	} else {
		header = `${theme.fg("error", "✗")} ${theme.fg("toolTitle", theme.bold("vision"))} ${theme.fg("error", "failed")} ${theme.fg("dim", elapsed)}`;
	}
	const children: Component[] = [
		new Text(header, 0, 0),
		new Text(theme.fg("dim", `  ${names}`), 0, 0),
	];
	if (job.status === "running") {
		children.push(new Text(theme.fg("muted", "  (starting worker...)"), 0, 0));
	} else if (job.status === "error") {
		children.push(
			new Text(theme.fg("error", `  ${job.error || "unknown error"}`), 0, 0),
		);
	} else if (job.result?.text) {
		const body = expanded ? job.result.text.trim() : preview(job.result.text);
		children.push(new Text(theme.fg("toolOutput", `  ${body}`), 0, 0));
		if (!expanded)
			children.push(new Text(theme.fg("muted", "  (Ctrl+O to expand)"), 0, 0));
	}
	return new VStack(children);
}

function startJob(
	cwd: string,
	files: SavedPaste[],
	userText: string,
): VisionJob {
	for (const prev of jobs.values()) {
		if (prev.status === "running" && !prev.consumed) {
			abortJob(prev);
			prev.status = "error";
			prev.error = "superseded";
			prev.consumed = true;
		}
	}
	const id = ++jobSeq;
	const abort = new AbortController();
	const job: VisionJob = {
		id,
		files,
		userText,
		cwd,
		startedAt: Date.now(),
		abort,
		status: "running",
		promise: Promise.resolve(null),
	};
	job.promise = describeImages(
		cwd,
		files,
		keepChipsText(userText),
		abort.signal,
	).then(
		(result) => {
			if (job.status === "running") {
				job.result = result;
				job.status = result?.text ? "done" : "error";
				if (!result?.text) job.error = job.error ?? "no description";
			}
			return result;
		},
		(err) => {
			job.status = "error";
			job.error = err instanceof Error ? err.message : String(err);
			return null;
		},
	);
	jobs.set(id, job);
	if (jobs.size > 20) {
		const ids = [...jobs.keys()].sort((a, b) => a - b);
		for (const extra of ids.slice(0, ids.length - 20)) {
			const old = jobs.get(extra);
			if (old && !old.consumed && old.status === "running") continue;
			jobs.delete(extra);
		}
	}
	paintChrome(job);
	startBeat();
	return job;
}

export default function (pi: ExtensionAPI) {
	pruneOldPastes();

	pi.registerEntryRenderer<VisionEntryData>(
		ENTRY_TYPE,
		(entry, { expanded }, theme) => {
			const data = entry.data;
			if (!data || !jobs.has(data.id)) return undefined;
			return visionCard(theme, data.id, expanded);
		},
	);

	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "user") return markdown;
		let out = markdown.replace(
			/\[VISION DESCRIPTION from [^\n]+:\n[\s\S]*?\]\n*/g,
			"",
		);
		out = out.replace(/\n*\[SYSTEM:[\s\S]*?\]\s*$/g, "");
		out = out.replace(new RegExp(JOB_TOKEN.source, "g"), "");
		return out.trim() || markdown;
	});

	const onSession = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.hasUI) uiRef = ctx.ui;
	};

	pi.on("session_start", onSession);
	pi.on("session_shutdown", () => {
		stopBeat();
		for (const job of jobs.values()) {
			if (!job.consumed) {
				abortJob(job);
				job.status = job.status === "done" ? job.status : "error";
				job.consumed = true;
			}
		}
		jobs.clear();
		paintChrome(undefined);
		uiRef = undefined;
	});
	pi.on("agent_settled", () => {
		const pending = [...jobs.values()].find((j) => !j.consumed);
		if (!pending) paintChrome(undefined);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		if (modelSupportsImages(ctx.model)) return { action: "continue" as const };
		if (ctx.hasUI) uiRef = ctx.ui;

		const userText = event.text ?? "";
		// Chips/markers in THIS submit only. event.images can still carry the
		// first clipboard paste, so ignore it when this turn already named files.
		const files = filesForTurn(userText);
		if (files.length === 0) return { action: "continue" as const };

		const job = startJob(ctx.cwd, files, userText);
		return {
			action: "transform" as const,
			text: visibleUserText(job),
			images: [],
		};
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const text = userTextOf(event.message);
		const job = matchJob(text);
		if (!job) return;

		if (ctx.hasUI) uiRef = ctx.ui;
		if (!job.entryAppended) {
			job.entryAppended = true;
			try {
				pi.appendEntry<VisionEntryData>(ENTRY_TYPE, {
					id: job.id,
					startedAt: job.startedAt,
					files: job.files.map((f) => ({
						name: path.basename(f.filePath),
						path: f.filePath,
					})),
				});
			} catch {
				/* ignore */
			}
		}

		if (ctx.signal) {
			if (ctx.signal.aborted) abortJob(job);
			else
				ctx.signal.addEventListener("abort", () => abortJob(job), {
					once: true,
				});
		}

		try {
			await job.promise;
		} catch (err) {
			job.status = "error";
			job.error = err instanceof Error ? err.message : String(err);
		}
		job.consumed = true;
		paintChrome(undefined);
		stopBeat();

		const content = [{ type: "text" as const, text: leadText(job) }];
		return { message: { ...event.message, content } };
	});
}
