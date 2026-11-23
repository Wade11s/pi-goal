/**
 * Objective clarification (ADR-0003, issue #84).
 *
 * `/goal <raw idea>` no longer commits a Goal by default: it records a **pending
 * clarification** — the raw idea plus the budget and attachment flags the user
 * typed — as a durable session entry and sends the model an interview
 * instruction. The model interviews the user, drafts the final Objective (English
 * three-section template) and a Goal title, and calls `propose_goal`, which opens
 * the confirmation editor. Saving that editor is the creation authority; nothing
 * was created before it, and a cancel or timeout creates nothing at all.
 *
 * This module is the pure half of that flow: the durable pending-entry shape, its
 * reconstruction from the selected branch, the one-document confirmation format
 * (`Title: <text>`, a blank line, then the Objective body), the model-facing
 * interview text, and the tool guidance. It touches no Pi API and no Goal record,
 * so the rules can be unit-tested directly and the handler in `index.ts` only
 * wires them to the session.
 *
 * A pending clarification is durable state (issue #85): a graceful or unclean
 * restart reconstructs it from the newest `goal-clarification` entry on the
 * branch, so the interview continues and `propose_goal` still works instead of
 * turning the user's draft into a dead end or a direct, unconfirmed creation.
 *
 * The Objective template is a **drafting convention, never a validation rule**:
 * extension validation stays at the Objective's 3–2000 characters, and an
 * Objective without the three sections is still a legitimate Objective.
 */
import { MAX_TITLE_LENGTH, MIN_TITLE_LENGTH } from "./goal.ts";
import { GOAL_MESSAGE_PREFIX, formatDataBlock } from "./goal.ts";
import type { AttachmentRequest } from "./attachments.ts";

/** Custom session-entry channel for a pending Objective clarification. */
export const CLARIFICATION_ENTRY_TYPE = "goal-clarification";

/**
 * What a `/goal <raw idea>` asked for, held until the confirmation editor saves.
 *
 * The attachment requests are held verbatim: a local path is not read and a
 * remote URL is not fetched until the user saves the confirmation, so a cancelled
 * clarification leaves no artifact and makes no network request.
 */
export interface PendingClarification {
	/** The raw idea exactly as typed, after the leading creation options were scanned. */
	idea: string;
	/** The budget flag the user typed, resolved only when the Goal is committed. */
	budget: PendingBudgetRequest;
	/** The attachment flags the user typed, materialized only after the save. */
	attachments: readonly AttachmentRequest[];
	/**
	 * The Goal identity the interview was started against, or `null` when the
	 * session had no Goal at that moment.
	 *
	 * This is the anchor that keeps a stale draft from becoming a Goal. A
	 * confirmation may supersede a **complete** Goal (or create the first one), and
	 * the editor is the creation authority — but only for the Goal slot the user was
	 * looking at. If a Goal with a different identity became current after the
	 * interview started (a direct `/goal`, a `create_goal`, a replacement, or a
	 * clear), the draft is abandoned: reconstruction refuses it rather than letting
	 * a restart turn it into a Goal that overwrites work the user chose in the
	 * meantime.
	 */
	baseGoalId: string | null;
}

/** The budget flag of a pending clarification, mirroring `GoalBudgetRequest`. */
export type PendingBudgetRequest =
	/** No flag given: use the extension default. */
	| { kind: "default" }
	/** `--no-budget`: explicitly unbounded. */
	| { kind: "none" }
	/** `--budget <n>`: an explicit budget. */
	| { kind: "value"; value: number };

/** The user-confirmed document one save attempt produced. */
export interface ConfirmedClarificationDraft {
	/** The title line exactly as saved. */
	title: string;
	/** The Objective body exactly as saved. */
	objective: string;
}

/**
 * Payload persisted in `goal-clarification` custom session entries (version 2).
 *
 * Three states, and the difference matters:
 *
 * - `pending`: the interview is open. Cancelling, closing the editor, or a new
 *   `/goal` may replace it, and nothing has been committed.
 * - `confirming`: the user saved the confirmation editor and the commit it
 *   authorizes is in flight (or failed / was interrupted). The confirmed draft and
 *   the held flags are durable here, so a failed creation or a crash cannot strand
 *   them behind a terminal record. Reopening `propose_goal` prefills that draft.
 * - `ended`: the clarification is over — cancelled, timed out, stale, or committed.
 *   Only this state is terminal.
 *
 * The newest entry wins on the branch. A `confirming` entry whose commit landed
 * before the process could write `ended` is still stale, because the Goal snapshot
 * that landed after it no longer matches the entry's base identity.
 */
