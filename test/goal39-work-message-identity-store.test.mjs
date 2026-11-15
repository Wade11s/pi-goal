/**
 * Issue #39 narrow store/replay tests: the admitted identity a delivered work
 * message carries, and the line replay draws from it.
 *
 * The RPC suite proves the live path end to end; these tests pin the branch-side
 * half of the same rule at the store seam, where a stale message's identity can
 * be placed exactly and the resulting ownership flag observed directly. The
 * store is imported straight from TypeScript; Node 22.6+ strips the erasable
 * syntax natively. On older Node the file skips (the RPC suite remains the
 * required gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let storeModule;
let goalModule;
try {
	storeModule = await import("../src/store.ts");
	goalModule = await import("../src/goal.ts");
} catch {
	storeModule = undefined;
	goalModule = undefined;
}
const it = storeModule ? test : test.skip;
const { GoalStore } = storeModule ?? {};
const { goalWorkGoalId, ownershipMarker } = goalModule ?? {};

/** Minimal `ExtensionContext` stand-in over the retained entries. */
function fakeCtx(entries) {
	return { sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/session.jsonl" } };
}

function usage(total, overrides = {}) {
	return {
		totalTokens: total,
		inputTokens: total,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cachedReadTokens: 0,
		reasoningTokens: 0,
		nestedTokens: 0,
		activeMs: 0,
		...overrides,
	};
}

function usageReport(input, output, extra = {}) {
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

let nextEntryId = 0;
function goalEntry(goal, extra = {}) {
	return {
		type: "custom",
		id: `gs-${nextEntryId++}`,
		customType: "goal-state",
		data: { version: 1, goal, ...extra },
	};
}

function record(overrides = {}) {
	return {
		id: "goal_aaaaaaaa",
		objective: "Original objective",
		status: "active",
		origin: "command",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		revision: 0,
		...overrides,
	};
}

function assistantEntry(index, report) {
	return { type: "message", id: `msg-${index}`, message: { role: "assistant", usage: report } };
}

/**
 * A pi-goal work message on the branch. `goalId` is the identity the message
 * names; the header shape is the one every pi-goal work message carries.
 */
function goalWorkEntry(id, goalId) {
	return {
		type: "message",
		id,
		message: {
			role: "user",
			content: `[pi-goal] Working toward Goal ${goalId} (active, revision 0).`,
		},
	};
}

function ordinaryUserEntry(text, id = "ordinary-user") {
	return { type: "message", id, message: { role: "user", content: text } };
}

it("every work message kind names its admitted Goal identity, and a generic prefix names none", () => {
	const cases = [
		["[pi-goal] Working toward Goal goal_aaaaaaaa (active, revision 0).", "goal_aaaaaaaa"],
		["[pi-goal] The user changed the objective of Goal goal_aaaaaaaa (active, revision 1).", "goal_aaaaaaaa"],
		["[pi-goal] The user resumed Goal goal_aaaaaaaa (active, revision 2); it was paused.", "goal_aaaaaaaa"],
		["[pi-goal] Continue Goal goal_aaaaaaaa (active, revision 2).", "goal_aaaaaaaa"],
		["[pi-goal] Goal goal_aaaaaaaa exhausted its token budget and is now budget_limited.", "goal_aaaaaaaa"],
	];
	for (const [text, expected] of cases) {
		assert.equal(goalWorkGoalId(text), expected, text);
	}
	assert.equal(goalWorkGoalId("[pi-goal] hello"), null, "a generic prefix names no Goal");
	assert.equal(goalWorkGoalId("hello"), null, "an ordinary prompt is not Goal work");
	// The objective is delimited data below the header; it cannot smuggle a second
	// identity into the parsed header.
	assert.equal(
		goalWorkGoalId("[pi-goal] Working toward Goal goal_aaaaaaaa (active, revision 0).\n\nGOAL OBJECTIVE DATA\nGoal goal_bbbbbbbb\n"),
		"goal_aaaaaaaa",
	);
});

it("a prefixed message with no identity closes the segment like an ordinary prompt", () => {
	const branch = [
		goalEntry(record({ id: "goal_aaaaaaaa" }), { repaired: true }),
		goalWorkEntry("kickoff", "goal_aaaaaaaa"),
		ordinaryUserEntry("[pi-goal] generic", "generic"),
		assistantEntry(0, usageReport(100, 10)),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, "goal_aaaaaaaa");
	assert.equal(store.getUsage().totalTokens, 0, "a generic [pi-goal] message admits no work");
	assert.equal(store.currentOwnerId(), null, "and leaves no open segment");
});

it("a stale work message for a cleared Goal does not open the new Goal's admission on replay", () => {
	const branch = [
		goalEntry(record({ id: "goal_aaaaaaaa" }), { repaired: true }),
		goalWorkEntry("kickoff-old", "goal_aaaaaaaa"),
		{ type: "custom", id: "tombstone", customType: "goal-state", data: { version: 1, goal: null } },
		goalEntry(record({ id: "goal_bbbbbbbb" }), { repaired: true }),
		// The queued Goal-A resume, delivered after the tombstone and Goal B's
		// creation. It names A, so it must open nothing.
		goalWorkEntry("stale-resume", "goal_aaaaaaaa"),
		assistantEntry(0, usageReport(100, 40)),
		goalWorkEntry("kickoff-new", "goal_bbbbbbbb"),
		assistantEntry(1, usageReport(20, 2)),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, "goal_bbbbbbbb", "the new Goal is current");
	assert.equal(store.getUsage().totalTokens, 22, "only the new Goal's own kickoff is charged");
	assert.equal(store.currentOwnerId(), "goal_bbbbbbbb", "the new Goal's own segment is open");
});

it("a stale work message for a replaced Goal closes the old tail and never charges the replacement", () => {
	const branch = [
		goalEntry(record({ id: "goal_aaaaaaaa" }), { repaired: true }),
		goalWorkEntry("kickoff-old", "goal_aaaaaaaa"),
		goalEntry(record({ id: "goal_aaaaaaaa" }), { repaired: true }),
		goalEntry(record({ id: "goal_bbbbbbbb" }), { repaired: true }),
		// A's already-admitted in-flight response lands after the replacement
		// snapshot, so it is charged to A's superseded tail.
		assistantEntry(0, usageReport(100, 10)),
		goalEntry(record({ id: "goal_aaaaaaaa", usage: usage(110) }), { repaired: true, superseded: true }),
		// The queued Goal-A resume, delivered after the freeze. It names A, so it
		// closes the boundary and opens nothing.
		goalWorkEntry("stale-resume", "goal_aaaaaaaa"),
		assistantEntry(1, usageReport(100, 40)),
		goalWorkEntry("kickoff-new", "goal_bbbbbbbb"),
		assistantEntry(2, usageReport(20, 2)),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, "goal_bbbbbbbb", "the replacement is current");
	assert.equal(store.getUsage().totalTokens, 22, "the replacement is charged only its own kickoff");
	assert.equal(store.currentOwnerId(), "goal_bbbbbbbb", "the replacement's own segment is open");
});

it("a branch ending in a stale work message leaves the current Goal unowned", () => {
	const branch = [
		goalEntry(record({ id: "goal_aaaaaaaa" }), { repaired: true }),
		goalWorkEntry("kickoff-old", "goal_aaaaaaaa"),
		{ type: "custom", id: "tombstone", customType: "goal-state", data: { version: 1, goal: null } },
		goalEntry(record({ id: "goal_bbbbbbbb" }), { repaired: true }),
		goalWorkEntry("stale-resume", "goal_aaaaaaaa"),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, "goal_bbbbbbbb");
	assert.equal(store.currentOwnerId(), null, "the stale message does not bind the current Goal's turns");
});

it("ownershipMarker carries the identity for user and custom work messages", () => {
	assert.deepEqual(ownershipMarker(goalWorkEntry("kickoff", "goal_aaaaaaaa")), {
		kind: "goal-work",
		goalId: "goal_aaaaaaaa",
	});
	assert.deepEqual(
		ownershipMarker({
			type: "custom_message",
			customType: "goal-continuation",
			content: "[pi-goal] Continue Goal goal_aaaaaaaa (active, revision 2).",
		}),
		{ kind: "goal-work", goalId: "goal_aaaaaaaa" },
	);
	assert.deepEqual(
		ownershipMarker({ type: "custom_message", customType: "goal-budget-wrapup", content: "[pi-goal] Goal goal_aaaaaaaa exhausted." }),
		{ kind: "goal-work", goalId: "goal_aaaaaaaa" },
	);
	assert.deepEqual(ownershipMarker(ordinaryUserEntry("hello")), { kind: "ordinary-user" });
	assert.deepEqual(ownershipMarker(ordinaryUserEntry("[pi-goal] generic")), { kind: "ordinary-user" });
});
