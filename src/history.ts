/**
 * The non-authoritative durable Goal audit history (issue #54).
 *
 * Goal snapshots and tombstones are the only lifecycle authority: they decide
 * what the current Goal is, what it may do next, and what a restart reconstructs.
 * This module adds a *second, derived* view of the same transitions — a
 * branch-local timeline a human can read after the fact — and it is deliberately
 * shaped so that it can never become a second source of truth:
 *
 * - it is **written from the committed transition**, never before it. The one
 *   call site is the store's committed-transition seam (the same seam that
 *   publishes `pi-goal:updated`), so a record exists only for a transition that
 *   is already durable, and a refused, failed, or retracted transition writes
 *   nothing;
 * - it is **derived from the event payload** rather than re-projected from the
 *   record, so history and the event stream cannot disagree about a transition
 *   (see {@link toGoalHistoryRecord});
 * - it is **never read by reconstruction**. `GoalStore.reconstruct` reads
 *   `goal-state` entries and nothing else, so a missing, truncated, or malformed
 *   history entry cannot resurrect, clear, replace, or otherwise change the
 *   authoritative Goal — the worst it can do is make the timeline harder to read;
 * - it records **metadata, never contents**: the manifest hashes (with media type,
 *   size, and label) rather than attachment bytes, exactly as the event does. The
 *   Goal title text is not recorded either: it follows the Objective's privacy
 *   boundary, and the record is projected from the event payload, which never
 *   carries the label.
 *
 * The one asymmetry the design accepts is the crash window between the lifecycle
 * commit and this append. A process that dies in that window leaves a transition
 * with no history record. That is a *diagnostic* gap only — the snapshot is
 * durable, so reconstruction and every later transition are correct — and it is
 * documented in `docs/behavior/history.md` rather than papered over with a
 * reconciliation pass that would have to invent the missing record.
 *
 * History is intentionally **not** a mutation surface. There is no command that
 * applies, replays, or reverts a history record: the only reader is the read-only
 * `/goal:history` rendering, and the only writer is the committed-transition seam.
 */
import { GOAL_TRANSITION_KINDS, type GoalTransitionKind } from "./events.ts";
import type { GoalEventAttachment, GoalEventUsage, GoalUpdatedEvent } from "./events.ts";
import { GOAL_STATUSES, type GoalStatus } from "./goal.ts";

/** Custom-entry channel for history records, kept apart from `goal-state`. */
export const HISTORY_ENTRY_TYPE = "goal-history";

/**
 * The usage summary a history record carries.
 *
 * Structurally the same numbers the Goal-updated event publishes, and taken from
 * that same payload, so the two surfaces can never drift. Accounting churn is
 * deliberately absent: a record is written per *transition*, never per token
 * delta, `goal-usage` checkpoint, or active-time tick.
 */
export type GoalHistoryUsage = GoalEventUsage;

/**
 * One attachment's manifest metadata as history records it.
 *
 * The hash is the identity of the artifact; the media type, byte size, and label
 * make the line readable without opening the artifact store. Contents are never
 * duplicated here — the bytes live once, in the extension-owned store.
 */
export type GoalHistoryAttachment = GoalEventAttachment;

/** One committed transition, as the durable history records it. */
export interface GoalHistoryRecord {
	/** Payload version. Bumps only if the record shape itself changes. */
	version: 1;
	/** The transition kind, from the same vocabulary as the event stream. */
	kind: GoalTransitionKind;
	/** The committed Goal identity the transition belongs to. */
	goalId: string;
	/** The revision this transition committed. */
	revision: number;
	/**
	 * The Lifecycle status before the transition, or `null` for a creation (there
	 * was no Goal in the slot before it).
	 */
	from: GoalStatus | null;
	/** The Lifecycle status as committed (for a clear, the status it had). */
	to: GoalStatus;
	/** ISO timestamp of the committed transition (the snapshot's own `updatedAt`). */
	timestamp: string;
	/** The committed usage summary at the transition. */
	usage: GoalHistoryUsage;
	/** The immutable manifest's metadata in manifest order; `[]` when none. */
	attachments: GoalHistoryAttachment[];
}

/** What reading a branch's history produced. */
export interface GoalHistoryView {
	/** The readable records, in append (commit) order. */
	records: GoalHistoryRecord[];
	/** How many `goal-history` entries could not be read and were skipped. */
	malformed: number;
	/**
	 * True when the branch itself could not be read — as distinct from a branch that
	 * was read and found empty, or read and found to hold only malformed entries.
	 * The renderer says the history could not be read rather than claiming the branch
	 * is empty; it is a rendering diagnostic only and never affects reconstruction,
	 * which reads `goal-state` alone.
	 */
	unreadable?: boolean;
}

/** Structural shape of a session-branch entry, so history.ts stays Pi-free. */
interface HistoryBranchEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

