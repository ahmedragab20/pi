/**
 * /btw — ask a side question without adding it to the conversation.
 *
 * Isolated complete() with no tools. Overlay shows the answer. History stays
 * in memory for this session instance and never hits the session file.
 */

import { spawn } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type MarkdownTheme,
	type TUI,
} from "@earendil-works/pi-tui";

export const MAX_CONVERSATION_CHARS = 80_000;
export const MAX_BLOCK_CHARS = 2_000;
export const MAX_HISTORY = 20;
export const VISIBLE_PREVIOUS = 5;

export const BTW_SYSTEM_PROMPT = [
	"You are answering a quick side question (\"by the way\") about the current coding session.",
	"Answer only from the conversation context below and your general knowledge.",
	"You have no tools. You cannot read files, run commands, or search.",
	"If the conversation does not contain enough to answer, say so.",
	"Be concise. No greeting. No recap of the question.",
].join("\n");

export type SessionEntryLike = {
	type: string;
	summary?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		command?: string;
		output?: string;
		excludeFromContext?: boolean;
	};
};

export type BtwExchange = {
	question: string;
	answer: string;
};

export type BtwKeyAction =
	| { type: "dismiss" }
	| { type: "scroll"; delta: number }
	| { type: "history"; delta: -1 | 1 }
	| { type: "copy" }
	| { type: "clear" }
	| { type: "none" };

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

const TRUNCATE_MARK = "…[earlier conversation truncated]\n";

export function capTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.max(0, maxChars - TRUNCATE_MARK.length);
	return TRUNCATE_MARK + text.slice(-keep);
}

