/**
 * /btw side-question command.
 *
 *   bun test ../tests/btw.test.ts
 */

import { describe, expect, test } from "bun:test";
import btwExtension, {
	BTW_SYSTEM_PROMPT,
	BtwHistory,
	MAX_CONVERSATION_CHARS,
	MAX_HISTORY,
	buildBtwPrompt,
	buildConversationText,
	btwKeyAction,
	capTail,
	extractAssistantText,
} from "../extensions/btw.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;
type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface CompleteCall {
	model: unknown;
	context: {
		systemPrompt?: string;
		messages: unknown[];
		tools?: unknown;
	};
	options: Record<string, unknown>;
}

function makeHarness(
	options: {
		mode?: "tui" | "rpc" | "print";
		hasUI?: boolean;
		model?: { id: string; provider: string } | null;
		entries?: unknown[];
		complete?: (call: CompleteCall) => Promise<{
			content: unknown;
			stopReason: string;
			errorMessage?: string;
		}>;
		custom?: (
			factory: (
				tui: unknown,
				theme: unknown,
				kb: unknown,
				done: (value: unknown) => void,
			) => { handleInput?: (data: string) => void },
		) => Promise<unknown>;
	} = {},
) {
	const commands = new Map<string, { description: string; handler: Handler }>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const notices: { message: string; type?: string }[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	const completeCalls: CompleteCall[] = [];
	const sent: string[] = [];
	let customCalls = 0;

	const pi = {
		on(event: string, handler: EventHandler) {
			const list = eventHandlers.get(event) ?? [];
			list.push(handler);
			eventHandlers.set(event, list);
		},
		registerCommand(
			name: string,
			def: { description: string; handler: Handler },
		) {
			commands.set(name, def);
		},
		sendUserMessage(text: string) {
			sent.push(text);
		},
	};

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		cwd: "/tmp",
		model:
			options.model === null
				? undefined
				: (options.model ?? { id: "gpt-test", provider: "openai" }),
		isIdle: () => true,
		sessionManager: {
			buildContextEntries: () => options.entries ?? [],
			getBranch: () => options.entries ?? [],
		},
		modelRegistry: {
			complete: async (
				model: unknown,
				context: CompleteCall["context"],
				opts: Record<string, unknown> = {},
			) => {
				const call = { model, context, options: opts };
				completeCalls.push(call);
				if (options.complete) return options.complete(call);
				return {
					content: [{ type: "text", text: "side answer" }],
					stopReason: "stop",
				};
			},
		},
		ui: {
			theme,
			notify(message: string, type?: string) {
				notices.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: (value: unknown) => void,
				) => { handleInput?: (data: string) => void },
			) => {
				customCalls += 1;
				if (options.custom) return options.custom(factory);
				await new Promise<void>((resolve) => {
					factory(
						{ requestRender() {}, terminal: { rows: 24, columns: 80 } },
						theme,
						{},
						() => resolve(),
					);
					queueMicrotask(() => resolve());
				});
			},
		},
	};

	btwExtension(pi as never);
	return {
		commands,
		notices,
		statuses,
		completeCalls,
		sent,
		get customCalls() {
			return customCalls;
		},
		ctx,
		async run(args: string) {
			const cmd = commands.get("btw");
			if (!cmd) throw new Error("btw not registered");
			await cmd.handler(args, ctx);
		},
		shutdown() {
			for (const handler of eventHandlers.get("session_shutdown") ?? []) {
				handler({}, ctx);
			}
		},
	};
}

describe("buildConversationText", () => {
	test("includes user, assistant, tool calls, tool results, compaction, and bash", () => {
		const text = buildConversationText([
			{
				type: "compaction",
				summary: "Earlier work set up auth.",
			},
			{
				type: "message",
				message: { role: "user", content: "wire login" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll read the config." },
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "src/auth.ts" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "text", text: "export function login() {}" }],
				},
			},
			{
				type: "message",
				message: {
					role: "bashExecution",
					command: "git status",
					output: "clean",
				},
			},
			{
				type: "message",
				message: {
					role: "bashExecution",
					command: "secret",
					output: "nope",
					excludeFromContext: true,
				},
			},
		]);

		expect(text).toContain("Compaction summary:");
		expect(text).toContain("Earlier work set up auth.");
		expect(text).toContain("User: wire login");
		expect(text).toContain("I'll read the config.");
		expect(text).toContain("called read(");
		expect(text).toContain("src/auth.ts");
		expect(text).toContain("Tool result (read):");
		expect(text).toContain("export function login() {}");
		expect(text).toContain("$ git status");
		expect(text).toContain("clean");
		expect(text).not.toContain("secret");
		expect(text).not.toContain("nope");
	});

	test("caps a huge dump from the tail", () => {
		const entries = [];
		for (let i = 0; i < 4000; i++) {
			entries.push({
				type: "message",
				message: { role: "user", content: `msg-${i}-${"x".repeat(40)}` },
			});
		}
		const text = capTail(buildConversationText(entries), MAX_CONVERSATION_CHARS);
		expect(text.length <= MAX_CONVERSATION_CHARS).toBe(true);
		expect(text.startsWith("…[earlier conversation truncated]\n")).toBe(true);
		expect(text).toContain("msg-3999");
		expect(text).not.toContain("msg-0-");
	});
});

