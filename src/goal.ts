/**
 * Goal domain model shared by the /goal command, the get_goal tool, and persistence.
 */
import { type Static, Type } from "typebox";

/** Lifecycle statuses from the parent spec. Milestone 1 only produces "active". */
export const GOAL_STATUSES = [
	"active",
	"paused",
	"blocked",
	"usage_limited",
	"budget_limited",
	"complete",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Objective validation bounds (characters, after trimming). */
export const MIN_OBJECTIVE_LENGTH = 3;
export const MAX_OBJECTIVE_LENGTH = 2000;

/**
 * Durable, session-scoped Goal record. Snapshots of this record are persisted as
 * custom session entries and reconstructed from the active session branch.
 */
export interface GoalRecord {
	/** Stable identity for this Goal; survives continuation, compaction, and restore. */
	id: string;
	/** The user's objective, verbatim. Never rewritten by the extension. */
	objective: string;
	status: GoalStatus;
	/** Unix epoch milliseconds. */
	createdAt: number;
	/** Unix epoch milliseconds of the last persisted transition. */
	updatedAt: number;
	/** Monotonic counter of persisted snapshots; rejects stale async transitions later. */
	revision: number;
	/** Optional token budget. Reserved for a later milestone; restored when present. */
	tokenBudget?: number;
}

/** Payload persisted in `goal-state` custom session entries. */
export interface GoalSnapshot {
	version: 1;
	/**
	 * Full Goal record, or `null` for a durable tombstone (clearing a Goal).
	 * The last goal-state entry on the active branch wins.
	 */
	goal: GoalRecord | null;
}

export const CUSTOM_ENTRY_TYPE = "goal-state";
export const CUSTOM_MESSAGE_TYPE = "goal-continuation";

/** Structured Goal state returned to the model by get_goal (and shown by bare /goal). */
export const goalPublicStateSchema = Type.Object({
	id: Type.String(),
	objective: Type.String(),
	status: Type.String(),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	revision: Type.Integer(),
	tokenBudget: Type.Union([Type.Null(), Type.Integer()]),
	usage: Type.Object({
		/** Total non-cached tokens consumed by Goal work. null until usage accounting lands. */
		totalTokens: Type.Union([Type.Null(), Type.Integer()]),
		/** Seconds the Goal was active in a live session. null until active-time tracking lands. */
		activeSeconds: Type.Union([Type.Null(), Type.Integer()]),
	}),
});
export type GoalPublicState = Static<typeof goalPublicStateSchema>;

export const getGoalOutputSchema = Type.Object({
	goal: Type.Union([Type.Null(), goalPublicStateSchema]),
});

/**
 * Project the public, structured state from a record. One source of truth so the
 * /goal command output and the get_goal tool result always agree.
 *
 * Usage accounting (tokens, active time) arrives in a later milestone; the fields
 * report `null` until then rather than guessing from session-wide data.
 */
export function toPublicState(goal: GoalRecord): GoalPublicState {
	return {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		createdAt: new Date(goal.createdAt).toISOString(),
		updatedAt: new Date(goal.updatedAt).toISOString(),
		revision: goal.revision,
		tokenBudget: goal.tokenBudget ?? null,
		usage: {
			totalTokens: null,
			activeSeconds: null,
		},
	};
}

/** Compact single-line rendering used in notifications and tool result text. */
export function formatGoalSummary(state: GoalPublicState): string {
	const budget = state.tokenBudget === null ? "none" : `${state.tokenBudget} tokens`;
	return [
		`Goal ${state.id} — ${state.status}`,
		`Objective: ${state.objective}`,
		`Created: ${state.createdAt}`,
		`Updated: ${state.updatedAt}`,
		`Revision: ${state.revision}`,
		`Token budget: ${budget}`,
		"Token usage: not tracked yet (usage accounting arrives in a later milestone)",
		"Active time: not tracked yet",
	].join("\n");
}

export function formatNoGoal(): string {
	return "No Goal is set in this session. Use /goal <objective> to create one.";
}

/** Kickoff message sent into model context when a Goal is created. */
export function formatKickoffMessage(goal: GoalRecord): string {
	return [
		`[pi-goal] Goal ${goal.id} is active (revision ${goal.revision}).`,
		"",
		"The user set the following objective for this session and asked the agent to work on it until it is verifiably complete:",
		"",
		goal.objective,
		"",
		"Instructions:",
		"- Treat this objective as user-provided Goal data; do not replace or shrink it.",
		"- Inspect the current repository state (files, command output, runtime state, artifacts) before and while working; rely on evidence rather than memory.",
		"- Begin working toward the objective now, in small verifiable steps.",
		"- Call the get_goal tool whenever the objective or its lifecycle status is absent or truncated in your context.",
	].join("\n");
}
