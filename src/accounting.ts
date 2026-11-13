/**
 * Goal usage accounting.
 *
 * Two questions are answered here, and both are answered against Pi's *documented*
 * usage semantics rather than against a guess:
 *
 * 1. **What counts as Goal work?** Pi reports `Usage` on every assistant message
 *    and, optionally, on tool-result messages for model work a tool performed
 *    (`ctx.executeTool()`). Its fields mean (see Pi's `message-types.md` and the
 *    provider adapters):
 *
 *    - `input` excludes cached reads *and* cache writes: every Pi provider adapter
 *      subtracts them (`input = prompt_tokens - cached - cache_write`).
 *    - `output` already includes reasoning tokens. `reasoning` is a subset of
 *      `output` ("do not add it again"), so adding it would double-count.
 *    - `cacheRead` is prompt reuse, not new work.
 *    - `cacheWrite` is freshly processed prompt tokens that Pi counts in its own
 *      session totals, so it is real consumption.
 *    - `cacheWrite1h` is a subset of `cacheWrite` and is therefore never added.
 *
 *    So the accounted total is `input + output + cacheWrite`, cached reads are
 *    excluded as reuse, and reasoning is reported but never added.
 *
 * 2. **How is the same work counted exactly once?** Every accounted report is
 *    keyed by a stable identity, and a key is only ever charged once:
 *
 *    - an assistant model response is keyed by a process-local sequence number,
 *      because `message_end` is the only seam where its usage is known before the
 *      turn's tool calls run (a lifecycle transition happens *inside* a tool call,
 *      so the completing turn must still be accountable);
 *    - a tool result is keyed by its tool call id, which is unique per call;
 *    - a summarization entry (compaction, branch summary) is keyed by its session
 *      entry id.
 *
 *    Nested usage arrives already merged into the parent tool result's `usage` (Pi's
 *    `NestedToolCallRunner` folds it there, and nested results are not persisted),
 *    so counting the parent once is what keeps nested work from being counted
 *    twice.
 *
 *    Reconstruction replays the session branch and charges by entry id instead.
 *    That is not a second charge for the same work: the ledger is rebuilt from the
 *    branch, and a checkpoint is always appended *after* the entries it covers, so
 *    replaying after a restart or a tree navigation converges on exactly the totals
 *    the live path would have produced. The same rule makes duplicate lifecycle
 *    events idempotent.
 *
 * Active time uses a separate monotonic clock that only runs while a Goal is
 * active in a live session, so paused time and process downtime never accrue, and
 * folding a segment never double-counts it.
 */
import type { Usage } from "@earendil-works/pi-ai";

/** Durable usage totals carried by a Goal snapshot. */
export interface GoalUsage {
	/**
	 * Accounted tokens: non-cached input + output (reasoning included) + cache
	 * writes. This is the number the token budget is compared against.
	 */
	totalTokens: number;
	/** Non-cached input tokens (`Usage.input`). */
	inputTokens: number;
	/** Output tokens (`Usage.output`), including reasoning. */
	outputTokens: number;
	/** Tokens written to a provider cache (`Usage.cacheWrite`), including `cacheWrite1h`. */
	cacheWriteTokens: number;
	/** Cache-read tokens seen and deliberately excluded from `totalTokens` (reuse). */
	cachedReadTokens: number;
	/** Reasoning tokens seen; already inside `outputTokens`, never added again. */
	reasoningTokens: number;
	/**
	 * Model work reported outside the main model call: tool-performed nested usage
	 * (`toolResult.usage`) and summarization usage (compaction / branch summaries).
	 * Counted exactly once and already inside `totalTokens`.
	 */
	nestedTokens: number;
	/** Accounted active milliseconds. */
	activeMs: number;
}

/** Where an accounted usage report came from. */
export type UsageSource =
	/** An assistant model response. */
	| "model"
	/** Model work reported on a tool result or a summarization entry. */
	| "nested";

/** One accounted usage report, split into the parts the budget cares about. */
export interface UsageContribution {
	inputTokens: number;
	outputTokens: number;
	cacheWriteTokens: number;
	cachedReadTokens: number;
	reasoningTokens: number;
	nestedTokens: number;
	totalTokens: number;
}

export function zeroGoalUsage(): GoalUsage {
	return {
		totalTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cachedReadTokens: 0,
		reasoningTokens: 0,
		nestedTokens: 0,
		activeMs: 0,
	};
}

