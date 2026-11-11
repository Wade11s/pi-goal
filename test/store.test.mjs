/**
 * Store-level regression tests for the durability boundaries.
 *
 * These use a fake Pi API and session manager that reproduce Pi's object-retention
 * semantics: `appendEntry` keeps the object it is handed, and `getBranch()` returns
 * exactly those objects. That is the property that makes the ordering below fail —
 * an RPC test that only exercises a *runtime replacement* does not, because a new
 * process re-parses the session file and never sees the polluted object.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore } from "../src/store.ts";
import { USAGE_ENTRY_TYPE } from "../src/goal.ts";

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
		appended: [],
		appendEntry(customType, data) {
			this.appended.push({ customType, data });
			entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
		},
	};
}

/** Minimal `ExtensionContext` stand-in over the retained entries. */
function fakeCtx(entries) {
	return { sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/session.jsonl" } };
}

/** An assistant message entry with usage, as the session manager would persist it. */
function assistantEntry(index, usageReport) {
	return {
		type: "message",
		id: `msg-${index}`,
		message: { role: "assistant", usage: usageReport },
	};
}

/** Short real delay, so active time accrues without any usage to refresh it. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tool result entry carrying reported nested usage, as Pi persists it. */
function toolResultEntry(toolCallId, usageReport) {
	return {
		type: "message",
		id: `tool-${toolCallId}`,
		message: { role: "toolResult", toolCallId, usage: usageReport },
	};
}

/** The accounted contribution of one nested model call: 40 + 7 + 3. */
function nested() {
	return usage(40, 7, { cacheWrite: 3 });
}

test("staging and committing never alias the object the session manager keeps", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");

	store.stage(pi, goal);
	store.commit(goal);
	store.accountUsage("model:1", usage(100, 10), "model");

	// The appended snapshot is durable state: it must still read as created, not as
	// currently accounted.
	assert.equal(pi.entries[0].data.goal.usage.totalTokens, 0, "the durable snapshot is not polluted");
	// The live record does carry the live view.
	assert.equal(store.get()?.usage?.totalTokens, 110);
});

test("a same-process reconstruction after live accounting charges each entry once", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);
	store.accountUsage("model:1", usage(100, 10), "model");

	// Same-process branch reconstruction (runtime replacement, tree navigation): the
	// baseline is the creation snapshot, and the branch is replayed after it. If the
	// live record aliased the appended snapshot, the baseline would already hold the
	// live totals and the replay would charge them a second time (220 instead of 110).
	const branch = [...pi.entries, assistantEntry(0, usage(100, 10))];
	store.reconstruct(fakeCtx(branch));

	assert.equal(store.getUsage().totalTokens, 110, "the replay converges on the live total");
	assert.equal(pi.entries[0].data.goal.usage.totalTokens, 0, "and the snapshot stayed clean");
});

test("a transition is immediate in memory and durable only at a safe boundary", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = { ...store.create("Make the full test suite pass", "command"), tokenBudget: 100 };
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	assert.equal(store.isBudgetExhausted(), true);

	// The transition happens in memory at once, so enforcement and status are
	// immediate, but nothing is written: Pi appends the message that triggered it
	// *after* dispatching message_end, so a snapshot here would sit ahead of it.
	const limited = store.markBudgetLimited();
	assert.equal(limited.ok, true);
	assert.equal(store.get()?.status, "budget_limited");
	assert.equal(store.hasPendingTransition(), true);
	assert.equal(pi.entries.length, 1, "nothing durable yet");

	// The boundary writes it, now that the triggering entry is on the branch.
	store.flushAccounting(pi);
	assert.equal(pi.entries.length, 2);
	const appended = pi.entries.at(-1).data.goal;
	assert.equal(appended.status, "budget_limited");
	assert.equal(appended.usage.totalTokens, 110);
	assert.equal(store.hasPendingTransition(), false);

	// Later accounting (the wrap-up run, ordinary runs) must not reach into the
	// object that was just appended, or a reconstruction would read a polluted
	// baseline and double-charge the replay.
	store.accountUsage("model:2", usage(50, 5), "model");
	store.accountUsage("model:3", usage(20, 2), "model");
	assert.equal(store.get()?.usage?.totalTokens, 187, "the live view keeps growing");
	assert.equal(appended.usage.totalTokens, 110, "the durable snapshot is frozen");
	assert.equal(pi.entries.at(-1).data.goal, appended, "the appended object is the one inspected");
});

