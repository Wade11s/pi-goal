/**
 * Unit tests for the accounting rules that are impractical to cover exhaustively
 * through the RPC seam: the token formula, deduplication, the active-time
 * boundaries, and budget validation.
 *
 * These are deliberately clock-injected and provider-free, so they are
 * deterministic. Everything that *is* observable end to end (real Pi usage
 * reports, real nested usage, real budget exhaustion, real restart recovery) is
 * covered in goal6.test.mjs against a real Pi subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ActiveTimeTracker,
	isBudgetExhausted,
	MIN_TOKEN_BUDGET,
	normalizeUsage,
	parseBudgetSettings,
	remainingTokens,
	resolveGoalTokenBudget,
	resolveResumeTokenBudget,
	UsageLedger,
	usageContribution,
	zeroGoalUsage,
} from "../src/accounting.ts";
import {
	formatBudgetWrapUpMessage,
	formatGoalStatusLine,
	formatGoalSummary,
	GOAL_STATUSES,
	toPublicState,
} from "../src/goal.ts";

/** A Pi `Usage` report with every field set, so the formula is observable. */
function usage(overrides = {}) {
	return {
		input: 100,
		output: 40,
		cacheRead: 900,
		cacheWrite: 25,
		reasoning: 15,
		totalTokens: 1065,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

test("accounted tokens are non-cached input + output + cache writes", () => {
	const contribution = usageContribution(usage(), "model");
	assert.equal(contribution?.totalTokens, 165);
	assert.equal(contribution?.inputTokens, 100);
	assert.equal(contribution?.outputTokens, 40);
	assert.equal(contribution?.cacheWriteTokens, 25);
});

test("cached-read reuse is excluded from the accounted total but still reported", () => {
	const contribution = usageContribution(usage({ cacheRead: 5_000_000 }), "model");
	assert.equal(contribution?.cachedReadTokens, 5_000_000);
	assert.equal(contribution?.totalTokens, 165, "cache reads are reuse, not new work");
});

test("reasoning is reported but never added on top of output", () => {
	const withoutReasoning = usageContribution(usage({ reasoning: undefined }), "model");
	const withReasoning = usageContribution(usage({ reasoning: 400 }), "model");
	assert.equal(withReasoning?.reasoningTokens, 400);
	assert.equal(
		withReasoning?.totalTokens,
		withoutReasoning?.totalTokens,
		"reasoning is a subset of output in every Pi provider adapter",
	);
});

test("nested and summarization usage is attributed without changing the total", () => {
	const nested = usageContribution(usage(), "nested");
	assert.equal(nested?.nestedTokens, 165);
	assert.equal(nested?.totalTokens, 165);
	const model = usageContribution(usage(), "model");
	assert.equal(model?.nestedTokens, 0);
	assert.equal(model?.totalTokens, 165);
});

test("a missing or malformed usage report is not a charge", () => {
	assert.equal(usageContribution(undefined, "model"), undefined);
	assert.equal(usageContribution(usage({ input: Number.NaN, output: -5 }), "model")?.totalTokens, 25);
});

test("the ledger charges each identity exactly once", () => {
	const ledger = new UsageLedger();
	const step = usage({ input: 10, output: 1, cacheWrite: 0 });
	assert.equal(ledger.account("entry-1", step, "model")?.totalTokens, 11);
	// The same entry reported again (duplicate lifecycle event, reconstruction
	// replay) must not be charged twice.
	assert.equal(ledger.account("entry-1", step, "model"), undefined);
	assert.equal(ledger.account("entry-2", usage({ input: 20, output: 2, cacheWrite: 0 }), "model")?.totalTokens, 22);
	assert.equal(ledger.usage.totalTokens, 33);
	assert.equal(ledger.isAccounted("entry-1"), true);
});

test("the ledger keeps tool-result identities and assistant identities apart", () => {
	const ledger = new UsageLedger();
	ledger.account("entry-1", usage({ input: 10, output: 1, cacheWrite: 0 }), "model");
	ledger.account("toolResult:call_1", usage({ input: 30, output: 3, cacheWrite: 0 }), "nested");
	const totals = ledger.usage;
	assert.equal(totals.totalTokens, 44);
	assert.equal(totals.nestedTokens, 33);
	assert.equal(totals.inputTokens, 40);
});

test("restoring the ledger forgets every charged identity", () => {
	const ledger = new UsageLedger();
	ledger.account("entry-1", usage(), "model");
	const restored = { ...zeroGoalUsage(), totalTokens: 7, inputTokens: 7 };
	ledger.restore(restored);
	assert.equal(ledger.usage.totalTokens, 7);
	assert.equal(ledger.isAccounted("entry-1"), false);
	// The replay after a restore re-charges what the snapshot did not cover.
	assert.equal(ledger.account("entry-1", usage(), "model")?.totalTokens, 165);
	assert.equal(ledger.usage.totalTokens, 172);
});

test("normalizeUsage tolerates snapshots written before accounting existed", () => {
	assert.deepEqual(normalizeUsage(undefined), zeroGoalUsage());
	assert.deepEqual(normalizeUsage(null), zeroGoalUsage());
	assert.deepEqual(normalizeUsage({ totalTokens: "x", inputTokens: -3 }), zeroGoalUsage());
	const normalized = normalizeUsage({ inputTokens: 10, outputTokens: 5, activeMs: 2500 });
	assert.equal(normalized.totalTokens, 15, "the total is derived from the parts");
	assert.equal(normalized.activeMs, 2500);
});

/** Controllable clock for the active-time boundaries. */
function fakeClock(start = 0) {
	let now = start;
	return {
		now: () => now,
		advance: (ms) => {
			now += ms;
		},
	};
}

test("active time accrues only while the clock runs", () => {
	const clock = fakeClock();
	const tracker = new ActiveTimeTracker(0, clock.now);
	tracker.start();
	clock.advance(500);
	assert.equal(tracker.activeMs, 500);
	clock.advance(500);
	assert.equal(tracker.activeMs, 1000);
	assert.equal(tracker.stop(), 1000, "stopping folds the open segment");
	clock.advance(10_000);
	assert.equal(tracker.activeMs, 1000, "a stopped clock does not accrue");
});

test("folding at a lifecycle boundary neither loses nor double-counts time", () => {
	const clock = fakeClock();
	const tracker = new ActiveTimeTracker(0, clock.now);
	tracker.start();
	clock.advance(400);
	const persisted = tracker.fold();
	assert.equal(persisted, 400);
	tracker.persisted(persisted);
	clock.advance(300);
	// A second boundary: the first fold is durable, the second segment is pending.
	const second = tracker.fold();
	assert.equal(second, 700);
	tracker.persisted(second);
	clock.advance(100);
	assert.equal(tracker.activeMs, 800);
	assert.equal(tracker.unpersistedMs, 100);
});

test("a resumed session continues from the persisted time and excludes downtime", () => {
	const clock = fakeClock();
	const first = new ActiveTimeTracker(0, clock.now);
	first.start();
	clock.advance(2500);
	const persisted = first.stop();

	// Process downtime: nothing accrues, because the tracker is reconstructed from
	// the persisted value and a fresh segment.
	clock.advance(60_000);
	const second = new ActiveTimeTracker(persisted, clock.now);
	second.start();
	clock.advance(700);
	assert.equal(second.activeMs, 3200, "downtime is excluded, prior active time is kept");
});

test("active time reports whole seconds and never goes backwards", () => {
	const clock = fakeClock();
	const tracker = new ActiveTimeTracker(1900, clock.now);
	tracker.start();
	clock.advance(50);
	assert.equal(Math.floor(tracker.activeMs / 1000), 1);
	clock.advance(1000);
	assert.equal(Math.floor(tracker.activeMs / 1000), 2);
});

test("every clock read is a single sample, so a fold cannot drop an interval", () => {
	// A clock that counts its reads: the contract is one read per operation, and a
	// tracker that sampled twice inside `fold()` would silently discard the interval
	// between the two reads.
	let reads = 0;
	let now = 0;
	const clock = () => {
		reads += 1;
		now += 10;
		return now;
	};
	const tracker = new ActiveTimeTracker(0, clock);

	const beforeStart = reads;
	tracker.start();
	assert.equal(reads - beforeStart, 1, "start samples once");

	const beforeFold = reads;
	const folded = tracker.fold();
	assert.equal(reads - beforeFold, 1, "fold samples the clock exactly once");
	assert.equal(folded, 10, "the whole interval since the segment started is folded");

	const beforeActive = reads;
	tracker.activeMs;
	assert.equal(reads - beforeActive, 1, "activeMs samples once");

	const beforeStop = reads;
	tracker.stop();
	assert.equal(reads - beforeStop, 1, "stop samples once");
});

test("a clock that steps backwards cannot shrink accounted active time", () => {
	let now = 0;
	const clock = () => now;
	const tracker = new ActiveTimeTracker(0, clock);
	tracker.start();
	now = 500;
	assert.equal(tracker.activeMs, 500);
	// A host clock can step backwards (NTP correction, manual change, suspend). The
	// tracker clamps to the highest value it has seen, so the total never shrinks.
	now = 100;
	assert.equal(tracker.activeMs, 500, "no negative accrual");
	assert.equal(tracker.fold(), 500, "and nothing already accrued is lost");
	now = 900;
	assert.equal(tracker.activeMs, 900, "accrual resumes from the clamped baseline");
});

test("budget configuration is validated, and the maximum wins over a larger default", () => {
	assert.deepEqual(parseBudgetSettings(undefined), {
		defaultTokenBudget: undefined,
		maxTokenBudget: undefined,
		problems: [],
	});
	assert.deepEqual(parseBudgetSettings({ goal: { defaultTokenBudget: 100, maxTokenBudget: 500 } }), {
		defaultTokenBudget: 100,
		maxTokenBudget: 500,
		problems: [],
	});

	const invalid = parseBudgetSettings({ goal: { defaultTokenBudget: 0, maxTokenBudget: "500" } });
	assert.equal(invalid.defaultTokenBudget, undefined);
	assert.equal(invalid.maxTokenBudget, undefined);
	assert.equal(invalid.problems.length, 2);

	const clamped = parseBudgetSettings({ goal: { defaultTokenBudget: 900, maxTokenBudget: 500 } });
	assert.equal(clamped.defaultTokenBudget, 500, "the maximum is the safety bound, so it wins");
	assert.equal(clamped.maxTokenBudget, 500);
	assert.equal(clamped.problems.length, 1);
});

test("an absent budget request falls back to the configured default", () => {
	const settings = parseBudgetSettings({ goal: { defaultTokenBudget: 250 } });
	assert.deepEqual(resolveGoalTokenBudget(undefined, settings), { ok: true, tokenBudget: 250 });
	const empty = parseBudgetSettings(undefined);
	assert.deepEqual(resolveGoalTokenBudget(undefined, empty), { ok: true, tokenBudget: undefined });
});

test("a configured maximum alone still bounds every new Goal", () => {
	// The maximum is a hard bound: with no default configured, a new Goal must not
	// silently become unbounded.
	const maxOnly = parseBudgetSettings({ goal: { maxTokenBudget: 500 } });
	assert.deepEqual(resolveGoalTokenBudget(undefined, maxOnly), { ok: true, tokenBudget: 500 });

	// An explicit unbounded request is refused rather than silently clamped.
	const unbounded = resolveGoalTokenBudget("none", maxOnly);
	assert.equal(unbounded.ok, false);
	assert.match(unbounded.ok ? "" : unbounded.error, /unbounded Goal is not allowed/);
	assert.match(unbounded.ok ? "" : unbounded.error, /goal\.maxTokenBudget \(500 tokens\)/);

	// With no maximum configured, an explicit unbounded request is honoured.
	const noMax = parseBudgetSettings(undefined);
	assert.deepEqual(resolveGoalTokenBudget("none", noMax), { ok: true, tokenBudget: undefined });

	// And a default below the maximum is still the default.
	const both = parseBudgetSettings({ goal: { defaultTokenBudget: 250, maxTokenBudget: 500 } });
	assert.deepEqual(resolveGoalTokenBudget(undefined, both), { ok: true, tokenBudget: 250 });
	assert.deepEqual(resolveGoalTokenBudget("none", both).ok, false);
});

test("an explicit budget is validated and can never exceed the maximum", () => {
	const settings = parseBudgetSettings({ goal: { maxTokenBudget: 500 } });
	assert.deepEqual(resolveGoalTokenBudget(500, settings), { ok: true, tokenBudget: 500 });
	assert.deepEqual(resolveGoalTokenBudget(1, settings), { ok: true, tokenBudget: 1 });

	const tooBig = resolveGoalTokenBudget(501, settings);
	assert.equal(tooBig.ok, false);
	assert.match(tooBig.ok ? "" : tooBig.error, /exceeds the configured maximum of 500/);

	for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = resolveGoalTokenBudget(bad, settings);
		assert.equal(result.ok, false, `${bad} must be refused`);
	}
	assert.equal(MIN_TOKEN_BUDGET, 1);
});

test("remaining capacity and exhaustion are computed from the accounted total", () => {
	assert.equal(remainingTokens(undefined, 10), undefined);
	assert.equal(remainingTokens(100, 40), 60);
	assert.equal(remainingTokens(100, 100), 0, "an exhausted budget reports zero, never negative");
	assert.equal(remainingTokens(100, 400), 0);
	assert.equal(isBudgetExhausted(undefined, 10), false);
	assert.equal(isBudgetExhausted(100, 99), false);
	assert.equal(isBudgetExhausted(100, 100), true, "reaching the budget exhausts it");
});

test("a budget-raising resume is an absolute cumulative ceiling with positive headroom", () => {
	const settings = parseBudgetSettings(undefined);
	// The new value is a total, not an increment: 150 means 150 tokens overall
	// when 130 are already accounted, leaving 20 tokens of headroom.
	assert.deepEqual(resolveResumeTokenBudget(150, settings, 130), { ok: true, tokenBudget: 150 });
	assert.deepEqual(resolveResumeTokenBudget(131, settings, 130), { ok: true, tokenBudget: 131 });

	// Equal to the current usage leaves no headroom and is refused.
	const noHeadroom = resolveResumeTokenBudget(130, settings, 130);
	assert.equal(noHeadroom.ok, false);
	assert.match(noHeadroom.ok ? "" : noHeadroom.error, /strictly greater than/);
	assert.match(noHeadroom.ok ? "" : noHeadroom.error, /130 tokens/);

	// Below the current usage would move the ceiling backwards.
	const backwards = resolveResumeTokenBudget(120, settings, 130);
	assert.equal(backwards.ok, false);
	assert.match(backwards.ok ? "" : backwards.error, /strictly greater than/);
});

test("a budget-raising resume refuses invalid token counts and never clamps the maximum", () => {
	const settings = parseBudgetSettings({ goal: { maxTokenBudget: 500 } });
	for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = resolveResumeTokenBudget(bad, settings, 100);
		assert.equal(result.ok, false, `${bad} must be refused`);
	}
	assert.deepEqual(resolveResumeTokenBudget(500, settings, 100), { ok: true, tokenBudget: 500 });

	// Above the configured maximum the request is refused, never clamped.
	const tooBig = resolveResumeTokenBudget(501, settings, 100);
	assert.equal(tooBig.ok, false);
	assert.match(tooBig.ok ? "" : tooBig.error, /exceeds the configured maximum of 500/);
	assert.match(tooBig.ok ? "" : tooBig.error, /Raise goal\.maxTokenBudget/);
});

