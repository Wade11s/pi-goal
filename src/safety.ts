/**
 * Conservative stopping rules for an unattended Goal.
 *
 * Three things can end automatic Goal work without the model asking for it, and
 * all three are deliberately narrow so that ordinary work is never mistaken for
 * a malfunction:
 *
 * 1. **Activity-free automatic Goal turns.** A Goal turn that produced nothing
 *    that could move the objective — no tool call, no output, no reasoning — is a
 *    malfunctioning continuation, not progress. A bounded number of them in a row
 *    stops the Goal as `blocked` instead of burning turns forever.
 * 2. **Execution-unavailable automatic Goal turns.** A Goal turn in which the
 *    model tried to run a command and the shell itself could not run it (the
 *    executable is missing, the process could not be spawned, the tool threw
 *    while running) means the agent cannot act at all. A bounded number of those
 *    stops the Goal. An *ordinary* command failure — the command ran and exited
 *    non-zero, timed out, died without an exit code, or was aborted — is normal
 *    work and is explicitly not counted.
 * 3. **Terminal provider failures.** A provider error that Pi will not retry is
 *    classified from the evidence Pi exposes: a usage limit becomes
 *    `usage_limited`, anything else stops the continuation for that run while
 *    the Goal stays active and resumes on the next successful run.
 *
 * A fourth rule, the three-consecutive-Goal-turn same-blocker audit, is
 * model-driven and lives with the Goal record (`GoalRecord.blockedAudit`) because
 * it has to survive compaction and a session restore. Its threshold is declared
 * next to the two above in `./goal.ts`, so the continuation prompt, the tool, and
 * the enforcement all read the same number.
 *
 * Everything here is deterministic and synchronous: no timers, no I/O, and no
 * reliance on the model's cooperation. The thresholds are constants rather than
 * settings because an unattended safety bound must not be something a drifting
 * configuration silently widens.
 *
 * The unit of counting is the **Goal turn**, and a Goal turn is a *chain* of runs,
 * not a single run. One run can contain many provider requests (a tool call and
 * its follow-up, a steering message), and Pi can turn one Goal turn into several
 * runs by retrying a failed provider request with `agent.continue()`. Observations
 * are therefore aggregated across the whole chain and evaluated once, when Pi has
 * finished retrying and reaches the settlement boundary — never at an
 * intermediate `agent_end`, which would evaluate a run Pi is about to retry and
 * then misread the retry as a fresh user run.
 */
import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_FREE_TURN_LIMIT, EXECUTION_UNAVAILABLE_TURN_LIMIT } from "./goal.ts";

/** Tools that run an operating-system command for the model. */
const EXECUTION_TOOLS = new Set(["bash", "powershell"]);

/**
 * What started a run, which decides whether it may count toward an anti-loop
 * bound at all.
 *
 * - `automatic` — Pi started the run because pi-goal asked for a continuation.
 *   This is the only kind of unattended Goal work, so it is the only kind the
 *   activity-free and execution-unavailable counters count.
 * - `kickoff` — the run the `/goal` command started for a new Goal. The user is
 *   watching it, so it must not consume one of the three automatic turns, even
 *   though it is still a Goal turn for the blocked audit.
 * - `user` — a run the user started with their own prompt. A human stepping in
 *   ends the unattended phase, so it resets every counter.
 */
export type GoalRunKind = "automatic" | "kickoff" | "user";

/** Why the safety monitor stopped the Goal. */
export type SafetyStopKind = "activity-free" | "execution-unavailable";

export interface SafetyStop {
	kind: SafetyStopKind;
	/** Durable, human-readable explanation stored as the Goal's blocker. */
	blocker: string;
	/** How many consecutive Goal turns reached the limit. */
	turns: number;
}

/** Minimal shape of a finalized tool result, as delivered by `tool_execution_end`. */
interface ToolResultLike {
	content?: unknown;
	structuredContent?: unknown;
}

/** Minimal shape of the `tool_execution_end` event this module needs. */
export interface ToolExecutionEndLike {
	toolName: string;
	isError: boolean;
	/** Absent when the tool did not run at all (blocked, invalid arguments, aborted). */
	durationMs?: number;
	result: ToolResultLike;
}

/** Minimal shape of an assistant message this module needs. */
export interface AssistantMessageLike {
	content?: unknown;
}

