/**
 * Model-scoped worker fallback and option-preserving retries.
 *
 *   bun test agent/tests/worker-model.test.ts
 *
 * Regression coverage for the worker model chain
 * (opencode-go/glm-5.3-flash → opencode-go/deepseek-v4-flash):
 * exhaustion must be scoped per model (GLM out ≠ DeepSeek out) with a
 * provider-level kill switch, and the foreground usage-limit retry must
 * re-spawn on the next model through `subagents:rpc:spawn` while preserving
 * the runner options of the original Agent call.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import workerModelExtension from "../extensions/worker-model.ts";
import {
	isProviderExhausted,
	isModelExhausted,
	markProviderExhausted,
	markModelExhausted,
	resetProviderExhaustion,
} from "../extensions/opencode-fallback.ts";

const GLM = "opencode-go/glm-5.3-flash";
const DEEPSEEK = "opencode-go/deepseek-v4-flash";

type Handler = (event: unknown, ctx: unknown) => unknown;
type EventBusHandler = (payload: unknown) => void;

interface SpawnCall {
	requestId: string;
	type: unknown;
	prompt: unknown;
	options: Record<string, unknown>;
}

function makeHarness() {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, EventBusHandler[]>();
	const spawns: SpawnCall[] = [];
	const notices: string[] = [];

	const bus = {
		on: (event: string, handler: EventBusHandler) => {
			const list = busHandlers.get(event) ?? [];
			list.push(handler);
			busHandlers.set(event, list);
			return () => {
				const current = busHandlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
		},
		emit: (event: string, payload: unknown) => {
			for (const handler of [...(busHandlers.get(event) ?? [])]) {
				handler(payload);
			}
		},
	};

	// Scripted responder: every spawn gets an id, then a completed event.
	// The RPC reply event is `${channel}:reply:${requestId}`; the completed
	// event must be async because `waitAgent` only subscribes after the
	// spawn reply resolves, so a synchronous emit would be missed.
	bus.on("subagents:rpc:spawn", (raw) => {
		const payload = raw as {
			requestId: string;
			type: unknown;
			prompt: unknown;
			options: Record<string, unknown>;
		};
		spawns.push({
			requestId: payload.requestId,
			type: payload.type,
			prompt: payload.prompt,
			options: payload.options ?? {},
		});
		setTimeout(() => {
			bus.emit(`subagents:rpc:spawn:reply:${payload.requestId}`, {
				success: true,
				data: { id: "fb-agent-1" },
			});
			setTimeout(() => {
				bus.emit("subagents:completed", {
					id: "fb-agent-1",
					status: "completed",
					result: "fallback output from deepseek",
				});
			}, 0);
		}, 0);
	});

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		events: bus,
	};

	const ctx = {
		hasUI: true,
		cwd: "/tmp/worker-model-test",
		ui: {
			notify: (message: string) => notices.push(message),
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "opencode-go" &&
				(id === "glm-5.3-flash" || id === "deepseek-v4-flash")
					? { provider, id }
					: undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	};

	workerModelExtension(pi as never);

	const fire = async (event: string, payload: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	};

	return { fire, spawns, notices, bus };
}

describe("worker model exhaustion scopes", () => {
	beforeEach(() => {
		resetProviderExhaustion();
	});

	test("marking GLM exhausted leaves DeepSeek selectable", () => {
		markModelExhausted(GLM);
		expect(isModelExhausted(GLM)).toBe(true);
		expect(isModelExhausted(DEEPSEEK)).toBe(false);
		// A single dead model is not a dead provider.
		expect(isProviderExhausted("opencode-go")).toBe(false);
	});

	test("marking the provider exhausted suppresses both flash models", () => {
		markProviderExhausted("opencode-go");
		expect(isProviderExhausted("opencode-go")).toBe(true);
		expect(isModelExhausted(GLM)).toBe(true);
		expect(isModelExhausted(DEEPSEEK)).toBe(true);
	});

	test("reset clears both scopes", () => {
		markModelExhausted(GLM);
		markProviderExhausted("opencode-go");
		resetProviderExhaustion();
		expect(isProviderExhausted("opencode-go")).toBe(false);
		expect(isModelExhausted(GLM)).toBe(false);
		expect(isModelExhausted(DEEPSEEK)).toBe(false);
	});
});

describe("foreground Agent usage-limit fallback", () => {
	beforeEach(() => {
		resetProviderExhaustion();
	});

	test("retries on DeepSeek and preserves runner options", async () => {
		const h = makeHarness();

		const [replacement] = (await h.fire("tool_result", {
			toolCallId: "call-1",
			toolName: "Agent",
			isError: true,
			input: {
				subagent_type: "tests",
				prompt: "run the worker suite",
				description: "run tests",
				name: "tests-worker",
				thinking: "low",
				max_turns: 12,
				isolated: true,
				inherit_context: false,
				isolation: "worktree",
				model: GLM,
			},
			content: [
				{ type: "text", text: "GoUsageLimitError: quota exceeded for opencode-go" },
			],
		})) as { content: { type: string; text: string }[]; isError?: boolean }[];

		// Exactly one replacement spawn, on the next model in the chain.
		expect(h.spawns.length).toBe(1);
		const spawn = h.spawns[0];
		const options = spawn?.options ?? {};
		expect(spawn?.type).toBe("tests");
		expect(spawn?.prompt).toBe("run the worker suite");
		expect(options.model).toBe(DEEPSEEK);
		// Runner options of the original Agent call survive the retry.
		expect(options.description).toBe("run tests");
		expect(options.name).toBe("tests-worker");
		expect(options.thinkingLevel).toBe("low");
		expect(options.maxTurns).toBe(12);
		expect(options.isolated).toBe(true);
		expect(options.inheritContext).toBe(false);
		expect(options.isolation).toBe("worktree");

		// The replacement result must not surface the quota error to the lead.
		expect(replacement).toBeDefined();
		expect(replacement.isError).toBe(false);
		const text = replacement.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("fallback output from deepseek");
		expect(text).not.toContain("GoUsageLimitError");
	});

	test("retries a detached usage-limit failure on the next model", async () => {
		const h = makeHarness();
		await h.fire("tool_result", {
			toolCallId: "call-bg",
			toolName: "Agent",
			isError: false,
			input: {
				subagent_type: "explorer",
				prompt: "map the project",
				description: "map project",
				model: GLM,
				run_in_background: true,
			},
			details: { status: "background", agentId: "bg-agent-1" },
			content: [{ type: "text", text: "Agent started" }],
		});
		h.bus.emit("subagents:failed", {
			id: "bg-agent-1",
			status: "error",
			error: "GoUsageLimitError: quota exceeded for opencode-go",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.spawns).toHaveLength(1);
		expect(h.spawns[0].options.model).toBe(DEEPSEEK);
		expect(h.spawns[0].type).toBe("explorer");
		expect(h.spawns[0].prompt).toBe("map the project");
	});
});
