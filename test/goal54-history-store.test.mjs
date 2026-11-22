/**
 * Store-level regressions for the non-authoritative durable Goal audit history
 * (issue #54).
 *
 * The narrow seams a real-Pi RPC test cannot reach deterministically live here:
 * the exact interleaving of a `goal-history` entry with the `goal-state` entry it
 * describes, silence for every refused/failed/rolled-back path, a history append
 * that fails (the crash gap between the lifecycle commit and the append), and
 * reconstruction over a branch whose history is missing, truncated, or malformed.
 *
 * The observer wiring reproduced here is the extension's own — project the
 * committed transition into the event payload, then derive the history record from
 * that payload — so the store tests assert the projection contract while
 * `test/goal54-history.test.mjs` asserts the same thing against a real Pi process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalStore } from "../src/store.ts";
import { CUSTOM_ENTRY_TYPE, GOAL_STATUSES, toPublicState } from "../src/goal.ts";
import { GOAL_TRANSITION_KINDS, toGoalUpdatedEvent } from "../src/events.ts";
import {
	formatGoalHistory,
	HISTORY_ENTRY_TYPE,
	isGoalHistoryRecord,
	readGoalHistory,
	toGoalHistoryRecord,
} from "../src/history.ts";

/** A Pi `Usage` report. */
function usage(input, output, extra = {}) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheWrite: 0, total: 0 },
		...extra,
	};
}

