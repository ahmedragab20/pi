/**
 * Goal loop
 *
 * `/goal <task>` starts a long-running lead loop that survives context resets.
 * The scoped state.json on disk carries the task, acceptance criteria, roadmap,
 * evidence and cycle log — chat is never the record. Every slice ends with a
 * `goal` call; the extension re-anchors the next slice with a kickoff prompt
 * and compacts only when context is actually full. `done` needs every
 * criterion evidenced plus a human review newer than the last evidence change.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { requestCompaction } from "./efficiency/compaction-coordinator.ts";

type GoalPhase =
	| "draft"
	| "running"
	| "await_plan"
	| "await_review"
	| "blocked"
	| "done"
	| "stopped";

type GoalAction =
	| "status"
	| "set_criteria"
	| "set_roadmap"
	| "step"
	| "plan_approved"
	| "evidence"
	| "cycle"
	| "await_plan"
	| "await_review"
	| "reviewed"
	| "blocked"
	| "done";

type StepState = "todo" | "active" | "done";

interface EvidenceSource {
	toolCallId: string;
	toolName: string;
	outputHash: string;
	recordedAt: number;
}

interface Criterion {
	id: string;
	text: string;
	met: boolean;
	evidence?: string;
	evidenceSource?: EvidenceSource;
	/** Cycle the current evidence was recorded in. */
	cycle?: number;
}

interface Step {
	id: string;
	text: string;
	state: StepState;
}

interface CycleLog {
	n: number;
	summary: string;
	next: string;
	files?: string;
}

interface TreeSnapshot {
	fingerprint: string;
	files: string;
}

/** A background subagent the lead spawned and has not read back yet. */
interface PendingAgent {
	id: string;
	description: string;
	cycle: number;
}

interface GoalState {
	version: number;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	task: string;
	phase: GoalPhase;
	cycle: number;
	cycleCap: number;
	criteria: Criterion[];
	roadmap: Step[];
	nextSlice: string;
	planApproved: boolean;
	planNote?: string;
	reviewed: boolean;
	reviewNote?: string;
	/** evidenceSerial at the moment the human review was recorded. */
	reviewSerial: number;
	/** Bumped on every evidence change, so a stale review is detectable. */
	evidenceSerial: number;
	autoContinue: boolean;
	lastAction: string;
	nudgeCount: number;
	stallCount: number;
	lastFingerprint?: string;
	blockedReason?: string;
	/** Why a done goal closed, when it was not the plain evidenced+reviewed path. */
	doneNote?: string;
	log: CycleLog[];
	agents: PendingAgent[];
	updatedAt: number;
	/** Human-readable mirror. */
	file: string;
	/** Authoritative machine state. */
	stateFile: string;
}

interface GoalDetails {
	action: GoalAction;
	phase?: GoalPhase;
	cycle?: number;
	met?: number;
	total?: number;
	error?: string;
}

const VERSION = 3;
const ENTRY = "goal";
const WIDGET = "goal";
const LOG_CAP = 12;
const PROOF_CAP = 32;
const STALL_LIMIT = 2;
const NUDGE_LIMIT = 1;
const DEFAULT_CAP = 50;
const MAX_ITEMS = 24;
const TASK_MAX = 400;
const TEXT_MAX = 200;
const EVIDENCE_MAX = 400;
const SUMMARY_MAX = 600;
const EVIDENCE_MIN = 12;
/** Compact at a cycle boundary only past this much of the context window. */
const COMPACT_AT_PERCENT = 55;
const SNAPSHOT_FILE_MAX_BYTES = 1024 * 1024;
/** Tools that can mutate product files. Gated until the plan is approved. */
const WRITE_TOOLS = new Set([
	"edit",
	"write",
	"multi_edit",
	"apply_patch",
	"ast_grep_replace",
]);
const READ_ONLY_AGENTS = new Set([
	"explorer",
	"git",
	"diff-reader",
	"terminal-reader",
	"log-reader",
]);
const NON_PROOF_TOOLS = new Set([
	"goal",
	"todo",
	"Agent",
	"get_subagent_result",
]);
const SHELL_MUTATION =
	/(?:^|[;&|]\s*)(?:cp|mv|rm|touch|mkdir|rmdir|ln|install|patch|truncate|dd|rsync)\b|\b(?:sed\s+[^\n]*-[a-z]*i|perl\s+[^\n]*-[a-z]*pi)\b|(?:^|[^<])>{1,2}\s*[^&]|\b(?:tee|sponge)\b|\bgit\s+(?:apply|add|am|branch\s+-[dD]|cherry-pick|clean|commit|checkout|merge|mv|push|rebase|reset|restore|rm|stash|switch|tag)\b|\b(?:npm|pnpm|yarn|bun)\b[^\n;&|]{0,200}\b(?:install|i|add|remove|uninstall|update|upgrade|link|unlink)\b|\b(?:writeFile|write_text|write_bytes)\b|\bopen\s*\([^\n]*,[^\n]*["'][wax][+b]?["']/i;
const APPROVAL_PROOF =
	/(?:https?:\/\/\S+|(?:human|user)[^\n]{0,80}\b(?:approved|waived|reviewed)\b|\b(?:approved|waived|reviewed)\b[^\n]{0,80}(?:human|user))/i;
/** Rubber stamps a model reaches for instead of naming what it saw. */
const WEAK_EVIDENCE =
	/^(it |they |that |all |everything )?(is |are |was |were |now )?(done|ok|okay|fine|good|yes|true|works?|working|worked|passed|passes|passing|green|verified|confirmed|fixed|complete|completed|success|successful|lgtm|no errors|no issues|all good|all tests pass|tests pass|looks right|looks good|should work|as planned|as expected)[.!]*$/i;

const GoalParams = Type.Object({
	action: StringEnum([
		"status",
		"set_criteria",
		"set_roadmap",
		"step",
		"plan_approved",
		"evidence",
		"cycle",
		"await_plan",
		"await_review",
		"reviewed",
		"blocked",
		"done",
	] as const),
	criteria: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"set_criteria: the accepted criterion texts, in order. Existing evidence is carried over by matching text.",
		}),
	),
	roadmap: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"set_roadmap: ordered step texts. Existing step state is carried over by matching text.",
		}),
	),
	id: Type.Optional(
		Type.String({ description: "Criterion id (C1) or roadmap step id (S1)" }),
	),
	state: Type.Optional(
		StringEnum(["todo", "active", "done"] as const, {
			description: "step: the new state for that roadmap step",
		}),
	),
	evidence: Type.Optional(
		Type.String({
			description:
				"evidence: the proof you actually saw — command + real output, file:line, or the assertion that went green",
		}),
	),
	met: Type.Optional(
		Type.Boolean({
			description:
				"evidence: false retracts a criterion that regressed (evidence then records why)",
		}),
	),
	summary: Type.Optional(
		Type.String({ description: "cycle: what this slice actually changed" }),
	),
	next: Type.Optional(
		Type.String({ description: "cycle: the next slice, concrete" }),
	),
	note: Type.Optional(
		Type.String({
			description:
				"plan_approved/reviewed/forced criteria change: an http(s) review URL or an explicit human/user approval or waiver",
		}),
	),
	source: Type.Optional(
		Type.String({
			description:
				"evidence: toolCallId of the recent successful tool result that produced this proof",
		}),
	),
	reason: Type.Optional(Type.String({ description: "blocked: why" })),
	force: Type.Optional(
		Type.Boolean({
			description:
				"set_criteria: allow dropping accepted criteria only with note proving human approval",
		}),
	),
});

