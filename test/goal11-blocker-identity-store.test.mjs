/**
 * Issue #26 repair batch 3 narrow store tests: opaque Blocker identity, the
 * legacy open-audit handoff, and the exact per-turn/reset semantics that a real
 * `pi --mode rpc` subprocess cannot reach exhaustively.
 *
 * These are deliberately *narrow* seams: the store's own transition, the durable
 * cutover, an injected persistence failure, and the reconstruction combinatorics
 * (every reset × every chain position). The RPC scenarios live in
 * `test/goal11-blocker-identity.test.mjs`; both are required by issue #21.
 *
 * The store is imported straight from TypeScript; Node 22.6+ strips the erasable
 * syntax natively. On older Node the file skips (the RPC suite remains the
 * required gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storeModule;
let goalModule;
try {
	storeModule = await import("../src/store.ts");
	goalModule = await import("../src/goal.ts");
} catch {
	storeModule = undefined;
}
const it = storeModule ? test : test.skip;
const { GoalStore } = storeModule ?? {};
const { BLOCKED_AUDIT_THRESHOLD } = goalModule ?? {};

function fakePi(failures = {}) {
	const appended = [];
	return {
		appended,
		failOn: failures,
		appendEntry(type, data) {
			if (failures[type]) throw new Error(`injected ${type} failure`);
			appended.push({ type, data });
		},
	};
}

function fakeCtx(branch) {
	return { sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/session.jsonl" } };
}

let nextEntryId = 0;
function goalEntry(goal, extra = {}) {
	return {
		type: "custom",
		id: `gs-${nextEntryId++}`,
		customType: "goal-state",
		data: { version: 1, goal, ...extra },
	};
}

/**
 * The immutable 0.1.0 fixture's `goal-state` entry, as a branch entry.
 *
 * The fixture is the same one the RPC legacy tests load, so the cutover handoff is
 * proved against the byte-fixed pre-repair snapshot rather than a hand-written one.
 */
function legacyOpenAuditEntry() {
	const lines = readFileSync(join(import.meta.dirname, "fixtures", "legacy", "legacy-open-audit.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	const entry = lines.find((line) => line.customType === "goal-state");
	return { type: "custom", id: entry.id, customType: entry.customType, data: entry.data };
}

function record(overrides = {}) {
	return {
		id: "goal_aaaaaaaa",
		objective: "Make the full test suite pass in this repository",
		status: "active",
		origin: "command",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		revision: 0,
		usage: {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cachedReadTokens: 0,
			reasoningTokens: 0,
			nestedTokens: 0,
			activeMs: 0,
		},
		...overrides,
	};
}

/** The audit of the newest durable snapshot a fake Pi accepted. */
function lastAudit(pi) {
	const states = pi.appended.filter((entry) => entry.type === "goal-state");
	return states.at(-1)?.data.goal.blockedAudit;
}

/** Every goal-state snapshot a fake Pi accepted, in append order. */
function goalStates(pi) {
	return pi.appended.filter((entry) => entry.type === "goal-state").map((entry) => entry.data.goal);
}

/** A store reconstructed from one branch, ready to report a blocker. */
function storeWith(goal) {
	const store = new GoalStore();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	return store;
}

it("the first report of a condition issues an opaque Blocker identity and persists it", () => {
	const store = storeWith(record());
	const pi = fakePi();
	const result = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	assert.equal(result.ok, true);
	assert.equal(result.repeat, false);
	assert.equal(result.turns, 1);
	assert.equal(result.thresholdMet, false);
	const audit = lastAudit(pi);
	assert.deepEqual(Object.keys(audit).sort(), ["blocker", "blockerId", "turns"]);
	assert.equal(audit.blocker, "The test database is unavailable");
	assert.equal(audit.turns, 1);
	assert.match(audit.blockerId, /^blocker_[0-9a-f]{8}$/, "the identity is opaque and extension-issued");
});

it("a Blocker identity is never derived from the blocker text", () => {
	// The same words must not produce the same identity: identity is issued, not
	// computed, so a model cannot forge or predict one from the description.
	const first = new GoalStore();
	first.reconstruct(fakeCtx([goalEntry(record())]));
	const a = fakePi();
	first.markBlockedReport(a, { blocker: "The test database is unavailable", turn: 1 });

	const second = new GoalStore();
	second.reconstruct(fakeCtx([goalEntry(record())]));
	const b = fakePi();
	second.markBlockedReport(b, { blocker: "The test database is unavailable", turn: 1 });

	assert.notEqual(lastAudit(a).blockerId, lastAudit(b).blockerId);
});

it("reusing the current identity advances the audit even when the wording changes", () => {
	const store = storeWith(record());
	const pi = fakePi();
	const first = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	const id = lastAudit(pi).blockerId;
	const second = store.markBlockedReport(pi, {
		blocker: "Test DB is still down; restarting it would unblock the work",
		blockerId: id,
		turn: 2,
	});
	assert.equal(second.ok, true);
	assert.equal(second.turns, 2);
	assert.equal(lastAudit(pi).blockerId, id, "the identity is unchanged while the condition persists");
	assert.equal(lastAudit(pi).blocker, "Test DB is still down; restarting it would unblock the work");
	assert.equal(first.ok, true);
});

it("omitting the identity starts a fresh chain at one with a fresh identity", () => {
	const store = storeWith(record());
	const pi = fakePi();
	store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	const id = lastAudit(pi).blockerId;
	const fresh = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 2 });
	assert.equal(fresh.ok, true);
	assert.equal(fresh.turns, 1, "an omitted identity reports a genuinely different condition");
	const audit = lastAudit(pi);
	assert.notEqual(audit.blockerId, id, "the old chain cannot resume");
	assert.equal(audit.turns, 1);
});

