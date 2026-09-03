/**
 * Worker models: OpenCode Go GLM Flash first, then OpenCode Go DeepSeek Flash
 * if GLM is unauthed or out of usage. Never switches the lead.
 *
 * Agent frontmatter cannot express a fallback (a pinned `model:` is locked),
 * so worker files omit `model` and this fills `Agent.model` before spawn.
 * Foreground failures are replaced inline; detached failures are retried as a
 * new detached agent and notify through the normal subagent completion path.
 */
import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	isModelExhausted,
	isUsageLimitError,
	markExhaustedFromError,
	markModelExhausted,
	resetProviderExhaustion,
} from "./opencode-fallback.ts";

type Pair = readonly [string, string];
type AgentInput = Record<string, unknown>;
type AgentEvent = {
	id?: string;
	status?: string;
	result?: string;
	error?: string;
};

type PendingBackground = {
	input: AgentInput;
	model: string;
};

const FLASH: Pair[] = [
	["opencode-go", "glm-5.3-flash"],
	["opencode-go", "deepseek-v4-flash"],
];
const RETRY_TIMEOUT_MS = 8 * 60_000;

function spec([provider, id]: Pair): string {
	return `${provider}/${id}`;
}

async function pickModel(
	ctx: ExtensionContext,
	chain: Pair[],
): Promise<string | undefined> {
	for (const pair of chain) {
		if (isModelExhausted(pair[0], pair[1])) continue;
		const model = ctx.modelRegistry.find(pair[0], pair[1]);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		return spec(pair);
	}
	return undefined;
}

function resultText(event: ToolResultEvent): string {
	const parts: string[] = [];
	for (const c of event.content ?? []) {
		if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
	}
	const details = event.details as
		| { error?: unknown; result?: unknown }
		| undefined;
	if (details?.error) parts.push(String(details.error));
	if (details?.result) parts.push(String(details.result));
	return parts.join("\n");
}

function rpc<T>(
	pi: ExtensionAPI,
	channel: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<T> {
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`${channel} timed out`));
		}, timeoutMs);
		const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw) => {
			clearTimeout(timer);
			unsub();
			const reply = raw as { success: boolean; data?: T; error?: string };
			if (reply.success) resolve(reply.data as T);
			else reject(new Error(reply.error ?? "rpc failed"));
		});
		pi.events.emit(channel, { requestId, ...params });
	});
}

function waitAgent(
	pi: ExtensionAPI,
	id: string,
	timeoutMs: number,
): Promise<AgentEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			offCompleted();
			offFailed();
			reject(new Error("fallback agent timed out"));
		}, timeoutMs);
		const done = (raw: unknown) => {
			const data = raw as AgentEvent;
			if (data.id !== id) return;
			clearTimeout(timer);
			offCompleted();
			offFailed();
			resolve(data);
		};
		const offCompleted = pi.events.on("subagents:completed", done);
		const offFailed = pi.events.on("subagents:failed", done);
	});
}

function retryOptions(
	input: AgentInput,
	model: string,
): Record<string, unknown> {
	return {
		description: String(input.description ?? "worker fallback"),
		name: input.name,
		model,
		maxTurns: input.max_turns,
		isolated: input.isolated,
		inheritContext: input.inherit_context,
		thinkingLevel: input.thinking,
		isBackground: true,
		isolation: input.isolation,
	};
}

async function spawnRetry(
	pi: ExtensionAPI,
	input: AgentInput,
	model: string,
): Promise<string> {
	const type = input.subagent_type;
	const prompt = input.prompt;
	if (typeof type !== "string" || typeof prompt !== "string") {
		throw new Error("worker fallback is missing subagent_type or prompt");
	}
	const spawned = await rpc<{ id: string }>(
		pi,
		"subagents:rpc:spawn",
		{
			type,
			prompt,
			options: retryOptions(input, model),
		},
		15_000,
	);
	if (!spawned?.id) throw new Error("worker fallback returned no agent id");
	return spawned.id;
}

async function stopRetry(pi: ExtensionAPI, id: string): Promise<void> {
	try {
		await rpc<void>(pi, "subagents:rpc:stop", { agentId: id }, 5_000);
	} catch {
		// The agent may have completed between the timeout and stop request.
	}
}

