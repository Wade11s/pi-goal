import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { spawnRun } from "../src/launch.ts";
import { describeRun, listRuns, readLog, sendMessage, stopRun, waitRuns } from "../src/lifecycle.ts";
import { discoverRex, listWindows, readProgramStatus } from "../src/rex.ts";
import { runDirFor } from "../src/record.ts";

// Opt-in smoke test against the real local Rex server and a real Pi child TUI.
// Run with: REX_SUBAGENT_LIVE=1 npm run test:live
const live = process.env.REX_SUBAGENT_LIVE === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForState(handle: string, wanted: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await describeRun(handle)).state === wanted) return;
		await sleep(500);
	}
	throw new Error(`${handle} never reached ${wanted}`);
}

async function windowLabel(handle: string): Promise<string | undefined> {
	const view = await describeRun(handle);
	if (!view.sessionId || !view.windowId) return undefined;
	const location = await discoverRex();
	const windows = await listWindows(location, view.sessionId);
	return windows.find((window) => window.windowId === view.windowId)?.label;
}

async function waitForLabel(handle: string, prefix: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const label = await windowLabel(handle);
		if (label?.startsWith(prefix)) return label;
		await sleep(300);
	}
	throw new Error(`tab label never started with ${prefix}; last was ${await windowLabel(handle)}`);
}

/** Collect the distinct OSC 7501 states Rex sees until the run finishes. */
async function observedStates(handle: string, timeoutMs: number): Promise<string[]> {
	const view = await describeRun(handle);
	const location = await discoverRex();
	const deadline = Date.now() + timeoutMs;
	const states: string[] = [];
	while (Date.now() < deadline) {
		for (const record of await readProgramStatus(location, view.sessionId, view.blockId)) {
			const state = record.state ?? "none";
			if (states.at(-1) !== state) states.push(state);
		}
		if (states.includes("done") || states.includes("error")) return states;
		await sleep(400);
	}
	return states;
}

async function cleanup(handle: string): Promise<void> {
	await stopRun(handle, { remove: true, killSession: true }).catch(() => undefined);
	rmSync(runDirFor(handle), { recursive: true, force: true });
}

test("live: a real Rex window runs a Pi TUI turn", { skip: !live }, async () => {
	const spawned = await spawnRun({
		name: `smoke-${Date.now().toString(36).slice(-4)}`,
		cwd: process.cwd(),
		prompts: ["Reply with exactly: REX_OK"],
		files: [],
		group: `smoke-${process.pid}`,
	});
	try {
		const [result] = await waitRuns([spawned.handle], { timeoutMs: 240_000, pollMs: 500 });
		assert.equal(result.outcome, "idle", `wait ended as ${result.outcome}: ${result.state}`);
		assert.equal(result.agentState, "idle");
		// The process is still alive while idle; there is no exit code yet.
		assert.equal(result.processExitCode, null);
		const view = await describeRun(spawned.handle);
		assert.ok(view.sessionId.startsWith("session:"));
		const log = readLog(spawned.handle);
		assert.match(log, /=== prompt 1 ===/);
		assert.match(log, /REX_OK/);
		// Titles stay plain: no glyph prefix was added back.
		const label = await waitForLabel(spawned.handle, "smoke-", 10_000);
		assert.match(label, /^smoke-/);
		const runs = await listRuns({}, {});
		assert.ok(runs.some((run) => run.handle === spawned.handle));
	} finally {
		await cleanup(spawned.handle);
	}
});

test("live: Pi's full OSC 7501 sequence reaches Rex unchanged", { skip: !live }, async () => {
	const spawned = await spawnRun({
		name: `status-${Date.now().toString(36).slice(-4)}`,
		cwd: process.cwd(),
		prompts: ["Use the bash tool to run exactly: sleep 8. Then reply STATUS_OK."],
		files: [],
		group: `status-${process.pid}`,
	});
	try {
		const states = await observedStates(spawned.handle, 120_000);
		assert.ok(states.includes("working"), `expected a working state, saw ${states.join(" → ")}`);
		assert.ok(states.includes("done"), `expected the completion state, saw ${states.join(" → ")}`);
		const location = await discoverRex();
		const view = await describeRun(spawned.handle);
		const [record] = await readProgramStatus(location, view.sessionId, view.blockId);
		assert.equal(record?.state, "done");
		assert.match(record?.msg ?? "", /^status-/, "Pi reports the session name as the message");
	} finally {
		await cleanup(spawned.handle);
	}
});

test("live: a steer reaches the running TUI turn instead of queueing a new one", { skip: !live }, async () => {
	const spawned = await spawnRun({
		name: `steer-${Date.now().toString(36).slice(-4)}`,
		cwd: process.cwd(),
		prompts: ["Use the bash tool to run exactly: sleep 20. After the command returns, reply DONE."],
		files: [],
		group: `steer-${process.pid}`,
	});
	try {
		await waitForState(spawned.handle, "busy", 120_000);
		assert.match(await waitForLabel(spawned.handle, "steer-", 10_000), /^steer-/, "the busy tab is not relabelled");
		const sent = await sendMessage(
			spawned.handle,
			"Drop the sleep. Do not run any tool. Reply with exactly: STEERED",
			{ delivery: "steer" },
		);
		assert.equal(sent.delivery, "steer");
		const [result] = await waitRuns([spawned.handle], { timeoutMs: 240_000, pollMs: 500 });
		assert.equal(result.outcome, "idle");
		assert.equal(result.agentState, "idle");
		assert.equal(result.processExitCode, null);
		const log = readLog(spawned.handle);
		assert.match(log, /Drop the sleep/);
		assert.match(log, /STEERED/);
		assert.ok(!/=== answer \d+ ===\nDONE/.test(log), `steer did not reach the running turn:\n${log}`);
	} finally {
		await cleanup(spawned.handle);
	}
});
