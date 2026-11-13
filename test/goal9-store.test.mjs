/**
 * Issue #24 batch 1 narrow store tests: retained-object isolation, the
 * branch-local legacy cutover mechanics that real RPC cannot reach exhaustively,
 * and the superseded identity's tail across every boundary that would otherwise
 * drop it.
 *
 * The store is imported straight from TypeScript; Node 22.6+ strips the erasable
 * syntax natively. On older Node the file skips (the RPC suite remains the required
 * gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Every entry a fake Pi accepted, as the branch entries a reload reads back. */
function asBranch(pi) {
	return pi.appended.map((entry, index) => ({
		type: "custom",
		id: `appended-${index}`,
		customType: entry.type,
		data: entry.data,
	}));
}

/** A context whose session file really exists, for the durability check. */
function durableCtx(file) {
	return { sessionManager: { getBranch: () => [], getSessionFile: () => file } };
}

/** Write `entries` as a session file and return a context that reads it back. */
function writeSessionFile(entries) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-store-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		entries.map((entry) => JSON.stringify({ type: "custom", customType: entry.type, data: entry.data })).join("\n") +
			"\n",
		"utf8",
	);
	return { file, dir };
}

/** Every finalized goal-state entry a fake Pi accepted, in append order. */
function appendedGoalStates(pi) {
	return pi.appended.filter((entry) => entry.type === "goal-state");
}

/** Every superseded (finalized historical) snapshot a fake Pi accepted. */
function appendedSuperseded(pi) {
	return appendedGoalStates(pi).filter((entry) => entry.data.superseded === true);
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

/** A tool result entry carrying reported nested usage, as the session manager persists it. */
function toolResultEntry(toolCallId, usageReport) {
	return {
		type: "message",
		id: `tool-${toolCallId}`,
		message: { role: "toolResult", toolCallId, usage: usageReport },
	};
}

/** An ordinary user prompt on the branch, which closes any open segment. */
function ordinaryUserEntry(text) {
	return { type: "message", id: "ordinary-user", message: { role: "user", content: text } };
}

/** A pi-goal work message on the branch, which opens a Goal-owned segment. */
function goalWorkEntry(id = "kickoff") {
	return {
		type: "message",
		id,
		message: {
			role: "user",
			content: "[pi-goal] Working toward Goal goal_aaaaaaaa (active, revision 0).",
		},
	};
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

it("a replacement attributes the superseded identity's in-flight assistant and tool-result tail", () => {
	// A replacement commits while the old identity's provider request is still in
	// flight. The old admission stays open past commit(), so the response and its
	// nested tool result are charged to the old identity, then frozen onto a
	// superseded snapshot when the next user message is delivered.
	const store = new GoalStore();
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	store.reconstruct(fakeCtx([goalEntry(previous)]));
	store.beginGoalWork(previous.id);

	const pi = fakePi();
	store.preserveSupersededForReplacement(pi);
	assert.equal(pi.appended.length, 1, "the already-accounted superseded snapshot is written first");
	assert.equal(pi.appended[0].data.goal.id, previous.id);
	assert.equal(pi.appended[0].data.goal.usage.totalTokens, 0);

	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	store.stage(pi, replacement);
	store.commit(replacement);
	assert.equal(store.get()?.id, replacement.id);
	assert.equal(store.getUsage().totalTokens, 0, "the replacement starts at zero");

	// The old response lands after the replacement snapshot and is bound to the old
	// identity by the turn seam.
	const assistant = store.accountUsage("model:1", usageReport(100, 10), "model", previous.id);
	assert.equal(assistant?.totalTokens, 110);
	// Its nested tool result carries no turn binding, so it follows the open segment.
	const nested = store.accountUsage("toolResult:call_1", usageReport(40, 7, { cacheWrite: 3 }), "nested");
	assert.equal(nested?.totalTokens, 50);
	assert.equal(store.getUsage().totalTokens, 0, "the replacement is not charged for the old tail");

	store.closeSupersededSegment(pi);
	const finalized = pi.appended
		.filter((e) => e.type === "goal-state" && e.data.goal.id === previous.id)
		.at(-1);
	assert.equal(finalized.data.goal.usage.totalTokens, 160, "the exact assistant plus tool-result tail");
	assert.equal(finalized.data.goal.usage.nestedTokens, 50);
	assert.equal(finalized.data.goal.status, "active");
	// The freeze is the *only* append, and it is marked superseded: there is no
	// second write to lose, and it can never become the current Goal.
	assert.equal(pi.appended.at(-1).data.goal.id, previous.id);
	assert.equal(pi.appended.at(-1).data.superseded, true);
	assert.equal(appendedSuperseded(pi).length, 1);

	// The replacement stays current without being re-affirmed.
	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi)]));
	assert.equal(reloaded.get()?.id, replacement.id, "the replacement is still the current Goal");
	assert.equal(reloaded.getUsage().totalTokens, 0);
});

