/**
 * Persistence and reconstruction of the Goal from the session's custom entries.
 *
 * Goal snapshots are stored as `goal-state` custom session entries (outside model
 * context). The current state is reconstructed from the last such entry on the
 * active session branch, so restart, resume, reload, fork, and tree navigation
 * all reconstruct the state that belongs to the selected branch.
 *
 * Creation is staged before it is announced: `stage()` only writes the snapshot
 * (throwing on write failure without touching memory), `commit()` makes it
 * visible, and `rollback()` retracts it with a durable tombstone. Pi 1.5.1
 * defers creating the session file until the first user/assistant message, so
 * durability is confirmed separately (`isDurable`) before success is reported.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BLOCKED_AUDIT_THRESHOLD,
	CUSTOM_ENTRY_TYPE,
	type GoalRecord,
	type GoalSnapshot,
	type GoalOrigin,
	MAX_BLOCKER_LENGTH,
	MAX_OBJECTIVE_LENGTH,
	MIN_BLOCKER_LENGTH,
	MIN_OBJECTIVE_LENGTH,
} from "./goal.ts";

function goalId(): string {
	// 8 hex chars from a UUID; stable across continuation, compaction, and restore.
	return `goal_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Outcome of completing the current Goal. Distinguishes "there was nothing to
 * complete" from "the completion could not be made durable", because the second
 * leaves the Goal active and must be reported as a persistence failure rather
 * than as a lifecycle refusal.
 */
export type CompleteGoalResult =
	| { ok: true; goal: GoalRecord }
	| { ok: false; reason: "not-active" }
	| { ok: false; reason: "persistence"; error: unknown };

/**
 * Outcome of the model reporting a blocker through `update_goal`.
 *
 * `thresholdMet` is the only case that transitions the Goal: before that the
 * report is recorded and refused, so the Goal keeps working instead of stopping
 * on a blocker that has not persisted.
 */
export type BlockedReportResult =
	| {
		ok: true;
		goal: GoalRecord;
		/** Consecutive Goal turns that have now reported this same blocker. */
		turns: number;
		/** Whether the three-consecutive-turn audit is satisfied. */
		thresholdMet: boolean;
		/** True when this call repeated a report already counted for the same Goal turn. */
		repeat: boolean;
	}
	| { ok: false; reason: "not-active" }
	| { ok: false; reason: "persistence"; error: unknown };

/**
 * Outcome of forgetting the blocked audit.
 *
 * `reset: false` means there was nothing to forget, which is the common case and
 * not an error. A persistence failure keeps the audit in memory rather than
 * dropping it, so the in-memory state never claims a reset that is not durable.
 */
export type ResetAuditResult =
	| { ok: true; reset: boolean }
	| { ok: false; reason: "persistence"; error: unknown };

/** Outcome of an extension-initiated conservative stop or usage-limit transition. */
export type StopGoalResult =
	| { ok: true; goal: GoalRecord }
	| { ok: false; reason: "not-active" }
	| { ok: false; reason: "persistence"; error: unknown };

/**
 * How a blocker description is compared across Goal turns.
 *
 * "Equivalent blockers" have to count as the same condition, or a model that
 * reworded its report would restart the audit forever and the Goal would never
 * reach the threshold. Only case, whitespace, and trailing sentence punctuation
 * are normalized: the wording itself stays meaningful, so a genuinely different
 * blocker still restarts the audit at one.
 */
export function normalizeBlocker(blocker: string): string {
	return blocker.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?;,]+$/, "");
}

export class GoalStore {
	/** undefined = not reconstructed yet; null = no Goal (or tombstone); record = present. */
	private current: GoalRecord | null | undefined = undefined;

	/**
	 * The Goal turn of the last counted blocker report.
	 *
	 * Several `update_goal` calls can arrive inside one Goal turn (a model that
	 * retries its own tool call, or a batch that repeats it). Only the first one
	 * counts: the audit is about consecutive *turns*, not calls.
	 */
	private lastBlockerTurn: number | undefined = undefined;