function capBlock(text: string, maxChars: number = MAX_BLOCK_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}…`;
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			const trimmed = block.text.trim();
			if (trimmed.length > 0) parts.push(trimmed);
		}
	}
	return parts;
}

function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		const args = block.arguments ?? {};
		let encoded = "";
		try {
			encoded = JSON.stringify(args);
		} catch {
			encoded = String(args);
		}
		lines.push(`called ${block.name}(${capBlock(encoded, 400)})`);
	}
	return lines;
}

export function extractAssistantText(content: unknown): string {
	return extractTextParts(content).join("\n").trim();
}

export function buildConversationText(entries: SessionEntryLike[]): string {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			const summary = capBlock(entry.summary);
			if (summary) sections.push(`Compaction summary:\n${summary}`);
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			const summary = capBlock(entry.summary);
			if (summary) sections.push(`Branch summary:\n${summary}`);
			continue;
		}
		if (entry.type !== "message" || !entry.message?.role) continue;

		const msg = entry.message;
		const role = msg.role;

		if (role === "user") {
			const text = extractTextParts(msg.content).join("\n").trim();
			if (text) sections.push(`User: ${capBlock(text)}`);
			continue;
		}

		if (role === "assistant") {
			const lines: string[] = [];
			const text = extractTextParts(msg.content).join("\n").trim();
			if (text) lines.push(capBlock(text));
			lines.push(...extractToolCallLines(msg.content));
			if (lines.length > 0) {
				sections.push(`Assistant: ${lines.join("\n")}`);
			}
			continue;
		}

		if (role === "toolResult") {
			const text = extractTextParts(msg.content).join("\n").trim();
			const name = msg.toolName ?? "tool";
			if (text) sections.push(`Tool result (${name}):\n${capBlock(text)}`);
			continue;
		}

		if (role === "bashExecution") {
			if (msg.excludeFromContext) continue;
			const command = typeof msg.command === "string" ? msg.command : "";
			const output = typeof msg.output === "string" ? msg.output : "";
			const body = [`$ ${command}`, capBlock(output)].filter(Boolean).join("\n");
			if (body.trim()) sections.push(`Bash:\n${body}`);
			continue;
		}

		if (role === "compactionSummary" && typeof msg.content === "string") {
			const summary = capBlock(msg.content);
			if (summary) sections.push(`Compaction summary:\n${summary}`);
			continue;
		}

		if (role === "branchSummary") {
			const summary =
				typeof (msg as { summary?: unknown }).summary === "string"
					? capBlock((msg as { summary: string }).summary)
					: extractTextParts(msg.content).join("\n").trim();
			if (summary) sections.push(`Branch summary:\n${summary}`);
		}
	}

	return capTail(sections.join("\n\n"), MAX_CONVERSATION_CHARS);
}

export function buildBtwPrompt(input: {
	conversation: string;
	sideQuestions: BtwExchange[];
	question: string;
}): string {
	const parts: string[] = [];
	if (input.conversation.trim()) {
		parts.push(
			"<conversation>",
			input.conversation.trim(),
			"</conversation>",
		);
	} else {
		parts.push("The main conversation is empty.");
	}

	if (input.sideQuestions.length > 0) {
		const recent = input.sideQuestions.slice(-MAX_HISTORY);
		const body = recent
			.map((ex) => `Q: ${ex.question}\nA: ${ex.answer}`)
			.join("\n\n");
		parts.push(
			"<side-questions>",
			"Earlier side questions in this session (not part of the main conversation):",
			body,
			"</side-questions>",
		);
	}

	parts.push("<question>", input.question.trim(), "</question>");
	return parts.join("\n\n");
}

export class BtwHistory {
	private items: BtwExchange[] = [];
	private index = -1;

	get length(): number {
		return this.items.length;
	}

	get viewIndex(): number {
		return this.index;
	}

	current(): BtwExchange | undefined {
		if (this.index < 0) return undefined;
		return this.items[this.index];
	}

	latest(): BtwExchange | undefined {
		return this.items.at(-1);
	}

	push(exchange: BtwExchange): void {
		this.items.push(exchange);
		if (this.items.length > MAX_HISTORY) {
			this.items = this.items.slice(-MAX_HISTORY);
		}
		this.index = this.items.length - 1;
	}

	stepOlder(): boolean {
		if (this.index <= 0) return false;
		this.index -= 1;
		return true;
	}

	stepNewer(): boolean {
		if (this.index < 0 || this.index >= this.items.length - 1) return false;
		this.index += 1;
		return true;
	}

	jumpToLatest(): void {
		this.index = this.items.length - 1;
	}

	/** Keep the viewed exchange; drop everything else. */
	clearEarlier(): void {
		const keep = this.current();
		this.items = keep ? [keep] : [];
		this.index = this.items.length - 1;
	}

	clearAll(): void {
		this.items = [];
		this.index = -1;
	}

	previousVisible(cutIndex: number = this.index): {
		questions: string[];
		olderCount: number;
	} {
		const earlier = this.items.slice(0, Math.max(0, cutIndex));
		const olderCount = Math.max(0, earlier.length - VISIBLE_PREVIOUS);
		return {
			questions: earlier.slice(-VISIBLE_PREVIOUS).map((ex) => ex.question),
			olderCount,
		};
	}

	snapshot(): BtwExchange[] {
		return this.items.map((ex) => ({ ...ex }));
	}
}

export function btwKeyAction(data: string, answering: boolean): BtwKeyAction {
	if (
		matchesKey(data, "escape") ||
		matchesKey(data, "ctrl+c") ||
		matchesKey(data, "enter") ||
		matchesKey(data, "return") ||
		matchesKey(data, "space")
	) {
		return { type: "dismiss" };
	}
	if (answering) return { type: "none" };

	if (matchesKey(data, "up") || matchesKey(data, "k")) {
		return { type: "scroll", delta: -1 };
	}
	if (matchesKey(data, "down") || matchesKey(data, "j")) {
		return { type: "scroll", delta: 1 };
	}
	if (matchesKey(data, "pageUp")) return { type: "scroll", delta: -10 };
	if (matchesKey(data, "pageDown")) return { type: "scroll", delta: 10 };

	if (
		matchesKey(data, "left") ||
		matchesKey(data, "[") ||
		matchesKey(data, "shift+left")
	) {
		return { type: "history", delta: -1 };
	}
	if (
		matchesKey(data, "right") ||
		matchesKey(data, "]") ||
		matchesKey(data, "shift+right")
	) {
		return { type: "history", delta: 1 };
	}

	if (matchesKey(data, "c")) return { type: "copy" };
	if (matchesKey(data, "x")) return { type: "clear" };
	return { type: "none" };
}

function writeToCommand(
	command: string,
	args: string[],
	text: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited ${code ?? "null"}`));
		});
		child.stdin?.end(text);
	});
}