/** Minimal `ExtensionAPI` stand-in that retains what it is given, like Pi does. */
function fakePi() {
	const entries = [];
	return {
		entries,
		failNext: 0,
		/** When set, every append of this custom type fails (the injected crash gap). */
		failType: null,
		appendEntry(customType, data) {
			if (this.failType === customType) {
				throw new Error(`injected append failure for ${customType}`);
			}
			if (this.failNext > 0) {
				this.failNext -= 1;
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

/** Every `goal-history` entry appended so far, in append order. */
function historyEntries(pi) {
	return pi.entries.filter((entry) => entry.customType === HISTORY_ENTRY_TYPE);
}

/** Every history record appended so far, in append order. */
function historyRecords(pi) {
	return historyEntries(pi).map((entry) => entry.data);
}

/** The transition kinds the history recorded, in order. */
function historyKinds(pi) {
	return historyRecords(pi).map((record) => record.kind);
}

/**
 * A store wired exactly like the extension: the committed-transition observer
 * projects the event payload and derives the history record from it.
 */
function historyStore(pi) {
	const events = [];
	const store = new GoalStore({
		onDurableTransition: (kind, goal, committedAt, previous) => {
			const event = toGoalUpdatedEvent(kind, goal, committedAt);
			events.push(event);
			pi.appendEntry(HISTORY_ENTRY_TYPE, toGoalHistoryRecord(event, previous?.status ?? null));
		},
	});
	return { store, events };
}

/** Create, commit, and open a Goal-owned segment. */
function startedGoal(pi, options = {}) {
	const { store, events } = historyStore(pi);
	const goal = store.create("Make the audit history trustworthy", "command", {
		tokenBudget: options.tokenBudget,
	});
	// The manifest is set on the record exactly as the /goal command does after
	// materializing the artifacts, before the snapshot commits.
	if (options.attachments) goal.attachments = options.attachments;
	store.stage(pi, goal);
	store.commit(goal);
	store.beginGoalWork(goal.id);
	return { store, events, goal };
}

test("every committed transition appends exactly one history record after its snapshot", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi);

	assert.equal(store.markPaused(pi).ok, true);
	assert.equal(store.editObjective(pi, "A refined objective for the timeline").ok, true);
	assert.equal(store.markResumed(pi).ok, true);
	assert.equal(store.markComplete(pi).ok, true);
	assert.equal(store.clear(pi).ok, true);

	assert.deepEqual(historyKinds(pi), [
		"created",
		"paused",
		"objective-edited",
		"resumed",
		"completed",
		"cleared",
	]);
	assert.equal(historyEntries(pi).length, 6, "one record per transition, never more");

	// Each record is appended immediately after the `goal-state` entry it describes,
	// so the timeline interleaves with the authoritative log in commit order.
	const goalStateIndexes = pi.entries
		.map((entry, index) => (entry.customType === CUSTOM_ENTRY_TYPE ? index : -1))
		.filter((index) => index !== -1);
	const historyIndexes = historyEntries(pi).map((entry) => pi.entries.indexOf(entry));
	for (const [position, index] of historyIndexes.entries()) {
		assert.equal(index, goalStateIndexes[position] + 1, `record ${position} follows its snapshot`);
	}
	assert.equal(goalStateIndexes.length, 6, "one snapshot per transition, and no extra ones");
	assert.equal(goal.id, historyRecords(pi)[0].goalId);
});

test("a history record carries the committed identity, revision, statuses, timestamp, usage, and manifest hashes", () => {
	const pi = fakePi();
	const manifest = [
		{ hash: "a".repeat(64), mediaType: "text/plain", bytes: 2048, label: "spec.md" },
		{ hash: "b".repeat(64), mediaType: "image/png", bytes: 90_112, label: "diagram.png" },
	];
	const { store, goal } = startedGoal(pi, { attachments: manifest });
	store.accountUsage("model:1", usage(400, 100, { cacheRead: 30, cacheWrite: 20 }), "model");
	assert.equal(store.markComplete(pi).ok, true);

	const [created, completed] = historyRecords(pi);
	const snapshot = pi.entries.find(
		(entry) => entry.customType === CUSTOM_ENTRY_TYPE && entry.data.goal?.revision === 1,
	).data.goal;

	assert.equal(created.from, null, "a creation has no previous status");
	assert.equal(created.to, "active");
	assert.equal(created.goalId, goal.id);
	assert.equal(created.revision, 0);
	assert.equal(created.timestamp, new Date(goal.updatedAt).toISOString(), "the transition's own time");

	assert.equal(completed.from, "active");
	assert.equal(completed.to, "complete");
	assert.equal(completed.revision, 1);
	assert.equal(completed.timestamp, new Date(snapshot.updatedAt).toISOString());
	assert.deepEqual(
		completed.usage,
		{
			totalTokens: 520,
			inputTokens: 400,
			outputTokens: 100,
			cacheWriteTokens: 20,
			cachedReadTokens: 30,
			reasoningTokens: 0,
			nestedTokens: 0,
			activeSeconds: completed.usage.activeSeconds,
		},
		"the committed usage summary",
	);
	assert.equal(completed.usage.totalTokens, snapshot.usage.totalTokens, "the same total the snapshot carries");

	// Manifest metadata, hashes included; never the bytes.
	assert.deepEqual(
		completed.attachments.map((attachment) => attachment.hash),
		manifest.map((attachment) => attachment.hash),
	);
	assert.deepEqual(
		completed.attachments.map((attachment) => attachment.mediaType),
		["text/plain", "image/png"],
	);
	assert.equal(JSON.stringify(completed).includes("Specification for the release"), false, "no attachment contents");
	assert.equal(JSON.stringify(created).includes(goal.objective), false, "no objective text either");
});

test("a replacement records the replaced identity's status, and the replaced identity keeps its own records", () => {
	const pi = fakePi();
	const { store, goal: first } = startedGoal(pi);
	assert.equal(store.markPaused(pi).ok, true);

	const second = store.create("The replacement objective");
	store.preserveSupersededForReplacement(pi);
	store.stage(pi, second);
	store.commit(second);

	const records = historyRecords(pi);
	assert.deepEqual(historyKinds(pi), ["created", "paused", "replaced"]);
	const replaced = records[2];
	assert.equal(replaced.goalId, second.id, "the record names the replacement identity");
	assert.equal(replaced.from, "paused", "the status the replaced identity had");
	assert.equal(replaced.to, "active");
	assert.equal(replaced.revision, 0);
	// The superseded freeze is bookkeeping rather than a transition, so it writes no
	// history record of its own — exactly as it emits no event.
	assert.equal(pi.entries.filter((entry) => entry.customType === CUSTOM_ENTRY_TYPE).length, 4);
	assert.equal(historyEntries(pi).length, 3);
	assert.ok(first.id);
});

test("the budget stop records at its durable flush, and accounting writes no records", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi, { tokenBudget: 100 });
	store.accountUsage("model:1", usage(90, 20), "model");

	// The in-memory stop is not durable yet, so it writes nothing.
	assert.equal(store.markBudgetLimited().ok, true);
	assert.deepEqual(historyKinds(pi), ["created"]);

	// The durable flush is the transition, and the history record follows the
	// snapshot it describes with the totals re-read at the flush.
	assert.equal(store.flushPendingTransition(pi), true);
	assert.deepEqual(historyKinds(pi), ["created", "budget-limited"]);
	const budgetLimited = historyRecords(pi)[1];
	assert.equal(budgetLimited.from, "active", "the status the budget stop replaced");
	assert.equal(budgetLimited.to, "budget_limited");
	assert.equal(budgetLimited.usage.totalTokens, 110);
	assert.equal(budgetLimited.revision, goal.revision + 1);

	// Wrap-up delivery and disarm, accounting checkpoints, and the recovery resume.
	assert.equal(store.consumeWrapUp(pi).ok, true);
	assert.equal(store.flushAccounting(pi, true), undefined);
	assert.equal(store.markResumed(pi, { tokenBudget: 500 }).ok, true);
	assert.equal(store.markComplete(pi).ok, true);
	assert.deepEqual(historyKinds(pi), ["created", "budget-limited", "budget-recovered", "completed"]);
	assert.equal(historyRecords(pi)[2].to, "active", "the recovery restarts the Goal");
	assert.equal(
		pi.entries.filter((entry) => entry.customType === "goal-usage").length >= 1,
		true,
		"accounting kept writing its own durable checkpoints",
	);
	assert.equal(historyEntries(pi).length, 4, "and none of them produced a history record");
});