test("a budget-raising resume never treats the configured default as implicit authority", () => {
	// The default applies to new Goals only. A resume must carry an explicit total,
	// and the default must not silently widen it.
	const settings = parseBudgetSettings({ goal: { defaultTokenBudget: 5000, maxTokenBudget: 1000 } });
	assert.deepEqual(resolveResumeTokenBudget(200, settings, 130), { ok: true, tokenBudget: 200 });
	const tooBig = resolveResumeTokenBudget(2000, settings, 130);
	assert.equal(tooBig.ok, false, "the maximum still bounds the explicit request");
});

function record(overrides = {}) {
	return {
		id: "goal_abcd1234",
		objective: "Make the full test suite pass",
		status: "active",
		origin: "command",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		revision: 0,
		...overrides,
	};
}

test("public state reports usage, budget, remaining capacity, and exhaustion", () => {
	const usageTotals = {
		...zeroGoalUsage(),
		totalTokens: 400,
		inputTokens: 300,
		outputTokens: 80,
		cacheWriteTokens: 20,
		cachedReadTokens: 900,
		reasoningTokens: 30,
		nestedTokens: 50,
		activeMs: 65_000,
	};
	const state = toPublicState(record({ tokenBudget: 500, usage: usageTotals }));
	assert.equal(state.tokenBudget, 500);
	assert.equal(state.usage.totalTokens, 400);
	assert.equal(state.usage.cachedReadTokens, 900);
	assert.equal(state.usage.reasoningTokens, 30);
	assert.equal(state.usage.nestedTokens, 50);
	assert.equal(state.usage.activeSeconds, 65);
	assert.equal(state.remainingTokens, 100);
	assert.equal(state.budgetExhausted, false);

	const exhausted = toPublicState(record({ tokenBudget: 400, usage: usageTotals, status: "budget_limited" }));
	assert.equal(exhausted.remainingTokens, 0);
	assert.equal(exhausted.budgetExhausted, true);

	const unbounded = toPublicState(record());
	assert.equal(unbounded.tokenBudget, null);
	assert.equal(unbounded.remainingTokens, null);
	assert.equal(unbounded.budgetExhausted, false);
	assert.equal(unbounded.usage.totalTokens, 0);
});

