import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	validateBrowserArgs,
	validateBrowserPath,
	validateUrl,
} from "../extensions/browser/policy.ts";

function caught(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

const AGENT_TMP = join(import.meta.dirname, "../tmp");
mkdirSync(AGENT_TMP, { recursive: true });
const tmp = mkdtempSync(join(AGENT_TMP, "browser-policy-"));
const artifacts = join(tmp, "artifacts");
mkdirSync(artifacts, { recursive: true });

// Harmlessly named symlink to a dummy dot-env file (dummy content only).
const envDir = join(tmp, "env");
mkdirSync(envDir, { recursive: true });
const realEnv = join(envDir, ".env");
writeFileSync(realEnv, "DUMMY_KEY=not-a-real-secret\n", "utf8");
const envSymlink = join(tmp, "config.json");
symlinkSync(realEnv, envSymlink);

describe("validateBrowserArgs rejections", () => {
	test("wait rejects --fn and --fn=value", () => {
		expect(caught(() => validateBrowserArgs("wait", ["--fn", "x"]))).toBe(true);
		expect(caught(() => validateBrowserArgs("wait", ["--fn=x"]))).toBe(true);
	});

	test("open rejects --cdp/--profile/--headers overrides", () => {
		expect(
			caught(() =>
				validateBrowserArgs("open", ["--cdp", "http://localhost:9222"]),
			),
		).toBe(true);
		expect(caught(() => validateBrowserArgs("open", ["--profile", "x"]))).toBe(
			true,
		);
		expect(caught(() => validateBrowserArgs("open", ["--headers", "x"]))).toBe(
			true,
		);
	});

	test("get rejects cdp-url", () => {
		expect(caught(() => validateBrowserArgs("get", ["cdp-url"]))).toBe(true);
	});
});

describe("validateBrowserArgs acceptance", () => {
	test("open with HTTP(S) URL is allowed and non-interactive", () => {
		const r = validateBrowserArgs("open", ["https://example.com"]);
		expect(r.needsConfirmation).toBe(false);
	});

	test("snapshot -i is allowed", () => {
		expect(caught(() => validateBrowserArgs("snapshot", ["-i"]))).toBe(false);
	});

	test("read --filter is allowed", () => {
		expect(caught(() => validateBrowserArgs("read", ["--filter", ".main"]))).toBe(
			false,
		);
	});

	test("find role heading text is allowed", () => {
		const r = validateBrowserArgs("find", ["role", "heading", "text"]);
		expect(r.needsConfirmation).toBe(false);
	});
});

describe("needsConfirmation", () => {
	test("find role button click --name Submit requires confirmation", () => {
		const r = validateBrowserArgs("find", [
			"role",
			"button",
			"click",
			"--name",
			"Submit",
		]);
		expect(r.needsConfirmation).toBe(true);
	});

	test("find nth 2 a click requires confirmation", () => {
		const r = validateBrowserArgs("find", ["nth", "2", "a", "click"]);
		expect(r.needsConfirmation).toBe(true);
	});

	test("find text Terms text does not require confirmation", () => {
		const r = validateBrowserArgs("find", ["text", "Terms", "text"]);
		expect(r.needsConfirmation).toBe(false);
	});

	test("direct upload/click/fill require confirmation", () => {
		expect(
			validateBrowserArgs("upload", ["a.png", "b.png"]).needsConfirmation,
		).toBe(true);
		expect(validateBrowserArgs("click", [".btn"]).needsConfirmation).toBe(true);
		expect(validateBrowserArgs("fill", [".box", "text"]).needsConfirmation).toBe(
			true,
		);
	});
});

describe("validateUrl", () => {
	test("rejects file:, javascript:, data: URLs and embedded credentials", () => {
		expect(caught(() => validateUrl("file:///etc/passwd"))).toBe(true);
		expect(caught(() => validateUrl("javascript:alert(1)"))).toBe(true);
		expect(caught(() => validateUrl("data:text/html,hello"))).toBe(true);
		expect(caught(() => validateUrl("https://user:pass@example.com/"))).toBe(
			true,
		);
	});

	test("accepts plain http(s) URLs", () => {
		expect(caught(() => validateUrl("http://example.com/"))).toBe(false);
		expect(caught(() => validateUrl("https://example.com/path"))).toBe(false);
	});
});

describe("validateBrowserPath", () => {
	test("rejects a harmlessly named symlink to a dot-env file", () => {
		expect(
			caught(() => validateBrowserPath(envSymlink, tmp, artifacts, false)),
		).toBe(true);
	});

	test("rejects a screenshot path outside workspace and artifacts", () => {
		const outside = join(tmp, "..", "outside-browser-shot.png");
		expect(caught(() => validateBrowserPath(outside, tmp, artifacts, true))).toBe(
			true,
		);
	});

	test("accepts an ordinary in-workspace image path", () => {
		const shot = join(tmp, "shot.png");
		const r = validateBrowserPath(shot, tmp, artifacts, true);
		expect(r.endsWith("shot.png")).toBe(true);
	});
});
