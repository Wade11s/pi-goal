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
	CUSTOM_ENTRY_TYPE,
	type GoalRecord,
	type GoalSnapshot,
	type GoalOrigin,
	type GoalBinding,
	MAX_OBJECTIVE_LENGTH,
	MIN_OBJECTIVE_LENGTH,
} from "./goal.ts";

function goalId(): string {
	// 8 hex chars from a UUID; stable across continuation, compaction, and restore.
	return `goal_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Outcome of a durable Goal transition (completion, pause, resume, clear,
 * objective edit). Distinguishes lifecycle refusals ("no-goal" / "not-eligible" /
 * "stale", with an explanation) from persistence failures, because the second
 * leaves the previous state in force and must be reported as a durability
 * problem rather than as a lifecycle refusal. `goal` is `null` for a successful
 * clear.
 */
export type GoalMutationResult =
	| { ok: true; goal: GoalRecord | null }
	| { ok: false; reason: "no-goal" | "not-eligible" | "stale"; message: string }
	| { ok: false; reason: "persistence"; error: unknown };

/** The failure side of {@link GoalMutationResult}. */
export type GoalMutationFailure = Extract<GoalMutationResult, { ok: false }>;

export class GoalStore {
	/** undefined = not reconstructed yet; null = no Goal (or tombstone); record = present. */
	private current: GoalRecord | null | undefined = undefined;

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
				restored = snapshot.goal;
			}
		} catch (error) {
			// Never break the session on corrupt entries; report and keep absent state.
			console.error("[pi-goal] failed to reconstruct Goal state:", error);
			this.current = null;
			return;
		}
		this.current = seen ? restored : null;
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
	 * Confirm the snapshot is durably on disk **as the current state**: the last
	 * `goal-state` entry in the session file must be this Goal. Pi defers creating
	 * the session file until the session has a user or assistant message, so a
	 * staged snapshot on a fresh session is in memory only until the kickoff's
	 * user message flushes the file. Matching "this id occurs somewhere in the
	 * file" would not do: a later tombstone (a `/goal clear` that landed during
	 * the durability wait) must count as *not* durable.
	 */
	isDurable(ctx: ExtensionContext, goalId: string): boolean {
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return false;
			let lastGoal: { id?: string } | undefined;
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.includes(CUSTOM_ENTRY_TYPE)) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				const custom = entry as { customType?: string; data?: GoalSnapshot };
				if (custom?.customType === CUSTOM_ENTRY_TYPE) lastGoal = custom.data?.goal ?? undefined;
			}
			return lastGoal?.id === goalId;
		} catch {
			return false;
		}
	}

	/** Make a staged Goal visible to /goal and get_goal. */
	commit(goal: GoalRecord): void {
		this.current = goal;
	}

	/**
	 * Append a snapshot durably, then make it visible.
	 *
	 * `appendEntry` writes through to the session file synchronously and throws on
	 * failure without changing in-memory state, so returning without throwing
	 * means the transition is already durable — every caller can announce it.
	 * This is the shared seam for every lifecycle transition after creation.
	 */
	private commitSnapshot(pi: ExtensionAPI, goal: GoalRecord | null): GoalMutationResult {
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal } satisfies GoalSnapshot);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = goal;
		return { ok: true, goal };
	}

	/**
	 * Refuse a bound transition when the current record is not the exact record
	 * the transition was prepared against. `expected` is omitted for synchronous
	 * user commands, which by construction act on the state they just read.
	 */
	private checkBinding(current: GoalRecord, expected: GoalBinding | undefined): string | undefined {
		if (!expected) return undefined;
		if (expected.id === current.id && expected.revision === current.revision) return undefined;
		const where =
			expected.id === current.id
				? `it was prepared against revision ${expected.revision} but the Goal is now revision ${current.revision}`
				: `it was prepared against Goal ${expected.id} but the current Goal is ${current.id} (revision ${current.revision})`;
		return `the Goal changed while the call was in flight: ${where}. Call get_goal, re-read the current objective, and re-audit before changing the lifecycle`;
	}

	/**
	 * Mark the current active Goal complete. Increments revision and updates
	 * timestamp, and stages the snapshot durably through the supplied Pi API.
	 *
	 * Only an active Goal can be completed, so a second call (for example two
	 * update_goal calls in one assistant turn) is refused instead of appending a
	 * duplicate snapshot. Completion is terminal for this Goal identity: the
	 * continuation seam never restarts a complete Goal. `expected` binds the
	 * completion to the Goal revision the model's call was prepared against, so
	 * a stale held response cannot complete a Goal the user has since edited,
	 * replaced, paused, or resumed.
	 *
	 * A write failure is reported as `persistence` and leaves the in-memory Goal
	 * untouched and still active, so a retry is possible and no phantom complete
	 * state is claimed.
	 */
	markComplete(pi: ExtensionAPI, expected?: GoalBinding): GoalMutationResult {
		const current = this.current;
		if (!current) {
			return { ok: false, reason: "no-goal", message: "no Goal is set in this session" };
		}
		const stale = this.checkBinding(current, expected);
		if (stale) return { ok: false, reason: "stale", message: stale };
		if (current.status !== "active") {
			return {
				ok: false,
				reason: "not-eligible",
				message: `only an active Goal can be completed (current status: ${current.status})`,
			};
		}
		return this.commitSnapshot(pi, {
			...current,
			status: "complete",
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
	}

	/**
	 * Pause the current active Goal. The transition is durable before it is
	 * visible, and once visible it immediately stops admission of further
	 * automatic Goal runs: the continuation seam only continues an `active` Goal.
	 * The in-flight run (if any) is left to finish on its own — pause never aborts
	 * work; aborting stays with the user. `expected` binds the pause to the Goal
	 * revision the model's call was prepared against (stale held responses are
	 * refused); user commands omit it and act on the state they just read.
	 */
	markPaused(pi: ExtensionAPI, expected?: GoalBinding): GoalMutationResult {
		const current = this.current;
		if (!current) {
			return { ok: false, reason: "no-goal", message: "no Goal is set in this session" };
		}
		const stale = this.checkBinding(current, expected);
		if (stale) return { ok: false, reason: "stale", message: stale };
		if (current.status !== "active") {
			return {
				ok: false,
				reason: "not-eligible",
				message: `only an active Goal can be paused (current status: ${current.status})`,
			};
		}
		return this.commitSnapshot(pi, {
			...current,
			status: "paused",
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
	}

	/**
	 * Resume the current paused Goal. The transition is durable before it is
	 * visible; restarting work is the caller's job (a resume kickoff message), so
	 * resuming while a run is in flight can steer instead of waiting for idle.
	 * The revision bump records the resume as its own transition, giving later
	 * accounting a fresh baseline at this snapshot.
	 */
	markResumed(pi: ExtensionAPI): GoalMutationResult {
		const current = this.current;
		if (!current) {
			return { ok: false, reason: "no-goal", message: "no Goal is set in this session" };
		}
		if (current.status !== "paused") {
			return {
				ok: false,
			reason: "not-eligible",
				message: `only a paused Goal can be resumed (current status: ${current.status})`,
			};
		}
		return this.commitSnapshot(pi, {
			...current,
			status: "active",
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
	}

	/**
	 * Edit the objective of the current Goal in place: the identity, creation
	 * time, origin, budget, and (future) usage history are all preserved, only
	 * the objective changes and the revision advances. A complete Goal is a
	 * finished identity and cannot be edited — replacing it is a new Goal.
	 */
	editObjective(pi: ExtensionAPI, objective: string): GoalMutationResult {
		const current = this.current;
		if (!current) {
			return { ok: false, reason: "no-goal", message: "no Goal is set in this session" };
		}
		if (current.status === "complete") {
			return {
				ok: false,
				reason: "not-eligible",
				message: "a complete Goal is finished and cannot be edited; use /goal <objective> to set a new one",
			};
		}
		return this.commitSnapshot(pi, {
			...current,
			objective,
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
	}

	/**
	 * Clear the current Goal from any status. Writes a durable tombstone
	 * snapshot (`goal: null`) before the in-memory state is cleared, so
	 * restoration can never resurrect an older snapshot of the cleared Goal.
	 */
	clear(pi: ExtensionAPI): GoalMutationResult {
		const current = this.current;
		if (!current) {
			return { ok: false, reason: "no-goal", message: "no Goal is set in this session" };
		}
		return this.commitSnapshot(pi, null);
	}

	/**
	 * Retract a Goal that could not be made durable: clear in-memory state and
	 * append a tombstone snapshot so a later flush of the abandoned staged entry
	 * cannot resurrect it during reconstruction. Best effort.
	 */
	rollback(pi: ExtensionAPI): void {
		this.current = null;
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: null } satisfies GoalSnapshot);
		} catch {
			// Nothing more we can do; the staged entry was never confirmed durable.
		}
	}

	/**
	 * Restore a previously captured record durably. Used to retract a
	 * replacement whose durability could not be confirmed: the previous record
	 * is still the correct current state, and a tombstone would wrongly erase it.
	 */
	restore(pi: ExtensionAPI, previous: GoalRecord): GoalMutationResult {
		return this.commitSnapshot(pi, previous);
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
