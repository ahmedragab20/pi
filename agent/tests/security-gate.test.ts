/**
 * Regression tests for the pre-execution security gate.
 *
 *   bun test agent/tests/security-gate.test.ts
 *
 * Covers:
 *  - tool_call blocking of credential/protected paths for read/write/edit
 *  - allowed near-miss paths (.environment, auth.json.example, source files)
 *  - bash: credential paths blocked even with UI confirmation available,
 *    risky commands gated on ctx.hasUI and ui.confirm, normal commands pass
 *  - user_bash applying the same credential and risky-command rules
 */

import { describe, expect, test } from "bun:test";
import securityGate from "../extensions/security-gate.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface UICall {
	kind: "confirm" | "notify";
	args: unknown[];
}

function makeHarness(opts: { hasUI: boolean; confirmResult?: boolean }) {
	const handlers = new Map<string, Handler[]>();
	const uiCalls: UICall[] = [];

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	const ctx = {
		hasUI: opts.hasUI,
		cwd: "/tmp/security-gate-test",
		ui: {
			confirm: (...args: unknown[]) => {
				uiCalls.push({ kind: "confirm", args });
				return Promise.resolve(opts.confirmResult ?? false);
			},
			notify: (...args: unknown[]) => {
				uiCalls.push({ kind: "notify", args });
			},
		},
	};

	securityGate(pi as never);

	const fire = async (event: string, payload: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	};

	return { fire, uiCalls };
}

const toolCall = (toolName: string, input: Record<string, unknown>) => ({
	type: "tool_call",
	toolCallId: "call-1",
	toolName,
	input,
});

describe("tool_call protected path blocking", () => {
	const secretPaths = [
		".env",
		".env.local",
		"src/.git/config",
		".ssh/authorized_keys",
		"auth.json",
		"config/credentials.json",
		".npmrc",
		".netrc",
		"certs/server.pem",
		"keys/private.key",
		"certs/cert.p12",
		"certs/cert.pfx",
	];

	for (const path of secretPaths) {
		for (const toolName of ["read", "write", "edit"]) {
			test(`${toolName} blocks ${path}`, async () => {
				const h = makeHarness({ hasUI: true, confirmResult: true });
				const [result] = await h.fire(
					"tool_call",
					toolCall(toolName, { path, content: "x", oldText: "a", newText: "b" }),
				);
				expect(result).toMatchObject({ block: true });
				expect((result as { reason: string }).reason).toContain(
					"Protected path access is not allowed",
				);
			});
		}
	}

	for (const path of [
		"project/.git/hooks/pre-commit",
		"node_modules/left-pad/index.js",
		"packages/app/node_modules/pkg/dist/bundle.js",
	]) {
		test(`read allows write-protected ${path}`, async () => {
			const h = makeHarness({ hasUI: true });
			const [result] = await h.fire("tool_call", toolCall("read", { path }));
			expect(result).toBeUndefined();
		});
		for (const toolName of ["write", "edit"]) {
			test(`${toolName} blocks write-protected ${path}`, async () => {
				const h = makeHarness({ hasUI: true });
				const [result] = await h.fire(
					"tool_call",
					toolCall(toolName, { path, content: "x", oldText: "a", newText: "b" }),
				);
				expect(result).toMatchObject({ block: true });
			});
		}
	}

	for (const path of [
		".environment",
		"config/.environment",
		"auth.json.example",
		"src/index.ts",
		"package.json",
		"auth.json.sample.txt",
	]) {
		test(`read allows ${path}`, async () => {
			const h = makeHarness({ hasUI: true });
			const [result] = await h.fire("tool_call", toolCall("read", { path }));
			expect(result).toBeUndefined();
			expect(h.uiCalls).toHaveLength(0);
		});
	}
});

describe("bash tool_call", () => {
	test("credential path is blocked even when UI would confirm", async () => {
		const h = makeHarness({ hasUI: true, confirmResult: true });
		const [result] = await h.fire(
			"tool_call",
			toolCall("bash", { command: "cat .env" }),
		);
		expect(result).toMatchObject({
			block: true,
			reason: "Blocked shell access to a credential or protected path",
		});
		expect(h.uiCalls).toHaveLength(0);
	});

	test("risky command blocked with no UI", async () => {
		const h = makeHarness({ hasUI: false });
		const [result] = await h.fire(
			"tool_call",
			toolCall("bash", { command: "sudo rm -rf /tmp/x" }),
		);
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("no UI to confirm");
	});

	test("risky command blocked when UI confirmation is false", async () => {
		const h = makeHarness({ hasUI: true, confirmResult: false });
		const [result] = await h.fire(
			"tool_call",
			toolCall("bash", { command: "sudo systemctl restart x" }),
		);
		expect(result).toMatchObject({ block: true, reason: "Blocked by user" });
		expect(h.uiCalls).toHaveLength(1);
	});

	test("risky command runs after true confirmation", async () => {
		const h = makeHarness({ hasUI: true, confirmResult: true });
		const [result] = await h.fire(
			"tool_call",
			toolCall("bash", { command: "git push --force origin main" }),
		);
		expect(result).toBeUndefined();
		expect(h.uiCalls).toHaveLength(1);
		expect((h.uiCalls[0] as { kind: string }).kind).toBe("confirm");
	});

	test("normal command is allowed with no UI interaction", async () => {
		const h = makeHarness({ hasUI: true });
		const [result] = await h.fire(
			"tool_call",
			toolCall("bash", { command: "ls -la" }),
		);
		expect(result).toBeUndefined();
		expect(h.uiCalls).toHaveLength(0);
	});
});

describe("user_bash", () => {
	const userBash = (command: string) => ({
		type: "user_bash",
		command,
		excludeFromContext: false,
		cwd: "/tmp/security-gate-test",
	});

	test("credential path is blocked even when UI would confirm", async () => {
		const h = makeHarness({ hasUI: true, confirmResult: true });
		const [result] = await h.fire("user_bash", userBash("cat .npmrc"));
		expect(result).toMatchObject({
			result: {
				exitCode: 126,
				cancelled: true,
			},
		});
		expect((result as { result: { output: string } }).result.output).toContain(
			"Blocked shell access to a credential or protected path",
		);
		expect(h.uiCalls).toHaveLength(0);
	});

	test("risky command blocked with no UI", async () => {
		const h = makeHarness({ hasUI: false });
		const [result] = await h.fire(
			"user_bash",
			userBash("git reset --hard HEAD~1"),
		);
		expect(result).toMatchObject({
			result: { exitCode: 126, cancelled: true },
		});
		expect((result as { result: { output: string } }).result.output).toContain(
			"no UI to confirm",
		);
	});

	test("risky command blocked when UI confirmation is false", async () => {
		const h = makeHarness({ hasUI: true, confirmResult: false });
		const [result] = await h.fire("user_bash", userBash("pkill -f node"));
		expect(result).toMatchObject({
			result: { exitCode: 126, cancelled: true },
		});
		expect((result as { result: { output: string } }).result.output).toContain(
			"Blocked by user",
		);
	});

	test("risky command runs after true confirmation", async () => {
		const h = makeHarness({ hasUI: true, confirmResult: true });
		const [result] = await h.fire("user_bash", userBash("chmod -R 777 /tmp/x"));
		expect(result).toBeUndefined();
		expect(h.uiCalls).toHaveLength(1);
	});

	test("normal command is allowed with no UI interaction", async () => {
		const h = makeHarness({ hasUI: true });
		const [result] = await h.fire("user_bash", userBash("echo hello"));
		expect(result).toBeUndefined();
		expect(h.uiCalls).toHaveLength(0);
	});
});
