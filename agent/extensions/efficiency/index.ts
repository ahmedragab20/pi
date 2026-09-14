/** Keep specialist tools discoverable; native pi owns output limits and compaction. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDeferredTools } from "./deferred-tools.ts";

export default function efficiency(pi: ExtensionAPI) {
	registerDeferredTools(pi);
}