/**
 * Project one committed transition into its history record.
 *
 * The event payload is the *only* input, which is what makes "history and the
 * event stream cannot disagree" a property of the code rather than of a
 * convention: there is no second projection of the record to fall out of step.
 * Everything the record carries beyond the event — the previous Lifecycle status —
 * comes from the caller's knowledge of the transition, because the committed
 * record itself does not carry what it replaced.
 *
 * `previousStatus` is `null` for a creation (nothing occupied the slot), the
 * replaced identity's status for a Replacement Goal, and the Goal's own previous
 * status for every in-place transition. A clear reports the status the cleared
 * Goal had in both fields, because a tombstone names no new current Goal.
 */
export function toGoalHistoryRecord(
	event: GoalUpdatedEvent,
	previousStatus: GoalStatus | null,
): GoalHistoryRecord {
	return {
		version: 1,
		kind: event.kind,
		goalId: event.goal.id,
		revision: event.goal.revision,
		from: previousStatus,
		to: event.goal.status,
		timestamp: event.timestamp,
		usage: { ...event.goal.usage },
		attachments: event.goal.attachments.map((attachment) => ({ ...attachment })),
	};
}

/**
 * The transition kinds and Lifecycle statuses a record may legitimately name.
 *
 * A record's `kind` and its `from`/`to` statuses are only valid when they come from
 * these shared vocabularies — the same ones the event stream and the Goal model
 * use. An entry naming anything else is a corrupt or future-version record, not a
 * transition this build understands, so validation rejects it and the reader skips
 * and counts it like any other malformed entry, rather than rendering an invented
 * transition or a status the Goal never held.
 */
const GOAL_TRANSITION_KIND_SET = new Set<string>(GOAL_TRANSITION_KINDS);
const GOAL_STATUS_SET = new Set<string>(GOAL_STATUSES);

/** Whether a value is a structurally valid history record. */
export function isGoalHistoryRecord(value: unknown): value is GoalHistoryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return false;
	if (typeof record.kind !== "string" || !GOAL_TRANSITION_KIND_SET.has(record.kind)) return false;
	if (typeof record.goalId !== "string" || record.goalId === "") return false;
	if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 0) return false;
	// A creation has no previous status (`null`); every other transition names a known
	// Lifecycle status. An unknown `from`/`to` is malformed, never a real record.
	if (record.from !== null && (typeof record.from !== "string" || !GOAL_STATUS_SET.has(record.from))) return false;
	if (typeof record.to !== "string" || !GOAL_STATUS_SET.has(record.to)) return false;
	if (typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))) return false;
	if (!record.usage || typeof record.usage !== "object") return false;
	const usage = record.usage as Record<string, unknown>;
	for (const key of [
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"cacheWriteTokens",
		"cachedReadTokens",
		"reasoningTokens",
		"nestedTokens",
		"activeSeconds",
	] as const) {
		const field = usage[key];
		if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return false;
	}
	if (!Array.isArray(record.attachments)) return false;
	for (const attachment of record.attachments) {
		if (!attachment || typeof attachment !== "object") return false;
		const entry = attachment as Record<string, unknown>;
		if (typeof entry.hash !== "string" || entry.hash === "") return false;
		if (typeof entry.mediaType !== "string" || entry.mediaType === "") return false;
		if (typeof entry.bytes !== "number" || !Number.isInteger(entry.bytes) || entry.bytes < 0) return false;
		if (typeof entry.label !== "string") return false;
	}
	return true;
}

/**
 * Read a branch's history records, in append order, counting the unreadable ones.
 *
 * A `goal-history` entry that is not a recognizable record is **skipped and
 * counted**, never trusted and never fatal: the branch may legitimately contain a
 * truncated line (a process killed mid-write, a hand-edited file, a future version
 * this build does not understand), and a timeline is a diagnostic surface — the
 * authoritative Goal is reconstructed from `goal-state` alone. The count is what
 * lets the renderer surface the gap instead of silently showing a shorter
 * timeline than the branch holds.
 */
export function readGoalHistory(entries: readonly HistoryBranchEntryLike[]): GoalHistoryView {
	const records: GoalHistoryRecord[] = [];
	let malformed = 0;
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== HISTORY_ENTRY_TYPE) continue;
		const data = entry.data;
		if (isGoalHistoryRecord(data)) records.push(data);
		else malformed += 1;
	}
	return { records, malformed };
}

/** Whole seconds, for human-facing rendering (mirrors `formatSeconds` in goal.ts). */
function formatSeconds(seconds: number): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	if (safe < 60) return `${safe}s`;
	const minutes = Math.floor(safe / 60);
	const rest = safe % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Human-facing byte size for the attachment summary. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The status change of one record: `active → paused`, or the single status when
 * the transition did not move it (a clear names the status the Goal had) and
 * `→ active` for a creation, which had no previous status.
 */
function formatStatusChange(record: GoalHistoryRecord): string {
	if (record.from === null) return `→ ${record.to}`;
	if (record.from === record.to) return record.to;
	return `${record.from} → ${record.to}`;
}

/**
 * Rendered-length caps for the untrusted string fields of a record.
 *
 * History is diagnostic data read straight off the session branch, so a hand-edited
 * or corrupt entry can carry any bytes. These caps keep one bad record from flooding
 * a timeline notice with a wall of text. They touch only the *rendering* — the
 * durable record is never rewritten — and each is generous enough that a legitimate
 * value is never truncated.
 */