it("the superseded snapshot carries the exact already-accounted totals", () => {
	const store = new GoalStore();
	const previous = record({
		id: "goal_aaaaaaaa",
		usage: usage(45, { inputTokens: 40, outputTokens: 5 }),
	});
	store.reconstruct(fakeCtx([goalEntry(previous)]));
	store.beginGoalWork(previous.id);
	const pi = fakePi();
	store.preserveSupersededForReplacement(pi);
	assert.equal(pi.appended[0].data.goal.usage.totalTokens, 45);
	assert.equal(pi.appended[0].data.goal.usage.inputTokens, 40);
	assert.equal(pi.appended[0].data.goal.usage.outputTokens, 5);
});

it("old-budget exhaustion is recorded on the superseded record and never on the replacement", () => {
	const store = new GoalStore();
	const previous = record({ id: "goal_aaaaaaaa", tokenBudget: 100, usage: usage(0) });
	store.reconstruct(fakeCtx([goalEntry(previous)]));
	store.beginGoalWork(previous.id);
	const pi = fakePi();
	store.preserveSupersededForReplacement(pi);
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	store.stage(pi, replacement);
	store.commit(replacement);

	store.accountUsage("model:1", usageReport(110, 0), "model", previous.id);
	store.accountUsage("toolResult:call_1", usageReport(40, 7, { cacheWrite: 3 }), "nested");
	store.closeSupersededSegment(pi);

	const finalized = pi.appended
		.filter((e) => e.type === "goal-state" && e.data.goal.id === previous.id)
		.at(-1);
	assert.equal(finalized.data.goal.status, "budget_limited", "the old identity's exhaustion is recorded");
	assert.equal(finalized.data.goal.usage.totalTokens, 160, "the in-flight tail is still attributed");
	assert.equal(store.get()?.id, replacement.id);
	assert.equal(store.getUsage().totalTokens, 0, "the replacement is not charged and does not inherit the stop");
	assert.equal(store.get()?.status, "active");
});

/**
 * The state a steered replacement leaves behind: the old identity's
 * already-accounted snapshot, the replacement's snapshot, and the old identity's
 * in-flight response plus nested tool result charged to its still-open admission.
 *
 * Every boundary test below starts from this precondition, which is the one the
 * reviewer reproduced independently.
 */
function replaceWithTailInFlight() {
	const store = new GoalStore();
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const branch = [goalEntry(previous, { repaired: true })];
	store.reconstruct(fakeCtx(branch));
	store.beginGoalWork(previous.id);
	const pi = fakePi();
	store.preserveSupersededForReplacement(pi);
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	store.stage(pi, replacement);
	store.commit(replacement);
	// The old response is bound to the old identity by the turn seam; its nested
	// tool result carries no binding and follows the open segment.
	store.accountUsage("model:1", usageReport(100, 10), "model", previous.id);
	store.accountUsage("toolResult:call_1", usageReport(40, 7, { cacheWrite: 3 }), "nested");
	return { store, previous, replacement, branch, pi };
}