/** All text of a tool result, joined across its text blocks. */
function toolResultText(result: ToolResultLike | undefined): string {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: unknown; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("\n");
}

/**
 * Outcomes that prove the shell ran the command, so the failure is ordinary work
 * rather than an unavailable shell.
 *
 * Pi's shell tools report all of these as an error result with a measured
 * duration and *no* exit code, which is exactly the shape an infrastructure
 * failure has — so the text is the only thing that tells them apart:
 *
 * - `Command exited with code N` — the command ran and failed. Normal work.
 * - `Command timed out after N seconds` — the shell spawned, ran the command, and
 *   the command was too slow. A timeout proves execution was available.
 * - `Command terminated without an exit code` — the process died, but it started.
 * - `Command aborted` — the user stopped it.
 * - `Invalid timeout: …` — the model passed a bad timeout argument.
 */
const ORDINARY_COMMAND_FAILURE_PATTERNS: RegExp[] = [
	/Command exited with code \d+/,
	/Command timed out after/,
	/Command terminated without an exit code/,
	/Command aborted/,
	/Invalid timeout:/,
];

/**
 * Whether a failed tool result is an *ordinary* command failure: the command ran,
 * and it either reported a non-zero exit code or ended in one of the ways above.
 *
 * It is normal work — a failing test, a rejected build, a slow command that hit
 * its timeout — so it must never be read as "execution is unavailable".
 */
function isOrdinaryCommandFailure(result: ToolResultLike | undefined): boolean {
	const structured = result?.structuredContent;
	if (structured && typeof structured === "object") {
		const exitCode = (structured as { exit_code?: unknown }).exit_code;
		if (typeof exitCode === "number" && Number.isFinite(exitCode)) return true;
	}
	const text = toolResultText(result);
	return ORDINARY_COMMAND_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether a finalized tool call is evidence that execution itself was
 * unavailable.
 *
 * All three conditions matter:
 * - it is a shell tool, so the failure is about running commands at all;
 * - it is an error, and the tool actually ran (`durationMs` is present), which
 *   rules out a call that was blocked or rejected before execution;
 * - it is not an ordinary command failure, which is the whole point: a non-zero
 *   exit is the command working as intended.
 */
function isExecutionUnavailable(event: ToolExecutionEndLike): boolean {
	if (!EXECUTION_TOOLS.has(event.toolName)) return false;
	if (!event.isError) return false;
	if (event.durationMs === undefined) return false;
	return !isOrdinaryCommandFailure(event.result);
}

/** Whether a content block array carries any text that is not pure whitespace. */
function hasMeaningfulText(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
		if (typed.type === "text") return typeof typed.text === "string" && typed.text.trim().length > 0;
		if (typed.type === "thinking") {
			return typeof typed.thinking === "string" && typed.thinking.trim().length > 0;
		}
		return false;
	});
}

/** Whether the assistant message asked for at least one tool call. */
function hasToolCall(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return (block as { type?: unknown }).type === "toolCall";
	});
}

/**
 * Per-session, in-memory view of the automatic Goal turns.
 *
 * Observations are aggregated per run and evaluated once, when the run ends, so
 * a Goal run that makes three failing shell attempts across three provider
 * requests is one execution-unavailable Goal turn rather than three. A run that
 * is not execution-unavailable — it made progress, or it simply did not try to
 * run a command — breaks the consecutive chain, because a chain of failures with
 * ordinary work in between is not a broken agent.
 */
export class GoalSafetyMonitor {
	/** Increments once per run, so a turn can be identified without a Pi turn id. */
	private turnKey = 0;
	/** What started the current run. */
	private kind: GoalRunKind = "user";

	private sawActivity = false;
	/** Whether a shell command actually ran in this Goal turn, whatever its outcome. */
	private sawShellRan = false;
	private sawExecutionFailure = false;

	private activityFreeTurns = 0;
	private executionUnavailableTurns = 0;

	/**
	 * Identity of the current run.
	 *
	 * Used to attribute a blocker report to one Goal turn, so several reports
	 * inside the same turn cannot satisfy the three-turn audit by themselves.
	 */
	get currentTurn(): number {
		return this.turnKey;
	}

	/** What started the current run. */
	get currentRunKind(): GoalRunKind {
		return this.kind;
	}

