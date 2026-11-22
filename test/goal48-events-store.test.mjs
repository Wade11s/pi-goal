/**
 * Store-level regressions for the Goal-updated event stream (issue #48).
 *
 * These cover the narrow seams a real-Pi RPC test cannot reach
 * deterministically: an injected append failure at the durable commit must
 * leave the event stream silent, the in-memory budget stop must announce
 * nothing until its durable flush, audit bookkeeping (below-threshold reports,
 * resets, wrap-up disarm) must stay off the stream, and an observer that throws
 * must never change or fail the committed transition underneath. Everything
 * observable end to end (payload, ordering, coverage, listener failures) is
 * covered in `test/goal48-events.test.mjs` against a real Pi subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore } from "../src/store.ts";

/** A Pi `Usage` report. */
function usage(input, output) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Minimal `ExtensionAPI` stand-in that retains what it is given, like Pi does. */
function fakePi() {
	const entries = [];
	return {
		entries,
		failNext: 0,
		appendEntry(customType, data) {
			if (this.failNext > 0) {
				this.failNext -= 1;
				throw new Error("injected append failure");
			}
			entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
		},
	};
}

/** A store that records every announced transition. */
function observedStore() {
	const events = [];
	const store = new GoalStore({
		onDurableTransition: (kind, goal, committedAt) => {
			events.push({ kind, id: goal.id, revision: goal.revision, committedAt });
		},
	});
	return { store, events };
}

/** Kinds announced so far, in order. */
function kinds(events) {
	return events.map((e) => e.kind);
}

/** Create and commit an active Goal with an open Goal-owned segment. */
function startedGoal(pi, options = {}) {
	const { store, events } = observedStore();
	const goal = store.create("Make the full test suite pass", "command", {
		tokenBudget: options.tokenBudget,
	});
	store.stage(pi, goal);
	store.commit(goal);
	store.beginGoalWork(goal.id);
	return { store, events, goal };
}

test("a committed creation and replacement are announced by the commit itself", () => {
	const pi = fakePi();
	const { store, events } = observedStore();
	const first = store.create("First objective");
	store.stage(pi, first);
	store.commit(first);
	assert.deepEqual(kinds(events), ["created"]);
	assert.equal(events[0].id, first.id);
	assert.equal(events[0].revision, 0);

	const second = store.create("Second objective");
	store.preserveSupersededForReplacement(pi);
	store.stage(pi, second);
	store.commit(second);
	assert.deepEqual(kinds(events), ["created", "replaced"]);
	assert.equal(events[1].id, second.id, "the replacement event names the new identity");
});

test("a staged creation whose append fails is abandoned with no event", () => {
	const pi = fakePi();
	const { store, events } = observedStore();
	const goal = store.create("Objective that never lands");
	pi.failNext = 1;
	assert.throws(() => store.stage(pi, goal), /injected append failure/);
	// Nothing was committed, so nothing may be announced — not even after the
	// command retracts its in-memory state with rollback.
	store.rollback(pi);
	assert.deepEqual(kinds(events), []);
});

test("every refused, stale, or failed lifecycle mutation stays silent", () => {
	const pi = fakePi();
	const { store, events, goal } = startedGoal(pi);

	// Refusals: nothing to mutate, nothing to announce.
	assert.equal(store.markPaused(pi, { id: goal.id, revision: 99 }).ok, false, "stale binding refused");
	assert.equal(
		store.markResumed(pi, { tokenBudget: 10 }).ok,
		false,
		"a budget raise only resumes a budget_limited Goal",
	);

	// Failed writes: the append throws, the mutation fails, no event.
	pi.failNext = 1;
	assert.equal(store.markComplete(pi).ok, false);
	assert.deepEqual(kinds(events), ["created"]);

	pi.failNext = 1;
	assert.equal(store.markPaused(pi).ok, false);
	assert.deepEqual(kinds(events), ["created"]);

	pi.failNext = 1;
	assert.equal(store.editObjective(pi, "A new objective").ok, false);
	assert.deepEqual(kinds(events), ["created"]);

	pi.failNext = 1;
	assert.equal(store.stopGoal(pi, { status: "blocked", blocker: "shell is gone" }).ok, false);
	assert.deepEqual(kinds(events), ["created"]);

	// A failed clear leaves the Goal in place and announces nothing.
	pi.failNext = 1;
	assert.equal(store.clear(pi).ok, false);
	assert.deepEqual(kinds(events), ["created"]);
	assert.ok(store.get(), "the Goal survived the failed clear");
});

