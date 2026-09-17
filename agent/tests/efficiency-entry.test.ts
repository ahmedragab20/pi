import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import efficiency from "../extensions/efficiency/index.ts";

function harness() {
	const handlers = new Map<string, (() => void)[]>();
	const registered = new Map<string, ToolDefinition>();
	const commands: string[] = [];
	const tools = [
		...[
			"read",
			"bash",
			"edit",
			"write",
			"ls",
			"Agent",
			"find",
			"grep",
			"agent_browser",
		].map((name) => ({ name, description: name })),
		{ name: "ast_grep", description: "ast-grep structural search" },
	];
	let active = tools.map((tool) => tool.name);
	const pi = {
		on(event: string, handler: () => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			registered.set(tool.name, tool);
			tools.push({ name: tool.name, description: tool.description });
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		getAllTools: () => tools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	efficiency(pi as unknown as ExtensionAPI);
	return {
		handlers,
		registered,
		commands,
		active: () => active,
		start: () => handlers.get("session_start")!.forEach((handler) => handler()),
	};
}

test("entry point leaves context untouched and keeps browser/core tools discoverable", async () => {
	const h = harness();
	expect([...h.handlers.keys()]).toEqual(["session_start"]);
	expect(h.commands).toEqual(["tools"]);
	expect([...h.registered.keys()]).toEqual(["tool_search"]);
	h.start();
	for (const name of [
		"read",
		"bash",
		"edit",
		"write",
		"Agent",
		"agent_browser",
		"tool_search",
	]) {
		expect(h.active()).toContain(name);
	}
	expect(h.active()).not.toContain("ast_grep");
	const result = await h.registered
		.get("tool_search")!
		.execute(
			"search",
			{ query: "ast-grep" },
			undefined,
			undefined,
			{} as never,
		);
	expect(result.details).toEqual({
		matches: ["ast_grep"],
		added: ["ast_grep"],
	});
	expect(h.active()).toContain("ast_grep");
	expect(h.active()).toContain("agent_browser");
});

test("an empty discovery query leaves active tools unchanged", async () => {
	const h = harness();
	h.start();
	const before = [...h.active()];
	const result = await h.registered
		.get("tool_search")!
		.execute("empty", { query: "  " }, undefined, undefined, {} as never);
	expect(result.details).toEqual({ matches: [], added: [] });
	expect(h.active()).toEqual(before);
});
