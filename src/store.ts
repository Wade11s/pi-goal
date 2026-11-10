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
	MAX_OBJECTIVE_LENGTH,
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
			updatedAt: Date.now(),
			revision: current.revision + 1,
		};
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: updated } satisfies GoalSnapshot);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = updated;
		return { ok: true, goal: updated };
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