it("Clear keeps the superseded identity's already-accounted open tail through the tombstone", () => {
	// The old tail landed before Clear, but its admission is still open: Clear of
	// the replacement does not erase work already admitted for the superseded
	// identity, so the tail stays open past the tombstone and is frozen at the
	// next boundary instead of being dropped.
	const { store, previous, pi } = replaceWithTailInFlight();

	const cleared = store.clear(pi);
	assert.equal(cleared.ok, true);

	const states = appendedGoalStates(pi);
	assert.equal(states.at(-1).data.goal, null, "the tombstone is the newest state");
	assert.equal(appendedSuperseded(pi).length, 0, "Clear does not freeze an open tail");
	assert.equal(store.get(), null, "Clear still leaves no Goal");
	assert.equal(store.hasOpenSupersededTail(), true, "the old admission stays open past the tombstone");

	// The next delivered user message is the freeze boundary.
	store.closeSupersededSegment(pi);
	const frozen = appendedSuperseded(pi);
	assert.equal(frozen.length, 1);
	assert.equal(frozen[0].data.goal.id, previous.id, "the tail stays with the identity that was replaced");
	assert.equal(frozen[0].data.goal.usage.totalTokens, 160, "the exact assistant plus tool-result tail");
	assert.equal(frozen[0].data.goal.usage.nestedTokens, 50);

	// The branch replays to the same place: no Goal, and the old identity's total
	// is durable history rather than work that belonged to nobody.
	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi)]));
	assert.equal(reloaded.get(), null);
});

it("Clear keeps the superseded identity's admission open so a later response stays attributed", () => {
	// A replacement commits while A's provider request is still in flight. Clear
	// of the replacement lands *before* A's response is finalized: the old
	// identity's admission must stay open past the tombstone, so the response and
	// its nested tool result are still charged to A rather than dropped.
	const store = new GoalStore();
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	store.reconstruct(fakeCtx([goalEntry(previous)]));
	store.beginGoalWork(previous.id);
	const pi = fakePi();
	store.preserveSupersededForReplacement(pi);
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	store.stage(pi, replacement);
	store.commit(replacement);

	const cleared = store.clear(pi);
	assert.equal(cleared.ok, true);
	assert.equal(store.get(), null, "Clear leaves no current Goal");

	// A's response lands after the tombstone. It was admitted for A, so it is
	// charged to A's superseded tail, not dropped.
	const assistant = store.accountUsage("model:1", usageReport(100, 10), "model", previous.id);
	assert.equal(assistant?.totalTokens, 110);
	const nested = store.accountUsage("toolResult:call_1", usageReport(40, 7, { cacheWrite: 3 }), "nested");
	assert.equal(nested?.totalTokens, 50);

	// The next delivered user message is the freeze boundary.
	store.closeSupersededSegment(pi);
	const states = appendedGoalStates(pi);
	const frozen = states.at(-1);
	assert.equal(frozen.data.superseded, true, "the tail is frozen as history");
	assert.equal(frozen.data.goal.id, previous.id);
	assert.equal(frozen.data.goal.usage.totalTokens, 160);
	assert.equal(frozen.data.goal.usage.nestedTokens, 50);

	// Replay recovers the same history: the newest non-superseded entry is the
	// tombstone, but the superseded freeze is durable and no Goal is current.
	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi)]));
	assert.equal(reloaded.get(), null, "no current Goal after Clear");
});

it("Clear refuses to commit when an already-accounted tail cannot be frozen", () => {
	// The superseded identity's tail is already accounted and its admission is
	// closed (a delivered user message closed it, but the freeze write failed).
	// Clear must not erase that work: it refuses to write the tombstone instead.
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
		{
			type: "custom",
			id: "checkpoint",
			customType: "goal-usage",
			data: {
				version: 1,
				goalId: previous.id,
				usage: usage(160, { inputTokens: 140, outputTokens: 10, cacheWriteTokens: 3, nestedTokens: 50 }),
			},
		},
		ordinaryUserEntry("anything else?"),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, replacement.id, "the replacement is current");

	const failing = fakePi();
	const append = failing.appendEntry.bind(failing);
	failing.appendEntry = (type, data) => {
		if (type === "goal-state" && data.superseded === true) throw new Error("disk full");
		return append(type, data);
	};
	const cleared = store.clear(failing);
	assert.equal(cleared.ok, false, "Clear is refused");
	assert.equal(cleared.reason, "persistence");
	assert.equal(store.get()?.id, replacement.id, "the replacement stays current");
	assert.equal(appendedGoalStates(failing).length, 0, "no tombstone was written");

	// The already-accounted tail survives for the next boundary.
	const retry = fakePi();
	const frozen = store.closeSupersededSegment(retry);
	assert.equal(frozen?.id, previous.id);
	assert.equal(frozen?.usage.totalTokens, 160, "the tail survived the failed write");
	assert.equal(appendedSuperseded(retry).length, 1);
});

