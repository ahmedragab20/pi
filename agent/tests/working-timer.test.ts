import { describe, expect, test } from "bun:test";
import workingTimerExtension, {
	formatElapsed,
} from "../extensions/working-timer.ts";

type EventHandler = (
	event: unknown,
	ctx: unknown,
) => unknown | Promise<unknown>;

function makePi() {
	const handlers = new Map<string, EventHandler[]>();
	let command:
		| { handler: (args: string, ctx: unknown) => Promise<void> }
		| undefined;
	const pi = {
		on(name: string, handler: EventHandler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(
			_name: string,
			definition: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			command = definition;
		},
	};
	return { pi, handlers, getCommand: () => command };
}

describe("working timer", () => {
	test("formatElapsed renders mm:ss and h:mm:ss", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(65_000)).toBe("01:05");
		expect(formatElapsed(3_723_000)).toBe("1:02:03");
	});

	test("keeps timing off persistent chrome and exposes it through /timing", async () => {
		const { pi, handlers, getCommand } = makePi();
		workingTimerExtension(pi as never);

		const statuses = new Map<string, string | undefined>();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus(key: string, text?: string) {
					statuses.set(key, text);
				},
				notify(message: string) {
					notices.push(message);
				},
			},
		};

		let now = 1_000;
		const realNow = Date.now;
		try {
			Date.now = () => now;
			await handlers.get("session_start")![0]({}, ctx);
			expect(statuses.get("working-timer")).toBeUndefined();

			await getCommand()!.handler("", ctx);
			expect(notices.at(-1)).toBe("No run timing yet");

			await handlers.get("agent_start")![0]({}, ctx);
			now += 65_000;
			await getCommand()!.handler("", ctx);
			expect(notices.at(-1)).toBe("Working for 01:05");

			await handlers.get("agent_settled")![0]({}, ctx);
			await getCommand()!.handler("", ctx);
			expect(notices.at(-1)).toBe("Last run 01:05");
			expect([...statuses.entries()]).toEqual([["working-timer", undefined]]);
		} finally {
			Date.now = realNow;
		}
	});
});
