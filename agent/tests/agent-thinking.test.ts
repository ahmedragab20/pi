import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
	resolveAgentThinking,
	validateThinkingLevel,
} from "../extensions/process/agent-thinking.ts";

const MODEL = { provider: "reasoning", id: "mock-reasoner", reasoning: true };
const FIXTURE_ROOT = fileURLToPath(new URL("../tmp", import.meta.url));
mkdirSync(FIXTURE_ROOT, { recursive: true });

function fixture(): string {
	const cwd = mkdtempSync(join(FIXTURE_ROOT, "agent-thinking-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	return cwd;
}

function context(cwd: string): Parameters<typeof resolveAgentThinking>[0] {
	return {
		cwd,
		model: MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === MODEL.provider && id === MODEL.id ? MODEL : undefined,
			getAll: () => [MODEL],
		},
	} as unknown as Parameters<typeof resolveAgentThinking>[0];
}

function agent(cwd: string, name: string, body: string): string {
	const path = join(cwd, ".pi", "agents", `${name}.md`);
	writeFileSync(path, body);
	return path;
}

function frontmatter(name: string, thinking?: string): string {
	return `---\nname: ${name}\n${thinking === undefined ? "" : `thinking: ${thinking}\n`}---\n\nworker\n`;
}

describe("agent thinking policy", () => {
	test("accepts all seven levels, including off", () => {
		for (const level of [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]) {
			expect(validateThinkingLevel(level, "test")).toBe(level);
		}
	});

	test("rejects malformed levels and has no omission error", () => {
		expect(validateThinkingLevel(undefined, "test")).toBeUndefined();
		for (const value of ["hihg", null, 3, ""]) {
			expect(() => validateThinkingLevel(value, "test")).toThrow(
				"test: invalid thinking level",
			);
		}
	});

	test("project frontmatter wins over requested thinking", () => {
		const cwd = fixture();
		try {
			agent(
				cwd,
				"thinking-project-wins",
				frontmatter("thinking-project-wins", "medium"),
			);
			expect(
				resolveAgentThinking(context(cwd), "thinking-project-wins", "high"),
			).toBe("medium");
		} finally {
			rmSync(cwd, { recursive: true });
		}
	});

	test("invalid frontmatter thinking reports its file path", () => {
		for (const value of ["hihg", "3"]) {
			const cwd = fixture();
			try {
				const path = agent(
					cwd,
					`thinking-invalid-${value}`,
					frontmatter(`thinking-invalid-${value}`, value),
				);
				expect(() =>
					resolveAgentThinking(context(cwd), `thinking-invalid-${value}`, "low"),
				).toThrow(`${path}: thinking: invalid thinking level`);
			} finally {
				rmSync(cwd, { recursive: true });
			}
		}
	});

	test("absent thinking uses explicit requested level", () => {
		const cwd = fixture();
		try {
			agent(cwd, "thinking-explicit", frontmatter("thinking-explicit"));
			expect(resolveAgentThinking(context(cwd), "thinking-explicit", "low")).toBe(
				"low",
			);
		} finally {
			rmSync(cwd, { recursive: true });
		}
	});

	test("named agent uses project default and per-model thinking overrides it", () => {
		const cwd = fixture();
		try {
			agent(cwd, "thinking-settings", frontmatter("thinking-settings"));
			writeFileSync(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({ defaultThinkingLevel: "low", modelThinkingLevels: {} }),
			);
			expect(
				resolveAgentThinking(
					{ ...context(cwd), thinkingLevel: "high" } as never,
					"thinking-settings",
				),
			).toBe("low");
			writeFileSync(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					defaultThinkingLevel: "low",
					modelThinkingLevels: { "reasoning/mock-reasoner": "medium" },
				}),
			);
			expect(resolveAgentThinking(context(cwd), "thinking-settings")).toBe(
				"medium",
			);
		} finally {
			rmSync(cwd, { recursive: true });
		}
	});

	test("efficiency no longer references or ships thinking-router", () => {
		const index = readFileSync(
			new URL("../extensions/efficiency/index.ts", import.meta.url),
			"utf8",
		);
		expect(index).not.toContain("thinking-router");
		expect(
			existsSync(
				new URL("../extensions/efficiency/thinking-router.ts", import.meta.url),
			),
		).toBe(false);
	});
});
