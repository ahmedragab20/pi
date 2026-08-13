/**
 * Git stash create per turn; offer restore on /fork.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Checkpoint = { entryId: string; sha: string };

function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
	return pi
		.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 3000 })
		.then((r) => r.code === 0 && r.stdout.trim() === "true")
		.catch(() => false);
}

export function registerGitCheckpoints(pi: ExtensionAPI): void {
	const checkpoints = new Map<string, string>();

	const loadFromSession = (ctx: { sessionManager: { getBranch: () => any[] } }) => {
		checkpoints.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "git-checkpoint") continue;
			const data = entry.data as Checkpoint | undefined;
			if (data?.entryId && data?.sha) checkpoints.set(data.entryId, data.sha);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		loadFromSession(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!(await isGitRepo(pi))) return;
		const entryId = ctx.sessionManager.getLeafId();
		if (!entryId) return;
		try {
			const { stdout, code } = await pi.exec("git", ["stash", "create"], {
				timeout: 8000,
			});
			const sha = stdout.trim();
			if (code !== 0 || !sha) return;
			checkpoints.set(entryId, sha);
			pi.appendEntry("git-checkpoint", { entryId, sha } satisfies Checkpoint);
		} catch {
			// not a git repo / empty stash
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const sha = checkpoints.get(event.entryId);
		if (!sha || !ctx.hasUI) return;
		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);
		if (!choice?.startsWith("Yes")) return;
		const result = await pi.exec("git", ["stash", "apply", sha], { timeout: 8000 });
		if (result.code === 0) {
			ctx.ui.notify("Code restored to checkpoint", "info");
		} else {
			ctx.ui.notify(
				`Restore failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
				"error",
			);
		}
	});
}
