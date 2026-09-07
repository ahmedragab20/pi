/**
 * Token efficiency + modern harness controls.
 *
 * /microcompact  /tools  /memory
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoCompress } from "./auto-compress.ts";
import { registerCompactionCoordinator } from "./compaction-coordinator.ts";
import { registerDeferredTools } from "./deferred-tools.ts";
import { pruneOldDumps } from "./dumps.ts";
import { registerMicrocompact } from "./microcompact.ts";
import { registerProjectMemory } from "./project-memory.ts";

export default function efficiency(pi: ExtensionAPI) {
	registerCompactionCoordinator(pi);
	registerAutoCompress(pi);
	registerMicrocompact(pi);
	registerDeferredTools(pi);
	registerProjectMemory(pi);

	pi.on("session_start", () => {
		pruneOldDumps();
	});
}
