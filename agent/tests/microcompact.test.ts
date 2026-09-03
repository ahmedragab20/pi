import { describe, expect, test } from "bun:test";
import { registerMicrocompact } from "../extensions/efficiency/microcompact.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

type Message = {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
};

function readCall(id: string, offset: number, limit = 100): Message {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "read",
				id,
				arguments: { path: "src/large.ts", offset, limit },
			},
		],
	};
}

function readResult(id: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
	};
}

function makeHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand() {},
	};
	const ctx = { getContextUsage: () => ({ percent: 60 }) };
	registerMicrocompact(pi as never);
	return {
		fire(messages: Message[]) {
			const [handler] = handlers.get("context") ?? [];
			return handler?.({ messages }, ctx) as { messages: Message[] } | undefined;
		},
	};
}

function textOf(message: Message): string {
	const content = message.content as { type: string; text: string }[];
	return content.map((part) => part.text).join("\n");
}

describe("microcompact read folding", () => {
	test("different ranges of one file do not supersede each other", () => {
		const h = makeHarness();
		const messages = [
			readCall("read-1", 1),
			readResult("read-1", "first range"),
			readCall("read-2", 101),
			readResult("read-2", "second range"),
			{ role: "user", content: "continue" },
		];
		expect(h.fire(messages)).toBeUndefined();
	});

	test("an identical later range folds only the superseded result", () => {
		const h = makeHarness();
		const messages = [
			readCall("read-1", 1),
			readResult("read-1", "first range"),
			readCall("read-2", 1),
			readResult("read-2", "second range"),
			{ role: "user", content: "continue" },
		];
		const folded = h.fire(messages);
		expect(folded).toBeDefined();
		expect(textOf(folded!.messages[1])).toContain("[folded] read");
		expect(textOf(folded!.messages[3])).toBe("second range");
	});

	test("folding an auto-compressed result preserves its original dump path", () => {
		const h = makeHarness();
		const originalDump = "/tmp/original-read-dump.txt";
		const compressed = `[compressed] read 9KB / 300 lines → ${originalDump}\nKept 20 lines.\nlast output`;
		const messages = [
			readCall("read-1", 1),
			readResult("read-1", compressed),
			readCall("read-2", 1),
			readResult("read-2", "new result"),
			{ role: "user", content: "continue" },
		];
		const folded = h.fire(messages);
		expect(textOf(folded!.messages[1])).toContain(`→ ${originalDump} —`);
	});
});
