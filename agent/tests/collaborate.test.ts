import { describe, expect, test } from "bun:test";
import {
	findPathConflict,
	nextPanePlacement,
	parseAddArgs,
} from "../extensions/collaborate.ts";

function errorMessage(run: () => unknown): string {
	try {
		run();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("parseAddArgs", () => {
	test("parses worker with paths, dependsOn, and brief", () => {
		const result = parseAddArgs(
			"worker --paths=src/a.ts,src/b.ts --after=T1,T2 -- implement the exact change",
		);
		expect(result.type).toBe("worker");
		expect(result.paths).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.dependsOn).toEqual(["T1", "T2"]);
		expect(result.description).toBe("implement the exact change");
	});

	test("rejects a missing -- brief", () => {
		expect(errorMessage(() => parseAddArgs("worker --paths=src/a.ts"))).toBe(
			"Add a complete worker brief after --",
		);
	});

	test("rejects an unknown worker type", () => {
		expect(errorMessage(() => parseAddArgs("boss -- do the thing"))).toBe(
			"Unknown worker type: boss",
		);
	});
});

describe("findPathConflict", () => {
	const conflictTask = {
		id: "T1",
		type: "worker",
		description: "",
		paths: ["src/a.ts"],
		dependsOn: [],
		status: "running",
	} as never;
	const freeTask = {
		id: "T2",
		type: "worker",
		description: "",
		paths: ["src/other.ts"],
		dependsOn: [],
		status: "running",
	} as never;

	test("reports an exact-path conflict", () => {
		const conflict = findPathConflict(
			{ type: "worker", description: "", paths: ["src/a.ts"], dependsOn: [] },
			[conflictTask],
		);
		expect(conflict).toBe("src/a.ts overlaps src/a.ts, owned by T1");
	});

	test("reports directory ownership overlap", () => {
		const conflict = findPathConflict(
			{
				type: "worker",
				description: "",
				paths: ["src/nested/b.ts"],
				dependsOn: [],
			},
			[
				{
					id: "T1",
					type: "worker",
					description: "",
					paths: ["src"],
					dependsOn: [],
					status: "running",
				} as never,
			],
		);
		expect(conflict).toBe("src/nested/b.ts overlaps src, owned by T1");
	});

	test("allows distinct paths", () => {
		const conflict = findPathConflict(
			{ type: "worker", description: "", paths: ["src/new.ts"], dependsOn: [] },
			[conflictTask, freeTask],
		);
		expect(conflict).toBeUndefined();
	});
});

describe("nextPanePlacement", () => {
	test("0 peers: new tab at index 0", () => {
		expect(nextPanePlacement(0)).toEqual({ newTab: true, anchorIndex: 0 });
	});

	test("1 peer: split peer 0 down", () => {
		expect(nextPanePlacement(1)).toEqual({
			newTab: false,
			anchorIndex: 0,
			direction: "down",
		});
	});

	test("2 peers: split peer 0 right", () => {
		expect(nextPanePlacement(2)).toEqual({
			newTab: false,
			anchorIndex: 0,
			direction: "right",
		});
	});

	test("3 peers: split peer 1 right", () => {
		expect(nextPanePlacement(3)).toEqual({
			newTab: false,
			anchorIndex: 1,
			direction: "right",
		});
	});

	test("4 peers: new tab at index 4", () => {
		expect(nextPanePlacement(4)).toEqual({ newTab: true, anchorIndex: 4 });
	});
});