	/**
	 * Called when a run starts.
	 *
	 * `continuesPreviousTurn` marks Pi's retry of the run that just failed. A retry
	 * is the same Goal turn, so it neither advances the turn identity nor clears
	 * what the failed attempt observed: the Goal turn is judged on everything that
	 * happened in it, including the attempts that failed.
	 */
	beginRun(kind: GoalRunKind, continuesPreviousTurn = false): void {
		if (!continuesPreviousTurn) this.turnKey += 1;
		this.kind = kind;
	}

	/**
	 * Forget the observations of the Goal turn that was just evaluated.
	 *
	 * Called at the settlement boundary, which is the only place a Goal turn is
	 * known to be over: Pi may still retry the run that just ended, and an aborted
	 * run never reaches the boundary at all.
	 */
	endTurn(): void {
		this.kind = "user";
		this.sawActivity = false;
		this.sawShellRan = false;
		this.sawExecutionFailure = false;
	}

	/** Observe the finalized assistant message of a provider request in the current Goal turn. */
	noteAssistantMessage(message: AssistantMessageLike): void {
		if (hasMeaningfulText(message.content) || hasToolCall(message.content)) {
			this.sawActivity = true;
		}
	}

	/**
	 * Observe one finalized tool call in the current Goal turn.
	 *
	 * A shell command that actually ran — successfully, or with an ordinary
	 * failure — proves execution was available, so it is the only thing that
	 * resets the execution-unavailable chain. Two things that look like shell
	 * outcomes prove nothing either way and are ignored:
	 *
	 * - a *non-shell* tool, because a successful `get_goal` or `read` says nothing
	 *   about whether the shell works, and the continuation contract tells the
	 *   model to read state;
	 * - a shell call that never ran, because Pi reports a call rejected before
	 *   execution — invalid arguments, a permission block, an abort before start —
	 *   as an error result with no measured duration. Such a call is neither an
	 *   execution failure nor evidence that the shell works, so it must not hide a
	 *   genuine spawn failure in the same Goal turn.
	 */
	noteToolExecutionEnd(event: ToolExecutionEndLike): void {
		if (!EXECUTION_TOOLS.has(event.toolName)) return;
		if (event.durationMs === undefined) return;
		if (!event.isError) {
			this.sawShellRan = true;
			return;
		}
		if (isExecutionUnavailable(event)) {
			this.sawExecutionFailure = true;
			return;
		}
		// An ordinary command failure: the shell ran the command, so execution was
		// available even though the command failed.
		this.sawShellRan = true;
	}

	/**
	 * Evaluate the finished Goal turn and advance the counters.
	 *
	 * Returns a stop when a limit was reached by this Goal turn, which is the
	 * moment the caller transitions the Goal to `blocked` — before the boundary
	 * could ask for another continuation. Returns null for every Goal turn that is
	 * still inside the bounds, including turns that merely reset a counter.
	 *
	 * Only an `automatic` Goal turn that Pi finished cleanly can count. A kickoff
	 * or a user-started turn is attended work, and an aborted or errored turn is a
	 * hard exit Pi already owns; all of them reset the counters instead of
	 * advancing them, because none of them is an unattended Goal turn that
	 * malfunctioned.
	 */
	evaluateRun(outcome: AgentActivityOutcome): SafetyStop | null {
		if (outcome !== "completed" || this.kind !== "automatic") {
			this.activityFreeTurns = 0;
			this.executionUnavailableTurns = 0;
			return null;
		}

		if (this.sawActivity) {
			this.activityFreeTurns = 0;
		} else {
			this.activityFreeTurns += 1;
		}

		if (this.sawShellRan) {
			// Execution was available in this Goal turn, whatever the command did.
			this.executionUnavailableTurns = 0;
		} else if (this.sawExecutionFailure) {
			this.executionUnavailableTurns += 1;
		} else {
			// A Goal turn that ran no command at all — it answered, or it used
			// another tool — is not an execution failure, so it breaks the chain
			// rather than leaving it to be continued later.
			this.executionUnavailableTurns = 0;
		}

		return this.stopForCurrentCounts();
	}