it("replay recovers a superseded tail when the newest non-superseded entry is a tombstone", () => {
	// A→B, A's in-flight tail lands, then Clear B writes the tombstone, and the
	// process dies before any freeze boundary. The newest non-superseded entry is
	// the tombstone, but A's admitted work is on the branch and must be recovered.
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
		{ type: "custom", id: "tombstone", customType: "goal-state", data: { version: 1, goal: null } },
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get(), null, "the tombstone leaves no current Goal");

	const pi = fakePi();
	const frozen = store.closeSupersededSegment(pi);
	assert.equal(frozen?.id, previous.id, "the recovered tail is frozen");
	assert.equal(frozen?.usage.totalTokens, 160);
	assert.equal(frozen?.usage.nestedTokens, 50);
	assert.equal(appendedSuperseded(pi).length, 1);
});

it("a recovered superseded tail is frozen as history and never resurrects the old Goal", () => {
	// The branch a crash leaves after Clear: the tombstone is the newest
	// non-superseded entry, and the old identity's tail has no freeze yet. The
	// recovered tail must be written as a superseded historical record, and a
	// reload of the branch including that freeze must still have no current Goal.
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
		{ type: "custom", id: "tombstone", customType: "goal-state", data: { version: 1, goal: null } },
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get(), null);

	const pi = fakePi();
	store.closeSupersededSegment(pi);
	const frozen = appendedSuperseded(pi);
	assert.equal(frozen.length, 1, "the recovered tail is frozen");
	assert.equal(frozen[0].data.superseded, true, "the freeze is historical");
	assert.equal(frozen[0].data.goal.id, previous.id);
	assert.equal(frozen[0].data.goal.usage.totalTokens, 160);

	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([...branch, ...asBranch(pi)]));
	assert.equal(reloaded.get(), null, "the freeze never resurrects the old Goal");
	assert.equal(reloaded.getUsage().totalTokens, 0);
});

it("a second replacement freezes the first identity's open tail before the second preserve", () => {
	// A→B, the old tail lands, then B→C before any delivered user message. The tail
	// belongs to A, so freezing it must not wait for the boundary that never comes.
	const { store, previous, pi } = replaceWithTailInFlight();
	const second = record({ id: "goal_cccccccc", usage: usage(0) });

	store.preserveSupersededForReplacement(pi);
	store.stage(pi, second);
	store.commit(second);

	const states = appendedGoalStates(pi);
	// After the replacement snapshot: A's freeze, then B's already-accounted
	// snapshot, then C's snapshot.
	assert.equal(states.at(-3).data.goal.id, previous.id);
	assert.equal(states.at(-3).data.superseded, true);
	assert.equal(states.at(-3).data.goal.usage.totalTokens, 160, "the first tail is frozen, not overwritten");
	assert.equal(states.at(-2).data.goal.id, "goal_bbbbbbbb");
	assert.equal(states.at(-2).data.superseded, undefined, "the second preserve is the replacement's own snapshot");
	assert.equal(states.at(-2).data.goal.usage.totalTokens, 0, "the replacement's tail is not transferred to it");
	assert.equal(states.at(-1).data.goal.id, second.id);
	assert.equal(store.get()?.id, second.id);

	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi)]));
	assert.equal(reloaded.get()?.id, second.id, "the newest replacement is current");
	assert.equal(reloaded.getUsage().totalTokens, 0);
});

