/**
 * Persistence and reconstruction of the Goal from the session's custom entries.
 *
 * Goal snapshots are stored as `goal-state` custom session entries (outside model
 * context). The current state is reconstructed from the last such entry on the
 * active session branch, so restart, resume, reload, fork, and tree navigation
 * all reconstruct the state that belongs to the selected branch: Pi copies the
 * branch path into the new session on fork/clone, `/tree` navigation re-points
 * the branch inside the same file, and a resume/restart selects the branch Pi
 * loads (its most recently appended leaf). Entries the branch cannot reach —
 * including a cleared Goal's snapshots on an abandoned branch — never take part
 * in reconstruction.
 *
 * Creation is staged before it is announced: `stage()` only writes the snapshot
 * (throwing on write failure without touching memory), `commit()` makes it
 * visible, and `rollback()` retracts it with a durable tombstone. Pi 1.5.1
 * defers creating the session file until the first user/assistant message, so
 * durability is confirmed separately (`isDurable`) before success is reported.
 *
 * Usage accounting lives here too, because it is durable state with the same
 * reconstruction rules:
 *
 * - **Tokens** are charged from finalized Pi messages and reported nested usage,
 *   keyed so that each report is charged exactly once (see `accounting.ts`). A
 *   checkpoint (`goal-usage`) records the accounted totals plus the active time;
 *   on reconstruction the branch is replayed from after the newest checkpoint or
 *   snapshot, so usage accrued since the last durable write is recovered instead
 *   of lost, and a reload can never charge it twice.
 * - **Active time** runs on a monotonic clock while a Goal is active in a live
 *   session. Folding a segment into the record is exact, so lifecycle boundaries
 *   neither lose nor double-count time, and a stopped Goal (complete,
 *   budget-limited) or a shut-down process stops the clock.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	BLOCKED_AUDIT_THRESHOLD,
	CUSTOM_ENTRY_TYPE,
	GOAL_STATUSES,
	type GoalRecord,
	type GoalSnapshot,
	type GoalOrigin,
	type GoalBinding,
	MAX_BLOCKER_LENGTH,
	MAX_OBJECTIVE_LENGTH,
	MIN_BLOCKER_LENGTH,
	MIN_OBJECTIVE_LENGTH,
	USAGE_ENTRY_TYPE,
} from "./goal.ts";
import {
	ACCOUNTING_CHECKPOINT_MS,
	ActiveTimeTracker,
	type GoalUsage,
	isBudgetExhausted,
	normalizeUsage,
	UsageLedger,
	type UsageSource,
	zeroGoalUsage,
} from "./accounting.ts";

const GOAL_STATUS_SET = new Set<string>(GOAL_STATUSES);

function goalId(): string {
	// 8 hex chars from a UUID; stable across continuation, compaction, and restore.
	return `goal_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Payload persisted in `goal-usage` custom session entries. */
export interface UsageCheckpoint {
	version: 1;
	/** The Goal these totals belong to; a checkpoint for another Goal is ignored. */
	goalId: string;
	usage: GoalUsage;
}

