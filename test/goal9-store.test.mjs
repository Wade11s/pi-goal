/**
 * Issue #24 batch 1 narrow store tests: retained-object isolation and the
 * branch-local legacy cutover mechanics that real RPC cannot reach exhaustively.
 *
 * The store is imported straight from TypeScript; Node 22.6+ strips the erasable
 * syntax natively. On older Node the file skips (the RPC suite remains the required
 * gate).
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

function fakePi() {
	const appended = [];
	return {
		appended,
		appendEntry(type, data) {
			appended.push({ type, data });
		},
	};
}

function fakeCtx(branch) {
	return { sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/session.jsonl" } };
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

let nextEntryId = 0;
function goalEntry(goal, extra = {}) {
	return {
		type: "custom",
		id: `gs-${nextEntryId++}`,
		customType: "goal-state",
		data: { version: 1, goal, ...extra },
	};
}

function cutoverEntry(goalId) {
	return {
		type: "custom",
		id: `co-${nextEntryId++}`,
		customType: "goal-cutover",
		data: { version: 1, goalId },
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

function assistantEntry(index, usage) {
	return { type: "message", id: `msg-${index}`, message: { role: "assistant", usage } };
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

it("a blocked report never aliases the snapshot the session manager keeps", () => {
	const store = new GoalStore();
	const goal = record({ usage: usage(0) });
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	store.beginGoalWork(goal.id);

	const pi = fakePi();
	const result = store.markBlockedReport(pi, { blocker: "The test database is down", turn: 1 });
	assert.equal(result.ok, true);
	const appended = pi.appended[0].data.goal;
	assert.equal(appended.blockedAudit.turns, 1);

	// Later live accounting publishes onto the live record only; the durable
	// snapshot must stay frozen.
	store.accountUsage("model:1", usageReport(100, 10), "model");
	assert.equal(store.get().usage.totalTokens, 110);
	assert.equal(appended.usage.totalTokens, 0, "the appended snapshot is not polluted");
	assert.notEqual(store.get(), appended, "the live record is a different object");
});

it("a conservative stop never aliases the snapshot the session manager keeps", () => {
	const store = new GoalStore();
	const goal = record();
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	store.beginGoalWork(goal.id);
	store.accountUsage("model:1", usageReport(100, 10), "model");

	const pi = fakePi();
	const result = store.stopGoal(pi, { status: "usage_limited", blocker: "quota exhausted", turns: 0 });
	assert.equal(result.ok, true);
	const appended = pi.appended[0].data.goal;
	store.accountUsage("model:2", usageReport(20, 2), "model");
	assert.equal(store.get().usage.totalTokens, 132);
	assert.equal(appended.usage.totalTokens, 110, "the stop snapshot stays frozen");
});

it("a durable audit reset never aliases the snapshot the session manager keeps", () => {
	const store = new GoalStore();
	const goal = record({ blockedAudit: { blocker: "The test database is down", turns: 1 } });
	store.reconstruct(fakeCtx([goalEntry(goal)]));

	const pi = fakePi();
	const result = store.resetBlockedAudit(pi);
	assert.equal(result.ok, true);
	const appended = pi.appended[0].data.goal;
	assert.equal(appended.blockedAudit, undefined);
	// The branch's own object is untouched too.
	assert.equal(goal.blockedAudit.turns, 1, "the reconstructed source object is not mutated");
});

it("a reconstructed record never aliases the branch entry object", () => {
	const store = new GoalStore();
	const goal = record({ usage: usage(0) });
	const branch = [goalEntry(goal)];
	store.reconstruct(fakeCtx(branch));
	store.beginGoalWork(goal.id);
	store.accountUsage("model:1", usageReport(100, 10), "model");
	assert.equal(store.get().usage.totalTokens, 110);
	assert.equal(branch[0].data.goal.usage.totalTokens, 0, "the branch snapshot object is not polluted");
});

it("a legacy snapshot is reconstructed once, cut over durably, and never migrated again", () => {
	const store = new GoalStore();
	const goal = record({ usage: usage(100, { inputTokens: 90, outputTokens: 10 }) });
	const branch = [goalEntry(goal), assistantEntry(0, usageReport(50, 5))];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.needsLegacyCutover(), true, "a snapshot without a cutover marker is legacy");
	// 0.1.0 rules charge every post-snapshot report: 100 + 55.
	assert.equal(store.getUsage().totalTokens, 155);

	const pi = fakePi();
	const result = store.applyLegacyCutover(pi, {});
	assert.equal(result.ok, true);
	assert.equal(result.cutover, true);
	assert.equal(store.needsLegacyCutover(), false);
	assert.equal(pi.appended.length, 2, "the repaired snapshot plus the branch-local marker");
	assert.equal(pi.appended[0].data.repaired, true);
	assert.equal(pi.appended[0].data.goal.id, goal.id, "identity is preserved");
	assert.equal(pi.appended[0].data.goal.usage.totalTokens, 155, "legacy reconstructed total is frozen");
	assert.equal(pi.appended[1].data.goalId, goal.id);

	// A later selection of the cut-over branch performs no second migration.
	store.reconstruct(fakeCtx([...branch, ...pi.appended.map((e) => ({ type: "custom", id: `x-${e.type}`, customType: e.type, data: e.data }))]));
	assert.equal(store.needsLegacyCutover(), false);
	const second = store.applyLegacyCutover(fakePi(), {});
	assert.equal(second.ok, true);
	assert.equal(second.cutover, false);
});

it("a pre-cutover fork performs its own migration while a post-cutover fork inherits the baseline", () => {
	const goal = record({ usage: usage(100, { inputTokens: 90, outputTokens: 10 }) });
	const legacySnapshot = goalEntry(goal);
	const legacyBranch = [legacySnapshot, assistantEntry(0, usageReport(50, 5))];

	// Fork copied before the cutover: no marker, so it migrates itself.
	const forkStore = new GoalStore();
	forkStore.reconstruct(fakeCtx(legacyBranch));
	assert.equal(forkStore.needsLegacyCutover(), true);
	const forkPi = fakePi();
	forkStore.applyLegacyCutover(forkPi, {});
	assert.equal(forkPi.appended.length, 2);

	// Fork copied after the cutover: the repaired snapshot and marker are present.
	const cutOverBranch = [
		legacySnapshot,
		...forkPi.appended.map((e) => ({ type: "custom", id: `y-${e.type}`, customType: e.type, data: e.data })),
	];
	const inherited = new GoalStore();
	inherited.reconstruct(fakeCtx(cutOverBranch));
	assert.equal(inherited.needsLegacyCutover(), false, "the baseline is inherited");
	assert.equal(inherited.getUsage().totalTokens, 155);
});

it("the configured maximum clamps an unbounded legacy Goal with a notice and never applies the default", () => {
	const store = new GoalStore();
	const goal = record({ usage: usage(100, { inputTokens: 90, outputTokens: 10 }) });
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	const result = store.applyLegacyCutover(pi, { maxTokenBudget: 500 });
	assert.equal(result.ok, true);
	assert.equal(result.notices.length, 1);
	assert.match(result.notices[0], /configured maximum token budget of 500/);
	assert.equal(store.get().tokenBudget, 500);
	assert.equal(store.get().usage.totalTokens, 100, "usage is preserved");
});

it("an active legacy Goal already at its budget becomes budget_limited before work", () => {
	const store = new GoalStore();
	const goal = record({
		tokenBudget: 100,
		usage: usage(110, { inputTokens: 100, outputTokens: 10 }),
	});
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	const result = store.applyLegacyCutover(pi, {});
	assert.equal(result.ok, true);
	assert.equal(store.get().status, "budget_limited");
	assert.equal(store.get().wrapUpPending, true, "it earns exactly one bounded wrap-up");
	assert.match(result.notices[0], /already at its token budget/);
});

it("0.1.0 optional-field defaults are preserved by the cutover", () => {
	const store = new GoalStore();
	const goal = record();
	delete goal.origin;
	delete goal.usage;
	delete goal.wrapUpPending;
	delete goal.blockedAudit;
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	assert.equal(store.get().origin, undefined);
	assert.equal(store.getUsage().totalTokens, 0, "absent usage is a zero baseline");
	const pi = fakePi();
	const result = store.applyLegacyCutover(pi, {});
	assert.equal(result.ok, true);
	assert.equal(store.get().origin, undefined);
	assert.equal(store.get().wrapUpPending, undefined);
	assert.equal(store.get().blockedAudit, undefined);
});