test("the status summary reports the budget, the accounted usage, and remaining capacity", () => {
	const summary = formatGoalSummary(
		toPublicState(
			record({
				tokenBudget: 1000,
				usage: { ...zeroGoalUsage(), totalTokens: 400, inputTokens: 300, outputTokens: 80, activeMs: 95_000 },
			}),
		),
	);
	assert.match(summary, /Token budget: 1000 tokens/);
	assert.match(summary, /Token usage: 400 tokens/);
	assert.match(summary, /Active time: 1m 35s/);
	assert.match(summary, /Remaining capacity: 600 tokens/);
	assert.ok(!summary.includes("exhausted"));

	const exhausted = formatGoalSummary(
		toPublicState(
			record({
				status: "budget_limited",
				tokenBudget: 400,
				usage: { ...zeroGoalUsage(), totalTokens: 400, activeMs: 1000 },
			}),
		),
	);
	assert.match(exhausted, /Remaining capacity: 0 tokens \(budget exhausted\)/);
});

test("the status line is compact and always carries the status and the usage", () => {
	const line = formatGoalStatusLine(
		toPublicState(record({ tokenBudget: 1000, usage: { ...zeroGoalUsage(), totalTokens: 400, activeMs: 5000 } })),
	);
	assert.equal(line, "goal_abcd1234 · active · 400 tok · 600 left · 5s");
	assert.match(
		formatGoalStatusLine(
			toPublicState(record({ status: "budget_limited", tokenBudget: 400, usage: { ...zeroGoalUsage(), totalTokens: 400 } })),
		),
		/budget exhausted/,
	);
});