it("an unrecognized or non-current identity is rejected without Goal mutation", () => {
	const store = storeWith(record());
	const pi = fakePi();
	store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	const id = lastAudit(pi).blockerId;
	const before = goalStates(pi).length;
	const revisionBefore = store.get().revision;

	const unknown = store.markBlockedReport(pi, {
		blocker: "The test database is unavailable",
		blockerId: "blocker_deadbeef",
		turn: 2,
	});
	assert.equal(unknown.ok, false);
	assert.equal(unknown.reason, "not-current");
	assert.match(unknown.message, /blocker_deadbeef/);
	assert.equal(goalStates(pi).length, before, "a rejected call appends nothing");
	assert.equal(store.get().revision, revisionBefore, "a rejected call advances no revision");
	assert.equal(store.get().blockedAudit.turns, 1, "a rejected call does not reset or replace the audit");
	assert.ok(id !== "blocker_deadbeef");
});

it("a superseded chain's identity is refused after the audit was reset", () => {
	// The old chain can never resume, not even with the identity it used to have.
	const store = storeWith(record());
	const pi = fakePi();
	store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	const id = lastAudit(pi).blockerId;
	store.resetBlockedAudit(pi);
	assert.equal(store.get().blockedAudit, undefined, "the reset drops the audit and its identity");

	const resumed = store.markBlockedReport(pi, {
		blocker: "The test database is unavailable",
		blockerId: id,
		turn: 2,
	});
	assert.equal(resumed.ok, false);
	assert.equal(resumed.reason, "not-current");
	assert.equal(goalStates(pi).length, 2, "only the report and the reset are durable");
});

it("a rejected identity does not own the turn, so a corrected call records the first report", () => {
	const store = storeWith(record());
	const pi = fakePi();
	const rejected = store.markBlockedReport(pi, {
		blocker: "The test database is unavailable",
		blockerId: "blocker_00000000",
		turn: 1,
	});
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, "not-current");

	const corrected = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	assert.equal(corrected.ok, true);
	assert.equal(corrected.repeat, false, "the corrected call is the turn's first valid report");
	assert.equal(corrected.turns, 1);
	assert.equal(goalStates(pi).length, 1, "the rejected call wrote nothing");
});