test("a deferred budget snapshot carries the usage accounted before the flush", () => {
	// The crossing turn keeps charging after the transition: a concurrent nested tool
	// result was already in flight when the budget was crossed, and the response that
	// follows it is charged too. The transition is only made durable at a later
	// boundary, and a snapshot that kept the totals frozen at the transition would
	// omit both — and because the snapshot is the replay baseline, reconstruction
	// could never recover them.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = { ...store.create("Make the full test suite pass", "command"), tokenBudget: 150 };
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(110, 10), "model");
	// The first concurrent nested result crosses the 150-token budget.
	store.accountUsage("toolResult:call_1", nested(), "nested");
	assert.equal(store.getUsage().totalTokens, 170);
	assert.equal(store.markBudgetLimited().ok, true);
	assert.equal(store.hasPendingTransition(), true);
	assert.equal(pi.entries.length, 1, "nothing is written at the transition itself");

	// The second concurrent result was already running, so it lands before the
	// boundary, and so does the response that follows.
	store.accountUsage("toolResult:call_2", nested(), "nested");
	store.accountUsage("model:2", usage(10, 5), "model");
	assert.equal(store.getUsage().totalTokens, 235, "the live ledger has every report");

	// The boundary writes the transition with the usage already on the branch.
	store.flushAccounting(pi);
	const appended = pi.entries.at(-1).data.goal;
	assert.equal(appended.status, "budget_limited");
	assert.equal(appended.usage.totalTokens, 235, "the durable snapshot covers every report so far");
	assert.equal(appended.usage.nestedTokens, 100, "both nested results are inside it");

	// The production ordering: the messages are appended before the snapshot that
	// covers them, and the failed response is the last one.
	const branch = [
		pi.entries[0],
		assistantEntry(0, usage(110, 10)),
		toolResultEntry("call_1", nested()),
		toolResultEntry("call_2", nested()),
		assistantEntry(1, usage(10, 5)),
		pi.entries[1],
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.getUsage().totalTokens, 235, "restoration converges on the live total");
	assert.equal(store.get()?.status, "budget_limited");
});

test("a deferred transition is written after the entry it covers", () => {
	// The production ordering: the ledger is charged at message_end, the message is
	// appended by Pi afterwards, and only then is the transition made durable. A
	// reconstruction must converge on the live total.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = { ...store.create("Make the full test suite pass", "command"), tokenBudget: 100 };
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	assert.equal(store.markBudgetLimited().ok, true);
	// Pi appends the triggering assistant message after the handler returned.
	const branch = [...pi.entries, assistantEntry(0, usage(100, 10))];
	store.flushAccounting(pi);
	const withTransition = [...branch, ...pi.entries.slice(1)];

	store.reconstruct(fakeCtx(withTransition));
	assert.equal(store.getUsage().totalTokens, 110, "the transition baseline covers the crossing message");
	assert.equal(store.get()?.status, "budget_limited");
});

test("reconstruction after a completion ignores post-completion responses", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	const completed = store.markComplete(pi);
	assert.equal(completed.ok, true);

	// The completing tool result and the ordinary response that follows it are not
	// Goal work. An unclean restart must not reclassify them as usage.
	const branch = [
		...pi.entries,
		{ type: "message", id: "tool-1", message: { role: "toolResult", toolCallId: "call_1", usage: usage(5, 1) } },
		assistantEntry(0, usage(30, 5)),
	];
	store.reconstruct(fakeCtx(branch));

	assert.equal(store.getUsage().totalTokens, 110, "post-completion responses are excluded");
	assert.equal(store.get()?.status, "complete");
});

