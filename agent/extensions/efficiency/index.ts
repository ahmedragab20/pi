/**
 * Token efficiency + modern harness controls.
 *
 * /microcompact  /tools  /memory  /thinking-router
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoCompress } from "./auto-compress.ts";
import { registerCheapCompact } from "./cheap-compact.ts";
import { registerDeferredTools } from "./deferred-tools.ts";
import { pruneOldDumps } from "./dumps.ts";
import { registerGitCheckpoints } from "./git-checkpoints.ts";
import { registerMicrocompact } from "./microcompact.ts";
import { registerProjectMemory } from "./project-memory.ts";
import { registerThinkingRouter } from "./thinking-router.ts";

export default function efficiency(pi: ExtensionAPI) {
	registerAutoCompress(pi);
	registerMicrocompact(pi);
	registerCheapCompact(pi);
	registerDeferredTools(pi);
	registerProjectMemory(pi);
	registerGitCheckpoints(pi);
	registerThinkingRouter(pi);

	pi.on("session_start", () => {
		pruneOldDumps();
	});
}