test("an observer that throws cannot change or fail the committed transition", () => {
	const pi = fakePi();
	const events = [];
	const store = new GoalStore({
		onDurableTransition: () => {
			throw new Error("listener exploded");
		},
	});
	const goal = store.create("Survive the listener");
	store.stage(pi, goal);
	store.commit(goal); // must not throw through the observer's failure
	assert.ok(store.get());

	const paused = store.markPaused(pi);
	assert.equal(paused.ok, true, "the pause committed despite the throwing observer");
	assert.equal(paused.goal.status, "paused");
});

test("the budget stop announces nothing in memory and exactly once at its durable flush", () => {
	const pi = fakePi();
	const { store, events, goal } = startedGoal(pi, { tokenBudget: 100 });
	store.accountUsage("model:1", usage(90, 20), "model");
	assert.equal(store.markBudgetLimited().ok, true);
	assert.deepEqual(kinds(events), ["created"], "the in-memory stop is not durable yet");

	assert.equal(store.flushPendingTransition(pi), true);
	assert.deepEqual(kinds(events), ["created", "budget-limited"]);
	assert.equal(events[1].revision, goal.revision + 1);

	// The flush is one-shot: no boundary may announce it a second time.
	assert.equal(store.flushPendingTransition(pi), false);
	assert.equal(store.flushAccounting(pi, true), undefined);
	assert.deepEqual(kinds(events), ["created", "budget-limited"]);

	// A forced checkpoint at shutdown is accounting, not a transition: it wrote a
	// durable `goal-usage` entry and still emitted nothing.
	assert.ok(
		pi.entries.some((e) => e.customType === "goal-usage"),
		"accounting kept writing durable checkpoints",
	);
	assert.deepEqual(kinds(events), ["created", "budget-limited"]);
});

test("a budget flush whose append fails announces nothing and retries at the next boundary", () => {
	const pi = fakePi();
	const { store, events } = startedGoal(pi, { tokenBudget: 100 });
	store.accountUsage("model:1", usage(90, 20), "model");
	store.markBudgetLimited();

	pi.failNext = 1;
	assert.throws(() => store.flushPendingTransition(pi), /injected append failure/);
	assert.deepEqual(kinds(events), ["created"], "nothing durable was written, so nothing was announced");

	assert.equal(store.flushPendingTransition(pi), true);
	assert.deepEqual(kinds(events), ["created", "budget-limited"]);
});

