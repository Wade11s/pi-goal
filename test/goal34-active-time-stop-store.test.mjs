/**
 * Store-level regressions for issue #34: Active elapsed time stops at every
 * transition to a non-active Lifecycle status.
 *
 * The blocked threshold in `markBlockedReport` and the `usage_limited` stop in
 * `stopGoal` are the two transitions that used to leave the clock running, so a
 * Goal that had already stopped kept billing the user for time in which no Goal
 * work ran — live, in every later snapshot and checkpoint, and across a restart.
 *
 * These are the narrow seams real RPC cannot reach deterministically: the exact
 * millisecond value the stop snapshot carries, what a *later* checkpoint and a
 * reconstruction read, and the failure path that must leave the clock running
 * because the Goal is still active. The observable end-to-end behavior (the
 * blocked transition, post-block idle time, and a restart) is covered in
 * `test/goal34-active-time-stop.test.mjs` against a real Pi subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore } from "../src/store.ts";
import { USAGE_ENTRY_TYPE } from "../src/goal.ts";

/** The one genuine condition the model reports across consecutive Goal turns. */
const BLOCKER = "the upstream release API token has not been issued yet";
/** Why the provider stopped the Goal. */
const USAGE_LIMIT = "the provider reported a usage limit for this account";

/** A Pi `Usage` report. */
function usage(input, output, extra = {}) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...extra,
	};
}

/** Minimal `ExtensionAPI` stand-in that retains what it is given, like Pi does. */
function fakePi() {
	const entries = [];
	return {
		entries,
		failAfter: undefined,
		appendEntry(customType, data) {
			if (this.failAfter !== undefined && entries.length >= this.failAfter) {
				throw new Error("injected append failure");
			}
			entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
		},
	};
}

/** Minimal `ExtensionContext` stand-in over the retained entries. */
function fakeCtx(entries) {
	return { sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/session.jsonl" } };
}

/** Short real delay, so active time accrues without any usage to refresh it. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let usageSeq = 0;

/** Create and commit an active Goal with an open Goal-owned segment. */
function startedGoal(pi, options = {}) {
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", options.origin ?? "command", {
		tokenBudget: options.tokenBudget,
	});
	store.stage(pi, goal);
	store.commit(goal);
	store.beginGoalWork(goal.id);
	return { store, goal };
}

/** Account `tokens` more Goal-owned model work. */
function account(store, tokens) {
	store.accountUsage(`model:${++usageSeq}`, usage(tokens, 0), "model");
}

/** Report the same blocker on three consecutive Goal turns, reaching the threshold. */
function reportToThreshold(store, pi) {
	const first = store.markBlockedReport(pi, { blocker: BLOCKER, turn: 1 });
	assert.equal(first.ok, true);
	assert.equal(first.thresholdMet, false, "the first report is recorded, not acted on");
	const identity = first.goal.blockedAudit?.blockerId;
	assert.match(String(identity), /^blocker_[0-9a-f]{8}$/, "the extension issued an opaque identity");
	assert.equal(store.markBlockedReport(pi, { blocker: BLOCKER, blockerId: identity, turn: 2 }).thresholdMet, false);
	const third = store.markBlockedReport(pi, { blocker: BLOCKER, blockerId: identity, turn: 3 });
	assert.equal(third.ok, true);
	assert.equal(third.thresholdMet, true, "the third consecutive report reaches the threshold");
	assert.equal(third.goal.status, "blocked");
	return third.goal;
}

/** Every durable accounting checkpoint, in append order. */
function checkpoints(pi) {
	return pi.entries.filter((entry) => entry.customType === USAGE_ENTRY_TYPE);
}

test("a Goal blocked at the audit threshold stops its active-time clock at the transition", async () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	account(store, 100);

	// The two reports before the threshold leave the Goal active, so the clock must
	// keep running: stopping it early would bill the user for less time than the
	// Goal actually worked.
	const first = store.markBlockedReport(pi, { blocker: BLOCKER, turn: 1 });
	assert.equal(first.goal.status, "active");
	const identity = first.goal.blockedAudit?.blockerId;
	const beforeSecond = store.getUsage().activeMs;
	await sleep(40);
	assert.ok(store.getUsage().activeMs > beforeSecond, "a still-active Goal keeps accruing");
	assert.equal(store.markBlockedReport(pi, { blocker: BLOCKER, blockerId: identity, turn: 2 }).goal.status, "active");
	await sleep(40);

	const blocked = store.markBlockedReport(pi, { blocker: BLOCKER, blockerId: identity, turn: 3 });
	assert.equal(blocked.ok, true);
	assert.equal(blocked.thresholdMet, true);
	const atBlock = store.getUsage().activeMs;
	const snapshot = pi.entries.at(-1).data.goal;
	assert.equal(snapshot.status, "blocked", "the stop snapshot is committed before the clock is read as frozen");
	assert.equal(snapshot.usage.activeMs, atBlock, "the stop snapshot carries the folded active time");
	assert.equal(snapshot.usage.totalTokens, 100, "exact token accounting is preserved");
	assert.equal(snapshot.revision, 3, "each counted report is its own revision");

	// The whole defect: the interval after the stop is not Goal work.
	await sleep(80);
	assert.equal(store.getUsage().activeMs, atBlock, "a blocked Goal accrues no further active time");

	// A later durable write on the same stopped Goal must not re-add the interval.
	const edited = store.editObjective(pi, "Make the full test suite pass and stay green");
	assert.equal(edited.ok, true);
	assert.equal(pi.entries.at(-1).data.goal.usage.activeMs, atBlock, "a later snapshot keeps the frozen value");
	store.flushAccounting(pi, true);
	assert.ok(checkpoints(pi).length > 0, "a later boundary still checkpoints");
	assert.equal(
		checkpoints(pi).at(-1).data.usage.activeMs,
		atBlock,
		"a later checkpoint never re-adds the blocked interval",
	);
});