export type PendingClarificationEntry =
	| { version: 2; state: "pending"; pending: PendingClarification }
	| { version: 2; state: "confirming"; pending: PendingClarification; draft: ConfirmedClarificationDraft }
	| { version: 2; state: "ended"; pending: null };

/** The entry written when `/goal` starts (or replaces) an interview. */
export function openClarificationEntry(pending: PendingClarification): PendingClarificationEntry {
	return { version: 2, state: "pending", pending };
}

/**
 * The entry written when the confirmation editor is saved, before the commit.
 *
 * It is deliberately not terminal: if the commit fails or the process dies while
 * it runs, this record is what lets the next attempt reopen the user's draft
 * instead of losing it.
 */
export function confirmingClarificationEntry(
	pending: PendingClarification,
	draft: ConfirmedClarificationDraft,
): PendingClarificationEntry {
	return { version: 2, state: "confirming", pending, draft };
}

/** The entry written when the clarification ends: cancelled, timed out, stale, or committed. */
export function endedClarificationEntry(): PendingClarificationEntry {
	return { version: 2, state: "ended", pending: null };
}

/** The few branch-entry fields pending-clarification reconstruction reads. */
export interface ClarificationBranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** Custom session-entry channel of the authoritative Goal snapshot. */
const GOAL_STATE_ENTRY_TYPE = "goal-state";

/**
 * What the selected branch says about an open Objective clarification.
 *
 * `none` covers a branch that never started one and a branch whose newest entry
 * records a durable end. `superseded` is a pending clarification whose Goal slot
 * moved after the interview started (a Goal was created, replaced, or cleared):
 * the draft is abandoned and is never offered again, because committing it would
 * now act on a Goal the user chose after the interview. `malformed` is the
 * fail-closed result: the newest entry could not be trusted, so no clarification
 * is offered rather than falling back to an older one that the session may
 * already have finished.
 */
export type PendingClarificationRead =
	| { kind: "none" }
	| { kind: "pending"; pending: PendingClarification; confirmed: ConfirmedClarificationDraft | null }
	| { kind: "superseded" }
	| { kind: "malformed" };

/**
 * Reconstruct the pending clarification from the selected session branch.
 *
 * The newest `goal-clarification` entry wins, exactly like the Goal snapshot rule:
 * an `ended` entry means the clarification is over on that branch, and an
 * abandoned branch's entry cannot leak into the selected one. There is no
 * fallback — a malformed newest entry fails closed — because resurrecting an
 * interview the session already ended would re-open a dead confirmation while a
 * corrupt line decided it.
 *
 * **Base identity.** A pending or confirming entry is offered only while the Goal
 * slot it was started against is still the one on the branch: every current
 * `goal-state` entry after the clarification entry must carry the entry's
 * `baseGoalId` (or a tombstone, when the base was `null`). This is what keeps a
 * crash between a Goal commit and the terminal write, a `create_goal` issued
 * during an interview, or a later replacement/clear from resurrecting a draft
 * that would overwrite the Goal the user actually chose. A transition of the
 * *same* Goal (an edit, a pause, …) keeps the identity and does not invalidate the
 * draft. A `superseded` historical snapshot never becomes current, so it is
 * ignored; an unreadable snapshot after the entry fails closed like any other
 * conflicting identity.
 *
 * Only the *shape* is trusted here. Local paths and remote URLs were validated
 * when `/goal` ran and are validated again by materialization at the confirming
 * save, so reconstruction never reads a file, resolves a URL, or fetches
 * anything: the whole zero-side-effect contract depends on that.
 */