function skillPath(): string {
	return join(getAgentDir(), "skills", "goal", "SKILL.md");
}

function slugFor(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function sessionSlug(sessionId: string): string {
	return createHash("sha1").update(sessionId).digest("hex").slice(0, 12);
}

function goalDir(cwd: string, sessionId: string): string {
	return join(getAgentDir(), "goals", slugFor(cwd), sessionSlug(sessionId));
}

function goalFile(cwd: string, sessionId: string): string {
	return join(goalDir(cwd, sessionId), "GOAL.md");
}

function goalStateFile(cwd: string, sessionId: string): string {
	return join(goalDir(cwd, sessionId), "state.json");
}

function currentSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function pathIsInsideProject(raw: unknown, cwd: string): boolean {
	if (typeof raw !== "string" || !raw) return false;
	const target = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
	const rel = relative(resolve(cwd), target);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function mutatesProject(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): boolean {
	if (toolName === "bash") {
		return (
			typeof input.command === "string" && SHELL_MUTATION.test(input.command)
		);
	}
	if (toolName === "Agent") {
		const type =
			typeof input.subagent_type === "string" ? input.subagent_type : "";
		return !READ_ONLY_AGENTS.has(type.toLowerCase());
	}
	if (toolName === "lsp_navigation") {
		const operation = typeof input.operation === "string" ? input.operation : "";
		return (
			input.apply === true &&
			/^(?:rename|rename_file|executeCommand)$/.test(operation)
		);
	}
	if (toolName === "multi_tool_use.parallel") {
		const calls = Array.isArray(input.tool_uses) ? input.tool_uses : [];
		return calls.some((raw) => {
			const call = raw as {
				recipient_name?: string;
				parameters?: Record<string, unknown>;
			};
			const nestedName = call.recipient_name?.split(".").pop() ?? "";
			return mutatesProject(nestedName, call.parameters ?? {}, cwd);
		});
	}
	if (!WRITE_TOOLS.has(toolName)) return false;
	const paths = input.paths;
	if (Array.isArray(paths)) {
		return (
			paths.length === 0 || paths.some((path) => pathIsInsideProject(path, cwd))
		);
	}
	const raw = input.path ?? input.file_path ?? input.filePath;
	return raw === undefined || pathIsInsideProject(raw, cwd);
}

function clip(text: string, max: number): string {
	const t = text.trim().replace(/\s+/g, " ");
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function metCount(s: GoalState): number {
	return s.criteria.filter((c) => c.met).length;
}

function doneSteps(s: GoalState): number {
	return s.roadmap.filter((x) => x.state === "done").length;
}

function activeStep(s: GoalState): Step | undefined {
	return s.roadmap.find((x) => x.state === "active");
}

function reviewStale(s: GoalState): boolean {
	return s.reviewed && s.reviewSerial !== s.evidenceSerial;
}

/** The done gate: every criterion evidenced, review newer than the last change. */
function goalSatisfied(s: GoalState): boolean {
	return (
		s.criteria.length > 0 &&
		s.criteria.every((c) => c.met && c.evidence) &&
		s.reviewed &&
		!reviewStale(s)
	);
}

/** What is still standing between the goal and done, in human words. */
function missingForDone(s: GoalState): string[] {
	const out: string[] = [];
	if (s.criteria.length === 0) return ["no criteria recorded"];
	const unmet = s.criteria.filter((c) => !c.met || !c.evidence);
	if (unmet.length > 0) {
		out.push(`not evidenced: ${unmet.map((c) => c.id).join(", ")}`);
	}
	if (!s.reviewed) out.push("no human review recorded");
	else if (reviewStale(s)) out.push("evidence changed after the human review");
	return out;
}

/** Text key used to carry state across a criteria/roadmap rewrite. */
function keyOf(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function nextNumber(prefix: string, ids: string[]): number {
	let max = 0;
	for (const id of ids) {
		const n = Number.parseInt(id.slice(prefix.length), 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max + 1;
}

/** Reject a criterion "proof" that is really just a claim. */
function evidenceProblem(text: string): string | undefined {
	const t = text.trim();
	const say =
		"name the command and its real output, the file:line, or the assertion that went green";
	// Phrase first: every rubber stamp is shorter than the length floor, so
	// checking length first would make this branch unreachable.
	if (WEAK_EVIDENCE.test(t)) return `"${t}" is a claim, not evidence — ${say}`;
	if (t.length < EVIDENCE_MIN) return `too short (${t.length} chars) — ${say}`;
	return undefined;
}

function approvalProblem(note: string): string | undefined {
	if (APPROVAL_PROOF.test(note.trim())) return undefined;
	return "note must contain an http(s) review URL or explicitly say the human/user approved, reviewed, or waived it";
}

function uniqueTexts(texts: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of texts) {
		const text = clip(raw, TEXT_MAX);
		const key = keyOf(text);
		if (!text || seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	return out;
}

function parseCriteria(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const m = trimmed.match(/^(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?(.+)$/);
		if (!m) continue;
		const item = m[1].trim();
		if (!item) continue;
		out.push(item);
	}
	return out;
}

function criteriaFromTexts(texts: string[]): Criterion[] {
	return uniqueTexts(texts)
		.slice(0, MAX_ITEMS)
		.map((text, i) => ({ id: `C${i + 1}`, text, met: false }));
}

/** Rewrite the criteria list, carrying evidence and ids across by text. */
function mergeCriteria(
	prev: Criterion[],
	texts: string[],
): { next: Criterion[]; dropped: Criterion[] } {
	const byKey = new Map(prev.map((c) => [keyOf(c.text), c]));
	const usedIds = prev.map((c) => c.id);
	let free = nextNumber("C", usedIds);
	const next: Criterion[] = [];
	const keptKeys = new Set<string>();
	for (const text of uniqueTexts(texts).slice(0, MAX_ITEMS)) {
		const k = keyOf(text);
		keptKeys.add(k);
		const old = byKey.get(k);
		next.push(
			old
				? {
						id: old.id,
						text,
						met: old.met,
						evidence: old.evidence,
						evidenceSource: old.evidenceSource,
						cycle: old.cycle,
					}
				: { id: `C${free++}`, text, met: false },
		);
	}
	const dropped = prev.filter(
		(criterion) => !keptKeys.has(keyOf(criterion.text)),
	);
	return { next, dropped };
}

/** Rewrite the roadmap, carrying step state across by text. */
function mergeRoadmap(prev: Step[], texts: string[]): Step[] {
	const byKey = new Map(prev.map((x) => [keyOf(x.text), x]));
	let free = nextNumber(
		"S",
		prev.map((x) => x.id),
	);
	const next: Step[] = [];
	for (const text of uniqueTexts(texts).slice(0, MAX_ITEMS)) {
		const old = byKey.get(keyOf(text));
		next.push(
			old
				? { id: old.id, text, state: old.state }
				: { id: `S${free++}`, text, state: "todo" },
		);
	}
	return next;
}

function resolveCriterion(s: GoalState, raw: string): Criterion | undefined {
	const t = raw.trim();
	const n = t.replace(/^[Cc]/, "");
	return s.criteria.find(
		(c) => c.id.toLowerCase() === t.toLowerCase() || c.id === `C${n}`,
	);
}

function resolveStep(s: GoalState, raw: string): Step | undefined {
	const t = raw.trim();
	const n = t.replace(/^[Ss]/, "");
	return s.roadmap.find(
		(x) => x.id.toLowerCase() === t.toLowerCase() || x.id === `S${n}`,
	);
}

function planLine(s: GoalState): string {
	if (!s.planApproved) return "plan: not approved";
	return s.planNote ? `plan: approved — ${s.planNote}` : "plan: approved";
}

function reviewLine(s: GoalState): string {
	if (!s.reviewed) return "review: not recorded";
	return reviewStale(s)
		? "review: STALE — evidence changed after the human reviewed"
		: "review: recorded";
}

function renderMarkdown(s: GoalState): string {
	const lines: string[] = [
		"# Goal",
		"",
		s.task,
		"",
		"<!-- Written by the goal extension. Edit it with the `goal` tool, never with write/edit. -->",
		"",
		`- phase: ${s.phase}`,
		`- cycle: ${s.cycle}/${s.cycleCap}`,
		`- criteria: ${metCount(s)}/${s.criteria.length} evidenced`,
		`- ${planLine(s)}`,
		`- ${reviewLine(s)}`,
		`- updated: ${new Date(s.updatedAt).toISOString()}`,
		"",
		"## Acceptance criteria",
		"",
	];
	if (s.criteria.length === 0) {
		lines.push("(none yet)");
	} else {
		for (const c of s.criteria) {
			lines.push(`- [${c.met ? "x" : " "}] **${c.id}** ${c.text}`);
			if (c.evidence) {
				lines.push(
					`  - evidence${c.cycle ? ` (cycle ${c.cycle})` : ""}: ${c.evidence}`,
				);
				if (c.evidenceSource) {
					lines.push(
						`  - source: ${c.evidenceSource.toolName} ${c.evidenceSource.toolCallId} (${c.evidenceSource.outputHash})`,
					);
				}
			}
		}
	}
	lines.push("", "## Roadmap", "");
	if (s.roadmap.length === 0) {
		lines.push("(none yet)");
	} else {
		for (const x of s.roadmap) {
			const mark = x.state === "done" ? "x" : x.state === "active" ? ">" : " ";
			lines.push(`- [${mark}] **${x.id}** ${x.text}`);
		}
	}
	lines.push(
		"",
		"## Next slice",
		"",
		s.nextSlice || "(pick the next unmet criterion)",
		"",
	);
	if (s.blockedReason) {
		lines.push("## Blocked", "", s.blockedReason, "");
	}
	if (s.doneNote) {
		lines.push("## Closed", "", s.doneNote, "");
	}
	if (s.agents.length > 0) {
		lines.push("## Background agents not read back", "");
		for (const a of s.agents) {
			lines.push(`- \`${a.id}\` — ${a.description} (spawned cycle ${a.cycle})`);
		}
		lines.push("");
	}
	if (s.log.length > 0) {
		lines.push("## Cycle log", "");
		for (const entry of s.log) {
			lines.push(`### Cycle ${entry.n}`, "");
			lines.push(entry.summary);
			if (entry.files) lines.push(`- files: ${entry.files}`);
			lines.push(`- next: ${entry.next}`, "");
		}
	}
	return `${lines.join("\n")}\n`;
}

/** One-screen state, used in tool results, kickoffs and `/goal status`. */
function formatShort(s: GoalState): string {
	const met = metCount(s);
	const step = activeStep(s);
	const rows: string[] = [
		s.task,
		`phase ${s.phase} · cycle ${s.cycle}/${s.cycleCap} · ${met}/${s.criteria.length} evidenced · ${planLine(s)} · ${reviewLine(s)}`,
		`state: ${s.stateFile}`,
		`mirror: ${s.file}`,
	];
	for (const c of s.criteria) {
		const ev = c.evidence ? ` — ${c.evidence}` : "";
		rows.push(`[${c.met ? "x" : " "}] ${c.id} ${c.text}${ev}`);
	}
	if (s.roadmap.length > 0) {
		rows.push(
			`roadmap ${doneSteps(s)}/${s.roadmap.length}${step ? ` · active ${step.id} ${step.text}` : ""}`,
		);
	}
	if (s.nextSlice) rows.push(`next: ${s.nextSlice}`);
	if (s.blockedReason) rows.push(`blocked: ${s.blockedReason}`);
	if (s.doneNote) rows.push(`closed: ${s.doneNote}`);
	if (s.agents.length > 0) {
		rows.push(
			`background agents not read back: ${s.agents.map((a) => `${a.id} (${a.description})`).join(", ")}`,
		);
	}
	return rows.filter(Boolean).join("\n");
}

function editorTemplate(task: string): string {
	return [
		"# Goal",
		task,
		"",
		"## Acceptance criteria",
		"# One checkable bullet per criterion. Delete this comment.",
		"# Each must be provable by a command, a file, a test, or a visible behavior.",
		"- [ ] ",
		"- [ ] ",
		"- [ ] ",
		"",
	].join("\n");
}

/** Instructions handed to compaction so the summary stays goal-shaped. */
function compactInstructions(s: GoalState): string {
	const unmet = s.criteria.filter((c) => !c.met).map((c) => `${c.id} ${c.text}`);
	return [
		"GOAL LOOP cycle boundary. The scoped state.json is the authoritative record:",
		s.stateFile,
		"",
		"Keep, verbatim where you can:",
		`- the goal: ${clip(s.task, 300)}`,
		"- every acceptance criterion: id, met/unmet, and the evidence string exactly as written",
		"- the roadmap steps and their state",
		`- the next slice: ${clip(s.nextSlice, 200) || "(the next unmet criterion)"}`,
		unmet.length > 0 ? `- still unmet: ${clip(unmet.join("; "), 400)}` : "",
		"- files changed so far, and any command whose real output was the evidence",
		"- open blockers, human feedback, and background agents not yet read back",
		"",
		"Drop: tool dumps, file contents, search output, chatter, dead ends already abandoned.",
		"Never record a criterion as met unless the goal file says it is met.",
	]
		.filter(Boolean)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let state: GoalState | null = null;
	let aborted = false;
	let cycling = false;
	const recentProofs = new Map<string, EvidenceSource>();

	const touch = () => {
		if (state) state.updatedAt = Date.now();
	};

	const invalidateApproval = () => {
		if (!state) return;
		state.planApproved = false;
		state.planNote = undefined;
		state.reviewed = false;
		state.reviewNote = undefined;
		state.phase = "draft";
	};

	const rememberProof = (event: {
		toolCallId: string;
		toolName: string;
		isError?: boolean;
		content: { type: string; text?: string }[];
	}) => {
		if (event.isError || NON_PROOF_TOOLS.has(event.toolName)) return;
		const text = event.content
			.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
			.join("\n")
			.trim();
		if (!text) return;
		recentProofs.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			outputHash: createHash("sha256").update(text).digest("hex").slice(0, 16),
			recordedAt: Date.now(),
		});
		while (recentProofs.size > PROOF_CAP) {
			const oldest = recentProofs.keys().next().value;
			if (typeof oldest !== "string") break;
			recentProofs.delete(oldest);
		}
	};

	const persist = () => {
		if (!state) return;
		touch();
		const dir = goalDir(state.cwd, state.sessionId);
		mkdirSync(dir, { recursive: true });
		// Commit authoritative JSON first; the markdown mirror may lag after a kill,
		// but it must never claim state that was not durably recorded.
		const jsonTmp = `${state.stateFile}.tmp`;
		writeFileSync(jsonTmp, JSON.stringify(state, null, 2), "utf8");
		renameSync(jsonTmp, state.stateFile);
		const mdTmp = `${state.file}.tmp`;
		writeFileSync(mdTmp, renderMarkdown(state), "utf8");
		renameSync(mdTmp, state.file);
		pi.appendEntry(ENTRY, state);
	};

	/** Fill in anything an older/partial session entry is missing. */
	const normalize = (
		raw: Partial<GoalState>,
		cwd: string,
		sessionId: string,
	): GoalState => ({
		version: VERSION,
		cwd,
		sessionId,
		sessionFile: raw.sessionFile,
		task: raw.task ?? "",
		phase: raw.phase ?? "draft",
		cycle: raw.cycle ?? 0,
		cycleCap: raw.cycleCap ?? DEFAULT_CAP,
		criteria: (raw.criteria ?? []).map((criterion) => ({
			...criterion,
			met: Boolean(criterion.met),
		})),
		roadmap: raw.roadmap ?? [],
		nextSlice: raw.nextSlice ?? "",
		planApproved: raw.planApproved ?? false,
		planNote: raw.planNote,
		reviewed: raw.reviewed ?? false,
		reviewNote: raw.reviewNote,
		reviewSerial: raw.reviewSerial ?? 0,
		evidenceSerial: raw.evidenceSerial ?? 0,
		autoContinue: raw.autoContinue ?? false,
		lastAction: raw.lastAction ?? "start",
		nudgeCount: raw.nudgeCount ?? 0,
		stallCount: raw.stallCount ?? 0,
		lastFingerprint: raw.lastFingerprint,
		blockedReason: raw.blockedReason,
		doneNote: raw.doneNote,
		log: raw.log ?? [],
		agents: raw.agents ?? [],
		updatedAt: raw.updatedAt ?? 0,
		file: goalFile(cwd, sessionId),
		stateFile: goalStateFile(cwd, sessionId),
	});

	const loadDisk = (cwd: string, sessionId: string): GoalState | null => {
		const path = goalStateFile(cwd, sessionId);
		if (!existsSync(path)) return null;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GoalState>;
			if (parsed.cwd !== cwd || parsed.sessionId !== sessionId || !parsed.task) {
				return null;
			}
			return normalize(parsed, cwd, sessionId);
		} catch {
			return null;
		}
	};

	const ensureTool = () => {
		const active = pi.getActiveTools();
		if (!active.includes("goal")) pi.setActiveTools([...active, "goal"]);
	};

	const refreshWidget = (ctx?: ExtensionContext) => {
		if (!ctx?.hasUI) return;
		if (!state || state.phase === "done" || state.phase === "stopped") {
			ctx.ui.setWidget(WIDGET, undefined);
			ctx.ui.setStatus(WIDGET, undefined);
			return;
		}
		const s = state;
		const met = metCount(s);
		const total = s.criteria.length;
		ctx.ui.setStatus(
			WIDGET,
			ctx.ui.theme.fg("accent", `goal ${met}/${total} · c${s.cycle}`),
		);
		ctx.ui.setWidget(WIDGET, (_tui, theme) => {
			const header = theme.fg(
				"muted",
				`goal ${met}/${total} · c${s.cycle} ${s.phase}  /goal`,
			);
			const rows: string[] = [];
			const step = activeStep(s);
			if (step) {
				rows.push(
					`${theme.fg("accent", "▸")} ${theme.fg("accent", step.id)} ${theme.fg("text", step.text)}`,
				);
			} else if (total > 0 && met === total) {
				rows.push(
					theme.fg(
						s.reviewed && !reviewStale(s) ? "success" : "warning",
						s.reviewed && !reviewStale(s)
							? "all evidenced · reviewed"
							: "all evidenced · needs human review",
					),
				);
			}
			const lines = [header, ...rows];
			return { render: () => lines, invalidate: () => {} };
		});
	};

	const recoverDiskForEmptyBranch = (ctx: ExtensionContext): GoalState | null =>
		ctx.sessionManager.getBranch().length === 0
			? loadDisk(ctx.cwd, currentSessionId(ctx))
			: null;

	const reconstruct = (ctx: ExtensionContext) => {
		const sessionId = currentSessionId(ctx);
		const branch = ctx.sessionManager.getBranch();
		let fromSession: GoalState | null = null;
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const data = entry.data as Partial<GoalState> | undefined;
			if (!data?.task || (data.cwd && data.cwd !== ctx.cwd)) continue;
			fromSession = normalize(data, ctx.cwd, sessionId);
		}
		// The selected branch is authoritative. Disk is crash recovery only for a
		// brand-new/empty branch, never a newer sibling branch or another session.
		state = fromSession ?? recoverDiskForEmptyBranch(ctx);
		recentProofs.clear();
		if (state) ensureTool();
		refreshWidget(ctx);
	};

	const systemAppendix = (): string | undefined => {
		if (!state) return;
		if (state.phase === "done" || state.phase === "stopped") return;
		const s = state;
		const step = activeStep(s);
		const unmet = s.criteria.filter((c) => !c.met).slice(0, 8);
		const lines = [
			"GOAL LOOP ACTIVE",
			`State (authoritative): ${s.stateFile}`,
			`Markdown mirror: ${s.file}`,
			`Phase ${s.phase} · cycle ${s.cycle}/${s.cycleCap} · ${metCount(s)}/${s.criteria.length} evidenced · ${planLine(s)} · ${reviewLine(s)}`,
			`Task: ${clip(s.task, TASK_MAX)}`,
		];
		if (step) lines.push(`Active step: ${step.id} ${step.text}`);
		if (s.nextSlice) lines.push(`Next slice: ${clip(s.nextSlice, TEXT_MAX)}`);
		if (unmet.length > 0) {
			lines.push(
				`Unmet: ${unmet.map((c) => `${c.id} ${c.text}`).join(" | ")}${
					s.criteria.length - metCount(s) > unmet.length ? " | …" : ""
				}`,
			);
		}
		if (s.agents.length > 0) {
			lines.push(
				`Background agents not read back: ${s.agents.map((a) => a.id).join(", ")} — get_subagent_result before you cycle.`,
			);
		}
		lines.push(
			"Chat history is untrusted and may be a compaction leftover. Re-read the goal file, and re-read every file you are about to change.",
			"Record proof with `goal evidence` the moment you see it. End every slice with `goal cycle` / `await_plan` / `await_review` / `blocked` / `done` — never just stop.",
			"`goal done` is rejected until every criterion has evidence AND a human review recorded after the last evidence change. The goal closes itself the moment that gate is satisfied — when it does, stop and report; the user can also close it early with `/goal done`.",
			"Workers stay on chores; you own the thinking, every non-mechanical edit, and the review of what they return. Plan approval before product code.",
		);
		return lines.join("\n");
	};

	const kickoffStart = (s: GoalState): string => {
		const have = s.criteria.length > 0;
		return [
			"Start a goal loop. Read this skill and follow it:",
			skillPath(),
			"",
			`Goal state (authoritative): ${s.stateFile}`,
			`Markdown mirror: ${s.file}`,
			`Task: ${s.task}`,
			have
				? `The human accepted ${s.criteria.length} criteria — they are already in the goal file. Do not rewrite them unless the human changes them.`
				: "No criteria yet. Draft checkable acceptance criteria — each one provable by a command, a file, a test, or a visible behavior.",
			"",
			"Phase: draft. Product code is blocked until the plan is approved.",
			"1. Explore only what you cannot already specify (`Agent` explorer for a named search).",
			"2. `goal set_criteria` once the list is settled, then `goal set_roadmap` with the ordered steps.",
			"3. Write the implementation plan yourself. Submit it with diffing-plan-review, print the URL, and call `goal await_plan` when you park.",
			"4. When the human approves: `goal plan_approved` with their verdict, then `goal step` the first roadmap step to active and work it.",
			"5. End every slice with `goal cycle` (summary + next). Never mark a criterion met without `goal evidence`.",
			"",
			"Call `goal status` now, then begin.",
		].join("\n");
	};

	const kickoffCycle = (s: GoalState): string => {
		const n = s.cycle + 1;
		const step = activeStep(s);
		const lines = [
			`Goal loop cycle ${n}. Anything above this line is a leftover — do not take requirements or progress from it.`,
			"",
			`1. Read ${s.stateFile}. That JSON file is your authoritative memory.`,
			`2. Use ${s.file} only as the human-readable mirror. Follow ${skillPath()} if it is not in context.`,
			s.nextSlice
				? `3. Next slice: ${s.nextSlice}`
				: `3. Pick the next unmet criterion${step ? ` under ${step.id}` : ""}.`,
			"4. Re-read the actual files you will change. They may not look like they did last cycle.",
			"5. Record proof with `goal evidence` (id + what you saw). No evidence, no tick.",
			"6. End the slice with `goal cycle` / `await_plan` / `await_review` / `blocked` / `done`.",
		];
		if (s.agents.length > 0) {
			lines.push(
				`7. Read back or drop these background agents first: ${s.agents.map((a) => `${a.id} (${a.description})`).join(", ")}.`,
			);
		}
		lines.push("", formatShort(s));
		return lines.join("\n");
	};

	const kickoffNudge = (s: GoalState): string =>
		[
			"Goal loop is still active. You ended a turn without `goal cycle` / `await_plan` / `await_review` / `blocked` / `done`.",
			"Do not invent progress. Read the authoritative state, then either finish the slice or call the tool.",
			"",
			`State: ${s.stateFile}`,
			formatShort(s),
		].join("\n");

	const send = (ctx: ExtensionContext, text: string) => {
		if (ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	/**
	 * Cycle boundary. Compaction is a memory-pressure response, not a ritual —
	 * microcompact and auto-compress already bound a healthy context, so pay for
	 * a summary only when the window is actually filling up.
	 */
	const beginCycleRefresh = (ctx: ExtensionContext) => {
		if (!state || cycling) return;
		cycling = true;
		const s = state;

		const go = () => {
			cycling = false;
			if (!state) return;
			if (state.phase === "stopped" || state.phase === "done") return;
			if (!state.autoContinue) return;
			state.lastAction = "kickoff";
			persist();
			refreshWidget(ctx);
			send(ctx, kickoffCycle(state));
		};

		const percent = ctx.getContextUsage?.()?.percent;
		if (typeof percent !== "number" || percent < COMPACT_AT_PERCENT) {
			go();
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				`goal: compacting at ${Math.round(percent)}% for cycle ${s.cycle + 1}`,
				"info",
			);
		}
		requestCompaction(ctx, {
			reason: `goal-cycle-${s.cycle + 1}`,
			customInstructions: compactInstructions(s),
			minPercent: COMPACT_AT_PERCENT,
			onComplete: go,
			onError: (error) => {
				// "Nothing to compact" / "Already compacted" just means the window is
				// fine. Only a real failure is worth a warning.
				if (
					ctx.hasUI &&
					!/nothing to compact|already compacted/i.test(error.message)
				) {
					ctx.ui.notify(
						`goal: compact failed, continuing: ${error.message}`,
						"warning",
					);
				}
				go();
			},
		});
	};

	const snapshotGit = async (ctx: ExtensionContext): Promise<TreeSnapshot> => {
		try {
			const options = { cwd: ctx.cwd, timeout: 8000 };
			const [status, unstaged, staged, untracked] = await Promise.all([
				pi.exec("git", ["status", "--porcelain"], options),
				pi.exec("git", ["diff", "--binary", "--"], options),
				pi.exec("git", ["diff", "--binary", "--cached", "--"], options),
				pi.exec(
					"git",
					["ls-files", "--others", "--exclude-standard", "-z"],
					options,
				),
			]);
			if (
				[status, unstaged, staged, untracked].some((result) => result.code !== 0)
			) {
				return { fingerprint: "", files: "" };
			}
			const hash = createHash("sha256")
				.update(status.stdout)
				.update(unstaged.stdout)
				.update(staged.stdout);
			for (const raw of untracked.stdout.split("\0").filter(Boolean).sort()) {
				if (!pathIsInsideProject(raw, ctx.cwd)) continue;
				try {
					const path = resolve(ctx.cwd, raw);
					const file = lstatSync(path);
					hash.update(raw).update(String(file.size));
					if (file.isSymbolicLink()) {
						hash.update("<symlink>");
					} else if (file.size <= SNAPSHOT_FILE_MAX_BYTES) {
						hash.update(readFileSync(path));
					} else {
						hash.update(String(file.mtimeMs));
					}
				} catch {
					hash.update(raw).update("<unreadable>");
				}
			}
			return {
				fingerprint: hash.digest("hex"),
				files: status.stdout.trim(),
			};
		} catch {
			return { fingerprint: "", files: "" };
		}
	};

	/** Shut the loop down for good. The only place phase becomes "done". */
	const closeGoal = (ctx: ExtensionContext, note?: string) => {
		if (!state) return;
		state.phase = "done";
		state.autoContinue = false;
		state.lastAction = "done";
		state.doneNote = note;
		persist();
		refreshWidget(ctx);
	};

	const noGoal = (action: GoalAction) => ({
		content: [
			{
				type: "text" as const,
				text: "No active goal. The user starts one with /goal <task>.",
			},
		],
		details: { action, error: "no active goal" } satisfies GoalDetails,
	});

	const ok = (action: GoalAction, extra: string) => {
		if (!state) return noGoal(action);
		return {
			content: [
				{ type: "text" as const, text: `${extra}\n\n${formatShort(state)}` },
			],
			details: {
				action,
				phase: state.phase,
				cycle: state.cycle,
				met: metCount(state),
				total: state.criteria.length,
			} satisfies GoalDetails,
		};
	};

	const fail = (action: GoalAction, error: string) => {
		const extra = state ? `\n\n${formatShort(state)}` : "";
		return {
			content: [{ type: "text" as const, text: `Error: ${error}${extra}` }],
			details: {
				action,
				error,
				phase: state?.phase,
				cycle: state?.cycle,
				met: state ? metCount(state) : 0,
				total: state?.criteria.length ?? 0,
			} satisfies GoalDetails,
		};
	};

	const startGoal = async (task: string, ctx: ExtensionContext) => {
		const trimmed = clip(task, TASK_MAX);
		if (!trimmed) {
			if (ctx.hasUI) ctx.ui.notify("Usage: /goal <task>", "warning");
			return;
		}
		if (state && state.phase !== "done" && state.phase !== "stopped") {
			if (!ctx.hasUI) return;
			const okReplace = await ctx.ui.confirm(
				"Replace goal?",
				`Active: ${state.task}\n${metCount(state)}/${state.criteria.length} evidenced — the current goal file is overwritten.`,
			);
			if (!okReplace) return;
		}

		let criteria: Criterion[] = [];
		if (ctx.hasUI && ctx.mode === "tui") {
			const edited = await ctx.ui.editor(
				"Acceptance criteria (save to accept)",
				editorTemplate(trimmed),
			);
			if (edited === undefined) {
				ctx.ui.notify("Goal cancelled", "info");
				return;
			}
			criteria = criteriaFromTexts(parseCriteria(edited));
		}

		const sessionId = currentSessionId(ctx);
		state = {
			version: VERSION,
			cwd: ctx.cwd,
			sessionId,
			sessionFile: ctx.sessionManager.getSessionFile(),
			task: trimmed,
			phase: "draft",
			cycle: 0,
			cycleCap: DEFAULT_CAP,
			criteria,
			roadmap: [],
			nextSlice: "",
			planApproved: false,
			reviewed: false,
			reviewSerial: 0,
			evidenceSerial: 0,
			autoContinue: true,
			lastAction: "start",
			nudgeCount: 0,
			stallCount: 0,
			log: [],
			agents: [],
			updatedAt: Date.now(),
			file: goalFile(ctx.cwd, sessionId),
			stateFile: goalStateFile(ctx.cwd, sessionId),
		};
		ensureTool();
		persist();
		refreshWidget(ctx);
		try {
			pi.setSessionName(
				`goal: ${trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed}`,
			);
		} catch {
			/* session name is optional */
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				criteria.length > 0
					? `goal: ${criteria.length} criteria accepted · plan before code`
					: "goal: draft criteria + plan before code",
				"info",
			);
		}
		send(ctx, kickoffStart(state));
	};

	pi.on("session_start", async (event, ctx) => {
		reconstruct(ctx);
		if (!state) return;
		// A restart never resumes on its own — the user says /goal continue.
		if (event.reason === "new" || event.reason === "startup") {
			state.autoContinue = false;
			persist();
		}
		if (ctx.hasUI && state.phase !== "done" && state.phase !== "stopped") {
			ctx.ui.notify(
				`goal ${state.phase} · ${metCount(state)}/${state.criteria.length} evidenced · /goal continue to resume`,
				"info",
			);
		}
	});
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_compact", async () => {
		if (state) persist();
	});
	pi.on("session_shutdown", async () => {
		if (state) persist();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state || state.phase === "done" || state.phase === "stopped") return;
		ensureTool();
		refreshWidget(ctx);
		const extra = systemAppendix();
		if (!extra) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
	});

	// Plan-before-code, enforced across built-in, shell, LSP, AST, nested, and
	// write-capable subagent paths. Read-only planning work remains available.
	pi.on("tool_call", async (event, ctx) => {
		if (!state || state.planApproved) return;
		const input = event.input as Record<string, unknown>;
		if (!mutatesProject(event.toolName, input, ctx.cwd)) return;
		return {
			block: true,
			reason:
				"Goal loop: the implementation plan is not approved yet, so product code is blocked. Submit the plan (diffing-plan-review), print the URL, and record the verdict with `goal plan_approved` — or record the human's waiver there — then retry.",
		};
	});

	// Track background subagents so a context reset cannot lose the handle.
	pi.on("tool_result", async (event) => {
		if (!state || state.phase === "done" || state.phase === "stopped") return;
		rememberProof(event);
		if (event.toolName === "Agent") {
			const details = event.details as
				| { status?: string; agentId?: string }
				| undefined;
			if (details?.status !== "background" || !details.agentId) return;
			if (state.agents.some((a) => a.id === details.agentId)) return;
			const input = event.input as Record<string, unknown>;
			const description =
				typeof input.description === "string"
					? input.description
					: typeof input.subagent_type === "string"
						? input.subagent_type
						: "agent";
			state.agents.push({
				id: details.agentId,
				description: clip(description, 80),
				cycle: state.cycle,
			});
			persist();
			return;
		}
		if (event.toolName !== "get_subagent_result") return;
		const text = event.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		const m = /^Agent:\s*(\S+)[\s\S]*?Status:\s*([A-Za-z]+)/.exec(text.trim());
		if (!m) return;
		const [, id, status] = m;
		if (/^(running|queued)$/i.test(status)) return;
		const before = state.agents.length;
		state.agents = state.agents.filter((a) => a.id !== id);
		if (state.agents.length !== before) persist();
	});

	pi.on("agent_end", (event) => {
		aborted = false;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const m = event.messages[i] as { role?: string; stopReason?: string };
			if (m.role !== "assistant") continue;
			if (m.stopReason === "aborted" || m.stopReason === "error") aborted = true;
			break;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state || cycling) return;
		if (!state.autoContinue) return;
		if (state.phase !== "running" && state.phase !== "draft") return;
		if (aborted) {
			state.autoContinue = false;
			persist();
			if (ctx.hasUI) {
				ctx.ui.notify("goal: interrupted — /goal continue to resume", "warning");
			}
			return;
		}
		if (ctx.hasPendingMessages()) return;

		if (state.lastAction === "cycle") {
			if (state.cycle >= state.cycleCap) {
				state.autoContinue = false;
				persist();
				if (ctx.hasUI) {
					ctx.ui.notify(
						`goal: cycle cap ${state.cycleCap} — /goal continue to keep going`,
						"warning",
					);
				}
				return;
			}
			beginCycleRefresh(ctx);
			return;
		}

		if (state.nudgeCount < NUDGE_LIMIT) {
			state.nudgeCount += 1;
			state.lastAction = "nudge";
			persist();
			send(ctx, kickoffNudge(state));
			return;
		}

		state.autoContinue = false;
		persist();
		if (ctx.hasUI) {
			ctx.ui.notify(
				"goal: paused after a turn with no cycle/await/done — /goal continue",
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Manage the active /goal loop. The scoped state.json is authoritative; chat and GOAL.md are not. Actions: status; set_criteria (criteria[], force?, note?); set_roadmap (roadmap[]); step (id, state); plan_approved (note); evidence (id, evidence, source, met?); cycle (summary, next); await_plan; await_review; reviewed (note); blocked (reason); done. Successful evidence must cite a recent successful toolCallId. done is rejected until every criterion has sourced evidence AND a human review recorded after the last evidence change; once that gate is satisfied the goal closes itself on reviewed/cycle, so done is usually just confirmation.",
		promptSnippet:
			"When a /goal loop is active, record evidence and end every slice with this tool. Chat is not memory.",
		promptGuidelines: [
			"A goal loop's record is its scoped state.json. Re-read it at the start of a cycle; never take progress from chat or the Markdown mirror.",
			"Call goal evidence the moment a criterion is proven, with the output you actually saw and the successful source toolCallId. Never mark progress in prose only.",
			"End every slice with goal cycle / await_plan / await_review / blocked / done.",
			"goal done is invalid until every criterion has evidence and the human review is newer than the last evidence change. The loop closes itself as soon as that holds — when the tool says the goal closed, stop working it.",
		],
		parameters: GoalParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state) return noGoal(params.action);
			ensureTool();
			if (
				state.phase === "done" &&
				params.action !== "status" &&
				params.action !== "blocked" &&
				params.action !== "done"
			) {
				return fail(
					params.action,
					"goal is already done — /goal <task> starts a new one",
				);
			}
			// Any state-changing call is progress: it earns a fresh nudge budget.
			if (params.action !== "status") state.nudgeCount = 0;

			switch (params.action) {
				case "status":
					return ok(
						"status",
						`Goal state: ${state.stateFile}\nMarkdown mirror: ${state.file}`,
					);

				case "set_criteria": {
					const texts = (params.criteria ?? [])
						.map((text) => text.trim())
						.filter(Boolean);
					if (texts.length === 0) return fail("set_criteria", "criteria[] required");
					const previousKeys = state.criteria.map((criterion) =>
						keyOf(criterion.text),
					);
					const { next, dropped } = mergeCriteria(state.criteria, texts);
					if (next.length === 0) return fail("set_criteria", "no usable criteria");
					if (dropped.length > 0) {
						if (!params.force) {
							return fail(
								"set_criteria",
								`this would drop accepted criteria (${dropped.map((criterion) => criterion.id).join(", ")}). Keep their text, or pass force with a human approval note.`,
							);
						}
						const note = params.note?.trim() ?? "";
						const problem = approvalProblem(note);
						if (problem) return fail("set_criteria", problem);
					}
					const changed =
						previousKeys.join("\n") !==
						next.map((criterion) => keyOf(criterion.text)).join("\n");
					state.criteria = next;
					if (changed) {
						state.evidenceSerial += 1;
						invalidateApproval();
					}
					state.lastAction = "set_criteria";
					persist();
					refreshWidget(ctx);
					return ok(
						"set_criteria",
						`${state.criteria.length} criteria recorded${
							dropped.length > 0
								? ` · dropped ${dropped.map((c) => c.id).join(", ")}`
								: ""
						}. Set the roadmap next, then plan.`,
					);
				}

				case "set_roadmap": {
					const texts = (params.roadmap ?? [])
						.map((text) => text.trim())
						.filter(Boolean);
					if (texts.length === 0) return fail("set_roadmap", "roadmap[] required");
					const before = state.roadmap.map((step) => keyOf(step.text)).join("\n");
					state.roadmap = mergeRoadmap(state.roadmap, texts);
					if (before !== state.roadmap.map((step) => keyOf(step.text)).join("\n")) {
						invalidateApproval();
					}
					state.lastAction = "set_roadmap";
					persist();
					refreshWidget(ctx);
					return ok(
						"set_roadmap",
						`Roadmap: ${state.roadmap.length} steps. Mark one active with goal step.`,
					);
				}

				case "step": {
					if (!params.id?.trim()) return fail("step", "id required (S1)");
					if (!params.state)
						return fail("step", "state required (todo|active|done)");
					const step = resolveStep(state, params.id);
					if (!step) return fail("step", `unknown step ${params.id}`);
					if (params.state === "active") {
						for (const other of state.roadmap) {
							if (other.state === "active") other.state = "todo";
						}
					}
					step.state = params.state;
					state.lastAction = "step";
					persist();
					refreshWidget(ctx);
					return ok("step", `${step.id} → ${step.state}`);
				}

				case "plan_approved": {
					const note = params.note?.trim();
					if (!note) {
						return fail(
							"plan_approved",
							"note required — the plan URL and the human's verdict, or how they waived plan review",
						);
					}
					const problem = approvalProblem(note);
					if (problem) return fail("plan_approved", problem);
					state.planApproved = true;
					state.planNote = clip(note, TEXT_MAX);
					if (state.phase === "await_plan") state.phase = "running";
					state.lastAction = "plan_approved";
					persist();
					refreshWidget(ctx);
					return ok("plan_approved", "Plan approved. Product code is unblocked.");
				}

				case "evidence": {
					if (!params.id?.trim()) return fail("evidence", "id required (C1)");
					const c = resolveCriterion(state, params.id);
					if (!c) return fail("evidence", `unknown id ${params.id}`);
					const text = params.evidence?.trim() ?? "";
					if (!text) {
						return fail("evidence", "evidence required — the proof you actually saw");
					}
					const met = params.met !== false;
					let source: EvidenceSource | undefined;
					if (met) {
						const problem = evidenceProblem(text);
						if (problem) return fail("evidence", problem);
						const sourceId = params.source?.trim();
						if (!sourceId) {
							return fail(
								"evidence",
								"source required — pass the toolCallId that produced this proof",
							);
						}
						source = recentProofs.get(sourceId);
						if (!source) {
							return fail(
								"evidence",
								`source ${sourceId} is not a recent successful verification result`,
							);
						}
					}
					c.met = met;
					c.evidence = clip(text, EVIDENCE_MAX);
					c.evidenceSource = source;
					c.cycle = state.cycle;
					state.evidenceSerial += 1;
					state.stallCount = 0;
					state.lastAction = "evidence";
					persist();
					refreshWidget(ctx);
					const stale = reviewStale(state)
						? " The human review is now stale — re-review before done."
						: "";
					return ok(
						"evidence",
						met ? `${c.id} evidenced.${stale}` : `${c.id} retracted.${stale}`,
					);
				}

				case "cycle": {
					if (!params.summary?.trim() || !params.next?.trim()) {
						return fail("cycle", "summary and next required");
					}
					if (state.criteria.length === 0) {
						return fail(
							"cycle",
							"no criteria yet — call set_criteria first (or wait for the human's list)",
						);
					}
					if (state.phase === "stopped") return fail("cycle", "goal is stopped");
					// Nothing left to cycle towards: close instead of spinning.
					if (goalSatisfied(state)) {
						closeGoal(ctx);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`goal complete · ${metCount(state)}/${state.criteria.length} evidenced and reviewed`,
								"info",
							);
						}
						return ok(
							"cycle",
							"Every criterion is evidenced and the review is current — the goal closed itself. End the turn and report what shipped.",
						);
					}
					const tree = await snapshotGit(ctx);
					// A session event could have cleared the goal while git ran.
					if (!state) return noGoal("cycle");
					const fingerprint = tree.fingerprint
						? [
								metCount(state),
								state.evidenceSerial,
								doneSteps(state),
								tree.fingerprint,
							].join("\n")
						: undefined;
					if (fingerprint && state.lastFingerprint === fingerprint) {
						state.stallCount += 1;
					} else {
						state.stallCount = 0;
					}
					state.lastFingerprint = fingerprint;
					if (state.stallCount >= STALL_LIMIT) {
						state.phase = "blocked";
						state.autoContinue = false;
						state.blockedReason = `${STALL_LIMIT + 1} cycles with no new evidence and no change to the tree`;
						state.lastAction = "blocked";
						persist();
						refreshWidget(ctx);
						return fail(
							"cycle",
							"stalled — no new evidence and no tree change for three cycles. Say what is blocking you and ask the user. They resume with /goal continue.",
						);
					}
					state.phase = state.planApproved ? "running" : "draft";
					state.autoContinue = true;
					state.nudgeCount = 0;
					state.nextSlice = clip(params.next, TEXT_MAX);
					state.blockedReason = undefined;
					state.lastAction = "cycle";
					state.cycle += 1;
					state.log.push({
						n: state.cycle,
						summary: clip(params.summary, SUMMARY_MAX),
						next: state.nextSlice,
						files: tree.files ? tree.files.split("\n").join("; ") : undefined,
					});
					if (state.log.length > LOG_CAP) state.log = state.log.slice(-LOG_CAP);
					persist();
					refreshWidget(ctx);
					const pending = state.agents.length
						? ` Background agents still unread: ${state.agents.map((a) => a.id).join(", ")} — read them back next cycle or drop them.`
						: "";
					return ok(
						"cycle",
						`Cycle recorded.${pending} End the turn now — the loop re-anchors you for the next slice. Do not start more work this turn.`,
					);
				}

				case "await_plan":
					state.phase = "await_plan";
					state.autoContinue = false;
					state.lastAction = "await_plan";
					persist();
					refreshWidget(ctx);
					return ok(
						"await_plan",
						"Parked on plan approval. Print the plan URL. After the human answers, record it with goal plan_approved; the user resumes with /goal continue.",
					);

				case "await_review":
					state.phase = "await_review";
					state.autoContinue = false;
					state.lastAction = "await_review";
					persist();
					refreshWidget(ctx);
					return ok(
						"await_review",
						"Parked on human /review. Print the review URL. The user resumes with /goal continue.",
					);

				case "reviewed": {
					if (state.criteria.some((c) => !c.met)) {
						return fail(
							"reviewed",
							`review is for finished work — still unmet: ${state.criteria
								.filter((c) => !c.met)
								.map((c) => c.id)
								.join(", ")}`,
						);
					}
					const reviewNote = params.note?.trim() ?? "";
					const reviewProblem = approvalProblem(reviewNote);
					if (reviewProblem) return fail("reviewed", reviewProblem);
					state.reviewed = true;
					state.reviewNote = clip(reviewNote, TEXT_MAX);
					state.reviewSerial = state.evidenceSerial;
					state.lastAction = "reviewed";
					if (goalSatisfied(state)) {
						closeGoal(ctx);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`goal complete · ${metCount(state)}/${state.criteria.length} evidenced and reviewed`,
								"info",
							);
						}
						return ok(
							"reviewed",
							"Review recorded and every criterion is evidenced — the goal closed itself. Stop working it; report what shipped.",
						);
					}
					persist();
					refreshWidget(ctx);
					return ok(
						"reviewed",
						"Human review recorded. Re-check every criterion still holds, then done.",
					);
				}

				case "blocked": {
					const reason = params.reason?.trim();
					if (!reason) return fail("blocked", "reason required");
					state.phase = "blocked";
					state.autoContinue = false;
					state.blockedReason = clip(reason, SUMMARY_MAX);
					state.lastAction = "blocked";
					persist();
					refreshWidget(ctx);
					return ok("blocked", `Blocked: ${state.blockedReason}`);
				}

				case "done": {
					if (state.phase === "done") {
						return ok(
							"done",
							state.doneNote
								? `Goal already closed — ${state.doneNote}`
								: "Goal complete already: it closed itself when the review landed.",
						);
					}
					if (state.criteria.length === 0) return fail("done", "no criteria");
					const unmet = state.criteria.filter((c) => !c.met || !c.evidence);
					if (unmet.length > 0) {
						return fail(
							"done",
							`not evidenced: ${unmet.map((c) => c.id).join(", ")} — prove each one`,
						);
					}
					if (!state.reviewed) {
						return fail(
							"done",
							"no human review recorded — /review, then goal reviewed once they approve",
						);
					}
					if (reviewStale(state)) {
						return fail(
							"done",
							"evidence changed after the human review — take it back through /review, then goal reviewed",
						);
					}
					closeGoal(ctx);
					return ok(
						"done",
						"Goal complete: every criterion evidenced, human-reviewed after the last change.",
					);
				}

				default:
					return fail("status", `unknown action ${String(params.action)}`);
			}
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("muted", args.action);
			if (args.id) text += ` ${theme.fg("accent", args.id)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as GoalDetails | undefined;
			const line = result.content[0];
			const msg = line?.type === "text" ? line.text.split("\n")[0] : "";
			if (details?.error) return new Text(theme.fg("error", msg), 0, 0);
			const meta =
				details && details.total !== undefined
					? theme.fg(
							"dim",
							` ${details.met}/${details.total} · ${details.phase ?? ""}`,
						)
					: "";
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", msg) + meta,
				0,
				0,
			);
		},
	});

	const subs = [
		{ value: "status", label: "status", description: "Show the active goal" },
		{ value: "continue", label: "continue", description: "Resume the loop" },
		{ value: "stop", label: "stop", description: "Halt auto-continue" },
		{ value: "done", label: "done", description: "Mark the goal complete now" },
		{ value: "file", label: "file", description: "Print the goal file path" },
	];

	pi.registerCommand("goal", {
		description:
			"Long-running loop until every criterion is evidenced, human-reviewed, and validated",
		getArgumentCompletions: (prefix: string) => {
			if (prefix.includes(" ")) return null;
			const p = prefix.trim().toLowerCase();
			const items = subs.filter((s) => s.value.startsWith(p));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const sub = raw.split(/\s+/)[0]?.toLowerCase() ?? "";

			if (!raw) {
				if (state && state.phase !== "done" && state.phase !== "stopped") {
					if (ctx.hasUI) ctx.ui.notify(formatShort(state), "info");
					return;
				}
				if (!ctx.hasUI) return;
				const task = await ctx.ui.input(
					"Goal",
					"what should be true when this is done?",
				);
				if (!task?.trim()) return;
				await startGoal(task, ctx);
				return;
			}

			if (sub === "status") {
				const s = state ?? recoverDiskForEmptyBranch(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(s ? formatShort(s) : "No active goal", "info");
				}
				return;
			}

			if (sub === "file") {
				const file = state?.file ?? goalFile(ctx.cwd, currentSessionId(ctx));
				if (ctx.hasUI) ctx.ui.notify(file, "info");
				return;
			}

			if (sub === "stop") {
				if (!state) {
					if (ctx.hasUI) ctx.ui.notify("No active goal", "info");
					return;
				}
				state.phase = "stopped";
				state.autoContinue = false;
				state.lastAction = "stop";
				persist();
				refreshWidget(ctx);
				if (ctx.hasUI)
					ctx.ui.notify("goal stopped · /goal continue resumes", "info");
				return;
			}

			if (sub === "done") {
				if (!state) state = recoverDiskForEmptyBranch(ctx);
				if (!state) {
					if (ctx.hasUI) ctx.ui.notify("No active goal", "warning");
					return;
				}
				if (state.phase === "done") {
					if (ctx.hasUI) ctx.ui.notify("Goal already done", "info");
					return;
				}
				// The human outranks the gate, but they get to see what they are skipping.
				const missing = missingForDone(state);
				if (missing.length > 0 && ctx.hasUI) {
					const okDone = await ctx.ui.confirm(
						"Mark the goal done?",
						`${missing.join("\n")}\n\nClosing it anyway is recorded in the goal file.`,
					);
					if (!okDone) return;
				}
				closeGoal(
					ctx,
					missing.length > 0
						? `closed by the user with ${missing.join("; ")}`
						: undefined,
				);
				if (ctx.hasUI) {
					ctx.ui.notify(
						missing.length > 0
							? `goal closed by you · ${missing.join(" · ")}`
							: "goal done · every criterion evidenced and reviewed",
						"info",
					);
				}
				return;
			}

			if (sub === "continue") {
				if (!state) state = recoverDiskForEmptyBranch(ctx);
				if (!state) {
					if (ctx.hasUI) ctx.ui.notify("No goal to continue", "warning");
					return;
				}
				if (state.phase === "done") {
					if (ctx.hasUI) ctx.ui.notify("Goal already done", "info");
					return;
				}
				if (state.cycle >= state.cycleCap)
					state.cycleCap = state.cycle + DEFAULT_CAP;
				if (state.phase === "stopped" || state.phase === "blocked") {
					state.phase = state.planApproved ? "running" : "draft";
					state.blockedReason = undefined;
					state.stallCount = 0;
					state.lastFingerprint = undefined;
				}
				// Parked on a human gate: only the recorded verdict moves the phase on.
				if (state.phase === "await_plan") state.phase = "draft";
				if (state.phase === "await_review") state.phase = "running";
				state.autoContinue = true;
				state.nudgeCount = 0;
				state.lastAction = "continue";
				ensureTool();
				persist();
				refreshWidget(ctx);
				send(ctx, state.cycle === 0 ? kickoffStart(state) : kickoffCycle(state));
				return;
			}

			await startGoal(raw, ctx);
		},
	});
}
