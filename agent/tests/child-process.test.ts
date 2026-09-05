import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { runChild } from "../extensions/process/child.ts";

type FakeChild = EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
	kill: (signal?: string) => boolean;
	killed: boolean;
};

function makeFakeChild(): { child: FakeChild; signals: string[] } {
	const signals: string[] = [];
	const child = new EventEmitter() as FakeChild;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killed = false;
	child.kill = (signal?: string) => {
		signals.push(signal ?? "SIGTERM");
		child.killed = true;
		return true;
	};
	return { child, signals };
}

const spawnFake = (child: FakeChild) =>
	((_command: string, _args: readonly string[], _options: unknown) =>
		child) as unknown as typeof spawn;

const settle = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));
const failure = (promise: Promise<unknown>): Promise<string> =>
	promise.then(
		() => {
			throw new Error("Expected child rejection");
		},
		(error: Error) => error.message,
	);

describe("runChild", () => {
	test("already-aborted signal never spawns", async () => {
		const ac = new AbortController();
		ac.abort();
		const { child } = makeFakeChild();
		let spawned = false;
		const spawnFn = (() => {
			spawned = true;
			return child;
		}) as unknown as typeof spawn;
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 1_000, signal: ac.signal },
			spawnFn,
		);
		p.catch(() => {});
		expect(spawned).toBe(false);
		expect(await failure(p)).toBe("Child aborted");
	});

	test("abort escalates after SIGTERM even when killed=true", async () => {
		const ac = new AbortController();
		const { child, signals } = makeFakeChild();
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 1_000, signal: ac.signal, killGraceMs: 5 },
			spawnFake(child),
		);
		p.catch(() => {});
		try {
			ac.abort();
			expect(await failure(p)).toBe("Child aborted");
			expect(signals).toEqual(["SIGTERM"]);
			expect(child.killed).toBe(true);
			await settle(20);
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
		}
	});

	test("emit exit/close after abort clears the kill escalation", async () => {
		const ac = new AbortController();
		const { child, signals } = makeFakeChild();
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 1_000, signal: ac.signal, killGraceMs: 5 },
			spawnFake(child),
		);
		p.catch(() => {});
		try {
			ac.abort();
			expect(await failure(p)).toBe("Child aborted");
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
			await settle(20);
			expect(signals).toEqual(["SIGTERM"]);
		} finally {
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
		}
	});

	test("graceful exit before the grace period avoids SIGKILL", async () => {
		const ac = new AbortController();
		const { child, signals } = makeFakeChild();
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 1_000, signal: ac.signal, killGraceMs: 50 },
			spawnFake(child),
		);
		p.catch(() => {});
		try {
			ac.abort();
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
			await settle(80);
			expect(signals).toEqual(["SIGTERM"]);
		} finally {
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
		}
	});

	test("successful stdout resolves trimmed and a later abort causes no kill", async () => {
		const ac = new AbortController();
		const { child, signals } = makeFakeChild();
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 1_000, signal: ac.signal },
			spawnFake(child),
		);
		p.catch(() => {});
		try {
			child.stdout.write("  hello \n world  ");
			child.emit("exit", 0, null);
			child.emit("close", 0);
			expect(await p).toBe("hello \n world");
			ac.abort();
			expect(signals).toEqual([]);
		} finally {
			child.emit("exit", 0, null);
			child.emit("close", 0);
		}
	});

	test("maxOutputBytes rejects an oversized chunk and terminates", async () => {
		const { child, signals } = makeFakeChild();
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 1_000, maxOutputBytes: 4, killGraceMs: 5 },
			spawnFake(child),
		);
		p.catch(() => {});
		try {
			child.stdout.write(Buffer.from("12345"));
			expect(await failure(p)).toContain("byte limit");
			expect(signals).toEqual(["SIGTERM"]);
		} finally {
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
		}
	});

	test("timeoutMs rejects and terminates with SIGTERM then SIGKILL", async () => {
		const { child, signals } = makeFakeChild();
		const p = runChild(
			"cmd",
			[],
			{ cwd: ".", timeoutMs: 5, killGraceMs: 5 },
			spawnFake(child),
		);
		p.catch(() => {});
		try {
			expect(await failure(p)).toContain("timed out");
			expect(signals).toEqual(["SIGTERM"]);
			await settle(20);
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			child.emit("exit", null, "SIGTERM");
			child.emit("close", null);
		}
	});
});