export function readPendingClarification(branch: readonly ClarificationBranchEntry[]): PendingClarificationRead {
	let newestIndex = -1;
	let newest: unknown;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== CLARIFICATION_ENTRY_TYPE) continue;
		newestIndex = index;
		newest = entry.data;
	}
	if (newestIndex === -1) return { kind: "none" };
	const parsed = parsePendingClarificationEntry(newest);
	if (parsed === undefined) return { kind: "malformed" };
	if (parsed === null) return { kind: "none" };
	if (goalIdentityChangedAfter(branch, newestIndex, parsed.pending.baseGoalId)) return { kind: "superseded" };
	return { kind: "pending", pending: parsed.pending, confirmed: parsed.confirmed };
}

/**
 * Whether a current Goal identity other than `baseGoalId` became authoritative
 * after the clarification entry.
 *
 * Only `goal-state` entries matter. A snapshot marked `superseded` is a finalized
 * historical record and never becomes current, so it is skipped. A tombstone
 * (`goal: null`) is a real identity — "no Goal" — and it matches only a `null`
 * base. A `goal-state` entry that cannot be read is treated as a conflicting
 * identity: the safe direction is not to offer a draft over a branch whose Goal
 * state cannot be verified.
 */
function goalIdentityChangedAfter(
	branch: readonly ClarificationBranchEntry[],
	clarificationIndex: number,
	baseGoalId: string | null,
): boolean {
	for (let index = clarificationIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY_TYPE) continue;
		if (isSupersededSnapshot(entry.data)) continue;
		const identity = branchGoalIdentity(entry.data);
		if (identity === undefined) return true;
		if (identity !== baseGoalId) return true;
	}
	return false;
}

/** Whether a `goal-state` payload is a finalized historical record of a replaced identity. */
function isSupersededSnapshot(data: unknown): boolean {
	return typeof data === "object" && data !== null && (data as Record<string, unknown>).superseded === true;
}

/**
 * The Goal identity one `goal-state` payload would make current: a Goal id, or
 * `null` for a tombstone. `undefined` means "not a readable current snapshot",
 * which the caller treats as a conflict.
 */
function branchGoalIdentity(data: unknown): string | null | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const snapshot = data as Record<string, unknown>;
	if (snapshot.version !== 1) return undefined;
	if (snapshot.goal === null) return null;
	if (typeof snapshot.goal !== "object" || snapshot.goal === null) return undefined;
	const id = (snapshot.goal as Record<string, unknown>).id;
	return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Parse one durable entry payload: the open/confirming clarification, its end
 * (`null`), or `undefined` for a payload that cannot be trusted.
 *
 * Unknown version, missing fields, or a wrong-typed flag are all untrustworthy.
 * Unknown extra fields are ignored, so a future additive version-2 field does not
 * invalidate an otherwise readable entry. The attachment list keeps its order
 * and its entries verbatim: materialization owns the limits and the source
 * validation, and this module must not silently drop a flag the user typed. A
 * malformed confirmed draft is dropped rather than failing the whole entry: the
 * interview underneath it is still valid, and the draft is only prefill text.
 */
function parsePendingClarificationEntry(
	data: unknown,
): { pending: PendingClarification; confirmed: ConfirmedClarificationDraft | null } | null | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const entry = data as Record<string, unknown>;
	if (entry.version !== 2) return undefined;
	if (entry.state === "ended") {
		return entry.pending === null ? null : undefined;
	}
	if (entry.state !== "pending" && entry.state !== "confirming") return undefined;
	if (typeof entry.pending !== "object" || entry.pending === null) return undefined;
	const pending = entry.pending as Record<string, unknown>;
	if (typeof pending.idea !== "string" || pending.idea.trim() === "") return undefined;
	if (pending.baseGoalId !== null && typeof pending.baseGoalId !== "string") return undefined;
	const budget = parsePendingBudget(pending.budget);
	if (budget === undefined) return undefined;
	if (!Array.isArray(pending.attachments)) return undefined;
	const attachments: AttachmentRequest[] = [];
	for (const item of pending.attachments) {
		const request = parseAttachmentRequest(item);
		if (request === undefined) return undefined;
		attachments.push(request);
	}
	const confirmed = entry.state === "confirming" ? parseConfirmedDraft(entry.draft) : null;
	return {
		pending: {
			idea: pending.idea,
			budget,
			attachments,
			baseGoalId: pending.baseGoalId === null ? null : (pending.baseGoalId as string),
		},
		confirmed,
	};
}

