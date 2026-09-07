import { getAgentDir } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { parseFrontmatter } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js";
import { SettingsManager } from "../npm/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import { plugin } from "bun";

plugin({
	name: "pi-thinking-stubs",
	setup(build) {
		build.module("@earendil-works/pi-coding-agent", () => ({
			exports: {
				getAgentDir,
				parseFrontmatter,
				SettingsManager,
				createCodingTools: () => [],
				createReadOnlyTools: () => [],
			},
			loader: "object",
		}));
	},
});
