import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	type ConfirmMode,
	isLocalUrl,
	needsBrowserConfirmation,
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
		expect(r.interactive).toBe(false);
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
		expect(r.interactive).toBe(false);
	});
});

describe("interactive", () => {
	test("find role button click --name Submit is interactive", () => {
		const r = validateBrowserArgs("find", [
			"role",
			"button",
			"click",
			"--name",
			"Submit",
		]);
		expect(r.interactive).toBe(true);
	});

	test("find nth 2 a click is interactive", () => {
		const r = validateBrowserArgs("find", ["nth", "2", "a", "click"]);
		expect(r.interactive).toBe(true);
	});

	test("find text Terms text is not interactive", () => {
		const r = validateBrowserArgs("find", ["text", "Terms", "text"]);
		expect(r.interactive).toBe(false);
	});

	test("direct upload/click/fill are interactive", () => {
		expect(
			validateBrowserArgs("upload", ["a.png", "b.png"]).interactive,
		).toBe(true);
		expect(validateBrowserArgs("click", [".btn"]).interactive).toBe(true);
		expect(validateBrowserArgs("fill", [".box", "text"]).interactive).toBe(
			true,
		);
	});
});

describe("verification actions", () => {
	const accepted: [string, string[]][] = [
		["snapshot", ["--delta"]],
		["snapshot", ["-i", "-c", "-u"]],
		["screenshot", ["--if-changed", "--threshold", "0.01"]],
		["console", []],
		["errors", ["--clear"]],
		["network", ["requests", "--type", "xhr,fetch", "--status", "2xx"]],
		["diff", ["snapshot"]],
		["diff", ["screenshot", "--baseline", "a.png", "-t", "0.2"]],
		["set", ["viewport", "390", "844"]],
		["set", ["viewport", "1280", "720", "2"]],
		["set", ["device", "iPhone 14"]],
		["set", ["media", "dark"]],
	];
	for (const [action, args] of accepted) {
		test(`accepts ${action} ${args.join(" ")}`.trim(), () => {
			expect(caught(() => validateBrowserArgs(action, args))).toBe(false);
		});
	}

	const rejected: [string, string[]][] = [
		["network", ["request", "ABC"]],
		["network", ["route", "*"]],
		["diff", ["screenshot"]],
		["diff", ["url", "https://a.com", "https://b.com"]],
		["diff", ["snapshot", "-o", "d.png"]],
		["diff", ["screenshot", "--baseline", "a.png", "-t", "2"]],
		["screenshot", ["--threshold", "5"]],
		["set", ["headers", "{}"]],
		["set", ["credentials", "u", "p"]],
		["set", ["media", "blue"]],
		["set", ["viewport", "wide", "844"]],
		["eval", ["1+1"]],
		["state", ["save", "x.json"]],
	];
	for (const [action, args] of rejected) {
		test(`rejects ${action} ${args.join(" ")}`, () => {
			expect(caught(() => validateBrowserArgs(action, args))).toBe(true);
		});
	}

	test("console and diff snapshot are not interactive", () => {
		expect(validateBrowserArgs("console", []).interactive).toBe(false);
		expect(validateBrowserArgs("diff", ["snapshot"]).interactive).toBe(false);
	});
});

describe("isLocalUrl", () => {
	test("accepts loopback and dev-only hostnames", () => {
		for (const url of [
			"http://localhost:3000/",
			"http://127.0.0.1:5173",
			"http://127.4.5.6/",
			"http://[::1]:8080/",
			"https://app.localhost/",
			"http://myapp.test/",
			"http://printer.local/",
		])
			expect(isLocalUrl(url)).toBe(true);
	});

	test("treats LAN, lookalike, and non-HTTP URLs as remote", () => {
		for (const url of [
			"https://example.com/",
			"http://192.168.1.1/",
			"http://10.0.0.5:3000/",
			"http://localhost.evil.com/",
			"file:///tmp/x",
			"",
			"about:blank",
		])
			expect(isLocalUrl(url)).toBe(false);
	});
});

describe("needsBrowserConfirmation", () => {
	// [mode, interactive, upload, consequential, local, expected]
	const cases: [ConfirmMode, boolean, boolean, boolean, boolean, boolean][] = [
		["default", true, false, false, false, false],
		["default", true, false, true, false, true],
		["default", true, false, true, true, false],
		["default", true, true, false, false, true],
		["default", true, true, false, true, false],
		["default", false, false, false, false, false],
		["strict", true, false, false, true, true],
		["strict", false, false, true, true, true],
		["strict", false, false, false, false, false],
	];
	for (const [mode, interactive, upload, consequential, local, expected] of cases) {
		test(`${mode} interactive=${interactive} upload=${upload} consequential=${consequential} local=${local}`, () => {
			expect(
				needsBrowserConfirmation({ mode, interactive, upload, consequential, local }),
			).toBe(expected);
		});
	}
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