it("a same-turn repeat is idempotent even with different text and a different identity", () => {
	const store = storeWith(record());
	const pi = fakePi();
	store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	const id = lastAudit(pi).blockerId;

	const repeat = store.markBlockedReport(pi, {
		blocker: "Something entirely different is wrong now",
		blockerId: "blocker_ffffffff",
		turn: 1,
	});
	assert.equal(repeat.ok, true);
	assert.equal(repeat.repeat, true);
	assert.equal(repeat.turns, 1, "a repeat cannot advance the audit");
	assert.equal(repeat.thresholdMet, false);
	assert.equal(lastAudit(pi).blockerId, id, "a repeat cannot replace the audit's identity");
	assert.equal(lastAudit(pi).blocker, "The test database is unavailable", "a repeat cannot replace the description");
	assert.equal(goalStates(pi).length, 1, "a repeat appends nothing");
});

it("only the third consecutive Goal turn transitions, and no turn can double-count", () => {
	const store = storeWith(record());
	const pi = fakePi();
	const blockers = ["first wording", "second wording", "third wording"];
	let id;
	for (const [index, blocker] of blockers.entries()) {
		const turn = index + 1;
		const result = store.markBlockedReport(pi, { blocker, blockerId: id, turn });
		assert.equal(result.ok, true);
		assert.equal(result.turns, turn);
		assert.equal(result.thresholdMet, turn === BLOCKED_AUDIT_THRESHOLD);
		id = lastAudit(pi).blockerId;
		if (turn === BLOCKED_AUDIT_THRESHOLD) {
			assert.equal(store.get().status, "blocked", "exactly the third consecutive turn transitions");
			// The Goal is stopped, so a further report in that turn has nothing to
			// advance: it is refused rather than counted again.
			assert.equal(store.markBlockedReport(pi, { blocker, blockerId: id, turn }).reason, "not-active");
			continue;
		}
		// A second call inside the same turn is one audit step, never a second one.
		const again = store.markBlockedReport(pi, { blocker, blockerId: id, turn });
		assert.equal(again.repeat, true);
		assert.equal(again.turns, turn);
	}
	assert.equal(store.get().status, "blocked", "exactly the third consecutive turn transitions");
	assert.equal(goalStates(pi).length, 3, "one durable audit step per Goal turn");
});