function terminalFailure(event: AgentEvent): boolean {
	return (
		event.status === "error" ||
		event.status === "aborted" ||
		event.status === "stopped"
	);
}

export default function workerModel(pi: ExtensionAPI) {
	const retried = new Set<string>();
	const pendingBackground = new Map<string, PendingBackground>();
	let sessionCtx: ExtensionContext | undefined;

	const reset = () => {
		resetProviderExhaustion();
		retried.clear();
		pendingBackground.clear();
	};

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		reset();
	});

	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
		pendingBackground.clear();
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (event.status !== 402 || !ctx.model) return;
		markModelExhausted(`${ctx.model.provider}/${ctx.model.id}`);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "Agent") return;
		sessionCtx = ctx;
		const input = event.input as AgentInput;
		if (typeof input.resume === "string" && input.resume.trim()) return;
		if (typeof input.model === "string" && input.model.trim()) return;

		const picked = await pickModel(ctx, FLASH);
		if (picked) input.model = picked;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "Agent") return;
		sessionCtx = ctx;
		const input = event.input as AgentInput;
		const details = event.details as
			| { status?: string; agentId?: string }
			| undefined;

		if (!event.isError && details?.status === "background" && details.agentId) {
			const model = typeof input.model === "string" ? input.model : "";
			pendingBackground.set(details.agentId, { input: { ...input }, model });
			return;
		}

		if (!event.isError || retried.has(event.toolCallId)) return;
		if (typeof input.resume === "string" && input.resume.trim()) return;

		const text = resultText(event);
		if (!isUsageLimitError(text)) return;

		const used = typeof input.model === "string" ? input.model : "";
		markExhaustedFromError(text, used);
		const picked = await pickModel(ctx, FLASH);
		if (!picked || picked === used) return;

		retried.add(event.toolCallId);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${used} out of usage — retrying worker on ${picked}`,
				"warning",
			);
		}

		let spawnedId: string | undefined;
		try {
			spawnedId = await spawnRetry(pi, input, picked);
			const finished = await waitAgent(pi, spawnedId, RETRY_TIMEOUT_MS);
			const ok = !terminalFailure(finished);
			const body =
				(ok ? finished.result : finished.error || finished.result) ??
				"Worker fallback finished with no text.";
			return {
				content: [
					{
						type: "text" as const,
						text: ok ? `${body}\n\n(retried on ${picked} after usage limit)` : body,
					},
				],
				isError: !ok,
			};
		} catch (error) {
			if (spawnedId) await stopRetry(pi, spawnedId);
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [
					{
						type: "text" as const,
						text: `${text}\n\nFallback retry failed: ${message}`,
					},
				],
				isError: true,
			};
		}
	});

	const offCompleted = pi.events.on("subagents:completed", (raw) => {
		const event = raw as AgentEvent;
		if (event.id) pendingBackground.delete(event.id);
	});

	const offFailed = pi.events.on("subagents:failed", (raw) => {
		const event = raw as AgentEvent;
		const id = event.id;
		if (!id) return;
		const pending = pendingBackground.get(id);
		pendingBackground.delete(id);
		const text = `${event.error ?? ""}\n${event.result ?? ""}`;
		if (!pending || retried.has(id) || !isUsageLimitError(text)) return;
		const ctx = sessionCtx;
		if (!ctx) return;

		void (async () => {
			markExhaustedFromError(text, pending.model);
			const picked = await pickModel(ctx, FLASH);
			if (!picked || picked === pending.model) return;
			retried.add(id);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`${pending.model} out of usage — retrying background worker on ${picked}`,
					"warning",
				);
			}
			void rpc<void>(pi, "subagents:rpc:consume", { agentId: id }, 5_000).catch(
				() => {
					// A visible failure notification is preferable to delaying the retry.
				},
			);
			try {
				const replacementId = await spawnRetry(pi, pending.input, picked);
				pendingBackground.set(replacementId, {
					input: { ...pending.input, model: picked },
					model: picked,
				});
			} catch (error) {
				if (ctx.hasUI) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Background worker fallback failed: ${message}`, "error");
				}
			}
		})();
	});

	pi.on("session_shutdown", () => {
		offCompleted();
		offFailed();
	});
}
