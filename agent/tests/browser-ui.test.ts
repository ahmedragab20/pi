import { describe, expect, test } from "bun:test";
import { agentBrowserRenderers, browserVerifyRenderers } from "../extensions/browser/renderers.ts";
import { stripTerminalSequences, visibleWidth } from "../npm/node_modules/@earendil-works/pi-tui/dist/index.js";

const theme = {
	fg: (_color: string, value: string) => `\x1b[38;5;2m${value}\x1b[0m`,
	bold: (value: string) => `\x1b[1m${value}\x1b[0m`,
};

function plain(lines: string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function context(overrides: Record<string, unknown> = {}) {
	return {
		argsComplete: true,
		isError: false,
		...overrides,
	} as never;
}

const result = (text: string, isError = false) => ({
	content: [{ type: "text", text }],
	details: undefined,
	isError,
}) as never;

describe("browser presentation", () => {
	test("headers identify action/session and do not expose secrets or typed text", () => {
		const component = agentBrowserRenderers.renderCall?.(
			{
				action: "fill",
				args: ["#password", "hunter2", "token=secret"],
				session: "checkout",
			} as never,
			theme as never,
			context(),
		);
		const output = plain(component?.render(80) ?? []);
		expect(output).toContain("fill");
		expect(output).toContain("session checkout");
		expect(output).not.toContain("hunter2");
		expect(output).not.toContain("secret");
		const invalidUrl = agentBrowserRenderers.renderCall?.(
			{ action: "open", args: ["data:text/plain,private-payload"] } as never, theme as never, context(),
		);
		expect(plain(invalidUrl?.render(100) ?? [])).not.toContain("private-payload");
	});

	test("renders safely at narrow and wide real TUI widths with Unicode", () => {
		const component = browserVerifyRenderers.renderResult?.(
			result("✓ café\nsecond line\nthird line\nfourth line\nfifth line"),
			{ expanded: false, isPartial: false },
			theme as never,
			context(),
		);
		for (const width of [12, 40, 80]) {
			const lines = component?.render(width) ?? [];
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const preview = plain(component?.render(40) ?? []);
		expect(preview).toContain("more");
		expect(preview).not.toContain("fifth line");
	});

	test("expanded and failed results wrap long tails without changing whitespace or evidence", () => {
		const text = "    indented  value\n" + "日本語/".repeat(30) + "END-OF-RESULT";
		for (const isError of [false, true]) {
			const evidence = { content: [{ type: "text" as const, text }], details: { raw: text } };
			const before = JSON.stringify(evidence);
			const component = agentBrowserRenderers.renderResult?.(
				evidence, { expanded: !isError, isPartial: false }, theme as never, context({ isError }),
			);
			const lines = (component?.render(40) ?? []).map(stripTerminalSequences);
			expect(lines.some((line) => line.startsWith("    indented  value"))).toBe(true);
			expect(lines.join("")).toContain("END-OF-RESULT");
			expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
			expect(JSON.stringify(evidence)).toBe(before);
		}
	});

	test("headers omit URL credentials and query strings; styles refresh after invalidation", () => {
		let color = 31;
		const liveTheme = { ...theme, fg: (_key: string, text: string) => `\x1b[${color}m${text}\x1b[0m` };
		const component = agentBrowserRenderers.renderCall?.(
			{ action: "open", args: ["https://synthetic:password@example.test/page?token=secret#private"] } as never,
			liveTheme as never, context(),
		)!;
		expect(plain(component.render(100))).toContain("https://example.test/page");
		expect(plain(component.render(100))).not.toContain("password");
		expect(plain(component.render(100))).not.toContain("secret");
		expect(component.render(100).join("")).toContain("\x1b[31m");
		color = 32; component.invalidate();
		expect(component.render(100).join("")).toContain("\x1b[32m");
		expect(component.render(100).join("")).not.toContain("\x1b[31m");
	});

	test("expanded, partial, error, and image/text results preserve useful detail", () => {
		const expanded = agentBrowserRenderers.renderResult?.(
			result("first\nsecond\nthird\nfourth\nfifth"),
			{ expanded: true, isPartial: false },
			theme as never,
			context(),
		);
		expect(plain(expanded?.render(40) ?? [])).toContain("fifth");

		const partial = agentBrowserRenderers.renderResult?.(
			result("working"),
			{ expanded: false, isPartial: true },
			theme as never,
			context({ argsComplete: false }),
		);
		expect(plain(partial?.render(40) ?? [])).toContain("running");
		expect(plain(partial?.render(40) ?? [])).toContain("arguments incomplete");

		const failure = agentBrowserRenderers.renderResult?.(
			result("Browser command failed: useful detail", true),
			{ expanded: false, isPartial: false },
			theme as never,
			context({ isError: true }),
		);
		expect(plain(failure?.render(40) ?? [])).toContain("useful detail");

		const imageEvidence = {
			content: [{ type: "text", text: "screenshot ready" }, { type: "image", data: "synthetic-base64", mimeType: "image/png" }],
			details: { artifact: "/sandbox/screenshot.png" },
		};
		const before = JSON.stringify(imageEvidence);
		const image = agentBrowserRenderers.renderResult?.(
			imageEvidence as never,
			{ expanded: false, isPartial: false },
			theme as never,
			context(),
		);
		expect(plain(image?.render(40) ?? [])).toContain("1 image");
		expect(JSON.stringify(imageEvidence)).toBe(before);
	});
});