	/** The stop the current counters imply, or null while they are inside the bounds. */
	private stopForCurrentCounts(): SafetyStop | null {
		if (this.activityFreeTurns >= ACTIVITY_FREE_TURN_LIMIT) {
			return {
				kind: "activity-free",
				turns: this.activityFreeTurns,
				blocker:
					`pi-goal stopped this Goal: ${ACTIVITY_FREE_TURN_LIMIT} consecutive automatic Goal turns produced no activity ` +
					"(no tool call, no output, and no reasoning), so the continuation loop was not making progress.",
			};
		}
		if (this.executionUnavailableTurns >= EXECUTION_UNAVAILABLE_TURN_LIMIT) {
			return {
				kind: "execution-unavailable",
				turns: this.executionUnavailableTurns,
				blocker:
					`pi-goal stopped this Goal: ${EXECUTION_UNAVAILABLE_TURN_LIMIT} consecutive automatic Goal turns could not execute a command ` +
					"(the shell failed to run, which is not the same as a command exiting non-zero, timing out, or being " +
					"aborted), so the agent could not act.",
			};
		}
		return null;
	}

	/**
	 * Forget every counter.
	 *
	 * Called on a user action (a prompt the user typed, an abort) and when a new
	 * Goal replaces the current one, so a human intervention or a fresh objective
	 * always starts from a clean audit.
	 */
	reset(): void {
		this.activityFreeTurns = 0;
		this.executionUnavailableTurns = 0;
		this.endTurn();
	}
}

/**
 * Evidence a provider failure carries, as far as Pi exposes it: the finalized
 * assistant message's error text plus any structured diagnostics a provider
 * attached.
 */
export interface ProviderFailureEvidence {
	errorMessage?: string;
	diagnostics?: unknown;
}

export type ProviderFailureKind = "usage-limit" | "terminal-error";

export interface ProviderFailureClassification {
	kind: ProviderFailureKind;
	/** The matched evidence, for the notification that surfaces the failure. */
	evidence: string;
}

/** The verbs that mean a limit, quota, or budget is used up. */
const EXHAUSTION_VERB = "(?:exceeded|exhausted|depleted|reached)";

/** Expand the verb placeholder in a pattern source. */
function withVerb(source: string): RegExp {
	return new RegExp(source.replace("EXHAUSTION_VERB", EXHAUSTION_VERB), "i");
}

/**
 * Evidence that names account or plan depletion directly.
 *
 * Every entry either names a provider error code whose meaning is a plan usage
 * limit, pairs a *usage limit*, *billing limit*, *account/plan/period quota*, or
 * *account/plan/period budget* with an exhaustion verb, or states that a credit
 * pool is empty. These may coexist with throttle wording in the same failure,
 * because they say the plan itself is used up rather than that a rate was hit —
 * which is why "429 rate limit reached; insufficient_quota: current quota
 * exhausted" is a usage limit and not a throttle.
 *
 * Bare account vocabulary is deliberately absent ("billing address could not be
 * verified", "billing service temporarily unavailable", "payment method
 * declined", "available balance"): those describe an account problem or a
 * transient condition, not an exhausted plan.
 */
const ACCOUNT_EXHAUSTION_PATTERNS: RegExp[] = [
	// Provider error codes and types whose meaning is a quota or plan usage limit.
	/insufficient[ _-]?quota/i,
	/(?:go|free)usagelimiterror/i,
	/"code"\s*:\s*"?1308(?![0-9])/,
	/subscription_sharing_[a-z_]*usage_limit_exceeded/i,
	// A usage limit that has been reached, in either word order.
	withVerb("usage[ _-]?limit[^.\n]{0,30}EXHAUSTION_VERB"),
	withVerb("EXHAUSTION_VERB[^.\n]{0,30}usage[ _-]?limit"),
	// An explicit billing, plan, spending, account, or subscription limit that has
	// been reached, in either word order — "billing hard limit has been reached" and
	// "You have reached your billing limit" are the same statement about the plan.
	withVerb("(?:billing|plan|spending|account|subscription)[ _-]?(?:hard[ _-]?)?limit[^.\n]{0,30}EXHAUSTION_VERB"),
	withVerb("EXHAUSTION_VERB[^.\n]{0,30}(?:billing|plan|spending|account|subscription)[ _-]?(?:hard[ _-]?)?limit"),
	// A quota that names the account, the plan, or a billing period.
	withVerb("(?:current|account|plan|billing|monthly|weekly|daily|remaining|total)[ _-]?quota[^.\n]{0,30}EXHAUSTION_VERB"),
	withVerb("EXHAUSTION_VERB[^.\n]{0,30}(?:current|account|plan|monthly|weekly|daily)[ _-]?quota"),
	// An account, plan, or period budget that has been used up. `retry` and `token`
	// are deliberately absent: those are Pi's or the request's own limits.
	withVerb("(?:spending|account|plan|monthly|weekly|daily|organization|org)[ _-]?budget[^.\n]{0,30}EXHAUSTION_VERB"),
	// Explicit exhaustion of a credit pool. An unqualified `budget` is absent here
	// on purpose: "out of budget" is at least as likely to describe this request's
	// own allowance as the account's plan.
	/out of credits/i,
	/credit balance (?:is )?too low/i,
];

