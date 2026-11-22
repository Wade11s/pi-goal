import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import childExtension, { planDelivery } from "../src/child.ts";
import { queueMessage, readStatus, runDirFor, writeRecord, type RunRecord } from "../src/record.ts";
import { tempEnv, writeExecutable } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

interface FakePi {
	on: (name: string, handler: Handler) => void;
	registerCommand: (name: string, options: { description?: string; handler: CommandHandler }) => void;
	sendUserMessage: (message: string, options?: { deliverAs?: string }) => void;
}

function fakePi(): {
	pi: FakePi;
	handlers: Map<string, Handler>;
	commands: Map<string, CommandHandler>;
	sent: { message: string; deliverAs?: string }[];
} {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandHandler>();
	const sent: { message: string; deliverAs?: string }[] = [];
	return {
		handlers,
		commands,
		sent,
		pi: {
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, options) => commands.set(name, options.handler),
			sendUserMessage: (message, options) => sent.push({ message, deliverAs: options?.deliverAs }),
		},
	};
}

interface FakeContext {
	idle: boolean;
	aborted: boolean;
	shutdowns: number;
	notices: { message: string; level?: string }[];
	isIdle: () => boolean;
	abort: () => void;
	shutdown: () => void;
	sessionManager: {
		getSessionId: () => string;
		getHeader: () => { type: "session"; id: string; timestamp: string };
		getBranch: () => unknown[];
	};
	ui: { notify: (message: string, level?: string) => void };
}

function fakeContext(idle: boolean, branch: unknown[] = []): FakeContext {
	const ctx: FakeContext = {
		idle,
		aborted: false,
		shutdowns: 0,
		notices: [],
		isIdle: () => ctx.idle,
		abort: () => {
			ctx.aborted = true;
		},
		shutdown: () => {
			ctx.shutdowns += 1;
		},
		sessionManager: {
			getSessionId: () => "child-session",
			getHeader: () => ({ type: "session", id: "child-session", timestamp: "2026-01-01T00:00:00.000Z" }),
			getBranch: () => branch,
		},
		ui: { notify: (message, level) => ctx.notices.push({ message, level }) },
	};
	return ctx;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for child state");
		await sleep(10);
	}
}

/** The child only needs these two API surfaces; the rest is unused. */
function install(pi: FakePi): void {
	childExtension(pi as unknown as Parameters<typeof childExtension>[0]);
}

const HANDLE = "abc123";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		version: 1,
		handle: HANDLE,
		name: "task",
		title: "task — model:high",
		group: "subagents",
		cwd: "/tmp/project",
		prompt: "",
		launchArgs: [],
		parentSessionId: "parent-1",
		parentRex: { sessionId: "session:parent", windowId: "window:parent", blockId: "block:parent" },
		rex: {
			endpoint: "unix:///tmp/rex.sock",
			hostId: "host-1",
			sessionId: "session:1",
			windowId: "window:1",
			blockId: "block:1",
		},
		state: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

interface Harness {
	runDir: string;
	env: NodeJS.ProcessEnv;
	calls: () => string[][];
}

function withRunDir<T>(
	fn: (harness: Harness) => Promise<T>,
	options: { record?: RunRecord } = {},
): Promise<T> {
	const temp = tempEnv();
	const runDir = join(temp.dir, "run");
	mkdirSync(runDir, { recursive: true });
	const logPath = join(temp.dir, "rex.log");
	const fakeRex = writeExecutable(
		join(temp.dir, "bin", "rex"),
		[
			"#!/bin/sh",
			`line=$(printf '%s\\t' "$@")`,
			`printf '%s\\n' "$line" >> ${JSON.stringify(logPath)}`,
			'case "$*" in',
			`  *"client ls"*) printf '%s\\n' '{"clients":[{"client_id":"client:app","info":{"kind":"app","label":"Mac"}}]}' ;;`,
			"esac",
			"exit 0",
			"",
		].join("\n"),
	);
	writeRecord(options.record ?? record(), temp.env);
	const saved = {
		runDir: process.env.REX_SUBAGENT_RUN_DIR,
		handle: process.env.PI_REX_SUBAGENT_HANDLE,
		agent: process.env.PI_CODING_AGENT_DIR,
		rex: process.env.REX_SUBAGENT_REX,
	};
	process.env.REX_SUBAGENT_RUN_DIR = runDir;
	process.env.PI_REX_SUBAGENT_HANDLE = HANDLE;
	process.env.PI_CODING_AGENT_DIR = temp.env.PI_CODING_AGENT_DIR;
	process.env.REX_SUBAGENT_REX = fakeRex;
	const calls = (): string[][] => {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => line.split("\t").filter(Boolean));
	};
	return fn({ runDir, env: temp.env, calls }).finally(() => {
		const restore = (key: string, value: string | undefined): void => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore("REX_SUBAGENT_RUN_DIR", saved.runDir);
		restore("PI_REX_SUBAGENT_HANDLE", saved.handle);
		restore("PI_CODING_AGENT_DIR", saved.agent);
		restore("REX_SUBAGENT_REX", saved.rex);
		temp.cleanup();
	});
}

