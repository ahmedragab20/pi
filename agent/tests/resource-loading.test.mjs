import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js";
import { SettingsManager } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { DefaultPackageManager } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js";
import { DefaultResourceLoader } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";
import { createEventBus } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

// Real installed resources, but never install packages or contact providers.
assert.equal(process.env.PI_OFFLINE, "1", "Run with PI_OFFLINE=1");
const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(agentDir, "..");
const sdkEntry = new URL(
	"../npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
	import.meta.url,
);
const sdkRequire = createRequire(sdkEntry);
const { createJiti } = sdkRequire("jiti");
// The installed fork relies on the same SDK alias supplied by pi's extension loader.
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": fileURLToPath(sdkEntry) },
});
const fork = new URL(
	"../git/github.com/ahmedragab20/pi-subagents/dist/",
	import.meta.url,
);
const { loadCustomAgents } = await jiti.import(
	new URL("custom-agents.js", fork).href,
);
const { resolveAgentInvocationConfig } = await jiti.import(
	new URL("invocation-config.js", fork).href,
);
const { loadSettings } = await jiti.import(new URL("settings.js", fork).href);

function isExtension(path, name) {
	return path.replace(/\/index\.[jt]s$/, "").endsWith(`/${name}`);
}

test("resource resolution preserves browser and disables only selected resources", async () => {
	const settings = SettingsManager.create(repoRoot, agentDir);
	const manager = new DefaultPackageManager({
		cwd: repoRoot,
		agentDir,
		settingsManager: settings,
	});
	const resolved = await manager.resolve(async () => "error");
	const enabled = resolved.extensions
		.filter((r) => r.enabled)
		.map((r) => r.path);
	for (const name of ["context-efficiency.ts", "worker-model.ts"]) {
		assert.equal(
			enabled.some((p) => isExtension(p, name)),
			false,
			name,
		);
	}
	for (const name of [
		"browser",
		"security-gate.ts",
		"vision-router.ts",
		"efficiency",
		"diffing",
		"ui",
	]) {
		assert.ok(
			enabled.some((p) => isExtension(p, name)),
			name,
		);
	}
	for (const source of ["npm:pi-intercom", "npm:pi-tool-repair"]) {
		for (const resources of Object.values(resolved)) {
			assert.equal(
				resources.some((r) => r.metadata.source === source && r.enabled),
				false,
				source,
			);
		}
		const entry = settings
			.getPackages()
			.find((p) => typeof p === "object" && p.source === source);
		assert.ok(entry, `${source} remains installed/configured`);
		for (const key of ["extensions", "skills", "prompts", "themes"])
			assert.deepEqual(entry[key], []);
	}
	assert.deepEqual(settings.getCompactionSettings(), {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	});
});