test("the completing batch's tool results are excluded by both paths", () => {
	// A tool result appended *after* the completion snapshot is outside the replay
	// baseline, so the live path must skip it too: live accounting and reconstruction
	// have to draw the same line.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	assert.equal(store.markComplete(pi).ok, true);
	// The completing tool result carries nested usage and is appended after the
	// completion snapshot.
	store.accountUsage("toolResult:call_1", usage(40, 7), "nested");
	assert.equal(store.getUsage().totalTokens, 110, "the live path skips it");

	const branch = [
		...pi.entries,
		{ type: "message", id: "tool-1", message: { role: "toolResult", toolCallId: "call_1", usage: usage(40, 7) } },
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.getUsage().totalTokens, 110, "and so does the replay");
});

test("reconstruction after budget exhaustion still accounts later Goal work", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = { ...store.create("Make the full test suite pass", "command"), tokenBudget: 100 };
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	assert.equal(store.markBudgetLimited().ok, true);
	const wrapUpDelivered = store.consumeWrapUp(pi);
	assert.equal(wrapUpDelivered.ok, true);

	// `budget_limited` is not terminal for accounting: the wrap-up run and later runs
	// are still charged, and the replay must agree with the live path.
	const branch = [...pi.entries, assistantEntry(0, usage(10, 5)), assistantEntry(1, usage(20, 2))];
	store.reconstruct(fakeCtx(branch));

	assert.equal(store.getUsage().totalTokens, 147, "110 + the wrap-up run + the later run");
	assert.equal(store.get()?.status, "budget_limited");
});

test("an accounting checkpoint becomes the replay baseline", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	const checkpoint = store.checkpointAccounting(pi);
	assert.ok(checkpoint);
	assert.equal(pi.appended.at(-1).customType, USAGE_ENTRY_TYPE);
	assert.equal(checkpoint.usage.totalTokens, 110);

	store.accountUsage("model:2", usage(20, 2), "model");
	assert.equal(store.getUsage().totalTokens, 132);

	// Everything after the checkpoint is replayed; everything before it is already
	// inside the checkpoint's totals.
	const branch = [...pi.entries, assistantEntry(0, usage(20, 2))];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.getUsage().totalTokens, 132, "the checkpoint plus the replay");
});

test("a tombstone clears the Goal and its accounting baseline", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);
	store.accountUsage("model:1", usage(100, 10), "model");

	store.rollback(pi);
	assert.equal(store.get(), null);

	store.reconstruct(fakeCtx([...pi.entries, assistantEntry(0, usage(30, 5))]));
	assert.equal(store.get(), null, "a cleared Goal is not resurrected by later entries");
	assert.equal(store.getUsage().totalTokens, 0, "and no usage is charged without a Goal");
});