test("the blocked threshold, a conservative stop, and a usage limit each record once; audit steps do not", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi, { tokenBudget: 1000 });
	const first = store.markBlockedReport(pi, { blocker: "waiting on upstream", turn: 1 });
	assert.equal(first.ok, true);
	const identity = first.goal.blockedAudit.blockerId;
	assert.equal(
		store.markBlockedReport(pi, { blocker: "waiting on upstream", blockerId: identity, turn: 2 }).ok,
		true,
	);
	assert.deepEqual(historyKinds(pi), ["created"], "below-threshold reports are audit bookkeeping");
	assert.equal(
		pi.entries.filter((entry) => entry.customType === CUSTOM_ENTRY_TYPE).length,
		3,
		"but they are still durable snapshots",
	);

	assert.equal(
		store.markBlockedReport(pi, { blocker: "waiting on upstream", blockerId: identity, turn: 3 }).ok,
		true,
	);
	assert.deepEqual(historyKinds(pi), ["created", "blocked"]);
	assert.equal(historyRecords(pi)[1].from, "active");
	assert.equal(historyRecords(pi)[1].to, "blocked");

	// A reset is bookkeeping, and a conservative stop is its own transition.
	assert.deepEqual(store.resetBlockedAudit(pi), { ok: true, reset: false });
	assert.equal(store.markResumed(pi).ok, true);
	assert.equal(store.stopGoal(pi, { status: "usage_limited", blocker: "Monthly usage limit reached" }).ok, true);
	assert.deepEqual(historyKinds(pi), ["created", "blocked", "resumed", "usage-limited"]);
	assert.equal(historyRecords(pi)[3].to, "usage_limited");
});

