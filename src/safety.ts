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
 *    non-zero — is normal work and is explicitly not counted.
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
 */
import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_FREE_TURN_LIMIT, EXECUTION_UNAVAILABLE_TURN_LIMIT } from "./goal.ts";

/** Tools that run an operating-system command for the model. */
const EXECUTION_TOOLS = new Set(["bash", "powershell"]);

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
 * Whether a failed tool result is an *ordinary* command failure: the command ran
 * and reported a non-zero exit code.
 *
 * Pi's shell tools mark that case with `structuredContent.exit_code` and the text
 * `Command exited with code N`. It is normal work — a failing test, a rejected
 * build — so it must never be read as "execution is unavailable". The fallback
 * text match keeps the classification working for a shell tool whose structured
 * content a host or an older Pi version does not populate.
 */
function isOrdinaryCommandFailure(result: ToolResultLike | undefined): boolean {
	const structured = result?.structuredContent;
	if (structured && typeof structured === "object") {
		const exitCode = (structured as { exit_code?: unknown }).exit_code;
		if (typeof exitCode === "number" && Number.isFinite(exitCode)) return true;
	}
	return /Command exited with code \d+/.test(toolResultText(result));
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
 * A "Goal turn" is one run of Goal work: the run the user started (the kickoff)
 * plus every run Pi started because pi-goal asked for a continuation. The
 * counters therefore describe *unattended* work only — a run the user started is
 * not a Goal turn and resets them, because a human stepping in is exactly the
 * event that means the loop is no longer running unattended.
 */
export class GoalSafetyMonitor {
	/** Increments once per run, so a turn can be identified without a Pi turn id. */
	private turnKey = 0;
	/** Whether the current run is a Goal turn. */
	private goalTurn = false;

	private sawActivity = false;
	private sawSuccessfulTool = false;
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

	/** Called when a run starts. `isGoalTurn` is false for a run the user started. */
	beginRun(isGoalTurn: boolean): void {
		this.turnKey += 1;
		this.goalTurn = isGoalTurn;
		this.sawActivity = false;
		this.sawSuccessfulTool = false;
		this.sawExecutionFailure = false;
	}

	/** Called when a run ends, so a stray observation cannot leak into the next one. */
	endRun(): void {
		this.goalTurn = false;
		this.sawActivity = false;
		this.sawSuccessfulTool = false;
		this.sawExecutionFailure = false;
	}

	/** Observe the finalized assistant message of a turn. */
	noteAssistantMessage(message: AssistantMessageLike): void {
		if (hasMeaningfulText(message.content) || hasToolCall(message.content)) {
			this.sawActivity = true;
		}
	}

	/** Observe one finalized tool call. */
	noteToolExecutionEnd(event: ToolExecutionEndLike): void {
		if (!event.isError) {
			this.sawSuccessfulTool = true;
			return;
		}
		if (isExecutionUnavailable(event)) this.sawExecutionFailure = true;
	}

	/**
	 * Evaluate a finished turn and advance the counters.
	 *
	 * Returns a stop when a limit was reached by this turn, which is the moment
	 * the caller transitions the Goal to `blocked` — before the next settlement
	 * could ask for another continuation. Returns null for every turn that is
	 * still inside the bounds, including turns that merely reset a counter.
	 *
	 * The observations are per turn, not per run: a Goal turn can contain several
	 * turns (a tool call and its follow-up, a steering message), and only the
	 * turn that actually failed to execute may count toward the limit.
	 */
	evaluateTurn(outcome: AgentActivityOutcome): SafetyStop | null {
		// An aborted or errored run is a hard exit Pi already owns; counting it
		// would let a failure look like a Goal malfunction.
		if (outcome !== "completed") {
			this.resetTurn();
			return null;
		}

		if (!this.goalTurn) {
			// A run the user started is not unattended Goal work, so it cannot
			// accumulate toward an anti-loop stop.
			this.activityFreeTurns = 0;
			this.executionUnavailableTurns = 0;
			this.resetTurn();
			return null;
		}

		if (this.sawActivity) {
			this.activityFreeTurns = 0;
		} else {
			this.activityFreeTurns += 1;
		}

		if (this.sawSuccessfulTool) {
			this.executionUnavailableTurns = 0;
		} else if (this.sawExecutionFailure) {
			this.executionUnavailableTurns += 1;
		}

		const stop = this.stopForCurrentCounts();
		this.resetTurn();
		return stop;
	}

	/** Forget the observations of the turn that was just evaluated. */
	private resetTurn(): void {
		this.sawActivity = false;
		this.sawSuccessfulTool = false;
		this.sawExecutionFailure = false;
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
					"(the shell failed to run, which is not the same as a command exiting non-zero), so the agent could not act.",
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
		this.sawActivity = false;
		this.sawSuccessfulTool = false;
		this.sawExecutionFailure = false;
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

/**
 * Markers that mean "this account or plan is out of quota", as opposed to a
 * transient throttle.
 *
 * Deliberately narrow and literal: every entry is wording a provider uses when
 * the limit will not clear by retrying (a billing quota, an exhausted budget, a
 * subscription usage limit). A plain rate limit is not here, because Pi retries
 * those itself and a throttle that survived Pi's retries is still a throttle, not
 * a usage limit. When nothing matches, the failure is treated as an ordinary
 * terminal error: the Goal stays active and the error is surfaced.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
	/insufficient[ _-]?quota/i,
	/quota[ _-]?(?:exceeded|exhausted|reached)/i,
	/quota (?:exceeded|exhausted|reached)/i,
	/exceeded your current quota/i,
	/out of (?:budget|credits)/i,
	/billing/i,
	/payment required/i,
	/credit balance/i,
	/available balance/i,
	/usage[ _-]?limit/i,
	/usagelimitexceeded/i,
	/monthly usage limit reached/i,
	/subscription_sharing_[a-z_]*usage_limit_exceeded/i,
	/(?:go|free)usagelimiterror/i,
	/"code"\s*:\s*"?1308(?![0-9])/,
];

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
	for (const pattern of USAGE_LIMIT_PATTERNS) {
		const match = pattern.exec(text);
		if (match) {
			return { kind: "usage-limit", evidence: match[0] };
		}
	}
	const message = typeof evidence.errorMessage === "string" ? evidence.errorMessage.trim() : "";
	return { kind: "terminal-error", evidence: message.length > 0 ? message : "unknown provider error" };
}