test("every durable lifecycle transition carries the live accounting view", async () => {
	// The lifecycle milestone writes its transitions durably before they are
	// visible. Accounting rides along: a snapshot that carried only the totals the
	// transition was decided with would omit usage accounted since, and — because a
	// snapshot is the replay baseline — that usage could never be recovered.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(100, 10), "model");
	store.accountUsage("model:2", usage(30, 5), "model");

	// Active time keeps accruing with no usage to refresh the record's stored view, so
	// by the time the transition runs that view is stale. A snapshot that wrote the
	// record's own usage would lose the interval; re-reading the clock does not.
	const staleMs = store.getUsage().activeMs;
	await sleep(30);

	const paused = store.markPaused(pi);
	assert.equal(paused.ok, true);
	assert.equal(pi.entries.at(-1).data.goal.usage.totalTokens, 145, "the pause snapshot carries the live total");
	assert.equal(pi.entries.at(-1).data.goal.status, "paused");
	assert.ok(
		pi.entries.at(-1).data.goal.usage.activeMs > staleMs,
		`the snapshot re-read the clock at write time (${pi.entries.at(-1).data.goal.usage.activeMs} <= ${staleMs})`,
	);
	assert.equal(store.get()?.usage?.totalTokens, 145);

	const resumed = store.markResumed(pi);
	assert.equal(resumed.ok, true);
	assert.equal(pi.entries.at(-1).data.goal.usage.totalTokens, 145, "and so does the resume snapshot");

	store.accountUsage("model:3", usage(20, 2), "model");
	const edited = store.editObjective(pi, "Make the full test suite pass and stay green");
	assert.equal(edited.ok, true);
	assert.equal(pi.entries.at(-1).data.goal.usage.totalTokens, 167, "an edit preserves the accounted usage");
	assert.equal(pi.entries.at(-1).data.goal.objective, "Make the full test suite pass and stay green");

	// Replay converges on the live total: nothing is lost, nothing is charged twice.
	// The branch order is the production one — each snapshot sits after the entries
	// it already covers.
	const branch = [
		pi.entries[0],
		assistantEntry(0, usage(100, 10)),
		assistantEntry(1, usage(30, 5)),
		pi.entries[1],
		assistantEntry(2, usage(20, 2)),
		pi.entries[2],
		pi.entries[3],
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.getUsage().totalTokens, 167, "the replay agrees with the live path");
});

test("a paused Goal accrues no active time, and a resumed one starts again", async () => {
	// Paused time must not accrue: the lifecycle milestone's pause has to stop the
	// active-time clock exactly like a terminal status does, and resume has to
	// restart it. Without that, an edit-pause-resume cycle would bill the user for
	// time in which no Goal work ran at all.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);
	store.accountUsage("model:1", usage(100, 10), "model");

	assert.equal(store.markPaused(pi).ok, true);
	const atPause = store.getUsage().activeMs;
	await sleep(60);
	assert.equal(store.getUsage().activeMs, atPause, "a paused Goal's clock is stopped");

	assert.equal(store.markResumed(pi).ok, true);
	await sleep(40);
	assert.ok(store.getUsage().activeMs > atPause, "a resumed Goal's clock runs again");

	// Pausing again freezes it at the new value rather than accruing further.
	const afterResume = store.getUsage().activeMs;
	assert.equal(store.markPaused(pi).ok, true);
	const atSecondPause = store.getUsage().activeMs;
	await sleep(40);
	assert.equal(store.getUsage().activeMs, atSecondPause, "and pausing again stops it");
	assert.ok(Math.abs(atSecondPause - afterResume) <= 1, "the freeze keeps the accounted value");

	// The frozen value is what a reconstruction restores, so a restart cannot invent
	// the paused interval either.
	store.reconstruct(fakeCtx(pi.entries));
	assert.ok(
		Math.abs(store.getUsage().activeMs - afterResume) <= 1,
		`a restored paused Goal keeps the frozen value (${store.getUsage().activeMs} vs ${afterResume})`,
	);
	assert.equal(store.get()?.status, "paused");
	assert.equal(store.getUsage().activeMs, atSecondPause, "and it is the paused value, not a resumed one");
});