const MAX_RENDERED_LABEL = 80; // an attachment basename; real ones are far shorter
const MAX_RENDERED_MEDIA_TYPE = 64; // e.g. "text/plain"; well under this
const MAX_RENDERED_HASH = 12; // the abbreviated digest, already sliced to 12 hex chars
const MAX_RENDERED_KIND = 24; // the longest transition kind is 16 characters
const MAX_RENDERED_GOAL_ID = 64; // a real id is "goal_" plus 8 hex (13 characters)
const MAX_RENDERED_REVISION = 20; // any rendered integer fits well inside this
const MAX_RENDERED_TIMESTAMP = 32; // an ISO-8601 instant is 24 characters

/** ANSI escape sequences: the CSI form (`\x1b[ … final-byte`) and the single-char Fe forms. */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/** C0/C1 control characters, except the tab/newline/carriage-return that get collapsed. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Render one untrusted string field safely for the single-line timeline.
 *
 * Strips ANSI escape sequences (so a corrupt label cannot paint terminal colors or
 * move the cursor) and the remaining control characters, collapses every whitespace
 * run — newlines included — to one space (so a value can never forge a second line),
 * trims, and caps the length with a trailing ellipsis. A purely rendering transform:
 * the durable record is read, never written.
 */
function renderText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(ANSI_ESCAPE, "")
		.replace(CONTROL_CHARS, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}

/** The one-line summary of one record. */
function formatHistoryLine(record: GoalHistoryRecord): string {
	const usage = record.usage;
	const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
	return (
		`${renderText(record.timestamp, MAX_RENDERED_TIMESTAMP)}  ` +
		`${renderText(record.kind, MAX_RENDERED_KIND)}  ` +
		`${renderText(record.goalId, MAX_RENDERED_GOAL_ID)}  ` +
		`revision ${renderText(String(record.revision), MAX_RENDERED_REVISION)}  ` +
		`${formatStatusChange(record)}  ${total} tokens  active ${formatSeconds(usage.activeSeconds)}`
	);
}

/**
 * The manifest line of one record, or null when the Goal had no attachments.
 *
 * Rendered per record rather than deduplicated across the timeline: a branch-local
 * view must stay readable on its own, so a record cannot depend on an earlier line
 * to say what the Goal owned at that transition. Hashes are abbreviated to the
 * first 12 hex characters — enough to compare two records by eye, while the full
 * 64-character digest stays in the durable entry.
 */
function formatAttachmentLine(record: GoalHistoryRecord): string | null {
	if (record.attachments.length === 0) return null;
	const items = record.attachments
		.map(
			(attachment) =>
				`${renderText(attachment.label, MAX_RENDERED_LABEL)} ` +
				`(${renderText(attachment.mediaType, MAX_RENDERED_MEDIA_TYPE)}, ${formatBytes(attachment.bytes)}) ` +
				`sha256:${renderText(attachment.hash.slice(0, 12), MAX_RENDERED_HASH)}`,
		)
		.join("; ");
	return `    attachments: ${items}`;
}

/**
 * Render the timeline as readable text.
 *
 * Read-only by construction: this function takes records and returns a string. It
 * has no access to the store, the Goal, or any mutation seam, which is what keeps
 * history from becoming a second interface for changing Goal state — the rendering
 * cannot write, and nothing else reads it back.
 *
 * An empty timeline is rendered as an explicit "no history" line rather than as an
 * empty string, so a caller never has to guess whether the branch was empty or the
 * rendering failed.
 */
export function formatGoalHistory(view: GoalHistoryView): string {
	const lines: string[] = [];
	// An unreadable branch is its own case: it is not an empty timeline, and claiming
	// one would understate what the branch holds. It is a rendering failure only — the
	// authoritative Goal is reconstructed from `goal-state`, which is unaffected.
	if (view.unreadable) {
		lines.push(
			"Goal history could not be read on this branch (the branch itself could not be read). " +
				"This affects only this timeline: the current Goal is reconstructed from its durable snapshots " +
				"and tombstones, which are unaffected.",
		);
		return lines.join("\n");
	}
	if (view.records.length === 0) {
		lines.push("No Goal history on this branch yet.");
	} else {
		lines.push(
			`Goal history on this branch (${view.records.length} record${view.records.length === 1 ? "" : "s"}, ` +
				"non-authoritative — the durable Goal snapshots and tombstones remain the only lifecycle authority):",
		);
		for (const record of view.records) {
			lines.push(formatHistoryLine(record));
			const attachments = formatAttachmentLine(record);
			if (attachments) lines.push(attachments);
		}
	}
	if (view.malformed > 0) {
		lines.push(
			`${view.malformed} history ${view.malformed === 1 ? "entry" : "entries"} on this branch could not be read ` +
				"(malformed data or an unsupported version) and were skipped. This affects only this timeline: the " +
				"current Goal is reconstructed from its durable snapshots and tombstones, which are unaffected.",
		);
	}
	return lines.join("\n");
}