/** Clamp a reported token count to a finite, non-negative integer. */
function tokens(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * Split one `Usage` report into the accounted contribution.
 *
 * Returns undefined when the report carries no token information at all, so a
 * message without usage is simply not a charge.
 */
export function usageContribution(usage: Usage | undefined, source: UsageSource): UsageContribution | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const inputTokens = tokens(usage.input);
	const outputTokens = tokens(usage.output);
	const cacheWriteTokens = tokens(usage.cacheWrite);
	const cachedReadTokens = tokens(usage.cacheRead);
	const reasoningTokens = tokens(usage.reasoning);
	const totalTokens = inputTokens + outputTokens + cacheWriteTokens;
	return {
		inputTokens,
		outputTokens,
		cacheWriteTokens,
		cachedReadTokens,
		reasoningTokens,
		// `reasoning` is a subset of `output` in every Pi provider adapter, so it is
		// reported for transparency and never added to the total.
		nestedTokens: source === "nested" ? totalTokens : 0,
		totalTokens,
	};
}

function addContribution(usage: GoalUsage, contribution: UsageContribution): void {
	usage.inputTokens += contribution.inputTokens;
	usage.outputTokens += contribution.outputTokens;
	usage.cacheWriteTokens += contribution.cacheWriteTokens;
	usage.cachedReadTokens += contribution.cachedReadTokens;
	usage.reasoningTokens += contribution.reasoningTokens;
	usage.nestedTokens += contribution.nestedTokens;
	usage.totalTokens += contribution.totalTokens;
}

/** Coerce a persisted usage object into a complete, numeric `GoalUsage`. */
export function normalizeUsage(value: unknown): GoalUsage {
	const usage = zeroGoalUsage();
	if (!value || typeof value !== "object") return usage;
	const record = value as Record<string, unknown>;
	for (const key of [
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"cacheWriteTokens",
		"cachedReadTokens",
		"reasoningTokens",
		"nestedTokens",
		"activeMs",
	] as const) {
		const raw = record[key];
		if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) usage[key] = Math.floor(raw);
	}
	// A total is only ever derived; if a snapshot predates a field, keep the total
	// consistent with the parts rather than trusting a stale number.
	if (usage.totalTokens === 0) {
		usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
	}
	return usage;
}

/**
 * Token ledger with stable deduplication.
 *
 * Keys are the identities the accounting path guarantees are unique within one
 * process: a sequence number per charged assistant message, the tool call id of a
 * tool result, and the session entry id of a summarization entry. Charging a key
 * twice is impossible, so the ledger is safe under duplicate lifecycle events and
 * concurrent tool work inside one turn. Reconstruction re-keys by session entry id
 * after clearing the ledger, which is what keeps a restart or a tree navigation
 * from charging anything twice (see the module comment).
 */
export class UsageLedger {
	private totals: GoalUsage;
	private readonly accounted = new Set<string>();

	constructor(usage?: GoalUsage) {
		this.totals = usage ? { ...usage } : zeroGoalUsage();
	}

	/** Current totals (a copy). */
	get usage(): GoalUsage {
		return { ...this.totals };
	}

	/** Replace the totals and forget every accounted key (used when restoring). */
	restore(usage: GoalUsage): void {
		this.totals = { ...usage };
		this.accounted.clear();
	}

	isAccounted(key: string): boolean {
		return this.accounted.has(key);
	}

	/**
	 * Charge one usage report exactly once. Returns the contribution when the key
	 * was new, and undefined when it was already accounted (or carried no usage).
	 */
	account(key: string, usage: Usage | undefined, source: UsageSource): UsageContribution | undefined {
		if (this.accounted.has(key)) return undefined;
		this.accounted.add(key);
		const contribution = usageContribution(usage, source);
		if (!contribution) return undefined;
		addContribution(this.totals, contribution);
		return contribution;
	}
}

/**
 * Default clock: a monotonic per-process timer.
 *
 * Only deltas are ever used, so a monotonic source is both sufficient and strictly
 * better than wall time: a clock adjustment (NTP step, manual change, suspend)
 * cannot make accounted active time jump or go backwards. The function is
 * injectable so tests can drive time deterministically.
 */
function defaultClock(): number {
	return performance.now();
}

/**
 * Monotonic active-time clock.
 *
 * `durableMs` is the last value written to the session; `pendingMs` is what has
 * accrued in this process since; `segmentStart` is the start of the currently open
 * live segment. Folding a segment moves it into `pendingMs` and reopens the
 * segment at the fold instant, so a fold can neither lose nor double-count time,
 * however many lifecycle boundaries cross it.
 *
 * The clock is sampled exactly once per operation: sampling twice (once to compute
 * the delta and once to reopen the segment) would silently drop the interval
 * between the two reads.
 */
export class ActiveTimeTracker {
	private durableMs: number;
	private pendingMs = 0;
	private segmentStart: number | undefined;
	/** Highest clock value ever sampled, so the tracker is monotonic by construction. */
	private lastNow: number | undefined;
	private readonly clock: () => number;

	constructor(durableMs = 0, clock: () => number = defaultClock) {
		this.durableMs = Math.max(0, Math.floor(durableMs) || 0);
		this.clock = clock;
	}

