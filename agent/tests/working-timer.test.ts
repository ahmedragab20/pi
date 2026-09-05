import { describe, expect, test } from "bun:test";
import workingTimerExtension, {
	formatElapsed,
	formatThinking,
} from "../extensions/working-timer.ts";

type EventHandler = (
	event: unknown,
	ctx: unknown,
) => unknown | Promise<unknown>;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function makePi() {
	const handlers = new Map<string, EventHandler[]>();
	let thinkingLevel = "low";
	const pi = {
		on(name: string, handler: EventHandler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
	};
	return { pi, handlers };
}

describe("working timer", () => {
	test("formatElapsed renders mm:ss and h:mm:ss", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(65_000)).toBe("01:05");
		expect(formatElapsed(3_723_000)).toBe("1:02:03");
	});

	test("formatThinking colors known levels and falls back", () => {
		expect(formatThinking(plainTheme as never, "high")).toBe("high");
		expect(formatThinking(plainTheme as never, "weird")).toBe("weird");
	});

	test("shows elapsed and thinking while working, duration on settle", async () => {
		const { pi, handlers } = makePi();
		workingTimerExtension(pi as never);

		const workingMessages: (string | undefined)[] = [];
		const statuses = new Map<string, string | undefined>();
		const ctx = {
			hasUI: true,
			ui: {
				setWorkingMessage(message?: string) {
					workingMessages.push(message);
				},
				setStatus(key: string, text?: string) {
					statuses.set(key, text);
				},
				theme: plainTheme,
			},
		};

		let now = 0;
		const realNow = Date.now;
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		let intervalCb: (() => void) | undefined;
		let intervalCleared = false;
		try {
			Date.now = () => now;
			(globalThis as Record<string, unknown>).setInterval = (cb: () => void) => {
				intervalCb = cb;
				return 123 as unknown as ReturnType<typeof setInterval>;
			};
			(globalThis as Record<string, unknown>).clearInterval = () => {
				intervalCleared = true;
			};

			handlers.get("session_start")![0]({}, ctx);
			now = 1_000;
			await handlers.get("agent_start")![0]({}, ctx);
			expect(workingMessages.at(-1)).toBe("Working... 00:00 · low");

			now += 65_000;
			intervalCb!();
			expect(workingMessages.at(-1)).toBe("Working... 01:05 · low");

			pi.setThinkingLevel("high");
			await handlers.get("thinking_level_select")![0]({}, ctx);
			expect(workingMessages.at(-1)).toBe("Working... 01:05 · high");

			await handlers.get("agent_settled")![0]({}, ctx);
			expect(workingMessages.at(-1)).toBeUndefined();
			expect(statuses.get("working-timer")).toBe("last 01:05");
			expect(intervalCleared).toBe(true);

			intervalCleared = false;
			await handlers.get("agent_start")![0]({}, ctx);
			handlers.get("session_shutdown")![0]({}, ctx);
			expect(intervalCleared).toBe(true);
		} finally {
			Date.now = realNow;
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
	});
});
