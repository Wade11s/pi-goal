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

/**
 * Wording that means the account, plan, or budget is *exhausted*, as opposed to a
 * transient throttle, an internal technical budget, or an unrelated account
 * problem.
 *
 * Every entry pairs a quota / usage-limit / credit noun with an exhaustion verb,
 * pairs a billing or plan limit with one, or names a provider error code whose
 * meaning is a plan usage limit. Three kinds of look-alike are deliberately
 * excluded, because each of them would stop a Goal permanently on evidence that
 * does not support it:
 *
 * - bare account vocabulary ("billing address could not be verified", "billing
 *   service temporarily unavailable", "payment method declined", "available
 *   balance") describes an account problem or a transient condition;
 * - internal budgets ("retry budget exhausted", "token budget exceeded for this
 *   request") are Pi's or the request's own limits, not the account's plan, so
 *   the budget noun must name an account, plan, or period;
 * - a *billing or plan limit* that has been reached is exhaustion, which is why
 *   those nouns are matched explicitly.
 *
 * The narrowness is the point. `usage_limited` is terminal for continuation and
 * resuming it is a user decision, so a false positive wedges the session's Goal;
 * a false negative only costs one more surfaced terminal error.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
	// Provider error codes and types whose meaning is a quota or plan usage limit.
	/insufficient[ _-]?quota/i,
	/(?:go|free)usagelimiterror/i,
	/"code"\s*:\s*"?1308(?![0-9])/,
	/subscription_sharing_[a-z_]*usage_limit_exceeded/i,
	// A usage limit or quota that has been reached, in either word order.
	/usage[ _-]?limit[^.\n]{0,30}EXHAUSTION_VERB/i,
	/EXHAUSTION_VERB[^.\n]{0,30}usage[ _-]?limit/i,
	/quota[^.\n]{0,30}EXHAUSTION_VERB/i,
	/EXHAUSTION_VERB[^.\n]{0,30}quota/i,
	// An explicit billing or plan limit that has been reached.
	/(?:billing|plan|spending|account|subscription)[ _-]?(?:hard[ _-]?)?limit[^.\n]{0,30}EXHAUSTION_VERB/i,
	// An account, plan, or period budget that has been used up.
	/(?:spending|account|plan|monthly|weekly|daily|organization|org)[ _-]?budget[^.\n]{0,30}EXHAUSTION_VERB/i,
	// Explicit exhaustion of a credit pool. `budget` is deliberately absent here: an
	// unqualified "out of budget" is at least as likely to describe this request's
	// own allowance ("The request is out of budget for this call") as the account's
	// plan, and only a qualified account, plan, or period budget matches above.
	/out of credits/i,
	/credit balance (?:is )?too low/i,
].map((pattern) => new RegExp(pattern.source.replace("EXHAUSTION_VERB", EXHAUSTION_VERB), pattern.flags));

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
const NEGATION_WORD = "(?:not|never|cannot|can't|couldn't|won't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|without|unable)";
const NEGATION_WINDOW = 40;
/** Negation anywhere inside the matched phrase, as in "quota is not exceeded". */
const NEGATION_PATTERN = new RegExp(`\\b${NEGATION_WORD}\\b`, "i");
/**
 * Negation in the window in front of the match, as in "not exceeded your quota".
 * The window stops at a sentence boundary, so a negated sentence does not suppress
 * an unnegated one that follows it.
 */
const NEGATION_BEFORE_PATTERN = new RegExp(`\\b${NEGATION_WORD}\\b[^.\\n]{0,30}$`, "i");

/**
 * Wording that makes "reached" describe a lookup or a timeout rather than an
 * exhausted plan.
 *
 * "The quota service reached a timeout while checking your account" contacted the
 * service and did not exhaust anything. `reached` is the weakest of the four verbs
 * — a service can reach a timeout, and only a limit can be reached — so a match
 * that leans on it needs a context free of timeout wording.
 */
const LOOKUP_CONTEXT_PATTERN = /\b(?:timeout|timed out|time limit|deadline|latency|throttl\w*)\b/i;

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
	// Definitive exhaustion evidence is evaluated first, and nothing else can
	// suppress it: a provider can report a throttle and an exhausted quota in the
	// same failure ("429 rate limit reached; insufficient_quota: current quota
	// exhausted"), and it is the quota that needs a user decision. A plain rate
	// limit matches none of the patterns above — no quota, usage-limit, billing, or
	// account-budget noun — so it stays a terminal error on its own.
	const exhausted = matchExhaustionEvidence(text);
	if (exhausted !== null) {
		return { kind: "usage-limit", evidence: exhausted };
	}
	return { kind: "terminal-error", evidence: terminalEvidence(evidence) };
}

/** `reached`, the weakest of the exhaustion verbs. */
const REACHED_VERB = /\breached\b/i;

/**
 * The exhaustion evidence in a provider failure, or null when there is none.
 *
 * A pattern match is only evidence when it survives every guard: it is not
 * negated, either inside the matched phrase or just in front of it, and a match
 * that leans on `reached` does not sit in timeout or throttling wording. The
 * stronger verbs — exceeded, exhausted, depleted — are unambiguous and only the
 * negation guards apply to them.
 */
function matchExhaustionEvidence(text: string): string | null {
	for (const pattern of USAGE_LIMIT_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) continue;
		if (NEGATION_PATTERN.test(match[0])) continue;
		const before = text.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index);
		if (NEGATION_BEFORE_PATTERN.test(before)) continue;
		if (REACHED_VERB.test(match[0]) && LOOKUP_CONTEXT_PATTERN.test(text)) continue;
		return match[0];
	}
	return null;
}

/** The error text to surface for a failure that is not a usage limit. */
function terminalEvidence(evidence: ProviderFailureEvidence): string {
	const message = typeof evidence.errorMessage === "string" ? evidence.errorMessage.trim() : "";
	return message.length > 0 ? message : "unknown provider error";
}