/**
 * A bare quota plus an exhaustion verb, in either word order.
 *
 * This is also exactly how a provider describes a *per-minute quota metric* —
 * Google's "Quota exceeded for quota metric 'Generate Content API requests per
 * minute'." is a throttle that resets within a minute, not a used-up plan — so a
 * match here only counts when its sentence is not about a rate dimension.
 */
const QUOTA_EXHAUSTION_PATTERNS: RegExp[] = [
	withVerb("quota[^.\n]{0,30}EXHAUSTION_VERB"),
	withVerb("EXHAUSTION_VERB[^.\n]{0,30}quota"),
];

/** The weakest of the exhaustion verbs, and the only one an object can clarify. */
const REACHED_VERB = /\breached\b/i;

/**
 * Where the noun phrase a verb governs ends: the next word is a preposition, a
 * conjunction, or a subordinator, so the noun is over.
 *
 * "reached a timeout while checking your account" and "reached your usage limit for
 * the Anthropic API" both have a modifier phrase after the object, and only the
 * object itself may decide. Cutting here is what keeps "reached a timeout while
 * checking your usage limit" a lookup rather than reading the limit that follows.
 */
const OBJECT_PHRASE_END =
	/\b(?:for|of|while|when|after|before|because|since|until|during|via|per|with|without|and|but|or|so|if|unless|that|which|please|to|at|from|on|in|into|about|against)\b/i;

/**
 * A limit that really is the account's, so reaching it is exhaustion.
 *
 * These are the nouns the account tier already pairs with an exhaustion verb. A
 * bare `limit` is deliberately absent, because "rate limit" is a throttle and not
 * a plan limit; `quota` is present because a quota that was *reached* is a used-up
 * allowance, while the per-minute quota metric is caught by
 * {@link REACHED_THROTTLE_PATTERN} first and by the rate-dimension guard after.
 */
const GENUINE_LIMIT_PATTERN =
	/\b(?:usage[ _-]?limit|(?:billing|plan|spending|account|subscription)[ _-]?(?:hard[ _-]?)?limit|quota|budget)\b/i;

/**
 * Wording that makes the object a rate dimension rather than a used-up plan.
 *
 * Checked before {@link GENUINE_LIMIT_PATTERN}, because "rate limit" and "quota
 * metric" both contain limit vocabulary while naming a throttle: a per-minute
 * allowance resets, so reaching it is not exhaustion.
 */
const REACHED_THROTTLE_PATTERN =
	/\b(?:throttl\w*|rate[ _-]?limit|quota[ _-]?metric|requests?[ _-]?per[ _-]?(?:minute|second|hour)|per[ _-]?(?:minute|second|hour)|rpm|tpm|tokens?[ _-]?per[ _-]?(?:minute|second))\b/i;

/**
 * What `reached` reached, other than a limit: a lookup, a service, a check, an
 * endpoint, or a throttle.
 *
 * "The account quota service reached a timeout while checking your account" and
 * "The billing limit check reached a timeout" both describe a *check that timed
 * out*, and "The quota service reached a rate limit" describes a throttle.
 * Qualifying the noun does not change that, so this guard applies to the
 * account/plan tier as well as to a bare quota: what decides is the verb's object,
 * not how the subject was named.
 *
 * The object's own noun is what counts, and a modifier in front of it does not
 * turn a limit into a lookup. "You have reached the API usage limit", "You have
 * reached the API's usage limit", and "You have reached your service usage limit"
 * all name the API or the service as the *scope* of a limit that really was
 * reached, exactly as the trailing form does: the noun the verb governs is still
 * `usage limit`. Only when the object is not a limit at all — a timeout, a rate, a
 * lookup, a service, an endpoint — is it a lookup, and a clause that opens with a
 * preposition ("…reached for this service") has no object at all, which is the
 * same answer.
 */
