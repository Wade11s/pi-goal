/**
 * Issue #45: provider-neutral subagent-usage conformance at Pi's public
 * custom-tool-result seam.
 *
 * A provider adapter supplies only fixture administration and methods that invoke
 * its real public tools. Every assertion below is against the returned `usage`
 * and `details`, never against a provider's private accounting implementation.
 * The same cases run against the deterministic fake and released Rex provider.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	assistantOutcomes,
	script,
} from "./rpc-harness.mjs";

const TREE_NAV = new URL("../extensions/tree-nav.ts", import.meta.url).pathname;

export const FIRST_USAGE = {
	input: 11,
	output: 7,
	cacheRead: 13,
	cacheWrite: 2,
	cacheWrite1h: 1,
	reasoning: 3,
	totalTokens: 33,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, totalFromProvider: true },
};

export const SECOND_USAGE = {
	input: 16,
	output: 10,
	cacheRead: 20,
	cacheWrite: 5,
	cacheWrite1h: 3,
	reasoning: 5,
	totalTokens: 51,
	cost: { input: 3, output: 5, cacheRead: 8, cacheWrite: 6, total: 22, totalFromProvider: true },
};

export const DELTA_USAGE = {
	input: 5,
	output: 3,
	cacheRead: 7,
	cacheWrite: 3,
	cacheWrite1h: 2,
	reasoning: 2,
	totalTokens: 18,
	cost: { input: 2, output: 3, cacheRead: 5, cacheWrite: 2, total: 12, totalFromProvider: true },
};

export const COMBINED_USAGE = {
	input: 27,
	output: 17,
	cacheRead: 33,
	cacheWrite: 7,
	cacheWrite1h: 4,
	reasoning: 8,
	totalTokens: 84,
	cost: { input: 4, output: 7, cacheRead: 11, cacheWrite: 10, total: 32, totalFromProvider: true },
};

function resultText(event) {
	return event.result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

function runKey(run) {
	return run.runId ?? run.handle;
}

function cursor(event, runId) {
	return event.result?.details?.runs?.find((run) => runKey(run) === runId);
}

function assertSuccess(event) {
	assert.equal(event.isError, false, resultText(event));
	assert.equal(event.result?.isError, undefined, resultText(event));
	assert.equal(event.result?.details?.version, 1);
	assert.equal(typeof event.result?.details?.parentSessionId, "string");
}

function assertFailure(event, pattern = /invalid|regress|negative|generation|owner|parent|conflict|baseline/i) {
	assert.equal(event.isError, true, resultText(event));
	assert.equal(event.result?.usage, undefined, "a rejected observation never charges usage");
	assert.match(resultText(event), pattern);
}

function assertUsage(event, expected) {
	assertSuccess(event);
	assert.deepEqual(event.result.usage, expected);
}

function assertZeroDelta(event, runId, sequence) {
	assertSuccess(event);
	assert.equal(event.result.usage, undefined, "a repeated or zero-delta observation omits tool-result usage");
	assert.equal(cursor(event, runId).sequence, sequence, "the durable cursor still advances or remains available");
}

function assertCursor(event, runId, sequence, cumulative) {
	const actual = cursor(event, runId);
	assert.ok(actual, `the public result retains a cursor for ${runId}`);
	assert.equal(actual.sequence, sequence);
	assert.deepEqual(actual.cumulative, cumulative);
	assert.equal(typeof actual.childSessionId, "string");
	assert.equal(typeof (actual.generation ?? actual.childSessionGeneration), "string");
}

/** Only token Usage crosses the seam: no child active/elapsed time is representable. */
function assertNoChildElapsed(value) {
	const visit = (current) => {
		if (!current || typeof current !== "object") return;
		for (const [key, child] of Object.entries(current)) {
			assert.doesNotMatch(key, /active|elapsed/i, `child time field ${key} must not cross the tool-result seam`);
			visit(child);
		}
	};
	visit(value.result?.usage);
	visit(value.result?.details);
}