describe("buildBtwPrompt", () => {
	test("wraps conversation, prior side questions, and the new question", () => {
		const prompt = buildBtwPrompt({
			conversation: "User: hi\n\nAssistant: hello",
			sideQuestions: [{ question: "file name?", answer: "config.ts" }],
			question: "what does retry do?",
		});
		expect(prompt).toContain("<conversation>");
		expect(prompt).toContain("User: hi");
		expect(prompt).toContain("<side-questions>");
		expect(prompt).toContain("Q: file name?");
		expect(prompt).toContain("A: config.ts");
		expect(prompt).toContain("<question>");
		expect(prompt).toContain("what does retry do?");
	});

	test("notes an empty main conversation", () => {
		const prompt = buildBtwPrompt({
			conversation: "",
			sideQuestions: [],
			question: "syntax for useEffect cleanup?",
		});
		expect(prompt).toContain("The main conversation is empty.");
		expect(prompt).not.toContain("<conversation>");
		expect(prompt).not.toContain("<side-questions>");
		expect(prompt).toContain("syntax for useEffect cleanup?");
	});
});

describe("BtwHistory", () => {
	test("caps at MAX_HISTORY and steps older/newer", () => {
		const history = new BtwHistory();
		for (let i = 0; i < MAX_HISTORY + 3; i++) {
			history.push({ question: `q${i}`, answer: `a${i}` });
		}
		expect(history.length).toBe(MAX_HISTORY);
		expect(history.latest()?.question).toBe(`q${MAX_HISTORY + 2}`);
		expect(history.current()?.question).toBe(`q${MAX_HISTORY + 2}`);

		expect(history.stepOlder()).toBe(true);
		expect(history.current()?.question).toBe(`q${MAX_HISTORY + 1}`);
		history.jumpToLatest();
		expect(history.current()?.question).toBe(`q${MAX_HISTORY + 2}`);
		expect(history.stepNewer()).toBe(false);
	});

	test("previousVisible shows five newest earlier questions", () => {
		const history = new BtwHistory();
		for (let i = 0; i < 8; i++) {
			history.push({ question: `q${i}`, answer: `a${i}` });
		}
		const { questions, olderCount } = history.previousVisible();
		expect(questions).toEqual(["q2", "q3", "q4", "q5", "q6"]);
		expect(olderCount).toBe(2);
	});

	test("clearEarlier keeps the viewed exchange only", () => {
		const history = new BtwHistory();
		history.push({ question: "one", answer: "a" });
		history.push({ question: "two", answer: "b" });
		history.push({ question: "three", answer: "c" });
		history.stepOlder();
		history.clearEarlier();
		expect(history.snapshot()).toEqual([{ question: "two", answer: "b" }]);
	});
});

describe("btwKeyAction", () => {
	test("escape/enter/space dismiss even while answering", () => {
		expect(btwKeyAction("\x1b", true).type).toBe("dismiss");
		expect(btwKeyAction("\r", false).type).toBe("dismiss");
		expect(btwKeyAction(" ", false).type).toBe("dismiss");
	});

	test("ignores history and copy while answering", () => {
		expect(btwKeyAction("c", true).type).toBe("none");
		expect(btwKeyAction("[", true).type).toBe("none");
		expect(btwKeyAction("x", true).type).toBe("none");
	});

	test("maps scroll, history, copy, and clear after the answer lands", () => {
		expect(btwKeyAction("\x1b[A", false)).toEqual({ type: "scroll", delta: -1 });
		expect(btwKeyAction("\x1b[B", false)).toEqual({ type: "scroll", delta: 1 });
		expect(btwKeyAction("[", false)).toEqual({ type: "history", delta: -1 });
		expect(btwKeyAction("]", false)).toEqual({ type: "history", delta: 1 });
		expect(btwKeyAction("\x1b[D", false)).toEqual({ type: "history", delta: -1 });
		expect(btwKeyAction("\x1b[C", false)).toEqual({ type: "history", delta: 1 });
		expect(btwKeyAction("c", false)).toEqual({ type: "copy" });
		expect(btwKeyAction("x", false)).toEqual({ type: "clear" });
	});
});

