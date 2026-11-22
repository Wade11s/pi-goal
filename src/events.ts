/**
 * The local Goal-updated event contract (issue #48).
 *
 * pi-goal publishes one event on Pi's shared extension event bus after every
 * meaningful durable Goal transition, so other local extensions can react to
 * *committed* state rather than optimistic UI state. The bus is the public seam:
 * any extension subscribes with `pi.events.on("pi-goal:updated", ...)` and
 * receives the payload below; pi-goal never requires a listener, and a listener
 * failure can never roll back the transition that was already committed (the bus
 * isolates handlers and logs their failures as its own diagnostics).
 *
 * Emission is strictly durable-before-announced, like every other observer
 * surface in this extension: an event is emitted only after the corresponding
 * `goal-state` snapshot or tombstone has been appended, and a transition that
 * fails, is refused, or is rolled back emits nothing. Conversely the stream is
 * deliberately *not* an accounting feed: token deltas, active-time ticks, and
 * `goal-usage` checkpoints never emit — only lifecycle-level transitions do —
 * so an idle listener costs nothing while a Goal works.
 *
 * The payload describes the committed record, not the objective itself: the
 * `objective` field is metadata (length and origin) because the event is
 * machine-consumed by any loaded extension and is therefore the same trust and
 * privacy surface as a log line, while the verbatim objective stays where its
 * trust boundary already lives (the durable snapshot and the delimited data
 * block in Goal messages).
 */
import { normalizeUsage } from "./accounting.ts";
import type { GoalOrigin, GoalRecord, GoalStatus } from "./goal.ts";

/** Channel on Pi's shared extension event bus. */
export const GOAL_UPDATED_EVENT = "pi-goal:updated";

/**
 * Every transition kind the stream covers.
 *
 * One kind per meaningful durable transition: the create paths (`created` for a
 * fresh slot, `replaced` when a Replacement Goal takes the slot), the in-place
 * objective edit, the user- and model-driven `paused`, every user restart of a
 * non-continuing state (`resumed`), the one budget-raising restart of a
 * `budget_limited` Goal (`budget-recovered`), the durable clear tombstone
 * (`cleared`), and the four terminal stops (`blocked`, `usage-limited`,
 * `budget-limited`, `completed`).
 */
export const GOAL_TRANSITION_KINDS = [
	"created",
	"replaced",
	"objective-edited",
	"paused",
	"resumed",
	"budget-recovered",
	"cleared",
	"blocked",
	"usage-limited",
	"budget-limited",
	"completed",
] as const;
export type GoalTransitionKind = (typeof GOAL_TRANSITION_KINDS)[number];

/** Objective metadata: what the event says about the objective, deliberately not its text. */
export interface GoalEventObjective {
	/** Character length of the committed objective, after the store's validation trim. */
	length: number;
	/** Who created the Goal: "command" (user typed /goal) or "tool" (model called create_goal). */
	origin: GoalOrigin;
}

/** The committed usage summary, mirroring `get_goal`'s usage projection. */
export interface GoalEventUsage {
	/** Accounted Goal tokens: non-cached input + output + cache writes. */
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheWriteTokens: number;
	/** Cached-read tokens seen and excluded from `totalTokens`. */
	cachedReadTokens: number;
	/** Reasoning tokens, already inside `outputTokens`. */
	reasoningTokens: number;
	/** Nested and summarization usage, counted once, already inside `totalTokens`. */
	nestedTokens: number;
	/** Whole seconds the Goal was active in a live session. */
	activeSeconds: number;
}

/** The committed Goal identity and state the event describes. */
export interface GoalUpdatedGoal {
	id: string;
	/** Revision as committed by this transition (the clear event keeps the cleared Goal's last revision). */
	revision: number;
	/** Lifecycle status as committed (for a clear, the status the Goal had when cleared). */
	status: GoalStatus;
	objective: GoalEventObjective;
	/** The cumulative token ceiling, or null when the Goal is unbounded. */
	tokenBudget: number | null;
	usage: GoalEventUsage;
}

/** Payload of one `pi-goal:updated` event. */
export interface GoalUpdatedEvent {
	version: 1;
	kind: GoalTransitionKind;
	goal: GoalUpdatedGoal;
	/** ISO timestamp of the committed transition (the snapshot's own `updatedAt`). */
	timestamp: string;
}

/**
 * Project the committed record into the event payload.
 *
 * `committedAt` is the transition's own time — the snapshot's `updatedAt`, which
 * makes the event exactly as old as the durable write it describes. A clear has
 * no record to carry a timestamp, so its caller supplies the clear time instead.
 */
export function toGoalUpdatedEvent(
	kind: GoalTransitionKind,
	goal: GoalRecord,
	committedAt: number = goal.updatedAt,
): GoalUpdatedEvent {
	const usage = normalizeUsage(goal.usage);
	return {
		version: 1,
		kind,
		goal: {
			id: goal.id,
			revision: goal.revision,
			status: goal.status,
			objective: {
				length: goal.objective.length,
				origin: goal.origin ?? "command",
			},
			tokenBudget: goal.tokenBudget ?? null,
			usage: {
				totalTokens: usage.totalTokens,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheWriteTokens: usage.cacheWriteTokens,
				cachedReadTokens: usage.cachedReadTokens,
				reasoningTokens: usage.reasoningTokens,
				nestedTokens: usage.nestedTokens,
				activeSeconds: Math.floor(usage.activeMs / 1000),
			},
		},
		timestamp: new Date(committedAt).toISOString(),
	};
}
