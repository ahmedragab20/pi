/**
 * /visualise — break down complex architecture/topics/thinking into a
 * visualised flow with notes and annotations.
 *
 * Phase 1: `/visualise [topic] [--repo|--conversation|--last]` sends a
 * kickoff user message; the agent researches and calls the
 * `render_visualisation` tool with a structured graph. The tool validates
 * the graph, renders it as ASCII in the transcript, and saves the JSON
 * graph under `~/.pi/agent/visualisations/` for later phases (interactive
 * TUI explorer, HTML/SVG export).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GraphKind = StringEnum([
	"flowchart",
	"sequence",
	"concept",
	"decision",
	"dependency",
] as const);

const NodeSchema = Type.Object({
	id: Type.String({
		description: "Unique node identifier, referenced by edges",
	}),
	label: Type.String({
		description: "Human-readable node label shown in the diagram",
	}),
	group: Type.Optional(
		Type.String({ description: "Group id this node belongs to" }),
	),
	note: Type.Optional(Type.String({ description: "Short per-node annotation" })),
});

const EdgeSchema = Type.Object({
	from: Type.String({ description: "Source node id" }),
	to: Type.String({ description: "Target node id" }),
	label: Type.Optional(
		Type.String({ description: "Short edge label (condition, payload, action)" }),
	),
});

const GroupSchema = Type.Object({
	id: Type.String({ description: "Unique group identifier" }),
	label: Type.String({ description: "Group label shown as a section header" }),
	note: Type.Optional(
		Type.String({ description: "Short per-group annotation" }),
	),
});

const NoteSchema = Type.Object({
	ref: Type.Optional(
		Type.String({
			description:
				"Node id, group id, or edge as 'from->to' this note attaches to",
		}),
	),
	text: Type.String({ description: "The note text" }),
});

const VisualisationParams = Type.Object({
	title: Type.String({ description: "Diagram title" }),
	kind: GraphKind,
	nodes: Type.Array(NodeSchema, { description: "Nodes in the graph" }),
	edges: Type.Array(EdgeSchema, {
		description: "Directed connections between nodes",
	}),
	groups: Type.Optional(
		Type.Array(GroupSchema, { description: "Optional grouping of nodes" }),
	),
	notes: Type.Array(NoteSchema, {
		description: "Numbered notes and annotations",
	}),
	assumptions: Type.Optional(
		Type.Array(Type.String(), { description: "Assumptions made" }),
	),
	sources: Type.Optional(
		Type.Array(Type.String(), { description: "Files or URLs used as evidence" }),
	),
});

type Graph = Static<typeof VisualisationParams>;

interface VisualiseOptions {
	/** Where graph JSON files are written. Defaults to <agentDir>/visualisations. */
	outputDir?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateGraph(graph: Graph): string[] {
	const errors: string[] = [];
	const nodeIds = new Set<string>();
	const groupIds = new Set<string>();
	const edgeKeys = new Set<string>();

	if (graph.nodes.length === 0) {
		errors.push("Error: graph has no nodes");
	}

	for (const group of graph.groups ?? []) {
		if (groupIds.has(group.id)) {
			errors.push(`Error: duplicate group id "${group.id}"`);
		}
		groupIds.add(group.id);
	}

	for (const node of graph.nodes) {
		if (nodeIds.has(node.id)) {
			errors.push(`Error: duplicate node id "${node.id}"`);
			continue;
		}
		nodeIds.add(node.id);
		if (node.group && !groupIds.has(node.group)) {
			errors.push(
				`Error: node "${node.id}" references unknown group "${node.group}"`,
			);
		}
	}

	for (const edge of graph.edges) {
		const key = `${edge.from}->${edge.to}`;
		if (edgeKeys.has(key)) {
			continue; // parallel duplicate edges render once; not an error
		}
		edgeKeys.add(key);
		if (!nodeIds.has(edge.from)) {
			errors.push(
				`Error: edge "${key}" references unknown "from" node "${edge.from}"`,
			);
		}
		if (!nodeIds.has(edge.to)) {
			errors.push(
				`Error: edge "${key}" references unknown "to" node "${edge.to}"`,
			);
		}
	}

	for (const note of graph.notes) {
		if (!note.ref) continue;
		const refOk =
			nodeIds.has(note.ref) ||
			groupIds.has(note.ref) ||
			(note.ref.includes("->") && edgeKeys.has(note.ref));
		if (!refOk) {
			errors.push(
				`Error: note references unknown node, group, or edge "${note.ref}"`,
			);
		}
	}

	return errors;
}