/** One held budget flag, or `undefined` when the payload is not a known shape. */
function parsePendingBudget(value: unknown): PendingBudgetRequest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const budget = value as Record<string, unknown>;
	if (budget.kind === "default") return { kind: "default" };
	if (budget.kind === "none") return { kind: "none" };
	if (typeof budget.value === "number" && Number.isInteger(budget.value) && budget.value > 0) {
		return budget.kind === "value" ? { kind: "value", value: budget.value } : undefined;
	}
	return undefined;
}

/** One held attachment flag, or `undefined` when the payload is not a known shape. */
function parseAttachmentRequest(value: unknown): AttachmentRequest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const request = value as Record<string, unknown>;
	if (request.kind === "text" || request.kind === "image") {
		return typeof request.path === "string" && request.path !== ""
			? { kind: request.kind, path: request.path }
			: undefined;
	}
	if (request.kind === "remote-image") {
		return typeof request.url === "string" && request.url !== ""
			? { kind: "remote-image", url: request.url }
			: undefined;
	}
	return undefined;
}

/** A saved confirmation document, or `null` when the stored draft is not usable as a prefill. */
function parseConfirmedDraft(data: unknown): ConfirmedClarificationDraft | null {
	if (typeof data !== "object" || data === null) return null;
	const draft = data as Record<string, unknown>;
	if (typeof draft.title !== "string" || typeof draft.objective !== "string") return null;
	return { title: draft.title, objective: draft.objective };
}

/**
 * The held flags of a pending clarification, spelled as the user typed them.
 *
 * Used by the user-facing surfaces that describe an open clarification: the
 * restore notice after a restart and the bare `/goal` status report. Repeated
 * attachment flags are collapsed into a count so the line stays readable.
 */
export function heldClarificationFlags(pending: PendingClarification): string[] {
	const flags: string[] = [];
	if (pending.budget.kind === "value") flags.push(`--budget ${pending.budget.value}`);
	else if (pending.budget.kind === "none") flags.push("--no-budget");
	const attachmentFlags = new Map<string, number>();
	for (const attachment of pending.attachments) {
		const flag =
			attachment.kind === "text" ? "--file" : attachment.kind === "image" ? "--image" : "--remote-image";
		attachmentFlags.set(flag, (attachmentFlags.get(flag) ?? 0) + 1);
	}
	for (const [flag, count] of attachmentFlags) flags.push(count === 1 ? flag : `${flag} x${count}`);
	return flags;
}

/**
 * How a pending clarification is described by the user-facing surfaces.
 *
 * `confirmed` means the durable record is a saved, uncommitted confirmation: the
 * user's edited draft is kept and the editor reopens with it, which is exactly
 * what a failed or interrupted creation needs to say.
 */
export interface PendingClarificationDescription {
	confirmed?: boolean;
}

/** One sentence for an interrupted save whose confirmed draft is still held. */
function confirmedDraftDetail(description: PendingClarificationDescription | undefined): string {
	return description?.confirmed === true
		? " A saved confirmation draft is kept from an interrupted or failed creation; the editor reopens with it."
		: "";
}

/** The held-flag sentence appended to the restored notice and the status report. */
function heldFlagsDetail(pending: PendingClarification, verb: "unchanged" | "holding"): string {
	const held = heldClarificationFlags(pending);
	if (held.length === 0) return "";
	return verb === "unchanged"
		? ` Its held flags (${held.join(", ")}) are unchanged: nothing has been read, materialized, or fetched.`
		: ` It is holding ${held.join(", ")}; nothing is read, materialized, or fetched until the confirmation is saved.`;
}

/**
 * The notice a restart prints when it reconstructed an open clarification.
 *
 * The user has to know that no Goal exists yet (a crash did not silently create
 * one), that the interview can still end in a committed Goal, and how to abandon
 * it. The held flags are named because they survived the restart unread.
 */
export function formatPendingClarificationRestoredNotice(
	pending: PendingClarification,
	description: PendingClarificationDescription = {},
): string {
	return (
		"Objective clarification restored: no new Goal is committed yet. The interview is still open, so answer the " +
		"model's questions and save the confirmation editor to create the Goal, or run /goal <new idea> to start over." +
		heldFlagsDetail(pending, "unchanged") +
		confirmedDraftDetail(description)
	);
}