describe("extractAssistantText", () => {
	test("joins text blocks", () => {
		expect(
			extractAssistantText([
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]),
		).toBe("first\nsecond");
	});
});

describe("/btw command", () => {
	test("registers the command", () => {
		const harness = makeHarness();
		expect(harness.commands.has("btw")).toBe(true);
		expect(harness.commands.get("btw")!.description.toLowerCase()).toContain(
			"side question",
		);
	});

	test("bare /btw with empty history prints usage", async () => {
		const harness = makeHarness({ mode: "print" });
		await harness.run("");
		expect(harness.notices[0]?.message).toContain("/btw <question>");
		expect(harness.completeCalls.length).toBe(0);
	});

	test("errors when no model is selected", async () => {
		const harness = makeHarness({ model: null });
		await harness.run("what?");
		expect(harness.notices[0]?.type).toBe("error");
		expect(harness.completeCalls.length).toBe(0);
	});

	test("print mode answers without writing a user message or passing tools", async () => {
		const harness = makeHarness({
			mode: "print",
			entries: [
				{
					type: "message",
					message: { role: "user", content: "fix the retry loop" },
				},
			],
		});
		await harness.run("what does the retry logic do?");

		expect(harness.sent.length).toBe(0);
		expect(harness.completeCalls.length).toBe(1);
		const call = harness.completeCalls[0]!;
		expect(call.context.tools).toBeUndefined();
		expect(call.context.systemPrompt).toBe(BTW_SYSTEM_PROMPT);
		expect(call.options.cacheRetention).toBe("none");
		const userText = JSON.stringify(call.context.messages);
		expect(userText).toContain("fix the retry loop");
		expect(userText).toContain("what does the retry logic do?");
		expect(harness.notices.some((n) => n.message === "side answer")).toBe(true);
	});

	test("bare /btw after an answer reopens without a new complete()", async () => {
		const harness = makeHarness({ mode: "print" });
		await harness.run("file name?");
		expect(harness.completeCalls.length).toBe(1);
		await harness.run("");
		expect(harness.completeCalls.length).toBe(1);
		expect(harness.notices.at(-1)?.message).toContain("file name?");
		expect(harness.notices.at(-1)?.message).toContain("side answer");
	});

	test("refuses a second /btw while the overlay is open", async () => {
		let release: (() => void) | undefined;
		const harness = makeHarness({
			custom: () =>
				new Promise((resolve) => {
					release = () => resolve(undefined);
				}),
		});
		const first = harness.run("one");
		await Promise.resolve();
		await Promise.resolve();
		await harness.run("two");
		expect(harness.notices.some((n) => n.message.includes("already open"))).toBe(
			true,
		);
		release?.();
		await first;
	});

	test("tui overlay complete() is isolated and dismissed without sendUserMessage", async () => {
		const harness = makeHarness({
			entries: [
				{
					type: "message",
					message: { role: "user", content: "implement /btw" },
				},
			],
			custom: async (factory) => {
				await new Promise<void>((resolve) => {
					factory(
						{ requestRender() {}, terminal: { rows: 24, columns: 80 } },
						{
							fg: (_c: string, t: string) => t,
							bold: (t: string) => t,
						},
						{},
						() => resolve(),
					);
					queueMicrotask(() => {
						queueMicrotask(() => resolve());
					});
				});
			},
		});
		await harness.run("did we already add the overlay?");
		expect(harness.sent.length).toBe(0);
		expect(harness.completeCalls.length).toBe(1);
		expect(harness.customCalls).toBe(1);
		expect(harness.completeCalls[0]!.context.tools).toBeUndefined();
	});

	test("aborted complete() does not notify an answer in print mode", async () => {
		const harness = makeHarness({
			mode: "print",
			complete: async () => ({ content: [], stopReason: "aborted" }),
		});
		await harness.run("ping");
		expect(harness.notices.some((n) => n.message === "side answer")).toBe(false);
		await harness.run("");
		expect(harness.notices.at(-1)?.message).toContain("/btw <question>");
	});
});
