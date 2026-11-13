/**
 * Store-level regressions for cumulative budget recovery (repair batch 2).
 *
 * These cover the narrow seams real RPC cannot reach deterministically: the
 * atomicity of one budget-raising resume, validation that leaves the Goal
 * untouched, the fresh active-time segment, and an injected persistence failure
 * at the commit. Everything observable end to end (command surface, wrap-up
 * cancellation, in-flight and re-exhaustion behavior) is covered in
 * `test/goal10-budget-recovery.test.mjs` against a real Pi subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore } from "../src/store.ts";

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

/** Account ten tokens of overshoot, mark the budget limited, and persist it. */
function exhaust(store, pi, budget, alreadyAccounted) {
	assert.ok(alreadyAccounted >= budget, "the Goal must already be at or over its budget");
	account(store, 10);
	const limited = store.markBudgetLimited();
	assert.equal(limited.ok, true);
	store.flushPendingTransition(pi);
	return limited.goal;
}

test("a budget-raising resume is one atomic transition that preserves identity, history, and usage", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi, { tokenBudget: 100, origin: "tool" });
	account(store, 130);
	const limited = exhaust(store, pi, 100, 130);
	assert.equal(limited.status, "budget_limited");
	assert.equal(limited.revision, 1, "the budget stop is its own revision");
	assert.equal(limited.wrapUpPending, true);
	const snapshotsBefore = pi.entries.length;

	const resumed = store.markResumed(pi, { tokenBudget: 200, maxTokenBudget: undefined });
	assert.equal(resumed.ok, true);
	assert.equal(pi.entries.length, snapshotsBefore + 1, "exactly one durable transition");

	const snapshot = pi.entries.at(-1).data.goal;
	assert.equal(snapshot.id, goal.id, "identity preserved");
	assert.equal(snapshot.objective, goal.objective, "objective preserved");
	assert.equal(snapshot.origin, "tool", "origin preserved");
	assert.equal(snapshot.createdAt, goal.createdAt, "creation time preserved");
	assert.equal(snapshot.revision, limited.revision + 1, "revision advances exactly once");
	assert.equal(snapshot.status, "active");
	assert.equal(snapshot.tokenBudget, 200, "the new cumulative ceiling is absolute");
	assert.equal(snapshot.wrapUpPending, false, "the pending old-episode wrap-up is cancelled");
	assert.equal(snapshot.usage.totalTokens, 140, "complete usage history is preserved");
	assert.equal(store.hasPendingTransition(), false, "the resume supersedes the waiting stop");
	assert.equal(store.isBudgetExhausted(), false, "the new ceiling leaves headroom");
});

test("a budget-raising resume starts a distinct active-time segment", async () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	exhaust(store, pi, 100, 130);
	const stoppedMs = store.getUsage().activeMs;

	const resumed = store.markResumed(pi, { tokenBudget: 200 });
	assert.equal(resumed.ok, true);
	const snapshot = pi.entries.at(-1).data.goal;
	assert.equal(snapshot.usage.activeMs, stoppedMs, "the snapshot freezes the stopped segment");
	assert.ok(store.getUsage().activeMs >= stoppedMs, "the resumed segment opens from the frozen value");

	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.ok(store.getUsage().activeMs > stoppedMs, "the fresh segment accrues live active time");
});

test("a budget-raising resume refuses a ceiling at or below the accounted usage", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	const limited = exhaust(store, pi, 100, 130);
	const snapshotsBefore = pi.entries.length;

	for (const requested of [140, 130, 100]) {
		const result = store.markResumed(pi, { tokenBudget: requested });
		assert.equal(result.ok, false, `${requested} must be refused`);
		assert.equal(result.reason, "not-eligible");
		assert.match(result.message, /strictly greater than/);
	}

	assert.equal(pi.entries.length, snapshotsBefore, "a refused resume writes nothing");
	const current = store.get();
	assert.equal(current.status, "budget_limited", "still budget_limited");
	assert.equal(current.tokenBudget, 100, "old budget kept");
	assert.equal(current.wrapUpPending, true, "old wrap-up state kept");
	assert.equal(current.revision, limited.revision, "no revision advance");
});

test("a budget-raising resume refuses invalid totals and never clamps the configured maximum", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	exhaust(store, pi, 100, 130);
	const snapshotsBefore = pi.entries.length;

	for (const requested of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = store.markResumed(pi, { tokenBudget: requested, maxTokenBudget: 500 });
		assert.equal(result.ok, false, `${requested} must be refused`);
		assert.equal(result.reason, "not-eligible");
	}

	const aboveMax = store.markResumed(pi, { tokenBudget: 501, maxTokenBudget: 500 });
	assert.equal(aboveMax.ok, false);
	assert.match(aboveMax.message, /exceeds the configured maximum of 500/);

	const atMax = store.markResumed(pi, { tokenBudget: 500, maxTokenBudget: 500 });
	assert.equal(atMax.ok, true, "a total exactly at the maximum is allowed");
	assert.equal(pi.entries.at(-1).data.goal.tokenBudget, 500, "never clamped");
	assert.equal(pi.entries.length, snapshotsBefore + 1, "only the valid resume wrote");
});