// ---------------------------------------------------------------------------
// ASCII rendering
// ---------------------------------------------------------------------------

const MAX_WIDTH = 100;
const LABEL_MAX = 44;
const EDGE_LABEL_MAX = 28;
const NOTE_WRAP = 92;

/** Order nodes by BFS depth from in-degree-0 roots, stable on declaration order. */
function orderNodes(graph: Graph): typeof graph.nodes {
	const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
	const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
	const adjacency = new Map<string, string[]>(
		graph.nodes.map((n) => [n.id, []]),
	);
	for (const edge of graph.edges) {
		if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
		adjacency.get(edge.from)!.push(edge.to);
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
	}

	const queue = graph.nodes
		.filter((n) => (indegree.get(n.id) ?? 0) === 0)
		.sort((a, b) => index.get(a.id)! - index.get(b.id)!)
		.map((n) => n.id);
	const visited = new Set<string>();
	const ordered: string[] = [];

	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		ordered.push(id);
		for (const next of adjacency.get(id) ?? []) {
			if (!visited.has(next)) queue.push(next);
		}
	}
	// Cycles: append any never-visited nodes in declaration order.
	for (const node of graph.nodes) {
		if (!visited.has(node.id)) ordered.push(node.id);
	}

	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	return ordered.map((id) => byId.get(id)!);
}

function wrapPlain(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (visibleWidth(candidate) > width && line) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines;
}

/**
 * Plain-text truncation. pi-tui's truncateToWidth emits ANSI reset codes
 * around the ellipsis — right for styled TUI lines, wrong for tool result
 * text. This variant never emits escape sequences.
 */
function truncatePlain(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const cw = ch.codePointAt(0)! > 0xffff ? 2 : 1;
		if (used + cw > width - 1) break;
		out += ch;
		used += cw;
	}
	return `${out}…`;
}

function renderBox(label: string, note: string | undefined): string[] {
	const text = truncatePlain(label, LABEL_MAX);
	const inner = visibleWidth(text) + 2;
	const top = `┌${"─".repeat(inner)}┐`;
	const mid = `│ ${text} │`;
	const bottom = `└${"─".repeat(inner)}┘`;
	const lines = [top, mid, bottom];
	if (note) {
		for (const wrapped of wrapPlain(truncatePlain(note, LABEL_MAX), inner)) {
			lines.push(`  ${wrapped}`);
		}
	}
	return lines;
}

function renderEdgeLine(
	prefix: string,
	label: string | undefined,
	target: string,
): string {
	const labelPart = label ? ` ${truncatePlain(label, EDGE_LABEL_MAX)} ` : "";
	const line = `${prefix}${labelPart}─▶ ${truncatePlain(target, LABEL_MAX)}`;
	return truncatePlain(line, MAX_WIDTH);
}