function snapshotFor(provider, current, sequence, usage, overrides = {}) {
	return {
		...current,
		version: 1,
		source: provider.source,
		parentSessionId: current.parentSessionId,
		sequence,
		usage,
		final: false,
		...overrides,
	};
}

/**
 * Real-Pi RPC adapter shared by the fake and released-provider fixtures.
 * Each call is an ordinary prompt whose scripted model invokes the public tool;
 * the assertion receives Pi's actual `tool_execution_end` result.
 */
export class RpcConformanceSession {
	constructor(options) {
		this.root = mkdtempSync(join(tmpdir(), "pi-goal-usage-conformance-rpc-"));
		this.cwd = join(this.root, "work");
		this.sessionDir = join(this.root, "sessions");
		this.scriptPath = join(this.root, "script.json");
		mkdirSync(this.cwd, { recursive: true });
		mkdirSync(this.sessionDir, { recursive: true });
		this.options = options;
		this.toolNames = options.toolNames;
		this.toolCounts = new Map();
		this.sessions = [];
		this.sessionSteps = new Map();
		this.sessionScripts = new Map();
		this.spawnCallIds = new Map();
		this.promptCounter = 0;
	}

	async start(sessionFile) {
		const session = await PiRpcSession.start({
			...this.options,
			cwd: this.cwd,
			sessionDir: this.sessionDir,
			scriptPath: this.scriptPath,
			...(sessionFile ? { sessionFile } : {}),
			extraExtensions: [...(this.options.extraExtensions ?? []), TREE_NAV],
		});
		this.session = session;
		this.sessions.push(session);
		this.sessionSteps.set(session, 0);
		this.sessionScripts.set(session, []);
		this.toolCounts = new Map();
		return session;
	}

	async callBatch(calls) {
		const session = this.session;
		const beforeOutcomes = assistantOutcomes(session).length;
		const steps = [
			...this.sessionScripts.get(session),
			{ toolCalls: calls.map(({ name, args }) => ({ name, args })) },
			{ text: "Conformance observation finished." },
		];
		this.sessionScripts.set(session, steps);
		script(steps, session);
		const occurrences = calls.map(({ name }) => {
			const occurrence = (this.toolCounts.get(name) ?? 0) + 1;
			this.toolCounts.set(name, occurrence);
			return { name, occurrence };
		});
		const pending = session.prompt(`Run public usage conformance call ${++this.promptCounter}`);
		const events = await Promise.all(occurrences.map(({ name, occurrence }) => session.waitForToolResult(name, occurrence)));
		await pending;
		await session.waitFor("the conformance tool turn and closing response", (records) =>
			assistantOutcomes(session).length >= beforeOutcomes + 2 ? true : undefined,
		);
		this.sessionSteps.set(session, this.sessionSteps.get(session) + 2);
		return events;
	}

	async call(name, args) {
		return (await this.callBatch([{ name, args }]))[0];
	}

	spawnArgs(name) {
		return { runId: name };
	}

	async spawn(name) {
		const event = await this.call(this.toolNames.spawn, this.spawnArgs(name));
		const run = event.result?.details?.runs?.[0];
		const runId = runKey(run);
		if (runId) this.spawnCallIds.set(runId, event.toolCallId);
		return { runId, event };
	}

	observe(handles) {
		return this.call(this.toolNames.observe, { handles });
	}

	observeConcurrent(groups) {
		return this.callBatch(groups.map((handles) => ({ name: this.toolNames.observe, args: { handles } })));
	}

	adopt(handle) {
		return this.call(this.toolNames.adopt, { handle });
	}

	stop(handle) {
		return this.call(this.toolNames.stop, { handle, remove: true });
	}

	async restart() {
		const sessionFile = await this.session.sessionFile();
		this.beforeRestartBytes = readFileSync(sessionFile, "utf8");
		await this.session.stop();
		await this.start(sessionFile);
		this.sessionFileAfterRestart = sessionFile;
	}