test("planDelivery starts a turn when idle and steers when busy", () => {
	assert.equal(planDelivery(true, "auto"), "prompt");
	assert.equal(planDelivery(true, "steer"), "prompt");
	assert.equal(planDelivery(true, "followUp"), "prompt");
	assert.equal(planDelivery(false, "auto"), "steer");
	assert.equal(planDelivery(false, "steer"), "steer");
	assert.equal(planDelivery(false, "followUp"), "followUp");
});

test("the child extension is inert without a run directory", () => {
	delete process.env.REX_SUBAGENT_RUN_DIR;
	const { pi, handlers, commands } = fakePi();
	install(pi);
	assert.equal(handlers.size, 0);
	assert.equal(commands.size, 0);
});

test("the child publishes cumulative selected-branch usage and excludes standalone entries", async () => {
	await withRunDir(async ({ runDir }) => {
		const assistantUsage = {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			cacheWrite1h: 1,
			reasoning: 3,
			totalTokens: 18,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33, totalFromProvider: true },
		};
		const toolUsage = {
			input: 4,
			output: 3,
			cacheRead: 1,
			cacheWrite: 0,
			reasoning: 1,
			totalTokens: 8,
			cost: { input: 0.04, output: 0.06, cacheRead: 0.01, cacheWrite: 0, total: 0.11, totalFromProvider: true },
		};
		const compactionUsage = {
			input: 2,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0.02, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.04, totalFromProvider: false },
		};
		const branchUsage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02, totalFromProvider: true },
		};
		const cacheWarmUsage = {
			input: 1000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 1000,
			totalTokens: 2000,
			cost: { input: 10, output: 0, cacheRead: 0, cacheWrite: 10, total: 20 },
		};
		const branch = [
			{ type: "message", message: { role: "assistant", usage: assistantUsage, stopReason: "error" } },
			{ type: "message", message: { role: "toolResult", usage: toolUsage } },
			{ type: "compaction", usage: compactionUsage },
			{ type: "branch_summary", usage: branchUsage },
			{ type: "usage", kind: "cache_warm", usage: cacheWarmUsage },
		];
		const { pi, handlers } = fakePi();
		install(pi);
		await handlers.get("session_start")?.({}, fakeContext(true, branch));
		const snapshot = JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"));
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.source, "pi-rex-subagent");
		assert.equal(snapshot.runHandle, HANDLE);
		assert.equal(snapshot.parentSessionId, "parent-1");
		assert.equal(snapshot.childSessionId, "child-session");
		assert.equal(typeof snapshot.childSessionGeneration, "string");
		assert.equal(snapshot.sequence, 1);
		assert.equal(snapshot.final, false);
		assert.deepEqual(snapshot.usage, {
			input: 17,
			output: 10,
			cacheRead: 3,
			cacheWrite: 1,
			cacheWrite1h: 1,
			reasoning: 4,
			totalTokens: 31,
			cost: { input: 0.17, output: 0.29000000000000004, cacheRead: 0.02, cacheWrite: 0.02, total: 0.5, totalFromProvider: false },
		});
		await handlers.get("session_shutdown")?.({ reason: "reload" }, fakeContext(true, branch));
	});
});