test("real extension loading retains browser, review, and deferred tools", {
	timeout: 60000,
}, async () => {
	const loader = new DefaultResourceLoader({
		cwd: repoRoot,
		agentDir,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	const { extensions, errors } = loader.getExtensions();
	assert.deepEqual(errors, []);
	const ui = extensions.find((extension) => isExtension(extension.path, "ui"));
	assert.ok(ui, "unified UI loads through normal resource discovery");
	assert.equal(ui.tools.size, 0, "presentation must not override tools");
	assert.ok(ui.commands.has("ui"));
	const attention = extensions.find((extension) => isExtension(extension.path, "question-attention.ts"));
	assert.ok(attention, "question attention loads through normal discovery");
	assert.equal(attention.tools.size, 0, "attention must not replace the question tool");
	const names = new Set(
		extensions.flatMap((extension) => [...extension.tools.keys()]),
	);
	for (const name of [
		"agent_browser",
		"Agent",
		"tool_search",
		"diffing_status",
	]) {
		assert.ok(names.has(name), `${name} is registered`);
	}
	for (const name of ["worker-model.ts", "context-efficiency.ts"]) {
		assert.equal(
			extensions.some((e) => isExtension(e.path, name)),
			false,
			name,
		);
	}
});

test("real question tool brackets herdr attention for answer, cancellation, and UI errors", { timeout: 15000 }, async () => {
	const { default: questionAttention } = await jiti.import(new URL("../extensions/question-attention.ts", import.meta.url).href);
	const { registerAskUserQuestionTool } = await jiti.import(new URL("../npm/node_modules/@juicesharp/rpiv-ask-user-question/ask-user-question.ts", import.meta.url).href);
	const params = { questions: [{
		question: "Which synthetic option?", header: "Fixture",
		options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
	}] };
	for (const outcome of ["answer", "cancel", "error"]) {
		const events = createEventBus();
		const handlers = new Map();
		const reports = [];
		const shown = Promise.withResolvers();
		const answer = Promise.withResolvers();
		let tool;
		const pi = {
			events,
			on: (name, handler) => handlers.set(name, handler),
			registerTool: (definition) => { tool = definition; },
		};
		events.on("herdr:blocked", (data) => reports.push(data));
		questionAttention(pi);
		registerAskUserQuestionTool(pi);
		const ctx = { mode: "tui", hasUI: true, ui: {
			custom: () => { shown.resolve(); return answer.promise; },
		} };
		await handlers.get("session_start")({}, ctx);
		const execution = tool.execute("synthetic-question", params, undefined, undefined, ctx)
			.then((value) => ({ value }), (error) => ({ error }));
		await shown.promise; // Explicit condition: the real tool is waiting for its dialog.
		assert.deepEqual(reports, [{ active: true, label: "Question awaiting answer" }]);
		const result = outcome === "answer"
			? { cancelled: false, answers: [{ questionIndex: 0, question: params.questions[0].question, kind: "option", answer: "A" }] }
			: { cancelled: true, answers: [] };
		if (outcome === "error") answer.reject(new Error("synthetic dialog failure"));
		else answer.resolve(result);
		const settled = await execution;
		if (outcome === "error") assert.equal(settled.error?.message, "synthetic dialog failure");
		else assert.deepEqual(settled.value.details, result);
		assert.deepEqual(reports, [{ active: true, label: "Question awaiting answer" }, { active: false }]);
		await handlers.get("session_shutdown")({}, ctx);
		assert.equal(reports.length, 2);
		events.clear();
	}
});

test("vision presentation distinguishes errors, cancellation, and consumed jobs", async () => {
	const { visionActivity } = await jiti.import(new URL("../extensions/vision-router.ts", import.meta.url).href);
	const abort = new AbortController();
	const job = { status: "running", startedAt: 100, abort };
	assert.deepEqual(visionActivity(job), { id: "vision", startedAt: 100, state: "running", label: "Describing images" });
	assert.equal(visionActivity({ ...job, status: "error" }).state, "error");
	assert.equal(visionActivity({ ...job, status: "done" }).state, "success");
	abort.abort();
	assert.equal(visionActivity({ ...job, status: "done" }).state, "cancelled");
	assert.deepEqual(visionActivity({ ...job, consumed: true }), { id: "vision", remove: true });
	assert.deepEqual(visionActivity(undefined), { id: "vision", remove: true });
});

test("the worker allowlist activates the real headless safety gate", {
	timeout: 60000,
}, async () => {
	const worker = loadCustomAgents(repoRoot).get("worker");
	assert.ok(worker);
	const loader = new DefaultResourceLoader({
		cwd: repoRoot,
		agentDir,
		additionalExtensionPaths: worker.extensions,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPromptOverride: () => [],
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter((e) =>
				worker.extensions.includes(e.path),
			),
		}),
	});
	await loader.reload();
	const { extensions, errors } = loader.getExtensions();
	assert.deepEqual(errors, []);
	const extensionPaths = extensions.map((e) => e.path).sort();
	const expectedPaths = [
		join(agentDir, "extensions/security-gate.ts"),
		join(agentDir, "extensions/browser/browser-verify.ts"),
	].sort();
	assert.deepEqual(extensionPaths, expectedPaths);
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	assert.deepEqual(loader.getSkills().skills, []);
	assert.deepEqual(loader.getAppendSystemPrompt(), []);
	const gate = extensions.find((e) => e.path.endsWith("security-gate.ts"));
	assert.ok(gate);
	assert.equal(gate.tools.size, 0);
	const verify = extensions.find((e) =>
		e.path.endsWith("browser/browser-verify.ts"),
	);
	assert.ok(verify);
	assert.deepEqual([...verify.tools.keys()], ["browser_verify"]);
	const [gateHandler] = gate.handlers.get("tool_call");
	const context = { hasUI: false, cwd: repoRoot };
	const event = (command) => ({
		type: "tool_call",
		toolCallId: "gate-test",
		toolName: "bash",
		input: { command },
	});
	// Invoke only the preflight hook; neither command is executed.
	assert.equal(await gateHandler(event("printf harmless"), context), undefined);
	assert.equal(
		(await gateHandler(event("printf harmless # .env"), context)).block,
		true,
	);
	assert.equal((await gateHandler(event("sudo harmless"), context)).block, true);
});

test("only the optional worker remains and its safety settings override caller params", () => {
	assert.deepEqual(
		readdirSync(join(agentDir, "agents")).filter((p) => p.endsWith(".md")),
		["worker.md"],
	);
	const { frontmatter: fm } = parseFrontmatter(
		readFileSync(join(agentDir, "agents/worker.md"), "utf8"),
	);
	assert.equal(fm.model, "openai-codex/gpt-5.6-luna");
	assert.equal(fm.thinking, "medium");
	assert.equal(fm.max_turns, 40);
	assert.equal(fm.isolated, false);
	assert.equal(fm.skills, false);
	assert.equal(fm.inherit_context, false);
	assert.equal(fm.prompt_mode, "replace");
	assert.deepEqual(fm.extensions, [
		join(agentDir, "extensions/security-gate.ts"),
		join(agentDir, "extensions/browser/browser-verify.ts"),
	]);
	assert.equal(fm.allowed_subagents, undefined);
	const worker = loadCustomAgents(repoRoot).get("worker");
	assert.ok(worker);
	const invocation = resolveAgentInvocationConfig(worker, {
		isolated: true,
		model: "wrong/model",
		thinking: "low",
		max_turns: 100,
	});
	assert.equal(invocation.isolated, false);
	assert.equal(invocation.modelInput, fm.model);
	assert.equal(invocation.thinking, "medium");
	assert.equal(invocation.maxTurns, 40);
	assert.equal(invocation.inheritContext, false);
});

test("global worker limits apply without conflicting project overrides", () => {
	assert.equal(existsSync(join(repoRoot, ".pi/subagents.json")), false);
	const settings = loadSettings(repoRoot);
	assert.equal(settings.maxConcurrent, 1);
	assert.equal(settings.maxConcurrentForeground, 1);
	assert.equal(settings.maxSubagentDepth, 1);
	assert.equal(settings.defaultMaxTurns, 40);
	assert.equal(settings.graceTurns, 2);
	assert.equal(settings.disableDefaultAgents, true);
	assert.equal(settings.fallbackSubagent, "none");
	for (const key of ["schedulingEnabled", "workflowsEnabled", "fleetView"])
		assert.equal(settings[key], false, key);
	assert.equal(settings.widgetMode, "off");
	assert.equal(settings.agentMentions, "off");
});