test("below-threshold reports, audit resets, and wrap-up disarm stay off the stream", () => {
	const pi = fakePi();
	const { store, events, goal } = startedGoal(pi, { tokenBudget: 100 });
	store.accountUsage("model:1", usage(90, 20), "model");
	store.markBudgetLimited();
	store.flushPendingTransition(pi);

	// The wrap-up is delivered: wrapUpPending is cleared durably, no event.
	assert.equal(store.consumeWrapUp(pi).ok, true);
	assert.deepEqual(kinds(events), ["created", "budget-limited"]);

	// A fresh chain on the resumed Goal: two below-threshold reports that pass
	// the issued identity back (the same condition), no events.
	store.markResumed(pi, { tokenBudget: 500 });
	assert.deepEqual(kinds(events), ["created", "budget-limited", "budget-recovered"]);
	const first = store.markBlockedReport(pi, { blocker: "waiting on upstream", turn: 1 });
	assert.equal(first.ok, true);
	const identity = first.goal.blockedAudit.blockerId;
	assert.equal(
		store.markBlockedReport(pi, { blocker: "waiting on upstream", blockerId: identity, turn: 2 }).ok,
		true,
	);
	assert.deepEqual(kinds(events), ["created", "budget-limited", "budget-recovered"]);

	// A user action resets the audit: durable, but bookkeeping rather than a
	// lifecycle transition.
	assert.deepEqual(store.resetBlockedAudit(pi), { ok: true, reset: true });
	assert.deepEqual(kinds(events), ["created", "budget-limited", "budget-recovered"]);

	// The threshold itself is the transition, and it announces exactly once. A
	// reset means a fresh chain, so the third consecutive report of the new chain
	// is the one that stops the Goal.
	const chain1 = store.markBlockedReport(pi, { blocker: "waiting on upstream", turn: 3 });
	assert.equal(chain1.ok, true);
	const freshIdentity = chain1.goal.blockedAudit.blockerId;
	assert.equal(
		store.markBlockedReport(pi, { blocker: "waiting on upstream", blockerId: freshIdentity, turn: 4 }).ok,
		true,
	);
	assert.deepEqual(kinds(events), ["created", "budget-limited", "budget-recovered"]);
	assert.equal(
		store.markBlockedReport(pi, { blocker: "waiting on upstream", blockerId: freshIdentity, turn: 5 }).ok,
		true,
	);
	assert.deepEqual(kinds(events), ["created", "budget-limited", "budget-recovered", "blocked"]);
	assert.equal(events[3].id, goal.id);
});

test("a failed threshold report announces nothing", () => {
	const pi = fakePi();
	const { store, events } = startedGoal(pi);
	assert.equal(store.markBlockedReport(pi, { blocker: "waiting on upstream", turn: 1 }).ok, true);
	assert.equal(store.markBlockedReport(pi, { blocker: "waiting on upstream", turn: 2 }).ok, true);
	pi.failNext = 1;
	const failed = store.markBlockedReport(pi, { blocker: "waiting on upstream", turn: 3 });
	assert.equal(failed.ok, false);
	assert.deepEqual(kinds(events), ["created"]);
});

test("a clear announces the cleared record's identity, not a new current Goal", () => {
	const pi = fakePi();
	const { store, events, goal } = startedGoal(pi);
	const paused = store.markPaused(pi);
	assert.equal(paused.ok, true);

	assert.equal(store.clear(pi).ok, true);
	assert.deepEqual(kinds(events), ["created", "paused", "cleared"]);
	const cleared = events[2];
	assert.equal(cleared.id, goal.id);
	assert.equal(cleared.revision, paused.goal.revision, "the revision the Goal had when cleared");
	assert.equal(store.get(), null, "no current Goal was invented");
});

test("rollback and restore are retractions, not transitions: neither announces", () => {
	const pi = fakePi();
	const { store, events, goal } = startedGoal(pi);

	// A retraction of a creation that could not be confirmed durable.
	store.rollback(pi);
	assert.deepEqual(kinds(events), ["created"], "the creation announced its commit; the retraction is silent");

	// A restore rewrites the previous record durably after a retracted
	// replacement; it corrects history rather than deciding lifecycle.
	const { store: fresh, events: freshEvents, goal: first } = startedGoal(pi);
	const second = fresh.create("The replacement that failed its durability gate");
	fresh.preserveSupersededForReplacement(pi);
	fresh.stage(pi, second);
	fresh.commit(second);
	assert.deepEqual(kinds(freshEvents), ["created", "replaced"]);
	assert.equal(fresh.restore(pi, first).ok, true);
	assert.deepEqual(kinds(freshEvents), ["created", "replaced"]);
	assert.equal(fresh.get().id, first.id);
	assert.equal(store.get(), null);
	assert.ok(goal.id);
});
