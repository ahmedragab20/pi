/**
 * Worker models: OpenCode Go GLM Flash first, then OpenCode Go DeepSeek Flash
 * if GLM is unauthed or out of usage. Never switches the lead.
 *
 * Images are not routed here — a multimodal lead sees them natively, and a
 * text-only lead is covered by `vision-router.ts`, which forks a headless
 * `pi -p` child rather than spawning a subagent.
 *
 * Agent frontmatter cannot express a fallback (a pinned `model:` is locked),
 * so worker files omit `model` and this fills `Agent.model` before spawn.
 * A failed spawn is retried once on the next model in the chain and the tool
 * result is replaced so the lead never sees the quota error.
 */
import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	isProviderExhausted,
	isUsageLimitError,
	markExhaustedFromError,
	markProviderExhausted,
	resetProviderExhaustion,
} from "./opencode-fallback.ts";

type Pair = readonly [string, string];

const FLASH: Pair[] = [
	["opencode-go", "glm-5.3-flash"],
	["opencode-go", "deepseek-v4-flash"],
];

function spec([provider, id]: Pair): string {
	return `${provider}/${id}`;
}

function providerOfSpec(s: string): string {
	return s.split("/")[0] ?? "";
}

async function pickModel(
	ctx: ExtensionContext,
	chain: Pair[],
): Promise<string | undefined> {
	for (const pair of chain) {
		if (isProviderExhausted(pair[0])) continue;
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
): Promise<{ status: string; result?: string; error?: string }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			offC();
			offF();
			reject(new Error("fallback agent timed out"));
		}, timeoutMs);
		const done = (raw: unknown) => {
			const data = raw as {
				id?: string;
				status?: string;
				result?: string;
				error?: string;
			};
			if (data.id !== id) return;
			clearTimeout(timer);
			offC();
			offF();
			resolve({
				status: data.status ?? "completed",
				result: data.result,
				error: data.error,
			});
		};
		const offC = pi.events.on("subagents:completed", done);
		const offF = pi.events.on("subagents:failed", done);
	});
}

export default function workerModel(pi: ExtensionAPI) {
	const retried = new Set<string>();
	pi.on("session_start", () => {
		resetProviderExhaustion();
		retried.clear();
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (event.status !== 402) return;
		const provider = ctx.model?.provider;
		if (
			provider === "opencode-go" ||
			provider === "opencode" ||
			provider === "openai-codex"
		) {
			markProviderExhausted(provider);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "Agent") return;
		const input = event.input as Record<string, unknown>;
		if (typeof input.resume === "string" && input.resume.trim()) return;
		if (typeof input.model === "string" && input.model.trim()) return;

		const picked = await pickModel(ctx, FLASH);
		if (!picked) return;
		input.model = picked;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "Agent" || !event.isError) return;
		if (retried.has(event.toolCallId)) return;

		const input = event.input as Record<string, unknown>;
		if (typeof input.resume === "string" && input.resume.trim()) return;
		if (input.run_in_background === true) return;

		const text = resultText(event);
		if (!isUsageLimitError(text)) return;

		markExhaustedFromError(text);
		const used = typeof input.model === "string" ? input.model : "";
		if (used) markProviderExhausted(providerOfSpec(used));

		if (used === LAST_RESORT) return;

		const picked = await pickModel(ctx, FLASH);
		if (!picked || picked === used) return;

		retried.add(event.toolCallId);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${used} out of usage — retrying worker on ${picked}`,
				"warning",
			);
			notified = true;
		}

		try {
			const spawned = await rpc<{ id: string }>(
				pi,
				"subagents:rpc:spawn",
				{
					type: input.subagent_type,
					prompt: input.prompt,
					options: {
						description: String(input.description ?? "worker fallback"),
						model: picked,
						isolated: true,
						isBackground: true,
						bypassQueue: true,
					},
				},
				15_000,
			);
			if (!spawned?.id) return;
			const finished = await waitAgent(pi, spawned.id, 8 * 60_000);
			const ok =
				finished.status !== "error" &&
				finished.status !== "aborted" &&
				finished.status !== "stopped";
			const body =
				(ok ? finished.result : finished.error || finished.result) ??
				"OpenCode Go fallback finished with no text.";
			return {
				content: [
					{
						type: "text" as const,
						text: ok ? `${body}\n\n(retried on ${picked} after usage limit)` : body,
					},
				],
				isError: !ok,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text" as const,
						text: `${text}\n\nFallback retry failed: ${msg}`,
					},
				],
				isError: true,
			};
		}
	});
}