export async function copyToClipboard(text: string): Promise<boolean> {
	const attempts: [string, string[]][] =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
					];
	for (const [command, args] of attempts) {
		try {
			await writeToCommand(command, args, text);
			return true;
		} catch {
			// try next
		}
	}
	try {
		process.stdout.write(
			`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`,
		);
		return true;
	} catch {
		return false;
	}
}

function sessionEntries(ctx: ExtensionCommandContext): SessionEntryLike[] {
	const sm = ctx.sessionManager as {
		buildContextEntries?: () => SessionEntryLike[];
		getBranch?: () => SessionEntryLike[];
	};
	const entries = sm.buildContextEntries?.() ?? sm.getBranch?.() ?? [];
	return entries;
}

class BtwPanel {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly history: BtwHistory;
	private readonly onClose: () => void;
	private readonly copy: (text: string) => Promise<boolean>;
	private question: string;
	private answer: string;
	private answering: boolean;
	private error: string | undefined;
	private scroll = 0;
	private copied = false;
	private bodyLines: string[] = [];
	private cachedWidth?: number;
	private visibleBody = 12;

	constructor(opts: {
		tui: TUI;
		theme: Theme;
		history: BtwHistory;
		question: string;
		answer: string;
		answering: boolean;
		onClose: () => void;
		copy: (text: string) => Promise<boolean>;
	}) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.history = opts.history;
		this.question = opts.question;
		this.answer = opts.answer;
		this.answering = opts.answering;
		this.onClose = opts.onClose;
		this.copy = opts.copy;
	}

	setAnswer(answer: string): void {
		this.answering = false;
		this.error = undefined;
		this.answer = answer;
		this.scroll = 0;
		this.cachedWidth = undefined;
		this.tui.requestRender();
	}

	setError(message: string): void {
		this.answering = false;
		this.error = message;
		this.cachedWidth = undefined;
		this.tui.requestRender();
	}

	showExchange(exchange: BtwExchange): void {
		this.answering = false;
		this.error = undefined;
		this.question = exchange.question;
		this.answer = exchange.answer;
		this.scroll = 0;
		this.copied = false;
		this.cachedWidth = undefined;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const action = btwKeyAction(data, this.answering);
		switch (action.type) {
			case "dismiss":
				this.onClose();
				return;
			case "scroll":
				this.scroll = Math.max(0, this.scroll + action.delta);
				this.tui.requestRender();
				return;
			case "history":
				if (action.delta < 0) {
					if (this.history.stepOlder()) this.showExchange(this.history.current()!);
				} else if (this.history.stepNewer()) {
					this.showExchange(this.history.current()!);
				}
				return;
			case "copy":
				void this.copyCurrent();
				return;
			case "clear":
				this.history.clearEarlier();
				this.cachedWidth = undefined;
				this.tui.requestRender();
				return;
			case "none":
				return;
		}
	}

	private async copyCurrent(): Promise<void> {
		if (!this.answer) return;
		const ok = await this.copy(this.answer);
		this.copied = ok;
		this.cachedWidth = undefined;
		this.tui.requestRender();
		if (ok) {
			setTimeout(() => {
				this.copied = false;
				this.cachedWidth = undefined;
				this.tui.requestRender();
			}, 1200);
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		const w = Math.max(24, width);
		if (this.cachedWidth === w && this.bodyLines.length > 0) {
			return this.compose(w);
		}
		this.cachedWidth = w;
		this.bodyLines = this.buildBody(w);
		return this.compose(w);
	}

	private buildBody(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(8, width - 4);
		const lines: string[] = [];
		const cut = this.answering ? this.history.length : this.history.viewIndex;
		const prev = this.history.previousVisible(cut);

		if (prev.olderCount > 0) {
			lines.push(th.fg("dim", `${prev.olderCount} older`));
		}
		for (const q of prev.questions) {
			lines.push(th.fg("dim", `· ${truncateToWidth(q, inner, "…")}`));
		}
		if (prev.questions.length > 0 || prev.olderCount > 0) lines.push("");

		lines.push(th.fg("muted", "Q"));
		for (const line of wrapPlain(this.question, inner)) {
			lines.push(th.fg("text", line));
		}
		lines.push("");

		if (this.answering) {
			lines.push(th.fg("accent", "answering…"));
		} else if (this.error) {
			lines.push(th.fg("error", this.error));
		} else {
			const md = new Markdown(
				this.answer || "(empty)",
				0,
				0,
				markdownThemeFrom(this.theme),
			);
			lines.push(...md.render(inner));
		}
		return lines;
	}

	private compose(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const termRows = this.tui.terminal?.rows ?? 24;
		const maxHeight = Math.max(10, Math.min(termRows - 2, Math.floor(termRows * 0.8)));
		const chrome = 4; // title + footer + two borders
		this.visibleBody = Math.max(4, maxHeight - chrome);

		const maxScroll = Math.max(0, this.bodyLines.length - this.visibleBody);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const slice = this.bodyLines.slice(
			this.scroll,
			this.scroll + this.visibleBody,
		);
		while (slice.length < this.visibleBody) slice.push("");

		const title = ` btw `;
		const titlePad = Math.max(0, inner - visibleWidth(title));
		const out: string[] = [];
		out.push(
			th.fg("border", "╭") +
				th.fg("accent", th.bold(title)) +
				th.fg("border", `${"─".repeat(titlePad)}╮`),
		);

		const canUp = this.scroll > 0;
		const canDown = this.scroll < maxScroll;
		for (let i = 0; i < slice.length; i++) {
			let prefix = " ";
			if (i === 0 && canUp) prefix = "↑";
			else if (i === slice.length - 1 && canDown) prefix = "↓";
			out.push(this.row(`${prefix}${slice[i] ?? ""}`, width));
		}

		const hint = this.answering
			? "esc cancel"
			: this.copied
				? "copied"
				: "esc close · ↑↓ scroll · ←→ history · c copy · x clear";
		out.push(this.row(` ${th.fg("dim", hint)}`, width));
		out.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
		return out;
	}

	private row(content: string, width: number): string {
		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const padded = truncateToWidth(content, inner, "…", true);
		return th.fg("border", "│") + padded + th.fg("border", "│");
	}
}

