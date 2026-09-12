import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import compactFooterExtension from "../extensions/compact-footer.ts";
import githubPrExtension, { createPrMonitor } from "../extensions/github-pr.ts";

const STATUS_KEY = "github-pr";
const GH_ARGS =
	"pr view --json number,url,state,isDraft,headRefName,baseRefName";

type ExecOut = {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
};
type Deferred = {
	promise: Promise<ExecOut>;
	resolve: (value: ExecOut) => void;
};

function defer(): Deferred {
	let resolve!: (value: ExecOut) => void;
	const promise = new Promise<ExecOut>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const openPr = (n = 42, over: Record<string, unknown> = {}) =>
	JSON.stringify({
		number: n,
		url: `https://github.com/octo/repo/pull/${n}`,
		state: "OPEN",
		isDraft: false,
		headRefName: "feature-x",
		baseRefName: "main",
		...over,
	});

const out = (over: Partial<ExecOut> = {}): ExecOut => ({
	code: 0,
	stdout: openPr(),
	stderr: "",
	killed: false,
	...over,
});

function makeHarness(opts: { hasUI?: boolean } = {}) {
	const statuses = new Map<string, string | undefined>();
	const durable: string[] = [];
	const ctx: Record<string, unknown> = {
		hasUI: opts.hasUI ?? true,
		cwd: "/repo",
		appendEntry: () => {
			durable.push("appendEntry");
		},
		sendMessage: () => {
			durable.push("sendMessage");
		},
	};
	if (opts.hasUI ?? true) {
		ctx.ui = {
			setStatus: (name: string, value?: string) => {
				statuses.set(name, value);
			},
		};
	}
	const gitRoot = { value: out({ stdout: "/repo\n" }) };
	const gitBranch = { value: out({ stdout: "main\n" }) };
	const mock = {
		ghResult: out(),
		ghThrow: undefined as Error | undefined,
	};
	const ghQueue: Deferred[] = [];
	const ghCalls: string[] = [];
	let lastOptions: { signal?: AbortSignal } = {};
	const exec = async (
		command: string,
		args: string[],
		options: { signal?: AbortSignal },
	): Promise<ExecOut> => {
		lastOptions = options;
		if (command === "git") {
			if (args.includes("--show-toplevel")) return gitRoot.value;
			if (args[0] === "symbolic-ref") return gitBranch.value;
			throw new Error(`unexpected git args: ${args.join(" ")}`);
		}
		if (command === "gh") {
			ghCalls.push(args.join(" "));
			const pending = ghQueue.shift();
			if (pending) return await pending.promise;
			if (mock.ghThrow) throw mock.ghThrow;
			return mock.ghResult;
		}
		throw new Error(`unexpected command: ${command}`);
	};
	const handlers = new Map<string, Function[]>();
	const pi = {
		exec,
		on(name: string, fn: Function) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
	};
	return {
		pi,
		handlers,
		ctx,
		statuses,
		durable,
		gitRoot,
		gitBranch,
		mock,
		ghQueue,
		ghCalls,
		signal: () => lastOptions.signal,
	};
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const monitors: { dispose(): void }[] = [];
const extensions: { handlers: Map<string, Function[]> }[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const key of ["GH_REPO", "PI_OFFLINE"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterAll(() => {
	for (const key of ["GH_REPO", "PI_OFFLINE"]) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

afterEach(() => {
	for (const monitor of monitors.splice(0)) monitor.dispose();
	for (const ext of extensions.splice(0)) {
		for (const fn of ext.handlers.get("session_shutdown") ?? []) fn({}, {});
	}
});

describe("createPrMonitor", () => {
	test("open PR sets footer status and full metadata", async () => {
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("open");
		expect(monitor.current().pr).toEqual({
			number: 42,
			url: "https://github.com/octo/repo/pull/42",
			isDraft: false,
			headRefName: "feature-x",
			baseRefName: "main",
		});
		expect(h.statuses.get(STATUS_KEY)).toBe("PR #42");
		expect(h.ghCalls).toEqual([GH_ARGS]);
	});

	test("draft PR gets a draft label", async () => {
		const h = makeHarness();
		h.mock.ghResult = out({ stdout: openPr(7, { isDraft: true }) });
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("open");
		expect(h.statuses.get(STATUS_KEY)).toBe("PR #7 (draft)");
	});

	test("CLOSED and MERGED states map to none and clear status", async () => {
		const h = makeHarness();
		h.mock.ghResult = out({ stdout: openPr(42, { state: "CLOSED" }) });
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("none");
		expect(monitor.current().pr).toBeUndefined();
		expect(h.statuses.get(STATUS_KEY)).toBeUndefined();
		h.mock.ghResult = out({ stdout: openPr(42, { state: "MERGED" }) });
		await monitor.refresh(true);
		expect(monitor.current().state).toBe("none");
	});

	test("no-PR stderr maps to none", async () => {
		const h = makeHarness();
		h.mock.ghResult = out({
			code: 1,
			stdout: "",
			stderr: "no pull requests found for branch feature-x",
		});
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("none");
		expect(monitor.current().pr).toBeUndefined();
	});

	test("thrown exec clears a stale PR to unavailable", async () => {
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().pr?.number).toBe(42);
		h.mock.ghThrow = new Error("spawn gh ENOENT");
		await monitor.refresh(true);
		expect(monitor.current().state).toBe("unavailable");
		expect(monitor.current().pr).toBeUndefined();
		expect(h.statuses.get(STATUS_KEY)).toBeUndefined();
	});

	test("nonzero auth failure is unavailable", async () => {
		const h = makeHarness();
		h.mock.ghResult = out({ code: 1, stdout: "", stderr: "gh: auth required" });
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("unavailable");
		expect(monitor.current().pr).toBeUndefined();
	});

	test("killed response is unavailable, not parsed", async () => {
		const h = makeHarness();
		h.mock.ghResult = out({ killed: true });
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("unavailable");
	});

	test("malformed JSON and bad PR URL are unavailable", async () => {
		const h = makeHarness();
		h.mock.ghResult = out({ stdout: "not json" });
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("unavailable");
		h.mock.ghResult = out({
			stdout: openPr(42, { url: "https://github.com/octo/repo/issues/42" }),
		});
		await monitor.refresh(true);
		expect(monitor.current().state).toBe("unavailable");
	});

	test("detached HEAD and non-repo git failures give no-branch without gh", async () => {
		const h = makeHarness();
		h.gitRoot.value = out({ code: 1, stdout: "" });
		h.gitBranch.value = out({ code: 1, stdout: "" });
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("no-branch");
		expect(h.ghCalls).toHaveLength(0);

		const h2 = makeHarness();
		h2.gitBranch.value = out({ code: 1, stdout: "" });
		const monitor2 = createPrMonitor(h2.pi as never, h2.ctx as never);
		monitors.push(monitor2);
		await monitor2.refresh();
		expect(monitor2.current().state).toBe("no-branch");
		expect(h2.ghCalls).toHaveLength(0);
	});

	test("cached refresh within 60s skips gh; fake clock past 60s refreshes", async () => {
		let time = 0;
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never, () => time);
		monitors.push(monitor);
		await monitor.refresh();
		expect(h.ghCalls).toHaveLength(1);
		time = 30_000;
		await monitor.refresh();
		expect(h.ghCalls).toHaveLength(1);
		expect(monitor.current().pr?.number).toBe(42);
		time = 61_000;
		await monitor.refresh();
		expect(h.ghCalls).toHaveLength(2);
	});

	test("force refresh bypasses TTL", async () => {
		let time = 0;
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never, () => time);
		monitors.push(monitor);
		await monitor.refresh();
		time = 30_000;
		await monitor.refresh(true);
		expect(h.ghCalls).toHaveLength(2);
	});

	test("branch change bypasses TTL and clears old status before new gh resolves", async () => {
		let time = 0;
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never, () => time);
		monitors.push(monitor);
		await monitor.refresh();
		expect(h.statuses.get(STATUS_KEY)).toBe("PR #42");
		time = 5_000;
		h.gitBranch.value = out({ stdout: "feature-2\n" });
		const pending = defer();
		h.ghQueue.push(pending);
		const done = monitor.refresh();
		await tick();
		expect(h.ghCalls).toHaveLength(2);
		expect(h.statuses.get(STATUS_KEY)).toBeUndefined();
		expect(monitor.current().state).toBe("unavailable");
		pending.resolve(out({ stdout: openPr(43) }));
		await done;
		expect(monitor.current().pr?.number).toBe(43);
		expect(h.statuses.get(STATUS_KEY)).toBe("PR #43");
	});

	test("branch changing while gh is pending never publishes the old PR and retries the new branch", async () => {
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		const first = defer();
		const second = defer();
		h.ghQueue.push(first, second);
		const done = monitor.refresh();
		await tick();
		expect(h.ghCalls).toHaveLength(1);
		h.gitBranch.value = out({ stdout: "feature-2\n" });
		first.resolve(out({ stdout: openPr(42) }));
		await tick();
		expect(monitor.current().state).toBe("unavailable");
		expect(monitor.current().pr).toBeUndefined();
		second.resolve(out({ stdout: openPr(43) }));
		await done;
		expect(h.ghCalls).toHaveLength(2);
		expect(monitor.current().pr?.number).toBe(43);
		expect(monitor.current().checkout?.branch).toBe("feature-2");
	});

	test("dispose aborts the signal and blocks late publication", async () => {
		const h = makeHarness();
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		const pending = defer();
		h.ghQueue.push(pending);
		const done = monitor.refresh();
		await tick();
		const signal = h.signal();
		monitor.dispose();
		expect(signal?.aborted).toBe(true);
		pending.resolve(out({ stdout: openPr(42) }));
		await done;
		expect(monitor.current().pr).toBeUndefined();
		expect(monitor.current().state).toBe("unavailable");
		expect(h.statuses.get(STATUS_KEY)).toBeUndefined();
	});

	test("renamed local tracking branch may differ from headRefName", async () => {
		const h = makeHarness();
		h.gitBranch.value = out({ stdout: "local-rename\n" });
		h.mock.ghResult = out({
			stdout: openPr(9, { headRefName: "original-feature" }),
		});
		const monitor = createPrMonitor(h.pi as never, h.ctx as never);
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.current().state).toBe("open");
		expect(monitor.current().pr?.number).toBe(9);
		expect(monitor.current().pr?.headRefName).toBe("original-feature");
	});
});

describe("compact footer × github-pr integration", () => {
	function makeFooter(statuses: Map<string, string>) {
		const h = makeHarness();
		let footerFactory: unknown;
		const ctx = {
			hasUI: true,
			cwd: "/Users/test/.pi",
			model: { id: "gpt-test" },
			getContextUsage: () => ({ percent: 7.3 }),
			sessionManager: { getEntries: () => [] },
			ui: {
				setFooter(factory: unknown) {
					footerFactory = factory;
				},
			},
		};
		compactFooterExtension(h.pi as never);
		h.handlers.get("session_start")![0]({}, ctx);
		const footerData = {
			onBranchChange(_cb: () => void) {
				return () => {};
			},
			getGitBranch: () => "feature",
			getExtensionStatuses: () => statuses,
		};
		const footer = (footerFactory as Function)(
			undefined,
			plainTheme,
			footerData,
		) as { dispose: () => void; render: (width: number) => string[] };
		return { footer };
	}

	test("PR status renders exactly once, right after branch and before context/model", () => {
		const { footer } = makeFooter(
			new Map([
				["github-pr", "PR #42"],
				["fast-mode", "fast"],
			]),
		);
		const line = footer.render(200)[0];
		expect(line).toBe(
			".pi (feature) · PR #42 · ctx 7.3% · cache — · gpt-test",
		);
		expect(line.split("PR #42").length - 1).toBe(1);
		footer.dispose();
	});

	test("missing PR status leaves the footer layout without a PR segment", () => {
		const { footer } = makeFooter(new Map([["fast-mode", "fast"]]));
		const line = footer.render(200)[0];
		expect(line).toBe(".pi (feature) · ctx 7.3% · cache — · gpt-test");
		expect(line.includes("PR #")).toBe(false);
		footer.dispose();
	});
});

describe("github-pr extension hooks", () => {
	test("context hook appends exactly one hidden metadata message, preserves originals, no durable writes", async () => {
		const h = makeHarness();
		githubPrExtension(h.pi as never);
		extensions.push(h);
		const handler = h.handlers.get("context")![0];
		const original = [
			{ role: "user", content: "hello" },
			{ role: "custom", customType: "github-pr-context", content: "stale" },
		];
		const result = (await handler({ messages: original }, h.ctx)) as {
			messages: Record<string, unknown>[];
		};
		const injected = result.messages.filter(
			(m) => m.customType === "github-pr-context",
		);
		expect(injected).toHaveLength(1);
		expect(injected[0].role).toBe("custom");
		expect(injected[0].display).toBe(false);
		expect(String(injected[0].content)).toContain('"number":42');
		expect(String(injected[0].content)).toContain("untrusted");
		expect(result.messages).toContain(original[0]);
		expect(h.durable).toEqual([]);
	});

	test("context hook works with hasUI=false and never touches status", async () => {
		const h = makeHarness({ hasUI: false });
		githubPrExtension(h.pi as never);
		extensions.push(h);
		const result = (await h.handlers.get("context")![0](
			{ messages: [] },
			h.ctx,
		)) as { messages: Record<string, unknown>[] };
		expect(
			result.messages.filter((m) => m.customType === "github-pr-context"),
		).toHaveLength(1);
		expect(h.durable).toEqual([]);
	});

	test("before_agent_start forces a refresh even within the TTL", async () => {
		const h = makeHarness();
		githubPrExtension(h.pi as never);
		extensions.push(h);
		await h.handlers.get("session_start")![0]({}, h.ctx);
		// session_start refreshes fire-and-forget; wait for the gh call to land.
		for (let i = 0; i < 50 && h.ghCalls.length === 0; i++) await tick();
		expect(h.ghCalls).toHaveLength(1);
		await h.handlers.get("before_agent_start")![0]({}, h.ctx);
		expect(h.ghCalls).toHaveLength(2);
	});
});
