/**
 * Regression tests for the pre-execution security gate.
 *
 *   bun test agent/tests/security-gate.test.ts
 *
 * Covers:
 *  - tool_call blocking of credential/protected paths for read/write/edit
 *  - allowed near-miss paths (.environment, auth.json.example, source files)
 *  - bash: credential paths blocked even with UI confirmation available,
 *    risky commands gated on terminal/RPC confirmation, normal commands pass
 *  - user_bash applying the same credential and risky-command rules
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import securityGate from "../extensions/security-gate.ts";
import { CommandConfirm } from "../extensions/security/command-confirm.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface UICall {
	kind: "confirm" | "notify";
	args: unknown[];
}

function makeHarness(opts: {
	hasUI: boolean;
	confirmResult?: boolean;
	mode?: "tui" | "rpc";
	custom?: (...args: any[]) => Promise<boolean | undefined>;
	emitError?: boolean;
}) {
	const handlers = new Map<string, Handler[]>();
	const uiCalls: UICall[] = [];
	const attentionEvents: { name: string; data: unknown }[] = [];

	const pi = {
		events: {
			emit(name: string, data: unknown) {
				attentionEvents.push({ name, data });
				if (opts.emitError) throw new Error("notification listener failed");
			},
		},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	const ctx = {
		hasUI: opts.hasUI,
		mode: opts.mode ?? "rpc",
		cwd: "/tmp/security-gate-test",
		ui: {
			custom: opts.custom,
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

	return { fire, uiCalls, attentionEvents };
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

describe("terminal risky-command confirmation", () => {
	test("long commands use a bounded custom dialog, not the unscrollable confirm message", async () => {
		let customShown = false;
		const h = makeHarness({
			hasUI: true,
			mode: "tui",
			custom: async (factory, options) => {
				customShown = true;
				expect(options.overlay).toBe(true);
				const dialog = factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					() => {},
				);
				const lines = dialog.render(80);
				expect(lines.length <= 20).toBe(true);
				expect(lines.join("\n")).toContain("Run risky command?");
				expect(lines.join("\n")).toContain("No");
				expect(lines.join("\n")).toContain("Yes");
				return false;
			},
		});
		const command = "echo 'reboot\n" + "long plan text\n".repeat(200) + "'";
		const [result] = await h.fire("tool_call", toolCall("bash", { command }));
		expect(customShown).toBe(true);
		expect(result).toMatchObject({ block: true });
		expect(h.uiCalls).toHaveLength(0);
	});
});

describe("herdr risky-command attention", () => {
	const active = { name: "herdr:blocked", data: { active: true, label: "Risky command approval" } };
	const inactive = { name: "herdr:blocked", data: { active: false } };
	const payload = (event: string) => event === "tool_call"
		? toolCall("bash", { command: "echo 'reboot PRIVATE_TEST_TEXT'" })
		: { command: "echo 'reboot PRIVATE_TEST_TEXT'" };

	for (const event of ["tool_call", "user_bash"]) {
		for (const approved of [true, false, undefined]) {
			test(`${event}: attention surrounds the dialog and clears on ${approved}`, async () => {
				const h = makeHarness({ hasUI: true, mode: "tui", custom: async () => {
					expect(h.attentionEvents).toEqual([active]);
					return approved;
				} });
				await h.fire(event, payload(event));
				expect(h.attentionEvents).toEqual([active, inactive]);
			});
		}

		test(`${event}: a failed dialog clears attention before propagating its error`, async () => {
			const error = new Error("dialog failed");
			const h = makeHarness({ hasUI: true, mode: "tui", custom: async () => { throw error; } });
			const result = await h.fire(event, payload(event)).catch((err) => err);
			expect(result).toBe(error);
			expect(h.attentionEvents).toEqual([active, inactive]);
		});

		test(`${event}: RPC and headless sessions do not report pane attention`, async () => {
			for (const hasUI of [true, false]) {
				const h = makeHarness({ hasUI, mode: "rpc" });
				await h.fire(event, payload(event));
				expect(h.attentionEvents).toEqual([]);
			}
		});
	}

	test("notification failures cannot change the user's rejection", async () => {
		const h = makeHarness({ hasUI: true, mode: "tui", emitError: true, custom: async () => false });
		const [result] = await h.fire("tool_call", payload("tool_call"));
		expect(result).toMatchObject({ block: true, reason: "Blocked by user" });
		expect(h.attentionEvents).toEqual([active, inactive]);
	});

	test("safe commands and protected-path blocks do not report an approval prompt", async () => {
		const h = makeHarness({ hasUI: true, mode: "tui" });
		await h.fire("tool_call", toolCall("bash", { command: "echo hello" }));
		await h.fire("tool_call", toolCall("bash", { command: "cat .env" }));
		expect(h.attentionEvents).toEqual([]);
	});
});

describe("scrollable command dialog", () => {
	const command = Array.from({ length: 200 }, (_, i) => `command-line-${i}`).join("\n");
	function dialogFor(text = command) {
		const results: boolean[] = [];
		let renders = 0;
		const terminal = { rows: 24 };
		const dialog = new CommandConfirm(text, ["test risk"], {
			terminal: terminal as never,
			requestRender() { renders++; },
		}, {
			fg: (_color, value) => value,
			bold: (value) => value,
		}, (value) => results.push(value));
		return { dialog, terminal, results, renders: () => renders };
	}

	test("every command line is reachable, with fixed controls and bounded rows", () => {
		const h = dialogFor();
		const seen = new Set<string>();
		for (let i = 0; i < 220; i++) {
			const lines = h.dialog.render(80);
			expect(lines.length <= 19).toBe(true);
			expect(lines.every((line) => line.length <= 80)).toBe(true);
			expect(lines.slice(-6).join("\n")).toContain("[ No ]     Yes");
			for (const line of lines) seen.add(line.trim());
			h.dialog.handleInput("\x1b[B");
		}
		for (const line of command.split("\n")) expect(seen.has(line)).toBe(true);
		expect(h.results).toEqual([]);
		expect(h.renders() > 0).toBe(true);
	});

	test("page, home, end, and up keys navigate without selecting approval", () => {
		const h = dialogFor();
		const initial = h.dialog.render(80);
		h.dialog.handleInput("\x1b[6~"); // Page Down
		expect(h.dialog.render(80).join("\n")).toContain("Lines 12-22 of 202");
		h.dialog.handleInput("\x1b[5~"); // Page Up
		expect(h.dialog.render(80)).toEqual(initial);
		h.dialog.handleInput("\x1b[F"); // End
		expect(h.dialog.render(80).join("\n")).toContain("command-line-199");
		h.dialog.handleInput("\x1b[A"); // Up
		expect(h.dialog.render(80).join("\n")).not.toContain("command-line-199");
		h.dialog.handleInput("\x1b[H"); // Home
		expect(h.dialog.render(80)).toEqual(initial);
		h.dialog.handleInput("\r");
		expect(h.results).toEqual([false]);
	});

	test("wraps long lines and clamps the scroll position after resize", () => {
		const h = dialogFor("x".repeat(10000) + "TAIL");
		expect(h.dialog.render(60).every((line) => line.length <= 60)).toBe(true);
		h.dialog.handleInput("\x1b[F");
		expect(h.dialog.render(60).join("\n")).toContain("TAIL");
		h.terminal.rows = 40;
		const resized = h.dialog.render(120);
		expect(resized.length <= 32).toBe(true);
		expect(resized.join("\n")).toContain("TAIL");
		expect(resized.every((line) => line.length <= 120)).toBe(true);
		h.dialog.invalidate();
		expect(h.dialog.render(120)).toEqual(resized);
	});

	for (const cancel of ["\r", "\x1b", "\x03"]) {
		test(`default/cancel key ${JSON.stringify(cancel)} denies`, () => {
			const h = dialogFor();
			h.dialog.render(80);
			h.dialog.handleInput(cancel);
			h.dialog.handleInput("\t");
			h.dialog.handleInput("\r");
			expect(h.results).toEqual([false]);
		});
	}

	test("only explicitly selecting Yes then Enter approves", () => {
		const h = dialogFor();
		h.dialog.render(80);
		h.dialog.handleInput("\t");
		expect(h.results).toEqual([]);
		expect(h.dialog.render(80).join("\n")).toContain("[ Yes ]");
		h.dialog.handleInput("\r");
		expect(h.results).toEqual([true]);
	});

	test("tiny terminals cannot approve; resizing restores No as default", () => {
		const h = dialogFor();
		h.dialog.render(80);
		h.dialog.handleInput("\t");
		h.terminal.rows = 4;
		expect(h.dialog.render(20).length <= 3).toBe(true);
		h.dialog.handleInput("\r");
		expect(h.results).toEqual([]);
		h.terminal.rows = 24;
		expect(h.dialog.render(80).join("\n")).toContain("[ No ]");
		h.dialog.handleInput("\r");
		expect(h.results).toEqual([false]);
	});

	test("terminal escape/control characters are displayed, not interpreted", () => {
		const h = dialogFor("echo \x1b[2J\rhidden\x07\tend");
		const rendered = h.dialog.render(80).join("\n");
		expect(rendered).toContain("echo \\x1b[2J\\x0dhidden\\x07    end");
		expect(rendered.includes("\x1b")).toBe(false);
	});
});

for (const event of ["tool_call", "user_bash"]) {
	for (const approved of [true, false, undefined]) {
		test(`${event}: terminal result ${approved} is handled safely`, async () => {
			let dialogs = 0;
			const h = makeHarness({ hasUI: true, mode: "tui", custom: async () => {
				dialogs++;
				return approved;
			} });
			const [result] = await h.fire(event, event === "tool_call"
				? toolCall("bash", { command: "reboot" }) : { command: "reboot" });
			expect(dialogs).toBe(1);
			if (approved) expect(result).toBeUndefined();
			else expect(result).toMatchObject(event === "tool_call"
				? { block: true } : { result: { exitCode: 126, cancelled: true } });
			expect(h.uiCalls).toHaveLength(0);
		});
	}
}

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

describe("symlink resolution", () => {
	// Dummy fixtures under a workspace-local temp dir. All contents are dummy
	// strings — no real credential files are ever read or referenced.
	const fixtureRoot = join(import.meta.dirname, "../tmp");
	mkdirSync(fixtureRoot, { recursive: true });
	const tmp = mkdtempSync(join(fixtureRoot, "security-tests-"));

	// Harmlessly named symlink → dummy dot-env file: read must be blocked.
	const envDir = join(tmp, "env");
	mkdirSync(envDir, { recursive: true });
	const realEnv = join(envDir, "." + "env");
	writeFileSync(realEnv, "DUMMY_KEY=not-a-real-secret\n", "utf8");
	const envSymlink = join(tmp, "settings.json");
	symlinkSync(realEnv, envSymlink);

	// Symlink → dummy node_modules dir: writing a not-yet-existing child via
	// the symlink must be blocked.
	const realNodeModules = join(tmp, "node_modules");
	mkdirSync(realNodeModules, { recursive: true });
	const nmSymlink = join(tmp, "vendor");
	symlinkSync(realNodeModules, nmSymlink);

	// Near-miss: symlink to a plain dummy file stays allowed.
	const plain = join(tmp, "plain.txt");
	writeFileSync(plain, "harmless dummy text\n", "utf8");
	const plainSymlink = join(tmp, "readme.md");
	symlinkSync(plain, plainSymlink);

	test("read blocks a harmlessly named symlink to a dummy dot-env file", async () => {
		const h = makeHarness({ hasUI: true });
		const [result] = await h.fire(
			"tool_call",
			toolCall("read", { path: envSymlink }),
		);
		expect(result).toMatchObject({ block: true });
	});

	test("write blocks a not-yet-existing child under a symlink to node_modules", async () => {
		const h = makeHarness({ hasUI: true });
		const [result] = await h.fire(
			"tool_call",
			toolCall("write", {
				path: join(nmSymlink, "new-file.js"),
				content: "x",
			}),
		);
		expect(result).toMatchObject({ block: true });
	});

	test("near-miss stays allowed: symlink to a plain dummy file is readable", async () => {
		const h = makeHarness({ hasUI: true });
		const [result] = await h.fire(
			"tool_call",
			toolCall("read", { path: plainSymlink }),
		);
		expect(result).toBeUndefined();
		expect(h.uiCalls).toHaveLength(0);
	});
});
