import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSecretPath } from "../security-gate.ts";
// Use the same installed SDK resolvers as the built-in tools, including read fallbacks.
import { resolveReadPath, resolveToCwd } from "../../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";

const AGENT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = resolve(AGENT, "scripts/review-pane.py");
const ALLOWED = new Set(["read", "grep", "find", "ls", "review_diff", "review_record"]);
type Run = { run_id: string; cwd: string; reviewer_pane: string; model: string; thinking: string; fast: boolean };

export function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function checkReadPath(tool: string, raw: string, cwd: string): string | undefined {
	try {
		const path = tool === "read" ? resolveReadPath(raw, cwd) : resolveToCwd(raw, cwd);
		const canonical = realpathSync(path);
		if (!within(realpathSync(cwd), canonical) || isSecretPath(path) || isSecretPath(canonical)) {
			return "Reviewer reads must stay inside the checkout and exclude credentials.";
		}
		// A recursive grep could include credentials without naming them in its input.
		if (tool === "grep" && !statSync(canonical).isFile()) {
			return "Search one explicit non-secret file at a time; discover paths with find or review_diff.";
		}
	} catch {
		return "Reviewer path does not exist or cannot be safely resolved.";
	}
	return undefined;
}

export default function reviewerTools(pi: ExtensionAPI) {
	pi.registerFlag("review-pane-run", { type: "string", description: "Coordinator-owned review metadata path" });
	let run: Run | undefined;
	const requireRun = () => {
		if (!run) throw new Error("Reviewer metadata is not initialized");
		return run;
	};

	pi.on("session_start", (_event, ctx) => {
		run = undefined;
		const flag = pi.getFlag("review-pane-run");
		if (typeof flag !== "string") throw new Error("--review-pane-run is required");
		const path = realpathSync(flag);
		const root = realpathSync(resolve(AGENT, "tmp/review-pane"));
		const rel = relative(root, path);
		if (!/^[a-f0-9]{32}\/meta\.json$/.test(rel)) throw new Error("Invalid reviewer metadata path");
		let candidate: Run;
		try {
			candidate = JSON.parse(readFileSync(path, "utf8")) as Run;
		} catch {
			throw new Error("Invalid reviewer metadata JSON");
		}
		if (candidate.run_id !== rel.split("/")[0]
			|| candidate.reviewer_pane !== process.env.HERDR_PANE_ID
			|| process.env.HERDR_ENV !== "1"
			|| realpathSync(candidate.cwd) !== realpathSync(ctx.cwd)
			|| candidate.model !== "openai-codex/gpt-6-astra"
			|| candidate.thinking !== "max" || candidate.fast !== true) {
			throw new Error("Reviewer metadata does not match this pane, checkout, or pinned policy");
		}
		run = candidate;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!run || !ALLOWED.has(event.toolName)) return { block: true, reason: "Read-only reviewer tool allowlist" };
		if (["read", "grep", "find", "ls"].includes(event.toolName)) {
			const input = event.input as Record<string, unknown>;
			const raw = typeof input.path === "string" ? input.path : ".";
			const reason = checkReadPath(event.toolName, raw, ctx.cwd);
			if (reason) return { block: true, reason };
		}
		return undefined;
	});
	pi.on("user_bash", () => ({ result: {
		output: "Shell execution is disabled in reviewer panes.", exitCode: 126, cancelled: false, truncated: false,
	} }));
	pi.on("before_provider_request", (event, ctx) => {
		// Same priority-tier mechanism as fast.ts, confined to this opt-in reviewer.
		if (run && ctx.model?.provider === "openai-codex" && ctx.model.id === "gpt-6-astra"
			&& event.payload && typeof event.payload === "object") {
			return { ...event.payload, service_tier: "priority" };
		}
		return undefined;
	});

	async function execute(action: string, args: string[], signal?: AbortSignal) {
		const meta = requireRun();
		const result = await pi.exec("python3", [SCRIPT, action, "--run-id", meta.run_id, ...args], { signal, timeout: 80000 });
		if (result.code !== 0) throw new Error(result.stdout || "Review coordinator failed");
		return { content: [{ type: "text" as const, text: result.stdout }], details: undefined };
	}
	pi.registerTool({
		name: "review_diff", label: "Review diff",
		description: "Read the fixed review scope. Omit path for paginated changed paths (including untracked files for working-tree reviews). Supply one path for paginated diff lines. Follow next_offset; truncated_bytes means coverage is incomplete. Only exact approved changed-file paths are accepted, including deleted files. Git hooks, external diff, textconv and conversion filters are disabled; patches use unfiltered local content. Never request credentials.",
		parameters: {
			type: "object", properties: {
				path: { type: "string" }, offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 300 },
			}, additionalProperties: false,
		} as const,
		async execute(_id, params, signal) {
			const args = ["--offset", String(params.offset ?? 0), "--limit", String(params.limit ?? 200)];
			if (params.path !== undefined) args.push(`--path=${params.path}`);
			return execute("diff", args, signal);
		},
	});
	pi.registerTool({
		name: "review_record", label: "Record review",
		description: "Persist one immutable verdict plus Markdown findings and coverage, then notify the lead asynchronously. Advisory proposals alone are LGTM. Do not include secrets. This is the only permitted write; it cannot change repository code.",
		parameters: {
			type: "object", properties: {
				verdict: { type: "string", enum: ["LGTM", "BLOCKED"] },
				findings: { type: "string", minLength: 1, maxLength: 24000 },
			}, required: ["verdict", "findings"], additionalProperties: false,
		} as const,
		async execute(_id, params, signal) {
			return execute("record", ["--verdict", params.verdict, `--findings=${params.findings}`], signal);
		},
	});
}
