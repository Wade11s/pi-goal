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
	CUTOVER_ENTRY_TYPE,
	GOAL_STATUSES,
	isGoalCutover,
	ownershipMarker,
	type GoalCutover,
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

/** Outcome of a durable legacy cutover. */
export type CutoverResult =
	| {
			ok: true;
			cutover: boolean;
			notices: string[];
			/**
			 * Set when the branch-local cutover marker could not be written *after* the
			 * repaired snapshot already was. The cutover itself stands — the repaired
			 * snapshot is what the next load reads — so this is a degraded outcome rather
			 * than a failure, and the caller reports it as one.
			 */
			markerError?: unknown;
	  }
	| { ok: false; reason: "persistence"; error: unknown };

/**
 * Structural validity of a `goal-state` payload.
 *
 * A snapshot is valid when it is an object of version 1 whose `goal` is either
 * `null` (a durable tombstone) or a structurally valid record. Anything else —
 * an unknown version, a malformed record, a non-object — is *not* a snapshot,
 * and when it is the newest `goal-state` entry the branch fails closed rather
 * than falling back to an older entry.
 */
function isGoalSnapshot(value: unknown): value is GoalSnapshot {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return false;
	return record.goal === null || isGoalRecord(record.goal);
}

/** Deep-copy a reconstructed record so no live mutation can reach the branch object. */
function copyRecord(goal: GoalRecord): GoalRecord {
	const copy: GoalRecord = { ...goal };
	if (goal.blockedAudit !== undefined) copy.blockedAudit = { ...goal.blockedAudit };
	if (goal.usage !== undefined) copy.usage = { ...goal.usage };
	return copy;
}

function isUsageCheckpoint(value: unknown): value is UsageCheckpoint {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && typeof record.goalId === "string" && typeof record.usage === "object";
}

/**
 * The superseded identity's still-open admission tail.
 *
 * A replacement commits a new identity while the old identity's provider request may
 * still be in flight, so `commit()` deliberately leaves the old admission open: the
 * old response and its tool results are charged to `ledger`, and `record` is the old
 * identity's own record, frozen onto a durable superseded snapshot by
 * `closeSupersededSegment`. `open` says the admission is still taking in-flight
 * reports; `dirty` says the branch does not yet carry this tail.
 */
interface SupersededTail {
	record: GoalRecord;
	ledger: UsageLedger;
	/** Whether the old admission is still open for its in-flight tail. */
	open: boolean;
	/** Whether the tail changed the record since the superseded snapshot. */
	dirty: boolean;
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
	| { ok: false; reason: "not-active"; message?: string }
	| { ok: false; reason: "stale"; message: string }
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
	 * The Goal turn of the last counted blocker report, and the revision that report
	 * wrote.
	 *
	 * Several `update_goal` calls can arrive inside one Goal turn (a model that
	 * retries its own tool call, or a batch that repeats it). Only the first one
	 * counts: the audit is about consecutive *turns*, not calls. The revision is what
	 * makes that shortcut safe — a repeat is the same audit step only while the Goal
	 * still reads exactly as the counted report left it.
	 */
	private lastBlockerTurn: number | undefined = undefined;
	private lastBlockerRevision: number | undefined = undefined;

	/**
	 * Whether the current run/segment is Goal-owned work, and the identity it was
	 * admitted for.
	 *
	 * Only explicitly admitted Goal work is charged: a run started by a Goal
	 * lifecycle message (kickoff, edit, resume), an automatic Continuation, or the
	 * one Budget wrap-up. An ordinary user prompt is never Goal work, whatever the
	 * Goal's status, and neither is the run a `/goal` command waits for or the run
	 * that called `create_goal`. The flag is set when pi-goal sends a Goal work
	 * message and cleared on a genuine user prompt; reconstruction derives it from
	 * the branch so live accounting and replay draw the same line.
	 */
	private goalOwned = false;
	private ownerId: string | null = null;

	/**
	 * The superseded identity's still-open admission tail.
	 *
	 * A replacement commits a new identity while the old identity's provider request
	 * may still be in flight. Decision #17 requires that work to stay with the old
	 * identity, so `commit()` deliberately leaves the old admission open: the old
	 * response and its tool results are charged to this ledger, and the tail is frozen
	 * onto a durable superseded snapshot when the next user message is delivered
	 * (`closeSupersededSegment`). The old active-time clock is stopped at replacement;
	 * only the tokens of the in-flight tail are still collected here.
	 */
	private supersededTail: SupersededTail | null = null;

	/**
	 * True when the selected branch's newest snapshot is a pre-repair (0.1.0)
	 * snapshot that still has to be cut over. Cleared by `applyLegacyCutover`.
	 */
	private legacyPending = false;

	/**
	 * Actionable guidance from the last reconstruction (a newest `goal-state`
	 * entry that was malformed or had an unrecognized version). The caller surfaces
	 * it; reconstruction itself stays silent and fails closed.
	 */
	private lastNotice: string | null = null;