it("a persistence failure leaves the Goal untouched and the turn unowned", () => {
	const store = storeWith(record());
	const failing = fakePi({ "goal-state": true });
	const result = store.markBlockedReport(failing, { blocker: "The test database is unavailable", turn: 1 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "persistence");
	assert.equal(store.get().blockedAudit, undefined, "the failed report recorded nothing");

	// The turn is not owned by the failed call, so a retry records the first report.
	const pi = fakePi();
	const retry = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	assert.equal(retry.ok, true);
	assert.equal(retry.repeat, false);
	assert.equal(retry.turns, 1);
});

it("a malformed Blocker identity is dropped during reconstruction instead of being trusted", () => {
	for (const bad of ["", "   ", 42, null, {}]) {
		const store = new GoalStore();
		store.reconstruct(
			fakeCtx([
				goalEntry(
					record({
						blockedAudit: { blocker: "The test database is unavailable", turns: 2, blockerId: bad },
					}),
				),
			]),
		);
		assert.equal(store.get().blockedAudit, undefined, `identity ${JSON.stringify(bad)} is not trusted`);
	}
});

it("a legacy audit without an identity survives reconstruction for the cutover handoff", () => {
	// Batch 1 preserved the legacy audit; batch 3 hands it an identity. The
	// snapshot itself is a 0.1.0 snapshot, so nothing rewrites it here.
	const goal = record({ blockedAudit: { blocker: "The test database is unavailable", turns: 2 } });
	const store = new GoalStore();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	assert.deepEqual(store.get().blockedAudit, { blocker: "The test database is unavailable", turns: 2 });
	assert.equal(store.needsLegacyCutover(), true);
});

it("the cutover preserves the legacy description and count and issues a fresh identity", () => {
	const goal = record({ blockedAudit: { blocker: "The test database is unavailable", turns: 2 } });
	const store = new GoalStore();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	const cutover = store.applyLegacyCutover(pi, {});
	assert.equal(cutover.ok, true);
	assert.equal(cutover.cutover, true);
	const repaired = goalStates(pi).at(-1);
	assert.equal(repaired.blockedAudit.blocker, "The test database is unavailable", "description preserved");
	assert.equal(repaired.blockedAudit.turns, 2, "count preserved");
	assert.match(repaired.blockedAudit.blockerId, /^blocker_[0-9a-f]{8}$/, "a fresh identity is issued");
	assert.ok(cutover.notices.join("\n").includes("Blocker identity"), "the handoff is reported");
});

it("a legacy audit keeps its identity across a reload and reaches the threshold on the next report", () => {
	const goal = record({ blockedAudit: { blocker: "The test database is unavailable", turns: 2 } });
	const branch = [goalEntry(goal)];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	const cutoverPi = fakePi();
	store.applyLegacyCutover(cutoverPi, {});
	const branchAfterCutover = [
		...branch,
		...cutoverPi.appended.map((entry, index) => ({
			type: "custom",
			id: `cut-${index}`,
			customType: entry.type,
			data: entry.data,
		})),
	];

	// A fresh runtime reconstructs from the branch: the identity survives, so the
	// same condition can be advanced rather than restarted.
	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx(branchAfterCutover));
	assert.equal(reloaded.needsLegacyCutover(), false, "the cutover is branch-local and done");
	const audit = reloaded.get().blockedAudit;
	assert.equal(audit.turns, 2);
	assert.match(audit.blockerId, /^blocker_[0-9a-f]{8}$/);

	const pi = fakePi();
	const advanced = reloaded.markBlockedReport(pi, {
		blocker: "The test database is still unavailable",
		blockerId: audit.blockerId,
		turn: 1,
	});
	assert.equal(advanced.ok, true);
	assert.equal(advanced.turns, 3, "the preserved count is honoured, not restarted");
	assert.equal(advanced.thresholdMet, true, "the third turn of the legacy chain stops the Goal");
	assert.equal(reloaded.get().status, "blocked");
	assert.equal(pi.appended.length, 1, "exactly one transition, no extra unattended turns");
});

it("a legacy handoff identity grants no extra unattended turns when it is omitted", () => {
	const goal = record({ blockedAudit: { blocker: "The test database is unavailable", turns: 2 } });
	const store = new GoalStore();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	store.applyLegacyCutover(pi, {});

	const omitted = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	assert.equal(omitted.ok, true);
	assert.equal(omitted.turns, 1, "omitting the identity starts a fresh chain, so nothing is granted");
	assert.equal(omitted.thresholdMet, false);
	assert.equal(store.get().status, "active", "no extra unattended turns are granted at cutover");
});

it("a non-active legacy audit is preserved as history and gets no identity", () => {
	// The handoff is for an *active* Goal's open audit. A stopped Goal's audit
	// describes the stop and is never advanced again.
	const goal = record({
		status: "blocked",
		blockedAudit: { blocker: "The test database is unavailable", turns: 3 },
	});
	const store = new GoalStore();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	const cutover = store.applyLegacyCutover(pi, {});
	assert.equal(cutover.ok, true);
	const repaired = goalStates(pi).at(-1);
	assert.deepEqual(repaired.blockedAudit, { blocker: "The test database is unavailable", turns: 3 });
	assert.equal(repaired.status, "blocked");
	assert.equal(
		store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 }).reason,
		"not-active",
	);
});

it("every reset drops the identity durably, so no chain can resume after it", () => {
	for (const reset of ["user action", "no-report turn", "resume"]) {
		const store = storeWith(record());
		const pi = fakePi();
		store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
		const id = lastAudit(pi).blockerId;
		if (reset === "resume") {
			store.markPaused(pi);
			assert.equal(store.markResumed(pi).ok, true);
		} else {
			assert.equal(store.resetBlockedAudit(pi).ok, true);
		}
		const durable = goalStates(pi).at(-1);
		assert.equal(durable.blockedAudit, undefined, `${reset}: the reset is durable`);
		const after = store.markBlockedReport(pi, { blocker: "The test database is unavailable", blockerId: id, turn: 2 });
		assert.equal(after.ok, false, `${reset}: the old identity is refused`);
		assert.equal(after.reason, "not-current");
	}
});