function wrapPlain(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (visibleWidth(next) <= width) {
			current = next;
			continue;
		}
		if (current) lines.push(current);
		if (visibleWidth(word) <= width) {
			current = word;
		} else {
			lines.push(truncateToWidth(word, width, "…"));
			current = "";
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

function usage(): string {
	return "Usage: /btw <question>  ·  bare /btw reopens the last side question";
}

export default function btwExtension(pi: ExtensionAPI): void {
	const history = new BtwHistory();
	let open = false;
	let abortCurrent: AbortController | undefined;

	pi.on("session_shutdown", () => {
		abortCurrent?.abort();
		abortCurrent = undefined;
	});

	pi.registerCommand("btw", {
		description:
			"Ask a side question without adding it to the conversation (overlay, no tools)",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (open) {
				if (ctx.hasUI) ctx.ui.notify("a side question is already open", "warning");
				return;
			}

			if (!question) {
				const last = history.latest();
				if (!last) {
					if (ctx.hasUI) ctx.ui.notify(usage(), "warning");
					return;
				}
				history.jumpToLatest();
				await showOverlay(ctx, {
					question: last.question,
					answer: last.answer,
					answering: false,
				});
				return;
			}

			if (!ctx.model) {
				if (ctx.hasUI) ctx.ui.notify("No model selected", "error");
				return;
			}

			const conversation = buildConversationText(sessionEntries(ctx));
			const prompt = buildBtwPrompt({
				conversation,
				sideQuestions: history.snapshot(),
				question,
			});

			open = true;
			if (ctx.hasUI) ctx.ui.setStatus("btw", ctx.ui.theme.fg("accent", "btw"));
			const ac = new AbortController();
			abortCurrent = ac;

			try {
				if (ctx.mode === "tui") {
					await runOverlayAnswer(ctx, {
						question,
						prompt,
						signal: ac.signal,
					});
				} else {
					const answer = await completeBtw(ctx, prompt, ac.signal);
					if (answer.status === "ok") {
						history.push({ question, answer: answer.text });
						if (ctx.hasUI) ctx.ui.notify(answer.text, "info");
					} else if (answer.status === "error" && ctx.hasUI) {
						ctx.ui.notify(answer.message, "error");
					}
				}
			} finally {
				if (abortCurrent === ac) abortCurrent = undefined;
				open = false;
				if (ctx.hasUI) ctx.ui.setStatus("btw", undefined);
			}
		},
	});

	async function showOverlay(
		ctx: ExtensionCommandContext,
		state: { question: string; answer: string; answering: boolean },
	): Promise<void> {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) {
				ctx.ui.notify(`Q: ${state.question}\n\n${state.answer}`, "info");
			}
			return;
		}
		open = true;
		if (ctx.hasUI) ctx.ui.setStatus("btw", ctx.ui.theme.fg("accent", "btw"));
		try {
			await ctx.ui.custom(
				(tui, theme, _kb, done) =>
					new BtwPanel({
						tui,
						theme,
						history,
						question: state.question,
						answer: state.answer,
						answering: state.answering,
						onClose: () => done(undefined),
						copy: copyToClipboard,
					}),
				overlayOptions(),
			);
		} finally {
			open = false;
			if (ctx.hasUI) ctx.ui.setStatus("btw", undefined);
		}
	}

	async function runOverlayAnswer(
		ctx: ExtensionCommandContext,
		opts: { question: string; prompt: string; signal: AbortSignal },
	): Promise<void> {
		await ctx.ui.custom((tui, theme, _kb, done) => {
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				abortCurrent?.abort();
				done(undefined);
			};
			const panel = new BtwPanel({
				tui,
				theme,
				history,
				question: opts.question,
				answer: "",
				answering: true,
				onClose: close,
				copy: copyToClipboard,
			});

			void (async () => {
				const result = await completeBtw(ctx, opts.prompt, opts.signal);
				if (closed) return;
				if (result.status === "ok") {
					history.push({ question: opts.question, answer: result.text });
					panel.setAnswer(result.text);
				} else if (result.status === "aborted") {
					close();
				} else {
					panel.setError(result.message);
				}
			})();

			return panel;
		}, overlayOptions());
	}
}