test("refused, failed, and rolled-back transitions append no history", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi);

	// Refusals: nothing durable happened.
	assert.equal(store.markPaused(pi, { id: goal.id, revision: 99 }).ok, false, "stale binding");
	assert.equal(store.markResumed(pi, { tokenBudget: 10 }).ok, false, "a budget raise only resumes a stop");
	assert.deepEqual(historyKinds(pi), ["created"]);

	// Failed writes: the append throws, so neither the snapshot nor its record land.
	pi.failNext = 1;
	assert.equal(store.markComplete(pi).ok, false);
	pi.failNext = 1;
	assert.equal(store.markPaused(pi).ok, false);
	pi.failNext = 1;
	assert.equal(store.editObjective(pi, "Never lands").ok, false);
	pi.failNext = 1;
	assert.equal(store.clear(pi).ok, false);
	assert.deepEqual(historyKinds(pi), ["created"], "a failed transition writes nothing at all");
	assert.ok(store.get(), "the Goal survived every failed write");

	// A retracted creation: the commit announced the creation, and the retraction is
	// bookkeeping that writes nothing further — the same shape the event stream has.
	const rollbackPi = fakePi();
	const { store: fresh } = historyStore(rollbackPi);
	const staged = fresh.create("A creation that cannot be confirmed durable");
	fresh.stage(rollbackPi, staged);
	fresh.commit(staged);
	assert.deepEqual(historyKinds(rollbackPi), ["created"]);
	fresh.rollback(rollbackPi);
	assert.deepEqual(historyKinds(rollbackPi), ["created"], "the retraction itself appends nothing");
	assert.equal(fresh.get(), null);

	// A durability-rollback restore rewrites the previous record and appends nothing.
	const restorePi = fakePi();
	const { store: replacing } = historyStore(restorePi);
	const stagedOriginal = replacing.create("First");
	replacing.stage(restorePi, stagedOriginal);
	replacing.commit(stagedOriginal);
	const original = replacing.get();
	const second = replacing.create("Second");
	replacing.preserveSupersededForReplacement(restorePi);
	replacing.stage(restorePi, second);
	replacing.commit(second);
	assert.deepEqual(historyKinds(restorePi), ["created", "replaced"]);
	assert.equal(replacing.restore(restorePi, original).ok, true);
	assert.deepEqual(historyKinds(restorePi), ["created", "replaced"], "a restore is a retraction, not a transition");
});

test("a history append that fails leaves the committed transition standing (the crash gap)", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi);
	store.accountUsage("model:1", usage(400, 100), "model");

	// The lifecycle write succeeds and the history write fails: this is the window a
	// crash between the two leaves behind, injected deterministically.
	pi.failType = HISTORY_ENTRY_TYPE;
	assert.equal(store.markComplete(pi).ok, true, "the transition still commits");
	assert.deepEqual(historyKinds(pi), ["created"], "with a gap where the record would be");

	// The snapshot is durable, so reconstruction is exactly what it would have been.
	const branch = [...pi.entries];
	const reconstructed = new GoalStore().reconstruct(fakeCtx(branch));
	assert.equal(reconstructed?.id, goal.id);
	assert.equal(reconstructed?.status, "complete", "the Goal is complete, gap or no gap");
	assert.equal(reconstructed?.revision, goal.revision + 1);
	assert.equal(reconstructed?.usage?.totalTokens, 500);

	// The gap is diagnostic only: the next transition appends normally again.
	pi.failType = null;
	assert.equal(store.clear(pi).ok, true);
	assert.deepEqual(historyKinds(pi), ["created", "cleared"]);
});

test("history is read from the selected branch and is never consulted by reconstruction", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi);
	assert.equal(store.markPaused(pi).ok, true);

	// Missing history entirely: reconstruction reads `goal-state` alone.
	const withoutHistory = new GoalStore().reconstruct(fakeCtx([...pi.entries].filter((e) => e.customType !== HISTORY_ENTRY_TYPE)));
	assert.equal(withoutHistory?.id, goal.id);
	assert.equal(withoutHistory?.status, "paused");

	// Malformed history entries beside a perfectly good snapshot: skipped, counted,
	// and still unable to change the Goal.
	const malformed = [
		...pi.entries,
		{ type: "custom", id: "bad-1", customType: HISTORY_ENTRY_TYPE, data: { version: 1, kind: "cleared" } },
		{ type: "custom", id: "bad-2", customType: HISTORY_ENTRY_TYPE, data: "not an object" },
		{ type: "custom", id: "bad-3", customType: HISTORY_ENTRY_TYPE, data: { version: 2, kind: "created" } },
		{ type: "custom", id: "bad-4", customType: HISTORY_ENTRY_TYPE },
		{ type: "custom", id: "bad-5", customType: HISTORY_ENTRY_TYPE, data: null },
	];
	const withMalformed = new GoalStore().reconstruct(fakeCtx(malformed));
	assert.equal(withMalformed?.id, goal.id, "malformed history cannot resurrect, clear, or replace the Goal");
	assert.equal(withMalformed?.status, "paused");
	assert.equal(withMalformed?.revision, store.get()?.revision);

	// The reader skips them and reports the count, so the rendering can say so.
	const view = readGoalHistory(malformed);
	assert.deepEqual(view.records.map((record) => record.kind), ["created", "paused"]);
	assert.equal(view.malformed, 5);
});

