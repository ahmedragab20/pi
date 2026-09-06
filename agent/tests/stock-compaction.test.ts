import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const efficiencyDir = join(agentDir, "extensions", "efficiency");
const indexPath = join(efficiencyDir, "index.ts");

function tsFilesRecursively(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...tsFilesRecursively(path));
		} else if (entry.isFile() && extname(entry.name) === ".ts") {
			files.push(path);
		}
	}
	return files;
}

describe("stock compaction ownership", () => {
	test("efficiency does not override pi stock compaction", () => {
		for (const file of tsFilesRecursively(efficiencyDir)) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toContain("session_before_compact");
		}

		const index = readFileSync(indexPath, "utf8");
		expect(index).not.toContain("registerCheapCompact");
		expect(index).not.toContain("cheap-compact.ts");
	});
});