const REACHED_OBJECT_PATTERN =
	/\b(?:checking|timeouts?|timed[ _-]?out|deadlines?|latency|services?|checks?|lookups?|verification|verify|apis?|endpoints?|servers?|status)\b/i;

/**
 * Wording that makes an exhaustion verb describe a rate dimension rather than a
 * used-up plan.
 *
 * "Quota exceeded for quota metric ... requests per minute" describes an allowance
 * that resets within a minute, and a per-minute metric can be *exceeded* as easily
 * as reached, so this guard covers the whole bare-quota tier, not just `reached`.
 */
const NON_EXHAUSTION_CONTEXT_PATTERN =
	/\b(?:timeout|timed out|time limit|deadline|latency|throttl\w*|rate[ _-]?limit|quota[ _-]?metric|requests?[ _-]?per[ _-]?(?:minute|second|hour)|per[ _-]?(?:minute|second|hour)|rpm|tpm|tokens?[ _-]?per[ _-]?(?:minute|second))\b/i;

/**
 * The sentence containing `index`, so a lookup or a rate dimension mentioned
 * *elsewhere* in the message cannot mask genuine exhaustion in this one.
 */
function sentenceAt(text: string, index: number): string {
	const lineStart = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("\n", index)) + 1;
	const period = text.indexOf(".", index);
	const newline = text.indexOf("\n", index);
	const lineEnd = Math.min(period === -1 ? text.length : period, newline === -1 ? text.length : newline);
	return text.slice(lineStart, lineEnd);
}

/**
 * The noun phrase the verb governs: the clause it owns, cut where a modifier
 * phrase begins.
 */
function reachedObject(text: string, matchIndex: number, matched: string): string {
	const verb = REACHED_VERB.exec(matched);
	if (!verb) return "";
	const clauseStart = matchIndex + (verb.index ?? 0) + verb[0].length;
	const clause = text.slice(clauseStart).split(/[.;\n]/)[0] ?? "";
	const cut = clause.search(OBJECT_PHRASE_END);
	return (cut === -1 ? clause : clause.slice(0, cut)).trim();
}

/**
 * Whether a `reached`-based match says a limit was reached or that a lookup was.
 *
 * Only the object the verb governs is inspected, and only for `reached`: the
 * stronger verbs — exceeded, exhausted, depleted — name the outcome directly, and
 * a provider usage-limit error code carries no verb at all. The clause the verb
 * owns still ends at the next `;`, `.`, or newline, so "You have reached your
 * usage limit; please check your plan" keeps its remark out of the object.
 *
 * Three questions, in order. A rate dimension is a throttle whatever else the
 * phrase says ("reached a rate limit", "reached a quota metric"). A genuine limit
 * is exhaustion, and a modifier in front of it — an API, a service — is the limit's
 * scope rather than its identity ("reached the API usage limit"). Only an object
 * that is neither is a lookup ("reached a timeout", "reached a service"), and no
 * object at all ("reached for this service") is exhaustion, because there is
 * nothing that was reached but the limit the subject named.
 */
function reachedALookup(text: string, matchIndex: number, matched: string): boolean {
	const object = reachedObject(text, matchIndex, matched);
	if (REACHED_THROTTLE_PATTERN.test(object)) return true;
	if (GENUINE_LIMIT_PATTERN.test(object)) return false;
	return REACHED_OBJECT_PATTERN.test(object);
}

/**
 * Wording that negates a statement.
 *
 * "You have not exceeded your quota" and "Your quota is not exceeded" are a
 * provider saying the plan is fine, so a negation turns exhaustion into its
 * opposite. It is checked in two places, because the negation can sit on either
 * side of the verb:
 *
 * - inside the matched phrase, which is what catches "quota is not exceeded";
 * - in the short window in front of the match, which catches "not exceeded your
 *   quota". That window stops at a sentence boundary, so "This is not a rate
 *   limit. Your quota is exceeded." keeps its second, unnegated statement.
 */