test("history is branch-local: only the selected branch's records are read", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	assert.equal(store.markPaused(pi).ok, true);
	const beforeFork = [...pi.entries];

	// A fork copies the branch: its own transitions append to the copy, and the
	// original branch keeps only what it had.
	const forked = fakePi();
	for (const entry of beforeFork) forked.entries.push(entry);
	const { store: forkStore } = historyStore(forked);
	const forkedGoal = forkStore.create("The fork's own objective");
	forkStore.stage(forked, forkedGoal);
	forkStore.commit(forkedGoal);

	const forkView = readGoalHistory(forked.entries);
	assert.deepEqual(forkView.records.map((record) => record.kind), ["created", "paused", "created"]);
	assert.equal(forkView.records[2].goalId, forkedGoal.id);

	const originalView = readGoalHistory(pi.entries);
	assert.deepEqual(originalView.records.map((record) => record.kind), ["created", "paused"]);
	assert.equal(originalView.records[0].goalId, store.get()?.id);
});

test("the store's own reader returns the branch view and never throws", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);
	assert.equal(store.markComplete(pi).ok, true);

	const view = store.readHistory(fakeCtx(pi.entries));
	assert.deepEqual(view.records.map((record) => record.kind), ["created", "completed"]);
	assert.equal(view.malformed, 0);

	const broken = { sessionManager: { getBranch: () => { throw new Error("no branch"); } } };
	assert.deepEqual(store.readHistory(broken), { records: [], malformed: 0, unreadable: true });
});

test("the rendering is readable, read-only, and honest about gaps", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi, {
		attachments: [{ hash: "c".repeat(64), mediaType: "text/plain", bytes: 12_400, label: "spec.md" }],
	});
	store.accountUsage("model:1", usage(48_210, 0), "model");
	assert.equal(store.markPaused(pi).ok, true);

	const view = readGoalHistory(pi.entries);
	const rendered = formatGoalHistory(view);
	assert.match(rendered, /^Goal history on this branch \(2 records, non-authoritative/, "the header names the authority");
	assert.match(rendered, /created\s+goal_[0-9a-f]{8}\s+revision 0\s+→ active\s+0 tokens\s+active 0s/);
	assert.match(rendered, /paused\s+goal_[0-9a-f]{8}\s+revision 1\s+active → paused\s+48210 tokens\s+active/);
	assert.match(rendered, /attachments: spec\.md \(text\/plain, 12\.1 KB\) sha256:cccccccccccc/);
	assert.equal(rendered.includes(goal.objective), false, "the objective text never reaches the timeline");

	// An empty timeline says so instead of rendering nothing.
	assert.equal(
		formatGoalHistory({ records: [], malformed: 0 }),
		"No Goal history on this branch yet.",
	);
	// An unreadable entry is surfaced, not silently dropped.
	assert.match(
		formatGoalHistory({ records: [], malformed: 2 }),
		/2 history entries on this branch could not be read .* were skipped/,
	);
});