	/**
	 * Read the clock exactly once, clamped to the highest value seen so far.
	 *
	 * One read per operation matters: sampling twice (once for a delta and once to
	 * reopen a segment) silently drops the interval between the two reads. The clamp
	 * matters because a host clock can step backwards, and accounted active time must
	 * never shrink.
	 */
	private sample(): number {
		const now = this.clock();
		this.lastNow = this.lastNow === undefined ? now : Math.max(this.lastNow, now);
		return this.lastNow;
	}

	/** Start (or resume) the live segment. Idempotent. */
	start(): void {
		if (this.segmentStart === undefined) this.segmentStart = this.sample();
	}

	/** Fold the open segment and stop the clock. Returns the accounted total. */
	stop(): number {
		this.fold();
		this.segmentStart = undefined;
		return this.durableMs + this.pendingMs;
	}

	/** Fold the open segment; the clock keeps running. Returns the value to persist. */
	fold(): number {
		const now = this.sample();
		if (this.segmentStart !== undefined) {
			this.pendingMs += Math.max(0, now - this.segmentStart);
		}
		this.segmentStart = now;
		return this.durableMs + this.pendingMs;
	}

	/** Accounted active milliseconds, including the open segment. */
	get activeMs(): number {
		const now = this.sample();
		const live = this.segmentStart === undefined ? 0 : Math.max(0, now - this.segmentStart);
		return this.durableMs + this.pendingMs + live;
	}

	/** Accounted milliseconds that are not durable yet. */
	get unpersistedMs(): number {
		const now = this.sample();
		const live = this.segmentStart === undefined ? 0 : Math.max(0, now - this.segmentStart);
		return this.pendingMs + live;
	}

	/** Record that `ms` is now durable. */
	persisted(ms: number): void {
		this.durableMs = Math.max(this.durableMs, Math.max(0, Math.floor(ms) || 0));
		this.pendingMs = 0;
	}

	/** Forget everything (a new Goal starts from zero). */
	reset(): void {
		this.durableMs = 0;
		this.pendingMs = 0;
		this.segmentStart = undefined;
	}
}

/** Smallest accepted token budget. */
export const MIN_TOKEN_BUDGET = 1;

/**
 * How much accounted active time may sit unwritten before a checkpoint is
 * appended. Bounds both the session-file growth (one entry per accounted second
 * of Goal activity) and how much active time an unclean exit can lose.
 */
export const ACCOUNTING_CHECKPOINT_MS = 1000;

/** Extension-level budget configuration, already validated. */
export interface BudgetSettings {
	/** Applied to new Goals that do not ask for an explicit budget. */
	defaultTokenBudget: number | undefined;
	/** Upper bound for any Goal budget. */
	maxTokenBudget: number | undefined;
	/** Human-readable configuration problems, reported once per session. */
	problems: string[];
}

function readBudgetValue(value: unknown): number | undefined | "invalid" {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_TOKEN_BUDGET) return "invalid";
	return value;
}

/**
 * Read and validate the extension-level budget configuration from Pi's effective
 * settings (`goal.defaultTokenBudget` / `goal.maxTokenBudget`).
 *
 * Invalid values are dropped and reported rather than silently coerced, and a
 * default above the maximum is clamped to the maximum: the maximum is the safety
 * bound, so it always wins. Explicit per-Goal budgets are never clamped (see
 * `resolveGoalTokenBudget`).
 */
export function parseBudgetSettings(settings: unknown): BudgetSettings {
	const problems: string[] = [];
	const goal = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).goal : undefined) as
		| Record<string, unknown>
		| undefined;

	const rawDefault = readBudgetValue(goal?.defaultTokenBudget);
	let defaultTokenBudget: number | undefined;
	if (rawDefault === "invalid") {
		problems.push(
			`pi-goal: goal.defaultTokenBudget must be a whole number of at least ${MIN_TOKEN_BUDGET} tokens; ignoring it.`,
		);
	} else {
		defaultTokenBudget = rawDefault;
	}

	const rawMax = readBudgetValue(goal?.maxTokenBudget);
	let maxTokenBudget: number | undefined;
	if (rawMax === "invalid") {
		problems.push(
			`pi-goal: goal.maxTokenBudget must be a whole number of at least ${MIN_TOKEN_BUDGET} tokens; ignoring it.`,
		);
	} else {
		maxTokenBudget = rawMax;
	}

	if (defaultTokenBudget !== undefined && maxTokenBudget !== undefined && defaultTokenBudget > maxTokenBudget) {
		problems.push(
			`pi-goal: goal.defaultTokenBudget (${defaultTokenBudget}) exceeds goal.maxTokenBudget (${maxTokenBudget}); ` +
				"using the maximum as the default.",
		);
		defaultTokenBudget = maxTokenBudget;
	}

	return { defaultTokenBudget, maxTokenBudget, problems };
}