it("a durability rollback restores the old identity together with its open tail", () => {
	// The replacement's durability could not be confirmed while the old response
	// was in flight. The restored record must carry the admitted tail: the entries
	// sit *before* the restore snapshot, so no later replay can recover them.
	const { store, previous, replacement, pi } = replaceWithTailInFlight();
	const captured = store.get();
	assert.ok(captured);

	const restored = store.restore(pi, previous);
	assert.equal(restored.ok, true);

	const states = appendedGoalStates(pi);
	assert.equal(states.at(-2).data.goal.id, previous.id);
	assert.equal(states.at(-2).data.superseded, true, "the tail is frozen as history first");
	assert.equal(states.at(-2).data.goal.usage.totalTokens, 160);
	const last = states.at(-1);
	assert.equal(last.data.goal.id, previous.id, "the previous identity is restored");
	assert.equal(last.data.superseded, undefined);
	assert.equal(last.data.goal.usage.totalTokens, 160, "the restored record carries the admitted tail");

	// A reload reconstructs the restored identity at its real total.
	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi)]));
	assert.equal(reloaded.get()?.id, previous.id);
	assert.equal(reloaded.getUsage().totalTokens, 160, "the restored total survives the reload");
	assert.notEqual(reloaded.get()?.id, replacement.id);
});

it("a failed freeze write keeps the tail for the next boundary", () => {
	// A write failure must not throw into the event handler that called it, and it
	// must not drop the tail: the next boundary is the next chance to persist it.
	const { store, previous, replacement, pi } = replaceWithTailInFlight();
	const failing = fakePi();
	const append = failing.appendEntry.bind(failing);
	failing.appendEntry = (type, data) => {
		if (type === "goal-state" && data.superseded === true) throw new Error("disk full");
		return append(type, data);
	};

	assert.equal(store.closeSupersededSegment(failing), null, "the failure is reported, not thrown");
	assert.equal(appendedSuperseded(failing).length, 0, "nothing was written");

	const retry = fakePi();
	const frozen = store.closeSupersededSegment(retry);
	assert.equal(frozen?.id, previous.id);
	assert.equal(frozen?.usage.totalTokens, 160, "the tail survived the failed write");
	assert.equal(appendedSuperseded(retry).length, 1);

	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi), ...asBranch(retry)]));
	assert.equal(reloaded.get()?.id, replacement.id, "the replacement is still current after the retry");
	assert.equal(reloaded.getUsage().totalTokens, 0);
});