it("a report that does not follow the previous turn starts a fresh chain even with the old identity", () => {
	// Consecutiveness is the extension's rule, not the model's: a turn that made
	// progress broke the chain, so the identity it used to have is spent.
	const store = storeWith(record());
	const pi = fakePi();
	store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	const id = lastAudit(pi).blockerId;
	// A Goal turn with no report breaks the chain; the durable reset is what a
	// settlement writes, and the in-memory turn bookkeeping forgets it too.
	store.resetBlockedAudit(pi);
	const later = store.markBlockedReport(pi, {
		blocker: "The test database is unavailable",
		blockerId: id,
		turn: 5,
	});
	assert.equal(later.ok, false);
	assert.equal(later.reason, "not-current");
	const fresh = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 5 });
	assert.equal(fresh.ok, true);
	assert.equal(fresh.turns, 1);
	assert.notEqual(lastAudit(pi).blockerId, id);
});

it("the immutable legacy fixture is handed a fresh identity that advances the preserved chain", () => {
	// The byte-fixed 0.1.0 snapshot, loaded exactly as a real session loads it.
	const branch = [legacyOpenAuditEntry()];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.deepEqual(store.get().blockedAudit, {
		blocker: "The test database is unavailable",
		turns: 2,
	});

	const cutoverPi = fakePi();
	const cutover = store.applyLegacyCutover(cutoverPi, {});
	assert.equal(cutover.ok, true);
	assert.equal(cutover.cutover, true);
	const repaired = goalStates(cutoverPi).at(-1);
	assert.equal(repaired.blockedAudit.blocker, "The test database is unavailable", "description preserved");
	assert.equal(repaired.blockedAudit.turns, 2, "count preserved");
	const issued = repaired.blockedAudit.blockerId;
	assert.match(issued, /^blocker_[0-9a-f]{8}$/);
	assert.notEqual(issued, "The test database is unavailable", "the identity is not derived from the text");
	assert.equal(cutoverPi.appended.length, 2, "the repaired snapshot and the cutover marker");

	// Same-condition advancement: the next report reuses the identity and satisfies
	// the preserved chain in exactly one durable transition, with no extra turns.
	const pi = fakePi();
	const advanced = store.markBlockedReport(pi, {
		blocker: "The test database is still unavailable",
		blockerId: issued,
		turn: 1,
	});
	assert.equal(advanced.ok, true);
	assert.equal(advanced.turns, 3, "the preserved count is honoured, not restarted");
	assert.equal(advanced.thresholdMet, true);
	assert.equal(store.get().status, "blocked");
	assert.equal(pi.appended.length, 1, "exactly one transition: no extra unattended turns");
	assert.equal(goalStates(pi).at(-1).blockedAudit.blockerId, issued, "the identity is unchanged");
});

it("the immutable legacy fixture's identity grants nothing when the next report omits it", () => {
	const store = new GoalStore();
	store.reconstruct(fakeCtx([legacyOpenAuditEntry()]));
	const cutoverPi = fakePi();
	store.applyLegacyCutover(cutoverPi, {});
	const issued = goalStates(cutoverPi).at(-1).blockedAudit.blockerId;

	// Omitting the identity reports a genuinely different condition, so the preserved
	// count is not inherited and no extra unattended turn is granted.
	const pi = fakePi();
	const omitted = store.markBlockedReport(pi, { blocker: "The test database is unavailable", turn: 1 });
	assert.equal(omitted.ok, true);
	assert.equal(omitted.turns, 1, "the fresh chain starts at one");
	assert.equal(omitted.thresholdMet, false);
	assert.equal(store.get().status, "active");
	assert.notEqual(goalStates(pi).at(-1).blockedAudit.blockerId, issued);

	// The spent identity cannot resume the chain the omission replaced.
	const stale = store.markBlockedReport(pi, {
		blocker: "The test database is unavailable",
		blockerId: issued,
		turn: 2,
	});
	assert.equal(stale.ok, false);
	assert.equal(stale.reason, "not-current");
});
