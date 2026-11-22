import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { registerAccountingTools } from "../src/accounting-tools.ts";
import type { WaitOptions, WaitResult } from "../src/lifecycle.ts";
import { readRecord, runDirFor, updateRecord, writeRecord, type RunRecord } from "../src/record.ts";
import { tempEnv } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = {
	content: { type: "text"; text: string }[];
	details: any;
	usage?: Usage;
	isError?: boolean;
};
type FakeTool = { execute: (id: string, params: any, signal: undefined, update: undefined, ctx: unknown) => Promise<ToolResult> };

function harness(
	env: NodeJS.ProcessEnv,
	spawn?: (options: any) => Promise<any>,
	branch: unknown[] = [],
	wait?: (handles: string[], options: WaitOptions) => Promise<WaitResult[]>,
	lifecycle: {
		stop?: (handle: string, options: any) => Promise<any>;
		describe?: (handle: string) => Promise<any>;
		remove?: (handle: string) => void;
	} = {},
	parentSessionId = "parent-1",
) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, FakeTool>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerTool(tool: FakeTool & { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerAccountingTools(pi, { env, spawn, wait, stop: lifecycle.stop, describe: lifecycle.describe, remove: lifecycle.remove });
	const context = {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionId: () => parentSessionId,
			getBranch: () => branch,
		},
	};
	return {
		tools,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		execute(name: string, params: unknown): Promise<ToolResult> {
			const tool = tools.get(name);
			assert.ok(tool, `missing tool ${name}`);
			return tool.execute("call-1", params, undefined, undefined, context);
		},
	};
}

function record(handle: string, parentSessionId = "parent-1"): RunRecord {
	return {
		version: 1,
		handle,
		name: handle,
		group: "subagents",
		cwd: "/tmp/project",
		prompt: "work",
		launchArgs: [],
		parentSessionId,
		rex: {
			endpoint: "unix:///tmp/rex.sock",
			hostId: "host-1",
			sessionId: `session:${handle}`,
			windowId: `window:${handle}`,
			blockId: `block:${handle}`,
		},
		state: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function writeSnapshot(handle: string, env: NodeJS.ProcessEnv, sequence: number, usage: Usage, overrides: Record<string, unknown> = {}): void {
	const dir = runDirFor(handle, env);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "usage.json"),
		`${JSON.stringify({
			version: 1,
			source: "pi-rex-subagent",
			runHandle: handle,
			parentSessionId: "parent-1",
			childSessionId: handle,
			childSessionGeneration: `generation-${handle}`,
			sequence,
			usage,
			final: false,
			updatedAt: "2026-01-01T00:00:00.000Z",
			...overrides,
		})}\n`,
	);
}

const firstUsage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	cacheWrite1h: 1,
	reasoning: 3,
	totalTokens: 18,
	cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.1, total: 3.3, totalFromProvider: true },
};

const secondUsage: Usage = {
	input: 14,
	output: 9,
	cacheRead: 5,
	cacheWrite: 1,
	cacheWrite1h: 1,
	reasoning: 5,
	totalTokens: 29,
	cost: { input: 1.4, output: 3.6, cacheRead: 0.5, cacheWrite: 0.1, total: 5.6, totalFromProvider: true },
};

const thirdUsage: Usage = {
	input: 20,
	output: 12,
	cacheRead: 6,
	cacheWrite: 2,
	cacheWrite1h: 2,
	reasoning: 6,
	totalTokens: 40,
	cost: { input: 2, output: 4, cacheRead: 0.6, cacheWrite: 0.2, total: 8, totalFromProvider: true },
};

