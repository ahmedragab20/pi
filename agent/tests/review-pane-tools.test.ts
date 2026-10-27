import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import reviewerTools, { checkReadPath } from "../extensions/review-pane/tools.ts";
type ExtensionAPI = Parameters<typeof reviewerTools>[0];

const agent = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = join(agent, "tmp");
mkdirSync(scratch, { recursive: true });
const cwd = mkdtempSync(join(scratch, "review-tools-"));
writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");
writeFileSync(join(cwd, "..notes.md"), "inside checkout\n");
mkdirSync(join(cwd, "..cache"));
writeFileSync(join(cwd, "..cache/source.ts"), "inside checkout\n");
writeFileSync(join(cwd, ".env"), "test fixture; not a credential\n");
symlinkSync(join(cwd, ".env"), join(cwd, "alias"));
symlinkSync(agent, join(cwd, "outside"));
afterAll(() => {
	for (const name of ["source.ts", "..notes.md", "..cache/source.ts", ".env", "alias", "outside"]) unlinkSync(join(cwd, name));
	rmdirSync(join(cwd, "..cache"));
	rmdirSync(cwd);
});

// External pi APIs are the boundary; guards, schemas and payload hook are real.
function harness(runCommand?: (command: string, args: string[]) => { code: number; stdout: string }) {
	const events = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const calls: unknown[][] = [];
	let metadataPath: string | undefined;
	reviewerTools({
		registerFlag() {}, getFlag: () => metadataPath,
		on: (name: string, callback: (...args: any[]) => any) => events.set(name, callback),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		exec: async (...args: unknown[]) => {
			calls.push(args);
			return runCommand ? runCommand(args[0] as string, args[1] as string[]) : { code: 0, stdout: "{\"ok\":true}" };
		},
	} as unknown as ExtensionAPI);
	const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-6-astra" } };
	return { events, tools, calls, ctx, initialize(overrides: Record<string, unknown> = {}) {
		const runId = randomUUID().replaceAll("-", "");
		const rd = join(agent, "tmp/review-pane", runId);
		mkdirSync(rd, { recursive: true });
		metadataPath = join(rd, "meta.json");
		const priorPane = process.env.HERDR_PANE_ID;
		const priorHerdr = process.env.HERDR_ENV;
		process.env.HERDR_PANE_ID = "test:p2";
		process.env.HERDR_ENV = "1";
		writeFileSync(metadataPath, JSON.stringify({ run_id: runId, cwd, reviewer_pane: "test:p2",
			model: "openai-codex/gpt-6-astra", thinking: "max", fast: true, ...overrides }));
		try { events.get("session_start")!({}, ctx); }
		finally {
			if (priorPane === undefined) delete process.env.HERDR_PANE_ID;
			else process.env.HERDR_PANE_ID = priorPane;
			if (priorHerdr === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = priorHerdr;
			unlinkSync(metadataPath);
			rmdirSync(rd);
		}
		return runId;
	} };
}

describe("reviewer guards", () => {
	test("allows checkout reads, rejects secret aliases, escapes and recursive grep", () => {
		expect(checkReadPath("read", "source.ts", cwd)).toBeUndefined();
		expect(checkReadPath("grep", "source.ts", cwd)).toBeUndefined();
		for (const path of [".env", "alias", "outside/AGENTS.md", "missing"])
			expect(typeof checkReadPath("read", path, cwd)).toBe("string");
		expect(checkReadPath("grep", ".", cwd)).toContain("one explicit");
		expect(checkReadPath("ls", ".", cwd)).toBeUndefined();
	});

	test("allows dot-dot-prefixed children without allowing parent traversal", () => {
		for (const path of ["..notes.md", "..cache/source.ts"])
			expect(checkReadPath("read", path, cwd)).toBeUndefined();
		expect(checkReadPath("ls", "..", cwd)).toContain("inside the checkout");
	});

	test("forwards leading-dash filenames and findings through the real Python parser", async () => {
		const h = harness((command, args) => {
			const parse = "import importlib.util,json,sys; spec=importlib.util.spec_from_file_location('review',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps(vars(module.parser().parse_args(sys.argv[2:]))))";
			const result = spawnSync(command, ["-B", "-c", parse, ...args], { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout };
		});
		h.initialize();
		for (const path of ["-source.ts", "--help", "file=one.ts"]) {
			const result = await h.tools.get("review_diff").execute("parse-path", { path });
			expect(JSON.parse(result.content[0].text).path).toBe(path);
		}
		const result = await h.tools.get("review_record").execute("parse-report", { verdict: "LGTM", findings: "--synthetic-note" });
		expect(JSON.parse(result.content[0].text).findings).toBe("--synthetic-note");
	});

	test("fails closed before initialization and rejects write/shell/delegation tools", () => {
		const h = harness();
		const gate = h.events.get("tool_call")!;
		expect(gate({ toolName: "read", input: { path: "source.ts" } }, h.ctx).block).toBe(true);
		expect(() => h.events.get("session_start")!({}, h.ctx)).toThrow("required");
		h.initialize();
		for (const name of ["write", "edit", "bash", "Agent", "codemode", "mcp__anything"])
			expect(gate({ toolName: name, input: {} }, h.ctx).block).toBe(true);
		expect(gate({ toolName: "read", input: { path: "source.ts" } }, h.ctx)).toBeUndefined();
		expect(h.events.get("user_bash")!({}).result.exitCode).toBe(126);
	});

	test("rejects mismatched metadata and clears previous authorization on reinitialization", () => {
		for (const mismatch of [
			{ run_id: "0".repeat(32) }, { reviewer_pane: "test:wrong" }, { cwd: agent },
			{ model: "wrong/model" }, { thinking: "high" }, { fast: false },
		]) {
			const h = harness();
			h.initialize();
			expect(() => h.initialize(mismatch)).toThrow("does not match");
			expect(h.events.get("tool_call")!({ toolName: "read", input: { path: "source.ts" } }, h.ctx)).toMatchObject({ block: true });
		}
	});

	test("requests priority only for initialized Astra and preserves payload fields", () => {
		const h = harness();
		const hook = h.events.get("before_provider_request")!;
		const event = { payload: { model: "gpt-6-astra", stream: true } };
		expect(hook(event, h.ctx)).toBeUndefined();
		h.initialize();
		expect(hook(event, h.ctx)).toEqual({ model: "gpt-6-astra", stream: true, service_tier: "priority" });
		expect(hook(event, { model: { provider: "anthropic", id: "other" } })).toBeUndefined();
		expect(event.payload).toEqual({ model: "gpt-6-astra", stream: true });
	});

	test("tools invoke fixed coordinator operations with argv, never a shell", async () => {
		const h = harness();
		const runId = h.initialize();
		const diff = h.tools.get("review_diff");
		const record = h.tools.get("review_record");
		await diff.execute("1", { path: "source.ts", offset: 20, limit: 10 });
		await record.execute("2", { verdict: "BLOCKED", findings: "Evidence with quotes ' and $(not executed)" });
		expect(h.calls[0][0]).toBe("python3");
		expect(h.calls[0][1]).toEqual([join(agent, "scripts/review-pane.py"), "diff", "--run-id", runId,
			"--offset", "20", "--limit", "10", "--path=source.ts"]);
		expect(h.calls[1][1]).toEqual([join(agent, "scripts/review-pane.py"), "record", "--run-id", runId,
			"--verdict", "BLOCKED", "--findings=Evidence with quotes ' and $(not executed)"]);
		expect(record.parameters.required).toEqual(["verdict", "findings"]);
		expect(record.parameters.properties.verdict.enum).toEqual(["LGTM", "BLOCKED"]);
		expect(diff.parameters.additionalProperties).toBe(false);
	});
});