test("the child publishes turn, compaction, reload, and quit snapshots in sequence", async () => {
	await withRunDir(async ({ runDir }) => {
		const usage = {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 0.03, output: 0.04, cacheRead: 0.01, cacheWrite: 0, total: 0.08, totalFromProvider: true },
		};
		const branch: unknown[] = [];
		const ctx = fakeContext(true, branch);
		const { pi, handlers } = fakePi();
		install(pi);
		await handlers.get("session_start")?.({}, ctx);
		branch.push({ type: "message", message: { role: "assistant", usage, stopReason: "stop" } });
		await handlers.get("turn_end")?.({}, ctx);
		assert.equal(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8")).sequence, 2);
		await handlers.get("agent_settled")?.({}, ctx);
		assert.equal(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8")).sequence, 3);
		branch.push({ type: "compaction", usage });
		await handlers.get("session_compact")?.({}, ctx);
		assert.equal(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8")).sequence, 4);
		branch.push({ type: "branch_summary", usage });
		await handlers.get("session_tree")?.({}, ctx);
		assert.equal(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8")).sequence, 5);
		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		const reloaded = JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"));
		assert.equal(reloaded.sequence, 6);
		assert.equal(reloaded.final, false);
		await handlers.get("session_start")?.({ reason: "reload" }, ctx);
		assert.equal(JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8")).sequence, 7);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		const final = JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"));
		assert.equal(final.sequence, 8);
		assert.equal(final.final, true);
		assert.equal(final.usage.input, 9);
		assert.equal(final.usage.output, 6);
		assert.equal(final.usage.totalTokens, 18);
		assert.equal(final.usage.cost.totalFromProvider, true);
	});
});

test("the child extension delivers the first message as a user message", async () => {
	await withRunDir(async ({ runDir }) => {
		await queueMessage(runDir, "first task");
		const { pi, handlers, sent } = fakePi();
		install(pi);
		await handlers.get("session_start")?.({}, fakeContext(true));
		assert.deepEqual(sent, [], "the first turn waits for the TUI to initialize");
		await sleep(700);
		assert.deepEqual(sent, [{ message: "first task", deliverAs: undefined }]);
		assert.equal(existsSync(join(runDir, "inbox", "0001.json")), false);
		const status = readStatus(runDir);
		assert.equal(status?.state, "busy", "a delivered prompt starts a run");
		assert.equal(status?.turn, 1);
		assert.equal(status?.transport, "tui");
		await handlers.get("agent_settled")?.({}, fakeContext(true));
		assert.equal(readStatus(runDir)?.state, "idle");
		await handlers.get("session_shutdown")?.({}, fakeContext(true));
	});
});

test("the child extension steers into a busy turn and follows up after it", async () => {
	await withRunDir(async ({ runDir }) => {
		const { pi, handlers, sent } = fakePi();
		install(pi);
		const busy = fakeContext(true);
		await handlers.get("session_start")?.({}, busy);
		busy.idle = false;
		await queueMessage(runDir, "change course", "steer");
		await queueMessage(runDir, "then summarise", "followUp");
		await handlers.get("agent_start")?.({}, busy);
		await sleep(320);
		assert.deepEqual(sent, [
			{ message: "change course", deliverAs: "steer" },
			{ message: "then summarise", deliverAs: "followUp" },
		]);
		assert.equal(readStatus(runDir)?.state, "busy");
		assert.equal(readStatus(runDir)?.turn, 2);
		await handlers.get("agent_settled")?.({}, fakeContext(true));
		assert.equal(readStatus(runDir)?.state, "idle");
		// A settled turn must not claim a process exit code; only the Rex probe knows one.
		assert.equal(readStatus(runDir)?.lastExit, undefined);
		await handlers.get("session_shutdown")?.({}, fakeContext(true));
	});
});

test("/back selects the parent tab in the connected Rex app", async () => {
	await withRunDir(async ({ calls }) => {
		const { pi, commands } = fakePi();
		install(pi);
		const ctx = fakeContext(true);
		await commands.get("back")?.("", ctx);
		assert.deepEqual(ctx.notices, [{ message: "returned to the parent tab", level: "info" }]);
		const selection = calls().find((args) => args.includes("session.select"));
		assert.ok(selection, `expected a session.select call, got ${JSON.stringify(calls())}`);
		assert.deepEqual(selection.slice(selection.indexOf("do")), [
			"do",
			"session.select",
			"session_id=session:parent",
			"window_id=window:parent",
		]);
		assert.ok(selection.includes("client:app"));
		assert.ok(selection.includes("unix:///tmp/rex.sock"));
	});
});

test("/back explains when the subagent has no parent tab", async () => {
	await withRunDir(
		async ({ calls }) => {
			const { pi, commands } = fakePi();
			install(pi);
			const ctx = fakeContext(true);
			await commands.get("back")?.("", ctx);
			assert.equal(ctx.notices.length, 1);
			assert.match(ctx.notices[0].message, /no parent tab/);
			assert.equal(ctx.notices[0].level, "warning");
			assert.deepEqual(calls(), []);
		},
		{ record: record({ parentRex: undefined }) },
	);
});

test("the child does not expose idle when its usage snapshot cannot be published", async () => {
	await withRunDir(async ({ runDir }) => {
		const { pi, handlers } = fakePi();
		install(pi);
		const ctx = fakeContext(false);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("agent_start")?.({}, ctx);
		rmSync(join(runDir, "usage.json"));
		mkdirSync(join(runDir, "usage.json"));
		await handlers.get("agent_settled")?.({}, ctx);
		assert.equal(readStatus(runDir)?.state, "busy");
		await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
	});
});

test("managed child session and tree navigation are refused to preserve accounting", async () => {
	await withRunDir(async () => {
		const { pi, handlers } = fakePi();
		install(pi);
		const ctx = fakeContext(true);
		for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
			const result = await handlers.get(event)?.({}, ctx);
			assert.deepEqual(result, { cancel: true });
		}
		assert.equal(ctx.notices.length, 3);
		assert.equal(ctx.notices.every((notice) => /accounting/.test(notice.message)), true);
	});
});

test("an unowned child keeps normal Pi navigation", async () => {
	await withRunDir(
		async () => {
			const { pi, handlers } = fakePi();
			install(pi);
			const ctx = fakeContext(true);
			for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
				const result = await handlers.get(event)?.({}, ctx);
				assert.equal(result, undefined, `${event} must not be cancelled without an accounting owner`);
			}
			assert.deepEqual(ctx.notices, []);
		},
		{ record: record({ parentSessionId: undefined }) },
	);
});