function persistToolResult(branch: unknown[], toolName: string, result: ToolResult): void {
	branch.push({
		type: "message",
		id: `entry-${branch.length + 1}`,
		parentId: branch.length === 0 ? null : `entry-${branch.length}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "toolResult", toolName, details: result.details, isError: result.isError === true },
	});
}

async function spawnForTest(parent: ReturnType<typeof harness>, handle: string): Promise<void> {
	const result = await parent.execute("rex_spawn", { prompt: "do work", name: handle });
	assert.equal(result.isError, undefined, result.content[0]?.text);
}

function independentAdoption(env: NodeJS.ProcessEnv, handle: string, parentSessionId: string, barrierDir: string) {
	const fixture = fileURLToPath(new URL("./fixtures/accounting-parent.mjs", import.meta.url));
	const child = spawn(process.execPath, [fixture, handle, parentSessionId, barrierDir], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const result = new Promise<ToolResult>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) return reject(new Error(`adoption helper exited ${code}: ${stderr}`));
			try {
				resolve(JSON.parse(stdout) as ToolResult);
			} catch (error) {
				reject(new Error(`invalid adoption helper output: ${stdout}\n${stderr}`, { cause: error }));
			}
		});
	});
	return { child, ready: join(barrierDir, `${parentSessionId}.ready`), result };
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("parallel children and repeated handles produce one combined delta", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
		const created = record(options.name);
		writeRecord(created, fixture.env);
		return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
	});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, secondUsage);
		const result = await parent.execute("rex_observe", { handles: ["child-a", "child-a", "child-b", "child-b"] });
		assert.equal(result.isError, undefined);
		assert.equal(result.details.runs.length, 2);
		assert.deepEqual(result.usage, {
			input: 24,
			output: 14,
			cacheRead: 7,
			cacheWrite: 2,
			cacheWrite1h: 2,
			reasoning: 8,
			totalTokens: 47,
			cost: { input: 2.4, output: 5.6, cacheRead: 0.7, cacheWrite: 0.2, total: 8.899999999999999, totalFromProvider: true },
		});
		const repeated = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(repeated.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("concurrent observations of one child charge a snapshot once", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const results = await Promise.all([
			parent.execute("rex_observe", { handles: ["child1"] }),
			parent.execute("rex_observe", { handles: ["child1"] }),
		]);
		assert.equal(results.filter((result) => result.usage !== undefined).length, 1);
		assert.deepEqual(results.find((result) => result.usage)?.usage, firstUsage);
		assert.equal(results.every((result) => result.details.runs[0].sequence === 1), true);
	} finally {
		fixture.cleanup();
	}
});

test("overlapping multi-run observations cannot double charge or deadlock", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, secondUsage);
		const results = await Promise.all([
			parent.execute("rex_observe", { handles: ["child-a", "child-b"] }),
			parent.execute("rex_observe", { handles: ["child-b", "child-a"] }),
		]);
		assert.equal(results.filter((result) => result.usage !== undefined).length, 1);
		assert.deepEqual(results.find((result) => result.usage)?.usage, {
			input: 24,
			output: 14,
			cacheRead: 7,
			cacheWrite: 2,
			cacheWrite1h: 2,
			reasoning: 8,
			totalTokens: 47,
			cost: { input: 2.4, output: 5.6, cacheRead: 0.7, cacheWrite: 0.2, total: 8.899999999999999, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("a failed multi-run observation advances no cursor and can be retried", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeFileSync(join(runDirFor("child-b", fixture.env), "usage.json"), "not-json\n");
		const failed = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(failed.isError, true);
		assert.equal(failed.usage, undefined);
		assert.deepEqual(failed.details.runs, []);

		writeSnapshot("child-a", fixture.env, 2, secondUsage);
		writeSnapshot("child-b", fixture.env, 1, firstUsage);
		const retried = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, {
			input: 24,
			output: 14,
			cacheRead: 7,
			cacheWrite: 2,
			cacheWrite1h: 2,
			reasoning: 8,
			totalTokens: 47,
			cost: { input: 2.4, output: 5.6, cacheRead: 0.7, cacheWrite: 0.2, total: 8.899999999999999, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("restart and selected-branch replay restore only durable branch cursors", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const first = await parent.execute("rex_observe", { handles: ["child1"] });
		persistToolResult(branch, "rex_observe", first);

		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		writeSnapshot("child1", fixture.env, 2, secondUsage);
		const afterRestart = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(afterRestart.isError, undefined, afterRestart.content[0]?.text);
		assert.deepEqual(afterRestart.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});

		const spawnOnlyBranch = branch.filter((entry: any) => entry.message.details.kind === "spawn");
		const navigated = harness(fixture.env, undefined, spawnOnlyBranch);
		await navigated.start();
		const fromSpawnBaseline = await navigated.execute("rex_observe", { handles: ["child1"] });
		assert.equal(fromSpawnBaseline.isError, undefined, fromSpawnBaseline.content[0]?.text);
		assert.deepEqual(fromSpawnBaseline.usage, secondUsage);
	} finally {
		fixture.cleanup();
	}
});

test("a malformed tool-result details fails closed for its run only", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const spawn = async (options: any) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		};
		const parent = harness(fixture.env, spawn, branch);
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, firstUsage);
		const observed = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(observed.isError, undefined, observed.content[0]?.text);
		persistToolResult(branch, "rex_observe", observed);
		// One persisted observation is corrupted after the fact: only child-b's
		// cursor inside it becomes unusable.
		const corrupt = {
			...observed.details,
			runs: observed.details.runs.map((run: any) => (run.handle === "child-b" ? { ...run, sequence: -3 } : run)),
		};
		persistToolResult(branch, "rex_observe", { content: [], details: corrupt });

		const restarted = harness(
			fixture.env,
			spawn,
			branch,
			async (handles): Promise<WaitResult[]> =>
				handles.map((handle) => ({ handle, outcome: "idle", state: "idle", agentState: "idle", turn: 1, processExitCode: 0 })),
		);
		await restarted.start();
		writeSnapshot("child-a", fixture.env, 2, secondUsage);
		writeSnapshot("child-b", fixture.env, 2, secondUsage);

		// The corrupted run fails closed, naming the entry and tool it came from.
		const poisoned = await restarted.execute("rex_observe", { handles: ["child-b"] });
		assert.equal(poisoned.isError, true);
		assert.equal(poisoned.usage, undefined);
		assert.deepEqual(poisoned.details.runs, []);
		assert.match(poisoned.content[0].text, /child-b/);
		assert.match(poisoned.content[0].text, /entry-\d+ \(rex_observe\)/);

		// A healthy sibling still observes, and a mixed call still fails closed
		// without advancing any cursor.
		const healthy = await restarted.execute("rex_observe", { handles: ["child-a"] });
		assert.equal(healthy.isError, undefined, healthy.content[0]?.text);
		assert.deepEqual(healthy.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		const mixed = await restarted.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(mixed.isError, true);
		assert.equal(mixed.usage, undefined);
		assert.deepEqual(mixed.details.runs, []);

		// Unrelated spawn, wait, adopt and stop operations keep working.
		const spawned = await restarted.execute("rex_spawn", { prompt: "more work", name: "child-c" });
		assert.equal(spawned.isError, undefined, spawned.content[0]?.text);
		const waited = await restarted.execute("rex_wait", { handles: ["child-a"], timeoutMs: 10 });
		assert.equal(waited.isError, undefined, waited.content[0]?.text);
		assert.equal(waited.usage, undefined, "the healthy run was already observed at sequence 2");
		const unowned = record("cli-run");
		unowned.parentSessionId = undefined;
		writeRecord(unowned, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const adopted = await restarted.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		assert.equal(adopted.details.runs[0].sequence, 5);
		// The corrupted run itself stays fail closed, including for stop.
		const stopPoisoned = await restarted.execute("rex_stop", { handle: "child-b" });
		assert.equal(stopPoisoned.isError, true);
		assert.match(stopPoisoned.content[0].text, /entry-\d+ \(rex_observe\)/);
		// Re-adoption of the corrupted run is refused rather than trusted.
		const readoptPoisoned = await restarted.execute("rex_adopt", { handle: "child-b" });
		assert.equal(readoptPoisoned.isError, true);
		assert.match(readoptPoisoned.content[0].text, /re-adoption is refused/);
	} finally {
		fixture.cleanup();
	}
});

test("an unattributable malformed accounting result fails the whole session closed", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const first = await parent.execute("rex_observe", { handles: ["child1"] });
		persistToolResult(branch, "rex_observe", first);
		branch.push({
			type: "message",
			id: "corrupt-entry",
			parentId: "entry-2",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "rex_observe",
				details: { version: 1, kind: "observation", parentSessionId: "parent-1", runs: "garbage" },
				isError: false,
			},
		});
		writeSnapshot("child1", fixture.env, 2, secondUsage);
		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		const observed = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observed.isError, true);
		assert.equal(observed.usage, undefined);
		assert.match(observed.content[0].text, /corrupt-entry/);
		assert.match(observed.content[0].text, /cannot be attributed|unattributable|cannot restore/);
	} finally {
		fixture.cleanup();
	}
});

test("a non-object accounting payload is unattributable corruption, not an unrelated parent result", async () => {
	const fixture = tempEnv();
	try {
		const branch = [
			{
				type: "message",
				id: "corrupt-non-object",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "toolResult", toolName: "rex_observe", details: "garbage", isError: false },
			},
		];
		const parent = harness(fixture.env, undefined, branch);
		await parent.start();
		const observed = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observed.isError, true);
		assert.equal(observed.usage, undefined);
		assert.match(observed.content[0].text, /corrupt-non-object/);
		assert.match(observed.content[0].text, /cannot restore Rex accounting cursors/);
	} finally {
		fixture.cleanup();
	}
});

test("a valid later tool result recovers a run whose earlier cursor was malformed", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async (options) => {
				const created = record(options.name);
				writeRecord(created, fixture.env);
				return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work", name: "child1" });
		persistToolResult(branch, "rex_spawn", spawned);
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const first = await parent.execute("rex_observe", { handles: ["child1"] });
		persistToolResult(branch, "rex_observe", first);
		// A corrupt result sits between two valid ones for the same run.
		persistToolResult(branch, "rex_observe", {
			content: [],
			details: { ...first.details, runs: [{ ...first.details.runs[0], sequence: -3 }] },
		});
		writeSnapshot("child1", fixture.env, 2, secondUsage);
		const second = await parent.execute("rex_observe", { handles: ["child1"] });
		persistToolResult(branch, "rex_observe", second);

		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		// The later valid result wins: the run is usable again from its cursor.
		const recovered = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
		assert.equal(recovered.usage, undefined, "the sequence-2 cursor was restored, not the spawn baseline");
		assert.equal(recovered.details.runs[0].sequence, 2);
		writeSnapshot("child1", fixture.env, 3, thirdUsage);
		const charged = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(charged.isError, undefined, charged.content[0]?.text);
		assert.deepEqual(charged.usage, {
			input: 6,
			output: 3,
			cacheRead: 1,
			cacheWrite: 1,
			cacheWrite1h: 1,
			reasoning: 1,
			totalTokens: 11,
			cost: { input: 0.6000000000000001, output: 0.3999999999999999, cacheRead: 0.09999999999999998, cacheWrite: 0.1, total: 2.4000000000000004, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("adoption claims an unowned run at its current snapshot and excludes history", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const parent = harness(fixture.env);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		assert.equal(adopted.usage, undefined);
		assert.equal(adopted.details.kind, "adoption");
		assert.equal(adopted.details.runs[0].sequence, 5);
		assert.deepEqual(adopted.details.runs[0].cumulative, firstUsage);
		assert.equal(readRecord("cli-run", fixture.env)?.parentSessionId, "parent-1");
		const unchanged = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(unchanged.isError, undefined, unchanged.content[0]?.text);
		assert.equal(unchanged.usage, undefined);

		writeSnapshot("cli-run", fixture.env, 6, secondUsage);
		const observed = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.deepEqual(observed.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		const repeated = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(repeated.isError, true);
		assert.equal(repeated.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("an owned observation cursor rejects an identical snapshot whose owner becomes null", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const observed = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observed.isError, undefined, observed.content[0]?.text);
		assert.equal(observed.details.runs[0].unownedAdoption, undefined);

		writeSnapshot("child1", fixture.env, 1, firstUsage, { parentSessionId: null });
		const rejected = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);
	} finally {
		fixture.cleanup();
	}
});

test("an unowned adoption baseline retains only its null-owner exception across replay", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const branch: unknown[] = [];
		const parent = harness(fixture.env, undefined, branch);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		assert.equal(adopted.details.runs[0].unownedAdoption, true);
		persistToolResult(branch, "rex_adopt", adopted);

		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		const unchanged = await restarted.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(unchanged.isError, undefined, unchanged.content[0]?.text);
		assert.equal(unchanged.usage, undefined);
		assert.equal(unchanged.details.runs[0].unownedAdoption, true);
		persistToolResult(branch, "rex_observe", unchanged);

		const selectedBranch = branch.filter((entry) => {
			const message = (entry as { message: { toolName?: string } }).message;
			return message.toolName === "rex_adopt" || message.toolName === "rex_observe";
		});
		const replayed = harness(fixture.env, undefined, selectedBranch);
		await replayed.start();
		const afterReplay = await replayed.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(afterReplay.isError, undefined, afterReplay.content[0]?.text);
		assert.equal(afterReplay.usage, undefined);
		assert.equal(afterReplay.details.runs[0].unownedAdoption, true);

		// A branch without the interrupted adoption's persisted result may retry
		// under the same owner and establish a newer unowned-snapshot baseline.
		writeSnapshot("cli-run", fixture.env, 6, secondUsage, { parentSessionId: null });
		const retryBranch: unknown[] = [];
		const retry = harness(fixture.env, undefined, retryBranch);
		await retry.start();
		const retried = await retry.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.equal(retried.usage, undefined);
		assert.equal(retried.details.runs[0].sequence, 6);
		assert.equal(retried.details.runs[0].unownedAdoption, true);
	} finally {
		fixture.cleanup();
	}
});

test("pre-claim null-owner snapshots are charged exactly once until an owned snapshot advances", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const parent = harness(fixture.env);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);

		// A busy unowned child publishes a newer null-owner snapshot that raced
		// the ownership claim. The immediate observation must not fail owner
		// validation: this is a legitimate pre-claim publication.
		writeSnapshot("cli-run", fixture.env, 6, secondUsage, { parentSessionId: null });
		const immediate = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(immediate.isError, undefined, immediate.content[0]?.text);
		assert.deepEqual(immediate.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		assert.equal(immediate.details.runs[0].sequence, 6);
		assert.equal(immediate.details.runs[0].unownedAdoption, true, "no owned snapshot has been observed yet");
		const repeated = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(repeated.isError, undefined, repeated.content[0]?.text);
		assert.equal(repeated.usage, undefined);

		// A second pre-claim publication is still legitimate and charged once.
		const third: Usage = {
			input: 20,
			output: 12,
			cacheRead: 6,
			cacheWrite: 1,
			cacheWrite1h: 1,
			reasoning: 6,
			totalTokens: 41,
			cost: { input: 2, output: 5, cacheRead: 0.6, cacheWrite: 0.1, total: 7.7, totalFromProvider: true },
		};
		writeSnapshot("cli-run", fixture.env, 7, third, { parentSessionId: null });
		const second = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(second.isError, undefined, second.content[0]?.text);
		assert.deepEqual(second.usage, {
			input: 6,
			output: 3,
			cacheRead: 1,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 1,
			totalTokens: 12,
			cost: { input: 0.6000000000000001, output: 1.4, cacheRead: 0.09999999999999998, cacheWrite: 0, total: 2.1000000000000005, totalFromProvider: true },
		});
		assert.equal(second.details.runs[0].unownedAdoption, true);

		// Once the child has seen the claim, snapshots carry the owner and the
		// unowned-adoption marker is dropped for good.
		const fourth: Usage = {
			input: 25,
			output: 14,
			cacheRead: 8,
			cacheWrite: 2,
			cacheWrite1h: 1,
			reasoning: 8,
			totalTokens: 50,
			cost: { input: 2.5, output: 6, cacheRead: 0.8, cacheWrite: 0.2, total: 9.5, totalFromProvider: true },
		};
		writeSnapshot("cli-run", fixture.env, 8, fourth, { parentSessionId: "parent-1" });
		const owned = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(owned.isError, undefined, owned.content[0]?.text);
		assert.deepEqual(owned.usage, {
			input: 5,
			output: 2,
			cacheRead: 2,
			cacheWrite: 1,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 9,
			cost: { input: 0.5, output: 1, cacheRead: 0.20000000000000007, cacheWrite: 0.1, total: 1.7999999999999998, totalFromProvider: true },
		});
		assert.equal(owned.details.runs[0].unownedAdoption, undefined);

		// A null-owner snapshot after an owned cursor is never accepted.
		writeSnapshot("cli-run", fixture.env, 9, fourth, { parentSessionId: null });
		const rejected = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);
	} finally {
		fixture.cleanup();
	}
});

test("pre-claim null-owner acceptance survives restart and branch replay", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const branch: unknown[] = [];
		const parent = harness(fixture.env, undefined, branch);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		persistToolResult(branch, "rex_adopt", adopted);
		writeSnapshot("cli-run", fixture.env, 6, secondUsage, { parentSessionId: null });
		const observed = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(observed.isError, undefined, observed.content[0]?.text);
		assert.deepEqual(observed.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		persistToolResult(branch, "rex_observe", observed);

		const third: Usage = {
			input: 20,
			output: 12,
			cacheRead: 6,
			cacheWrite: 1,
			cacheWrite1h: 1,
			reasoning: 6,
			totalTokens: 41,
			cost: { input: 2, output: 5, cacheRead: 0.6, cacheWrite: 0.1, total: 7.7, totalFromProvider: true },
		};
		writeSnapshot("cli-run", fixture.env, 7, third, { parentSessionId: null });
		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		const afterRestart = await restarted.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(afterRestart.isError, undefined, afterRestart.content[0]?.text);
		assert.deepEqual(afterRestart.usage, {
			input: 6,
			output: 3,
			cacheRead: 1,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 1,
			totalTokens: 12,
			cost: { input: 0.6000000000000001, output: 1.4, cacheRead: 0.09999999999999998, cacheWrite: 0, total: 2.1000000000000005, totalFromProvider: true },
		});
		assert.equal(afterRestart.details.runs[0].unownedAdoption, true);
	} finally {
		fixture.cleanup();
	}
});

test("ownership claim filesystem failures surface as clear run-level errors", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const claimPath = join(runDirFor("cli-run", fixture.env), ".accounting-owner.json");
		const parent = harness(fixture.env);
		await parent.start();

		mkdirSync(claimPath, { recursive: true });
		const replaced = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(replaced.isError, true);
		assert.match(replaced.content[0].text, /run cli-run accounting ownership/);
		assert.equal(replaced.usage, undefined);
		assert.deepEqual(replaced.details.runs, []);
		assert.equal(readRecord("cli-run", fixture.env)?.parentSessionId, undefined);

		rmdirSync(claimPath);
		chmodSync(runDirFor("cli-run", fixture.env), 0o555);
		try {
			const unwritable = await parent.execute("rex_adopt", { handle: "cli-run" });
			assert.equal(unwritable.isError, true);
			assert.match(unwritable.content[0].text, /run cli-run accounting ownership could not be claimed/);
			assert.equal(unwritable.usage, undefined);
			assert.deepEqual(unwritable.details.runs, []);
			assert.equal(readRecord("cli-run", fixture.env)?.parentSessionId, undefined);
		} finally {
			chmodSync(runDirFor("cli-run", fixture.env), 0o755);
		}
	} finally {
		fixture.cleanup();
	}
});

test("a durable ownership claim permits same-owner retry and rejects another parent", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const claimPath = join(runDirFor("cli-run", fixture.env), ".accounting-owner.json");
		writeFileSync(claimPath, `${JSON.stringify({ version: 1, parentSessionId: "parent-1" })}\n`);
		const firstParent = harness(fixture.env);
		await firstParent.start();
		const retry = await firstParent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(retry.isError, undefined, retry.content[0]?.text);
		assert.equal(retry.details.runs[0].unownedAdoption, true);

		const secondParent = harness(fixture.env, undefined, [], undefined, {}, "parent-2");
		await secondParent.start();
		const rejected = await secondParent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);
		assert.equal(readRecord("cli-run", fixture.env)?.parentSessionId, "parent-1");
		assert.deepEqual(JSON.parse(readFileSync(claimPath, "utf8")), { version: 1, parentSessionId: "parent-1" });
	} finally {
		fixture.cleanup();
	}
});

test("a malformed ownership claim fails closed without being removed", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const claimPath = join(runDirFor("cli-run", fixture.env), ".accounting-owner.json");
		writeFileSync(claimPath, "not-json\n");
		const parent = harness(fixture.env);
		await parent.start();
		const rejected = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0].text, /run cli-run accounting ownership/);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);
		assert.equal(existsSync(claimPath), true, "an ambiguous claim is never removed automatically");
		assert.equal(readRecord("cli-run", fixture.env)?.parentSessionId, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("independent parent processes cannot both adopt and charge one unowned run", async () => {
	const fixture = tempEnv();
	const children: ReturnType<typeof spawn>[] = [];
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		// Keep both processes in the adoption read path long enough to expose a
		// parent-local-only transaction queue without coordinating implementation
		// internals in either helper process.
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, {
			parentSessionId: null,
			padding: "x".repeat(8 * 1024 * 1024),
		});
		const barrierDir = join(fixture.dir, "adoption-barrier");
		mkdirSync(barrierDir, { recursive: true });
		const firstParent = independentAdoption(fixture.env, "cli-run", "parent-1", barrierDir);
		const secondParent = independentAdoption(fixture.env, "cli-run", "parent-2", barrierDir);
		children.push(firstParent.child, secondParent.child);
		await Promise.all([waitForFile(firstParent.ready), waitForFile(secondParent.ready)]);
		writeFileSync(join(barrierDir, "adopt.go"), "go\n");
		const adoptions = await Promise.all([firstParent.result, secondParent.result]);
		const successes = adoptions.filter((result) => !result.isError);
		assert.equal(successes.length, 1, adoptions.map((result) => result.content[0]?.text).join("\n"));
		const winner = successes[0]!;
		const loser = adoptions.find((result) => result.isError)!;
		assert.equal(loser.usage, undefined);
		assert.deepEqual(loser.details.runs, []);
		const winnerSessionId = winner.details.parentSessionId as string;
		const loserSessionId = adoptions.find((result) => result !== winner)!.details.parentSessionId as string;
		assert.equal(readRecord("cli-run", fixture.env)?.parentSessionId, winnerSessionId);

		writeSnapshot("cli-run", fixture.env, 6, secondUsage, { parentSessionId: winnerSessionId });
		const winnerBranch: unknown[] = [];
		persistToolResult(winnerBranch, "rex_adopt", winner);
		const winningObserver = harness(fixture.env, undefined, winnerBranch, undefined, {}, winnerSessionId);
		await winningObserver.start();
		const charged = await winningObserver.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(charged.isError, undefined, charged.content[0]?.text);
		assert.deepEqual(charged.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		const losingObserver = harness(fixture.env, undefined, [], undefined, {}, loserSessionId);
		await losingObserver.start();
		const rejected = await losingObserver.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
	} finally {
		for (const child of children) child.kill();
		fixture.cleanup();
	}
});

test("a same-parent CLI-created run uses an explicit adoption baseline", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("cli-run"), fixture.env);
		writeSnapshot("cli-run", fixture.env, 3, firstUsage);
		const parent = harness(fixture.env);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		assert.equal(adopted.usage, undefined);
		writeSnapshot("cli-run", fixture.env, 4, secondUsage);
		const observed = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.deepEqual(observed.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("adoption rejects other-parent runs and unknown existing snapshots", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("other-run", "parent-2"), fixture.env);
		writeSnapshot("other-run", fixture.env, 1, firstUsage, { parentSessionId: "parent-2" });
		writeRecord({ ...record("empty-run"), state: "exited" }, fixture.env);
		const parent = harness(fixture.env);
		await parent.start();
		const other = await parent.execute("rex_adopt", { handle: "other-run" });
		assert.equal(other.isError, true);
		assert.match(other.content[0].text, /different parent/);
		const missing = await parent.execute("rex_adopt", { handle: "empty-run" });
		assert.equal(missing.isError, true);
		assert.equal(missing.usage, undefined);
		const observed = await parent.execute("rex_observe", { handles: ["other-run"] });
		assert.equal(observed.isError, true);
	} finally {
		fixture.cleanup();
	}
});

test("wait returns lifecycle outcomes and observes usage even on timeout", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			async (handles): Promise<WaitResult[]> =>
				handles.map((handle) => ({ handle, outcome: "timeout", state: "busy", turn: 1, processExitCode: null })),
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const result = await parent.execute("rex_wait", { handles: ["child1"], timeoutMs: 10 });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0].text, /timeout/);
		assert.deepEqual(result.usage, firstUsage);
		assert.equal(result.details.kind, "observation");
		assert.equal(result.details.runs[0].sequence, 1);
	} finally {
		fixture.cleanup();
	}
});

test("rex_wait returns lifecycle outcomes when usage observation fails", async () => {
	const fixture = tempEnv();
	try {
		const outcomes: WaitResult[] = [
			{ handle: "child1", outcome: "idle", state: "idle", agentState: "idle", turn: 2, processExitCode: 0 },
			{ handle: "child2", outcome: "timeout", state: "busy", turn: 1, processExitCode: null },
		];
		const parent = harness(
			fixture.env,
			async (options) => {
				const created = record(options.name);
				writeRecord(created, fixture.env);
				return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
			},
			[],
			async (handles): Promise<WaitResult[]> => handles.map((handle) => outcomes.find((entry) => entry.handle === handle)!),
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		await spawnForTest(parent, "child2");
		// child2 never published a snapshot, so observation fails after the wait
		// itself succeeded.
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const result = await parent.execute("rex_wait", { handles: ["child1", "child2"], timeoutMs: 10 });
		assert.equal(result.isError, true);
		assert.equal(result.usage, undefined);
		assert.deepEqual(result.details.runs, []);
		assert.equal(
			result.content[0].text,
			'run child2 has no usage snapshot\n{"outcomes":[{"handle":"child1","outcome":"idle","state":"idle","agentState":"idle","turn":2,"processExitCode":0},{"handle":"child2","outcome":"timeout","state":"busy","turn":1,"processExitCode":null}]}',
		);
	} finally {
		fixture.cleanup();
	}
});

test("accounting-aware stop collects the final delta before removal", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: "busy" }),
				stop: async () => {
					writeSnapshot("child1", fixture.env, 2, secondUsage, { final: true });
					return { handle: "child1", stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		await parent.execute("rex_observe", { handles: ["child1"] });
		const stopped = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.equal(stopped.details.runs[0].final, true);
		assert.deepEqual(stopped.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("a clean final zero-delta stop advances the final cursor without usage", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: "idle" }),
				stop: async () => {
					writeSnapshot("child1", fixture.env, 2, firstUsage, { final: true });
					return { handle: "child1", stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		await parent.execute("rex_observe", { handles: ["child1"] });
		const stopped = await parent.execute("rex_stop", { handle: "child1" });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.equal(stopped.usage, undefined);
		assert.equal(stopped.details.runs[0].sequence, 2);
		assert.equal(stopped.details.runs[0].final, true);
		assert.equal(readRecord("child1", fixture.env)?.usageFinalizationRequired, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("failed final observation preserves records and can be retried", async () => {
	const fixture = tempEnv();
	try {
		let lifecycleState = "busy";
		const metadata = (): Record<string, unknown> => JSON.parse(readFileSync(join(runDirFor("child1", fixture.env), "metadata.json"), "utf8"));
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: lifecycleState }),
				stop: async () => {
					lifecycleState = "stopped";
					return { handle: "child1", stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const failed = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(failed.isError, true);
		assert.equal(failed.usage, undefined);
		assert.match(failed.content[0].text, /"stopped":true/);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), true);
		// The run was reliably live, so the durable finalization requirement
		// survives the failed collection: a retry cannot mistake it for dead.
		assert.equal(metadata().usageFinalizationRequired, true);
		lifecycleState = "busy";
		const stillNotFinal = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stillNotFinal.isError, true);
		assert.equal(stillNotFinal.usage, undefined);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), true);

		writeSnapshot("child1", fixture.env, 2, secondUsage, { final: true });
		const retried = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, secondUsage);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("a terminal stop retry collects the last non-final snapshot as unconfirmed and permits removal", async () => {
	const fixture = tempEnv();
	try {
		let lifecycleState = "busy";
		const beforeClose: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: lifecycleState }),
				stop: async (handle, options) => {
					beforeClose.push(options.beforeClose);
					lifecycleState = "exited";
					return { handle, stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const usagePath = join(runDirFor("child1", fixture.env), "usage.json");
		const originalSnapshot = readFileSync(usagePath, "utf8");

		const liveAttempt = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(liveAttempt.isError, true);
		assert.match(liveAttempt.content[0].text, /final usage snapshot/);
		assert.equal(readRecord("child1", fixture.env)?.usageFinalizationRequired, true);
		assert.equal(typeof beforeClose[0], "function", "a reliably live stop still requests child finalization");

		// Terminal fallback must not turn malformed data into a collectible zero
		// or non-final observation, and must retain the durable retry marker.
		writeFileSync(usagePath, "not-json\n");
		const malformed = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(malformed.isError, true);
		assert.equal(malformed.usage, undefined);
		assert.equal(readFileSync(usagePath, "utf8"), "not-json\n");
		assert.equal(readRecord("child1", fixture.env)?.usageFinalizationRequired, true);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), true);

		// Restore only the original durable non-final bytes. No later final
		// snapshot is manufactured for this retry.
		writeFileSync(usagePath, originalSnapshot);
		const retried = await parent.execute("rex_stop", { handle: "child1" });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, firstUsage);
		assert.equal(retried.details.runs[0].final, false);
		assert.equal(retried.details.runs[0].finalization, "unconfirmed");
		assert.match(retried.content[0].text, /finalization.*unconfirmed/i);
		assert.equal(readRecord("child1", fixture.env)?.usageFinalizationRequired, undefined);
		assert.equal(beforeClose[1], undefined);
		assert.equal(beforeClose[2], undefined);

		const removed = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(removed.isError, undefined, removed.content[0]?.text);
		assert.equal(removed.usage, undefined);
		assert.equal(removed.details.runs[0].final, false);
		assert.equal(removed.details.runs[0].finalization, "unconfirmed");
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("a pre-upgrade owned terminal run needs no invented adoption baseline for zero recovery", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("legacy-run"), fixture.env);
		writeRecord(record("legacy-stop"), fixture.env);
		const parent = harness(
			fixture.env,
			undefined,
			[],
			async (handles): Promise<WaitResult[]> =>
				handles.map((handle) => ({ handle, outcome: "gone", state: "gone", turn: 0, processExitCode: null })),
			{
				describe: async () => ({ state: "gone" }),
				stop: async (handle) => ({ handle, stopped: true, removed: false }),
			},
		);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "legacy-run" });
		assert.equal(adopted.isError, true, "adoption must not invent a zero baseline for unknown history");
		assert.match(adopted.content[0].text, /no usage snapshot/);

		// No wait or baseline result exists for this second pre-upgrade run.
		const directStop = await parent.execute("rex_stop", { handle: "legacy-stop", remove: true });
		assert.equal(directStop.isError, undefined, directStop.content[0]?.text);
		assert.equal(directStop.usage, undefined);
		assert.equal(directStop.details.runs[0].snapshot, "missing");
		assert.equal(existsSync(runDirFor("legacy-stop", fixture.env)), false);

		const waited = await parent.execute("rex_wait", { handles: ["legacy-run"], timeoutMs: 1 });
		assert.equal(waited.isError, undefined, waited.content[0]?.text);
		assert.equal(waited.usage, undefined);
		assert.equal(waited.details.runs[0].snapshot, "missing");
		assert.equal(waited.details.runs[0].sequence, 0);
		assert.equal(waited.details.runs[0].finalization, "unconfirmed");

		const stopped = await parent.execute("rex_stop", { handle: "legacy-run", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.equal(stopped.usage, undefined);
		assert.equal(stopped.details.runs[0].snapshot, "missing");
		assert.equal(existsSync(runDirFor("legacy-run", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("a terminal direct child with no snapshot records zero recovery, replays, and can be removed", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		assert.equal(spawned.isError, undefined, spawned.content[0]?.text);
		persistToolResult(branch, "rex_spawn", spawned);

		// No session_start snapshot is ever written. Restore only the original
		// direct-spawn baseline, as for a crashed or pre-upgrade child.
		const terminal = harness(fixture.env, undefined, branch, undefined, {
			describe: async () => ({ state: "exited" }),
			stop: async (handle) => ({ handle, stopped: true, removed: false }),
		});
		await terminal.start();
		const stopped = await terminal.execute("rex_stop", { handle: "child1" });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.equal(stopped.usage, undefined, "unknown history is never emitted as a Usage delta");
		assert.deepEqual(stopped.details.runs, [
			{
				handle: "child1",
				childSessionId: null,
				generation: null,
				sequence: 0,
				cumulative: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
				},
				final: false,
				finalization: "unconfirmed",
				snapshot: "missing",
			},
		]);
		assert.match(stopped.content[0].text, /snapshot.*missing/i);
		persistToolResult(branch, "rex_stop", stopped);

		const replayed = harness(fixture.env, undefined, branch, undefined, {
			describe: async () => ({ state: "exited" }),
			stop: async (handle) => ({ handle, stopped: true, removed: false }),
		});
		await replayed.start();
		const observed = await replayed.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observed.isError, undefined, observed.content[0]?.text);
		assert.equal(observed.usage, undefined);
		assert.equal(observed.details.runs[0].snapshot, "missing");
		assert.equal(observed.details.runs[0].finalization, "unconfirmed");

		const removed = await replayed.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(removed.isError, undefined, removed.content[0]?.text);
		assert.equal(removed.usage, undefined);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("only a terminal wait can establish a missing-snapshot cursor for a direct spawn", async () => {
	const fixture = tempEnv();
	try {
		let state: "busy" | "exited" = "busy";
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			async (handles): Promise<WaitResult[]> =>
				handles.map((handle) => ({
					handle,
					outcome: state === "exited" ? "exited" : "timeout",
					state,
					turn: 0,
					processExitCode: state === "exited" ? 1 : null,
				})),
		);
		await parent.start();
		await spawnForTest(parent, "child1");

		const observedLive = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observedLive.isError, true);
		assert.match(observedLive.content[0].text, /no usage snapshot/);
		const waitedLive = await parent.execute("rex_wait", { handles: ["child1"], timeoutMs: 1 });
		assert.equal(waitedLive.isError, true);
		assert.equal(waitedLive.usage, undefined);

		state = "exited";
		const waitedTerminal = await parent.execute("rex_wait", { handles: ["child1"], timeoutMs: 1 });
		assert.equal(waitedTerminal.isError, undefined, waitedTerminal.content[0]?.text);
		assert.equal(waitedTerminal.usage, undefined);
		assert.equal(waitedTerminal.details.runs[0].snapshot, "missing");
		assert.equal(waitedTerminal.details.runs[0].finalization, "unconfirmed");
		assert.match(waitedTerminal.content[0].text, /snapshot.*missing/i);

		// The successful terminal result is durable evidence. An idempotent
		// observe need not reprobe a process that can never restart.
		const replaySafe = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(replaySafe.isError, undefined, replaySafe.content[0]?.text);
		assert.equal(replaySafe.usage, undefined);
		assert.equal(replaySafe.details.runs[0].snapshot, "missing");
	} finally {
		fixture.cleanup();
	}
});

test("an already dead child remains collectible without a final marker", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: "exited" }),
				stop: async () => ({ handle: "child1", stopped: true, removed: false }),
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const stopped = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.deepEqual(stopped.usage, firstUsage);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("an undetermined pre-stop state fails closed without poisoning dead-child collection", async () => {
	const fixture = tempEnv();
	try {
		const states: (string | undefined)[] = [undefined, "unknown", "exited"];
		const metadata = (): Record<string, unknown> => JSON.parse(readFileSync(join(runDirFor("child1", fixture.env), "metadata.json"), "utf8"));
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => {
					const state = states.shift();
					if (state === undefined) throw new Error("rex unreachable");
					return { state };
				},
				stop: async () => ({ handle: "child1", stopped: true, removed: false }),
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);

		// A transient describe failure cannot prove the child is dead, so this
		// attempt fails closed and demands a final snapshot it never gets.
		const undetermined = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(undetermined.isError, true);
		assert.equal(undetermined.usage, undefined);
		assert.match(undetermined.content[0].text, /final usage snapshot/);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), true);
		// But it must not persist the finalization requirement: the state was
		// never reliably live, so later dead-child collection stays possible.
		assert.equal(metadata().usageFinalizationRequired, undefined);

		// An explicit "unknown" display state is equally undeterminable.
		const unknownState = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(unknownState.isError, true);
		assert.equal(unknownState.usage, undefined);
		assert.equal(metadata().usageFinalizationRequired, undefined);

		// Once exited is proven, the last non-final durable snapshot is collectible.
		const dead = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(dead.isError, undefined, dead.content[0]?.text);
		assert.deepEqual(dead.usage, firstUsage);
		assert.equal(dead.details.runs[0].final, false);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("conflicting, regressed, changed, negative, and post-final snapshots fail closed", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		await parent.execute("rex_observe", { handles: ["child1"] });

		writeSnapshot("child1", fixture.env, 1, firstUsage, { childSessionId: "different-child" });
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 1, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 2, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, undefined);

		writeSnapshot("child1", fixture.env, 3, secondUsage, { childSessionGeneration: "replacement" });
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 3, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, undefined);

		writeSnapshot("child1", fixture.env, 2, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 4, firstUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		const negative = { ...secondUsage, input: -1 };
		writeSnapshot("child1", fixture.env, 4, negative);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 4, secondUsage);
		const usagePath = join(runDirFor("child1", fixture.env), "usage.json");
		writeFileSync(usagePath, readFileSync(usagePath, "utf8").replace('"totalTokens":29', '"totalTokens":1e999'));
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		const withoutOptional = { ...secondUsage };
		delete withoutOptional.cacheWrite1h;
		delete withoutOptional.reasoning;
		writeSnapshot("child1", fixture.env, 4, withoutOptional);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);

		writeSnapshot("child1", fixture.env, 4, secondUsage, { final: true });
		const final = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(final.isError, undefined, final.content[0]?.text);
		assert.equal(final.usage, undefined);
		assert.equal(final.details.runs[0].final, true);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).usage, undefined);
		writeSnapshot("child1", fixture.env, 5, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
	} finally {
		fixture.cleanup();
	}
});

test("a changed child session is rejected on a higher sequence without advancing the cursor", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, undefined);

		writeSnapshot("child1", fixture.env, 2, secondUsage, { childSessionId: "replacement-child" });
		const rejected = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);

		writeSnapshot("child1", fixture.env, 2, secondUsage);
		const retried = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("estimated cumulative cost cannot become provider-reported on the second observation", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		const first: Usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, totalFromProvider: false },
		};
		const second: Usage = {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6, totalFromProvider: true },
		};
		const third: Usage = {
			input: 6,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 13,
			cost: { input: 6, output: 4, cacheRead: 2, cacheWrite: 1, total: 13, totalFromProvider: false },
		};
		writeSnapshot("child1", fixture.env, 1, first);
		const initial = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(initial.isError, undefined, initial.content[0]?.text);
		assert.deepEqual(initial.usage, first);

		writeSnapshot("child1", fixture.env, 2, second);
		const rejected = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);

		writeSnapshot("child1", fixture.env, 3, third);
		const retried = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, {
			input: 5,
			output: 3,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 11,
			cost: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, total: 11, totalFromProvider: false },
		});
	} finally {
		fixture.cleanup();
	}
});

test("provider to estimated cost remains mixed and cannot upgrade on the third observation", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		const first: Usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, totalFromProvider: true },
		};
		const second: Usage = {
			...first,
			input: 3,
			output: 2,
			cacheRead: 1,
			totalTokens: 6,
			cost: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6, totalFromProvider: false },
		};
		const third: Usage = {
			...second,
			input: 6,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 13,
			cost: { input: 6, output: 4, cacheRead: 2, cacheWrite: 1, total: 13, totalFromProvider: true },
		};
		writeSnapshot("child1", fixture.env, 1, first);
		const initial = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(initial.isError, undefined, initial.content[0]?.text);
		assert.equal(initial.usage?.cost.totalFromProvider, true, "a neutral spawn baseline inherits provider provenance");

		writeSnapshot("child1", fixture.env, 2, second);
		const estimated = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(estimated.isError, undefined, estimated.content[0]?.text);
		assert.deepEqual(estimated.usage, {
			input: 2,
			output: 1,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 2, output: 1, cacheRead: 1, cacheWrite: 0, total: 4, totalFromProvider: false },
		});

		writeSnapshot("child1", fixture.env, 3, third);
		const rejected = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(rejected.isError, true);
		assert.equal(rejected.usage, undefined);
		assert.deepEqual(rejected.details.runs, []);

		writeSnapshot("child1", fixture.env, 3, {
			...third,
			cost: { ...third.cost, totalFromProvider: false },
		});
		const retried = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 1,
			totalTokens: 7,
			cost: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, total: 7, totalFromProvider: false },
		});
	} finally {
		fixture.cleanup();
	}
});

test("mixed provider-cost provenance is never upgraded", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		const estimated: Usage = {
			...firstUsage,
			cost: { ...firstUsage.cost, totalFromProvider: false },
		};
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, estimated);
		const combined = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(combined.usage?.cost.totalFromProvider, false);

		writeSnapshot("child-a", fixture.env, 2, secondUsage);
		writeSnapshot("child-b", fixture.env, 2, {
			...secondUsage,
			cost: { ...secondUsage.cost, totalFromProvider: false },
		});
		const later = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(later.usage?.cost.totalFromProvider, false);
	} finally {
		fixture.cleanup();
	}
});

test("a dead child's durable snapshot remains collectible after parent restart", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		writeSnapshot("child1", fixture.env, 1, firstUsage);

		const restarted = harness(fixture.env, undefined, branch, undefined, {
			describe: async () => ({ state: "exited" }),
			stop: async () => ({ handle: "child1", stopped: true, removed: false }),
		});
		await restarted.start();
		const collected = await restarted.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(collected.isError, undefined, collected.content[0]?.text);
		assert.deepEqual(collected.usage, firstUsage);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("rex_stop reports one consistent removed state to the model", async () => {
	const fixture = tempEnv();
	const lifecycleFor = (handle: string, remove?: (handle: string) => void) => ({
		describe: async () => ({ state: "idle" }),
		stop: async () => {
			writeSnapshot(handle, fixture.env, 1, firstUsage, { final: true });
			return { handle, stopped: true, removed: false };
		},
		...(remove ? { remove } : {}),
	});
	try {
		const spawn = async (options: any) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		};

		// A requested and successful removal: both fields say removed.
		const removedParent = harness(fixture.env, spawn, [], undefined, lifecycleFor("stop-a"));
		await removedParent.start();
		await spawnForTest(removedParent, "stop-a");
		const removed = await removedParent.execute("rex_stop", { handle: "stop-a", remove: true });
		assert.equal(removed.isError, undefined, removed.content[0]?.text);
		assert.deepEqual(JSON.parse(removed.content[0].text), {
			stopped: { handle: "stop-a", stopped: true, removed: true },
			removed: true,
		});
		assert.equal(existsSync(runDirFor("stop-a", fixture.env)), false);

		// No removal requested: both fields say not removed.
		const keptParent = harness(fixture.env, spawn, [], undefined, lifecycleFor("stop-b"));
		await keptParent.start();
		await spawnForTest(keptParent, "stop-b");
		const kept = await keptParent.execute("rex_stop", { handle: "stop-b" });
		assert.equal(kept.isError, undefined, kept.content[0]?.text);
		assert.deepEqual(JSON.parse(kept.content[0].text), {
			stopped: { handle: "stop-b", stopped: true, removed: false },
			removed: false,
		});
		assert.equal(existsSync(runDirFor("stop-b", fixture.env)), true);

		// A failed removal: both fields say not removed and the error is reported.
		const failedParent = harness(
			fixture.env,
			spawn,
			[],
			undefined,
			lifecycleFor("stop-c", () => {
				throw new Error("permission denied");
			}),
		);
		await failedParent.start();
		await spawnForTest(failedParent, "stop-c");
		const failed = await failedParent.execute("rex_stop", { handle: "stop-c", remove: true });
		assert.equal(failed.isError, undefined, failed.content[0]?.text);
		assert.deepEqual(failed.usage, firstUsage, "a removal error must not hide the final accounting result");
		assert.deepEqual(JSON.parse(failed.content[0].text), {
			stopped: { handle: "stop-c", stopped: true, removed: false },
			removed: false,
			removalError: "permission denied",
		});
		assert.equal(existsSync(runDirFor("stop-c", fixture.env)), true);
	} finally {
		fixture.cleanup();
	}
});

test("a removal failure still returns the successful accounting result", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
			undefined,
			{
				describe: async () => ({ state: "idle" }),
				stop: async () => {
					writeSnapshot("child1", fixture.env, 1, firstUsage, { final: true });
					return { handle: "child1", stopped: true, removed: false };
				},
				remove: () => {
					throw new Error("permission denied");
				},
			},
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		const stopped = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.deepEqual(stopped.usage, firstUsage);
		assert.match(stopped.content[0].text, /permission denied/);
		assert.match(stopped.content[0].text, /"removed":false/);
		persistToolResult(branch, "rex_stop", stopped);

		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		const observed = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observed.isError, undefined, observed.content[0]?.text);
		assert.equal(observed.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("stop validates ownership and baseline before changing the run", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("other-run", "parent-2"), fixture.env);
		writeSnapshot("other-run", fixture.env, 1, firstUsage, { parentSessionId: "parent-2" });
		writeRecord(record("unadopted-run"), fixture.env);
		writeSnapshot("unadopted-run", fixture.env, 1, firstUsage);
		const parent = harness(fixture.env, undefined, [], undefined, {
			describe: async () => ({ state: "busy" }),
			stop: async (handle) => {
				const current = JSON.parse(readFileSync(join(runDirFor(handle, fixture.env), "metadata.json"), "utf8"));
				writeRecord({ ...current, state: "stopped" }, fixture.env);
				writeSnapshot(handle, fixture.env, 2, secondUsage, { final: true });
				return { handle, stopped: true, removed: false };
			},
		});
		await parent.start();
		const other = await parent.execute("rex_stop", { handle: "other-run" });
		assert.equal(other.isError, true);
		assert.equal(JSON.parse(readFileSync(join(runDirFor("other-run", fixture.env), "metadata.json"), "utf8")).state, "running");
		const unadopted = await parent.execute("rex_stop", { handle: "unadopted-run" });
		assert.equal(unadopted.isError, true);
		assert.equal(JSON.parse(readFileSync(join(runDirFor("unadopted-run", fixture.env), "metadata.json"), "utf8")).state, "running");
	} finally {
		fixture.cleanup();
	}
});

test("nested delegation is charged only through the immediate child aggregate", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child-a");
			writeRecord(created, fixture.env);
			return { handle: "child-a", record: created, dir: runDirFor("child-a", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		writeRecord(record("grandchild-b", "child-a"), fixture.env);
		writeSnapshot("child-a", fixture.env, 1, secondUsage);
		writeSnapshot("grandchild-b", fixture.env, 1, firstUsage, { parentSessionId: "child-a" });
		const direct = await parent.execute("rex_observe", { handles: ["child-a"] });
		assert.deepEqual(direct.usage, secondUsage);
		const nested = await parent.execute("rex_observe", { handles: ["grandchild-b"] });
		assert.equal(nested.isError, true);
		assert.equal(nested.usage, undefined);
		const adopted = await parent.execute("rex_adopt", { handle: "grandchild-b" });
		assert.equal(adopted.isError, true);
	} finally {
		fixture.cleanup();
	}
});

test("a spawn baseline failure stops the child and preserves an explicit recovery diagnostic", async () => {
	const fixture = tempEnv();
	try {
		let stopOptions: any;
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				stop: async (handle, options) => {
					stopOptions = options;
					updateRecord(handle, { state: "stopped" }, fixture.env);
					return { handle, stopped: true, removed: false };
				},
			},
		);
		// Deliberately skip session_start: launch succeeds, then the public
		// observer seam rejects recordSpawn because no parent was restored.
		const spawned = await parent.execute("rex_spawn", { prompt: "do work", name: "child1" });
		assert.equal(spawned.isError, true);
		assert.equal(spawned.usage, undefined);
		assert.deepEqual(spawned.details.runs, []);
		assert.match(spawned.content[0].text, /child1/);
		assert.match(spawned.content[0].text, /accounting baseline/);
		assert.match(spawned.content[0].text, /stopped.*records retained/i);
		assert.equal(stopOptions.remove, false);
		const retained = readRecord("child1", fixture.env);
		assert.equal(retained?.state, "stopped");
		assert.equal(retained?.parentSessionId, "parent-1");
		assert.match(retained?.usageBaselineError ?? "", /accounting baseline/);

		// A failed spawn has no trustworthy zero baseline in the parent branch.
		// Adoption must not silently reclassify its earlier work as history,
		// including after the parent restores with no successful spawn result.
		await parent.start();
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const adopted = await parent.execute("rex_adopt", { handle: "child1" });
		assert.equal(adopted.isError, true);
		assert.match(adopted.content[0].text, /baseline failure|baseline failed|spawn accounting failure/);
		assert.equal(adopted.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("a spawn rollback failure surfaces the handle and requires explicit management", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				stop: async (handle) => ({ handle, stopped: false, removed: false, detail: "Rex is unreachable" }),
			},
		);
		const spawned = await parent.execute("rex_spawn", { prompt: "do work", name: "child1" });
		assert.equal(spawned.isError, true);
		assert.equal(spawned.usage, undefined);
		assert.match(spawned.content[0].text, /child1/);
		assert.match(spawned.content[0].text, /rollback failed/i);
		assert.match(spawned.content[0].text, /Rex is unreachable/);
		assert.match(spawned.content[0].text, /explicit management/i);
		const retained = readRecord("child1", fixture.env);
		assert.equal(retained?.state, "running");
		assert.equal(retained?.parentSessionId, "parent-1");
		assert.match(retained?.usageBaselineError ?? "", /accounting baseline/);
	} finally {
		fixture.cleanup();
	}
});

test("a failed spawn records no baseline and leaves later spawns usable", async () => {
	const fixture = tempEnv();
	try {
		let failNextSpawn = true;
		const parent = harness(fixture.env, async (options) => {
			if (failNextSpawn) {
				failNextSpawn = false;
				throw new Error("rex unreachable");
			}
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		const failed = await parent.execute("rex_spawn", { prompt: "do work", name: "child-a" });
		assert.equal(failed.isError, true);
		assert.equal(failed.usage, undefined);
		assert.deepEqual(failed.details.runs, []);
		assert.equal(failed.details.kind, "spawn");
		// No baseline was recorded, so nothing about the failed run is chargeable.
		const observed = await parent.execute("rex_observe", { handles: ["child-a"] });
		assert.equal(observed.isError, true);
		assert.equal(observed.usage, undefined);
		// A later spawn still establishes its own zero baseline normally.
		const spawned = await parent.execute("rex_spawn", { prompt: "retry", name: "child-b" });
		assert.equal(spawned.isError, undefined, spawned.content[0]?.text);
		writeSnapshot("child-b", fixture.env, 1, firstUsage);
		const charged = await parent.execute("rex_observe", { handles: ["child-b"] });
		assert.equal(charged.isError, undefined, charged.content[0]?.text);
		assert.deepEqual(charged.usage, firstUsage);
	} finally {
		fixture.cleanup();
	}
});

test("spawn establishes a zero baseline and observe returns only new usage", async () => {
	const fixture = tempEnv();
	try {
		const handle = "child1";
		const parent = harness(fixture.env, async () => {
			const created = record(handle);
			writeRecord(created, fixture.env);
			return { handle, record: created, dir: runDirFor(handle, fixture.env), reusedBatch: false };
		});
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		assert.equal(spawned.isError, undefined);
		assert.equal(spawned.usage, undefined);
		assert.deepEqual(spawned.details, {
			version: 1,
			kind: "spawn",
			parentSessionId: "parent-1",
			runs: [
				{
					handle,
					childSessionId: null,
					generation: null,
					sequence: 0,
					cumulative: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
					},
					final: false,
				},
			],
		});

		writeSnapshot(handle, fixture.env, 1, firstUsage);
		const first = await parent.execute("rex_observe", { handles: [handle] });
		assert.equal(first.isError, undefined);
		assert.deepEqual(first.usage, firstUsage);
		assert.equal(first.details.runs[0].sequence, 1);
		assert.equal(first.details.runs[0].generation, `generation-${handle}`);

		writeSnapshot(handle, fixture.env, 2, firstUsage);
		const repeated = await parent.execute("rex_observe", { handles: [handle] });
		assert.equal(repeated.isError, undefined);
		assert.equal(repeated.usage, undefined);
		assert.equal(repeated.details.runs[0].sequence, 2);

		writeSnapshot(handle, fixture.env, 3, secondUsage);
		const next = await parent.execute("rex_observe", { handles: [handle] });
		assert.deepEqual(next.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});