test("a durable transition supersedes a budget transition still waiting to be written", () => {
	// The budget transition is made in memory at the crossing and written at the next
	// post-persistence boundary. A lifecycle transition that lands in between writes
	// durably *now*, so it must supersede the waiting one: otherwise a later flush
	// would resurrect the pre-edit record (old objective, older totals) over the
	// newer durable state.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = { ...store.create("Make the full test suite pass", "command"), tokenBudget: 150 };
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(110, 10), "model");
	store.accountUsage("toolResult:call_1", nested(), "nested");
	assert.equal(store.markBudgetLimited().ok, true);
	assert.equal(store.hasPendingTransition(), true);

	// The user edits the objective before the boundary that would have written the
	// transition. The edit is allowed for any status that is not complete.
	store.accountUsage("toolResult:call_2", nested(), "nested");
	const edited = store.editObjective(pi, "Make the full test suite pass and document it");
	assert.equal(edited.ok, true);
	assert.equal(store.hasPendingTransition(), false, "the newer durable snapshot supersedes it");

	const appended = pi.entries.at(-1).data.goal;
	assert.equal(appended.status, "budget_limited");
	assert.equal(appended.objective, "Make the full test suite pass and document it");
	assert.equal(appended.usage.totalTokens, 220, "both concurrent nested results are inside it");
	assert.equal(appended.wrapUpPending, true, "the wrap-up is still owed");

	// A boundary flush now has nothing waiting, so it must not write a stale record.
	store.flushAccounting(pi);
	assert.equal(pi.entries.length, 2, "creation and the edit — no stale transition snapshot");
	assert.equal(pi.entries.at(-1).data.goal.objective, "Make the full test suite pass and document it");

	const branch = [
		pi.entries[0],
		assistantEntry(0, usage(110, 10)),
		toolResultEntry("call_1", nested()),
		toolResultEntry("call_2", nested()),
		pi.entries[1],
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.getUsage().totalTokens, 220, "restoration converges on the live total");
	assert.equal(store.get()?.objective, "Make the full test suite pass and document it");
});

test("a budget-limited Goal cannot be completed, and clearing it drops the accounting", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = { ...store.create("Make the full test suite pass", "command"), tokenBudget: 150 };
	store.stage(pi, goal);
	store.commit(goal);

	store.accountUsage("model:1", usage(110, 10), "model");
	store.accountUsage("toolResult:call_1", nested(), "nested");
	assert.equal(store.markBudgetLimited().ok, true);

	// Budget exhaustion is never completion, and the lifecycle milestone's refusal
	// path is what enforces it now.
	const completed = store.markComplete(pi);
	assert.equal(completed.ok, false);
	if (!completed.ok) {
		assert.equal(completed.reason, "not-eligible");
		assert.match(completed.message, /only an active Goal can be completed \(current status: budget_limited\)/);
	}
	assert.equal(store.isWrapUpPending(), true, "and the wrap-up is still owed");

	const cleared = store.clear(pi);
	assert.equal(cleared.ok, true);
	assert.equal(cleared.goal, null);
	assert.equal(store.get(), null);
	assert.equal(store.getUsage().totalTokens, 0, "a cleared Goal carries no accounting");
	assert.equal(store.hasPendingTransition(), false, "and no transition is still waiting");
});

test("the two public accounting views agree, live time included", async () => {
	// `getUsage()` and the record `get()` publishes are two views of one state, so a
	// caller must never see them disagree. The ledger carries tokens only, so the
	// active time has to come from the clock in both.
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Make the full test suite pass", "command");
	store.stage(pi, goal);
	store.commit(goal);
	store.accountUsage("model:1", usage(100, 10), "model");
	// A delay with no accounting: only a view that reads the clock can see this time.
	await sleep(60);

	const record = store.get();
	assert.ok(record != null, "a Goal is present");
	const viaRecord = record.usage;
	assert.ok(viaRecord != null, "the record carries an accounting view");
	const viaGetter = store.getUsage();
	assert.equal(viaGetter.totalTokens, 110);
	assert.ok(viaRecord.activeMs >= 50, `the record carries the live active time (${viaRecord.activeMs})`);
	assert.ok(viaGetter.activeMs >= 50, `and so does the getter (${viaGetter.activeMs})`);
	assert.ok(
		Math.abs(viaGetter.activeMs - viaRecord.activeMs) < 25,
		`the two views agree on the live active time (${viaGetter.activeMs} vs ${viaRecord.activeMs})`,
	);
});