test("a usage_limited stop freezes active time in the snapshot and in later checkpoints", async () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	account(store, 100);
	await sleep(40);

	const stopped = store.stopGoal(pi, { status: "usage_limited", blocker: USAGE_LIMIT, turns: 0 });
	assert.equal(stopped.ok, true);
	assert.equal(stopped.goal.status, "usage_limited");
	const atStop = store.getUsage().activeMs;
	assert.equal(pi.entries.at(-1).data.goal.usage.activeMs, atStop, "the stop snapshot carries the folded value");
	assert.equal(pi.entries.at(-1).data.goal.usage.totalTokens, 100, "exact token accounting is preserved");
	assert.equal(pi.entries.at(-1).data.goal.revision, 1, "the stop is its own revision");

	await sleep(80);
	assert.equal(store.getUsage().activeMs, atStop, "a usage-limited Goal accrues no further active time");

	store.flushAccounting(pi, true);
	assert.ok(checkpoints(pi).length > 0, "a later boundary still checkpoints");
	assert.equal(
		checkpoints(pi).at(-1).data.usage.activeMs,
		atStop,
		"a later checkpoint never re-adds the usage-limited interval",
	);
});

test("a reconstruction of a stopped branch reads the frozen active time and adds no interval", async () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	account(store, 100);
	reportToThreshold(store, pi);
	const atBlock = store.getUsage().activeMs;
	await sleep(60);

	// A fresh runtime over the same branch: the newest snapshot is the blocked one,
	// and nothing after it may be billed as active time.
	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx(pi.entries));
	const goal = reloaded.get();
	assert.equal(goal?.status, "blocked", "the stopped status survives the reload");
	assert.equal(reloaded.getUsage().activeMs, atBlock, "the reloaded clock is frozen at the stopped value");
	assert.equal(reloaded.getUsage().totalTokens, 100, "exact token accounting survives the reload");
	assert.equal(reloaded.unpersistedActiveMs(), 0, "nothing is left unpersisted for a stopped Goal");
});

test("a conservative stop blocks the same way as the audit threshold", async () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	account(store, 100);
	await sleep(40);

	const stopped = store.stopGoal(pi, { status: "blocked", blocker: BLOCKER, turns: 3 });
	assert.equal(stopped.ok, true);
	const atStop = store.getUsage().activeMs;
	await sleep(80);
	assert.equal(store.getUsage().activeMs, atStop, "a conservatively stopped Goal accrues no further active time");
	assert.equal(pi.entries.at(-1).data.goal.usage.activeMs, atStop);
});

test("a failed stop leaves the Goal active and its clock running", async () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	account(store, 100);
	const first = store.markBlockedReport(pi, { blocker: BLOCKER, turn: 1 });
	const identity = first.goal.blockedAudit?.blockerId;
	assert.equal(store.markBlockedReport(pi, { blocker: BLOCKER, blockerId: identity, turn: 2 }).thresholdMet, false);

	pi.failAfter = pi.entries.length;
	const failed = store.markBlockedReport(pi, { blocker: BLOCKER, blockerId: identity, turn: 3 });
	assert.equal(failed.ok, false);
	assert.equal(failed.reason, "persistence", "a write failure is reported as persistence");
	assert.equal(store.get()?.status, "active", "the Goal is still active, so nothing was stopped");
	const before = store.getUsage().activeMs;
	await sleep(40);
	assert.ok(store.getUsage().activeMs > before, "the clock keeps running while the Goal is still active");

	pi.failAfter = pi.entries.length;
	const limited = store.stopGoal(pi, { status: "usage_limited", blocker: USAGE_LIMIT, turns: 0 });
	assert.equal(limited.ok, false);
	assert.equal(limited.reason, "persistence");
	assert.equal(store.get()?.status, "active");
	const beforeLimit = store.getUsage().activeMs;
	await sleep(40);
	assert.ok(store.getUsage().activeMs > beforeLimit, "and it keeps running after a failed usage-limited stop too");
});