function markdownThemeFrom(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

function overlayOptions() {
	return {
		overlay: true as const,
		overlayOptions: {
			anchor: "right-center" as const,
			width: "56%" as const,
			minWidth: 48,
			maxHeight: "80%" as const,
			margin: 1,
		},
	};
}

type CompleteResult =
	| { status: "ok"; text: string }
	| { status: "aborted" }
	| { status: "error"; message: string };

async function completeBtw(
	ctx: ExtensionCommandContext,
	prompt: string,
	signal: AbortSignal,
): Promise<CompleteResult> {
	if (!ctx.model) return { status: "error", message: "No model selected" };
	try {
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: BTW_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				signal,
				cacheRetention: "none",
				maxTokens: 2048,
			},
		);
		if (response.stopReason === "aborted" || signal.aborted) {
			return { status: "aborted" };
		}
		if (response.stopReason === "error") {
			return {
				status: "error",
				message: response.errorMessage ?? "side question failed",
			};
		}
		const text = extractAssistantText(response.content);
		if (!text) {
			return { status: "error", message: "empty answer" };
		}
		return { status: "ok", text };
	} catch (err) {
		if (signal.aborted) return { status: "aborted" };
		const message = err instanceof Error ? err.message : String(err);
		return { status: "error", message };
	}
}