	/**
	 * Rebuild state from the active branch. Called on session_start (startup,
	 * resume, reload, new, fork/clone) and session_tree (branch navigation).
	 *
	 * The last *current* `goal-state` entry on the branch wins, and a tombstone
	 * (`goal: null`) is a current entry: a cleared Goal therefore stays cleared on
	 * the branch that cleared it, no matter how many older snapshots of it the
	 * same branch still contains. A snapshot marked `superseded` is a finalized
	 * historical record of a replaced identity: it is valid and replayable, but it
	 * never wins, so a freeze that landed after the replacement's own snapshot
	 * cannot resurrect the identity the user replaced. An entry that is not a
	 * recognizable snapshot (unknown version, wrong shape, unknown status) is
	 * skipped rather than trusted, so a corrupt line never decides the session's
	 * Goal state.
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
		this.lastNotice = null;
		let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
		try {
			branch = ctx.sessionManager.getBranch();
		} catch (error) {
			// Never break the session on corrupt entries; report and keep absent state.
			console.error("[pi-goal] failed to reconstruct Goal state:", error);
			this.resetRuntimeState();
			return null;
		}

		// The newest *current* `goal-state` entry controls the branch. Scan to the end so a
		// malformed or unrecognized *latest* entry can be told apart from an older
		// invalid one: only the latest may fail the branch closed. A snapshot marked
		// `superseded` is a finalized historical record of an identity that has been
		// replaced; it is valid and replayable, but it must never become the current
		// Goal, so the newest non-superseded snapshot is the baseline. That is what
		// keeps a crash between the historical freeze and the next durable write from
		// resurrecting the superseded identity.
		let latestIndex = -1;
		let latest: unknown;
		let baselineIndex = -1;
		let baseline: GoalSnapshot | undefined;
		// The newest non-superseded snapshot that is not a tombstone. When the newest
		// non-superseded entry is a tombstone, this is the replay baseline for
		// recovering a superseded identity's still-open tail.
		let replayBaselineIndex = -1;
		let replayBaseline: GoalSnapshot | undefined;
		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index]!;
			if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE) {
				latestIndex = index;
				latest = entry.data;
				if (isGoalSnapshot(entry.data) && entry.data.superseded !== true) {
					baselineIndex = index;
					baseline = entry.data;
					if (entry.data.goal !== null) {
						replayBaselineIndex = index;
						replayBaseline = entry.data;
					}
				}
			}
		}

		if (latestIndex === -1) {
			this.resetRuntimeState();
			return null;
		}

		// Fail closed on a malformed or unrecognized newest snapshot. Falling back to
		// an older entry could resurrect a cleared, replaced, or stopped Goal, which
		// is exactly what the cutover contract forbids.
		if (!isGoalSnapshot(latest)) {
			this.resetRuntimeState();
			this.lastNotice =
				"pi-goal could not read the newest Goal snapshot on this branch (malformed data or an " +
				"unsupported version), so it left the session without a Goal instead of falling back to an older " +
				"snapshot. Inspect the goal-state entries in the session file, remove or repair the newest one, " +
				"then create a Goal again with /goal.";
			return null;
		}

		if (!baseline || baseline.goal === null) {
			// No current Goal. A superseded identity's tail may still be open on the
			// branch: Clear of the replacement does not close it, so the entries after
			// the replacement snapshot are its admitted work. Recover that tail by
			// replaying from the newest non-tombstone snapshot before the tombstone;
			// the caller's freeze boundary then persists it. A fresh runtime has no
			// in-flight turn to route, so the recovered tail never claims ownership.
			this.resetRuntimeState();
			if (replayBaseline && replayBaseline.goal !== null) {
				const replayed =
					replayBaseline.repaired === true || this.hasCutover(branch, replayBaseline.goal.id);
				// A superseded tail is a repaired-rules construct: a legacy branch has no
				// replacement machinery, so there is nothing to recover and no current
				// ledger to charge.
				if (replayed) {
					const replay = this.replayBranch(branch, replayBaselineIndex, "repaired");
					if (replay.superseded) this.supersededTail = replay.superseded;
				}
			}
			return null;
		}

		const goal = copyRecord(withSanitizedAudit(baseline.goal));
		const repaired = baseline.repaired === true || this.hasCutover(branch, goal.id);
		this.current = goal;
		this.supersededTail = null;
		this.pendingTransition = undefined;
		// The audit itself is durable, but which Goal turn it belongs to is not:
		// a fresh runtime has no turn to match, so the next report starts a new
		// turn rather than being swallowed as a repeat.
		this.lastBlockerTurn = undefined;
		this.lastBlockerRevision = undefined;
		this.legacyPending = !repaired;
		this.ledger.restore(normalizeUsage(goal.usage));
		this.clock.reset();
		this.clock.persisted(this.ledger.usage.activeMs);
		// Replay everything after the baseline so usage accrued since the last
		// durable write is recovered, not lost, and cannot be charged twice.
		//
		// A *complete* Goal is terminal, so nothing after its snapshot is Goal work:
		// the live path excludes those responses (the completing turn is charged at
		// `message_end`, before the tool that completes it), and the replay must draw
		// the same line. Without this, an unclean restart would reclassify the
		// post-completion response as Goal usage and inflate the total.
		if (goal.status !== "complete") {
			const replay = this.replayBranch(branch, baselineIndex, repaired ? "repaired" : "legacy");
			// A hard crash can leave the superseded identity's in-flight tail on the
			// branch after the replacement snapshot, with no freeze boundary yet. The
			// replay rebuilds that tail into a superseded record so the live view and a
			// reload converge on the old identity's total instead of dropping it.
			if (replay.superseded) this.supersededTail = replay.superseded;
			// The replay may have adopted a checkpoint's accounted active time, so the
			// clock resumes from the newest durable value rather than the snapshot's.
			this.clock.persisted(this.ledger.usage.activeMs);
			// Budget-stop convergence. The live path stops a Goal at the `message_end`
			// that crosses its budget and makes the transition durable at the next
			// boundary; a process that dies in between leaves an `active` snapshot and a
			// branch that replays past the budget. Reconstruction has to reach the same
			// stop, or the continuation seam admits a Goal turn the live session had
			// already paid for and failed to stop. Only a cut-over branch is repaired
			// this way: a pre-repair snapshot is migrated by {@link applyLegacyCutover},
			// which owns the configured maximum and the notice that goes with it.
			if (repaired) this.convergeBudgetStop();
		}
		this.applyBranchOwnership(branch, baselineIndex);
		// A superseded segment that is still open at the end of the branch is the live
		// replacement's ownership too: commit() kept the old admission open, and no
		// delivered user message has closed it yet. `currentOwnerId()` then reads as no
		// current owner, so a turn started now is not bound to the replacement, while
		// unbound reports follow the old open segment.
		//
		// Only while the replacement has no open segment of its own, though: a branch
		// whose newest work message belongs to the replacement (its kickoff was
		// delivered, and only the freeze write failed) keeps that segment, because that
		// is what the live path holds. Claiming the old identity here would rebind the
		// replacement's own turns — and its unbound tool results — to a Goal that was
		// already replaced.
		if (this.supersededTail?.open && !(this.goalOwned && this.ownerId === this.current?.id)) {
			this.goalOwned = true;
			this.ownerId = this.supersededTail.record.id;
		}
		if (this.current?.status === "active") this.clock.start();
		return this.current;
	}

	/**
	 * Stop an active Goal whose accounted usage has already reached its budget.
	 *
	 * Nothing is written: this is the reconstruction of a transition the live path
	 * made in memory, so it follows the same rule — the snapshot would otherwise land
	 * ahead of entries the ledger already covers. `flushAccounting` persists it at the
	 * next boundary, and the next reconstruction re-derives it from the branch if
	 * nothing ever runs.
	 */
	private convergeBudgetStop(): void {
		const goal = this.current;
		if (!goal || goal.status !== "active") return;
		if (!isBudgetExhausted(goal.tokenBudget, this.ledger.usage.totalTokens)) return;
		this.markBudgetLimited();
	}