test("a corrupt or oversized label renders single-line, escape-free, and bounded, without mutating history", () => {
	const evilLabel = "report\u001b[31m.txt\u001b[0m\nrm -rf /";
	const oversized = "x".repeat(200_000);
	const base = {
		version: 1,
		kind: "created",
		goalId: "goal_aaaaaaaa",
		revision: 0,
		from: null,
		to: "active",
		timestamp: new Date(0).toISOString(),
		usage: {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cachedReadTokens: 0,
			reasoningTokens: 0,
			nestedTokens: 0,
			activeSeconds: 0,
		},
		attachments: [],
	};
	const evil = {
		...base,
		attachments: [{ hash: "a".repeat(64), mediaType: "text/plain", bytes: 10, label: evilLabel }],
	};
	const big = {
		...base,
		attachments: [{ hash: "b".repeat(64), mediaType: "text/plain", bytes: 10, label: oversized }],
	};

	// A label carrying an ANSI escape and a newline renders on one line, the escape
	// stripped and the newline collapsed: the corrupt record is still surfaced, but
	// safely — never as a colored or multi-line entry.
	const evilRendered = formatGoalHistory({ records: [evil], malformed: 0 });
	const evilLines = evilRendered.split("\n");
	assert.equal(evilLines.length, 3, "header, the record line, and one attachment line — no injected line");
	const evilAttachment = evilLines.find((line) => line.includes("attachments:"));
	assert.ok(evilAttachment, "the record is still surfaced");
	assert.equal(evilAttachment.includes("\u001b"), false, "no escape sequence survives");
	assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(evilAttachment), "no control character survives");
	assert.ok(evilAttachment.includes("report.txt rm -rf /"), "the newline collapsed to a space, the escape stripped");

	// An oversized label is capped, so the notice stays bounded and single-line.
	const bigRendered = formatGoalHistory({ records: [big], malformed: 0 });
	const bigLines = bigRendered.split("\n");
	assert.equal(bigLines.length, 3, "still exactly one line per record");
	const bigAttachment = bigLines.find((line) => line.includes("attachments:"));
	assert.ok(bigAttachment.length < 200, `the attachment line is bounded (got ${bigAttachment.length})`);
	assert.ok(bigAttachment.includes("..."), "an over-long label is truncated with an ellipsis");

	// The rendering is read-only: the durable records keep their corrupt labels.
	assert.equal(evil.attachments[0].label, evilLabel, "history is not mutated by rendering");
	assert.equal(big.attachments[0].label, oversized);
});

test("an unreadable branch is distinguished from an empty one, and never claimed empty", () => {
	const pi = fakePi();
	const { store } = startedGoal(pi);

	// A branch that reads fine but holds no history is empty, not unreadable.
	const empty = store.readHistory(
		fakeCtx(pi.entries.filter((entry) => entry.customType !== HISTORY_ENTRY_TYPE)),
	);
	assert.equal(empty.unreadable, undefined, "a read-but-empty branch is not flagged unreadable");
	assert.equal(formatGoalHistory(empty), "No Goal history on this branch yet.");

	// A branch whose read throws is unreadable, and is not rendered as empty.
	const broken = { sessionManager: { getBranch: () => { throw new Error("no branch"); } } };
	const view = store.readHistory(broken);
	assert.equal(view.unreadable, true);
	const rendered = formatGoalHistory(view);
	assert.match(rendered, /could not be read on this branch/);
	assert.equal(rendered.includes("No Goal history"), false, "an unreadable branch is never claimed empty");

	// The read failure cannot change the Goal: reconstruction reads goal-state alone.
	const reconstructed = new GoalStore().reconstruct(fakeCtx(pi.entries));
	assert.equal(reconstructed?.id, store.get()?.id, "the unreadable timeline cannot change the Goal");
});

test("a history record is structurally validated, so a truncated entry is never rendered as data", () => {
	const valid = {
		version: 1,
		kind: "paused",
		goalId: "goal_aaaaaaaa",
		revision: 3,
		from: "active",
		to: "paused",
		timestamp: new Date(0).toISOString(),
		usage: {
			totalTokens: 1,
			inputTokens: 1,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cachedReadTokens: 0,
			reasoningTokens: 0,
			nestedTokens: 0,
			activeSeconds: 0,
		},
		attachments: [],
	};
	assert.equal(isGoalHistoryRecord(valid), true);
	for (const broken of [
		null,
		"paused",
		{ ...valid, version: 2 },
		{ ...valid, kind: 3 },
		{ ...valid, goalId: "" },
		{ ...valid, revision: -1 },
		{ ...valid, revision: 1.5 },
		{ ...valid, from: 7 },
		{ ...valid, to: undefined },
		{ ...valid, timestamp: "not a time" },
		{ ...valid, usage: undefined },
		{ ...valid, usage: { ...valid.usage, totalTokens: "1" } },
		{ ...valid, usage: { ...valid.usage, activeSeconds: -1 } },
		{ ...valid, attachments: "none" },
		{ ...valid, attachments: [{ hash: "", mediaType: "text/plain", bytes: 1, label: "x" }] },
		{ ...valid, attachments: [{ hash: "a".repeat(64), mediaType: "text/plain", bytes: 1.5, label: "x" }] },
	]) {
		assert.equal(isGoalHistoryRecord(broken), false, JSON.stringify(broken));
	}
	// A clear's self-referential statuses are valid: a tombstone names no new Goal.
	assert.equal(isGoalHistoryRecord({ ...valid, kind: "cleared", from: "complete", to: "complete" }), true);
	// A creation has no previous status.
	assert.equal(isGoalHistoryRecord({ ...valid, kind: "created", from: null }), true);
});