function renderGraph(graph: Graph): string {
	const lines: string[] = [];
	const rule = "═".repeat(MAX_WIDTH);
	const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));

	// Header
	lines.push(rule);
	lines.push(`  ${truncatePlain(graph.title, MAX_WIDTH - 4)}  (${graph.kind})`);
	lines.push(rule);
	lines.push("");

	// Group sections: declared groups first (declaration order), ungrouped last
	const sections: Array<{ label: string; note?: string; ids: string[] }> = [];
	const grouped = new Set<string>();
	for (const group of graph.groups ?? []) {
		const ids = graph.nodes.filter((n) => n.group === group.id).map((n) => n.id);
		ids.forEach((id) => grouped.add(id));
		sections.push({ label: group.label, note: group.note, ids });
	}
	const ungrouped = graph.nodes
		.filter((n) => !grouped.has(n.id))
		.map((n) => n.id);
	if (ungrouped.length > 0 && (graph.groups?.length ?? 0) > 0) {
		sections.push({ label: "Other", ids: ungrouped });
	}

	const ordered = orderNodes(graph);
	const edgesByFrom = new Map<string, typeof graph.edges>();
	for (const edge of graph.edges) {
		const list = edgesByFrom.get(edge.from) ?? [];
		list.push(edge);
		edgesByFrom.set(edge.from, list);
	}

	if (sections.length === 0) {
		sections.push({ label: "", ids: ordered.map((n) => n.id) });
	}

	for (const section of sections) {
		if (section.label) {
			lines.push(
				`── ${truncatePlain(section.label, MAX_WIDTH - 6)} ${"─".repeat(4)}`,
			);
			if (section.note)
				lines.push(`   ${truncatePlain(section.note, MAX_WIDTH - 6)}`);
		}
		for (const id of section.ids) {
			const node = ordered.find((n) => n.id === id);
			if (!node) continue;
			lines.push(...renderBox(node.label, node.note));
			const outgoing = (edgesByFrom.get(id) ?? []).filter((e) =>
				labelOf.has(e.to),
			);
			outgoing.forEach((edge, i) => {
				const last = i === outgoing.length - 1;
				// Single edge: plain leading spaces — the arrow comes from
				// renderEdgeLine, so no doubled "▶─▶" glyph.
				const prefix = outgoing.length === 1 ? "  " : last ? "  └─▶" : "  ├─▶";
				lines.push(renderEdgeLine(prefix, edge.label, labelOf.get(edge.to)!));
			});
			lines.push("");
		}
	}

	// Notes
	if (graph.notes.length > 0) {
		lines.push("── Notes ────────────────────────");
		graph.notes.forEach((note, i) => {
			const prefix = note.ref
				? `[${truncatePlain(note.ref, EDGE_LABEL_MAX)}] `
				: "";
			const first = `${i + 1}. ${prefix}`;
			const body = `${first}${note.text}`;
			const wrapped = wrapPlain(truncatePlain(body, 2000), NOTE_WRAP);
			if (wrapped.length === 0) wrapped.push("");
			wrapped.forEach((line, j) => {
				lines.push(j === 0 ? line : `   ${line}`);
			});
		});
		lines.push("");
	}

	// Assumptions
	if (graph.assumptions && graph.assumptions.length > 0) {
		lines.push("── Assumptions ──────────────────");
		for (const assumption of graph.assumptions) {
			wrapPlain(assumption, NOTE_WRAP - 2).forEach((line, j) => {
				lines.push(j === 0 ? `- ${line}` : `  ${line}`);
			});
		}
		lines.push("");
	}

	// Sources
	if (graph.sources && graph.sources.length > 0) {
		lines.push("── Sources ───────────────────────");
		for (const source of graph.sources) {
			lines.push(truncatePlain(`- ${source}`, MAX_WIDTH));
		}
		lines.push("");
	}

	return lines.map((line) => truncatePlain(line, MAX_WIDTH)).join("\n");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "visualisation";
}

function timestamp(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

function saveGraph(graph: Graph, outputDir: string): string {
	mkdirSync(outputDir, { recursive: true });
	const file = join(outputDir, `${timestamp()}-${slugify(graph.title)}.json`);
	writeFileSync(file, JSON.stringify(graph, null, "\t"), "utf8");
	return file;
}

// ---------------------------------------------------------------------------
// Kickoff prompt
// ---------------------------------------------------------------------------

interface ContentBlock {
	type?: string;
	text?: string;
}

interface SessionEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as ContentBlock).type === "text"
		) {
			const text = (part as ContentBlock).text;
			if (typeof text === "string" && text.trim().length > 0) parts.push(text);
		}
	}
	return parts;
}

function buildConversationText(entries: SessionEntry[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text.length === 0) continue;
		sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return sections.join("\n\n");
}