test("unreadable ownership fails closed for snapshots and navigation", async () => {
	await withRunDir(
		async ({ runDir, env }) => {
			writeFileSync(join(runDirFor(HANDLE, env), ".accounting-owner.json"), "not-json\n");
			const { pi, handlers } = fakePi();
			install(pi);
			const ctx = fakeContext(true);
			await handlers.get("session_start")?.({}, ctx);
			assert.equal(existsSync(join(runDir, "usage.json")), false);
			const result = await handlers.get("session_before_tree")?.({}, ctx);
			assert.deepEqual(result, { cancel: true });
			assert.match(ctx.notices.at(-1)?.message ?? "", /fail closed/);
			await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		},
		{ record: record({ parentSessionId: undefined }) },
	);
});

test("adoption makes later navigation refuse", async () => {
	await withRunDir(
		async ({ env }) => {
			const { pi, handlers } = fakePi();
			install(pi);
			const ctx = fakeContext(true);
			assert.equal(await handlers.get("session_before_switch")?.({}, ctx), undefined);
			// The run is claimed by a parent session after the child already ran unowned.
			writeRecord(record({ parentSessionId: "parent-9" }), env);
			for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
				assert.deepEqual(await handlers.get(event)?.({}, ctx), { cancel: true });
			}
			assert.equal(ctx.notices.length, 3);
		},
		{ record: record({ parentSessionId: undefined }) },
	);
});

test("an intentional stop forces the legacy success exit when the aborted turn never settles", { timeout: 10_000 }, async () => {
	await withRunDir(async ({ runDir }) => {
		const previousGrace = process.env.REX_SUBAGENT_STOP_GRACE_MS;
		process.env.REX_SUBAGENT_STOP_GRACE_MS = "80";
		const exits: number[] = [];
		const originalExit = process.exit;
		(process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
			exits.push(code ?? 0);
		};
		try {
			const { pi, handlers } = fakePi();
			install(pi);
			const ctx = fakeContext(false);
			await handlers.get("session_start")?.({}, ctx);
			writeFileSync(join(runDir, "stop"), "");
			await waitFor(() => exits.length === 1 && readStatus(runDir)?.state === "stopped");
			assert.equal(ctx.aborted, true);
			// The aborted turn never settles, so the pre-accounting forced success
			// exit takes over instead of lingering until a window kill.
			assert.equal(readStatus(runDir)?.state, "stopped");
			assert.deepEqual(exits, [0]);
			assert.equal(ctx.shutdowns, 0, "a forced exit is not a graceful shutdown");
			const snapshot = JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"));
			assert.equal(snapshot.final, false, "an unsettled turn may not claim a final snapshot");
			assert.equal(snapshot.sequence, 2, "the early non-final snapshot was still published");
		} finally {
			(process as unknown as { exit: (code?: number) => void }).exit = originalExit;
			if (previousGrace === undefined) delete process.env.REX_SUBAGENT_STOP_GRACE_MS;
			else process.env.REX_SUBAGENT_STOP_GRACE_MS = previousGrace;
		}
	});
});