it("a crash right after the freeze append never resurrects the superseded Goal", () => {
	// The freeze is one append and the superseded marker is what makes it safe: a
	// crash between it and any later write leaves the newest goal-state entry being
	// a historical record of the replaced identity, which must not become current.
	const { store, previous, replacement, pi } = replaceWithTailInFlight();
	store.closeSupersededSegment(pi);
	const states = appendedGoalStates(pi);
	assert.equal(states.at(-1).data.goal.id, previous.id, "the freeze is the newest goal-state entry");
	assert.equal(states.at(-1).data.superseded, true);

	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([goalEntry(record({ id: previous.id })), ...asBranch(pi)]));
	assert.equal(reloaded.get()?.id, replacement.id, "the replacement stays current across the crash window");
	assert.equal(reloaded.get()?.status, "active");
	assert.equal(reloaded.getUsage().totalTokens, 0, "and the old tail is not charged to it");

	// The freeze landing after the replacement snapshot must not defeat the
	// replacement's durability check either.
	const { file, dir } = writeSessionFile(pi.appended);
	try {
		assert.equal(reloaded.isDurable(durableCtx(file), replacement.id), true);
		assert.equal(reloaded.isDurable(durableCtx(file), previous.id), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("a hard crash between the old tail and its freeze boundary recovers the tail on the next load", () => {
	// The branch a SIGKILL leaves: the replacement snapshot, the old identity's
	// in-flight response and tool result, and no freeze boundary after them. The
	// tail was admitted, so the next load has to recover it rather than drop it.
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, replacement.id, "the replacement is current");
	assert.equal(store.getUsage().totalTokens, 0, "the old tail is not charged to it");

	// The first durable boundary of the new runtime freezes the recovered tail.
	const pi = fakePi();
	store.closeSupersededSegment(pi);
	const frozen = appendedSuperseded(pi);
	assert.equal(frozen.length, 1);
	assert.equal(frozen[0].data.goal.id, previous.id);
	assert.equal(frozen[0].data.goal.usage.totalTokens, 160, "the exact tail is recovered");
	assert.equal(frozen[0].data.goal.usage.nestedTokens, 50);

	const reloaded = new GoalStore();
	reloaded.reconstruct(fakeCtx([...branch, ...asBranch(pi)]));
	assert.equal(reloaded.get()?.id, replacement.id);
	assert.equal(reloaded.getUsage().totalTokens, 0, "the reload converges on the live view");
	assert.equal(reloaded.hasOpenSupersededTail(), false, "no segment is open at the end of the branch");
	assert.equal(reloaded.currentOwnerId(), null, "no current owner at the end of the branch");
});

it("a reload does not rewrite a tail that is already durable", () => {
	// The freeze is on the branch, so a reload must adopt it instead of appending
	// the same historical snapshot again on every load.
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
		goalEntry(
			record({
				id: "goal_aaaaaaaa",
				usage: usage(160, { inputTokens: 140, outputTokens: 10, cacheWriteTokens: 3, nestedTokens: 50 }),
			}),
			{ repaired: true, superseded: true },
		),
		goalWorkEntry("steer-new"),
		assistantEntry(2, usageReport(20, 2)),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, replacement.id);
	assert.equal(store.getUsage().totalTokens, 22, "only the replacement's own steered work is charged");

	const pi = fakePi();
	store.closeSupersededSegment(pi);
	assert.equal(pi.appended.length, 0, "the durable freeze is adopted, not rewritten");
});

it("a recovered open tail does not steal the replacement's own open segment", () => {
	// The replacement's kickoff was delivered, but its freeze write failed, so the
	// branch carries the old tail *and* the replacement's own open segment. The
	// live segment is the one new turns bind to; the recovered tail is only history
	// waiting for its next durable boundary.
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
		goalWorkEntry("steer-new"),
		assistantEntry(2, usageReport(20, 2)),
	];
	const store = new GoalStore();
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.currentOwnerId(), replacement.id, "the replacement's own segment is the live one");
	assert.equal(store.getUsage().totalTokens, 22, "the replacement's own work is charged to it");

	const pi = fakePi();
	store.closeSupersededSegment(pi);
	const frozen = appendedSuperseded(pi);
	assert.equal(frozen.length, 1, "the recovered tail is still frozen at the next boundary");
	assert.equal(frozen[0].data.goal.id, previous.id);
	assert.equal(frozen[0].data.goal.usage.totalTokens, 160);
});

it("a branch of only superseded snapshots, or a tombstone after one, leaves no current Goal", () => {
	// A superseded snapshot is history. A branch that holds nothing else has no
	// current Goal, and a tombstone followed by one still means "cleared".
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });

	const only = new GoalStore();
	only.reconstruct(fakeCtx([goalEntry(previous, { repaired: true, superseded: true })]));
	assert.equal(only.get(), null, "history alone is not a current Goal");
	assert.equal(only.getUsage().totalTokens, 0);

	const afterTombstone = new GoalStore();
	afterTombstone.reconstruct(
		fakeCtx([
			{ type: "custom", id: "tombstone", customType: "goal-state", data: { version: 1, goal: null } },
			goalEntry(previous, { repaired: true, superseded: true }),
		]),
	);
	assert.equal(afterTombstone.get(), null, "a later historical snapshot cannot resurrect a cleared Goal");
});

