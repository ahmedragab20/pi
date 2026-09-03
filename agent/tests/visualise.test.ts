import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerVisualise } from "../extensions/visualise.ts";

/*
 * Run with:  bun test --preload tests/visualise-stubs.ts tests/visualise.test.ts
 */

interface RegisteredCommand {
	name: string;
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	}>;
}

interface SentMessage {
	text: string;
	options?: Record<string, unknown>;
}

function makeHarness(outputDir: string) {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const sentMessages: SentMessage[] = [];

	const pi = {
		registerCommand(name: string, def: Omit<RegisteredCommand, "name">) {
			commands.set(name, { name, ...def });
		},
		registerTool(def: RegisteredTool) {
			tools.set(def.name, def);
		},
		sendUserMessage(text: string, options?: Record<string, unknown>) {
			sentMessages.push({ text, options });
		},
	};

	registerVisualise(pi as never, { outputDir });
	return { commands, tools, sentMessages };
}

/** Fresh temp output dir per test, removed afterwards. */
async function withTempDir(
	fn: (
		harness: ReturnType<typeof makeHarness>,
		outputDir: string,
	) => Promise<void>,
): Promise<void> {
	const outputDir = mkdtempSync(join(tmpdir(), "visualise-test-"));
	try {
		await fn(makeHarness(outputDir), outputDir);
	} finally {
		rmSync(outputDir, { recursive: true, force: true });
	}
}

interface BranchEntry {
	type: string;
	message: { role: string; content: unknown };
}

function makeCommandCtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		mode: "tui",
		cwd: "/tmp",
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [] as BranchEntry[],
		},
		ui: {
			notify: () => {},
		},
		...overrides,
	};
}

const validGraph = {
	title: "Checkout Flow",
	kind: "flowchart" as const,
	nodes: [
		{ id: "cart", label: "Cart", group: "shop" },
		{ id: "pay", label: "Payment", group: "shop" },
		{ id: "confirm", label: "Confirmation", group: "shop" },
	],
	edges: [
		{ from: "cart", to: "pay", label: "checkout" },
		{ from: "pay", to: "confirm", label: "success" },
	],
	groups: [{ id: "shop", label: "Shopping" }],
	notes: [
		{ ref: "pay", text: "Payment retries up to 3 times before failing." },
		{ text: "Confirmation emails are queued, not synchronous." },
	],
	assumptions: ["Cart persists for 30 days."],
	sources: ["src/checkout/flow.ts"],
};

/** Visible width of a line, ignoring ANSI escapes. Box-drawing chars count as 1. */
function lineWidth(line: string): number {
	const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
	let width = 0;
	for (const ch of stripped) {
		const cp = ch.codePointAt(0)!;
		width += cp > 0xffff ? 2 : 1;
	}
	return width;
}

