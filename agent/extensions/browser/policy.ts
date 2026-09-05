import { isAbsolute, relative } from "node:path";
import { isSecretPath, isWriteProtectedPath } from "../security-gate.ts";
import { canonicalPath } from "../security/paths.ts";

const INTERACTIVE = new Set([
	"click",
	"dblclick",
	"type",
	"fill",
	"press",
	"select",
	"check",
	"uncheck",
	"drag",
	"upload",
]);
const FLAGS: Record<string, Record<string, boolean>> = {
	read: {
		"--filter": true,
		"--outline": false,
		"--require-md": false,
		"--llms": true,
		"--json": false,
	},
	snapshot: {
		"-i": false,
		"--interactive": false,
		"-c": false,
		"--compact": false,
		"-d": true,
		"--depth": true,
		"-s": true,
		"--selector": true,
		"--json": false,
	},
	click: { "--new-tab": false },
	scroll: { "--selector": true },
	screenshot: { "--full": false, "--annotate": false },
	find: { "--name": true, "--exact": false },
	wait: { "--text": true, "--url": true, "--load": true, "--state": true },
};

export function isInteractiveAction(action: string): boolean {
	return INTERACTIVE.has(action);
}

export function validateUrl(raw: string): void {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Browser URL must be an absolute HTTP(S) URL");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error("Browser URLs must use HTTP(S) without embedded credentials");
	}
}

function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
	);
}

export function validateBrowserPath(
	raw: string,
	cwd: string,
	artifacts: string,
	write: boolean,
): string {
	const path = canonicalPath(raw, cwd);
	const protectedPath = write ? isWriteProtectedPath : isSecretPath;
	if (protectedPath(raw) || protectedPath(path))
		throw new Error("Protected browser file path");
	if (
		!inside(path, canonicalPath(cwd, cwd)) &&
		!inside(path, canonicalPath(artifacts, cwd))
	) {
		throw new Error(
			"Browser files must be inside the workspace or browser-artifacts directory",
		);
	}
	return path;
}

/** Deliberately expose a subset, not the CLI's arbitrary global flags or JS hooks. */
export function validateBrowserArgs(
	action: string,
	args: string[],
): { positional: string[]; needsConfirmation: boolean } {
	const positional: string[] = [];
	const flags = FLAGS[action] ?? {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.includes("\0"))
			throw new Error("NUL is not allowed in browser arguments");
		if (!arg.startsWith("-")) {
			positional.push(arg);
			continue;
		}
		if (!Object.hasOwn(flags, arg))
			throw new Error(`Unsupported browser option: ${arg}`);
		if (flags[arg]) {
			const value = args[++i];
			if (!value || value.startsWith("-") || value.includes("\0"))
				throw new Error(`Missing or unsafe value for ${arg}`);
		}
	}
	const count = (min: number, max = min) => {
		if (positional.length < min || positional.length > max)
			throw new Error(`Invalid arguments for browser ${action}`);
	};
	let needsConfirmation = INTERACTIVE.has(action);
	switch (action) {
		case "open":
		case "read":
			count(0, 1);
			if (positional[0]) validateUrl(positional[0]);
			break;
		case "snapshot":
		case "back":
		case "forward":
		case "reload":
		case "tabs":
		case "close":
			count(0);
			break;
		case "click":
		case "dblclick":
		case "focus":
		case "press":
		case "hover":
		case "check":
		case "uncheck":
		case "scrollintoview":
			count(1);
			break;
		case "type":
		case "fill":
		case "drag":
			count(2);
			break;
		case "select":
			count(2, 20);
			break;
		case "upload":
			count(2, 20);
			break;
		case "screenshot":
		case "pdf":
			count(0, 1);
			break;
		case "scroll":
			count(1, 2);
			if (
				!["up", "down", "left", "right"].includes(positional[0]) ||
				(positional[1] && !/^\d+$/.test(positional[1]))
			)
				throw new Error("Invalid scroll direction or distance");
			break;
		case "get": {
			const arity: Record<string, number> = {
				text: 2,
				html: 2,
				value: 2,
				attr: 3,
				title: 1,
				url: 1,
				count: 2,
				box: 2,
				styles: 2,
			};
			if (!Object.hasOwn(arity, positional[0]))
				throw new Error("Unsupported browser get operation");
			count(arity[positional[0]]);
			break;
		}
		case "find": {
			const locator = positional[0];
			if (
				![
					"role",
					"text",
					"label",
					"placeholder",
					"alt",
					"title",
					"testid",
					"first",
					"last",
					"nth",
				].includes(locator)
			)
				throw new Error("Unsupported browser locator");
			const index = locator === "nth" ? 3 : 2;
			if (locator === "nth" && !/^\d+$/.test(positional[1]))
				throw new Error("Invalid locator index");
			const nested = positional[index];
			if (!["click", "fill", "check", "hover", "text"].includes(nested))
				throw new Error("Unsupported nested browser action");
			count(index + (nested === "fill" ? 2 : 1));
			needsConfirmation = INTERACTIVE.has(nested);
			break;
		}
		case "wait":
			count(0, 1);
			if (!args.length)
				throw new Error(
					"wait requires a selector, duration, or supported condition",
				);
			break;
		default:
			throw new Error("Unsupported browser action");
	}
	return { positional, needsConfirmation };
}