it("replay attributes the superseded tail to the old identity and keeps the replacement at zero", () => {
	// The branch after a steered replacement: old creation, old kickoff, the
	// already-accounted superseded snapshot, the new creation, the old in-flight
	// response and tool result, the finalized old snapshot, and then the steered new
	// kickoff and its response. The old tail sits before the finalized snapshot, so
	// replay never recharges it; the new Goal's baseline is the replacement's own
	// snapshot, so it charges only its own work. No re-affirmation is written: the
	// superseded marker is what keeps the newest goal-state entry from becoming the
	// current Goal.
	const store = new GoalStore();
	const previous = record({ id: "goal_aaaaaaaa", usage: usage(0) });
	const replacement = record({ id: "goal_bbbbbbbb", usage: usage(0) });
	const branch = [
		goalEntry(previous, { repaired: true }),
		goalWorkEntry("kickoff-old"),
		goalEntry(previous, { repaired: true }),
		goalEntry(replacement, { repaired: true }),
		assistantEntry(0, usageReport(100, 10)),
		toolResultEntry("call_1", usageReport(40, 7, { cacheWrite: 3 })),
		goalEntry(
			record({
				id: "goal_aaaaaaaa",
				usage: usage(160, {
					inputTokens: 140,
					outputTokens: 10,
					cacheWriteTokens: 3,
					nestedTokens: 50,
				}),
			}),
			{ repaired: true, superseded: true },
		),
		goalWorkEntry("steer-new"),
		assistantEntry(2, usageReport(20, 2)),
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.id, "goal_bbbbbbbb", "the replacement is the current Goal");
	assert.equal(
		store.getUsage().totalTokens,
		22,
		"only the replacement's own steered work is charged; the old identity's in-flight response and tool result are not",
	);
	assert.equal(store.currentOwnerId(), "goal_bbbbbbbb");

	// Reloading the same branch must not append the historical snapshot again.
	const pi = fakePi();
	store.closeSupersededSegment(pi);
	assert.equal(pi.appended.length, 0, "the durable freeze is adopted, not rewritten");
});

it("replay closes an open segment at a tombstone and at an ordinary prompt", () => {
	// The same identity rule has to hold for the other two closers, or a cleared Goal
	// would keep charging the work that follows it.
	const store = new GoalStore();
	const goal = record({ usage: usage(0) });
	const branch = [
		goalEntry(goal, { repaired: true }),
		goalWorkEntry("kickoff"),
		assistantEntry(0, usageReport(20, 2)),
		{ type: "custom", id: "tombstone", customType: "goal-state", data: { version: 1, goal: null } },
		assistantEntry(1, usageReport(100, 10)),
		ordinaryUserEntry("anything else?"),
		assistantEntry(2, usageReport(50, 5)),
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get(), null, "the tombstone leaves no Goal");
	assert.equal(store.getUsage().totalTokens, 0, "nothing after the tombstone is charged");
});

it("a reloaded Goal whose replayed usage reached its budget stops instead of admitting more work", () => {
	// The live path stops at the message_end that crosses the budget and persists the
	// transition at the next boundary. A process that dies in between leaves the branch
	// with an active snapshot and a replay that has already crossed the budget, so the
	// reconstruction has to reach the same stop: otherwise the continuation seam admits
	 // another Goal turn the live session had already paid for and failed to stop.
	const store = new GoalStore();
	const goal = record({ tokenBudget: 100, usage: usage(0) });
	const branch = [
		goalEntry(goal, { repaired: true }),
		goalWorkEntry("kickoff"),
		assistantEntry(0, usageReport(95, 10)),
	];
	store.reconstruct(fakeCtx(branch));
	assert.equal(store.get()?.status, "budget_limited", "the replayed crossing stops the Goal");
	assert.equal(store.get()?.wrapUpPending, true, "and it earns the one bounded wrap-up");
	assert.equal(store.hasPendingTransition(), true, "the stop is durable at the next boundary");
	assert.equal(store.getUsage().totalTokens, 105);
});

it("reconstruction leaves a legacy branch's budget stop to the cutover", () => {
	// A pre-repair snapshot is migrated by the cutover, which owns the configured
	// maximum and its notice. Reconstruction must not apply the repaired budget stop
	// first, or the Goal would already be budget_limited and the migration notice — the
	// only place the user learns the maximum was applied — would never be issued.
	const store = new GoalStore();
	const goal = record({ tokenBudget: 100, usage: usage(110, { inputTokens: 100, outputTokens: 10 }) });
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	assert.equal(store.get()?.status, "active");
	assert.equal(store.needsLegacyCutover(), true);
	const result = store.applyLegacyCutover(fakePi(), {});
	assert.equal(result.ok, true);
	assert.equal(store.get()?.status, "budget_limited", "the cutover makes the stop");
	assert.match(result.notices.join("\n"), /already at its token budget/);
});