	assertRestartWasFree() {
		assert.equal(readFileSync(this.sessionFileAfterRestart, "utf8"), this.beforeRestartBytes,
			"cursor reconstruction appends no accounting or usage entry");
		assert.equal(this.session.records.filter((record) => record.type === "tool_execution_end").length, 0,
			"session start invokes no observation tool");
	}

	async baselineEntryId(handle) {
		const { entries } = await this.session.getEntries();
		const toolCallId = this.spawnCallIds.get(handle);
		const entry = entries.find((candidate) =>
			candidate.type === "message" && candidate.message?.role === "toolResult" && candidate.message.toolCallId === toolCallId,
		);
		assert.ok(entry, "the public spawn baseline remains a durable branch entry");
		return entry.id;
	}

	async navigate(entryId) {
		const mark = this.session.records.length;
		await this.session.prompt(`/nav ${entryId}`);
		await this.session.notifyAfter(mark, (record) => record.message.includes(`navigated to ${entryId}`));
		assert.equal(this.session.records.slice(mark).filter((record) => record.type === "tool_execution_end").length, 0,
			"selected-branch cursor reconstruction invokes no tool and charges nothing");
	}

	verify() {
		for (const session of this.sessions) {
			assertStepsConsumed(session, this.sessionSteps.get(session));
			assertCleanRun(session);
			assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		}
	}