test("an unknown transition kind or unknown status is malformed, never a real timeline entry", () => {
	const valid = {
		version: 1,
		kind: "paused",
		goalId: "goal_aaaaaaaa",
		revision: 3,
		from: "active",
		to: "paused",
		timestamp: new Date(0).toISOString(),
		usage: {
			totalTokens: 1,
			inputTokens: 1,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cachedReadTokens: 0,
			reasoningTokens: 0,
			nestedTokens: 0,
			activeSeconds: 0,
		},
		attachments: [],
	};
	// An unknown kind, or an unknown from/to status, is not a transition this build
	// understands, so it is malformed rather than a legitimate record.
	assert.equal(isGoalHistoryRecord({ ...valid, kind: "not-a-transition" }), false);
	assert.equal(isGoalHistoryRecord({ ...valid, from: "not-a-status" }), false);
	assert.equal(isGoalHistoryRecord({ ...valid, to: "not-a-status" }), false);
	assert.equal(isGoalHistoryRecord({ ...valid, from: 7 }), false);

	// Every kind the stream covers, and every Lifecycle status, stays valid.
	for (const kind of GOAL_TRANSITION_KINDS) {
		assert.equal(isGoalHistoryRecord({ ...valid, kind }), true, kind);
	}
	for (const status of GOAL_STATUSES) {
		assert.equal(isGoalHistoryRecord({ ...valid, from: status, to: status }), true, status);
		assert.equal(isGoalHistoryRecord({ ...valid, kind: "cleared", from: status, to: status }), true);
	}
	// A creation's null previous status is still valid.
	assert.equal(isGoalHistoryRecord({ ...valid, kind: "created", from: null }), true);

	// The reader skips and counts the unknown entries beside a good record, exactly
	// like any other malformed entry, and never returns them as records.
	const view = readGoalHistory([
		{ type: "custom", customType: HISTORY_ENTRY_TYPE, data: valid },
		{ type: "custom", customType: HISTORY_ENTRY_TYPE, data: { ...valid, kind: "not-a-transition" } },
		{ type: "custom", customType: HISTORY_ENTRY_TYPE, data: { ...valid, from: "active", to: "not-a-status" } },
	]);
	assert.deepEqual(view.records.map((record) => record.kind), ["paused"]);
	assert.equal(view.malformed, 2);

	// And the rendering shows the one good record, never the invented kind or status.
	const rendered = formatGoalHistory(view);
	assert.match(rendered, /paused\s+goal_aaaaaaaa\s+revision 3/);
	assert.equal(rendered.includes("not-a-transition"), false, "an unknown kind is never a timeline entry");
	assert.equal(rendered.includes("not-a-status"), false, "and neither is an unknown status");
	assert.match(rendered, /2 history entries on this branch could not be read/);
});

test("the projection never mutates the event payload or the Goal record it came from", () => {
	const pi = fakePi();
	const { store, goal } = startedGoal(pi, {
		attachments: [{ hash: "d".repeat(64), mediaType: "image/png", bytes: 1024, label: "shot.png" }],
	});
	const event = toGoalUpdatedEvent("created", goal);
	const frozen = JSON.parse(JSON.stringify(event));
	const record = toGoalHistoryRecord(event, null);

	record.usage.totalTokens = 999_999;
	record.attachments[0].hash = "0".repeat(64);
	assert.deepEqual(event, frozen, "the record is a copy, not an alias of the event payload");
	assert.equal(goal.attachments?.[0]?.hash, "d".repeat(64), "and never of the Goal's manifest");
});