	/** Forget every runtime-only piece of state (no Goal, no ownership, no legacy flag). */
	private resetRuntimeState(): void {
		this.current = null;
		this.pendingTransition = undefined;
		this.lastBlockerTurn = undefined;
		this.lastBlockerRevision = undefined;
		this.ledger.restore(zeroGoalUsage());
		this.clock.reset();
		this.goalOwned = false;
		this.ownerId = null;
		this.supersededTail = null;
		this.legacyPending = false;
	}

	/** Whether a branch carries a cutover marker for `goalId`. */
	private hasCutover(
		branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
		goalId: string,
	): boolean {
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== CUTOVER_ENTRY_TYPE) continue;
			const cutover = entry.data;
			if (isGoalCutover(cutover) && cutover.goalId === goalId) return true;
		}
		return false;
	}

	/**
	 * Derive the live Goal-owned flag from the branch after a reconstruction.
	 *
	 * Only a Goal work message that sits *after* the newest snapshot can leave a
	 * segment open: the snapshot is a durable transition that supersedes whatever
	 * came before it. A marker before the baseline therefore leaves ownership
	 * closed, and a genuine user prompt after the baseline closes it again.
	 */
	private applyBranchOwnership(
		branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
		baselineIndex: number,
	): void {
		let lastMarkerIndex = -1;
		let lastMarker: "goal-work" | "ordinary-user" | "none" = "none";
		for (let index = 0; index < branch.length; index++) {
			const marker = ownershipMarker(branch[index]!);
			if (marker.kind !== "none") {
				lastMarker = marker.kind;
				lastMarkerIndex = index;
			}
		}
		this.goalOwned =
			lastMarker === "goal-work" && lastMarkerIndex > baselineIndex && this.current != null;
		this.ownerId = this.goalOwned ? this.current?.id ?? null : null;
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
	 * The segment is tracked by *identity*, not just as a boolean, because a snapshot
	 * that introduces a different Goal identity closes the segment the previous
	 * identity opened. That is the branch-side half of `commit()` zeroing the ledger:
	 * a replacement staged while the old identity's run is still in flight appends its
	 * snapshot before the old response and its tool results, so carrying the old
	 * kickoff's flag across it would charge work the live path refused to the new
	 * Goal. A snapshot for the *same* identity (pause, resume, edit, an audit step)
	 * is a transition of that Goal's own work and leaves the segment open, which is
	 * what keeps already-admitted in-flight work attributable through a pause.
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
	private replayBranch(
		branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
		afterIndex: number,
		mode: "legacy" | "repaired",
	): {
		superseded: { record: GoalRecord; ledger: UsageLedger; open: boolean; dirty: boolean } | null;
	} {
		// The identity whose snapshot most recently preceded the entries being walked.
		// A work message opens the segment for that identity, so an entry appended after
		// a replacement snapshot is only ever charged once the replacement's own work
		// message has been delivered.
		let snapshotGoalId: string | null = null;
		let segmentOwner: string | null = null;
		// The most recent snapshot record, used to seed the superseded identity's ledger
		// when a replacement snapshot arrives while its segment is still open.
		let previousSnapshotRecord: GoalRecord | null = null;
		let supersededRecord: GoalRecord | null = null;
		let supersededLedger: UsageLedger | null = null;
		let supersededOpen = false;
		let supersededDirty = false;
		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index]!;
			const marker = ownershipMarker(entry);
			if (marker.kind === "goal-work") segmentOwner = snapshotGoalId;
			else if (marker.kind === "ordinary-user") {
				segmentOwner = null;
				// A delivered user message is the freeze boundary: live accounting has
				// already closed the old admission, so replay closes it too. The durable
				// frozen snapshot normally already records the tail; if a crash lost that
				// write, the recovered tail stays dirty for the next boundary to persist.
				supersededOpen = false;
			}
			if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE) {
				const snapshot = entry.data as GoalSnapshot | undefined;
				if (snapshot?.superseded === true) {
					// A finalized historical freeze closes the superseded identity's
					// admission without changing which identity is current. It is never
					// selected as the baseline, so it cannot resurrect the old Goal.
					supersededOpen = false;
					segmentOwner = null;
					if (
						supersededRecord &&
						supersededLedger &&
						snapshot.goal != null &&
						snapshot.goal.id === supersededRecord.id
					) {
						// The freeze is already durable, so adopt it instead of re-deriving the
						// tail from the entries before it. Without this, every reload of a
						// branch that had a replacement would report the recovered tail as
						// still unwritten and append the same historical snapshot again.
						supersededRecord = copyRecord(withSanitizedAudit(snapshot.goal));
						supersededLedger.restore(normalizeUsage(snapshot.goal.usage));
						supersededDirty = false;
					}
					continue;
				}
				if (!isGoalSnapshot(snapshot)) continue;
				const goalId: string | null = snapshot.goal?.id ?? null;
				if (goalId !== snapshotGoalId) {
					if (goalId === null) {
						// A tombstone ends the current Goal's admission. A superseded
						// identity's admission is independent: Clear of the replacement does
						// not erase the old identity's admitted work, so an open tail stays
						// open past the tombstone and keeps collecting its in-flight work.
						if (!supersededOpen) segmentOwner = null;
						snapshotGoalId = null;
					} else if (
						mode === "repaired" &&
						segmentOwner !== null &&
						segmentOwner !== goalId &&
						previousSnapshotRecord?.id === segmentOwner &&
						previousSnapshotRecord.status !== "complete"
					) {
						// The old identity's admission was still open when the replacement
						// committed. Its already-accounted totals are the last snapshot for
						// that identity; the entries that follow the replacement snapshot
						// until the next delivered user message are its in-flight tail.
						supersededRecord = copyRecord(previousSnapshotRecord);
						supersededLedger = new UsageLedger(normalizeUsage(previousSnapshotRecord.usage));
						supersededOpen = true;
						supersededDirty = false;
					}
					if (segmentOwner === goalId) segmentOwner = null;
					snapshotGoalId = goalId;
				}
				previousSnapshotRecord = snapshot.goal
					? copyRecord(withSanitizedAudit(snapshot.goal))
					: null;
			}
			if (index <= afterIndex) continue;
			if (entry.type === "custom") {
				if (entry.customType !== USAGE_ENTRY_TYPE) continue;
				const checkpoint = entry.data as UsageCheckpoint | undefined;
				if (!isUsageCheckpoint(checkpoint)) continue;
				// A checkpoint only counts for the Goal it was written for.
				if (supersededRecord && supersededLedger && checkpoint.goalId === supersededRecord.id) {
					this.applyCheckpointTo(supersededLedger, checkpoint);
					supersededRecord.usage = supersededLedger.usage;
					supersededDirty = true;
					if (this.refreshSupersededRecord(supersededRecord, supersededLedger)) supersededDirty = true;
					continue;
				}
				if (checkpoint.goalId !== this.current?.id) continue;
				this.applyCheckpoint(checkpoint);
				continue;
			}
			const superseded =
				supersededRecord != null && supersededLedger != null && segmentOwner === supersededRecord.id;
			if (
				mode === "repaired" &&
				!superseded &&
				(this.current == null || segmentOwner !== this.current.id)
			) {
				continue;
			}
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "assistant") {
					if (superseded && supersededLedger && supersededRecord) {
						if (supersededLedger.account(entry.id, message.usage, "model")) {
							supersededRecord.usage = supersededLedger.usage;
							supersededDirty = true;
							if (this.refreshSupersededRecord(supersededRecord, supersededLedger)) supersededDirty = true;
						}
					} else {
						this.ledger.account(entry.id, message.usage, "model");
					}
				} else if (message.role === "toolResult") {
					// Nested usage arrives merged into the tool result's own `usage`,
					// so charging the result once is what keeps it from being counted
					// twice.
					if (superseded && supersededLedger && supersededRecord) {
						if (supersededLedger.account(`toolResult:${message.toolCallId}`, message.usage, "nested")) {
							supersededRecord.usage = supersededLedger.usage;
							supersededDirty = true;
							if (this.refreshSupersededRecord(supersededRecord, supersededLedger)) supersededDirty = true;
						}
					} else {
						this.ledger.account(`toolResult:${message.toolCallId}`, message.usage, "nested");
					}
				}
				continue;
			}
			if (entry.type !== "compaction" && entry.type !== "branch_summary") continue;
			if (!entry.usage) continue;
			if (superseded && supersededLedger && supersededRecord) {
				if (supersededLedger.account(entry.id, entry.usage, "nested")) {
					supersededRecord.usage = supersededLedger.usage;
					supersededDirty = true;
					if (this.refreshSupersededRecord(supersededRecord, supersededLedger)) supersededDirty = true;
				}
			} else {
				this.ledger.account(entry.id, entry.usage, "nested");
			}
		}
		if (!supersededRecord || !supersededLedger || (!supersededOpen && !supersededDirty)) {
			return { superseded: null };
		}
		return {
			superseded: {
				record: supersededRecord,
				ledger: supersededLedger,
				open: supersededOpen,
				dirty: supersededDirty,
			},
		};
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
		this.applyCheckpointTo(this.ledger, checkpoint);
	}

	/** Adopt a checkpoint onto any ledger using the same undercount rule. */
	private applyCheckpointTo(ledger: UsageLedger, checkpoint: UsageCheckpoint): void {
		const checkpointUsage = normalizeUsage(checkpoint.usage);
		const replayed = ledger.usage;
		if (checkpointUsage.totalTokens < replayed.totalTokens) {
			// Undercount: keep the replayed tokens, and keep the checkpoint's active
			// time, which is the one thing the branch cannot reconstruct.
			ledger.restore({
				...replayed,
				activeMs: Math.max(replayed.activeMs, checkpointUsage.activeMs),
			});
			return;
		}
		ledger.restore(checkpointUsage);
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
		pi.appendEntry(
			CUSTOM_ENTRY_TYPE,
			{ version: 1, repaired: true, goal: copyRecord(goal) } satisfies GoalSnapshot,
		);
	}

	/**
	 * Append a finalized historical snapshot of a superseded identity.
	 *
	 * The `superseded` marker is what makes this single append crash-safe:
	 * reconstruction skips a superseded snapshot when it chooses the current Goal, so
	 * a crash immediately after this append still reconstructs the replacement from
	 * its own snapshot. There is no second append to lose, and therefore no window in
	 * which the newest `goal-state` entry is a replaced identity that would be read as
	 * current.
	 */
	private persistSupersededSnapshot(pi: ExtensionAPI, goal: GoalRecord): void {
		pi.appendEntry(
			CUSTOM_ENTRY_TYPE,
			{ version: 1, repaired: true, superseded: true, goal: copyRecord(goal) } satisfies GoalSnapshot,
		);
	}

	/**
	 * Adopt a *copy* of `goal` as the live record, for the same reason
	 * `persistSnapshot` copies: one object must never be both the live record and a
	 * persisted entry.
	 */
	private adopt(goal: GoalRecord): GoalRecord {
		return copyRecord(goal);
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
				if (custom?.customType !== CUSTOM_ENTRY_TYPE) continue;
				// A finalized superseded snapshot is history, not the current Goal: a
				// durability check for the replacement must not be defeated by the old
				// identity's freeze landing after the replacement snapshot.
				if (custom.data?.superseded === true) continue;
				lastGoal = custom.data?.goal ?? undefined;
			}
			return lastGoal?.id === goalId;
		} catch {
			return false;
		}
	}

	/**
	 * Persist the current Goal's already-accounted totals as a durable snapshot
	 * before replacement commits a new identity, and keep the old identity's
	 * admission open for its in-flight tail.
	 *
	 * The frozen record preserves the superseded Goal's accounted usage on its own
	 * branch history without changing the live ledger: the replacement still resets
	 * accounting for the new Goal. It is a *current* snapshot, not a historical one,
	 * because it is what a crash between this write and the replacement's own snapshot
	 * must reconstruct from. The old identity's segment stays open past `commit()` when
	 * it was open here, so a response or tool result still in flight is charged to the
	 * old identity and frozen onto a superseded snapshot by
	 * {@link closeSupersededSegment} instead of being dropped or charged to the
	 * replacement.
	 */
	preserveSupersededForReplacement(pi: ExtensionAPI): boolean {
		const current = this.current;
		if (!current) return true;
		// A still-open previous tail must be frozen *before* this replacement's
		// already-accounted snapshot overwrites it. The tail belongs to the identity
		// that was replaced first; dropping it here would lose work the old identity
		// had already admitted. If the freeze fails, the replacement must not proceed.
		const superseded = this.supersededTail;
		if (superseded) {
			const frozen = this.closeSupersededSegment(pi);
			if (!frozen && superseded.dirty) return false;
		}
		const usage = this.liveUsage();
		const record = { ...copyRecord(current), usage };
		this.persistSnapshot(pi, record);
		const open = this.goalOwned && this.ownerId === current.id && record.status !== "complete";
		this.supersededTail = {
			record: copyRecord(record),
			ledger: new UsageLedger(usage),
			open,
			dirty: false,
		};
		return true;
	}

	/**
	 * Freeze the superseded identity's in-flight tail onto a durable historical
	 * snapshot and return that record, or `null` when there is nothing to freeze or
	 * the write failed.
	 *
	 * Called when the next user message is delivered, at shutdown, and before a
	 * second replacement or a durability-rollback restore — every boundary that
	 * would otherwise discard the old identity's already-admitted work. Clear does
	 * not freeze an *open* tail: it keeps the admission open past the tombstone so
	 * the old identity's in-flight work stays attributable (see
	 * {@link commitTombstone}).
	 *
	 * The snapshot is marked `superseded`, so it can never become the current Goal on
	 * reconstruction even if the process dies immediately after this append. There is
	 * no separate re-affirmation of the replacement to lose: the replacement's own
	 * snapshot is already the newest non-superseded entry. A write failure leaves the
	 * tail dirty for the next boundary instead of dropping it, and does not throw into
	 * the event handler that called it.
	 */
	closeSupersededSegment(pi: ExtensionAPI): GoalRecord | null {
		const result = this.tryCloseSupersededSegment(pi);
		return result.ok ? result.record : null;
	}

	/**
	 * Freeze the superseded identity's tail and report a write failure distinctly
	 * from "nothing to freeze", so a boundary that must not lose already-accounted
	 * work (Clear) can refuse to proceed instead of dropping it.
	 */
	private tryCloseSupersededSegment(
		pi: ExtensionAPI,
	): { ok: true; record: GoalRecord | null } | { ok: false; error: unknown } {
		const superseded = this.supersededTail;
		if (!superseded) return { ok: true, record: null };
		const record = superseded.record;
		record.usage = { ...superseded.ledger.usage };
		if (!superseded.dirty) {
			// Nothing new to write: the earlier superseded snapshot already carries this
			// identity's totals. Closing an idle tail must not grow the snapshot log.
			this.supersededTail = null;
			return { ok: true, record };
		}
		this.refreshUsage();
		try {
			this.persistSupersededSnapshot(pi, record);
		} catch (error) {
			// Keep the tail for the next boundary. Losing it would drop work that was
			// already admitted for the superseded identity.
			return { ok: false, error };
		}
		this.supersededTail = null;
		return { ok: true, record };
	}

	/**
	 * Close the superseded identity's admission at a delivery or load boundary.
	 *
	 * The tail is frozen when the write succeeds. If the write fails, the dirty tail
	 * is kept for the next boundary but the admission is closed, so work that follows
	 * the boundary is never attributed to the old identity.
	 */
	closeSupersededAdmission(pi: ExtensionAPI): GoalRecord | null {
		const frozen = this.closeSupersededSegment(pi);
		const superseded = this.supersededTail;
		if (superseded) superseded.open = false;
		return frozen;
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
		// A replacement does not close the superseded identity's admission: its
		// in-flight tail stays attributable to the old identity until the next
		// delivered user message (see `closeSupersededSegment`).
		const superseded = this.supersededTail;
		if (superseded && superseded.open) {
			this.goalOwned = true;
			this.ownerId = superseded.record.id;
		} else {
			// A new identity owns no work yet: attribution starts when pi-goal sends its
			// first Goal work message (the /goal kickoff) or, for create_goal, at the
			// first subsequent Continuation.
			this.goalOwned = false;
			this.ownerId = null;
		}
		this.legacyPending = false;
		if (goal.status === "active") this.clock.start();
	}

	/**
	 * Charge one usage report exactly once, and only when it is Goal-owned work.
	 *
	 * `key` is the identity the accounting path guarantees: a sequence number for an
	 * assistant message, `toolResult:<toolCallId>` for tool-performed nested work, or
	 * the session entry id of a summarization entry. Returns the contribution when
	 * the key was new.
	 *
	 * Ownership is the load-bearing guard: an ordinary prompt, a creation control,
	 * a pre-creation response, or an unrelated same-batch tool result is never
	 * charged, whatever the Goal's status. Completion stays terminal for accounting
	 * on both the live path and the replay, so nothing after it is charged either.
	 *
	 * `admittedBy` binds the report to the Goal identity that owned the segment when
	 * the provider request *started*. A replacement steered into an in-flight run
	 * must not steal the response that was already on the wire for the old identity,
	 * so an assistant report started under the old identity is charged to the old
	 * identity's superseded tail, and a report started under any other identity is
	 * refused rather than re-attributed. `null` means the turn started with no Goal
	 * (a mid-turn Goal work message may still open a segment); `undefined` is used
	 * for reports without a turn seam (tool results, summarization), which follow
	 * the currently open segment.
	 */
	accountUsage(key: string, usage: Usage | undefined, source: UsageSource, admittedBy?: string | null) {
		const target = this.usageTarget(admittedBy);
		if (!target) return undefined;
		if (target === "superseded") {
			const superseded = this.supersededTail!;
			const record = superseded.record;
			if (record.status === "complete") return undefined;
			const contribution = superseded.ledger.account(key, usage, source);
			if (contribution) {
				record.usage = superseded.ledger.usage;
				superseded.dirty = true;
				this.refreshSupersededBudget();
			}
			return contribution;
		}
		const current = this.current;
		if (!current || current.status === "complete") return undefined;
		const contribution = this.ledger.account(key, usage, source);
		if (contribution) this.refreshUsage();
		return contribution;
	}

	/**
	 * Which identity an accounting report belongs to, given its turn binding.
	 *
	 * The superseded identity's open segment is a real admission: a report bound to
	 * it (or an unbound report while its segment is the open one) is charged to the
	 * old identity, never to the replacement. A report bound to the current identity
	 * is charged only while that identity's own segment is open.
	 */
	private usageTarget(admittedBy: string | null | undefined): "current" | "superseded" | null {
		const current = this.current;
		const superseded = this.supersededTail;
		if (admittedBy !== undefined && admittedBy !== null) {
			if (superseded && superseded.open && admittedBy === superseded.record.id) return "superseded";
			if (current && admittedBy === current.id && this.goalOwned && this.ownerId === current.id) {
				return "current";
			}
			return null;
		}
		if (this.goalOwned && this.ownerId !== null) {
			if (superseded && superseded.open && this.ownerId === superseded.record.id) return "superseded";
			if (current && this.ownerId === current.id) return "current";
		}
		return null;
	}

	/**
	 * Record the old identity's budget exhaustion on its superseded record only.
	 *
	 * The replacement keeps its own fresh ledger and its own budget; the old
	 * identity's stop is a historical fact about its frozen record. No wrap-up is
	 * armed for it: a superseded identity never continues.
	 */
	private refreshSupersededBudget(): void {
		const superseded = this.supersededTail;
		if (!superseded) return;
		if (this.refreshSupersededRecord(superseded.record, superseded.ledger)) {
			superseded.dirty = true;
		}
	}

	/**
	 * Record budget exhaustion on a superseded identity's record, returning whether
	 * it changed. Used both by the live tail and by replay reconstruction.
	 */
	private refreshSupersededRecord(record: GoalRecord, ledger: UsageLedger): boolean {
		if (record.status !== "active") return false;
		if (!isBudgetExhausted(record.tokenBudget, ledger.usage.totalTokens)) return false;
		record.status = "budget_limited";
		record.updatedAt = Date.now();
		record.revision += 1;
		return true;
	}

	/** Mark the current run/segment as Goal-owned work for `goalId`. */
	beginGoalWork(goalId: string): void {
		this.goalOwned = true;
		this.ownerId = goalId;
	}

	/** Close the current segment: an ordinary user prompt is never Goal work. */
	endGoalWork(): void {
		// The superseded identity's admission closes at its freeze boundary (see
		// `closeSupersededAdmission`). While it is open, an ordinary prompt must not
		// clear the binding: the old identity's in-flight tail is still admitted.
		const superseded = this.supersededTail;
		if (superseded?.open && this.ownerId === superseded.record.id) return;
		this.goalOwned = false;
		this.ownerId = null;
	}

	/**
	 * Whether the superseded identity's admission is still open for in-flight work.
	 *
	 * The `message_end` and compaction seams charge reports against the Goal that
	 * exists when the report is finalized; a Clear that lands while the old
	 * identity's request is in flight leaves no current Goal, so they must still
	 * charge its admitted tail.
	 */
	hasOpenSupersededTail(): boolean {
		return this.supersededTail?.open === true;
	}

	/** Whether a superseded tail is still waiting to be made durable. */
	hasUnfrozenSupersededTail(): boolean {
		return this.supersededTail?.dirty === true;
	}

	/**
	 * The identity the *current* segment was admitted for, or null when the open
	 * segment belongs to the superseded identity (or no segment is open).
	 *
	 * `turn_start` uses this to bind the turn's assistant report. A replacement
	 * steered into an in-flight run must not bind the new turn to the old identity,
	 * so an open superseded segment reads as no current owner; the old tail is
	 * routed by the open segment itself (see `usageTarget`).
	 */
	currentOwnerId(): string | null {
		if (!this.goalOwned || this.ownerId === null) return null;
		return this.current != null && this.ownerId === this.current.id ? this.ownerId : null;
	}

	/** Actionable guidance from the last reconstruction, if any. */
	takeNotice(): string | null {
		const notice = this.lastNotice;
		this.lastNotice = null;
		return notice;
	}

	/** Whether the selected branch still needs its one-time legacy cutover. */
	needsLegacyCutover(): boolean {
		return this.legacyPending;
	}

	/**
	 * Perform the one-time branch-local cutover of a pre-repair (0.1.0) snapshot.
	 *
	 * The legacy token totals and active milliseconds reconstructed by
	 * {@link replayBranch} under the 0.1.0 status-only rule are frozen as the
	 * Goal's historical baseline, never reclassified under the repaired Goal-owned
	 * rules. The repaired snapshot and the branch-local cutover marker are written
	 * before any repaired Goal work is admitted. The snapshot is the load-bearing
	 * write — it is what the next load reads — so once it is durable the cutover
	 * stands and the in-memory record is replaced with it; only the marker is
	 * allowed to fail afterwards, and that failure is reported rather than thrown
	 * (see {@link CutoverResult}). A snapshot write that fails leaves the branch
	 * untouched, so a reload retries the whole cutover.
	 *
	 * The configured maximum is a hard safety bound: an unbounded Goal or one
	 * above the maximum is migrated to the maximum with an explicit notice, while
	 * the configured default is never applied retroactively. An active Goal whose
	 * reconstructed usage already reached its effective budget becomes
	 * `budget_limited` and earns the one bounded wrap-up.
	 */
	applyLegacyCutover(pi: ExtensionAPI, settings: { maxTokenBudget?: number }): CutoverResult {
		const current = this.current;
		if (!this.legacyPending || !current) {
			this.legacyPending = false;
			return { ok: true, cutover: false, notices: [] };
	}
		const notices: string[] = [];
		let updated: GoalRecord = copyRecord(current);
		const max = settings.maxTokenBudget;
		if (max !== undefined && (updated.tokenBudget === undefined || updated.tokenBudget > max)) {
			const before = updated.tokenBudget === undefined ? "unbounded" : `${updated.tokenBudget} tokens`;
			updated.tokenBudget = max;
			notices.push(
				`pi-goal migrated Goal ${updated.id} to the configured maximum token budget of ${max} tokens ` +
				`(it was ${before}). The Goal's identity and accounted usage are unchanged; the default budget ` +
				"was not applied retroactively.",
			);
		}

		// Freeze the legacy reconstructed totals exactly as the 0.1.0 rules produced
		// them. Live active time up to the cutover is part of the baseline.
		const frozen = this.liveUsage();
		if (updated.status === "active" && isBudgetExhausted(updated.tokenBudget, frozen.totalTokens)) {
			updated.status = "budget_limited";
			updated.wrapUpPending = true;
			this.clock.stop();
			notices.push(
				`pi-goal found the legacy Goal ${updated.id} already at its token budget of ` +
				`${updated.tokenBudget} tokens (${frozen.totalTokens} accounted). It is now budget_limited and ` +
				"earns one bounded wrap-up; budget exhaustion is not completion.",
			);
		}

		const record: GoalRecord = { ...updated, usage: frozen };
		try {
			this.persistSnapshot(pi, record);
		} catch (error) {
			// Nothing was written, so the branch is untouched and a reload retries.
			return { ok: false, reason: "persistence", error };
		}
		// The repaired snapshot is durable from here on, so the cutover stands whatever
		// happens to the marker: adopting the record now is what keeps a later
		// transition from persisting the pre-cutover record over it. The marker is a
		// branch-local record that a snapshot without `repaired` was migrated; this
		// snapshot carries it, so its absence only means a fork copied in the fault
		// window re-runs the migration instead of inheriting the baseline.
		let markerError: unknown;
		try {
			pi.appendEntry(CUTOVER_ENTRY_TYPE, { version: 1, goalId: record.id } satisfies GoalCutover);
		} catch (error) {
			markerError = error;
		}
		this.current = this.adopt(record);
		this.ledger.restore(frozen);
		this.clock.reset();
		this.clock.persisted(frozen.activeMs);
		this.legacyPending = false;
		if (record.status === "active") this.clock.start();
		return { ok: true, cutover: true, notices, ...(markerError === undefined ? {} : { markerError }) };
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
		const superseded = this.supersededTail;
		if (superseded && !superseded.open) {
			// A closed tail is finished work: it must be durable before the tombstone,
			// or Clear would erase already-accounted work. Refuse the Clear instead of
			// dropping it. The superseded snapshot is historical and never current.
			const frozen = this.tryCloseSupersededSegment(pi);
			if (!frozen.ok) {
				return { ok: false, reason: "persistence", error: frozen.error };
			}
		}
		try {
			pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 1, goal: null } satisfies GoalSnapshot);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = null;
		this.pendingTransition = undefined;
		this.ledger.restore(zeroGoalUsage());
		this.clock.reset();
		this.legacyPending = false;
		if (superseded && superseded.open) {
			// The old identity's admission is still taking its in-flight tail. Clear of
			// the replacement does not erase work already admitted for the superseded
			// identity, so the tail stays open and bound to it until the next freeze
			// boundary (the next delivered user message, a shutdown, or a new Goal).
			this.goalOwned = true;
			this.ownerId = superseded.record.id;
		} else {
			this.goalOwned = false;
			this.ownerId = null;
			this.supersededTail = null;
		}
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
		this.lastBlockerRevision = undefined;
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
		this.lastBlockerRevision = undefined;
		this.goalOwned = false;
		this.ownerId = null;
		this.supersededTail = null;
		this.legacyPending = false;
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
		expected?: GoalBinding,
	): BlockedReportResult {
		const current = this.current;
		if (!current || current.status !== "active") return { ok: false, reason: "not-active" };
		const blocker = params.blocker.trim();
		const previous = current.blockedAudit;

		// A repeated report inside the same Goal turn is idempotent: it must not
		// advance the audit, or a model that retries its own tool call could
		// satisfy the threshold inside one turn. This check comes before the stale
		// binding check precisely because the first report advanced the revision: a
		// repeat prepared against the pre-report revision is still the same turn and
		// must read as one audit step, not as a stale write.
		//
		// The revision the counted report wrote is what keeps that sound. A Goal can
		// advance for a reason that has nothing to do with the report — `/goal edit`
		// runs immediately while the run is busy — and then the repeat is *not* the
		// same audit step: the model is reporting a blocker against an objective it
		// can no longer see. It falls through to the stale check below instead of
		// being reported as recorded.
		const repeatedTurn = this.lastBlockerTurn === params.turn && previous !== undefined;
		if (repeatedTurn && current.revision === this.lastBlockerRevision) {
			return {
				ok: true,
				goal: current,
				turns: previous.turns,
				thresholdMet: previous.turns >= BLOCKED_AUDIT_THRESHOLD,
				repeat: true,
			};
		}

		const stale = this.checkBinding(current, expected);
		if (stale) {
			return { ok: false, reason: "stale", message: stale };
		}
		if (repeatedTurn) {
			return {
				ok: false,
				reason: "stale",
				message:
					`the Goal changed while the call was in flight: the blocker report already counted for this Goal ` +
					`turn was recorded at revision ${this.lastBlockerRevision} but the Goal is now revision ` +
					`${current.revision}. Call get_goal, re-read the current objective, and report again if the ` +
					"blocker persists.",
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
		this.lastBlockerRevision = current.revision + 1;

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
			this.persistSnapshot(pi, updated);
		} catch (error) {
			this.lastBlockerTurn = undefined;
			this.lastBlockerRevision = undefined;
			return { ok: false, reason: "persistence", error };
		}
		this.current = this.adopt(updated);
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
			this.persistSnapshot(pi, updated);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = this.adopt(updated);
		this.lastBlockerTurn = undefined;
		this.lastBlockerRevision = undefined;
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
		this.lastBlockerRevision = undefined;
		const current = this.current;
		if (!current || current.status !== "active" || current.blockedAudit === undefined) {
			return { ok: true, reset: false };
		}
		const { blockedAudit: _dropped, ...rest } = current;
		const updated: GoalRecord = { ...rest, updatedAt: Date.now(), revision: current.revision + 1 };
		try {
			this.persistSnapshot(pi, updated);
		} catch (error) {
			// Keep the audit rather than dropping it: an in-memory reset that is not
			// durable would let a reload resurrect a count the user invalidated.
			return { ok: false, reason: "persistence", error };
		}
		this.current = this.adopt(updated);
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
		let record: GoalRecord = { ...previous };
		// A replacement whose durability could not be confirmed may still have the old
		// identity's in-flight tail open. Freeze that tail before restoring: the tail
		// belongs to the identity being restored, and dropping it here would lose work
		// that was already admitted and sits before the restored snapshot.
		const superseded = this.supersededTail;
		if (superseded) {
			const frozen = this.closeSupersededSegment(pi);
			if (frozen && frozen.id === previous.id) {
				record = frozen;
			} else if (!frozen && superseded.record.id === previous.id) {
				// The freeze write failed. Keep the tail on the restored record rather than
				// dropping it; the next durable write will carry it.
				record = {
					...record,
					usage: { ...superseded.ledger.usage },
					...(superseded.record.status === "budget_limited" ? { status: "budget_limited" as const } : {}),
				};
			}
		}
		try {
			this.persistSnapshot(pi, record);
		} catch (error) {
			return { ok: false, reason: "persistence", error };
		}
		this.current = this.adopt(record);
		this.pendingTransition = undefined;
		this.goalOwned = false;
		this.ownerId = null;
		this.supersededTail = null;
		this.legacyPending = false;
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