it("a failed cutover marker leaves memory holding the durable repaired snapshot", () => {
	// The repaired snapshot and the branch-local marker are two appends. If the second
	// one throws, the snapshot is already durable, so the cutover *is* on the branch:
	// keeping the pre-cutover record in memory would let a later pause or budget flush
	// persist `active` with the original budget over the clamped snapshot, and a reload
	// would not cut over again because it reads `repaired: true`.
	const store = new GoalStore();
	const goal = record({ usage: usage(1_000_000, { inputTokens: 999_990, outputTokens: 10 }) });
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	const pi = fakePi();
	const append = pi.appendEntry.bind(pi);
	let calls = 0;
	pi.appendEntry = (customType, data) => {
		if (++calls === 2) throw new Error("disk full");
		return append(customType, data);
	};
	const result = store.applyLegacyCutover(pi, { maxTokenBudget: 100_000 });
	assert.equal(result.ok, true, "the repaired snapshot is durable, so the cutover stands");
	assert.equal(result.cutover, true);
	assert.notEqual(result.markerError, undefined, "the missing marker is reported");
	assert.equal(store.needsLegacyCutover(), false, "the branch is cut over");
	assert.equal(store.get()?.tokenBudget, 100_000, "the clamp survives in memory");

	// The next durable write must carry the clamped record, not the pre-cutover one.
	const edited = store.editObjective(pi, "A refined objective");
	assert.equal(edited.ok, true);
	const appended = pi.appended.at(-1).data.goal;
	assert.equal(appended.tokenBudget, 100_000, "a later transition cannot restore the original budget");
	assert.equal(appended.status, "budget_limited", "nor the pre-cutover status");
});

it("a same-turn blocked repeat after the Goal was edited is refused as stale", () => {
	// The repeat shortcut exists for a model that retries its own tool call. It is only
	// sound while the Goal still reads exactly as the counted report left it: `/goal
	// edit` runs immediately while the same run is busy, so a second report in that turn
	// was prepared against an objective that no longer exists.
	const store = new GoalStore();
	const goal = record({ usage: usage(0) });
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	store.beginGoalWork(goal.id);
	const pi = fakePi();
	const first = store.markBlockedReport(pi, { blocker: "The test database is down", turn: 1 });
	assert.equal(first.ok, true);
	assert.equal(first.repeat, false);

	const edited = store.editObjective(pi, "A completely different objective");
	assert.equal(edited.ok, true);

	const repeat = store.markBlockedReport(
		pi,
		{ blocker: "The test database is down", turn: 1 },
		{ id: goal.id, revision: 0 },
	);
	assert.equal(repeat.ok, false, "the repeat is not reported as recorded");
	assert.equal(repeat.reason, "stale");
	assert.match(repeat.message, /the Goal changed while the call was in flight/);
	assert.equal(store.get()?.blockedAudit?.turns, 1, "the repeat recorded no second audit step");
	assert.equal(store.get()?.revision, 2, "only the report and the edit advanced the revision");
});

it("a same-turn blocked repeat with no other transition stays idempotent", () => {
	// The behaviour the shortcut was written for must survive the stale guard.
	const store = new GoalStore();
	const goal = record({ usage: usage(0) });
	store.reconstruct(fakeCtx([goalEntry(goal)]));
	store.beginGoalWork(goal.id);
	const pi = fakePi();
	const first = store.markBlockedReport(pi, { blocker: "The test database is down", turn: 1 });
	assert.equal(first.ok, true);
	const repeat = store.markBlockedReport(pi, { blocker: "The test database is down", turn: 1 });
	assert.equal(repeat.ok, true);
	assert.equal(repeat.repeat, true);
	assert.equal(repeat.turns, 1);
	assert.equal(repeat.thresholdMet, false);
	assert.equal(pi.appended.length, 1, "the repeat appended nothing");
});