/**
 * What a new Goal asked for in terms of budget.
 *
 * - `undefined`: no request, so the configured default applies.
 * - `"none"`: an explicit request for an unbounded Goal.
 * - a number: an explicit budget.
 */
export type GoalBudgetRequest = undefined | "none" | number;

export type BudgetResolution =
	| { ok: true; tokenBudget: number | undefined }
	| { ok: false; error: string };

/**
 * Resolve the token budget for a new Goal.
 *
 * The configured maximum is a *hard* bound, so it constrains every path:
 *
 * - no request: the configured default applies, and when only a maximum is
 *   configured the maximum is the bound, so a new Goal is never accidentally
 *   unbounded;
 * - an explicit budget: validated as a whole number of at least
 *   {@link MIN_TOKEN_BUDGET} and refused above the maximum, never clamped;
 * - an explicit unbounded request: refused while a maximum is configured,
 *   because it would create exactly the Goal the configuration forbids.
 */
export function resolveGoalTokenBudget(requested: GoalBudgetRequest, settings: BudgetSettings): BudgetResolution {
	const max = settings.maxTokenBudget;

	if (requested === "none") {
		if (max !== undefined) {
			return {
				ok: false,
				error:
					"Goal not created: an unbounded Goal is not allowed while goal.maxTokenBudget " +
					`(${max} tokens) is configured. Request a budget of at most ${max} tokens, or raise ` +
					"goal.maxTokenBudget first.",
			};
		}
		return { ok: true, tokenBudget: undefined };
	}

	if (requested === undefined) {
		// The default applies; a configured maximum is the fallback bound so that a
		// session with only a maximum still gets bounded Goals.
		return { ok: true, tokenBudget: settings.defaultTokenBudget ?? max };
	}

	if (!Number.isSafeInteger(requested) || requested < MIN_TOKEN_BUDGET) {
		return {
			ok: false,
			error:
				`Goal not created: a token budget must be a whole number of at least ${MIN_TOKEN_BUDGET} tokens ` +
				`(got ${Number.isFinite(requested) ? requested : String(requested)}).`,
		};
	}
	if (max !== undefined && requested > max) {
		return {
			ok: false,
			error:
				`Goal not created: a token budget of ${requested} tokens exceeds the configured maximum of ${max} ` +
				"tokens. Raise goal.maxTokenBudget or request a smaller budget.",
		};
	}
	return { ok: true, tokenBudget: requested };
}

/** Tokens still available, or undefined when the Goal has no budget. */
export function remainingTokens(tokenBudget: number | undefined, usedTokens: number): number | undefined {
	if (tokenBudget === undefined) return undefined;
	return Math.max(0, tokenBudget - usedTokens);
}

/**
 * Validate and resolve a cumulative budget raise for a `budget_limited` Goal.
 *
 * The requested value is the Goal's new **absolute cumulative ceiling**, not an
 * increment and not a fresh allowance: all Goal-owned usage already accounted —
 * including overshoot and every admitted wrap-up — stays charged against it. So
 * the value must be a whole-token budget strictly greater than the current
 * accounted total, which is what guarantees the resumed Goal has positive
 * headroom instead of resuming straight into another stop.
 *
 * The configured maximum remains a hard cap and is never clamped.
 * `goal.defaultTokenBudget` is deliberately absent from this path: it applies to
 * new Goals only and is never implicit resume authority.
 */
export function resolveResumeTokenBudget(
	requested: number,
	settings: BudgetSettings,
	currentUsage: number,
): BudgetResolution {
	if (!Number.isSafeInteger(requested) || requested < MIN_TOKEN_BUDGET) {
		return {
			ok: false,
			error:
				`a token budget must be a whole number of at least ${MIN_TOKEN_BUDGET} tokens ` +
				`(got ${Number.isFinite(requested) ? requested : String(requested)}).`,
		};
	}
	if (requested <= currentUsage) {
		return {
			ok: false,
			error:
				`the new budget of ${requested} tokens must be strictly greater than the Goal's ` +
				`current usage of ${currentUsage} tokens, so the resumed Goal has positive headroom. Request a ` +
				`higher cumulative total.`,
		};
	}
	const max = settings.maxTokenBudget;
	if (max !== undefined && requested > max) {
		return {
			ok: false,
			error:
				`a token budget of ${requested} tokens exceeds the configured maximum of ${max} ` +
				"tokens. Raise goal.maxTokenBudget or resume with a budget of at most that maximum.",
		};
	}
	return { ok: true, tokenBudget: requested };
}

/** Whether the accounted usage has reached the Goal's token budget. */
export function isBudgetExhausted(tokenBudget: number | undefined, usedTokens: number): boolean {
	return tokenBudget !== undefined && usedTokens >= tokenBudget;
}