function lastAssistantText(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

type ContextMode = "auto" | "repo" | "conversation" | "last";

function parseArgs(raw: string): { mode: ContextMode; topic: string } {
	const tokens = raw.split(/\s+/).filter(Boolean);
	let mode: ContextMode = "auto";
	const topicParts: string[] = [];
	for (const token of tokens) {
		if (token === "--repo" || token === "--conversation" || token === "--last") {
			mode = token.slice(2) as ContextMode;
		} else {
			topicParts.push(token);
		}
	}
	return { mode, topic: topicParts.join(" ") };
}

function buildKickoff(
	topic: string,
	mode: ContextMode,
	conversationText: string,
): string {
	const parts: string[] = [];

	parts.push(
		"Visualise a complex architecture/topic/line of thinking as a diagram with notes and annotations.",
	);
	if (topic) {
		parts.push(`Topic: ${topic}`);
	}

	parts.push(
		[
			"Steps:",
			"1. Research the topic first — read relevant files, conversation context, or reason it through. Do not skip this.",
			"2. Decide the clearest diagram kind (flowchart, sequence, concept, decision, or dependency).",
			"3. Call the render_visualisation tool with the complete graph: title, kind, nodes (id, label, optional group/note), edges (from, to, optional label), optional groups, numbered notes (attach refs where useful), assumptions, and sources (file paths/URLs used).",
			"4. After the render, briefly summarise the key takeaways in one or two sentences.",
		].join("\n"),
	);

	if (mode === "repo") {
		parts.push(
			"Focus on the current repository: explore the codebase in the working directory to ground the diagram in real files and modules.",
		);
	} else if (mode === "last") {
		if (conversationText) {
			parts.push(`<last-message>\n${conversationText}\n</last-message>`);
		} else {
			parts.push(
				"No previous assistant message found; work from the current session context.",
			);
		}
	} else if (conversationText) {
		parts.push(`<conversation>\n${conversationText}\n</conversation>`);
	}

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export function registerVisualise(
	pi: ExtensionAPI,
	options: VisualiseOptions = {},
): void {
	const outputDir = options.outputDir ?? join(getAgentDir(), "visualisations");

	pi.registerCommand("visualise", {
		description:
			"Break down a topic/architecture into a visualised flow with notes",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { mode, topic } = parseArgs(args);

			const branch = (ctx.sessionManager?.getBranch?.() ?? []) as SessionEntry[];
			let conversationText = "";
			if (mode === "last") {
				conversationText = lastAssistantText(branch) ?? "";
			} else if (mode === "auto" || mode === "conversation") {
				conversationText = buildConversationText(branch);
			}

			if (!topic && !conversationText && mode !== "repo") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Nothing to visualise: no topic and no conversation context",
						"warning",
					);
				}
				return;
			}

			const kickoff = buildKickoff(topic, mode, conversationText);
			if (ctx.isIdle?.()) {
				pi.sendUserMessage(kickoff);
			} else {
				pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Visualisation kickoff sent — researching and rendering",
					"info",
				);
			}
		},
	});

	pi.registerTool({
		name: "render_visualisation",
		label: "Render Visualisation",
		description:
			"Render a structured graph as an ASCII diagram with notes and annotations. Use when the user asks to visualise, outline, or diagram an architecture, topic, or line of thinking.",
		promptGuidelines: [
			"Use render_visualisation when the user asks to visualise, outline, or diagram an architecture, topic, or line of thinking.",
		],
		parameters: VisualisationParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const errors = validateGraph(params);
			if (errors.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: ["Validation failed — fix the graph and retry:", ...errors].join(
								"\n",
							),
						},
					],
					details: { valid: false, errors },
				};
			}

			const rendered = renderGraph(params);
			const file = saveGraph(params, outputDir);
			const savedLine = truncatePlain(`Saved graph JSON: ${file}`, MAX_WIDTH);
			return {
				content: [
					{
						type: "text" as const,
						text: `${rendered}\n${savedLine}`,
					},
				],
				details: { valid: true, file },
			};
		},
	});
}

export default function visualise(pi: ExtensionAPI): void {
	registerVisualise(pi);
}
