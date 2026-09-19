import { describe, expect, test } from "bun:test";
import questionAttention from "../extensions/question-attention.ts";

const QUESTION_BLOCKED = "rpiv:ask-user:blocked";

function harness(mode = "tui") {
	const handlers = new Map<string, Function>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const reports: unknown[] = [];
	let failNotifications = false;
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, handler); },
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const set = listeners.get(name) ?? new Set();
				set.add(handler); listeners.set(name, set);
				return () => { set.delete(handler); };
			},
			emit(name: string, data: unknown) {
				if (name === "herdr:blocked") {
					if (failNotifications) throw new Error("notification unavailable");
					reports.push(data);
				}
				for (const handler of listeners.get(name) ?? []) handler(data);
			},
		},
	};
	questionAttention(pi as never);
	return {
		reports,
		start: () => handlers.get("session_start")!({}, { mode, hasUI: mode !== "print" }),
		stop: () => handlers.get("session_shutdown")!({}, {}),
		emit: (data: unknown) => pi.events.emit(QUESTION_BLOCKED, data),
		listenerCount: () => listeners.get(QUESTION_BLOCKED)?.size ?? 0,
		failNotifications: () => { failNotifications = true; },
	};
}

const blocked = { active: true, label: "Question awaiting answer" };
const unblocked = { active: false };

describe("question attention", () => {
	test("forwards only the wait state and a generic label, not question content", () => {
		const h = harness(); h.start();
		h.emit({ active: true, questions: ["synthetic private question"], answer: "synthetic answer" });
		expect(h.reports).toEqual([blocked]);
		h.emit({ active: false });
		expect(h.reports).toEqual([blocked, unblocked]);
		h.stop();
		expect(h.reports).toHaveLength(2);
	});

	test("overlapping questions stay blocked until the final wait ends", () => {
		const h = harness(); h.start();
		h.emit({ active: false }); // Must not clear another integration's attention.
		h.emit({ active: true }); h.emit({ active: true });
		h.emit({ active: false });
		expect(h.reports).toEqual([blocked]);
		h.emit({ active: false }); h.emit({ active: false });
		expect(h.reports).toEqual([blocked, unblocked]);
		h.stop();
	});

	test("reload and shutdown clear attention once and remove old listeners", () => {
		const h = harness(); h.start(); h.emit({ active: true });
		h.start();
		expect(h.reports).toEqual([blocked, unblocked]);
		expect(h.listenerCount()).toBe(1);
		h.emit({ active: true }); h.stop(); h.stop();
		expect(h.reports).toEqual([blocked, unblocked, blocked, unblocked]);
		expect(h.listenerCount()).toBe(0);
		h.emit({ active: true });
		expect(h.reports).toHaveLength(4);
	});

	test("RPC and print never signal attention for a local pane", () => {
		for (const mode of ["rpc", "print"]) {
			const h = harness(mode); h.start();
			h.emit({ active: true }); h.emit({ active: false }); h.stop();
			expect(h.reports).toEqual([]);
			expect(h.listenerCount()).toBe(0);
		}
	});

	test("ignores malformed events and events outside an active session", () => {
		const h = harness(); h.emit({ active: true }); h.start();
		for (const data of [null, undefined, false, "active", {}, { active: "true" }, { active: 1 }]) h.emit(data);
		expect(h.reports).toEqual([]);
		h.stop();
	});

	test("notification failures cannot interrupt answering or lifecycle cleanup", () => {
		const h = harness(); h.start(); h.failNotifications();
		expect(() => { h.emit({ active: true }); h.emit({ active: false }); h.stop(); }).not.toThrow();
		expect(h.listenerCount()).toBe(0);
	});
});