	async close() {
		if (this.session && !this.session.closed) await this.session.stop();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/**
 * Run the reusable contract cases. Adapter methods that administer snapshots are
 * fixture-only; all behavior under test arrives through public tool results.
 */
export function runSubagentUsageConformance({ name, skip, createProvider }) {
	const conformanceTest = (title, body) => test(`${name}: ${title}`, skip, async (t) => {
		const provider = await createProvider();
		t.after(() => provider.close());
		await body(provider);
		provider.rpc.verify();
	});

	conformanceTest("spawn baseline, first/repeated/zero-delta observations, and complete Usage", async (provider) => {
		const { runId, event: spawned } = await provider.spawn("basic");
		assertSuccess(spawned);
		assert.equal(spawned.result.usage, undefined, "the explicit spawn baseline is free");
		const baseline = cursor(spawned, runId);
		assert.equal(baseline.sequence, 0);
		assert.equal(baseline.cumulative.totalTokens, 0);
		assertNoChildElapsed(spawned);

		const current = await provider.snapshot(runId);
		await provider.publish(runId, snapshotFor(provider, current, 7, FIRST_USAGE));
		const first = await provider.observe([runId]);
		assertUsage(first, FIRST_USAGE);
		assertCursor(first, runId, 7, FIRST_USAGE);
		assertNoChildElapsed(first);

		assertZeroDelta(await provider.observe([runId]), runId, 7);
		await provider.publish(runId, snapshotFor(provider, current, 8, FIRST_USAGE));
		assertZeroDelta(await provider.observe([runId]), runId, 8);
	});

	conformanceTest("parallel runs, repeated handles, and concurrent observations charge once", async (provider) => {
		const a = (await provider.spawn("parallel-a")).runId;
		const b = (await provider.spawn("parallel-b")).runId;
		await provider.publish(a, snapshotFor(provider, await provider.snapshot(a), 2, FIRST_USAGE));
		await provider.publish(b, snapshotFor(provider, await provider.snapshot(b), 2, SECOND_USAGE));
		const first = await provider.observe([a, a, b, b]);
		assertUsage(first, COMBINED_USAGE);
		assert.equal(first.result.details.runs.length, 2, "duplicate handles collapse to one cursor per run");

		await provider.publish(a, snapshotFor(provider, await provider.snapshot(a), 3, SECOND_USAGE));
		await provider.publish(b, snapshotFor(provider, await provider.snapshot(b), 3, COMBINED_USAGE));
		const overlapping = await provider.observeConcurrent([[a, b], [b, a]]);
		assert.equal(overlapping.filter((event) => event.result.usage !== undefined).length, 1,
			"per-run serialization permits only one charging observation");
		assertUsage(overlapping.find((event) => event.result.usage !== undefined), SECOND_USAGE);
		assertZeroDelta(overlapping.find((event) => event.result.usage === undefined), a, 3);
		for (const event of overlapping) assert.equal(event.result.details.runs.length, 2);
	});

	conformanceTest("malformed, regressed, negative, generation, parent, and conflict data fail closed", async (provider) => {
		const { runId } = await provider.spawn("invalid-data");
		const original = await provider.snapshot(runId);
		await provider.publish(runId, snapshotFor(provider, original, 2, FIRST_USAGE));
		assertUsage(await provider.observe([runId]), FIRST_USAGE);

		const malformed = snapshotFor(provider, original, 3, SECOND_USAGE);
		malformed.usage = { ...SECOND_USAGE, input: "not-a-number" };
		const cases = [
			malformed,
			snapshotFor(provider, original, 1, SECOND_USAGE),
			snapshotFor(provider, original, 3, { ...FIRST_USAGE, input: FIRST_USAGE.input - 1 }),
			snapshotFor(provider, original, 3, SECOND_USAGE, { childSessionGeneration: `${original.childSessionGeneration}-changed` }),
			snapshotFor(provider, original, 3, SECOND_USAGE, { parentSessionId: "unrelated-parent" }),
			snapshotFor(provider, original, 2, SECOND_USAGE),
		];
		for (const value of cases) {
			await provider.publish(runId, value);
			assertFailure(await provider.observe([runId]));
		}

		await provider.publish(runId, snapshotFor(provider, original, 3, SECOND_USAGE));
		const recovered = await provider.observe([runId]);
		assertUsage(recovered, DELTA_USAGE);
		assertCursor(recovered, runId, 3, SECOND_USAGE);
	});

	conformanceTest("adoption establishes a free baseline and excludes earlier work", async (provider) => {
		const runId = await provider.createUnowned("adopted", FIRST_USAGE);
		const adopted = await provider.adopt(runId);
		assertSuccess(adopted);
		assert.equal(adopted.result.usage, undefined, "adoption never charges pre-adoption work");
		assertCursor(adopted, runId, 1, FIRST_USAGE);
		assertZeroDelta(await provider.observe([runId]), runId, 1);

		await provider.publish(runId, snapshotFor(provider, await provider.snapshot(runId), 2, SECOND_USAGE));
		assertUsage(await provider.observe([runId]), DELTA_USAGE);
		assertFailure(await provider.adopt(runId), /already|baseline|adopt/i);
	});

	conformanceTest("restart and selected-branch reconstruction restore cursors without charging", async (provider) => {
		const { runId } = await provider.spawn("reconstruction");
		const original = await provider.snapshot(runId);
		await provider.publish(runId, snapshotFor(provider, original, 2, FIRST_USAGE));
		assertUsage(await provider.observe([runId]), FIRST_USAGE);

		await provider.restart();
		provider.assertRestartWasFree();
		assertZeroDelta(await provider.observe([runId]), runId, 2);

		const baselineEntry = await provider.baselineEntryId(runId);
		await provider.navigate(baselineEntry);
		const reobserved = await provider.observe([runId]);
		assertUsage(reobserved, FIRST_USAGE);
		assertCursor(reobserved, runId, 2, FIRST_USAGE);

		await provider.restart();
		provider.assertRestartWasFree();
		assertZeroDelta(await provider.observe([runId]), runId, 2);
	});

	conformanceTest("final collection returns the last delta before removal", async (provider) => {
		const { runId } = await provider.spawn("final-collection");
		await provider.prepareFinal(runId);
		const last = await provider.snapshot(runId);
		const stopped = await provider.stop(runId);
		assertUsage(stopped, last.usage);
		assert.equal(cursor(stopped, runId).final, true);
		assertNoChildElapsed(stopped);
		assert.equal(await provider.hasRun(runId), false, "records are removed only after final observation succeeds");
	});
}