/**
 * The notice a restart prints when the newest pending entry cannot be trusted.
 *
 * Fail closed, exactly like Goal reconstruction: no clarification is offered, and
 * the user is told why `propose_goal` will refuse and what to type to recover.
 */
export function formatPendingClarificationMalformedNotice(): string {
	return (
		"pi-goal could not read the newest pending Objective clarification on this branch (malformed data or an " +
		"unsupported version), so no clarification is in progress and propose_goal will refuse. Run /goal <objective> " +
		"to start over."
	);
}

/**
 * The bare-`/goal` status suffix that describes an open clarification with no
 * Goal. It replaces no Goal report: it is appended only when no Goal is set.
 */
export function formatOpenClarificationStatus(
	pending: PendingClarification,
	description: PendingClarificationDescription = {},
): string {
	return (
		"An Objective clarification is open: no new Goal is committed yet. Answer the model's questions and save the " +
		"confirmation editor to create it, or run /goal <new idea> to start over." +
		heldFlagsDetail(pending, "holding") +
		confirmedDraftDetail(description)
	);
}

/** The confirmation editor's dialog title. */
export const CLARIFICATION_EDITOR_TITLE = "Confirm the new Goal";

/** The first line's literal prefix; the rest of that line is the Goal title. */
export const CLARIFICATION_TITLE_PREFIX = "Title:";

/**
 * Compose the one confirmation document: `Title: <text>`, a blank line, then the
 * Objective body. Both parts are user-editable; on save the first line is parsed
 * as the title and everything after it as the Objective.
 */
export function formatClarificationDocument(title: string, objective: string): string {
	return `${CLARIFICATION_TITLE_PREFIX} ${title}\n\n${objective}`;
}

/** What the confirmation document parsed into, or why its title structure is invalid. */
export type ClarificationDocumentParse =
	| { ok: true; title: string; objective: string }
	| { ok: false; error: string };

/**
 * Parse the confirmation document the user saved.
 *
 * Only the *structure* is checked here: the first line must be the `Title:` line,
 * and everything after it is the Objective body (the separator blank line is
 * convenience, not syntax — removing it still yields the same objective). The
 * extracted title is intentionally returned unvalidated, so the caller applies
 * the one title rule that `/goal:edit --title` applies, with creation wording.
 * An invalid structure is refused with the document reopened for correction, so
 * the user can fix the line instead of losing the Objective they wrote.
 */
export function parseClarificationDocument(text: string): ClarificationDocumentParse {
	// CRLF is a transport artifact, not a line break the user typed: normalize it
	// before the first-line split so a Windows host is not told its title has a
	// line break in it. Leading blank lines are tolerated the same way.
	const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+/, "");
	const newline = normalized.indexOf("\n");
	const firstLine = (newline === -1 ? normalized : normalized.slice(0, newline)).trim();
	if (!firstLine.startsWith(CLARIFICATION_TITLE_PREFIX)) {
		return {
			ok: false,
			error:
				`Goal not created: the confirmation's first line must be \`${CLARIFICATION_TITLE_PREFIX} <title>\`, ` +
				"with the Goal title after the prefix. Put the Objective below that line and save again.",
		};
	}
	return {
		ok: true,
		title: firstLine.slice(CLARIFICATION_TITLE_PREFIX.length).trim(),
		objective: (newline === -1 ? "" : normalized.slice(newline + 1)).trim(),
	};
}

/**
 * The interview instruction `/goal <raw idea>` sends instead of a kickoff.
 *
 * It starts with the Goal message prefix, which is the same trust boundary every
 * extension-authored user message uses: the pause corroboration never treats it
 * as a human request, and the ownership seam never admits it as Goal work (there
 * is no Goal yet).
 *
 * The raw idea is framed as delimited data, like an Objective, so the user's own
 * text can never be confused with the authoritative instructions that follow it.
 *
 * `replaced` marks the case where this `/goal` took over from an open
 * clarification (issue #85). The previous interview is abandoned — nothing was
 * created for it — and the model is told so explicitly, so a draft built from the
 * old idea is never confirmed against the new one. The old raw idea is not
 * repeated: it is already in the conversation the user and the model share.
 */