test("the compact status line exposes every lifecycle status", () => {
	for (const status of GOAL_STATUSES) {
		const line = formatGoalStatusLine(
			toPublicState(
				record({
					status,
					tokenBudget: status === "complete" || status === "paused" ? undefined : 1000,
					usage: { ...zeroGoalUsage(), totalTokens: 400, activeMs: 5000 },
				}),
			),
		);
		assert.match(line, new RegExp(`\\b${status}\\b`), `status ${status} is missing from: ${line}`);
		assert.ok(line.length <= 80, `status line for ${status} is not compact: ${line}`);
		assert.match(line, /400 tok/, `usage is missing from the ${status} line`);
	}
});

test("the budget wrap-up restates the objective as data and forbids false completion", () => {
	const goal = record({
		status: "budget_limited",
		tokenBudget: 400,
		usage: { ...zeroGoalUsage(), totalTokens: 412, inputTokens: 400, outputTokens: 12, activeMs: 60_000 },
	});
	const message = formatBudgetWrapUpMessage(goal);
	assert.match(message, /exhausted its token budget and is now budget_limited/);
	assert.match(message, /Accounted usage: 412 tokens of the 400-token budget/);
	assert.match(message, /This is NOT completion/);
	assert.match(message, /Do not call update_goal/);
	assert.match(message, /Next useful action/);
	// Same trust boundary as the continuation: the objective is delimited data and
	// the authoritative instructions follow it.
	assert.ok(message.includes(">>> BEGIN GOAL OBJECTIVE DATA"), "the objective is delimited");
	assert.ok(
		message.indexOf("INSTRUCTIONS FROM PI-GOAL") > message.indexOf("END GOAL OBJECTIVE DATA (nonce "),
		"the instructions come after the objective data block",
	);
	assert.ok(message.includes(JSON.stringify(goal.objective)), "the objective is reproduced verbatim");
});
