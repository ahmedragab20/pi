import { readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve existing ancestors too, so policy covers writes to new children.
 * This is a preflight check, not protection against filesystem TOCTOU races. */
export function canonicalPath(raw: string, cwd: string, links = 0): string {
	if (links > 40) throw new Error("Too many symbolic links in tool path");
	if (raw.startsWith("@")) raw = raw.slice(1);
	const expanded =
		raw === "~"
			? homedir()
			: raw.startsWith("~/")
				? join(homedir(), raw.slice(2))
				: raw;
	let current = resolve(cwd, expanded);
	const missing: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(current), ...missing);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}
		// realpath fails on dangling symlinks; their destination still matters
		// when write/create will follow the link.
		try {
			const target = readlinkSync(current);
			return canonicalPath(
				resolve(dirname(current), target, ...missing),
				cwd,
				links + 1,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EINVAL" && code !== "ENOENT" && code !== "ENOTDIR")
				throw error;
		}
		const parent = dirname(current);
		if (parent === current) throw new Error("Cannot resolve tool path");
		missing.unshift(basename(current));
		current = parent;
	}
}