test("a bare resume of a budget_limited Goal is refused with guidance", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	exhaust(store, pi, 100, 130);
	const snapshotsBefore = pi.entries.length;

	const result = store.markResumed(pi);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "not-eligible");
	assert.match(result.message, /--budget <new-total>/);
	assert.equal(pi.entries.length, snapshotsBefore, "the refusal writes nothing");
	assert.equal(store.get().status, "budget_limited");
});

test("the budget option is refused for every non-budget_limited status", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 10);
	const snapshotsBefore = pi.entries.length;

	// active
	assert.equal(store.markResumed(pi, { tokenBudget: 200 }).reason, "not-eligible");

	// paused: the budget option is refused, the bare resume still works.
	assert.equal(store.markPaused(pi).ok, true);
	assert.equal(store.markResumed(pi, { tokenBudget: 200 }).reason, "not-eligible");
	assert.equal(store.markResumed(pi).ok, true, "the bare resume still works");

	// blocked
	store.stopGoal(pi, { status: "blocked", blocker: "a genuine blocker", turns: 0 });
	assert.equal(store.markResumed(pi, { tokenBudget: 200 }).reason, "not-eligible");
	assert.equal(store.markResumed(pi).ok, true, "the bare resume still works");

	// usage_limited
	store.stopGoal(pi, { status: "usage_limited", blocker: "a usage limit", turns: 0 });
	assert.equal(store.markResumed(pi, { tokenBudget: 200 }).reason, "not-eligible");
	assert.equal(store.markResumed(pi).ok, true, "the bare resume still works");

	// complete
	store.markComplete(pi);
	assert.equal(store.markResumed(pi, { tokenBudget: 200 }).reason, "not-eligible");

	// one pause, two stops, one completion, and three successful bare resumes.
	assert.equal(pi.entries.length, snapshotsBefore + 7);
	assert.equal(store.get().id, goal.id, "one identity throughout");
});

test("a persistence failure at the resume commit leaves the Goal budget_limited and unchanged", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	const limited = exhaust(store, pi, 100, 130);
	const snapshotsBefore = pi.entries.length;
	pi.failAfter = snapshotsBefore;

	const result = store.markResumed(pi, { tokenBudget: 200 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "persistence");
	assert.match(String(result.error), /injected append failure/);
	assert.equal(pi.entries.length, snapshotsBefore, "the failed write appended nothing");

	const current = store.get();
	assert.equal(current.status, "budget_limited", "still budget_limited");
	assert.equal(current.tokenBudget, 100, "old budget kept");
	assert.equal(current.wrapUpPending, true, "old wrap-up state kept");
	assert.equal(current.revision, limited.revision, "no revision advance");
	assert.equal(store.isWrapUpPending(), true, "the owed wrap-up is still owed");
});

test("an objective edit before a budget-raising resume has its own revision", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	exhaust(store, pi, 100, 130);

	const edited = store.editObjective(pi, "Make the full test suite pass and stay green");
	assert.equal(edited.ok, true);
	assert.equal(edited.goal.revision, 2, "the edit is one revision");
	assert.equal(edited.goal.status, "budget_limited", "the edit preserves budget_limited");
	assert.equal(edited.goal.wrapUpPending, true, "the edit does not cancel the owed wrap-up");

	const resumed = store.markResumed(pi, { tokenBudget: 200 });
	assert.equal(resumed.ok, true);
	assert.equal(resumed.goal.revision, 3, "the resume is the next revision");
	assert.equal(resumed.goal.objective, "Make the full test suite pass and stay green");
	assert.equal(resumed.goal.status, "active");
	assert.equal(resumed.goal.tokenBudget, 200);
	assert.equal(resumed.goal.wrapUpPending, false);
});

test("resumed work that immediately crosses the new ceiling exhausts it again", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 100 });
	account(store, 130);
	exhaust(store, pi, 100, 130);

	// 140 accounted, new ceiling 150: only 10 tokens of headroom.
	assert.equal(store.markResumed(pi, { tokenBudget: 150 }).ok, true);
	assert.equal(store.isBudgetExhausted(), false);

	// The resumed run's first response is already in flight and adds 30 tokens.
	store.beginGoalWork(store.get().id);
	account(store, 30);
	assert.equal(store.isBudgetExhausted(), true, "170 of 150 is exhausted");
	const limited = store.markBudgetLimited();
	assert.equal(limited.ok, true);
	assert.equal(limited.goal.status, "budget_limited");
	assert.equal(limited.goal.tokenBudget, 150, "the new episode uses the new ceiling");
	assert.equal(limited.goal.wrapUpPending, true, "the new episode earns a fresh wrap-up");
	assert.equal(limited.goal.usage.totalTokens, 170);
});
