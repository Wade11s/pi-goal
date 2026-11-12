/**
 * Issue #7 narrow store tests: stale-transition mechanics that RPC cannot reach.
 *
 * Every model-side transition (update_goal) is bound to the Goal identity and
 * revision captured at `turn_start`, and Pi 1.5.1 rejects tree navigation while
 * a turn is streaming — so over real RPC a bound transition can never execute
 * against a Goal that a branch switch has replaced underneath it; the in-flight
 * binding is always refreshed or the run is refused outright. The one way the
 * binding *can* go stale mid-flight is a branch switch between binding capture
 * and mutation, which only an extension-internal race can produce. These tests
 * exercise that seam directly against GoalStore, plus the reconstruction
 * validation no clean RPC flow can produce (corrupt or future-versioned
 * snapshots in the session file).
 *
 * The store is imported straight from TypeScript; Node 22.6+ strips the
 * erasable syntax natively. On older Node the file skips (these mechanics are a
 * defense-in-depth layer, and the RPC suite remains the required gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let storeModule;
try {
	storeModule = await import("../src/store.ts");
} catch {
	storeModule = undefined;
}

const it = storeModule ? test : test.skip;
const { GoalStore } = storeModule ?? {};

/** Recording stand-in for the Pi extension API: appendEntry writes succeed. */
function fakePi() {
	const appended = [];
	return {
		appended,
		appendEntry(type, data) {
			appended.push({ type, data });
		},
	};
}

/** Branch-shaped stand-in for the extension context. */
function fakeCtx(branch) {
	return { sessionManager: { getBranch: () => branch } };
}

function goalEntry(goal) {
	return { type: "custom", customType: "goal-state", data: { version: 1, goal } };
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

it("a binding captured before a branch switch to another Goal identity is refused", () => {
	const store = new GoalStore();
	const goalA = record();
	const goalB = record({ id: "goal_bbbbbbbb", objective: "Other branch objective" });
	store.reconstruct(fakeCtx([goalEntry(goalA)]));
	const binding = { id: goalA.id, revision: 0 };

	// The branch switches to a different Goal before the mutation lands.
	store.reconstruct(fakeCtx([goalEntry(goalB)]));
	const pi = fakePi();
	const result = store.markComplete(pi, binding);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "stale");
	assert.match(result.message, /prepared against Goal goal_aaaaaaaa but the current Goal is goal_bbbbbbbb/);
	// A refused transition persists nothing.
	assert.equal(pi.appended.length, 0);
	// The selected branch's Goal is untouched and still active.
	assert.equal(store.get().id, "goal_bbbbbbbb");
	assert.equal(store.get().status, "active");
});

it("a binding captured before a branch switch to a newer revision is refused", () => {
	const store = new GoalStore();
	const goal = record();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const binding = { id: goal.id, revision: 0 };

	// The selected branch now holds a newer revision of the same Goal (an edit
	// or a pause+resume that happened on another branch line).
	store.reconstruct(fakeCtx([goalEntry({ ...goal, revision: 2, objective: "Newer objective" })]));
	const pi = fakePi();
	for (const mutate of [
		(pi) => store.markComplete(pi, binding),
		(pi) => store.markPaused(pi, binding),
	]) {
		const result = mutate(pi);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "stale");
		assert.match(result.message, /prepared against revision 0 but the Goal is now revision 2/);
	}
	assert.equal(pi.appended.length, 0);
});

it("a binding whose Goal was cleared on the selected branch finds no Goal to mutate", () => {
	const store = new GoalStore();
	const goal = record();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const binding = { id: goal.id, revision: 0 };

	// The selected branch cleared the Goal: the tombstone is the last valid
	// goal-state entry, and reconstruction must not fall back to the older
	// snapshot ahead of it.
	store.reconstruct(fakeCtx([goalEntry(goal), goalEntry(null)]));
	assert.equal(store.get(), null);
	const result = store.markComplete(fakePi(), binding);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "no-goal");
});

it("a fresh binding against the selected branch's state still mutates", () => {
	const store = new GoalStore();
	const goal = record();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	const completed = store.markComplete(pi, { id: goal.id, revision: 0 });
	assert.equal(completed.ok, true);
	assert.equal(completed.goal.status, "complete");
	assert.equal(completed.goal.revision, 1);
	assert.equal(pi.appended.length, 1);
	assert.equal(pi.appended[0].data.goal.status, "complete");
});

it("reconstruction fails closed on a malformed or unrecognized newest snapshot", () => {
	const store = new GoalStore();
	const goal = record();
	const branch = [
		goalEntry(goal),
		// Unknown lifecycle status: a hand-edited or future-versioned line.
		goalEntry({ ...goal, revision: 1, status: "half-finished" }),
		// Unknown snapshot version.
		{ type: "custom", customType: "goal-state", data: { version: 99, goal: { ...goal, revision: 2 } } },
		// Malformed record shape.
		goalEntry(42),
		// A different custom entry type entirely.
		{ type: "custom", customType: "someone-elses-state", data: { version: 1, goal: { ...goal, revision: 3 } } },
	];
	store.reconstruct(fakeCtx(branch));
	// The newest goal-state entry is malformed, so the branch fails closed. It must
	// not fall back to the older valid snapshot, which could resurrect a cleared,
	// replaced, or stopped Goal.
	assert.equal(store.get(), null);
	const notice = store.takeNotice();
	assert.ok(notice, "actionable guidance is exposed");
	assert.match(notice, /could not read the newest Goal snapshot/);

	// A later valid snapshot or tombstone still wins over an older malformed entry.
	store.reconstruct(
		fakeCtx([goalEntry(goal), goalEntry({ ...goal, status: "bogus" }), goalEntry({ ...goal, revision: 2 })]),
	);
	assert.equal(store.get().revision, 2);
	store.reconstruct(fakeCtx([goalEntry(goal), goalEntry({ ...goal, status: "bogus" }), goalEntry(null)]));
	assert.equal(store.get(), null);
});

it("a tombstone ahead of a corrupt later entry does not resurrect the Goal", () => {
	const store = new GoalStore();
	const goal = record();
	// The newest entry is corrupt, so the branch fails closed rather than adopting
	// the older tombstone's "no Goal" as a fallback.
	store.reconstruct(fakeCtx([goalEntry(goal), goalEntry(null), goalEntry({ ...goal, status: "bogus" })]));
	assert.equal(store.get(), null);
	assert.ok(store.takeNotice(), "the fail-closed path still explains itself");
});

it("reconstruction with no recognizable snapshot yields no Goal", () => {
	const store = new GoalStore();
	store.reconstruct(fakeCtx([{ type: "custom", customType: "goal-state", data: { version: 7 } }]));
	assert.equal(store.get(), null);
	store.reconstruct(fakeCtx([]));
	assert.equal(store.get(), null);
});