	/** Rebuild state from the active branch. Called on session_start and session_tree. */
	reconstruct(ctx: ExtensionContext): void {
		let restored: GoalRecord | null = null;
		let seen = false;
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
				const snapshot = entry.data as GoalSnapshot | undefined;
				if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) continue;
				if (!isGoalRecord(snapshot.goal)) continue;
				seen = true;
				restored = snapshot.goal === null ? null : withSanitizedAudit(snapshot.goal);
			}
		} catch (error) {
			// Never break the session on corrupt entries; report and keep absent state.
			console.error("[pi-goal] failed to reconstruct Goal state:", error);
			this.current = null;
			this.lastBlockerTurn = undefined;
			return;
		}
		this.current = seen ? restored : null;
		// The audit itself is durable, but which Goal turn it belongs to is not:
		// a fresh runtime has no turn to match, so the next report starts a new
		// turn rather than being swallowed as a repeat.
		this.lastBlockerTurn = undefined;
	}

	/** Current record, or undefined when not yet reconstructed. */
	get(): GoalRecord | null | undefined {
		return this.current;
	}

	/**
	 * Whether an unfinished Goal exists (any status). Used to refuse creating a
	 * second one.
	 */
	hasGoal(): boolean {
		return this.current != null;
	}

	/** Whether the session persists to a file (Goals must survive restarts). */
	isPersistentSession(ctx: ExtensionContext): boolean {
		try {
			return Boolean(ctx.sessionManager.getSessionFile());
		} catch {
			return false;
		}
	}

	/**
	 * Write the snapshot as a custom entry. Throws on write failure without
	 * changing in-memory state, so a failed stage can simply be abandoned.
	 * The entry participates in the session tree, so forks and tree navigation
	 * see branch-correct state.
	 */
	stage(pi: ExtensionAPI, goal: GoalRecord): void {
		pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal } satisfies GoalSnapshot);
	}

	/**
	 * Confirm the snapshot is durably on disk. Pi defers creating the session
	 * file until the session has a user or assistant message, so a staged
	 * snapshot on a fresh session is in memory only until the kickoff's user
	 * message flushes the file.
	 */
	isDurable(ctx: ExtensionContext, goalId: string): boolean {
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return false;
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.includes(CUSTOM_ENTRY_TYPE)) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				const custom = entry as { customType?: string; data?: GoalSnapshot };
				if (custom?.customType === CUSTOM_ENTRY_TYPE && custom.data?.goal?.id === goalId) return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/** Make a staged Goal visible to /goal and get_goal. */
	commit(goal: GoalRecord): void {
		this.current = goal;
	}

	/**
	 * Mark the current active Goal complete. Increments revision and updates
	 * timestamp, and stages the snapshot durably through the supplied Pi API.
	 *
	 * Only an active Goal can be completed, so a second call (for example two
	 * update_goal calls in one assistant turn) is refused instead of appending a
	 * duplicate snapshot. Completion is terminal for this Goal identity: the
	 * continuation seam never restarts a complete Goal.
	 *
	 * A write failure is reported as `persistence` and leaves the in-memory Goal
	 * untouched and still active, so a retry is possible and no phantom complete
	 * state is claimed.
	 */
	markComplete(pi: ExtensionAPI): CompleteGoalResult {
		const current = this.current;
		if (!current || current.status !== "active") return { ok: false, reason: "not-active" };
		const updated: GoalRecord = {
			...current,
			status: "complete",
			// A complete Goal has no blocker, so a stale audit is dropped rather
			// than reported as if it were still stopping the Goal.
			blockedAudit: undefined,
			updatedAt: Date.now(),
			revision: current.revision + 1,
		};
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: updated } satisfies GoalSnapshot);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = updated;
		this.lastBlockerTurn = undefined;
		return { ok: true, goal: updated };
	}

	/**
	 * Retract a Goal that could not be made durable: clear in-memory state and
	 * append a tombstone snapshot so a later flush of the abandoned staged entry
	 * cannot resurrect it during reconstruction. Best effort.
	 */
	rollback(pi: ExtensionAPI): void {
		this.current = null;
		this.lastBlockerTurn = undefined;
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: null } satisfies GoalSnapshot);
		} catch {
			// Nothing more we can do; the staged entry was never confirmed durable.
		}
	}

	/**
	 * Record the model reporting a blocker, and enforce the blocked audit.
	 *
	 * The audit counts consecutive Goal turns that reported the *same* blocker
	 * (compared by `normalizeBlocker`, so a reworded repetition still advances
	 * it). The Goal becomes `blocked` only when the count reaches
	 * `BLOCKED_AUDIT_THRESHOLD`; before that the report is persisted and refused,
	 * which keeps a transient blocker from stopping useful work while still
	 * making the audit durable across compaction and a session restore.
	 *
	 * A write failure leaves the Goal active and untouched, so the model can
	 * simply report again.
	 */
	markBlockedReport(
		pi: ExtensionAPI,
		params: { blocker: string; turn: number },
	): BlockedReportResult {
		const current = this.current;
		if (!current || current.status !== "active") return { ok: false, reason: "not-active" };
		const blocker = params.blocker.trim();
		const previous = current.blockedAudit;

		// A repeated report inside the same Goal turn is idempotent: it must not
		// advance the audit, or a model that retries its own tool call could
		// satisfy the threshold inside one turn.
		if (this.lastBlockerTurn === params.turn && previous) {
			return {
				ok: true,
				goal: current,
				turns: previous.turns,
				thresholdMet: previous.turns >= BLOCKED_AUDIT_THRESHOLD,
				repeat: true,
			};
		}

		// The audit is about *consecutive* Goal turns, so a report that does not
		// follow the previous one immediately starts a new chain: the turns in
		// between made progress, verified a wait, or reported nothing, and none of
		// those is the same blocker persisting. `lastBlockerTurn` is unknown after a
		// reload, where the durable audit is the only evidence of the chain.
		const followsPreviousTurn =
			this.lastBlockerTurn === undefined || this.lastBlockerTurn === params.turn - 1;
		this.lastBlockerTurn = params.turn;

		const sameBlocker =
			followsPreviousTurn &&
			previous !== undefined &&
			normalizeBlocker(previous.blocker) === normalizeBlocker(blocker);
		const turns = sameBlocker ? previous.turns + 1 : 1;
		const thresholdMet = turns >= BLOCKED_AUDIT_THRESHOLD;
		const updated: GoalRecord = {
			...current,
			...(thresholdMet ? { status: "blocked" as const } : {}),
			blockedAudit: { blocker, turns },
			updatedAt: Date.now(),
			revision: current.revision + 1,
		};
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: updated } satisfies GoalSnapshot);
		} catch (error) {
			this.lastBlockerTurn = undefined;
			return { ok: false, reason: "persistence", error };
		}
		this.current = updated;
		return { ok: true, goal: updated, turns, thresholdMet, repeat: false };
	}

	/**
	 * Stop the Goal with an extension-owned reason: a conservative anti-loop stop
	 * (`blocked`) or a provider usage limit (`usage_limited`).
	 *
	 * Both are terminal for continuation, exactly like completion, and both are
	 * recorded with the reason that produced them so `get_goal` and bare `/goal`
	 * can explain why the Goal is not working.
	 */
	stopGoal(
		pi: ExtensionAPI,
		stop: { status: "blocked" | "usage_limited"; blocker: string; turns?: number },
	): StopGoalResult {
		const current = this.current;
		if (!current || current.status !== "active") return { ok: false, reason: "not-active" };
		const updated: GoalRecord = {
			...current,
			status: stop.status,
			blockedAudit: { blocker: stop.blocker, turns: stop.turns ?? 0 },
			updatedAt: Date.now(),
			revision: current.revision + 1,
		};
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: updated } satisfies GoalSnapshot);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = updated;
		this.lastBlockerTurn = undefined;
		return { ok: true, goal: updated };
	}

	/**
	 * Forget the blocked audit.
	 *
	 * Three things make an existing audit stale, and all of them mean the next
	 * report has to start at one:
	 * - a user action (a prompt the user typed, an abort), because the loop is no
	 *   longer unattended;
	 * - a Goal turn that reported no blocker, because the audit is about
	 *   *consecutive* turns;
	 * - a replacement Goal, which is a new identity.
	 *
	 * The reset is persisted whenever there is an audit to clear. That can only
	 * happen after a report, so it is bounded and never fires on an ordinary prompt,
	 * and it is what stops a reload from resurrecting a count the model or the user
	 * already invalidated.
	 */
	resetBlockedAudit(pi: ExtensionAPI): ResetAuditResult {
		this.lastBlockerTurn = undefined;
		const current = this.current;
		if (!current || current.status !== "active" || current.blockedAudit === undefined) {
			return { ok: true, reset: false };
		}
		const { blockedAudit: _dropped, ...rest } = current;
		const updated: GoalRecord = { ...rest, updatedAt: Date.now(), revision: current.revision + 1 };
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: updated } satisfies GoalSnapshot);
		} catch (error) {
			// Keep the audit rather than dropping it: an in-memory reset that is not
			// durable would let a reload resurrect a count the user invalidated.
			return { ok: false, reason: "persistence", error };
		}
		this.current = updated;
		return { ok: true, reset: true };
	}

	/** Build a new active Goal record (revision 0). Pure: no state is changed. */
	create(objective: string, origin: GoalOrigin = "command"): GoalRecord {
		const now = Date.now();
		return {
			id: goalId(),
			objective,
			status: "active",
			origin,
			createdAt: now,
			updatedAt: now,
			revision: 0,
		};
	}
}

