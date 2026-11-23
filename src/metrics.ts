/**
 * Privacy-safe operational metrics for committed Goal transitions (issue #55).
 *
 * The projection is derived *only* from the committed `pi-goal:updated` event —
 * never from a live Goal record, never by polling the store — so a metric and
 * the durable snapshot it describes can never disagree, and a metric exists only
 * for a transition that actually committed.
 *
 * The projection is an explicit **allowlist**. Every field is read by name from
 * the event and written into a fresh object; nothing is spread or copied. That is
 * what keeps the metrics surface privacy-safe by construction rather than by
 * review: Objective text, Blocker descriptions, attachment contents, source file
 * names, source URLs, raw session identifiers, and raw user prompts have no field
 * to travel in, and a future event field (however sensitive) is invisible to
 * metrics until someone deliberately adds it here *and* updates the pinned key
 * set in `test/goal55-metrics-store.test.mjs`. The Goal title is in the same
 * position: it is label text under the Objective's privacy boundary, so no
 * metric carries it.
 *
 * `createGoalMetricsPublisher` is the optional local consumer seam. pi-goal
 * hands the projection to a sink (in core: an emit on Pi's shared extension
 * event bus, channel `pi-goal:metrics`) and never awaits it. A sink that throws,
 * or a returned promise that rejects, is isolated exactly like the
 * `pi-goal:updated` listener path: it cannot roll back the committed transition,
 * cannot surface as a durability failure, and cannot stop later metrics. pi-goal
 * core itself performs no network I/O and carries no hosted-exporter dependency;
 * a hosted companion is documented in `docs/behavior/metrics.md` and installed
 * separately.
 */
import { isBudgetExhausted, remainingTokens } from "./accounting.ts";
import type { GoalStatus } from "./goal.ts";
import { type GoalTransitionKind, type GoalUpdatedEvent } from "./events.ts";
import { PI_GOAL_VERSION } from "./version.ts";

/**
 * Channel on Pi's shared extension event bus carrying the pre-redacted
 * projection. A local consumer — a logger, an aggregate counter, or an
 * explicitly installed hosted exporter — subscribes to this instead of
 * `pi-goal:updated`, so it never receives the broader local event payload.
 */
export const GOAL_METRICS_CHANNEL = "pi-goal:metrics";

/** Bumps only if the metric shape itself changes. */
export const GOAL_METRICS_VERSION = 1;

/**
 * Budget state as the committed event reports it.
 *
 * `unbounded` means the Goal carries no Token budget; `within-budget` means it
 * does and accounted usage is below it; `exhausted` means accounted usage has
 * reached or passed it (an overshoot is reported as exhausted with zero
 * remaining, never as a negative remainder).
 */
export type GoalMetricsBudgetState = "unbounded" | "within-budget" | "exhausted";

/** The committed budget state, derived from the event rather than read live. */
export interface GoalMetricsBudget {
	state: GoalMetricsBudgetState;
	/** The cumulative Token ceiling, or `null` when unbounded. */
	limitTokens: number | null;
	/** Tokens of headroom before the ceiling, or `null` when unbounded. */
	remainingTokens: number | null;
}

/**
 * One privacy-safe operational record for one committed Goal transition.
 *
 * Deliberately absent: Goal identity and revision (a per-Goal correlation key is
 * an identifier a hosted backend does not need for operational metrics),
 * objective text or its length/origin, Goal title text, Blocker text, attachment
 * material and manifest, source paths and URLs, session identifiers, and prompt
 * text.
 */
export interface GoalMetrics {
	/** The metric schema version. */
	version: typeof GOAL_METRICS_VERSION;
	/** The pi-goal release that produced the record. */
	extensionVersion: string;
	/** The committed transition kind. */
	kind: GoalTransitionKind;
	/** The Lifecycle status as committed. */
	status: GoalStatus;
	/** Accounted Goal tokens (input + output + cache writes). */
	totalTokens: number;
	/** Whole seconds the Goal was active in a live session. */
	activeSeconds: number;
	/** Committed budget state. */
	budget: GoalMetricsBudget;
	/** ISO timestamp of the committed transition. */
	timestamp: string;
}

/**
 * Project one committed Goal-updated event into its privacy-safe metric.
 *
 * Pure and synchronous: same event in, same metric out, no I/O, no clock. The
 * output object is rebuilt field by field, so extra fields on the input (a
 * future event version, a test canary, an accidentally attached record) are
 * dropped rather than forwarded.
 */
export function toGoalMetrics(
	event: GoalUpdatedEvent,
	extensionVersion: string = PI_GOAL_VERSION,
): GoalMetrics {
	const tokenBudget = event.goal.tokenBudget ?? undefined;
	const accounted = event.goal.usage.totalTokens;
	const exhausted = isBudgetExhausted(tokenBudget, accounted);
	return {
		version: GOAL_METRICS_VERSION,
		extensionVersion,
		kind: event.kind,
		status: event.goal.status,
		totalTokens: accounted,
		activeSeconds: event.goal.usage.activeSeconds,
		budget: {
			state: tokenBudget === undefined ? "unbounded" : exhausted ? "exhausted" : "within-budget",
			limitTokens: tokenBudget ?? null,
			remainingTokens: remainingTokens(tokenBudget, accounted) ?? null,
		},
		timestamp: event.timestamp,
	};
}

/**
 * A local metrics consumer: a logger, a counter, or a companion exporter's
 * receive path. It may be async, and its failure is never pi-goal's.
 */
export type GoalMetricsConsumer = (metrics: GoalMetrics) => void | Promise<void>;

/** Options for {@link createGoalMetricsPublisher}. */
export interface GoalMetricsPublisherOptions {
	/** Where each projection is delivered. Failure is isolated. */
	sink: GoalMetricsConsumer;
	/** Override the reported extension version (tests pin the default instead). */
	extensionVersion?: string;
	/**
	 * Optional diagnostics hook for a sink failure. It is advisory only: it never
	 * changes a return value, must not throw (a throw is swallowed), and must not
	 * be used to report a durability problem — the transition is already durable.
	 */
	onError?: (error: unknown) => void;
}

/** The optional local consumer seam. */
export interface GoalMetricsPublisher {
	/**
	 * Project and deliver one committed event. Best effort by construction and
	 * deliberately returns nothing: there is no success flag a caller could
	 * mistake for — or turn into — a durability result.
	 */
	publish(event: GoalUpdatedEvent): void;
}

/**
 * Build a failure-isolated publisher over `sink`.
 *
 * Delivery is synchronous up to the sink call, so metrics keep commit order. A
 * sink that throws is caught; a sink that returns a rejected promise has the
 * rejection attached to a handler immediately, so it can never become an
 * unhandled rejection that crashes the host. Either way `publish` still does not
 * throw, the transition underneath is already committed, and the next committed
 * transition still publishes.
 */
export function createGoalMetricsPublisher(
	options: GoalMetricsPublisherOptions,
): GoalMetricsPublisher {
	const report = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Diagnostics are advisory; a broken hook is not a metrics failure.
		}
	};

	return {
		publish(event: GoalUpdatedEvent): void {
			let result: void | Promise<void>;
			try {
				result = options.sink(toGoalMetrics(event, options.extensionVersion));
			} catch (error) {
				report(error);
				return;
			}
			if (result !== null && typeof result === "object" && typeof result.then === "function") {
				void result.then(undefined, (error: unknown) => report(error));
			}
		},
	};
}