const NEGATION_WORD = "(?:no|none|not|never|cannot|can't|couldn't|won't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|without|unable)";
const NEGATION_WINDOW = 40;
/** Negation anywhere inside the matched phrase, as in "quota is not exceeded". */
const NEGATION_PATTERN = new RegExp(`\\b${NEGATION_WORD}\\b`, "i");
/**
 * Negation in the window in front of the match, as in "not exceeded your quota".
 * The window stops at a sentence boundary, so a negated sentence does not suppress
 * an unnegated one that follows it.
 */
const NEGATION_BEFORE_PATTERN = new RegExp(`\\b${NEGATION_WORD}\\b[^.\\n]{0,30}$`, "i");

/** Everything Pi exposes about one provider failure, flattened for matching. */
function evidenceText(evidence: ProviderFailureEvidence): string {
	const parts: string[] = [];
	if (typeof evidence.errorMessage === "string") parts.push(evidence.errorMessage);
	if (evidence.diagnostics !== undefined) {
		try {
			parts.push(JSON.stringify(evidence.diagnostics));
		} catch {
			// Diagnostics that cannot be serialized carry no matchable evidence.
		}
	}
	return parts.join("\n");
}

/**
 * Classify a terminal provider failure.
 *
 * `usage-limit` requires explicit evidence: the error text or a provider
 * diagnostic has to say the account, plan, or budget is exhausted. Anything else
 * — an authentication failure, a malformed request, a content-policy refusal, an
 * exhausted retry budget — is a `terminal-error`, which stops the continuation
 * for that run and leaves the Goal active so the next successful run resumes it.
 */
export function classifyProviderFailure(evidence: ProviderFailureEvidence): ProviderFailureClassification {
	const text = evidenceText(evidence);
	// Account or plan depletion is looked for first and is decisive: it survives
	// throttle wording in the same failure, because it says the plan itself is used
	// up. Every match of every pattern is scanned, so a rejected earlier one cannot
	// hide a later statement of exhaustion.
	const exhausted = firstEvidence(text, ACCOUNT_EXHAUSTION_PATTERNS, false);
	if (exhausted !== null) {
		return { kind: "usage-limit", evidence: exhausted };
	}
	// A bare quota plus an exhaustion verb is then considered, but only when its
	// sentence is not about a rate dimension: that is the wording of a per-minute
	// quota metric, which is a throttle.
	const quota = firstEvidence(text, QUOTA_EXHAUSTION_PATTERNS, true);
	if (quota !== null) {
		return { kind: "usage-limit", evidence: quota };
	}
	return { kind: "terminal-error", evidence: terminalEvidence(evidence) };
}

/**
 * The first match of any pattern that survives the guards, or null.
 *
 * `guardRateContext` adds the lookup/rate-dimension guard used for the bare-quota
 * tier. Scanning every match rather than only the first is what lets a later
 * sentence state exhaustion after an earlier one was rejected as a lookup.
 */
function firstEvidence(text: string, patterns: RegExp[], guardRateContext: boolean): string | null {
	for (const pattern of patterns) {
		// A fresh global regex per pattern, so no lastIndex state leaks between calls.
		const scanner = new RegExp(pattern.source, `${pattern.flags}g`);
		for (const match of text.matchAll(scanner)) {
			const index = match.index ?? 0;
			const matched = match[0];
			if (NEGATION_PATTERN.test(matched)) continue;
			const before = text.slice(Math.max(0, index - NEGATION_WINDOW), index);
			if (NEGATION_BEFORE_PATTERN.test(before)) continue;
			// "reached" is the weakest verb in both tiers: whatever it reached decides
			// whether a limit was hit or a lookup was, and a qualified noun does not
			// change that.
			if (reachedALookup(text, index, matched)) continue;
			if (guardRateContext && NON_EXHAUSTION_CONTEXT_PATTERN.test(sentenceAt(text, index))) continue;
			return matched;
		}
	}
	return null;
}

/** The error text to surface for a failure that is not a usage limit. */
function terminalEvidence(evidence: ProviderFailureEvidence): string {
	const message = typeof evidence.errorMessage === "string" ? evidence.errorMessage.trim() : "";
	return message.length > 0 ? message : "unknown provider error";
}