function isUsageCheckpoint(value: unknown): value is UsageCheckpoint {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && typeof record.goalId === "string" && typeof record.usage === "object";
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

/** The failure side of {@link GoalMutationResult}. */
export type GoalMutationFailure = Extract<GoalMutationResult, { ok: false }>;

/**
 * Outcome of exhausting the token budget.
 *
 * There is no `persistence` outcome because nothing is written here: the
 * transition is made in memory so enforcement is immediate, and
 * `flushAccounting` persists it later (see `pendingTransition`).
 */
export type BudgetLimitedResult = { ok: true; goal: GoalRecord } | { ok: false; reason: "not-active" };

/** Outcome of delivering the one bounded budget wrap-up. */
export type WrapUpResult =
	| { ok: true; goal: GoalRecord }
	| { ok: false; reason: "not-pending" }
	| { ok: false; reason: "persistence"; error: unknown };

/** Options accepted when creating a Goal record. */
export interface CreateGoalOptions {
	/** Explicit token budget; undefined means "use the configured default". */
	tokenBudget?: number;
}

export class GoalStore {
	/** undefined = not reconstructed yet; null = no Goal (or tombstone); record = present. */
	private current: GoalRecord | null | undefined = undefined;

	/** Token ledger with stable deduplication. */
	private readonly ledger = new UsageLedger();

	/** Monotonic active-time clock for the current Goal. */
	private readonly clock = new ActiveTimeTracker();

	/**
	 * An in-memory lifecycle transition that is not durable yet.
	 *
	 * Pi dispatches `message_end` to extensions *before* it appends the message that
	 * triggered it, so a snapshot written from inside that handler would sit on the
	 * branch *ahead* of the entry it already accounts for — and a reconstruction would
	 * replay that entry and charge it a second time. The budget transition is therefore
	 * made in memory immediately (so enforcement and status are instant) and persisted
	 * later, at a boundary where the triggering entry is already on the branch
	 * (`turn_end`, `agent_before_settle`, `agent_settled`, shutdown).
	 *
	 * Every other transition writes durably through `commitSnapshot` before it is
	 * visible, and each of those writes supersedes a transition still waiting here:
	 * the newer snapshot carries the current status, revision, and totals.
	 */
	private pendingTransition: GoalRecord | undefined;

	/**
	 * The Goal turn of the last counted blocker report.
	 *
	 * Several `update_goal` calls can arrive inside one Goal turn (a model that
	 * retries its own tool call, or a batch that repeats it). Only the first one
	 * counts: the audit is about consecutive *turns*, not calls.
	 */
	private lastBlockerTurn: number | undefined = undefined;

	/**
	 * Rebuild state from the active branch. Called on session_start (startup,
	 * resume, reload, new, fork/clone) and session_tree (branch navigation).
	 *
	 * The last *valid* `goal-state` entry on the branch wins, and a tombstone
	 * (`goal: null`) is a valid entry: a cleared Goal therefore stays cleared on
	 * the branch that cleared it, no matter how many older snapshots of it the
	 * same branch still contains. An entry that is not a recognizable snapshot
	 * (unknown version, wrong shape, unknown status) is skipped rather than
	 * trusted, so a corrupt line never decides the session's Goal state.
	 *
	 * Returns the reconstructed state so the caller can observe what changed;
	 * never throws for bad entry data (reconstruction failures are logged and
	 * leave the Goal absent) because a broken entry must not break the session.
	 *
	 * Usage accounting is rebuilt here too, because it is durable state with the
	 * same reconstruction rules: the branch is replayed from after the newest
	 * snapshot so usage accrued since the last durable write is recovered rather
	 * than lost, and the accounting checkpoints met on the way are verified
	 * against the replay instead of being trusted outright (see `replayBranch`).
	 */
	reconstruct(ctx: ExtensionContext): GoalRecord | null {
		let restored: GoalRecord | null = null;
		let seen = false;
		let usage = zeroGoalUsage();
		// Branch index of the newest `goal-state` snapshot for the restored Goal. The
		// replay starts after it; the accounting checkpoints in that range are
		// verified against the replay rather than trusted outright (see
		// `replayBranch`).
		let baselineIndex = -1;
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let index = 0; index < branch.length; index++) {
				const entry = branch[index]!;
				if (entry.type !== "custom") continue;
				if (entry.customType !== CUSTOM_ENTRY_TYPE) continue;
				const snapshot = entry.data as GoalSnapshot | undefined;
				if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) continue;
				if (!isGoalRecord(snapshot.goal)) continue;
				seen = true;
				// A `null` goal is the durable tombstone: it clears the Goal and resets
				// the accounting baseline with it.
				// The record is copied, never adopted: the session manager owns the entry
				// object, and publishing the live accounting view onto it (see
				// `refreshUsage`) would leak in-memory state into durable state.
				restored = snapshot.goal
					? { ...withSanitizedAudit(snapshot.goal) }
					: null;
				usage = snapshot.goal ? normalizeUsage(snapshot.goal.usage) : zeroGoalUsage();
				baselineIndex = index;
			}
		} catch (error) {
			// Never break the session on corrupt entries; report and keep absent state.
			console.error("[pi-goal] failed to reconstruct Goal state:", error);
			this.current = null;
			this.ledger.restore(zeroGoalUsage());
			this.clock.reset();
			this.lastBlockerTurn = undefined;
			return null;
		}
		this.current = seen ? restored : null;
		this.pendingTransition = undefined;
		// The audit itself is durable, but which Goal turn it belongs to is not:
		// a fresh runtime has no turn to match, so the next report starts a new
		// turn rather than being swallowed as a repeat.
		this.lastBlockerTurn = undefined;
		this.ledger.restore(usage);
		this.clock.reset();
		this.clock.persisted(usage.activeMs);
		// Replay everything after the baseline so usage accrued since the last
		// durable write is recovered, not lost, and cannot be charged twice.
		//
		// A *complete* Goal is terminal, so nothing after its snapshot is Goal work:
		// the live path excludes those responses (the completing turn is charged at
		// `message_end`, before the tool that completes it), and the replay must draw
		// the same line. Without this, an unclean restart would reclassify the
		// post-completion response as Goal usage and inflate the total.
		if (this.current && this.current.status !== "complete") {
			this.replayBranch(ctx, baselineIndex);
			// The replay may have adopted a checkpoint's accounted active time, so the
			// clock resumes from the newest durable value rather than the snapshot's.
			this.clock.persisted(this.ledger.usage.activeMs);
		}
		if (this.current?.status === "active") this.clock.start();
		return this.current;
	}

	/**
	 * Charge every usage-bearing session entry after `afterIndex`, verifying the
	 * accounting checkpoints found on the way.
	 *
	 * This is the recovery half of the ledger: it makes a restart, a reload, or a
	 * tree navigation converge on the totals the live event path produced, because
	 * both charge each entry exactly once — the live path while the entry is created,
	 * the replay for everything the newest durable baseline does not already cover.
	 *
	 * A checkpoint is a shortcut over that replay, never a second source of truth, so
	 * it is adopted only when adopting it loses nothing. The branch is the authority:
	 * if a checkpoint reports fewer tokens than the entries between the baseline and
	 * it already account for, then the live path declined a report the replay charges,
	 * and adopting the checkpoint would seal that omission into the durable baseline —
	 * the tool result a Goal created mid-turn never charged live would be gone for
	 * good, and no later replay could recover it because it sits *before* the
	 * checkpoint. In that case the replay keeps its own totals and carries on, keeping
	 * only the checkpoint's active time, which the branch cannot reconstruct.
	 */
	private replayBranch(ctx: ExtensionContext, afterIndex: number): void {
		let branch;
		try {
			branch = ctx.sessionManager.getBranch();
		} catch (error) {
			console.error("[pi-goal] failed to replay Goal usage:", error);
			return;
		}
		for (let index = afterIndex + 1; index < branch.length; index++) {
			const entry = branch[index]!;
			if (entry.type === "custom") {
				if (entry.customType !== USAGE_ENTRY_TYPE) continue;
				const checkpoint = entry.data as UsageCheckpoint | undefined;
				if (!isUsageCheckpoint(checkpoint)) continue;
				// A checkpoint only counts for the Goal it was written for; every
				// checkpoint here is already after the baseline snapshot.
				if (checkpoint.goalId !== this.current?.id) continue;
				this.applyCheckpoint(checkpoint);
				continue;
			}
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "assistant") {
					this.ledger.account(entry.id, message.usage, "model");
				} else if (message.role === "toolResult") {
					// Nested usage arrives merged into the tool result's own `usage`,
					// so charging the result once is what keeps it from being counted
					// twice.
					this.ledger.account(`toolResult:${message.toolCallId}`, message.usage, "nested");
				}
				continue;
			}
			if (entry.type !== "compaction" && entry.type !== "branch_summary") continue;
			if (!entry.usage) continue;
			this.ledger.account(entry.id, entry.usage, "nested");
		}
	}

	/**
	 * Adopt an accounting checkpoint as the replay baseline when adopting it loses
	 * nothing (see `replayBranch`).
	 *
	 * The comparison is against the totals the replay has already accumulated from
	 * the branch, not against the snapshot: a checkpoint may only ever *raise* the
	 * baseline, because a lower one would discard usage the branch still accounts
	 * for. Equality is the normal case — a checkpoint written at a post-persistence
	 * boundary records exactly what the live path had charged, which is exactly what
	 * the replay charges — so the shortcut keeps working and only a genuine
	 * undercount falls through to the replay.
	 */
	private applyCheckpoint(checkpoint: UsageCheckpoint): void {
		const checkpointUsage = normalizeUsage(checkpoint.usage);
		const replayed = this.ledger.usage;
		if (checkpointUsage.totalTokens < replayed.totalTokens) {
			// Undercount: keep the replayed tokens, and keep the checkpoint's active
			// time, which is the one thing the branch cannot reconstruct.
			this.ledger.restore({
				...replayed,
				activeMs: Math.max(replayed.activeMs, checkpointUsage.activeMs),
			});
			return;
		}
		this.ledger.restore(checkpointUsage);
	}

	/** Current record, or undefined when not yet reconstructed. */
	get(): GoalRecord | null | undefined {
		this.refreshUsage();
		return this.current;
	}

	/**
	 * Current accounted usage (a copy): the ledger's token totals plus the live
	 * active time.
	 *
	 * This is the same view `get()` publishes onto the record, so the two can never
	 * disagree: the ledger itself only carries tokens, and the active time always
	 * comes from the clock (the ledger's own `activeMs` would be whatever the last
	 * restore happened to carry).
	 */
	getUsage(): GoalUsage {
		this.refreshUsage();
		return this.liveUsage();
	}

	/** Live accounting view: ledger totals plus the currently running active time. */
	private liveUsage(): GoalUsage {
		return { ...this.ledger.usage, activeMs: this.clock.activeMs };
	}

	/**
	 * Publish the live accounting view onto the in-memory record.
	 *
	 * The durable snapshot freezes usage at the moment it is written; the record in
	 * memory always carries the live view, so `/goal`, `get_goal`, and the status
	 * line report what has been accounted *now* rather than what the last snapshot
	 * happened to capture. The record this writes to is always a private copy (see
	 * `adopt`), so in-memory accounting never leaks into durable state.
	 */
	private refreshUsage(): void {
		if (!this.current) return;
		this.current.usage = this.liveUsage();
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
	 * Append a snapshot of a *copy* of `goal`.
	 *
	 * Pi's session manager retains the object it is given, so handing it the live
	 * record would let in-memory accounting (see `refreshUsage`) leak into durable
	 * state — and a later same-process reconstruction would then read a polluted
	 * baseline and charge the same entries twice. Copying here is what keeps the
	 * durable snapshot and the live record independent objects.
	 */
	private persistSnapshot(pi: ExtensionAPI, goal: GoalRecord): void {
		pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: { ...goal } } satisfies GoalSnapshot);
	}

	/**
	 * Adopt a *copy* of `goal` as the live record, for the same reason
	 * `persistSnapshot` copies: one object must never be both the live record and a
	 * persisted entry.
	 */
	private adopt(goal: GoalRecord): GoalRecord {
		return { ...goal };
	}

	/**
	 * Write the snapshot as a custom entry. Throws on write failure without
	 * changing in-memory state, so a failed stage can simply be abandoned.
	 * The entry participates in the session tree, so forks and tree navigation
	 * see branch-correct state.
	 */
	stage(pi: ExtensionAPI, goal: GoalRecord): void {
		this.persistSnapshot(pi, goal);
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
		this.current = this.adopt(goal);
		// A newly created Goal starts its accounting from zero, even when the
		// session already burned tokens before it existed, and no transition of a
		// Goal that no longer exists is still waiting to be written.
		this.pendingTransition = undefined;
		this.ledger.restore(zeroGoalUsage());
		this.clock.reset();
		if (goal.status === "active") this.clock.start();
	}

	/**
	 * Charge one usage report exactly once.
	 *
	 * `key` is the identity the accounting path guarantees: a sequence number for an
	 * assistant message, `toolResult:<toolCallId>` for tool-performed nested work, or
	 * the session entry id of a summarization entry. Returns the contribution when
	 * the key was new.
	 */
	accountUsage(key: string, usage: Usage | undefined, source: UsageSource) {
		// One rule, enforced here so the live path and the branch replay cannot drift
		// apart: a tool result that arrives after the Goal was completed belongs to the
		// suffix the replay deliberately skips (the completion snapshot is the replay
		// baseline), so it is not Goal work either.
		if (source === "nested" && this.current?.status === "complete") return undefined;
		const contribution = this.ledger.account(key, usage, source);
		if (contribution) this.refreshUsage();
		return contribution;
	}

	/** Whether the token budget is exhausted for the current Goal. */
	isBudgetExhausted(): boolean {
		const goal = this.current;
		if (!goal) return false;
		return isBudgetExhausted(goal.tokenBudget, this.ledger.usage.totalTokens);
	}

	/**
	 * Append a snapshot durably, then make it visible.
	 *
	 * `appendEntry` writes through to the session file synchronously and throws on
	 * failure without changing in-memory state, so returning without throwing
	 * means the transition is already durable — every caller can announce it.
	 * This is the shared seam for every lifecycle transition after creation.
	 *
	 * Two accounting rules ride along, and both matter for exactly-once accounting:
	 *
	 * - the snapshot carries the **live** accounting view, so every durable write
	 *   reflects every usage already present on the branch when it is made — not the
	 *   totals some earlier decision froze; and
	 * - it supersedes any transition still waiting to be written (see
	 *   `pendingTransition`), because this snapshot is newer and complete.
	 *
	 * Both the appended entry and the adopted record are copies: Pi's session
	 * manager retains the object it is handed, so one object must never be both the
	 * live record and a persisted entry.
	 */
	private commitSnapshot(
		pi: ExtensionAPI,
		goal: GoalRecord,
	): { ok: true; goal: GoalRecord } | { ok: false; reason: "persistence"; error: unknown } {
		// Every durable snapshot carries the live accounting view, so it reflects every
		// usage already present on the branch when it is written rather than the totals
		// some earlier decision froze.
		const record: GoalRecord = { ...goal, usage: this.liveUsage() };
		try {
			this.persistSnapshot(pi, record);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = this.adopt(record);
		// This snapshot is newer and complete, so a transition still waiting to be
		// written (see `pendingTransition`) is superseded by it.
		this.pendingTransition = undefined;
		return { ok: true, goal: record };
	}

	/**
	 * Append the durable tombstone (`goal: null`) and clear the in-memory Goal.
	 * Separate from {@link commitSnapshot} because a cleared Goal has no accounting
	 * left to carry and no transition left waiting.
	 */
	private commitTombstone(pi: ExtensionAPI): GoalMutationResult {
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: null } satisfies GoalSnapshot);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = null;
		this.pendingTransition = undefined;
		this.ledger.restore(zeroGoalUsage());
		this.clock.reset();
		return { ok: true, goal: null };
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
	 * timestamp, folds the accounted usage into the snapshot, and stages it
	 * durably through the supplied Pi API.
	 *
	 * Only an active Goal can be completed, so a second call (for example two
	 * update_goal calls in one assistant turn) is refused instead of appending a
	 * duplicate snapshot. Completion is terminal for this Goal identity: the
	 * continuation seam never restarts a complete Goal, and its clock stops.
	 * `expected` binds the completion to the Goal revision the model's call was
	 * prepared against, so a stale held response cannot complete a Goal the user
	 * has since edited, replaced, paused, or resumed.
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
		// Completion is terminal for accounting: the clock stops at the transition and
		// the snapshot carries the folded value.
		const activeMs = this.clock.stop();
		const result = this.commitSnapshot(pi, {
			...current,
			status: "complete",
			// A complete Goal has no blocker, so a stale audit is dropped rather
			// than reported as if it were still stopping the Goal.
			blockedAudit: undefined,
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
		if (!result.ok) {
			// The Goal is still active, so the clock keeps running.
			this.clock.start();
			return result;
		}
		this.clock.persisted(activeMs);
		return result;
	}

	/**
	 * Pause the current active Goal. The transition is durable before it is
	 * visible, and once visible it immediately stops admission of further
	 * automatic Goal runs: the continuation seam only continues an `active` Goal.
	 * The in-flight run (if any) is left to finish on its own — pause never aborts
	 * work; aborting stays with the user. `expected` binds the pause to the Goal
	 * revision the model's call was prepared against (stale held responses are
	 * refused); user commands omit it and act on the state they just read.
	 *
	 * A paused Goal does not accrue active time, so its clock stops here exactly as
	 * it does for a terminal status, and the snapshot carries the folded value.
	 * `markResumed` restarts it.
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
		const activeMs = this.clock.stop();
		const result = this.commitSnapshot(pi, {
			...current,
			status: "paused",
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
		if (!result.ok) {
			// The Goal is still active, so the clock keeps running.
			this.clock.start();
			return result;
		}
		this.clock.persisted(activeMs);
		return result;
	}

	/**
	 * Resume a Goal the user has decided to continue.
	 *
	 * `paused`, `blocked`, and `usage_limited` are all non-continuing states that a
	 * user decision ends: a pause is the user stopping work themselves, and a
	 * conservative stop or a provider usage limit is the extension or the provider
	 * stopping it and telling the user a decision is needed. Resuming is that
	 * decision, so all three restart the same objective with the same identity and
	 * history.
	 *
	 * The transition is durable before it is visible; restarting work is the
	 * caller's job (a resume kickoff message), so resuming while a run is in flight
	 * can steer instead of waiting for idle.
	 * The revision bump records the resume as its own transition, giving later
	 * accounting a fresh baseline at this snapshot. Work restarts, so the
	 * active-time clock restarts with it.
	 *
	 * A `blocked` or `usage_limited` Goal also carries a blocked audit that explains
	 * why it stopped. That audit belongs to the stop, not to the Goal: it is dropped
	 * here so the resumed Goal starts a fresh audit rather than inheriting a count
	 * the user has already overruled, and `lastBlockerTurn` goes with it so the next
	 * report starts at one instead of continuing the broken chain.
	 *
	 * `complete` is terminal for the identity — a finished Goal is replaced, not
	 * resumed — so it is refused along with every other status.
	 */
	markResumed(pi: ExtensionAPI): GoalMutationResult {
		const current = this.current;
		if (!current) {
			return { ok: false, reason: "no-goal", message: "no Goal is set in this session" };
		}
		if (current.status !== "paused" && current.status !== "blocked" && current.status !== "usage_limited") {
			return {
				ok: false,
				reason: "not-eligible",
				message: `only a paused, blocked, or usage-limited Goal can be resumed (current status: ${current.status})`,
			};
		}
		this.lastBlockerTurn = undefined;
		const result = this.commitSnapshot(pi, {
			...current,
			status: "active",
			// The audit described the stop the user just overruled; a resumed Goal
			// starts from a clean one.
			blockedAudit: undefined,
			updatedAt: Date.now(),
			revision: current.revision + 1,
		});
		if (!result.ok) return result;
		this.clock.start();
		return result;
	}

	/**
	 * Edit the objective of the current Goal in place: the identity, creation
	 * time, origin, budget, and usage history are all preserved, only the
	 * objective changes and the revision advances. A complete Goal is a
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
		return this.commitTombstone(pi);
	}

	/**
	 * Exhaust the token budget in memory: transition the active Goal to
	 * `budget_limited`, stop its active-time clock, and arm the one bounded wrap-up.
	 *
	 * Budget exhaustion is never completion: the status is `budget_limited`, the
	 * `wrapUpPending` flag is armed so the wrap-up is delivered exactly once (even
	 * across a restart), and the continuation seam treats the Goal as finished for
	 * continuation purposes.
	 *
	 * Nothing is written here. The caller enforces the budget immediately (that is
	 * the point of doing it in memory), and `flushAccounting` persists the transition
	 * at a post-persistence boundary so the snapshot never lands ahead of the entry
	 * it already accounts for. There is no `GoalBinding` to check because the
	 * transition is extension-triggered from accounted usage, not model-triggered:
	 * there is no prepared-against revision to bind it to.
	 *
	 * The usage recorded here is the in-memory view at the instant of the transition;
	 * the durable snapshot re-reads the totals when it is actually written, so usage
	 * that lands afterwards is not lost (see `transitionToPersist`).
	 */
	markBudgetLimited(): BudgetLimitedResult {
		const current = this.current;
		if (!current || current.status !== "active") return { ok: false, reason: "not-active" };
		const activeMs = this.clock.stop();
		const updated: GoalRecord = {
			...current,
			status: "budget_limited",
			updatedAt: Date.now(),
			revision: current.revision + 1,
			usage: { ...this.ledger.usage, activeMs },
			wrapUpPending: true,
		};
		this.current = this.adopt(updated);
		this.pendingTransition = updated;
		this.clock.persisted(activeMs);
		return { ok: true, goal: updated };
	}

	/** Whether a lifecycle transition is waiting to be made durable. */
	hasPendingTransition(): boolean {
		return this.pendingTransition !== undefined;
	}

	/**
	 * The durable form of a pending lifecycle transition.
	 *
	 * The transition itself (status, revision, timestamp, wrap-up flag) is fixed when
	 * it happens, but the usage it carries must be re-read at the flush. A snapshot
	 * that kept the totals frozen at the transition would omit every report charged
	 * between then and the boundary — an in-flight concurrent tool result that was
	 * already running when the budget was crossed, or the responses that follow it —
	 * and because a snapshot is the reconstruction baseline, the branch replay could
	 * never recover them: they sit *before* the snapshot on the branch, so they are
	 * neither inside its totals nor replayed after it.
	 *
	 * Re-reading is sound precisely because a flush only happens at a boundary where
	 * Pi has already appended every entry the ledger covers (`turn_end` runs after
	 * the turn's assistant message and every one of its tool results, and the same
	 * holds for `agent_settled`, `agent_before_settle`, and shutdown). The totals
	 * written are therefore exactly the usage already present on the branch, and
	 * anything charged afterwards lands *after* the snapshot and is recovered by the
	 * replay — which is what keeps accounting exactly once.
	 */
	private transitionToPersist(transition: GoalRecord): GoalRecord {
		return { ...transition, usage: this.liveUsage() };
	}

	/**
	 * Persist accounting at a boundary where every entry it covers is already on the
	 * session branch.
	 *
	 * A pending transition is written first and supersedes a checkpoint; otherwise a
	 * checkpoint is written when enough unpersisted active time has accrued (or when
	 * `force` is set, at shutdown). Best-effort by design: a failed write leaves the
	 * pending state in place so the next boundary retries it.
	 *
	 * A checkpoint written here is only ever a *shortcut*: reconstruction verifies it
	 * against the branch and discards it when it reports fewer tokens than the
	 * entries before it account for (see `applyCheckpoint`). That is what makes a
	 * forced shutdown checkpoint safe even if the live path had declined a report —
	 * without the check, such a checkpoint would seal the undercount permanently,
	 * because the entry it omits sits before the checkpoint and no later replay can
	 * reach it.
	 */
	flushAccounting(pi: ExtensionAPI, force = false): void {
		if (!this.current) return;
		try {
			if (this.flushPendingTransition(pi)) return;
			if (force || this.clock.unpersistedMs >= ACCOUNTING_CHECKPOINT_MS) {
				this.checkpointAccounting(pi);
			}
		} catch {
			// Leave the pending state for the next boundary to retry.
		}
	}

	/**
	 * Write a pending lifecycle transition if one is waiting, and report whether one
	 * was: a transition supersedes a checkpoint, so a caller that wrote one is done.
	 *
	 * Also used on its own when a session is being *replaced* rather than exited (see
	 * the `session_shutdown` handler). The transition is state that belongs to the
	 * outgoing branch, so losing it would leave a Goal durably `active` with its
	 * budget already exhausted; a bare accounting checkpoint, by contrast, is only an
	 * optimization and would land in a session the user has navigated away from.
	 */
	flushPendingTransition(pi: ExtensionAPI): boolean {
		const pending = this.pendingTransition;
		if (!pending) return false;
		this.persistSnapshot(pi, this.transitionToPersist(pending));
		this.pendingTransition = undefined;
		return true;
	}

	/**
	 * Disarm the pending wrap-up after it has been delivered. Durable, so a
	 * duplicate boundary event, a reload, or a restart cannot deliver it twice.
	 */
	consumeWrapUp(pi: ExtensionAPI): WrapUpResult {
		const current = this.current;
		if (!current || current.status !== "budget_limited" || !current.wrapUpPending) {
			return { ok: false, reason: "not-pending" };
		}
		const updated: GoalRecord = {
			...current,
			// The wrap-up run's own usage is accounted like any other Goal work, and
			// `commitSnapshot` folds the live view into the snapshot it writes.
			updatedAt: Date.now(),
			revision: current.revision + 1,
			wrapUpPending: false,
		};
		const result = this.commitSnapshot(pi, updated);
		if (!result.ok) return { ok: false, reason: "persistence", error: result.error };
		return { ok: true, goal: result.goal };
	}

	/** Whether the one bounded wrap-up is still owed. */
	isWrapUpPending(): boolean {
		return this.current?.status === "budget_limited" && this.current.wrapUpPending === true;
	}

	/**
	 * Write the accounted totals and the folded active time to a `goal-usage`
	 * checkpoint.
	 *
	 * Tokens are always recoverable from the branch, so a checkpoint exists for the
	 * active time: a process that never transitions loses at most the time since the
	 * last checkpoint. It is a shortcut over the replay rather than a record of it,
	 * which is why reconstruction verifies it (see `applyCheckpoint`) instead of
	 * trusting it. The clock keeps running across a checkpoint.
	 */
	checkpointAccounting(pi: ExtensionAPI): UsageCheckpoint | undefined {
		const goal = this.current;
		if (!goal) return undefined;
		const activeMs = this.clock.fold();
		const checkpoint: UsageCheckpoint = {
			version: 1,
			goalId: goal.id,
			usage: { ...this.ledger.usage, activeMs },
		};
		pi.appendEntry(USAGE_ENTRY_TYPE, checkpoint);
		this.clock.persisted(activeMs);
		return checkpoint;
	}

	/** Accounted milliseconds that are not durable yet. */
	unpersistedActiveMs(): number {
		return this.clock.unpersistedMs;
	}

	/** Stop the active-time clock (terminal statuses and process shutdown). */
	stopClock(): number {
		return this.clock.stop();
	}

	/**
	 * Retract a Goal that could not be made durable: clear in-memory state and
	 * append a tombstone snapshot so a later flush of the abandoned staged entry
	 * cannot resurrect it during reconstruction. Best effort.
	 */
	rollback(pi: ExtensionAPI): void {
		this.current = null;
		this.pendingTransition = undefined;
		this.ledger.restore(zeroGoalUsage());
		this.clock.reset();
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

	/**
	 * Restore a previously captured record durably. Used to retract a
	 * replacement whose durability could not be confirmed: the previous record
	 * is still the correct current state, and a tombstone would wrongly erase it.
	 *
	 * Deliberately *not* through {@link commitSnapshot}: that folds the live
	 * accounting view into the record it writes, and this path runs after the
	 * replacement's `commit()` has already zeroed the ledger for the new Goal.
	 * Persisting the previous record with the new Goal's near-zero usage would lose
	 * the older Goal's totals *and* make them unrecoverable, because the restored
	 * snapshot becomes the replay baseline and the older entries sit before it. The
	 * record therefore carries its own durable usage, and the ledger and the clock are
	 * rebuilt from it rather than from the discarded replacement.
	 */
	restore(pi: ExtensionAPI, previous: GoalRecord): GoalMutationResult {
		const record: GoalRecord = { ...previous };
		try {
			this.persistSnapshot(pi, record);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = this.adopt(record);
		this.pendingTransition = undefined;
		const usage = normalizeUsage(record.usage);
		this.ledger.restore(usage);
		this.clock.reset();
		this.clock.persisted(usage.activeMs);
		if (record.status === "active") this.clock.start();
		return { ok: true, goal: record };
	}

	/** Build a new active Goal record (revision 0). Pure: no state is changed. */
	create(objective: string, origin: GoalOrigin = "command", options: CreateGoalOptions = {}): GoalRecord {
		const now = Date.now();
		return {
			id: goalId(),
			objective,
			status: "active",
			origin,
			createdAt: now,
			updatedAt: now,
			revision: 0,
			...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
			usage: zeroGoalUsage(),
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
	// A snapshot whose status is not a known lifecycle status is not trusted: an
	// entry hand-edited into the session file (or written by an unknown future
	// version) must not put the Goal into a state the state machine never issued.
	if (typeof record.status !== "string" || !GOAL_STATUS_SET.has(record.status)) {
		return false;
	}
	if (record.tokenBudget !== undefined && typeof record.tokenBudget !== "number") return false;
	if (record.wrapUpPending !== undefined && typeof record.wrapUpPending !== "boolean") return false;
	return (
		typeof record.id === "string" &&
		record.id !== "" &&
		typeof record.objective === "string" &&
		record.objective !== "" &&
		typeof record.createdAt === "number" &&
		Number.isFinite(record.createdAt) &&
		record.createdAt > 0 &&
		typeof record.updatedAt === "number" &&
		Number.isFinite(record.updatedAt) &&
		record.updatedAt > 0 &&
		typeof record.revision === "number" &&
		Number.isInteger(record.revision) &&
		record.revision >= 0
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