export function validateObjective(raw: string): { ok: true; objective: string } | { ok: false; error: string } {
	const objective = raw.trim();
	if (objective.length < MIN_OBJECTIVE_LENGTH || objective.length > MAX_OBJECTIVE_LENGTH) {
		return {
			ok: false,
			error:
				`Goal not created: the objective must be between ${MIN_OBJECTIVE_LENGTH} and ${MAX_OBJECTIVE_LENGTH} ` +
				"characters after trimming.",
		};
	}
	return { ok: true, objective };
}

export function validateBlocker(raw: string): { ok: true; blocker: string } | { ok: false; error: string } {
	const blocker = raw.trim();
	if (blocker.length < MIN_BLOCKER_LENGTH || blocker.length > MAX_BLOCKER_LENGTH) {
		return {
			ok: false,
			error:
				`Blocker not recorded: describe the blocker in ${MIN_BLOCKER_LENGTH} to ${MAX_BLOCKER_LENGTH} ` +
				"characters after trimming.",
		};
	}
	return { ok: true, blocker };
}

function isGoalRecord(value: unknown): value is GoalRecord | null {
	if (value === null) return true; // tombstone
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (
		record.origin !== undefined &&
		record.origin !== "command" &&
		record.origin !== "tool"
	) {
		return false;
	}
	return (
		typeof record.id === "string" &&
		typeof record.objective === "string" &&
		typeof record.status === "string" &&
		typeof record.createdAt === "number" &&
		typeof record.updatedAt === "number" &&
		typeof record.revision === "number"
	);
}

/**
 * Drop a malformed `blockedAudit` instead of trusting it.
 *
 * The audit is written by this extension, but a snapshot can be hand-edited or
 * written by a future version. A malformed one would break blocker comparison,
 * so it is dropped and the Goal keeps working with a fresh audit.
 */
function withSanitizedAudit(goal: GoalRecord): GoalRecord {
	const audit = goal.blockedAudit;
	if (audit === undefined) return goal;
	if (
		audit === null ||
		typeof audit !== "object" ||
		typeof audit.blocker !== "string" ||
		audit.blocker.trim().length === 0 ||
		typeof audit.turns !== "number" ||
		!Number.isInteger(audit.turns) ||
		// A legitimate audit can never exceed the threshold: reaching it transitions
		// the Goal, so a larger count is a hand-edited or corrupt snapshot.
		audit.turns < 0 ||
		audit.turns > BLOCKED_AUDIT_THRESHOLD
	) {
		const { blockedAudit: _dropped, ...rest } = goal;
		return rest;
	}
	return goal;
}