test("an intentional stop keeps the success exit when the final snapshot cannot be published", { timeout: 10_000 }, async () => {
	await withRunDir(async ({ runDir }) => {
		const previousGrace = process.env.REX_SUBAGENT_STOP_GRACE_MS;
		process.env.REX_SUBAGENT_STOP_GRACE_MS = "2000";
		const exits: number[] = [];
		const originalExit = process.exit;
		(process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
			exits.push(code ?? 0);
		};
		try {
			const { pi, handlers } = fakePi();
			install(pi);
			const ctx = fakeContext(false);
			await handlers.get("session_start")?.({}, ctx);
			writeFileSync(join(runDir, "stop"), "");
			await sleep(320);
			assert.equal(ctx.aborted, true);
			// Every snapshot write from here on fails.
			rmSync(join(runDir, "usage.json"));
			mkdirSync(join(runDir, "usage.json"));
			ctx.idle = true;
			await handlers.get("agent_settled")?.({}, ctx);
			// Publication failed, but the intentional stop must not degrade into an
			// incidental exited outcome: force the legacy success exit instead.
			assert.deepEqual(exits, [0]);
			assert.equal(readStatus(runDir)?.state, "stopped");
			assert.equal(ctx.shutdowns, 0);
			assert.match(readFileSync(join(runDir, "child.err.log"), "utf8"), /usage snapshot write failed/);
		} finally {
			(process as unknown as { exit: (code?: number) => void }).exit = originalExit;
			if (previousGrace === undefined) delete process.env.REX_SUBAGENT_STOP_GRACE_MS;
			else process.env.REX_SUBAGENT_STOP_GRACE_MS = previousGrace;
		}
	});
});

test("the child finalizes aborted usage before stopped status and graceful shutdown", { timeout: 10_000 }, async () => {
	await withRunDir(async ({ runDir }) => {
		const usage = {
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0.03, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.07, totalFromProvider: true },
		};
		const branch: unknown[] = [];
		const { pi, handlers } = fakePi();
		install(pi);
		const ctx = fakeContext(false, branch);
		await handlers.get("session_start")?.({}, ctx);
		const exits: number[] = [];
		const originalExit = process.exit;
		(process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
			exits.push(code ?? 0);
		};
		try {
			writeFileSync(join(runDir, "stop"), "");
			await sleep(320);
			assert.equal(ctx.aborted, true);
			assert.equal(ctx.shutdowns, 0);
			assert.notEqual(readStatus(runDir)?.state, "stopped");
			assert.deepEqual(exits, []);

			ctx.idle = true;
			branch.push(
				{ type: "message", message: { role: "assistant", usage, stopReason: "aborted" } },
				{ type: "message", message: { role: "toolResult", usage, isError: false } },
			);
			await handlers.get("agent_settled")?.({}, ctx);
			assert.equal(readStatus(runDir)?.state, "stopped");
			assert.equal(ctx.shutdowns, 1);
			assert.deepEqual(exits, []);
			const snapshot = JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"));
			assert.equal(snapshot.final, true);
			assert.equal(snapshot.sequence, 3);
			assert.equal(snapshot.usage.input, 6);
			assert.equal(snapshot.usage.totalTokens, 10);
			await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		} finally {
			(process as unknown as { exit: (code?: number) => void }).exit = originalExit;
		}
	});
});

test("the child extension parks unreadable messages instead of looping", async () => {
	await withRunDir(async ({ runDir }) => {
		const inbox = join(runDir, "inbox");
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, "0001.json"), "{broken");
		const { pi, handlers, sent } = fakePi();
		install(pi);
		await handlers.get("session_start")?.({}, fakeContext(true));
		await sleep(700);
		assert.deepEqual(sent, []);
		assert.equal(existsSync(join(inbox, "0001.json.bad")), true);
		assert.match(readFileSync(join(runDir, "child.err.log"), "utf8"), /unreadable inbox message 0001\.json/);
	});
});