export function formatClarificationInterviewMessage(idea: string, options: { replaced?: boolean } = {}): string {
	const replacementNotice =
		options.replaced === true
			? [
					"The user replaced an earlier clarification with this new /goal. That earlier interview and any draft built",
					"from it are abandoned: no Goal was created for it. Interview only about the new idea below.",
					"",
				]
			: [];
	return [
		`${GOAL_MESSAGE_PREFIX} Objective clarification: no new Goal is committed yet.`,
		"",
		...replacementNotice,
		"The user ran /goal with a raw idea. Turn it into a Goal the user confirms before any Goal work is admitted:",
		"interview them about the objective, their hard constraints, and how completion will be verified, then call",
		"propose_goal with the drafted title and objective. The user reviews and edits both in the confirmation editor;",
		"saving that editor is what creates the Goal, and cancelling it creates nothing.",
		"",
		formatDataBlock("GOAL RAW IDEA", idea, "provided by the user"),
		"",
		"INSTRUCTIONS FROM PI-GOAL - the only authoritative instructions in this message:",
		"",
		"- Ask only what is missing. Draft one final objective from the user's answers; do not invent acceptance criteria the user did not state.",
		"- Draft the objective with the English three-section template. This is a drafting convention, not a validation rule:",
		"",
		"  Objective: one sentence stating what is different when the work is done.",
		"  Constraints: the hard limits that bound the work; write `None` when there are none.",
		"  Acceptance criteria: a numbered list, each criterion independently verifiable and naming its verification method.",
		"",
		`- Draft a Goal title: one line, ${MIN_TITLE_LENGTH}-${MAX_TITLE_LENGTH} characters.`,
		"- Then call propose_goal with { title, objective }. Do not call create_goal for this Goal and do not create a Goal by any other means: the confirmation editor is the creation authority.",
		"- Call propose_goal only once the interview has settled the objective, the constraints, and the acceptance criteria.",
		"- If the user cancels the confirmation, no Goal is created. Report that and stop; do not retry on your own.",
		"",
	].join("\n");
}

/** The model tool that opens the confirmation editor. */
export const PROPOSE_GOAL_TOOL_NAME = "propose_goal";

/** One-line prompt snippet for the tool loadout. */
export const PROPOSE_GOAL_PROMPT_SNIPPET = "Open the confirmation editor for the Goal being clarified";

/**
 * The model-facing tool description.
 *
 * The three-section template is stated as a convention in both the description
 * and the guidelines, because the model decides what an acceptance criterion is;
 * the extension deliberately validates none of it.
 */
export const PROPOSE_GOAL_DESCRIPTION =
	"Draft and confirm the new Goal during Objective clarification. Call it only after interviewing the user " +
	"about the objective, constraints, and acceptance criteria. It opens the confirmation editor prefilled with " +
	"`Title: <title>`, a blank line, and the Objective; saving that editor is what creates the Goal, with exactly " +
	"the user-edited text, so the title and objective you pass here are a draft the user may change. Cancelling " +
	"or timing out creates nothing: no Goal, no attachments, no fetches. It is refused when no Objective " +
	"clarification is in progress.";

/** Prompt guidelines carrying the drafting template as a convention, never a rule. */
export const PROPOSE_GOAL_PROMPT_GUIDELINES: readonly string[] = [
	"Call propose_goal only during an Objective clarification started by /goal. It is refused when no clarification is in progress.",
	"Interview first, then draft: ask about the objective, the hard constraints, and how completion will be verified, and draft only from what the user said.",
	"Draft the objective with the English three-section template as a drafting convention (not a validation rule): `Objective:` one sentence stating what is different when the work is done; `Constraints:` the hard limits, or `None`; `Acceptance criteria:` a numbered list where each criterion is independently verifiable and names its verification method.",
	`Draft a Goal title: one line, ${MIN_TITLE_LENGTH}-${MAX_TITLE_LENGTH} characters, recognizable at a glance.`,
	"Saving the confirmation editor creates the Goal; the user's edited title and objective are the authority, and a cancellation creates nothing. Never use create_goal for the Goal being clarified.",
];
