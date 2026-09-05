/**
 * Pre-execution security gate for lead and security-only worker sessions.
 * Risky commands require interactive confirmation; credential paths are always
 * blocked for agent tools so their contents cannot enter a model transcript.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./security/paths.ts";

const RULES: { pattern: RegExp; label: string }[] = [
	{ pattern: /\bsudo\b/i, label: "privilege escalation (sudo)" },
	{
		pattern: /\brm\s+(-[^\s]*[rf][^\s]*|--recursive|--force)\b/i,
		label: "rm with -r/-f/--recursive/--force",
	},
	{
		pattern: /\b(?:chmod|chown)\b[^\n]*(?:\b777\b|-R(?:f)?\b)/i,
		label: "chmod/chown with 777 or -R",
	},
	{
		pattern: /\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
		label: "download piped into shell (curl|sh)",
	},
	{
		pattern:
			/\bgit\s+(?:push\b[^\n]*(?:--force(?:-with-lease)?|-f(?:\s|$))|reset\s+--hard|clean\s+-[a-z]*[fdx])/i,
		label: "destructive git (push --force / reset --hard / clean -f)",
	},
	{
		pattern: /\b(?:mkfs(?:\.\w+)?|fdisk|parted|shutdown|reboot|halt|poweroff)\b/i,
		label: "disk/system-destructive operation",
	},
	{
		pattern: /\bdd\b[^\n]*\bof=\/dev\//i,
		label: "dd writing to a device (/dev/...) ",
	},
	{
		pattern: /\b(?:pkill|killall)\b|\bkill\s+-9\b/i,
		label: "force-kill processes",
	},
];

const SECRET_COMPONENTS = new Set([".ssh"]);
const WRITE_PROTECTED_COMPONENTS = new Set([".git", "node_modules"]);
const MUTATING_PATH_TOOLS = new Set([
	"write",
	"edit",
	"multi_edit",
	"apply_patch",
	"ast_grep_replace",
]);
const PROTECTED_BASENAMES = new Set([
	"auth.json",
	"credentials.json",
	"id_rsa",
	"id_ed25519",
	".netrc",
	".npmrc",
]);
const PROTECTED_EXTS = /\.(?:pem|p12|key|pfx)$/i;
const SENSITIVE_COMMAND_PATH =
	/(?:^|[\s"'=])(?:[^\s"']*\/)?(?:\.env(?:\.[^\s"']+)?|auth\.json|credentials\.json|id_rsa|id_ed25519|\.netrc|\.npmrc|[^\s"']+\.(?:pem|p12|key|pfx))(?:$|[\s"'])|(?:^|\/)\.ssh(?:\/|$)|(?:^|\/)\.git\/(?:config|credentials)(?:$|[\s"'])|\/etc\/(?:passwd|shadow)(?:$|[\s"'])/i;

function commandHits(command: string): string[] {
	const hits: string[] = [];
	for (const rule of RULES) {
		if (rule.pattern.test(command)) hits.push(rule.label);
	}
	return hits;
}

function pathParts(raw: string): {
	normalized: string;
	parts: string[];
	base: string;
} {
	const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const parts = normalized.split("/").filter(Boolean);
	return { normalized, parts, base: parts.at(-1) ?? "" };
}

export function isSecretPath(raw: string): boolean {
	const { normalized, parts, base } = pathParts(raw);
	if (normalized === "/etc/passwd" || normalized === "/etc/shadow") return true;
	if (base === ".env" || base.startsWith(".env.")) return true;
	if (PROTECTED_BASENAMES.has(base) || PROTECTED_EXTS.test(base)) return true;
	if (parts.some((part) => SECRET_COMPONENTS.has(part))) return true;
	return parts.includes(".git") && (base === "config" || base === "credentials");
}

export function isWriteProtectedPath(raw: string): boolean {
	if (isSecretPath(raw)) return true;
	return pathParts(raw).parts.some((part) =>
		WRITE_PROTECTED_COMPONENTS.has(part),
	);
}

function protectedPaths(
	input: Record<string, unknown>,
	predicate: (path: string) => boolean,
): string[] {
	const out: string[] = [];
	for (const key of ["path", "file_path", "filePath", "newFilePath"]) {
		const value = input[key];
		if (typeof value === "string" && predicate(value)) out.push(value);
	}
	if (Array.isArray(input.paths)) {
		for (const value of input.paths) {
			if (typeof value === "string" && predicate(value)) out.push(value);
		}
	}
	return out;
}

export default function securityGate(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command =
				typeof event.input.command === "string" ? event.input.command : "";
			if (SENSITIVE_COMMAND_PATH.test(command)) {
				return {
					block: true,
					reason: "Blocked shell access to a credential or protected path",
				};
			}
			const hits = commandHits(command);
			if (hits.length === 0) return undefined;
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Blocked risky command (no UI to confirm): ${hits.join(", ")}`,
				};
			}
			const ok = await ctx.ui.confirm(
				"Run risky command?",
				`${command}\n\n⚠️  Detected: ${hits.join(", ")}`,
			);
			if (!ok) return { block: true, reason: "Blocked by user" };
			return undefined;
		}

		const predicate = MUTATING_PATH_TOOLS.has(event.toolName)
			? isWriteProtectedPath
			: isSecretPath;
		const paths = protectedPaths(
			event.input as Record<string, unknown>,
			(path) => predicate(path) || predicate(canonicalPath(path, ctx.cwd)),
		);
		if (paths.length > 0) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked protected path: ${paths.join(", ")}`, "warning");
			}
			return {
				block: true,
				reason: `Protected path access is not allowed: ${paths.join(", ")}`,
			};
		}
		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		if (SENSITIVE_COMMAND_PATH.test(event.command)) {
			return {
				result: {
					output: "Blocked shell access to a credential or protected path",
					exitCode: 126,
					cancelled: true,
					truncated: false,
				},
			};
		}
		const hits = commandHits(event.command);
		if (hits.length === 0) return undefined;
		if (!ctx.hasUI) {
			return {
				result: {
					output: `Blocked risky command (no UI to confirm): ${hits.join(", ")}`,
					exitCode: 126,
					cancelled: true,
					truncated: false,
				},
			};
		}
		const ok = await ctx.ui.confirm(
			"Run risky command?",
			`${event.command}\n\n⚠️  Detected: ${hits.join(", ")}`,
		);
		if (!ok) {
			return {
				result: {
					output: "Blocked by user",
					exitCode: 126,
					cancelled: true,
					truncated: false,
				},
			};
		}
		return undefined;
	});
}