describe("visualise", () => {
	test("registers /visualise command and render_visualisation tool", async () => {
		await withTempDir(async ({ commands, tools }) => {
			expect(commands.has("visualise")).toBe(true);
			expect(commands.get("visualise")!.description).toContain("visualised flow");
			expect(tools.has("render_visualisation")).toBe(true);
			expect(tools.get("render_visualisation")!.parameters).toBeDefined();
		});
	});

	test("tool rejects a dangling edge reference with clear error text", async () => {
		await withTempDir(async ({ tools }) => {
			const tool = tools.get("render_visualisation")!;
			const result = await tool.execute(
				"t1",
				{ ...validGraph, edges: [{ from: "cart", to: "ghost" }] },
				undefined,
				undefined,
				{},
			);

			const text = result.content[0]!.text;
			expect(text).toContain("Validation failed");
			expect(text).toContain('edge "cart->ghost"');
			expect(text).toContain('"ghost"');
			expect(result.details.valid).toBe(false);
		});
	});

	test("tool rejects a duplicate node id with clear error text", async () => {
		await withTempDir(async ({ tools }) => {
			const tool = tools.get("render_visualisation")!;
			const result = await tool.execute(
				"t2",
				{
					...validGraph,
					nodes: [...validGraph.nodes, { id: "cart", label: "Cart 2" }],
				},
				undefined,
				undefined,
				{},
			);

			const text = result.content[0]!.text;
			expect(text).toContain("Validation failed");
			expect(text).toContain('duplicate node id "cart"');
		});
	});

	test("tool accepts a valid graph and renders it", async () => {
		await withTempDir(async ({ tools }) => {
			const tool = tools.get("render_visualisation")!;
			const result = await tool.execute(
				"t3",
				validGraph,
				undefined,
				undefined,
				{},
			);

			const text = result.content[0]!.text;
			expect(result.details.valid).toBe(true);
			expect(text).not.toContain("Validation failed");
			expect(text).toContain("Checkout Flow");
		});
	});

	test("ASCII render includes title, labels, arrows, numbered notes, and stays <= 100 cols", async () => {
		await withTempDir(async ({ tools }) => {
			const tool = tools.get("render_visualisation")!;
			const result = await tool.execute(
				"t4",
				validGraph,
				undefined,
				undefined,
				{},
			);
			const lines = result.content[0]!.text.split("\n");

			expect(lines.some((l) => l.includes("Checkout Flow"))).toBe(true);
			for (const label of ["Cart", "Payment", "Confirmation"]) {
				expect(lines.some((l) => l.includes(label))).toBe(true);
			}
			expect(lines.some((l) => l.includes("─▶"))).toBe(true);
			expect(lines.some((l) => /^\s*1\./.test(l))).toBe(true);
			expect(lines.some((l) => /^\s*2\./.test(l))).toBe(true);
			expect(lines.some((l) => l.includes("Payment retries up to 3 times"))).toBe(
				true,
			);

			// Regression: no ANSI escapes (pi-tui truncateToWidth emits them at
			// truncation points — wrong for plain tool result text).
			expect(result.content[0]!.text).not.toContain("\x1b");
			// Regression: no doubled arrow glyph from prefix + edge line.
			expect(lines.some((l) => l.includes("▶─▶"))).toBe(false);

			for (const line of lines) {
				expect(lineWidth(line) <= 100).toBe(true);
			}
		});
	});

	test("successful render saves graph JSON with title, kind, nodes, edges, notes", async () => {
		await withTempDir(async ({ tools }, outputDir) => {
			const tool = tools.get("render_visualisation")!;
			const result = await tool.execute(
				"t5",
				validGraph,
				undefined,
				undefined,
				{},
			);

			expect(result.details.valid).toBe(true);
			expect(typeof result.details.file).toBe("string");
			expect(existsSync(String(result.details.file))).toBe(true);

			const files = readdirSync(outputDir).filter((f) => f.endsWith(".json"));
			expect(files.length).toBe(1);

			const saved = JSON.parse(readFileSync(join(outputDir, files[0]!), "utf8"));
			expect(saved.title).toBe("Checkout Flow");
			expect(saved.kind).toBe("flowchart");
			expect(saved.nodes.map((n: { id: string }) => n.id)).toEqual([
				"cart",
				"pay",
				"confirm",
			]);
			expect(saved.edges.length).toBe(2);
			expect(saved.notes.length).toBe(2);
		});
	});

	test("/visualise <topic> sends kickoff containing topic and tool instructions", async () => {
		await withTempDir(async ({ commands, sentMessages }) => {
			await commands.get("visualise")!.handler("checkout flow", makeCommandCtx());

			expect(sentMessages.length).toBe(1);
			const payload = sentMessages[0]!.text;
			expect(payload).toContain("checkout flow");
			expect(payload).toContain("render_visualisation");
			expect(payload).toContain("Research the topic");
		});
	});

	test("/visualise with no args infers context from the conversation branch", async () => {
		await withTempDir(async ({ commands, sentMessages }) => {
			const branch: BranchEntry[] = [
				{
					type: "message",
					message: {
						role: "user",
						content: "How does the retry logic in the worker work?",
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "The worker retries with backoff." }],
					},
				},
			];
			await commands
				.get("visualise")!
				.handler(
					"",
					makeCommandCtx({ sessionManager: { getBranch: () => branch } }),
				);

			expect(sentMessages.length).toBe(1);
			const payload = sentMessages[0]!.text;
			expect(payload).toContain("How does the retry logic in the worker work?");
			expect(payload).toContain("The worker retries with backoff.");
			expect(payload).toContain("render_visualisation");
		});
	});

	test("/visualise with no topic and no conversation bails without sending", async () => {
		await withTempDir(async ({ commands, sentMessages }) => {
			await commands.get("visualise")!.handler("", makeCommandCtx());
			expect(sentMessages.length).toBe(0);
		});
	});

	test("/visualise --repo sends repo exploration kickoff", async () => {
		await withTempDir(async ({ commands, sentMessages }) => {
			await commands.get("visualise")!.handler("auth --repo", makeCommandCtx());
			expect(sentMessages.length).toBe(1);
			const payload = sentMessages[0]!.text;
			expect(payload).toContain("auth");
			expect(payload).toContain("repository");
			expect(payload).toContain("render_visualisation");
		});
	});
});
