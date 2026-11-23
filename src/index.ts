/**
 * pi-goal — Codex-style persistent Goals for Pi.
 *
 * Registers the Goal command family (`/goal`, `/goal:pause`, `/goal:resume`,
 * `/goal:clear`, `/goal:history`, `/goal:edit`), the get_goal / create_goal /
 * update_goal model tools, and the automatic-continuation seam. A Goal is a durable,
 * session-scoped record persisted as custom session entries and reconstructed
 * from the selected branch on session start (restart, resume, reload, and
 * fork/clone, which copy the branch into a new session) and after tree
 * navigation, so the selected session branch alone determines the active
 * objective: snapshots on abandoned branches cannot leak into it, a cleared
 * Goal stays cleared on the branch that cleared it, and model transitions are
 * bound to the Goal identity and revision they were prepared against.
 *
 * Creating a Goal sends the objective into model context as a user message and
 * starts initial work. While a Goal is active, work continues at Pi's safe
 * settlement boundary (`agent_before_settle`), never from a timer or an
 * `agent_end` self-loop, so Pi keeps owning retries, compaction recovery, and
 * queued follow-ups. The model ends the loop by calling update_goal; a
 * complete, paused, cleared, or absent Goal never continues.
 *
 * The full lifecycle is user-controlled. `/goal:edit <objective>` changes the
 * objective in place (same identity, same history) and steers an active run;
 * `/goal:pause` stops admission of further automatic runs immediately;
 * `/goal:resume` restarts eligible work; `/goal:clear` writes a durable
 * tombstone and returns the session to ordinary prompt behavior. `/goal <objective>`
 * never replaces an unfinished Goal: it refuses and names `/goal:clear`, while a
 * complete Goal is superseded without a dialog. None of these commands wait for
 * an active run to become idle — an active Goal's own continuation loop would
 * otherwise starve them — so every
 * transition is persisted first (Pi's appendEntry writes through
 * synchronously) and only then announced, and work-start messages are delivered
 * through Pi's steering when a run is in flight.
 *
 * The model's authority stays bounded: update_goal can complete a Goal, can report a
 * blocker (three consecutive Goal turns reporting the same genuine blocker move it to
 * `blocked`), and can pause one only after an explicit user request that the call must
 * quote verbatim (the quote is corroborated against recent human-authored user
 * messages). Resuming, clearing, and replacing are user-owned.
 *
 * Stopping is conservative and mostly independent of the model
 * (`./safety.ts`): repeated activity-free automatic Goal turns, repeated turns
 * in which commands could not be executed at all, and terminal provider
 * failures all stop automatic continuation deterministically, and a provider
 * usage limit moves the Goal to `usage_limited`. The model can end the loop
 * itself by completing the Goal, or by reporting the same genuine blocker for
 * three consecutive Goal turns. User actions reset every anti-loop counter.
 *
 * `goal.enabled` (Pi settings, default true) is an admission control rather than
 * a lifecycle state: while it is false the extension admits no *new* Goal work —
 * no creation or replacement, no `create_goal`, no work-admitting objective edit,
 * no resume, and no automatic continuation or budget wrap-up at the settlement
 * seam — while inspection, pause, clear, and terminal updates from work already
 * in flight keep working. It never rewrites a Lifecycle status and never stops
 * Active elapsed time, so an active-but-disabled Goal is surfaced as exactly
 * that instead of being mistaken for a continuing one.
 *
 * `goal.sessionNameFromObjective` (Pi settings, default false) is a separate opt-in
 * convenience: after a successful *fresh* creation it may name an otherwise unnamed
 * session from the Goal title or the Objective's first line. A session name is host
 * metadata Pi already owns, not Goal state, so it never participates in the
 * Lifecycle, in accounting, or in the event stream, and it never overwrites a name
 * the user provided.
 *
 * `goal.clarifyOnCreate` (Pi settings, default true) makes `/goal <raw idea>` start
 * an **Objective clarification** (ADR-0003, see `./clarification.ts`) instead of
 * committing a Goal: the extension records a durable pending clarification — the raw
 * idea plus the budget and attachment flags — and sends the model an interview
 * instruction. The model's `propose_goal` call opens one confirmation document
 * (`Title: <text>`, a blank line, then the Objective), and saving it is the creation
 * authority: the user-edited title and Objective commit through this same
 * command-origin path, and held attachments materialize only then. Cancelling or
 * timing out creates nothing at all. `false` restores direct creation; a UI-less
 * host always creates directly, with a notice; `goal.enabled: false` still refuses
 * before any clarification starts.
 *
 * `goal.planTool` (Pi settings, default false) is another opt-in, and the other one that
 * changes what is *registered*: while it is true the extension registers an
 * `update_plan` model tool for a Goal's ordered progress steps. Its record is the tool
 * result's persisted `details` — Pi's ordinary session-branch tool result — so it is
 * durable without a second Goal record, and it never mutates a Lifecycle status or
 * satisfies the Completion audit (see `./plan.ts`).
 * Every committed transition is also appended to the session branch as a
 * `goal-history` entry and rendered read-only by `/goal:history` (see `history.ts`
 * and `docs/behavior/history.md`). That timeline is derived diagnostic data, not
 * a second lifecycle source of truth: it is written from the same
 * committed-transition seam as the local event stream and projected from that
 * stream's payload, nothing reconstructs from it, and no command or tool mutates
 * a Goal from a record.
 *
 * Usage is accounted durably from finalized Pi messages and reported nested
 * usage, with stable deduplication (see `accounting.ts`). A Goal with a token
 * budget transitions to `budget_limited` when its accounted usage reaches the
 * budget, receives exactly one bounded wrap-up, and then stops continuing —
 * budget exhaustion is never completion.
 */
import type {
	AgentActivityOutcome,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BLOCKED_AUDIT_THRESHOLD,
	CUSTOM_MESSAGE_TYPE,
	CUSTOM_WRAPUP_MESSAGE_TYPE,
	buildCompletionReport,
	corroborateGoalCreationRequest,
	corroboratePauseRequest,
	formatBudgetWrapUpMessage,
	formatContinuationMessage,
	formatEditMessage,
	formatGoalStatusLine,
	formatGoalSummary,
	formatKickoffMessage,
	formatNoGoal,
	formatResumeMessage,
	getGoalOutputSchema,
	goalWorkGoalId,
	MAX_BLOCKER_LENGTH,
	MAX_OBJECTIVE_LENGTH,
	MAX_TITLE_LENGTH,
	messageText,
	MIN_BLOCKER_LENGTH,
	MIN_OBJECTIVE_LENGTH,
	MIN_TITLE_LENGTH,
	MIN_USER_REQUEST_LENGTH,
	type GoalBinding,
	type GoalCreationCorroboration,
	type GoalPublicState,
	type GoalRecord,
	type GoalStatus,
	previewObjective,
	toPublicState,
	updateGoalOutputSchema,
} from "./goal.ts";
import {
	GoalStore,
	validateBlocker,
	validateGoalTitle,
	validateObjective,
	type GoalEditChanges,
	type GoalMutationFailure,
} from "./store.ts";
import { GOAL_UPDATED_EVENT, toGoalUpdatedEvent, type GoalUpdatedEvent } from "./events.ts";
import { GOAL_METRICS_CHANNEL, createGoalMetricsPublisher } from "./metrics.ts";
import { formatGoalHistory, HISTORY_ENTRY_TYPE, toGoalHistoryRecord } from "./history.ts";
import {
	GOAL_COMMAND_BRIDGE,
	GOAL_COMMAND_BRIDGE_VERSION,
	classifyGoalBridgeOutcome,
	committedKindsFor,
	commandContextForBridge,
	GOAL_COMMAND_NAMES,
	goalBridgeActionFor,
	goalBridgeRefusal,
	goalBridgeUnregisteredCommand,
	parseGoalCommandBridgeRequest,
	recordingCommandContext,
	type GoalBridgeAction,
	type GoalBridgeDiagnostic,
	type GoalBridgeTransition,
	type GoalCommandBridgeRequest,
	type GoalCommandBridgeResult,
	type GoalCommandName,
} from "./command-bridge.ts";
import {
	attachmentStoreRoot,
	discardUncommittedArtifacts,
	loadAttachments,
	materializeAttachmentRequests,
	validateAttachmentPath,
	verifyAttachments,
	type AttachmentRequest,
} from "./attachments.ts";
import { validateRemoteImageUrl, type RemoteImageFetchOptions } from "./remote-image.ts";
import type { AttachmentContent, GoalMessageContent } from "./goal.ts";
import {
	applySessionNameFromGoal,
	parseSessionNamingSettings,
	sessionNameSurface,
	type SessionNamingSettings,
} from "./session-naming.ts";
import {
	PLAN_TOOL_NAME,
	PLAN_TOOL_PROMPT_GUIDELINES,
	PLAN_TOOL_PROMPT_SNIPPET,
	formatPlanDisabledMessage,
	formatPlanMessage,
	formatPlanNoGoalMessage,
	parsePlanToolSettings,
	planOutputSchema,
	planParametersSchema,
	validatePlanArgument,
	type PlanRecord,
	type PlanToolArguments,
	type PlanToolSettings,
} from "./plan.ts";
import {
	ACCOUNTING_CHECKPOINT_MS,
	MIN_TOKEN_BUDGET,
	type AdmissionSettings,
	type BudgetSettings,
	type ClarifyOnCreateSettings,
	type ResumePromptSettings,
	parseAdmissionSettings,
	parseBudgetSettings,
	parseClarifyOnCreateSettings,
	parseResumePromptSettings,
	resolveGoalTokenBudget,
} from "./accounting.ts";
import {
	classifyProviderFailure,
	GoalSafetyMonitor,
	type GoalRunKind,
	type ProviderFailureEvidence,
	type SafetyStop,
} from "./safety.ts";
import {
	CLARIFICATION_EDITOR_TITLE,
	CLARIFICATION_ENTRY_TYPE,
	PROPOSE_GOAL_DESCRIPTION,
	PROPOSE_GOAL_PROMPT_GUIDELINES,
	PROPOSE_GOAL_PROMPT_SNIPPET,
	PROPOSE_GOAL_TOOL_NAME,
	confirmingClarificationEntry,
	endedClarificationEntry,
	formatClarificationDocument,
	formatClarificationInterviewMessage,
	formatOpenClarificationStatus,
	formatPendingClarificationMalformedNotice,
	formatPendingClarificationRestoredNotice,
	openClarificationEntry,
	parseClarificationDocument,
	readPendingClarification,
	type ConfirmedClarificationDraft,
	type PendingClarification,
} from "./clarification.ts";

/**
 * Auto-cancel an interactive objective edit after this long.
 *
 * Pi's `editor` dialog has no timeout option of its own, so a host that never
 * answers the editor request would otherwise leave the command waiting
 * forever. The timeout is a safety bound only: the dialog itself stays open on
 * the host, and answering it later is harmless because the command has already
 * reported the cancellation.
 */
const EDIT_TIMEOUT_MS = 120_000;

/**
 * Auto-decline the opt-in paused-Goal resume prompt after this long.
 *
 * The dialog's default answer is "No", so a user who is away, a host that never
 * answers, and an RPC client that ignores the request all leave the paused Goal
 * exactly as it was. The prompt is a convenience over the explicit, durable
 * `/goal:resume` transition, so letting it lapse is always safe.
 */
const RESUME_PROMPT_TIMEOUT_MS = 120_000;

/**
 * Bound one extension dialog, with an override for deterministic tests.
 *
 * Every interactive dialog pi-goal shows has a safe default answer, so it is
 * always created with a `timeout` and Pi resolves the default when nobody
 * answers. `PI_GOAL_DIALOG_TIMEOUT_MS` shortens those bounds so the timeout
 * branches can be exercised through the real-Pi RPC harness without waiting the
 * production interval out; an unset or invalid value leaves the defaults
 * untouched.
 */
function dialogTimeoutMs(defaultMs: number): number {
	const raw = process.env.PI_GOAL_DIALOG_TIMEOUT_MS;
	if (raw === undefined || raw.trim() === "") return defaultMs;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : defaultMs;
}

/**
 * Parsed `/goal` arguments: the objective, an optional budget request, and the
 * explicit local attachment requests (issue #49).
 *
 * Budget and attachment flags are only recognized as a *leading* prefix
 * (`/goal --budget 5000 --file spec.md <objective>`), so an objective that
 * merely contains the word `--file` is never silently truncated. `--no-budget`
 * creates an unbounded Goal even when an extension default is configured, which
 * is why it is a distinct request kind rather than "no request".
 *
 * `--file <path>`, `--image <path>`, and `--remote-image <url>` are repeatable
 * leading options for local text files, local images, and explicit remote image
 * URLs. Plain arguments remain text: an objective that never starts with a flag
 * is exactly what it always was, and composer drafts are never inferred from it.
 * Remote URLs are accepted only here, through the direct user command; the
 * `create_goal` model tool stays text-only.
 */
export type GoalBudgetRequest =
	/** No flag given: use the extension default. */
	| { kind: "default" }
	/** `--no-budget`: explicitly unbounded. */
	| { kind: "none" }
	/** `--budget <n>`: an explicit budget. */
	| { kind: "value"; value: number };

/** Parse problems that must refuse the command rather than guess an objective. */
export interface ParsedGoalArgs {
	objective: string;
	budget: GoalBudgetRequest;
	/** Explicit local attachment requests, in the order the user named them. */
	attachments: AttachmentRequest[];
	/** Flag errors that must refuse creation before materialization. */
	problems: string[];
}

/**
 * The creation options `/goal` accepts, as flag names without the leading `--`.
 *
 * One vocabulary for three readers: the option scanner below, the `/goal `
 * argument completion, and the `/goal:edit` attachment refusal (which names only
 * the attachment subset). A new option is added here once, not in three regexes.
 */
const GOAL_CREATION_FLAG_NAMES = ["budget", "no-budget", "file", "image", "remote-image"] as const;
const GOAL_CREATION_FLAGS = GOAL_CREATION_FLAG_NAMES.map((name) => `--${name}`);
const GOAL_ATTACHMENT_FLAG_NAMES = GOAL_CREATION_FLAG_NAMES.filter((name) => name !== "budget" && name !== "no-budget");
const GOAL_OPTION_SCANNER = new RegExp(`^--(${GOAL_CREATION_FLAG_NAMES.join("|")})(?:=(\\S+))?(?:\\s+|$)`);
const GOAL_ATTACHMENT_OPTION_SCANNER = new RegExp(`^--(${GOAL_ATTACHMENT_FLAG_NAMES.join("|")})(?:=|\\s|$)`);

/**
 * Parsed `/goal:resume` request.
 *
 * The budget option is the only way to resume a `budget_limited` Goal, and only
 * the two explicit spellings are recognized. It is also the only argument the
 * command accepts: a verb command never reads its argument as an Objective.
 */
export type ResumeBudgetRequest =
	| { kind: "none" }
	| { kind: "value"; value: number };

const RESUME_BUDGET_GUIDANCE =
	"Goal not resumed: /goal:resume takes no argument except --budget <new-total> (or --budget=<new-total>), " +
	"which raises a budget_limited Goal's cumulative token ceiling.";

/**
 * Parse the argument of `/goal:resume --budget <new-total>`.
 *
 * Strict on purpose: exactly one flag, one value, no trailing argument. Anything
 * else — a missing flag, a stray word, a second flag — is refused with the
 * command's usage rather than being silently ignored.
 */
function parseResumeBudget(raw: string): ResumeBudgetRequest | { error: string } {
	const text = raw.trim();
	const match = /^--budget(?:=(\S+))?(?:\s+|$)/.exec(text);
	if (!match) return { error: RESUME_BUDGET_GUIDANCE };
	const inline = match[1];
	let valueText: string;
	let consumed = match[0].length;
	if (inline !== undefined) {
		valueText = inline;
	} else {
		const rest = text.slice(consumed);
		const value = /^(\S+)/.exec(rest);
		if (!value) {
			return {
				error:
					"Goal not resumed: /goal:resume --budget needs a new total, for example " +
					"/goal:resume --budget 150.",
			};
		}
		valueText = value[1]!;
		consumed += value[0].length;
	}
	const trailing = text.slice(consumed).trim();
	if (trailing !== "") {
		return {
			error:
				`Goal not resumed: unexpected argument ${JSON.stringify(trailing)} after --budget ${valueText}. ` +
				"Use /goal:resume --budget <new-total>.",
		};
	}
	const value = Number(valueText);
	if (!Number.isFinite(value)) {
		return {
			error:
				`Goal not resumed: ${JSON.stringify(valueText)} is not a number. Use ` +
				"/goal:resume --budget <new-total>.",
		};
	}
	return { kind: "value", value };
}

/**
 * Guidance for an edit that tries to change attachments.
 *
 * Extracted so the typed form, the interactive form, and the `/goal:edit` argument
 * parser all refuse with the same words.
 */
const EDIT_ATTACHMENT_GUIDANCE =
	"Goal not edited: /goal:edit changes only the objective and title and keeps the Goal's immutable " +
	"attachment manifest. Changing attachments requires a Replacement Goal: /goal --file <path> --image <path> " +
	"--remote-image <https URL> ... <objective> (run /goal:clear first when the current Goal is unfinished; a complete goal does not block).";

/** Where a parsed `/goal:edit` title option ends and the objective begins. */
interface GoalEditTitleOption {
	/** The raw title text, before validation (empty when the option had no value). */
	value: string;
	/** The remaining text, which is the objective (empty when there is none). */
	rest: string;
}

/**
 * Read a leading `--title <text>` / `--title=<text>` option from a `/goal:edit` argument.
 *
 * Only a *leading* option is recognized, exactly like `/goal`'s creation flags: an
 * objective that merely contains the word `--title` is never truncated into a
 * title. The value is either an unquoted token or one quoted string (`"..."` or
 * `'...'`, with `\\` and matching-quote escapes), which is what lets a title contain
 * spaces without turning the rest of the argument into it. `--titlex` is not this
 * option; it is ordinary objective text.
 */
function readGoalEditTitleOption(
	text: string,
): { kind: "none" } | { kind: "option"; option: GoalEditTitleOption } | { kind: "error"; message: string } {
	if (!text.startsWith("--title")) return { kind: "none" };
	const afterFlag = text.slice("--title".length);
	// `--titlex` (or `--title-text`) is not the option: its next character is not a
	// separator, so the whole argument is the objective.
	if (afterFlag !== "" && !/^[=\s]/.test(afterFlag)) return { kind: "none" };
	let rest = afterFlag.startsWith("=") ? afterFlag.slice(1) : afterFlag;
	const leading = /^\s*/.exec(rest)![0];
	rest = rest.slice(leading.length);
	if (rest === "") {
		return {
			kind: "error",
			message:
				'Goal not edited: --title needs a title, for example /goal:edit --title "Ship the release notes".',
		};
	}
	const quote = rest[0];
	if (quote === '"' || quote === "'") {
		let index = 1;
		let value = "";
		let closed = false;
		while (index < rest.length) {
			const char = rest[index]!;
			if (char === "\\" && (rest[index + 1] === quote || rest[index + 1] === "\\")) {
				value += rest[index + 1];
				index += 2;
				continue;
			}
			if (char === quote) {
				closed = true;
				index += 1;
				break;
			}
			value += char;
			index += 1;
		}
		if (!closed) {
			return {
				kind: "error",
				message: "Goal not edited: the title's opening quote is not closed. Use /goal:edit --title \"<text>\".",
			};
		}
		if (index < rest.length && !/\s/.test(rest[index]!)) {
			return {
				kind: "error",
				message: "Goal not edited: put a space between the quoted title and the objective.",
			};
		}
		return { kind: "option", option: { value, rest: rest.slice(index).trim() } };
	}
	const token = /^(\S+)/.exec(rest);
	if (!token) {
		return {
			kind: "error",
			message:
				'Goal not edited: --title needs a title, for example /goal:edit --title "Ship the release notes".',
		};
	}
	return { kind: "option", option: { value: token[1]!, rest: rest.slice(token[0].length).trim() } };
}

/**
 * Parsed `/goal:edit` request.
 *
 * `editor` is the bare command (the prefilled objective editor); `edit` carries
 * the title and/or objective exactly as typed, for the one validation point in
 * `editGoal`; `refused` is a usage error that touches no Goal.
 */
type ParsedGoalEdit =
	| { kind: "editor" }
	| { kind: "edit"; title?: string; objective?: string }
	| { kind: "refused"; message: string };

/**
 * Parse `/goal:edit` arguments: a leading `--title` option and/or the objective.
 *
 * `--title` alone changes only the title; `--title` plus an objective changes both
 * in one revision; no argument opens the editor. An attachment option anywhere a
 * flag could start is refused with the Replacement Goal guidance rather than being
 * folded into the objective (the historical behavior, now also after `--title`).
 */
function parseGoalEditArgs(raw: string): ParsedGoalEdit {
	const text = raw.trim();
	if (text === "") return { kind: "editor" };
	if (GOAL_ATTACHMENT_OPTION_SCANNER.test(text)) {
		return { kind: "refused", message: EDIT_ATTACHMENT_GUIDANCE };
	}
	const title = readGoalEditTitleOption(text);
	if (title.kind === "error") return { kind: "refused", message: title.message };
	if (title.kind === "none") return { kind: "edit", objective: text };
	if (readGoalEditTitleOption(title.option.rest).kind !== "none") {
		return { kind: "refused", message: "Goal not edited: --title may be given only once." };
	}
	if (GOAL_ATTACHMENT_OPTION_SCANNER.test(title.option.rest)) {
		return { kind: "refused", message: EDIT_ATTACHMENT_GUIDANCE };
	}
	return {
		kind: "edit",
		title: title.option.value,
		...(title.option.rest === "" ? {} : { objective: title.option.rest }),
	};
}

function parseGoalArgs(raw: string): ParsedGoalArgs {
	let rest = raw.trim();
	let budget: GoalBudgetRequest = { kind: "default" };
	const attachments: AttachmentRequest[] = [];
	const problems: string[] = [];
	for (;;) {
		const match = GOAL_OPTION_SCANNER.exec(rest);
		if (!match) break;
		const flag = match[1]!;
		const inline = match[2];
		rest = rest.slice(match[0].length);
		if (flag === "no-budget") {
			budget = { kind: "none" };
			continue;
		}
		if (flag === "file" || flag === "image" || flag === "remote-image") {
			let value: string;
			if (inline !== undefined) {
				value = inline;
			} else {
				const next = /^(\S+)(?:\s+|$)/.exec(rest);
				if (!next) {
					problems.push(
						flag === "remote-image"
							? "Goal not created: --remote-image needs an HTTPS image URL (for example --remote-image https://example.com/screenshot.png)."
							: `Goal not created: --${flag} needs a local file path (for example --${flag} ${flag === "image" ? "screenshot.png" : "notes.md"}).`,
					);
					break;
				}
				value = next[1]!;
				rest = rest.slice(next[0].length);
			}
			if (flag === "remote-image") {
				const validated = validateRemoteImageUrl(value);
				if (!validated.ok) {
					problems.push(validated.error);
					break;
				}
				attachments.push({ kind: "remote-image", url: validated.url.href });
				continue;
			}
			const kind = flag === "image" ? "image" : "text";
			const validated = validateAttachmentPath(kind, value);
			if (!validated.ok) {
				problems.push(validated.error);
				break;
			}
			attachments.push({ kind, path: validated.path });
			continue;
		}
		if (inline !== undefined) {
			budget = { kind: "value", value: Number(inline) };
			continue;
		}
		const value = /^(\S+)(?:\s+|$)/.exec(rest);
		if (!value) break;
		rest = rest.slice(value[0].length);
		budget = { kind: "value", value: Number(value[1]) };
	}
	return { objective: rest.trim(), budget, attachments, problems };
}

/** How long creation waits for the snapshot to become durable on disk. */
const DURABILITY_TIMEOUT_MS = 5000;
const DURABILITY_POLL_MS = 15;

/**
 * What a resume restarted work *from*, for the resume notice.
 *
 * A switch rather than a chained conditional: each of the four non-continuing
 * statuses ends the Goal for a different reason, and the notice names that reason.
 * `budget_limited` is the only one whose restart quotes the new ceiling, so it is
 * the fallback rather than another branch.
 */
function resumeRestartNotice(status: GoalStatus, tokenBudget: number | undefined, accountedTokens: number): string {
	switch (status) {
		case "paused":
			return "Work restarted from retained progress.";
		case "blocked":
			return "The blocked audit that ended it is cleared, so work restarts from retained progress with a fresh audit.";
		case "usage_limited":
			return "The usage-limit stop that ended it is cleared, so work restarts from retained progress.";
		default:
			return (
				`The cumulative token ceiling is now ${tokenBudget} tokens with ${accountedTokens} tokens already ` +
				"accounted; the old episode's wrap-up is cancelled."
			);
	}
}

/** Status-bar key used for the compact Goal indicator. */
const STATUS_KEY = "goal";

/**
 * Uniform error result for the model-facing Goal tools. Keeping one shape means
 * a failed create/update reports the same structured `{ goal }` payload a
 * success does (null, or the unchanged current Goal), so a caller never has to
 * guess whether the state moved.
 */
function goalToolError(message: string, goal: GoalPublicState | null) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		structuredContent: { goal },
		details: { goal },
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What the /goal command was asked to do. */
type GoalCommand = { kind: "status" } | { kind: "create"; objective: string } | { kind: "invalid"; message: string };

/**
 * The whole-argument spellings of the verb commands, as a user migrating from
 * Codex's space-separated subcommands would type them after `/goal`.
 *
 * The bare word, matched case-insensitively and after trimming, is the old
 * `pause` / `resume` / `clear` / `history` / `edit` subcommand; `resume --budget`
 * (both spellings) is the old budget-raising resume. Each names the verb command
 * it used to reach, so the refusal can point at it. The list is derived from the
 * command family itself, so a seventh verb cannot be registered without also
 * being reserved here.
 */
const RESERVED_GOAL_VERBS = GOAL_COMMAND_NAMES.filter((name) => name !== "goal").map((name) => name.slice("goal:".length));

/**
 * The reserved-word guard for the `/goal` creation path (ADR-0002).
 *
 * An Objective is only ever the argument of `/goal`, so it can never be read as
 * a lifecycle action — but Codex muscle memory types the old space-separated
 * spelling (a bare `pause` after `/goal`), and without this guard that would
 * silently create a Goal named "pause" and start work on it. The old spelling is
 * refused, not aliased: the message names the verb command to type instead, and
 * nothing else happens. The guard is the only trace of the old syntax in the
 * code.
 *
 * It matches the trimmed, lower-cased Objective that is left after the leading
 * creation options have been scanned, against the bare verb words and against a
 * leading `resume --budget`, and nothing else: `Clear the lint errors`, `Edit
 * the README`, `Resume work on X`, and `history of the release` are Objectives.
 * It applies to the `/goal` command only — `create_goal` has its own creation
 * authority and no command ambiguity to resolve.
 */
function reservedGoalVerbRefusal(args: string): string | null {
	// An Objective can be preceded by creation options — a user types
	// `/goal --no-budget clear`, and the companion renders a `set` with a budget
	// as `--budget 90000 clear`. Refuse the Objective the creation path would
	// actually use, not the raw argument: scanning with the same parser closes
	// the option-smuggling path without a second copy of its token rules.
	const word = parseGoalArgs(args).objective.toLowerCase();
	if (RESERVED_GOAL_VERBS.includes(word as (typeof RESERVED_GOAL_VERBS)[number])) {
		return `Goal not created: \`${word}\` is a Goal command; use /goal:${word}.`;
	}
	if (/^resume\s+--budget(?:=|\s|$)/.test(word)) {
		return (
			"Goal not created: `resume --budget` is a Goal command; use /goal:resume --budget <new-total> " +
			"(or --budget=<new-total>)."
		);
	}
	return null;
}

/**
 * Parse /goal arguments.
 *
 * The parser reduces to two meanings: an empty argument is the status report,
 * anything else is a creation — after the reserved-word guard has had its say.
 * Every lifecycle verb is its own command (`/goal:pause`, `/goal:resume`,
 * `/goal:clear`, `/goal:history`, `/goal:edit`), so no rule about a first word or
 * an entire argument is needed to tell a verb from an Objective any more.
 */
function parseGoalCommand(args: string): GoalCommand {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "status" };
	const reserved = reservedGoalVerbRefusal(trimmed);
	if (reserved !== null) return { kind: "invalid", message: reserved };
	return { kind: "create", objective: trimmed };
}

export default function goalExtension(pi: ExtensionAPI): void {
	/**
	 * The optional local metrics consumer seam: the same committed event, projected
	 * to a privacy-safe record and published on its own channel for an operator or
	 * an explicitly installed companion exporter. The sink is a local bus emit, so
	 * the default does no network I/O; the publisher isolates a sink failure so it
	 * can never touch the committed transition (see docs/behavior/metrics.md).
	 */
	const metrics = createGoalMetricsPublisher({
		sink: (projected) => {
			pi.events.emit(GOAL_METRICS_CHANNEL, projected);
		},
	});

	/**
	 * Committed transitions observed while a bridged `/goal` command runs.
	 *
	 * Scoped by `bridgeInFlight`: a command that is not bridged never records
	 * anything, and the sink is cleared before the reply is built so a later
	 * transition cannot be attributed to a request that already finished.
	 */
	let bridgeTransitions: GoalBridgeTransition[] | null = null;

	/**
	 * One bridged command at a time.
	 *
	 * Serializing is what keeps attribution exact: the sink holds the transitions
	 * of *the* command in flight, and a dialog (the objective editor) or a busy
	 * session can keep a command waiting for minutes. A second request is refused
	 * rather than queued, so a caller always learns immediately that its request
	 * did not run.
	 */
	let bridgeInFlight = false;

	/**
	 * The most recent session context, captured at `session_start` (and refreshed on
	 * input and tree navigation).
	 *
	 * Pi hands a context to event handlers but not to a bus listener, and a bridged
	 * command needs one to read the session file, show dialogs, and wait for idle.
	 * Pi's contexts are lazy handles onto the live runner, so the captured one stays
	 * valid for the session it was captured in.
	 */
	let sessionContext: ExtensionContext | null = null;

	const store = new GoalStore({
		// The store owns every durable commit point, so it is what announces each
		// committed transition to the local event stream — including creation and
		// replacement, whose commit is the durable bar the event uses. The /goal
		// command's separate on-disk durability poll stays a gate for the
		// *user-facing* announcement only (see `emitGoalUpdated` and
		// docs/behavior/events.md). Both derived surfaces ride the same committed
		// event: the metrics projection is derived from it, never from the live
		// record, and the audit history record is projected from it too, so neither
		// can disagree with the stream or with the transition underneath.
		onDurableTransition: (kind, goal, committedAt, previous) => {
			const event = toGoalUpdatedEvent(kind, goal, committedAt);
			// A bridged command records the durable transitions it caused, so its
			// caller is answered from the commit rather than from a message (see
			// `./command-bridge.ts`). Recording happens before the announcement and
			// only here, so nothing that failed to commit can appear in the result.
			if (bridgeTransitions !== null) bridgeTransitions.push({ kind, goal: toPublicState(goal) });
			emitGoalUpdated(event);
			metrics.publish(event);
			appendGoalHistory(pi, event, previous);
		},
	});
	const safety = new GoalSafetyMonitor();

	/**
	 * Publish one committed Goal-updated event on Pi's shared extension event bus.
	 *
	 * Emitted only after the durable write it describes, exactly like the UI
	 * announcement: the transition is already committed when this runs, so the
	 * event surface is best effort by construction. The bus isolates listeners
	 * (a handler failure is caught and logged by the bus itself, never
	 * propagated to the emitter), and this catch is the mirror image for a
	 * failure of the emit call: it must never surface as — or be mistaken for —
	 * a durability failure of the transition underneath.
	 */
	function emitGoalUpdated(event: GoalUpdatedEvent): void {
		try {
			pi.events.emit(GOAL_UPDATED_EVENT, event);
		} catch {
			// The transition is already durable; the event surface is best effort.
		}
	}

	/**
	 * Append one audit-history record for a transition that is already durable.
	 *
	 * The single write seam for the timeline, and it sits *inside* the store's
	 * committed-transition observer: the `goal-state` snapshot or tombstone has
	 * already been appended when this runs, so a history record can only ever
	 * describe committed state, and a refused, failed, or retracted transition
	 * never reaches it. The record is projected from the event payload rather than
	 * from the Goal record, which is what keeps the timeline and the public event
	 * stream from disagreeing about a transition.
	 *
	 * Best effort in the same sense the event is: an unwritable session file must
	 * not be reported as a failed lifecycle transition, and a history append that
	 * never landed leaves the documented diagnostic gap (a transition with no
	 * record) instead of a wrong Goal. Nothing reads these entries back except the
	 * read-only `/goal:history` rendering — reconstruction reads `goal-state` alone
	 * — so the failure mode is a shorter timeline, never a changed Goal.
	 */
	function appendGoalHistory(pi: ExtensionAPI, event: GoalUpdatedEvent, previous: GoalRecord | null): void {
		try {
			pi.appendEntry(HISTORY_ENTRY_TYPE, toGoalHistoryRecord(event, previous?.status ?? null));
		} catch {
			// The transition is already durable; history is derived diagnostic data.
		}
	}

	/**
	 * What started the next run, set by whoever starts it: the kickoff the /goal
	 * command sends, or a continuation this extension just requested. Consumed by
	 * `agent_start`, and cleared by `agent_settled` so a continuation Pi rejected
	 * (an invalid boundary continuation, a run it refused to start) cannot leak
	 * into the next user-started run.
	 */
	let pendingRunKind: GoalRunKind | undefined = undefined;

	/** Evidence of the provider failure that ended the current run, if any. */
	let providerFailure: ProviderFailureEvidence | undefined = undefined;

	/** How the last assistant message of the current run ended. */
	let runOutcome: AgentActivityOutcome | undefined = undefined;

	/** What started the run that just ended, so its retry can be recognized. */
	let lastRunKind: GoalRunKind = "user";
	/**
	 * Whether the next run continues the Goal turn that just ended.
	 *
	 * Pi can turn one Goal turn into several runs in two ways, and both of them must
	 * keep the Goal turn's identity and its accumulated observations:
	 *
	 * - it retries a failed provider request (`agent_end` with an error outcome);
	 * - it compacts for overflow recovery and retries the same response
	 *   (`session_compact` with `willRetry`), which follows a *completed* run, so
	 *   the error signal alone would miss it.
	 *
	 * Cleared by anything that means the next run does *not* continue the turn: the
	 * settlement boundary (the Goal turn is over), user input (Pi is delivering
	 * queued work, not retrying), or the run itself once it has started. Without
	 * those clears, a message the user queued during a failing run would inherit the
	 * Goal turn's identity and count as unattended Goal work.
	 */
	let continuesGoalTurn = false;

	/**
	 * Whether a blocker report was counted during the current Goal turn.
	 *
	 * The blocked audit counts *consecutive* Goal turns, so a Goal turn that ends
	 * without a report has to break the chain even though nothing in that turn
	 * said so.
	 */
	let blockerCountedThisRun = false;

	/**
	 * The Goal (identity + revision) the model's current request was prepared
	 * against, admitted at the first provider turn of an execution and kept for the
	 * rest of it. Model-side lifecycle transitions (`update_goal`) are bound to it:
	 * a held response released after a user edit, replacement, pause, or resume
	 * executes against a revised Goal and must be refused instead of mutating it,
	 * because the model decided on state it can no longer see reflected.
	 *
	 * A run's *follow-up* turns are prepared against the context the run started with
	 * plus its tool results, never against a Goal that appeared meanwhile, so
	 * re-admitting the Goal at every `turn_start` would hand an old run whatever Goal
	 * the user created while it was in flight — `/goal:clear` plus
	 * `/goal <objective>`, or a replacement — and its `complete`, `blocked`, or
	 * explicit-`pause` would be accepted against an identity the run never saw. The
	 * binding is therefore re-admitted only to the identity it already holds; a
	 * different identity is never adopted.
	 *
	 * A same-identity revision change is admitted, but not because the model has
	 * necessarily seen it. An edit or a resume (including a budget raise) of an active
	 * Goal is delivered or steered into the running work, so the model has seen that
	 * revision. A user `/goal:pause`, an automatic `budget_limited` transition, or an
	 * automatic blocked-threshold transition is not steered, and is safe for a
	 * different reason: each leaves the Goal in a non-active status, and every
	 * model-side transition (`complete`, `blocked`, and explicit `pause`) requires an
	 * `active` Goal, so the status gate refuses it.
	 *
	 * `null` while no turn of this execution has started, or while no Goal existed
	 * when it did. A later turn of that execution may then admit whatever Goal exists,
	 * which is what lets the run whose own `create_goal` built one act on it: the tool
	 * result is what showed the model that Goal.
	 *
	 * Cleared when an execution ends (settlement) and when a new one starts, so a
	 * kickoff, a Continuation, a resume, or a prompt the user types is admitted
	 * against the Goal that is current then. A run Pi starts to retry the one before
	 * it — a failed provider request, or a response compaction recovered — is the
	 * *same* execution, so it keeps the binding.
	 */
	let turnGoal: GoalBinding | null = null;

	/**
	 * An initial Goal staged by `/goal <objective>` while that command waits for
	 * an ordinary (non-Goal) run to finish. The continuation seam must not adopt
	 * that run before the command has sent the kickoff: otherwise the run the
	 * command is waiting for continues as Goal work, `waitForIdle` may never
	 * resolve (an edit keeps the Goal active), and the creation announcement
	 * races its own objective. Cleared as soon as the wait ends; the gate covers
	 * this Goal identity for the whole pending lifecycle, including a concurrent
	 * edit/pause/resume, not merely the revision captured before the wait.
	 */
	let pendingInitialKickoff: GoalBinding | null = null;

	/**
	 * Execution-time Goal-creation authority.
	 *
	 * `create_goal` may create a Goal only from an explicit request, and the
	 * request must be corroborated at execution time against the one currently
	 * authoritative source. The source is either the raw interactive/RPC user
	 * input that started the current execution or a Pi custom message;
	 * skill/template expansion and other transformed prompt text are not
	 * evidence, and an extension calling `pi.sendUserMessage()` never acquires
	 * human-user authority through that API.
	 *
	 * The authority belongs to the execution started by the request and survives
	 * later model turns, Pi retries, compaction, and overflow recovery inside it.
	 * A newer interactive/RPC user message or Pi custom message replaces it, even
	 * when unrelated. Settlement, session restart, branch navigation, a successful
	 * Goal creation, and direct Goal lifecycle operations clear it. It is one-shot:
	 * a successful creation consumes it, while a rejection leaves it valid so a
	 * corrected call can retry. Nothing about it is persisted — a snapshot keeps
	 * `origin: "tool"` and gains no quotation, source id, or reusable marker.
	 */
	type GoalCreationAuthoritySource =
		| { kind: "user"; text: string }
		| { kind: "custom"; customType: string; text: string };

	let creationAuthority: GoalCreationAuthoritySource | null = null;
	/**
	 * Raw user inputs seen at the `input` seam, matched to delivered user messages
	 * in order. The `input` event fires before skill/template expansion and (for a
	 * queued steer) before delivery, while the model sees the expanded text; the
	 * quote must match the raw input, so it is captured here and applied when the
	 * message is delivered, which is the same boundary the branch replay reads.
	 */
	const pendingUserInputs: Array<{ text: string; source: string }> = [];

	function clearCreationAuthority(): void {
		creationAuthority = null;
		pendingUserInputs.length = 0;
	}

	/**
	 * Apply the raw input of a delivered user message. An interactive/RPC prompt is
	 * an accepted source; an extension-originated `sendUserMessage` is not, and it
	 * starts a new execution, so it clears the previous authority. A user message
	 * delivered with no matching input fails closed.
	 */
	function applyDeliveredUserAuthority(): void {
		const pending = pendingUserInputs.shift();
		if (!pending) {
			creationAuthority = null;
			return;
		}
		if (pending.source === "interactive" || pending.source === "rpc") {
			creationAuthority = { kind: "user", text: pending.text };
			return;
		}
		creationAuthority = null;
	}

	/** The tool error for a Goal-creation request whose evidence is not corroborated. */
	function goalCreationAuthorityError(
		corroboration: Extract<GoalCreationCorroboration, { ok: false }>,
		quote: string,
	): string {
		switch (corroboration.reason) {
			case "quote-empty":
				return (
					"Goal not created: create_goal requires a quotation of the explicit Goal-creation request. " +
					'Pass user_request with the exact words of the request (for example "please create a goal for the release").'
				);
			case "quote-not-request":
				return (
					"Goal not created: the quoted text is not a complete affirmative Goal-creation instruction " +
					`(${JSON.stringify(previewObjective(quote, 120))} does not expressly ask to create, set, or start a Goal). ` +
					'Quote the instruction itself — for example "please create a goal for the release" — not a keyword, a fragment, ' +
					"a mention, a question, a hypothetical, or a negation."
				);
			case "not-found":
				return (
					"Goal not created: no currently authoritative request contains " +
					`${JSON.stringify(previewObjective(quote, 200))}. The quotation must come from the raw interactive/RPC user message ` +
					"or Pi custom message that started this execution, and a newer message replaces an older one. " +
					"Ask the user to repeat the request, or use /goal <objective>."
				);
			case "not-an-instruction":
				return (
					"Goal not created: the quoted Goal-creation instruction is not affirmative in the currently authoritative source — " +
					"it is negated, cancelled, hypothetical, a question, or superseded by a later correction or cancellation. " +
					"If the user did ask, ask them to repeat the request; otherwise keep working. " +
					"The user can also create a Goal directly with /goal <objective>."
				);
		}
	}

	/**
	 * Extension-level admission configuration (`goal.enabled`), read from Pi's
	 * effective settings at every session start, exactly like the budget settings,
	 * so a reload picks up a changed configuration.
	 *
	 * Admission is a host preference rather than Goal state: nothing about it is
	 * persisted, and a disabled extension never rewrites a Lifecycle status, never
	 * pauses a Goal, and never stops the Active elapsed time clock. It only refuses
	 * to admit *new* Goal work — creation, replacement, a work-admitting objective
	 * edit, resume, and the automatic continuation (or budget wrap-up) the
	 * settlement seam would otherwise request.
	 */
	let admission: AdmissionSettings = { enabled: true, problems: [] };

	/**
	 * Extension-level session-naming configuration
	 * (`goal.sessionNameFromObjective`), read from Pi's effective settings at every
	 * session start, exactly like the admission and budget settings, so a reload
	 * picks up a changed configuration.
	 *
	 * The default is `false`: naming a session is a convenience the user has to ask
	 * for, and pi-goal otherwise leaves Pi's own session metadata alone.
	 */
	let sessionNaming: SessionNamingSettings = { nameFromObjective: false, problems: [] };

	/**
	 * Name the session from a freshly created Goal's title or Objective, when the user
	 * opted in.
	 *
	 * Called only from the two creation paths, and only after their durable commit
	 * succeeded: a refused, failed, or rolled-back creation never reaches it, so a
	 * failed Goal can never leave a name behind. The write itself is best effort — a
	 * host failure is reported as a warning, never as a creation failure, because the
	 * Goal is already durable and the name is metadata about the session.
	 *
	 * The Goal title is the preferred source and the Objective's first line is the
	 * fallback. Attachment contents have their own trust boundary and are never
	 * folded into a name (see `./session-naming.ts`).
	 */
	function nameSessionFromGoal(ctx: ExtensionContext, goal: GoalRecord): void {
		const outcome = applySessionNameFromGoal(
			sessionNameSurface(pi),
			{ title: goal.title, objective: goal.objective },
			sessionNaming.nameFromObjective,
		);
		if (outcome.kind === "failed") {
			notify(
				ctx,
				`Session not named: pi-goal could not name the session from the Goal title or Objective ` +
					`(${outcome.reason}). The Goal itself is unchanged; rename the session yourself if you want a name.`,
				"warning",
			);
		}
	}

	/**
	 * Extension-level convenience configuration (`goal.resumePrompt`), read from
	 * Pi's effective settings at every session start like the other settings.
	 *
	 * Off by default. When on, a restored **paused** Goal may be offered one
	 * confirmation dialog at session start; accepting runs the same durable user
	 * resume as `/goal:resume` (same identity, history, and a fresh Blocked audit),
	 * while declining, dismissing, timing out, or having no UI leaves the Goal
	 * exactly as it was.
	 */
	let resumePrompt: ResumePromptSettings = { enabled: false, problems: [] };

	/**
	 * Extension-level Objective-clarification configuration
	 * (`goal.clarifyOnCreate`, default true), read at the same seam as the others.
	 *
	 * On by default: vague Objectives are the problem the flow exists for, so the
	 * remedy is the default path and `false` is the escape hatch back to direct
	 * creation. The setting lives in Pi's settings rather than in a snapshot: it is
	 * a host preference about *creation*, never Goal state.
	 */
	let clarifyOnCreate: ClarifyOnCreateSettings = { enabled: true, problems: [] };

	/**
	 * The pending clarification this runtime holds, or null.
	 *
	 * The durable record is the `goal-clarification` session entry appended when
	 * `/goal` begins the interview; this is the live view of it, because the model
	 * asks to propose a Goal in a later model turn than the command. It is rebuilt
	 * from the selected branch at every `session_start` and `session_tree` (issue
	 * #85), so a graceful or unclean restart continues the same interview with the
	 * same raw idea and flags, and it is cleared when the confirmation is saved,
	 * cancelled, or times out. A new `/goal` replaces it, and the identity check in
	 * {@link endPendingClarification} keeps the replaced interview's open editor from
	 * committing anything.
	 */
	let pendingClarification: PendingClarification | null = null;

	/**
	 * The confirmation the user saved whose commit is in flight, or whose commit
	 * failed or was interrupted.
	 *
	 * The durable record for it is the `confirming` `goal-clarification` entry,
	 * written *before* the commit, so a failed creation or a crash mid-fetch cannot
	 * strand the user's edited draft and held flags behind a terminal end. While an
	 * attempt is live, `pendingClarification` is null (a second confirmation must
	 * not start), and the draft is what reopens the editor when `propose_goal` is
	 * called again.
	 */
	let pendingConfirmation: { pending: PendingClarification; draft: ConfirmedClarificationDraft } | null = null;

	/**
	 * Whether `propose_goal` is registered *and* survived registration in this
	 * session. Objective clarification is only offered while it is true: an
	 * interview that could not end in a confirmation editor would be a dead end, so
	 * a missing tool falls back to direct creation.
	 *
	 * This is the session-start answer only. Another extension can take the tool
	 * name afterwards, so every seam that matters (recording an interview, offering
	 * a restored one, confirming) re-reads the registry with
	 * {@link toolSurvivedRegistration} instead of trusting this flag.
	 */
	let proposeGoalRegistered = false;

	/**
	 * Extension-level plan-tool configuration (`goal.planTool`), read from Pi's
	 * effective settings at every session start like the other settings.
	 *
	 * Off by default: a structured progress plan is a convenience for long Goals,
	 * and an opt-out default would put another tool in every model's loadout. See
	 * `./plan.ts` for why the plan is a persisted tool result rather than Goal
	 * state.
	 */
	let planTool: PlanToolSettings = { enabled: false, problems: [] };

	/**
	 * Whether the plan tool is registered *and* survived registration in this
	 * session. Only this flag gates the Continuation wording, so the model is never
	 * told to call a tool that is not in its loadout.
	 *
	 * Registration happens at `session_start` rather than at extension load because
	 * Pi's effective settings are not readable before the runtime is bound, and
	 * registering late is a supported seam. Once registered a tool cannot be
	 * unregistered, so a setting changed mid-session leaves the registration in
	 * place; the tool then refuses its calls rather than silently recording plans
	 * the user switched off, and the next session start reconciles the two.
	 */
	let planToolRegistered = false;

	/**
	 * Register the opt-in progress-plan tool, and record whether it really landed.
	 *
	 * "Registration succeeded" is checked rather than assumed, for two reasons that
	 * both come from Pi's tool registry being keyed by name across all extensions:
	 *
	 * - another extension may already own `update_plan`. Registering anyway would
	 *   silently replace its tool, which is the one thing this feature must not do
	 *   to a host that happens to use the same conventional name;
	 * - a registration can fail, and a Continuation that named a tool the model
	 *   cannot call would waste a Goal turn and teach it to ignore the extension.
	 *
	 * Both checks resolve to "not registered" on anything unexpected, which is the
	 * fail-closed direction: the tool is a convenience, so the safe outcome of not
	 * knowing is not to promise it.
	 */
	function registerPlanTool(ctx: ExtensionContext): void {
		if (planToolNameTaken()) {
			planToolRegistered = false;
			notify(
				ctx,
					`pi-goal did not register ${PLAN_TOOL_NAME}: another extension already provides a tool with that name, and ` +
						"pi-goal will not replace it. No Continuation will mention the plan tool. Rename that extension's tool to " +
						"use pi-goal's own, or set goal.planTool to false to stop pi-goal from offering one.",
					"warning",
			);
			return;
		}
		try {
			pi.registerTool({
				name: PLAN_TOOL_NAME,
				label: "Update Plan",
				description:
					"Record the current Goal's ordered progress plan, replacing any previous one: an ordered list of " +
					"steps, each pending, in_progress, or completed, with at most one in_progress. Use it for a Goal with " +
					"several steps so verified progress and remaining work are visible across turns. It is progress " +
					"narration only: it never changes the Goal's Lifecycle status and can never mark the Goal complete.",
				parameters: planParametersSchema,
				outputSchema: planOutputSchema,
				promptSnippet: PLAN_TOOL_PROMPT_SNIPPET,
				promptGuidelines: [...PLAN_TOOL_PROMPT_GUIDELINES],
				/**
				 * Compatibility shim for the one spelling a model reliably drifts into:
				 * naming the list `steps` instead of `plan`. Everything else is passed
				 * through untouched, so a semantically invalid plan is refused by the
				 * tool with an explanation rather than being reshaped here.
				 */
				prepareArguments: (args: unknown): PlanToolArguments => {
					if (typeof args !== "object" || args === null) return { plan: [] };
					const record = args as Record<string, unknown>;
					if (record.plan !== undefined || record.steps === undefined) return record as PlanToolArguments;
					return { ...record, plan: record.steps } as PlanToolArguments;
				},
				async execute(
					_toolCallId: string,
					params: PlanToolArguments,
					_signal,
					_onUpdate,
					toolCtx: ExtensionToolContext,
				) {
					// The setting is read at session start, and a tool cannot be
					// unregistered, so a value changed mid-session is refused here rather
					// than recorded against a user who switched the tool off.
					if (!planTool.enabled) {
						return planToolError(formatPlanDisabledMessage());
					}
					// The plan is progress on a Goal. With no Goal there is nothing for it
					// to describe and no Continuation that would ever show it, so the call
					// is refused instead of writing an orphan record.
					const goal = store.get();
					if (!goal) {
						return planToolError(formatPlanNoGoalMessage());
					}
					const validation = validatePlanArgument(params?.plan);
					if (!validation.ok) {
						return planToolError(validation.error);
					}
					const plan: PlanRecord = validation.plan;
					// Nothing here touches the store: no snapshot, no revision, no event.
					// The plan's durability is this tool result's own `details`, which Pi
					// persists onto the session branch like any other tool result, and its
					// usage is charged by the ordinary accounting path like any other tool
					// call — there is no plan-specific branch in either.
					return {
						content: [{ type: "text", text: formatPlanMessage(plan) }],
						structuredContent: { plan },
						details: { plan },
					};
				},
			});
		} catch (error) {
			planToolRegistered = false;
			notify(
				ctx,
					`pi-goal could not register the ${PLAN_TOOL_NAME} tool (${describeError(error)}). The Goal itself is ` +
					"unaffected; no Continuation will mention the tool.",
				"warning",
			);
			return;
		}
		planToolRegistered = planToolSurvivedRegistration();
		if (!planToolRegistered) {
			notify(
				ctx,
					`pi-goal registered ${PLAN_TOOL_NAME}, but another extension's tool of the same name took its place, so ` +
						"pi-goal will not tell the model to call it. Rename that extension's tool, or set goal.planTool to false " +
						"to stop pi-goal from registering its own.",
				"warning",
			);
		}
	}

	/**
	 * Whether some *other* extension already owns a tool's name.
	 *
	 * `get_goal` is the control: it is registered unconditionally at extension load
	 * and is pi-goal's own, so its source identifies this extension. A tool of the
	 * same name from a different source is somebody else's, and registering over it
	 * would be exactly the shadowing this feature must not do. Anything unexpected —
	 * a host without these seams, a missing entry, a throw — resolves to "taken",
	 * because declining to register costs a convenience while clobbering another
	 * extension costs that extension its tool.
	 */
	function toolNameTakenByOther(name: string): boolean {
		try {
			const tools = pi.getAllTools();
			const ownSource = tools.find((tool) => tool.name === "get_goal")?.sourceInfo?.path;
			if (ownSource === undefined) return true;
			const existing = tools.find((tool) => tool.name === name);
			return existing !== undefined && existing.sourceInfo?.path !== ownSource;
		} catch {
			return true;
		}
	}

	/**
	 * Whether the declaration of `name` now in force is pi-goal's own.
	 *
	 * The belt to {@link toolNameTakenByOther}'s braces: a registration that was
	 * allowed can still lose the name, and only the declaration actually in force
	 * may be relied on.
	 */
	function toolSurvivedRegistration(name: string): boolean {
		try {
			const tools = pi.getAllTools();
			const ownSource = tools.find((tool) => tool.name === "get_goal")?.sourceInfo?.path;
			if (ownSource === undefined) return false;
			const registered = tools.find((tool) => tool.name === name);
			return registered?.sourceInfo?.path === ownSource;
		} catch {
			return false;
		}
	}

	/**
	 * Whether some *other* extension already owns the plan tool's name.
	 */
	function planToolNameTaken(): boolean {
		return toolNameTakenByOther(PLAN_TOOL_NAME);
	}

	/**
	 * Whether the `update_plan` declaration now in force is pi-goal's own.
	 *
	 * The belt to {@link planToolNameTaken}'s braces: a registration that was
	 * allowed can still lose the name, and only the declaration actually in force
	 * may be named in a Continuation.
	 */
	function planToolSurvivedRegistration(): boolean {
		return toolSurvivedRegistration(PLAN_TOOL_NAME);
	}

	/** The uniform tool error for a refused plan call. No plan record is persisted. */
	function planToolError(message: string) {
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
			// An empty record on purpose: the durable plan is a *successful* tool
			// result's `details.plan`, so a refusal must leave nothing for a reader of
			// the branch to pick up in its place.
			details: {},
		};
	}

	/**
	 * Register the Objective-clarification tool, and record whether it really landed.
	 *
	 * `goal.clarifyOnCreate` decides whether the flow exists at all, so the tool is
	 * registered only while the setting is on: with clarification off there is no
	 * interview for it to end, and an always-registered tool would add a refusal the
	 * model must learn for nothing. The same two registry rules as the plan tool
	 * apply, for the same reasons: never shadow another extension's tool, and only
	 * report success when pi-goal's own declaration really is the one in force. A
	 * missing tool falls back to direct creation — an interview whose confirmation
	 * cannot be opened would be a dead end.
	 *
	 * The tool refuses at execution time when no pending clarification exists, so a
	 * model that calls it from an ordinary turn learns nothing was created and
	 * nothing moved.
	 */
	function registerProposeGoalTool(ctx: ExtensionContext): void {
		if (toolNameTakenByOther(PROPOSE_GOAL_TOOL_NAME)) {
			proposeGoalRegistered = false;
			notify(
				ctx,
				`pi-goal did not register ${PROPOSE_GOAL_TOOL_NAME}: another extension already provides a tool with that ` +
					"name, and pi-goal will not replace it. Because Objective clarification is enabled " +
					"(goal.clarifyOnCreate is true), /goal <objective> will refuse rather than create a Goal without the " +
					"confirmation editor that is its creation authority. Rename that extension's tool (or unload it), or " +
					"set goal.clarifyOnCreate to false to create directly without confirmation.",
				"warning",
			);
			return;
		}
		try {
			pi.registerTool({
				name: PROPOSE_GOAL_TOOL_NAME,
				label: "Propose Goal",
				description: PROPOSE_GOAL_DESCRIPTION,
				parameters: Type.Object({
					title: Type.String({
						minLength: MIN_TITLE_LENGTH,
						maxLength: MAX_TITLE_LENGTH,
						description: "The drafted Goal title: one line, 1-80 characters.",
					}),
					objective: Type.String({
						minLength: MIN_OBJECTIVE_LENGTH,
						maxLength: MAX_OBJECTIVE_LENGTH,
						description:
							"The drafted Goal objective, ideally with the Objective: / Constraints: / Acceptance criteria: " +
							"sections. The user may edit it in the confirmation editor before it becomes the Goal.",
					}),
				}),
				outputSchema: getGoalOutputSchema,
				promptSnippet: PROPOSE_GOAL_PROMPT_SNIPPET,
				promptGuidelines: [...PROPOSE_GOAL_PROMPT_GUIDELINES],
				async execute(
					_toolCallId: string,
					params: { title: string; objective: string },
					_signal,
					_onUpdate,
					toolCtx: ExtensionToolContext,
				) {
					return proposeGoal(params, toolCtx);
				},
			});
		} catch (error) {
			proposeGoalRegistered = false;
			notify(
				ctx,
				`pi-goal could not register the ${PROPOSE_GOAL_TOOL_NAME} tool (${describeError(error)}). Because Objective ` +
					"clarification is enabled (goal.clarifyOnCreate is true), /goal <objective> will refuse rather than " +
					"create a Goal without the confirmation editor that is its creation authority. Fix the registration " +
					"failure, or set goal.clarifyOnCreate to false to create directly without confirmation.",
				"warning",
			);
			return;
		}
		proposeGoalRegistered = toolSurvivedRegistration(PROPOSE_GOAL_TOOL_NAME);
		if (!proposeGoalRegistered) {
			notify(
				ctx,
				`pi-goal registered ${PROPOSE_GOAL_TOOL_NAME}, but another extension's tool of the same name took its place. ` +
					"Because Objective clarification is enabled (goal.clarifyOnCreate is true), /goal <objective> will refuse " +
					"rather than create a Goal without the confirmation editor that is its creation authority. Rename that " +
					"extension's tool, or set goal.clarifyOnCreate to false to create directly without confirmation.",
				"warning",
			);
		}
	}

	/**
	 * The refusal for an admission request that `goal.enabled` currently forbids.
	 *
	 * One shared tail, because every refusal has to answer the same three
	 * questions: nothing about the existing Goal moved, which controls still work,
	 * and what admits work again. Naming the permitted controls is the point — a
	 * user who disabled the extension must still be able to inspect and stop a Goal
	 * safely, and must not read the refusal as a lifecycle decision.
	 */
	function admissionDisabledRefusal(prefix: string): string {
		return (
			`${prefix} pi-goal is disabled (goal.enabled is false), so no new Goal work is admitted. ` +
			"Disabling the extension is an admission control, not a Lifecycle status and not a pause: no Goal was " +
			"created, replaced, edited, resumed, or paused, and no work was started or aborted. Status inspection " +
			"(/goal, get_goal), /goal:pause, /goal:clear, and terminal updates from work already in flight still work. " +
			"Re-enable goal.enabled to admit Goal work again."
		);
	}

	/**
	 * The admission-disabled condition carried by every successful `update_goal`
	 * result.
	 *
	 * `update_goal` is never an admission decision, so it keeps working while
	 * disabled: that is exactly why its text has to say what is *not* happening.
	 * Without it a below-threshold blocker result reads as a Goal that stays active
	 * and therefore keeps continuing, and a terminal result hides that no
	 * continuation was admitted either.
	 *
	 * The clause is status-aware, for the same reason the status report is: a
	 * complete Goal is terminal for its identity — replacing it is a new
	 * `/goal <objective>`, not a resume — so promising that re-enabling makes
	 * `/goal:resume` work would be false. A still-active Goal is not resumed either;
	 * the continuation is what admission withholds from it.
	 */
	function admissionDisabledUpdateCondition(status: GoalPublicState["status"]): string {
		if (admission.enabled) return "";
		if (status === "complete") {
			return (
				" pi-goal is disabled (goal.enabled is false), so no new Goal work is admitted — no automatic continuation " +
				"— until it is re-enabled; a complete Goal is terminal either way, so replacing it is a new " +
				"/goal <objective>, not a resume. This update is a lifecycle write from work already in flight and stands as " +
				"written."
			);
		}
		const resume = status === "active" ? "" : " and no /goal:resume";
		return (
			" pi-goal is disabled (goal.enabled is false), so no new Goal work is admitted — no automatic continuation" +
			`${resume} — until it is re-enabled; this update is a lifecycle write from work already in flight and stands ` +
			"as written."
		);
	}

	/**
	 * The uniform `{ goal }` tool error for a refused admission request.
	 *
	 * The shape matches every other create refusal: the unchanged current Goal, or
	 * null when the session has none, so a caller never has to guess whether the
	 * state moved.
	 */
	function admissionDisabledToolError(prefix: string) {
		const current = store.get();
		return goalToolError(admissionDisabledRefusal(prefix), current ? toPublicState(current) : null);
	}

	/**
	 * Refuse an objective edit that would admit work, naming why that edit is the
	 * one edit a disabled extension declines.
	 *
	 * An edit of an *active* Goal steers a new objective into the running work, so
	 * it is new Goal work. The edit of a Goal that is already stopped changes only
	 * durable state and stays available, which is why this refusal is scoped to the
	 * active case rather than to every edit.
	 */
	function refuseWorkAdmittingEdit(ctx: ExtensionCommandContext, goal: GoalRecord): void {
		ctx.ui.notify(
			admissionDisabledRefusal(
				"Goal not edited: the objective of an active Goal is work-admitting, because an edit steers a new " +
					"objective into the running work.",
			),
			"warning",
		);
	}

	/**
	 * Extension-level budget configuration, read from Pi's effective settings at
	 * every session start (so a reload picks up a changed configuration).
	 */
	let budgetSettings: BudgetSettings = {
		defaultTokenBudget: undefined,
		maxTokenBudget: undefined,
		problems: [],
	};

	pi.on("turn_start", (_event, ctx) => {
		// An interview is only offered while pi-goal owns the tool that confirms it.
		// Another extension can take the `propose_goal` name after this runtime
		// registered it; `/goal` and `propose_goal` re-check at their own seams, and
		// this keeps an already-open offer from lingering as an unconfirmable one.
		reconcileClarificationToolOwnership(ctx);
		const goal = store.get();
		const admitted = goal ? { id: goal.id, revision: goal.revision } : null;
		// Re-admit the Goal for this turn only while this execution may still be
		// admitted to it. A follow-up turn of a run whose Goal the user cleared or
		// replaced while it was in flight keeps the identity the run started with, so
		// its model-side transitions are refused instead of applied to a Goal it never
		// saw. A same-identity revision change is admitted: an edit or a resume was
		// steered into the running work, so the model has seen it, and an un-steered
		// pause / budget_limited / blocked-threshold change leaves a non-active status
		// whose gate refuses the model's transitions anyway.
		if (turnGoal === null || (admitted !== null && admitted.id === turnGoal.id)) {
			turnGoal = admitted;
		}
		// The Goal identity that owned the segment when this provider request started.
		// A replacement steered into an in-flight run must not steal the response that
		// was already on the wire for the old identity, so the assistant report is
		// bound to this identity (see the `message_end` handler).
		turnOwnerId = store.currentOwnerId();
	});

	/**
	 * Serializes Goal creation across concurrent /goal commands. Commands that
	 * arrive while Pi is busy both wait for idle; without serialization both
	 * could pass the existing-Goal check before either persists, and the second
	 * would silently take the slot. Every creation runs its guards, the
	 * unfinished-Goal refusal, write, kickoff, and durability confirmation
	 * exclusively, so a losing command always sees the winner's committed Goal and
	 * is refused by it.
	 */
	let createLock: Promise<void> = Promise.resolve();
	function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = createLock.then(fn, fn);
		createLock = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/** Compact status line for Pi's footer/status bar, when a UI exists. */
	function updateStatus(ctx: ExtensionContext): void {
		const goal = store.get();
		try {
			ctx.ui.setStatus(
				STATUS_KEY,
				goal ? formatGoalStatusLine(toPublicState(goal), { admissionEnabled: admission.enabled }) : undefined,
			);
		} catch {
			// Status is a convenience surface; never break a lifecycle event for it.
		}
	}

	/**
	 * Notify from a *lifecycle* handler without ever letting a UI problem break the
	 * event: accounting and enforcement must survive a status-bar or notification
	 * failure. Command handlers notify through `ctx.ui.notify` directly — the `/goal`
	 * handler already wraps everything it does in a try/catch, and a command is
	 * user-initiated rather than part of Pi's event stream.
	 */
	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// best effort
		}
	}

	/**
	 * After any accounted usage: enforce the token budget immediately.
	 *
	 * The transition is made in memory here so the rest of *this* run stops doing
	 * Goal work right away, and `budgetGateActive` arms the tool gate for the
	 * remainder of the run. Nothing is written to the session: Pi appends the
	 * message that triggered this *after* dispatching `message_end`, so a durable
	 * write here would land ahead of it and be replayed twice. `flushAccounting`
	 * persists at a post-persistence boundary instead.
	 */
	function afterAccounting(ctx: ExtensionContext): void {
		const goal = store.get();
		if (!goal) return;
		if (goal.status === "active" && store.isBudgetExhausted()) {
			const limited = store.markBudgetLimited();
			if (limited.ok) {
				budgetGateActive = true;
				// The one bounded wrap-up is automatic work like a continuation, so a
				// disabled extension defers it instead of delivering it. The flag is
				// durable, so re-enabling the setting still delivers it exactly once.
				const wrapUp = admission.enabled
					? "No further Goal work runs; one wrap-up summary follows. "
					: "No further Goal work runs; because pi-goal is disabled (goal.enabled is false) the one bounded " +
							"wrap-up is deferred until the setting is re-enabled. ";
				notify(
					ctx,
					`Goal ${limited.goal.id} reached its token budget of ${limited.goal.tokenBudget} tokens ` +
						`(${store.getUsage().totalTokens} accounted) and is now budget_limited. ` +
						wrapUp +
						"Budget exhaustion is not completion.",
					"warning",
				);
			}
		}
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		// Captured for the optional command bridge (issue #56), which is invoked from
		// an event-bus listener where Pi provides no context of its own. Pi contexts
		// are lazy handles onto the live runner, so this stays valid for the session.
		sessionContext = ctx;
		clearCreationAuthority();
		// A pending clarification is runtime state over a durable entry. Memory is
		// cleared here, and the branch is read again below: stale state from a previous
		// session must never authorize a Goal in this one, and an interview this branch
		// still holds must not become a dead end (issue #85).
		pendingClarification = null;
		pendingConfirmation = null;
		budgetSettings = parseBudgetSettings(pi.getSettings());
		for (const problem of budgetSettings.problems) notify(ctx, problem, "warning");
		// Admission is read from the same effective settings, at the same seam: a
		// changed `goal.enabled` takes effect on the next session start or reload,
		// never retroactively for work already in flight.
		admission = parseAdmissionSettings(pi.getSettings());
		for (const problem of admission.problems) notify(ctx, problem, "warning");
		// Session naming is read from the same effective settings, at the same seam: a
		// changed `goal.sessionNameFromObjective` takes effect on the next session start
		// or reload, never retroactively for a Goal that already exists.
		sessionNaming = parseSessionNamingSettings(pi.getSettings());
		for (const problem of sessionNaming.problems) notify(ctx, problem, "warning");
		// The opt-in resume prompt is read at the same seam, so a changed setting
		// takes effect at the next session start and never mid-session.
		resumePrompt = parseResumePromptSettings(pi.getSettings());
		for (const problem of resumePrompt.problems) notify(ctx, problem, "warning");
		// Objective clarification is the default creation flow, read at the same seam so
		// a changed goal.clarifyOnCreate takes effect on the next session start or
		// reload, and its one tool is registered (or not) with it.
		clarifyOnCreate = parseClarifyOnCreateSettings(pi.getSettings());
		for (const problem of clarifyOnCreate.problems) notify(ctx, problem, "warning");
		if (clarifyOnCreate.enabled) registerProposeGoalTool(ctx);
		else proposeGoalRegistered = false;
		// The opt-in progress-plan tool is read at the same seam, and it is the other
		// setting that changes what is *registered*: a disabled session registers no
		// plan tool at all, so nothing mentions it and nothing can call it.
		planTool = parsePlanToolSettings(pi.getSettings());
		for (const problem of planTool.problems) notify(ctx, problem, "warning");
		if (planTool.enabled) registerPlanTool(ctx);
		else planToolRegistered = false;
		store.reconstruct(ctx);
		// A hard crash can leave the superseded identity's in-flight tail on the branch
		// with no freeze boundary after it. Reconstruction recovers that tail into
		// memory; freezing it now makes the reload converge durably with the live path
		// rather than waiting for another boundary that a later crash could lose.
		store.closeSupersededAdmission(pi);
		surfaceReconstructionNotice(ctx);
		applyCutover(ctx);
		// Restore verifies the attachment manifest against the artifact store: a
		// missing or corrupt artifact is surfaced here, explicitly, without changing
		// the Goal's Lifecycle status — the continuation seam suppresses its request
		// for as long as the verification fails.
		surfaceAttachmentVerification(store.get(), ctx);
		// Runtime-only counters must not survive into a new runtime; the durable
		// blocked audit is reconstructed with the Goal.
		safety.reset();
		const goal = store.get();
		if (goal) {
			// An active-but-disabled Goal is the case a user could mistake for a
			// continuing one, so the restore notice names the disabled condition
			// instead of leaving it to the status report.
			const disabled =
				!admission.enabled && goal.status === "active"
					? " pi-goal is disabled (goal.enabled is false): this Goal keeps its active status and keeps accruing " +
							"active time, but admits no new Goal work until the setting is re-enabled."
					: "";
			notify(ctx, `Goal ${goal.id} restored (${goal.status}).${disabled}`, "info");
		}
		// Rebuilt after the Goal notice so a restored clarification reads as the state
		// left behind, not as a new one: the raw idea and flags are the ones the user
		// typed before the restart, still unread and unfetched.
		reconstructPendingClarification(ctx);
		updateStatus(ctx);
		// Asked after the restore notice and only for a restored `paused` Goal. The
		// call is fire-and-forget by design: the dialog is created now, but
		// `session_start` never waits for its answer, so no host — including a
		// headless RPC client that ignores it — is ever blocked by the prompt.
		offerResumePrompt(ctx);
	});

	/**
	 * Surface the restore-time attachment verification without changing state.
	 *
	 * The notice is the explicit error the missing/corrupt-artifact contract
	 * requires: it names the failing artifacts and the recovery path. The Goal
	 * itself is untouched — its status is whatever the durable snapshot says —
	 * and the continuation seam independently re-verifies before every request.
	 */
	function surfaceAttachmentVerification(goal: GoalRecord | null | undefined, ctx: ExtensionContext): void {
		if (!goal) return;
		const verification = verifyGoalArtifacts(goal, ctx);
		if (!verification.ok) notifyAttachmentIntegrityFailure(goal, ctx, verification.problems);
	}

	/**
	 * Surface actionable guidance when reconstruction failed closed on a malformed
	 * or unrecognized newest snapshot. Reconstruction itself is silent; the user is
	 * told what to do instead of silently losing the Goal.
	 */
	function surfaceReconstructionNotice(ctx: ExtensionContext): void {
		const notice = store.takeNotice();
		if (notice) notify(ctx, notice, "error");
	}

	/**
	 * Perform the one-time branch-local cutover of a pre-repair snapshot before any
	 * repaired Goal work is admitted, and surface its migration notices. Loading and
	 * migration send no message and trigger no provider request.
	 */
	function applyCutover(ctx: ExtensionContext): void {
		if (!store.needsLegacyCutover()) return;
		const result = store.applyLegacyCutover(pi, budgetSettings);
		if (!result.ok) {
			notify(
				ctx,
				`pi-goal could not cut over the legacy Goal state: ${describeError(result.error)}. ` +
					"No repaired Goal work was admitted; fix the cause and reload the session.",
				"error",
			);
			return;
		}
		for (const notice of result.notices) notify(ctx, notice, "warning");
		if (result.markerError !== undefined) {
			// The repaired snapshot is durable, so the cutover stands and the Goal keeps
			// working under the repaired rules. What is missing is only the branch-local
			// record that this snapshot was migrated, which a fork copied in this window
			// would otherwise inherit instead of migrating itself.
			notify(
				ctx,
				`pi-goal migrated the legacy Goal state but could not record the branch-local cutover marker ` +
					`(${describeError(result.markerError)}). The migrated snapshot is durable, so no usage was lost; ` +
					"a fork of this branch taken now may migrate itself again instead of inheriting the baseline.",
				"warning",
			);
		}
		updateStatus(ctx);
	}
	/** Whether two reconstructed states are observably the same Goal state. */
	function sameBranchGoal(
		a: GoalRecord | null | undefined,
		b: GoalRecord | null | undefined,
	): boolean {
		if ((a ?? null) === (b ?? null)) return true;
		if (!a || !b) return false;
		return (
			a.id === b.id &&
			a.revision === b.revision &&
			a.status === b.status &&
			a.objective === b.objective
		);
	}

	/**
	 * Tell the user what the selected branch's Goal state is after tree
	 * navigation, but only when it actually changed. Reconstruction itself is
	 * silent: navigating between two views of the same state must not spam the
	 * UI, while a change the user needs to know about (a Goal appearing,
	 * disappearing, or becoming a different objective on the newly selected
	 * branch) is exactly the moment abandoned-branch isolation becomes visible.
	 */
	function notifyBranchChange(ctx: ExtensionContext, before: GoalRecord | null, after: GoalRecord | null): void {
		if (sameBranchGoal(before, after)) return;
		if (!after) {
			ctx.ui.notify(
				before
					? `No Goal on the selected branch (left the branch of ${before.id}, ${before.status}). Goal changes from the abandoned branch do not apply here.`
					: "No Goal on the selected branch.",
			"info",
			);
			return;
		}
		if (!before) {
			// The restored Goal's continuation is admission, so the notice is
			// admission-aware for the same reason `session_start`'s restore notice is:
			// promising that an active Goal continues at the next settlement is false
			// while `goal.enabled` is false.
			const continuation =
				after.status !== "active"
					? ""
					: admission.enabled
						? " It continues at the next settlement once a run starts; navigation alone starts no run."
						: " pi-goal is disabled (goal.enabled is false), so it keeps its active status and keeps accruing " +
							"active time but continues nowhere until the setting is re-enabled; navigation alone starts no run.";
			ctx.ui.notify(
				`Goal ${after.id} restored from the selected branch (${after.status}).` + continuation,
				"info",
			);
			return;
		}
		const identity = before.id === after.id ? "" : ` (a different Goal identity than ${before.id})`;
		const objective =
			before.objective === after.objective ? "" : `; objective is now "${previewObjective(after.objective)}"`;
		ctx.ui.notify(
				`Goal changed with the selected branch${identity}: ${after.id} is ${after.status} at revision ${after.revision}${objective}.`,
			"info",
		);
	}

	/**
	 * Tree navigation re-points the active branch inside the same session file,
	 * so the Goal state is rebuilt from the newly selected branch alone: the
	 * snapshots of any branch left behind (later edits, pauses, clears, or entire
	 * other Goals) are unreachable from the new branch and cannot leak into it.
	 * The change is announced whenever the reconstructed state observably
	 * changed, so abandoned-branch isolation is visible rather than implicit.
	 *
	 * `turnGoal` is deliberately *not* reset here. It is the binding the current
	 * execution's model transitions were prepared against; Pi rejects navigation while
	 * a turn is streaming, so at this point the binding is either already fresh
	 * for the selected branch or will be re-admitted at the first turn of the next
	 * execution. If a turn somehow raced a navigation, leaving the binding untouched
	 * keeps the execute-time identity+revision check refusing the stale transition
	 * instead of handing it a fresh binding it was never prepared against.
	 */
	pi.on("session_tree", (_event, ctx) => {
		sessionContext = ctx;
		clearCreationAuthority();
		const before = store.get() ?? null;
		const after = store.reconstruct(ctx);
		// A tail recovered from the selected branch belongs to an identity that is no
		// longer current. Freeze it at this durable boundary so the branch records the
		// old identity's already-admitted work instead of leaving it for a later crash
		// to lose.
		store.closeSupersededAdmission(pi);
		surfaceReconstructionNotice(ctx);
		applyCutover(ctx);
		// The selected branch's Goal owns its own manifest; verify it like a restore.
		surfaceAttachmentVerification(store.get(), ctx);
		// The pending clarification is branch-local too: navigating to a branch that
		// still holds one restores that interview, and navigating to a branch that ended
		// it forgets it, so a stale editor from the branch left behind cannot commit.
		reconstructPendingClarification(ctx);
		notifyBranchChange(ctx, before, after);
		// The status line follows the selected branch too, and the accounting
		// baseline is rebuilt with it.
		updateStatus(ctx);
		// Navigation selects a different branch's Goal state, so the runtime-only
		// counters of the branch left behind must not survive into it.
		safety.reset();
	});

	/**
	 * A compaction that recovers an overflow retries the response that triggered it,
	 * so the run that follows continues the Goal turn rather than starting a fresh
	 * one. This is the only signal for the recoverable-length case, because that run
	 * *completed*: without it, a Goal turn whose response was truncated and retried
	 * empty would be read as a user run and would never reach an anti-loop bound.
	 *
	 * A compaction that does not retry (manual, or the context threshold) leaves the
	 * flag alone, so the next run is a fresh Goal turn or a user run as usual.
	 */
	pi.on("session_compact", (event) => {
		if (event.willRetry) continuesGoalTurn = true;
	});

	/**
	 * A prompt the user typed is a user action: the loop is no longer unattended,
	 * so every anti-loop counter starts over. Extension commands (`/goal ...`) do
	 * not fire `input`; creating a Goal already starts from a fresh record.
	 */
	pi.on("input", (event, ctx) => {
		sessionContext = ctx;
		pendingUserInputs.push({ text: event.text, source: event.source });
		continuesGoalTurn = false;
		// A prompt the user actually typed is never Goal-owned work, so the
		// admission segment closes — but at *delivery*, not here: Pi dispatches this
		// while the provider request is still streaming, and closing now would drop
		// the in-flight response the Goal had already admitted. `message_end` for the
		// delivered user message is the seam that matches the branch replay (see
		// `applyDeliveredUserMessage`). pi-goal's own messages arrive with source
		// "extension" and never close a segment.
		safety.reset();
		reportAuditResetFailure("the prompt you just sent", ctx);
	});

	/**
	 * A run starts. Pi can start several runs for one Goal turn, because it retries
	 * a failed provider request with `agent.continue()`: that run is the *same*
	 * Goal turn, so it keeps the turn's identity and everything the failed attempt
	 * observed. Reading it as a fresh user run would reset the anti-loop counters
	 * and the blocked audit on a transient error Pi is about to retry.
	 */
	pi.on("agent_start", () => {
		// Whether this run continues the execution that just ended rather than opening a
		// new one: Pi's retry of a failed provider request, or of a response compaction
		// recovered, is the same execution and keeps its Goal binding.
		const retriesCurrentExecution = pendingRunKind === undefined && continuesGoalTurn;
		if (pendingRunKind !== undefined) {
			safety.beginRun(pendingRunKind);
			pendingRunKind = undefined;
		} else if (continuesGoalTurn) {
			// Pi is retrying the Goal turn that just ended: same turn, same identity,
			// and the failed attempt's observations still count.
			safety.beginRun(lastRunKind, true);
		} else {
			safety.beginRun("user");
		}
		// A new execution is admitted against the Goal that is current when it starts.
		if (!retriesCurrentExecution) turnGoal = null;
		continuesGoalTurn = false;
		providerFailure = undefined;
		runOutcome = undefined;
	});

	/**
	 * A run ended. Nothing is evaluated here: Pi may retry this run, and a Goal
	 * turn is only over once Pi stops retrying and reaches the settlement boundary.
	 * All this records is what the next `agent_start` needs to recognize a retry.
	 */
	pi.on("agent_end", () => {
		lastRunKind = safety.currentRunKind;
		// A run with no assistant message never reached the model; treat it as
		// neutral rather than as a completed, activity-free Goal turn.
		const outcome = runOutcome ?? "aborted";
		continuesGoalTurn = outcome === "error";
	});

	/**
	 * Settlement is the end of the whole session-level run. Whatever was pending
	 * is either consumed or moot, so nothing may leak into the next run.
	 */
	pi.on("agent_settled", (event, ctx) => {
		pendingRunKind = undefined;
		continuesGoalTurn = false;
		// The execution is over, so its Goal binding is too: the next one is admitted
		// against whatever Goal is current when it starts, which is what lets the Goal
		// a user created in the meantime kick off and continue normally.
		turnGoal = null;
		if (!event.aborted) return;
		// An abort is the strongest possible user action: the Goal turn the user
		// stopped must not be counted as a Goal malfunction, and it never reached
		// the boundary that would otherwise have closed it.
		safety.reset();
		blockerCountedThisRun = false;
		reportAuditResetFailure("the abort", ctx);
	});

	/**
	 * Observe the finalized assistant message: it is what "activity" means for a
	 * Goal turn, and the last one also says how the run ended.
	 */
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		safety.noteAssistantMessage(message);
		// Pi maps a turn's stop reason onto the run outcome, so the last assistant
		// message of a run is authoritative — including when an earlier attempt in
		// the same run failed and a later one recovered.
		runOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		providerFailure =
			message.stopReason === "error"
				? { errorMessage: message.errorMessage, diagnostics: message.diagnostics }
				: undefined;
	});

	/** Observe every finalized tool call, so execution failures can be told apart from ordinary ones. */
	pi.on("tool_execution_end", (event) => {
		safety.noteToolExecutionEnd({
			toolName: event.toolName,
			isError: event.isError,
			durationMs: event.durationMs,
			result: event.result,
		});
	});

	/**
	 * Assistant messages already charged, by object identity.
	 *
	 * `message_end` is the seam where a turn's usage becomes known, and it runs
	 * *before* that turn's tool calls — which is what makes the turn that performs a
	 * lifecycle transition (completion, budget exhaustion) accountable. The charge
	 * key is therefore a process-local sequence number rather than the session entry
	 * id, which does not exist yet at this point. That is sound because the ledger is
	 * rebuilt from the branch on every reconstruction, and a checkpoint is always
	 * appended *after* the entries it covers: replaying the branch after a restart or
	 * a tree navigation therefore charges each entry exactly once, never twice.
	 */
	const chargedMessages = new WeakSet<object>();
	let modelMessageSeq = 0;
	/** The Goal identity owning the segment at the start of the current turn. */
	let turnOwnerId: string | null = null;

	/**
	 * Token accounting, at the only seams where Pi reports finalized usage.
	 *
	 * - `message_end` for an assistant response charges the model call.
	 * - `message_end` for a tool result charges nested model work, keyed by the tool
	 *   call id. Pi merges nested usage into the calling tool result, so charging the
	 *   result once is what keeps it from being counted twice.
	 *
	 * Both are guarded by the ledger, so a duplicate event, a reconstruction
	 * replay, or concurrent tool calls inside one turn cannot double-charge.
	 *
	 * Both decide against the Goal that exists *now*, not against the turn the report
	 * belongs to. A Goal can be created while a tool of an ordinary turn is still in
	 * flight — `/goal` commits before it waits for idle, and `create_goal` runs inside
	 * a tool batch — so the turn's own assistant `message_end` predates the Goal while
	 * its tool results land after it. Those results are not Goal work either: the
	 * creating run stays ordinary, and the branch replay charges nothing between the
	 * creation snapshot and the first Goal work message, so a live path that charged
	 * them would disagree with the replay it is supposed to converge with.
	 * `applyDeliveredUserMessage` is what keeps the two on the same line.
	 */
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "user") {
			// A genuine user turn is not Goal work: the budget gate must not block the
			// tools the user's own request needs, even inside a gated run.
			budgetGateActive = false;
			// This is also the ownership seam. Pi appends the message in this very event,
			// so what happens here is exactly what `ownershipMarker` reads back on replay:
			// a pi-goal work message opens its admission segment, and every other prompt
			// closes it. A delivered message also closes the superseded identity's
			// admission, freezing its in-flight tail before the new segment opens.
			applyDeliveredUserMessage(message, pi);
			// The raw input of the delivered message is what authorizes a Goal creation
			// in this execution. Applying it here (rather than at the `input` seam) keeps
			// a queued steer from replacing the authority of the response already in
			// flight, and matches the branch-replay boundary.
			applyDeliveredUserAuthority();
			return;
		}
		if (message.role === "custom") {
			// A Pi custom message is an accepted authority source of any customType:
			// the type identifies the custom-message path, not a trust allowlist. It
			// replaces prior authority even when unrelated, because it is newer.
			creationAuthority = {
				kind: "custom",
				customType: message.customType,
				text: messageText(message.content),
			};
			return;
		}
		const goal = store.get();
		// A report is Goal work exactly when a non-complete Goal exists as it is
		// finalized. Completion is terminal for accounting, so the completing turn is
		// charged at its own `message_end` and nothing after the completion snapshot is.
		// A Clear that lands while the superseded identity's request is still in flight
		// leaves no current Goal, but its admitted tail must still be charged, so an
		// open superseded tail keeps the seam alive.
		if ((!goal || goal.status === "complete") && !store.hasOpenSupersededTail()) return;
		if (message.role === "assistant") {
			if (chargedMessages.has(message)) return;
			chargedMessages.add(message);
			store.accountUsage(`model:${++modelMessageSeq}`, message.usage, "model", turnOwnerId);
			afterAccounting(ctx);
			return;
		}
		if (message.role !== "toolResult") return;
		store.accountUsage(`toolResult:${message.toolCallId}`, message.usage, "nested");
		afterAccounting(ctx);
	});

	/**
	 * Summarization usage (compaction, branch summaries) is reported on the
	 * session entry rather than on an assistant message, so it is charged here.
	 */
	pi.on("session_compact", (event, ctx) => {
		const goal = store.get();
		if ((!goal || goal.status === "complete") && !store.hasOpenSupersededTail()) return;
		store.accountUsage(event.compactionEntry.id, event.compactionEntry.usage, "nested");
		afterAccounting(ctx);
	});

	/**
	 * Stop the active-time clock when the session runtime goes away, and make the
	 * accounted time durable so a later resume continues from it instead of
	 * silently restarting the clock.
	 */
	pi.on("session_shutdown", (event, ctx) => {
		if (!store.get() && !store.hasOpenSupersededTail()) return;
		// Pi fires this both when the process quits and when a session is *replaced*
		// (fork, clone, switch, resume, reload). The two are not the same event for a
		// durable writer, and telling them apart by the destination rather than the
		// reason string is what makes the difference: `switch_session` onto the same
		// file reports `resume`, while a fork reports `fork`.
		//
		// When the destination is another file, this session is being abandoned, and
		// **nothing at all may be appended to it**. Pi copies the branch for a fork or
		// a clone *before* this handler runs, so anything written here lands only on
		// the source: the new session never sees it, and the source has been mutated by
		// an operation the user performed on a copy. That holds for a forced
		// checkpoint, for the interval-driven one that folding the open segment would
		// otherwise make fire, and for a pending lifecycle transition alike — so the
		// clock is not even stopped on this path.
		//
		// Nothing is lost by writing nothing: the abandoned branch still replays to
		// the same totals whenever anyone selects it again, and a pending budget
		// transition self-heals on the next accounted turn exactly as it does after an
		// unclean exit. Only when this session's file survives — `quit`, or a reload or
		// switch back to the same file — is this the last chance to make the accounted
		// active time durable.
		const currentFile = ctx.sessionManager.getSessionFile();
		const keepsFile = event.targetSessionFile === undefined || event.targetSessionFile === currentFile;
		if (!keepsFile) return;
		// A superseded identity's in-flight tail is frozen at this last durable
		// boundary too, so a quit or reload cannot lose work that never saw another
		// delivered user message.
		store.closeSupersededAdmission(pi);
		store.stopClock();
		store.flushAccounting(pi, true);
	});

	/**
	 * Budget gate bookkeeping.
	 *
	 * `budgetGateActive` blocks tool calls while a run must not do Goal work. It is
	 * armed in two situations and cleared in exactly one place:
	 *
	 * - the run that *crosses* the budget (so its remaining turns cannot do
	 *   substantive work), and
	 * - the run that delivers the one bounded wrap-up.
	 *
	 * It is cleared only at `agent_settled`, because Pi's `agent_end` is explicitly
	 * *not* final: retry backoff and final-attempt recovery still happen after it, and
	 * so does a compaction retry. Clearing earlier would let a retried wrap-up run
	 * tools and produce extra model turns. Clearing at settlement is also what stops a
	 * stale flag from blocking a later, unrelated run — including the case where an
	 * abort during `agent_before_settle` commits the entries but suppresses the
	 * requested continuation.
	 *
	 * `wrapUpArmed` is the hand-off between delivering the wrap-up and the run it
	 * requests actually starting.
	 */
	let wrapUpArmed = false;
	let budgetGateActive = false;

	pi.on("agent_start", () => {
		if (!wrapUpArmed) return;
		wrapUpArmed = false;
		budgetGateActive = true;
	});

	/**
	 * Persist accounting now that this turn's entries are on the branch.
	 *
	 * Pi appends a message *after* dispatching its `message_end` handlers, so a write
	 * made there would sit ahead of the entry it already accounts for and be replayed
	 * twice after a crash. `turn_end` is the first boundary where the assistant
	 * message and every tool result of the turn are already durable, so checkpoints and
	 * pending lifecycle transitions are written here.
	 */
	pi.on("turn_end", () => {
		store.flushAccounting(pi);
	});

	/** Refresh the status line and persist accounting once Pi will not continue. */
	pi.on("agent_settled", (_event, ctx) => {
		// Settlement ends the execution, so its creation authority is over: a later
		// run needs a new request, even one Pi starts for a queued message.
		clearCreationAuthority();
		budgetGateActive = false;
		wrapUpArmed = false;
		store.flushAccounting(pi);
		updateStatus(ctx);
	});

	/**
	 * Enforcement seam for the budget boundary and the wrap-up.
	 *
	 * Asking the model not to call tools is not a bound: a model that reaches for a
	 * tool would otherwise execute it and drive a further model request. So while
	 * the gate is armed every tool call is blocked *and* the batch is terminated, which
	 * is Pi's documented mechanism for stopping after the current tool batch. The
	 * result is no substantive work and no additional model turn.
	 *
	 * The gate returns nothing while disarmed, so other extensions' `tool_call`
	 * decisions are completely untouched outside a gated run.
	 */
	pi.on("tool_call", () => {
		if (!budgetGateActive) return;
		return {
			block: true,
			terminate: true,
			reason:
				`Goal ${store.get()?.id ?? ""} exhausted its token budget, so this run may not call tools. ` +
				"Answer in text only: for the wrap-up, verified progress, remaining work, blockers, and the " +
				"single next useful action.",
		};
	});

	/**
	 * Automatic continuation and the one bounded budget wrap-up, at Pi's safe
	 * settlement boundary only.
	 *
	 * `agent_before_settle` is the one seam where Pi has finished every automatic
	 * follow-up it owns (retries, final-attempt recovery, compaction retries,
	 * queued messages) and is about to go idle. Continuing here therefore never
	 * races or duplicates those mechanisms; continuing from a timer or from
	 * `agent_end` would.
	 *
	 * Guards, all of which must hold:
	 * - a Goal exists and is active (completed, paused, blocked, usage-limited,
	 *   budget-limited, cleared, and absent Goals never continue), and
	 * - the Goal turn completed (aborted and errored Goal turns are hard exits: Pi
	 *   owns retries, so re-driving them here would be an unattended retry loop).
	 *
	 * This boundary is also where a Goal turn is *closed*. Everything Pi owns has
	 * finished by now — retries, final-attempt recovery, compaction retries, queued
	 * messages — so the accumulated observations describe one complete Goal turn,
	 * and only here can they be evaluated without misreading a run Pi is about to
	 * retry. A Goal turn that reported no blocker breaks the blocked audit here too,
	 * for the same reason.
	 *
	 * An errored Goal turn is additionally classified from the evidence Pi exposes,
	 * so a provider usage limit becomes `usage_limited` while any other terminal
	 * provider error stops the continuation for that run and is surfaced.
	 *
	 * A budget-limited Goal with a pending wrap-up gets exactly one bounded
	 * wrap-up message and one further request, and then nothing: the flag is
	 * durable, so neither a duplicate boundary event nor a restart can deliver a
	 * second one. Like an ordinary continuation it is only requested after a
	 * completed run, so a provider error never turns into an unattended retry. The
	 * run it requests is *enforced* as a single response: see the `tool_call` gate
	 * above, which blocks and terminates any tool call the wrap-up attempts.
	 *
	 * Composition: entries proposed by other extensions are chained, never
	 * replaced, and `continue: true` only *ensures* one further provider request.
	 * If queued work already causes that request, Pi satisfies the decision with
	 * it and makes no extra one, so this adds exactly one Goal turn per
	 * settlement and no more.
	 */
	pi.on("agent_before_settle", async (event, ctx) => {
		// Reaching this boundary means Pi is not retrying, so nothing that follows
		// can be a retry of the run that just ended.
		continuesGoalTurn = false;
		const goal = store.get();
		if (!goal) {
			// The status check comes later, after the budget wrap-up: a budget-limited
			// Goal is not active and still has one bounded message to deliver.
			closeGoalTurn(ctx);
			return;
		}
		if (pendingInitialKickoff && goal.id === pendingInitialKickoff.id) {
			// `/goal <objective>` has not sent its kickoff yet. Let the ordinary
			// run settle so the command can start work itself (or observe a
			// user clear/edit/pause and cancel the stale kickoff). Gate by Goal
			// identity, not by the captured revision: an edit keeps the Goal
			// active and would otherwise let this seam adopt the run the create
			// command is waiting for, forever. The run being waited for is not
			// this Goal's work, so a provider failure in it belongs to the run
			// that produced it rather than to a Goal that has not started yet.
			closeGoalTurn(ctx);
			return;
		}
		if (event.outcome === "error") {
			handleProviderFailure(goal, ctx);
			closeGoalTurn(ctx);
			return;
		}
		if (event.outcome !== "completed") {
			closeGoalTurn(ctx);
			return;
		}

		// Every entry this run produced is durable by now, so a pending transition is
		// written before the wrap-up snapshot that follows it.
		store.flushAccounting(pi);

		/*
		 * Admission control: while `goal.enabled` is false, this settlement admits
		 * nothing new. Neither the one bounded budget wrap-up nor a continuation is
		 * requested, because both are unattended Goal work.
		 *
		 * Nothing is dropped: the wrap-up flag is durable, so re-enabling the setting
		 * delivers it at the next settlement, and the Goal itself is untouched. It keeps
		 * its Lifecycle status — including `active` — and keeps accruing Active elapsed
		 * time, because stopping that clock is a pause, not a host preference. A run
		 * that is already in flight is never aborted here either; it finishes and
		 * reports its own terminal update.
		 */
		if (!admission.enabled) {
			const current = store.get();
			if (current?.status === "active") {
				notify(
					ctx,
					`Goal ${current.id} is active, but pi-goal is disabled (goal.enabled is false), so no continuation was ` +
						"requested at this settlement. The Goal keeps its active status and keeps accruing active time; " +
						"/goal:pause, not disabling the extension, stops that clock. Re-enable goal.enabled to admit Goal work again.",
					"warning",
				);
			} else if (store.isWrapUpPending()) {
				notify(
					ctx,
					`Goal ${current?.id ?? ""} is budget_limited with its one bounded wrap-up still owed, but pi-goal is ` +
						"disabled (goal.enabled is false), so it was not delivered. The wrap-up stays pending and is delivered at " +
						"the first settlement after the setting is re-enabled.",
					"warning",
				);
			}
			closeGoalTurn(ctx);
			return;
		}

		if (store.isWrapUpPending()) {
			// Exactly one bounded wrap-up, then the Goal stops for good.
			const delivered = store.consumeWrapUp(pi);
			if (!delivered.ok) return;
			// The wrap-up run is Goal-owned work: its one response is charged.
			store.beginGoalWork(delivered.goal.id);
			wrapUpArmed = true;
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message",
						customType: CUSTOM_WRAPUP_MESSAGE_TYPE,
						content: formatBudgetWrapUpMessage(delivered.goal),
						display: true,
					},
				],
				continue: true,
			};
		}

		if (goal.status !== "active") {
			closeGoalTurn(ctx);
			return;
		}

		// The Goal turn is over: evaluate it before deciding whether to continue.
		// The conservative stops come first on purpose: they are decisions about the
		// run itself (activity-free and execution-unavailable bounds), not about the
		// attachments, so an artifact problem must never delay or mask one.
		const stop = safety.evaluateRun(event.outcome);
		closeGoalTurn(ctx);
		if (stop) {
			applySafetyStop(stop, ctx);
			return;
		}

		// Artifact integrity gate: every kickoff and Continuation references the
		// same manifest, so a Goal whose artifacts cannot be verified against it is
		// never continued automatically. The authenticated load reads each artifact
		// once and returns exactly the bytes it verified; the suppression is explicit
		// (the error names what is missing or corrupt and how to restore it), and
		// nothing else moves: the attachments are not silently dropped, the Goal is
		// not completed, and its Lifecycle status is untouched by an artifact problem.
		const contents = goal.attachments?.length
			? loadGoalAttachments(goal, ctx)
			: ({ ok: true, contents: [] } as const);
		if (!contents.ok) {
			notifyAttachmentIntegrityFailure(goal, ctx, contents.problems);
			return;
		}

		// The next run is Goal work, whether Pi starts it for our continuation or
		// for queued work that already satisfies the decision.
		pendingRunKind = "automatic";
		store.beginGoalWork(goal.id);
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: CUSTOM_MESSAGE_TYPE,
					content: formatContinuationMessage(goal, { planTool: planToolRegistered }, contents.contents),
					display: true,
				},
			],
			continue: true,
		};
	});

	/**
	 * Close the Goal turn that just finished: evaluate nothing further, forget its
	 * observations, and break the blocked audit if it reported no blocker.
	 *
	 * Called from the settlement boundary, which is the only place a Goal turn is
	 * known to be over, and from the abort path, where the user has already ended
	 * it more decisively.
	 */
	function closeGoalTurn(ctx: ExtensionContext): void {
		const wasGoalTurn = safety.currentRunKind !== "user";
		const reported = blockerCountedThisRun;
		blockerCountedThisRun = false;
		safety.endTurn();
		if (wasGoalTurn && !reported) {
			// A Goal turn that reported no blocker breaks the blocked audit, so the
			// next report starts a fresh chain instead of resuming an old one.
			reportAuditResetFailure("a Goal turn that reported no blocker", ctx);
		}
		// The admitted Goal turn is over at its settlement boundary, so its
		// ownership segment must not leak into later user actions or runs (e.g. a
		// bare `/goal` edit dialog, or an ordinary prompt before a closing user
		// message is delivered). Continuations reopen their own segment explicitly.
		if (wasGoalTurn) {
			store.endGoalWork();
		}
	}

	/**
	 * Apply a conservative stop: persist the Goal as blocked and tell the user why.
	 *
	 * Called at the end of the Goal run that reached a bound, so the Goal is already
	 * blocked before the settlement boundary could ask for another continuation.
	 */
	function applySafetyStop(stop: SafetyStop, ctx: ExtensionContext): void {
		const goal = store.get();
		if (!goal || goal.status !== "active") return;
		const result = store.stopGoal(pi, { status: "blocked", blocker: stop.blocker, turns: stop.turns });
		if (result.ok) {
			ctx.ui.notify(
				`Goal ${result.goal.id} stopped and is now blocked (${stop.kind}): ${stop.blocker} ` +
					"Automatic continuation has stopped; /goal:resume restarts it with a fresh blocked audit once the " +
					"blocker is resolved.",
				"warning",
			);
			updateStatus(ctx);
			return;
		}
		if (result.reason === "not-active") {
			// The Goal stopped between this boundary's check and the write. Nothing was
			// attempted and nothing failed, so the status is reported rather than a
			// write error — and never with an empty detail.
			const now = store.get();
			ctx.ui.notify(
				`Goal ${goal.id} is ${now?.status ?? "no longer set"}, so the conservative stop (${stop.kind}) ` +
					"changes nothing: a Goal that is not active does not continue automatically.",
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Goal ${goal.id} reached a conservative stop (${stop.kind}) but could not be persisted as blocked ` +
				`(${describeError(result.error)}). The Goal stays ` +
				"active; fix the cause and it will stop again.",
			"error",
		);
	}

	/**
	 * Reset the blocked audit after a user action or a Goal turn that reported no
	 * blocker, and surface a write failure instead of silently dropping the reset.
	 *
	 * Silently keeping a stale audit would let a reload resurrect a count the user
	 * already invalidated, which is exactly what the durable reset exists to
	 * prevent.
	 */
	function reportAuditResetFailure(cause: string, ctx: ExtensionContext): void {
		const result = store.resetBlockedAudit(pi);
		if (result.ok) return;
		ctx.ui.notify(
			`pi-goal could not record the blocked-audit reset after ${cause}: ` +
				`${describeError(result.error)}. The audit stays as it was until the write succeeds.`,
			"error",
		);
	}

	/**
	 * Classify the terminal provider failure that just ended a run.
	 *
	 * A usage limit is evidence-based: only an error that says the account, plan,
	 * or budget is exhausted moves the Goal to `usage_limited`, which is terminal
	 * for continuation. Anything else is surfaced as a warning while the Goal
	 * stays active, so the next successful run resumes it instead of the
	 * extension driving its own retry loop.
	 *
	 * All of that describes an *active* Goal, and only an active Goal reaches it.
	 * A Goal that has already stopped — `blocked`, `usage_limited`,
	 * `budget_limited`, `paused`, `complete` — has no continuation to stop and no
	 * transition to make, so a provider error changes nothing about it. Reporting
	 * such a failure as if the Goal were active would contradict the stop: the Goal
	 * does not "continue on the next successful run", and a usage-limit error on it
	 * is not a failed write, because the store refuses a non-active record with
	 * `not-active` rather than with `persistence`. The status is reported as it is.
	 *
	 * The `budget_limited` case is the one that reaches this path in ordinary use:
	 * the run that failed may be the one bounded wrap-up, and the Goal stays
	 * `budget_limited` whether or not that run completed.
	 */
	function handleProviderFailure(goal: GoalRecord, ctx: ExtensionContext): void {
		const failure = classifyProviderFailure(providerFailure ?? {});
		if (goal.status !== "active") {
			ctx.ui.notify(
				`Goal ${goal.id} is ${goal.status}, so the provider failure (${failure.evidence}) changes nothing: ` +
					"a Goal that is not active does not continue automatically, and this one keeps its status. " +
					"Nothing was written and nothing was lost.",
				"warning",
			);
			return;
		}
		if (failure.kind === "usage-limit") {
			const result = store.stopGoal(pi, {
				status: "usage_limited",
				blocker:
					`The provider reported a usage limit (${failure.evidence}), so this Goal cannot continue until the ` +
					"limit is resolved and a user resumes it.",
				turns: 0,
			});
			if (result.ok) {
				ctx.ui.notify(
					`Goal ${result.goal.id} is now usage_limited: the provider reported a usage limit ` +
						`(${failure.evidence}). Automatic continuation has stopped; /goal:resume restarts it once the ` +
						"limit is resolved" +
						// The stop itself is a lifecycle write and still lands, but the resume it
						// names is admission: saying it restarts the Goal without qualification
						// would promise a command the disabled extension refuses.
						(admission.enabled
							? ", because a usage-limited Goal never continues on its own."
							: ", but pi-goal is disabled (goal.enabled is false), so that resume is refused until the setting is " +
								"re-enabled; a usage-limited Goal never continues on its own."),
					"warning",
				);
				updateStatus(ctx);
				return;
			}
			if (result.reason === "not-active") {
				// The Goal stopped between this boundary's check and the write — a
				// lifecycle command landed in between. Nothing was attempted and nothing
				// failed, so the status is reported rather than a write error.
				const now = store.get();
				ctx.ui.notify(
					`Goal ${goal.id} is ${now?.status ?? "no longer set"}, so the provider usage limit ` +
						`(${failure.evidence}) changes nothing: a Goal that is not active does not continue ` +
						"automatically.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Goal ${goal.id} hit a provider usage limit (${failure.evidence}) but the Goal could not be ` +
						`persisted as usage_limited (${describeError(result.error)}). The Goal stays ` +
					"active; fix the cause and it will stop again on the next failure.",
				"error",
			);
			return;
		}
		ctx.ui.notify(
			`Goal ${goal.id} is still active, but automatic continuation stopped for this run: the provider failed ` +
				`and Pi is not retrying it (${failure.evidence}). ` +
				// The Goal itself is unchanged, but promising the next successful run
				// continues it is false while `goal.enabled` is false: that run settles at
				// the admission gate and admits nothing. Name the disabled condition the
				// way the settlement suppression does instead.
				(admission.enabled
					? "The Goal continues on the next successful run."
					: "pi-goal is disabled (goal.enabled is false), so no continuation is admitted either: the Goal keeps its " +
							"active status and keeps accruing active time, and /goal:pause, not disabling the extension, stops that " +
							"clock. Re-enable goal.enabled to admit Goal work again."),
			"warning",
		);
	}

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Get the current session Goal: objective, title, lifecycle status, revision, token budget, accounted " +
			"usage, remaining capacity, active time, and the open blocked audit's Blocker identity, latest " +
			"description, and count. Returns goal: null when no Goal is set.",
		parameters: Type.Object({}),
		outputSchema: getGoalOutputSchema,
		promptSnippet: "Fetch the current session Goal objective, title, lifecycle status, and budget",
		promptGuidelines: [
			"Use get_goal when the session Goal objective or its lifecycle status is absent or truncated in the current context.",
			"Check get_goal's usage.remainingTokens before starting expensive work: a Goal that reaches its token budget becomes budget_limited and stops continuing.",
			"Call get_goal before re-reporting a blocker: it carries the open audit's Blocker identity, which update_goal's blocker_id must repeat verbatim for the same condition. The extension never compares blocker text.",
		],
		async execute() {
			const goal = store.get();
			if (!goal) {
				return {
					content: [{ type: "text", text: formatNoGoal(admission.enabled) }],
					structuredContent: { goal: null },
					details: { goal: null as GoalPublicState | null },
				};
			}
			const state = toPublicState(goal);
			// The model-facing text carries the open audit's identity on top of the
			// human-facing summary: reusing it is the only way a reworded report advances
			// the audit, and this is the tool the model reads it from. The human status
			// deliberately does not show the opaque identity.
			const identity =
				state.blockerId === null
					? ""
					: `\nBlocker identity: ${state.blockerId} (pass it back verbatim in update_goal's blocker_id for the ` +
						"same condition; omit it for a genuinely different one)";
			return {
				content: [{ type: "text", text: `${formatGoalSummary(state, { admissionEnabled: admission.enabled })}${identity}` }],
				structuredContent: { goal: state },
				details: { goal: state },
			};
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a persistent Goal for an explicit user or system request. " +
			"Requires user_request: the exact words of the request, quoted verbatim from the raw interactive/RPC " +
			"user message or Pi custom message that started this execution. The quote is corroborated at execution " +
			"time against that source, so a paraphrase, a fragment, a forged request, or a request from an earlier " +
			"message is refused with goal: null. Refuses when this session already has a Goal, and refuses a token " +
			"budget above the configured maximum.",
		parameters: Type.Object({
			objective: Type.String({ minLength: MIN_OBJECTIVE_LENGTH, maxLength: MAX_OBJECTIVE_LENGTH }),
			tokenBudget: Type.Optional(
				Type.Integer({
					minimum: MIN_TOKEN_BUDGET,
					description:
						"Optional token budget for this Goal. Omit it to use the extension default. " +
						"Reaching it makes the Goal budget_limited, which stops continuation and is not completion.",
				}),
			),
			userRequest: Type.Optional(
				Type.String({
					description:
						"Required for creation: the exact words of the explicit Goal-creation request, quoted verbatim " +
						"from the currently authoritative raw interactive/RPC user message or Pi custom message (for example " +
						'"please create a goal for the release"). The quote is corroborated against that source; a paraphrase, ' +
						"a keyword, a fragment, a mention, a question, a hypothetical, a negation, or a request from an earlier " +
						"message is refused. The objective remains model-written and need not repeat the quotation.",
				}),
			),
		}),
		outputSchema: getGoalOutputSchema,
		promptSnippet: "Create a persistent session Goal from an explicit user or system request",
		promptGuidelines: [
			"Call create_goal only when the user or the system explicitly asked for a Goal. Never infer one because a task looks large.",
			"Pass user_request with the exact words of the explicit Goal-creation request, quoted verbatim from the raw interactive/RPC user message or Pi custom message that started this execution. The quote is corroborated against that source; a paraphrase, a fragment, or an older message is refused with goal: null.",
			"Do not call create_goal while this session already has a Goal; it is refused. Use get_goal to inspect the current Goal instead.",
			"Only set tokenBudget when the user asked for a specific budget; otherwise omit it and let the configured default apply.",
		],
		/**
		 * Accept the snake_case spelling a model drifts into, matching update_goal's
		 * `user_request` compatibility shim. The canonical spelling is camelCase.
		 */
		prepareArguments: (args: unknown): { objective: string; tokenBudget?: number; userRequest?: string } => {
			if (typeof args !== "object" || args === null) return { objective: "" };
			const record = args as Record<string, unknown>;
			const objective = typeof record.objective === "string" ? record.objective : "";
			const tokenBudget = typeof record.tokenBudget === "number" ? record.tokenBudget : undefined;
			const rawRequest = record.userRequest ?? record.user_request;
			const userRequest = typeof rawRequest === "string" ? rawRequest : undefined;
			return {
				objective,
				...(tokenBudget === undefined ? {} : { tokenBudget }),
				...(userRequest === undefined ? {} : { userRequest }),
			};
		},
		async execute(
			_toolCallId: string,
			params: { objective: string; tokenBudget?: number; userRequest?: string },
			_signal,
			_onUpdate,
			ctx,
		) {
			// Admission control first: a disabled extension refuses before it validates
			// anything, and the refusal leaves the Goal (if any) and the one-shot
			// creation authority untouched, so a corrected call can still retry after
			// the setting is re-enabled.
			if (!admission.enabled) {
				return admissionDisabledToolError("Goal not created:");
			}
			const validation = validateObjective(String(params.objective ?? ""));
			if (!validation.ok) {
				return goalToolError(validation.error, null);
			}
			const budget = resolveGoalTokenBudget(params.tokenBudget, budgetSettings);
			if (!budget.ok) {
				return goalToolError(budget.error, null);
			}
			// A Goal is durable session state, so it needs a session that persists.
			// Refuse loudly instead of promising a restart survival that cannot happen.
			if (!store.isPersistentSession(ctx)) {
				return goalToolError(
					"Goal not created: this session is ephemeral (--no-session), so a Goal could not be " +
						"restored after a restart. Ask the user to start Pi with a persisted session.",
					null,
				);
			}
			const existing = store.get();
			if (existing) {
				// A Goal of any status, including a complete one, still occupies the
				// session's single Goal slot, and only the user changes that slot: an
				// unfinished Goal refuses /goal <objective> (one session works one Goal
				// at a time), a complete one is superseded by it without confirmation,
				// and /goal:clear removes either.
				return goalToolError(
					"A Goal is already set for this session (status: " +
						`${existing.status}); cannot create another one. ` +
						"Use get_goal to inspect it, or update_goal to complete it. Only the user can replace " +
						"or clear a Goal, with /goal <objective> (a complete Goal only) or /goal:clear.",
					toPublicState(existing),
				);
			}
			// Execution-time creation authority. The request must be corroborated
			// against the one currently authoritative source; a missing, forged,
			// stale, non-explicit, or ambiguous quote is refused with goal: null and
			// no state change. A rejection does not consume the authority, so a
			// corrected call can retry while the same request remains valid.
			if (!creationAuthority) {
				return goalToolError(
					"Goal not created: no explicit user or system request is currently authoritative. " +
					"create_goal may be called only in the execution started by a raw interactive/RPC user message " +
					"or a Pi custom message. Ask the user to make the request, or use /goal <objective>.",
					null,
				);
			}
			const quote = typeof params.userRequest === "string" ? params.userRequest : "";
			const corroboration = corroborateGoalCreationRequest(creationAuthority.text, quote);
			if (!corroboration.ok) {
				return goalToolError(goalCreationAuthorityError(corroboration, quote), null);
			}
			const goal = store.create(validation.objective, "tool", { tokenBudget: budget.tokenBudget });
			// A superseded identity's open tail must be durable before a new Goal takes the
			// session's Goal slot: creating a Goal leaves no marker of its own on the
			// branch, so replay only closes that admission at a durable freeze. Refuse
			// rather than lose admitted work or let the two paths disagree about it.
			if (!store.closeSupersededForCreation(pi)) {
				return goalToolError(
					"Goal not created: the replaced Goal's admitted work could not be written to the session. " +
						"Nothing was stored.",
					null,
				);
			}
			try {
				// Stage before announcing: a write failure here abandons creation with no
				// visible state change, and the attempt can simply be retried.
				store.stage(pi, goal);
				store.commit(goal);
				// A new Goal identity starts every audit from zero: counters left
				// over from a replaced Goal describe work that no longer exists.
				safety.reset();
			} catch (error) {
				store.rollback(pi);
				const reason = error instanceof Error ? error.message : String(error);
				return goalToolError(`Goal not created: ${reason}`, null);
			}
			// A successful creation consumes the one-shot authority. The Goal now
			// occupies the session's single slot, so a second call is refused anyway,
			// but clearing the authority also prevents a replayed model request from
			// being treated as fresh evidence.
			clearCreationAuthority();
			// A Goal now owns the slot a pending clarification's draft was started
			// against. Retire the leftover entry durably; the draft's recorded base
			// identity already makes it unofferable if this write is lost to a crash.
			endSupersededPendingClarification(ctx);
			// The tool path is always a fresh creation — it refuses while any Goal
			// exists — so a committed creation may name an unnamed session here too,
			// exactly like the command's. The failure paths above returned before this
			// point, so a rolled-back creation never names anything.
			nameSessionFromGoal(ctx, goal);
			// No separate durability poll is needed here, unlike the /goal command whose
			// kickoff is what creates the session file: a tool call implies a running
			// session whose file already exists, and appendEntry writes synchronously
			// and throws on failure. The existing-Goal guard, the stage, and the commit
			// above also contain no await, so two create_goal calls issued in one
			// assistant turn cannot both pass the guard. The committed creation was
			// announced on the event stream by the store's commit.
			updateStatus(ctx);
			const state = toPublicState(goal);
			return {
				content: [{ type: "text", text: `Goal ${goal.id} created and activated.` }],
				structuredContent: { goal: state },
				details: { goal: state },
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the current Goal. Supported actions: \"complete\" after an evidence-based completion audit, " +
			"\"blocked\" while the same genuine blocker persists across consecutive Goal turns (identify it with " +
			"blocker_id, which pi-goal issues on the first report and which reworded reports must pass back), " +
			"and \"pause\" after an explicit user request, which must be quoted verbatim in user_request. " +
			"Complete and blocked are terminal: they stop the Goal's automatic continuation. " +
			"The model cannot resume, clear, replace, budget-limit, or raise the token budget of a Goal.",
		parameters: Type.Object({
			action: Type.String({
				description:
					"complete, blocked, or pause. Pause requires user_request quoting the user's exact request; " +
					"resume and clear are user-owned (/goal:resume, /goal:clear).",
			}),
			blocker: Type.Optional(
				Type.String({
					description:
						`Required for action blocked: the genuine blocker in plain language (${MIN_BLOCKER_LENGTH}-${MAX_BLOCKER_LENGTH} characters). ` +
						"Say what is actually blocking the work and what would unblock it.",
				}),
			),
			blocker_id: Type.Optional(
				Type.String({
					description:
						"The Blocker identity of the condition being reported, for action blocked. Omit it for the first " +
						"report of a condition and pi-goal issues one; pass the current identity back verbatim on every " +
						"later report of that same condition, so differently worded descriptions still advance the " +
						"blocked audit. Omitting it reports a genuinely different condition and starts a fresh chain at " +
						"one. An identity the extension did not issue for the currently open audit is refused without " +
						"changing the Goal. The extension never compares blocker text.",
				}),
			),
			userRequest: Type.Optional(
				Type.String({
					description:
						"Required for pause: the user's exact words explicitly requesting the pause, " +
						"quoted verbatim from their message (for example \"please pause the goal\"). " +
						"The quote is verified against the user's recent messages.",
				}),
			),
		}),
		outputSchema: updateGoalOutputSchema,
		promptSnippet:
			"Mark the current Goal complete after an evidence audit, blocked after a persistent blocker, or paused at the user's explicit request",
		promptGuidelines: [
			"Call update_goal with action complete only after every explicit requirement of the objective is verified by current-state evidence.",
			`Call update_goal with action blocked on every Goal turn in which a genuine blocker persists, from the first turn onward; never wait until ${BLOCKED_AUDIT_THRESHOLD} consecutive turns have passed before reporting one. Never report a blocker merely because the work is hard, slow, uncertain, or incomplete.`,
			"Report the blocker on every Goal turn it persists: the first report omits blocker_id and pi-goal issues an opaque Blocker identity, and every later report of that same condition passes it back verbatim. Omit it only for a genuinely different condition.",
			"Never guess or reuse an old Blocker identity: call get_goal for the current one. The extension never compares blocker text, so wording alone can never advance the blocked audit.",
			"Completing or blocking a Goal stops its automatic continuation, so never use either to escape a difficult or merely tiring task.",
			"Call update_goal with action pause only when the user explicitly asked to pause this Goal, and quote their exact words in user_request. Never pause on your own initiative.",
			"Never call update_goal to resume or clear a Goal; the user owns those transitions, and a budget-raising resume is /goal:resume --budget <new-total>.",
		],
		/**
		 * Compatibility shim for the spellings a model reaches for: `{ status: … }`
		 * and `{ complete: true }` / `{ blocked: true }` / `{ paused: true }`. Without
		 * it a drifted call fails schema validation, the model sees only an arguments
		 * error, and the Goal keeps burning turns. Anything else is passed through
		 * with an empty action so an unsupported action is refused with a real
		 * explanation instead of being silently ignored.
		 *
		 * `blocker_id` gets the same treatment as `user_request`: the canonical
		 * spelling is snake_case — the one the tool description, the guidelines, and
		 * every Continuation use — and the camelCase a model drifts into is accepted
		 * too.
		 */
		prepareArguments: (
			args: unknown,
		): { action: string; blocker?: string; blockerId?: string; userRequest?: string } => {
			if (typeof args !== "object" || args === null) return { action: "" };
			const record = args as Record<string, unknown>;
			const blocker = typeof record.blocker === "string" ? record.blocker : undefined;
			const rawBlockerId = record.blocker_id ?? record.blockerId;
			const blockerId = typeof rawBlockerId === "string" ? rawBlockerId : undefined;
			const rawRequest = record.userRequest ?? record.user_request;
			const userRequest = typeof rawRequest === "string" ? rawRequest : undefined;
			const withBlocker = (action: string) => ({
				action,
				...(blocker === undefined ? {} : { blocker }),
				...(blockerId === undefined ? {} : { blockerId }),
				...(userRequest === undefined ? {} : { userRequest }),
			});
			if (record.action !== undefined) return withBlocker(String(record.action));
			if (record.status === "complete" || record.complete === true) return withBlocker("complete");
			if (record.status === "blocked" || record.blocked === true) return withBlocker("blocked");
			if (record.status === "paused" || record.paused === true) return withBlocker("pause");
			return withBlocker("");
		},
		async execute(
			_toolCallId: string,
			params: { action: string; blocker?: string; blockerId?: string; userRequest?: string },
			_signal,
			_onUpdate,
			ctx: ExtensionToolContext,
		) {
			const goal = store.get();
			if (!goal) {
				return goalToolError(formatNoGoal(admission.enabled), null);
			}
			/**
			 * Refuse a call whose decision was prepared against a different Goal
			 * state. The binding is the Goal identity and revision the execution this
			 * call belongs to was admitted against, so a held response released after a
			 * user edit / replacement / pause / resume — and a follow-up turn of a run
			 * whose Goal was cleared or replaced while it was in flight — is refused
			 * instead of mutating a Goal the model never saw.
			 */
			const staleRefusal = (binding: GoalBinding | null) => {
				if (!binding) {
					return goalToolError(
						"update_goal cannot verify which Goal revision this call was prepared against; " +
							"call get_goal to inspect the current state and try again.",
						toPublicState(goal),
					);
				}
				return goalToolError(
					"Goal not updated: this call was prepared against a Goal state that has since changed " +
						`(expected ${binding.id} revision ${binding.revision}, current ${goal.id} revision ${goal.revision}). ` +
						"The user may have edited, replaced, paused, or resumed the Goal while your response was in flight. " +
						"Call get_goal, re-read the current objective, and re-audit before completing or pausing.",
					toPublicState(goal),
				);
			};
			if (params?.action === "blocked") {
				// The blocker report is bound exactly like `complete` and `pause`: a
				// report whose execution holds no Goal binding belongs to a run admitted
				// before any Goal existed, so it must not mutate a Goal the model never
				// saw. A run whose own `create_goal` built the Goal is re-admitted at its
				// next `turn_start`, because the tool result is what showed it that Goal.
				// The revision is left to `markBlockedReport`, which must still read a
				// repeated report inside one Goal turn as one audit step.
				if (!turnGoal || goal.id !== turnGoal.id) {
					return staleRefusal(turnGoal);
				}
				return reportBlocker(goal, params.blocker, params.blockerId, ctx);
			}
			const reportMutationFailure = (action: string, failure: GoalMutationFailure) => {
				if (failure.reason === "persistence") {
					return goalToolError(
						`Goal not ${action}: writing the Goal to the session failed (${describeError(failure.error)}). ` +
							"The Goal is unchanged; fix the cause and try again.",
						toPublicState(goal),
					);
				}
				return goalToolError(`Goal could not be ${action}: ${failure.message}.`, toPublicState(goal));
			};
			if (params?.action === "complete") {
				if (!turnGoal || goal.id !== turnGoal.id || goal.revision !== turnGoal.revision) {
					return staleRefusal(turnGoal);
				}
				const completed = store.markComplete(pi, turnGoal);
				if (!completed.ok) {
					// Distinguish a lifecycle refusal from a persistence failure: the Goal
					// is still active in the second case, and saying otherwise would hide a
					// real durability problem behind a lifecycle message.
					return reportMutationFailure("marked complete", completed);
				}
				const state = toPublicState(completed.goal!);
				updateStatus(ctx);
				// A budgeted completion asks the final response to report its cost and
				// duration. The numbers come from the completion snapshot above, so the
				// reminder costs no extra provider turn and no extra accounting, and an
				// unbudgeted Goal gets no report at all.
				const completionReport = buildCompletionReport(state);
				const payload = {
					goal: state,
					...(completionReport === null ? {} : { completionReport }),
				};
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Goal ${completed.goal!.id} marked complete.` +
								(completionReport === null ? "" : `\n\n${completionReport.instruction}`) +
								admissionDisabledUpdateCondition(state.status),
						},
					],
					structuredContent: payload,
					details: payload,
				};
			}
			if (params?.action === "pause") {
				if (goal.status !== "active") {
					return goalToolError(
						`Goal could not be paused: ${goal.status === "paused" ? "it is already paused" : `only an active Goal can be paused (current status: ${goal.status})`}.`,
						toPublicState(goal),
					);
				}
				if (!turnGoal || goal.id !== turnGoal.id || goal.revision !== turnGoal.revision) {
					return staleRefusal(turnGoal);
				}
				const quote = typeof params.userRequest === "string" ? params.userRequest : "";
				if (quote.trim().length < MIN_USER_REQUEST_LENGTH) {
					return goalToolError(
						"update_goal can pause a Goal only after an explicit user request. " +
							'Pass user_request with the user\'s exact words (for example "please pause the goal") ' +
							"so the request can be verified against their messages. If the user has not asked, " +
							"keep working; the user can also pause directly with /goal:pause.",
						toPublicState(goal),
					);
				}
				const corroboration = corroboratePauseRequest(ctx.sessionManager.getBranch(), quote);
				if (!corroboration.ok) {
					if (corroboration.reason === "quote-not-request") {
						return goalToolError(
							"update_goal could not verify an explicit pause request: the quoted text is not itself a " +
								`pause request (${JSON.stringify(previewObjective(quote, 120))} does not name pausing). Quote ` +
								'the user\u2019s actual instruction \u2014 the sentence in which they ask to pause, for example ' +
								'"please pause the goal" \u2014 not an incidental fragment of something else they wrote.',
							toPublicState(goal),
						);
					}
					if (corroboration.reason === "not-an-instruction") {
						return goalToolError(
							"update_goal could not verify an explicit pause request: the quote was found, but the " +
								'user\u2019s message is not an affirmative pause instruction \u2014 it is negated ("do not pause"), ' +
								'a keep-working or resume instruction, a deferral ("not now"), or a later user message ' +
								"supersedes the request. If the user does want a pause they can run /goal:pause; otherwise keep working.",
							toPublicState(goal),
						);
					}
					return goalToolError(
						"update_goal could not verify an explicit user request to pause this Goal: no recent " +
							`user message contains ${JSON.stringify(previewObjective(quote, 200))}. ` +
							"If the user did ask, repeat the call quoting their exact words in user_request; " +
							"otherwise keep working. Pausing also stays available to the user as /goal:pause.",
						toPublicState(goal),
					);
				}
				const paused = store.markPaused(pi, turnGoal);
				if (!paused.ok) {
					return reportMutationFailure("paused", paused);
				}
				ctx.ui.notify(
					`Goal ${goal.id} paused at the model's request; the quoted request was verified against the user's messages. No further automatic Goal runs will start.`,
					"info",
				);
				updateStatus(ctx);
				const state = toPublicState(paused.goal!);
				return {
					content: [
						{
							type: "text",
							text:
								`Goal ${goal.id} paused at the user's explicit request (verified). ` +
								"Report the pause and the current progress, then stop Goal work for this turn; " +
								(admission.enabled
									? "the user restarts work with /goal:resume."
									: "the user restarts work with /goal:resume once pi-goal is re-enabled.") +
								admissionDisabledUpdateCondition(state.status),
						},
					],
					structuredContent: { goal: state },
					details: { goal: state },
				};
			}
			return goalToolError(
				"update_goal supports only action complete, action blocked with a plain-language blocker, " +
					"and action pause after an explicit user request (quote it in user_request). " +
					"Resuming and clearing stay with the user (/goal:resume, /goal:clear).",
				toPublicState(goal),
			);
		},
	});

	/**
	 * Record a blocker the model reported, and enforce the blocked audit.
	 *
	 * The extension — not the model — decides when the audit is satisfied, so an
	 * eager or drifted `blocked` call cannot end a Goal that has only seen a
	 * blocker once. Before the threshold the report is persisted (making the audit
	 * durable across compaction and a session restore) and refused with the current
	 * count, which is also what tells the model to keep working.
	 *
	 * The refusal carries the open audit's Blocker identity, latest description,
	 * and count, because that is the only way the model can report the *same*
	 * condition on the next turn: it must pass the identity back in `blocker_id`.
	 * The extension never compares blocker text, so a refusal that omitted the
	 * identity would leave a reworded repetition unable to advance the audit.
	 */
	function reportBlocker(
		goal: GoalRecord,
		rawBlocker: string | undefined,
		rawBlockerId: string | undefined,
		ctx: ExtensionToolContext,
	) {
		const validation = validateBlocker(String(rawBlocker ?? ""));
		if (!validation.ok) {
			return goalToolError(
				`${validation.error} Call update_goal with action "blocked" and a blocker describing what is ` +
					"actually preventing progress and what would unblock it.",
				toPublicState(goal),
			);
		}
		const result = store.markBlockedReport(
			pi,
			{
				blocker: validation.blocker,
				...(rawBlockerId === undefined ? {} : { blockerId: rawBlockerId }),
				turn: safety.currentTurn,
			},
			turnGoal ?? undefined,
		);
		if (result.ok && !result.repeat) blockerCountedThisRun = true;
		if (!result.ok) {
			if (result.reason === "not-current") {
				const current = store.get();
				return goalToolError(result.message, current ? toPublicState(current) : null);
			}
			if (result.reason === "stale") {
				const current = store.get();
				return goalToolError(
					"Blocker not recorded: this call was prepared against a Goal state that has since changed " +
						`(expected ${turnGoal?.id ?? "unknown"} revision ${turnGoal?.revision ?? "unknown"}, ` +
						`current ${current?.id ?? "none"} revision ${current?.revision ?? "none"}). ` +
						"Call get_goal, re-read the current objective, and report again if the blocker persists.",
					current ? toPublicState(current) : null,
				);
			}
			const message =
				result.reason === "persistence"
					? `Blocker not recorded: writing the Goal to the session failed (${describeError(result.error)}). The Goal is still active; fix the cause and call update_goal again.`
					: "Blocker not recorded: no active Goal to block.";
			return goalToolError(message, toPublicState(goal));
		}
		const state = toPublicState(result.goal);
		// The model-facing identity line: reuse this verbatim for the same condition,
		// omit it for a genuinely different one. It is deliberately *not* part of the
		// human-facing status, where the opaque identity says nothing useful.
		const identity = state.blockerId
			? `Blocker identity ${state.blockerId}: pass it back verbatim in blocker_id on every later report of ` +
				"this same condition, so a reworded description still advances the audit. Omit it only to report a " +
				"genuinely different condition. "
			: "";
		if (result.thresholdMet) {
			ctx.ui.notify(
				`Goal ${result.goal.id} is now blocked: ${validation.blocker} ` +
					`(the same blocker for ${result.turns} consecutive Goal turns). Automatic continuation has stopped; ` +
					"resolving the blocker and running /goal:resume is a user decision, and the resume starts a fresh audit.",
				"warning",
			);
			updateStatus(ctx);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Goal ${result.goal.id} is blocked after the same blocker persisted for ${result.turns} ` +
							"consecutive Goal turns. Automatic continuation has stopped. Report to the user what is " +
							"blocking the work and what would unblock it; /goal:resume restarts it with a fresh blocked audit" +
							(admission.enabled ? "." : " once pi-goal is re-enabled.") +
							admissionDisabledUpdateCondition(state.status),
					},
				],
				structuredContent: { goal: state },
				details: { goal: state },
			};
		}
		// A repeat inside the same Goal turn must read as one audit step, not as
		// progress toward the threshold, or a model that retries its own tool call
		// could talk itself into a blocked Goal inside a single turn.
		const counted = result.repeat
			? `This blocker was already recorded for the current Goal turn (${result.turns} of ${BLOCKED_AUDIT_THRESHOLD} consecutive Goal turns), so it was not counted again.`
			: `Blocker recorded (${result.turns} of ${BLOCKED_AUDIT_THRESHOLD} consecutive Goal turns).`;
		return goalToolError(
			`${counted} ${identity}The Goal stays active: the same genuine blocker must persist for at least ` +
				`${BLOCKED_AUDIT_THRESHOLD} consecutive Goal turns before it may be marked blocked, so a transient ` +
				"failure cannot stop useful work. " +
				(result.turns > 1
					? `The blocker on record for this Goal is: ${result.goal.blockedAudit?.blocker ?? validation.blocker}. `
					: "") +
				"Re-verify against the current state, take the next available safe action, and report again only if " +
				"the same blocker persists. Never report a blocker because the work is hard, slow, uncertain, or " +
				"incomplete." +
				admissionDisabledUpdateCondition(state.status),
			state,
		);
	}

	/**
	 * The `/goal` command: inspect when bare, create with an Objective.
	 *
	 * Both the registered user command and the in-process command bridge reach it
	 * through {@link runGoalCommand} with the same argument text, so a bridged
	 * command *is* the command the user sees: the same parsing, the same
	 * unfinished-Goal refusal, the same `goal.enabled` gate, the same
	 * Token-budget validation, and the same durable-before-announced ordering.
	 * Nothing downstream can tell the difference, which is the point — a second
	 * entry point that re-used the lifecycle helpers instead would be a second
	 * lifecycle path.
	 */
	async function handleGoalCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const command = parseGoalCommand(args);
		switch (command.kind) {
			case "status":
				// A bare status read is not a lifecycle operation and leaves any
				// model-held creation authority alone.
				await reportStatus(ctx);
				return;
			case "invalid":
				// The reserved-word guard: nothing was asked of the Goal, so nothing
				// is cleared either — the message only names the command to type.
				ctx.ui.notify(command.message, "error");
				return;
			case "create":
				// A creation is a user decision that supersedes any model-held
				// creation authority, before anything about the creation is validated.
				clearCreationAuthority();
				await createOrReplaceGoal(command.objective, ctx);
				return;
		}
	}

	/**
	 * Refuse a stray argument on a verb command that takes none.
	 *
	 * `/goal:pause foo` must not half-apply a lifecycle action: the extra text is
	 * neither an Objective nor an option, so the verb reports its usage and touches
	 * no Goal — no snapshot, no transition, no history record. An Objective belongs
	 * after `/goal`, and the verb commands are how the lifecycle is reached.
	 */
	function refuseVerbArgument(
		ctx: ExtensionCommandContext,
		name: "goal:pause" | "goal:clear" | "goal:history",
		args: string,
	): boolean {
		if (args.trim() === "") return false;
		ctx.ui.notify(`/${name} takes no argument.`, "error");
		return true;
	}

	async function handleGoalPauseCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (refuseVerbArgument(ctx, "goal:pause", args)) return;
		// A pause is a user decision that supersedes any model-held creation authority.
		clearCreationAuthority();
		pauseGoal(ctx);
	}

	/**
	 * `/goal:resume [--budget <new-total> | --budget=<new-total>]`.
	 *
	 * The budget option is parsed exactly as it always was — both spellings, the
	 * positive-headroom and maximum rules, and the refusal texts live in
	 * {@link parseResumeBudget} and {@link resumeGoal} — and it is the only argument
	 * the command accepts. Anything else is the command's usage, reported the same
	 * way, with the Goal untouched.
	 */
	async function handleGoalResumeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const budget: ResumeBudgetRequest | { error: string } = trimmed === "" ? { kind: "none" } : parseResumeBudget(trimmed);
		if ("error" in budget) {
			ctx.ui.notify(budget.error, "error");
			return;
		}
		clearCreationAuthority();
		resumeGoal(ctx, budget);
	}

	async function handleGoalClearCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (refuseVerbArgument(ctx, "goal:clear", args)) return;
		clearCreationAuthority();
		clearGoal(ctx);
	}

	/** `/goal:history` is read-only: it renders durable state and clears no authority. */
	async function handleGoalHistoryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (refuseVerbArgument(ctx, "goal:history", args)) return;
		reportHistory(ctx);
	}

	/**
	 * `/goal:edit`: the typed edit with an argument, the prefilled editor without.
	 *
	 * The argument is an optional leading `--title <text>` option and/or the new
	 * objective. A title-only edit changes just the Goal's label; adding an
	 * objective changes both in the same revision. An edit cannot change
	 * attachments: the immutable manifest is retained, so an argument whose flag
	 * position could start an attachment option is refused with Replacement Goal
	 * guidance instead of silently becoming part of the objective or title.
	 */
	async function handleGoalEditCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseGoalEditArgs(args);
		if (parsed.kind === "refused") {
			ctx.ui.notify(parsed.message, "error");
			return;
		}
		// An edit is a user decision that supersedes any model-held creation authority.
		clearCreationAuthority();
		if (parsed.kind === "editor") {
			// Bare `/goal:edit` opens Pi's multi-line editor prefilled with the
			// current objective. The typed form stays available for headless modes
			// and for hosts without a dialog-capable UI.
			await editGoalInteractively(ctx);
			return;
		}
		editGoal(parsed, ctx);
	}

	/** Every command of the Goal command family, by the name Pi dispatches it under. */
	const goalCommandHandlers: Record<GoalCommandName, (args: string, ctx: ExtensionCommandContext) => Promise<void>> = {
		goal: handleGoalCommand,
		"goal:pause": handleGoalPauseCommand,
		"goal:resume": handleGoalResumeCommand,
		"goal:clear": handleGoalClearCommand,
		"goal:history": handleGoalHistoryCommand,
		"goal:edit": handleGoalEditCommand,
	};

	/**
	 * Run one command of the Goal command family by name.
	 *
	 * The registered handlers and the in-process command bridge share this door,
	 * so there is exactly one way a Goal command runs and the bridge cannot drift
	 * from what the user types. A throw never escapes into Pi or the event bus: it
	 * is reported through the same notification channel the handler uses, which a
	 * bridged command's recording context captures as a diagnostic.
	 */
	async function runGoalCommand(name: GoalCommandName, args: string, ctx: ExtensionCommandContext): Promise<void> {
		try {
			await goalCommandHandlers[name](args, ctx);
		} catch (error) {
			ctx.ui.notify(`pi-goal error: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}


	/**
	 * Prefix-filtered argument completions for a Goal command.
	 *
	 * Pi calls this with the text typed after the command name and falls back to
	 * its own default behavior (file-path completion) when nothing matches, so no
	 * match is an empty list rather than a guess. Only the two commands with a
	 * fixed vocabulary complete: `/goal ` offers the creation options and
	 * `/goal:resume ` offers `--budget`; an Objective is free text and completes
	 * nothing.
	 */
	function completeGoalFlags(flags: readonly string[], prefix: string): { value: string; label: string }[] {
		return flags.filter((flag) => flag.startsWith(prefix)).map((flag) => ({ value: flag, label: flag }));
	}

	/**
	 * Register the Goal command family.
	 *
	 * Six commands sharing the `goal` namespace, after Pi's own `/skill:name`
	 * convention: `/goal` keeps its two meanings (create with an Objective, inspect
	 * without one) and each verb is its own `/` menu line with its own description,
	 * so the menu itself teaches the lifecycle and an Objective is only ever the
	 * argument of `/goal`. Pi dispatches on the text before the first space, so
	 * nothing here needs a subcommand parser. There is no `/goal:status` and no
	 * `/goal:create`: bare `/goal` already is the status report and `/goal
	 * <objective>` already is the creation.
	 */
	pi.registerCommand("goal", {
		description: "Create (/goal <objective>) or inspect (bare /goal) the session Goal",
		getArgumentCompletions: (prefix) => completeGoalFlags(GOAL_CREATION_FLAGS, prefix),
		handler: (args, ctx) => runGoalCommand("goal", args, ctx),
	});
	pi.registerCommand("goal:pause", {
		description: "Pause the session Goal: no further automatic Goal runs start, and work in flight finishes",
		handler: (args, ctx) => runGoalCommand("goal:pause", args, ctx),
	});
	pi.registerCommand("goal:resume", {
		description:
			"Restart a paused, blocked, usage_limited, or budget_limited Goal (--budget <new-total> raises a " +
			"budget_limited Goal's ceiling)",
		getArgumentCompletions: (prefix) => completeGoalFlags(["--budget"], prefix),
		handler: (args, ctx) => runGoalCommand("goal:resume", args, ctx),
	});
	pi.registerCommand("goal:clear", {
		description: "Clear the session Goal with a durable tombstone and return to ordinary prompt behavior",
		handler: (args, ctx) => runGoalCommand("goal:clear", args, ctx),
	});
	pi.registerCommand("goal:history", {
		description: "Render the session's read-only Goal audit history",
		handler: (args, ctx) => runGoalCommand("goal:history", args, ctx),
	});
	pi.registerCommand("goal:edit", {
		description:
			"Edit the session Goal in place: /goal:edit <objective>, /goal:edit --title <text>, or bare /goal:edit for the editor",
		getArgumentCompletions: (prefix) => completeGoalFlags(["--title"], prefix),
		handler: (args, ctx) => runGoalCommand("goal:edit", args, ctx),
	});

	/**
	 * Whether Pi still lists `/name` among the commands it can dispatch.
	 *
	 * A request's `name` is validated against the family before anything runs, and
	 * every member is registered when the extension loads, so this is the belt to
	 * that brace: a name that is valid for the protocol but is not a registered
	 * command at dispatch time is answered `invalid` instead of run, because the
	 * command the user could type and the command the bridge would run would then
	 * be two different things. Pi's own command list is the registry of truth.
	 */
	function isGoalCommandRegistered(name: GoalCommandName): boolean {
		return pi.getCommands().some((command) => command.name === name);
	}

	/**
	 * Answer one bridge request by running the same Goal command the user would.
	 *
	 * The result is built from three facts and no guesses: the durable transitions
	 * the store announced during the command, the diagnostics the command reported
	 * (recorded by wrapping its UI, not by parsing text), and the public state
	 * afterwards. "Committed" additionally requires that the recorded transition is
	 * the *current* Goal identity (or, for a clear, that no Goal is current) and
	 * that its snapshot reached the session file — the same on-disk bar the
	 * command's own success announcement waits for. A later legitimate transition
	 * of the same Goal does not undo the commit, while a creation that committed in
	 * memory and then failed its durability poll is reported as a refusal, never as
	 * a success.
	 */
	async function handleBridgeRequest(
		request: GoalCommandBridgeRequest,
		reply: (result: GoalCommandBridgeResult) => void,
	): Promise<void> {
		const ctx = sessionContext;
		const current = store.get();
		const publicState = current ? toPublicState(current) : null;
		if (ctx === null) {
			reply(
				goalBridgeRefusal({
					id: request.id,
					name: request.name,
					args: request.args,
					message:
						"Goal command not run: pi-goal has not started a session yet, so the Goal command surface is not " +
						"available. Retry once the session has loaded.",
					goal: publicState,
					admissionEnabled: admission.enabled,
				}),
			);
			return;
		}
		if (bridgeInFlight) {
			reply(
				goalBridgeRefusal({
					id: request.id,
					name: request.name,
					args: request.args,
					message:
						"Goal command not run: another bridged Goal command is still running (it may be waiting for a " +
						"dialog or for the session to go idle). Retry after it finishes.",
					goal: publicState,
					admissionEnabled: admission.enabled,
				}),
			);
			return;
		}
		if (!isGoalCommandRegistered(request.name)) {
			reply(goalBridgeUnregisteredCommand(request, publicState, admission.enabled));
			return;
		}
		const action = goalBridgeActionFor(request.name, request.args);
		const recorded: GoalBridgeTransition[] = [];
		const diagnostics: GoalBridgeDiagnostic[] = [];
		bridgeInFlight = true;
		bridgeTransitions = recorded;
		try {
			await runGoalCommand(request.name, request.args, recordingCommandContext(commandContextForBridge(ctx), diagnostics));
		} catch (error) {
			// The command runner reports its own failures as notifications; this is the
			// last-resort mirror for a throw outside them, and it is a refusal, never a
			// success.
			diagnostics.push({ level: "error", text: `pi-goal error: ${describeError(error)}` });
		} finally {
			bridgeTransitions = null;
			bridgeInFlight = false;
		}

		const transitions = recorded.filter((transition) => committedKindsFor(action).includes(transition.kind));
		const last = transitions.at(-1);
		const after = store.get() ?? null;
		// "Landed" is identity plus durability, never the exact revision: a Goal that
		// committed and then took another legitimate transition (a continuation that
		// completed it while the reply was being built) still committed. A retracted
		// creation or a replacement the durability poll restored fails here, because
		// the current Goal is then null or a different identity.
		const committed =
			last !== undefined &&
			(last.kind === "cleared"
				? after === null
				: after !== null && after.id === last.goal.id && store.isDurable(ctx, after.id));
		const outcome = classifyGoalBridgeOutcome({ action, transitions, diagnostics, committed });
		const result: GoalCommandBridgeResult = {
			version: GOAL_COMMAND_BRIDGE_VERSION,
			id: request.id,
			name: request.name,
			args: request.args,
			ok: outcome.ok,
			disposition: outcome.disposition,
			action,
			goal: after ? toPublicState(after) : null,
			admissionEnabled: admission.enabled,
			transitions,
			diagnostics,
		};
		reply(result);
	}

	// The optional companion seam (issue #56): an in-process request/response for
	// extensions that need the user command surface with a structured outcome. The
	// listener never throws into the bus and answers exactly once per request, so a
	// companion cannot mistake a dropped reply for a committed Goal.
	pi.events.on(GOAL_COMMAND_BRIDGE, (payload) => {
		const parsed = parseGoalCommandBridgeRequest(payload);
		// A malformed payload has no reply channel worth trusting: answering it would
		// mean calling an unvalidated function from the bus. The refusal still names
		// itself (a version mismatch says "upgrade the companion or pi-goal"), so the
		// mismatch is diagnosed in the host's log even though the caller's own timeout
		// is what answers it.
		if (!parsed.ok) {
			console.error(`[pi-goal] dropped a malformed bridge request: ${parsed.message}`);
			return;
		}
		const request = parsed.request;
		// "Called exactly once" includes the failure case: a reply callback that
		// throws (a broken host channel) has already been *called*, so the last-resort
		// refusal below must not call it a second time. Attempt-once is the honest
		// reading of the contract — the caller's own timeout covers a lost answer.
		let answered = false;
		const reply = (result: GoalCommandBridgeResult): void => {
			if (answered) return;
			answered = true;
			request.reply(result);
		};
		handleBridgeRequest(request, reply).catch((error: unknown) => {
			try {
				const goal = store.get();
				reply(
					goalBridgeRefusal({
						id: request.id,
						name: request.name,
						args: request.args,
						message: `pi-goal error: ${describeError(error)}`,
						goal: goal ? toPublicState(goal) : null,
						admissionEnabled: admission.enabled,
					}),
				);
			} catch {
				// Nothing left to report to: the caller's own timeout covers this case.
			}
		});
	});

	/**
	 * Open or close the admission segment for a user message Pi has just delivered.
	 *
	 * This is the live half of `ownershipMarker`, and drawing the line here rather
	 * than at `input` is what makes live accounting and branch replay converge:
	 *
	 * - `input` fires while the provider request is still streaming, so an ordinary
	 *   prompt typed during an admitted Goal response would close the segment before
	 *   that response is finalized and drop it live, while the replay — where the
	 *   assistant message is appended *before* the prompt that interrupted it —
	 *   charges it. A budget that only the live path failed to stop would then be
	 *   crossed on reload.
	 * - a queued steer is appended only after the in-flight assistant message and its
	 *   tool results, so opening the segment when the message is *queued* would
	 *   charge the previous identity's (or the previous turn's) work to this Goal.
	 *
	 * Pi appends the message in the same event, so the entry this sees is the entry
	 * the replay reads. The segment is opened only when the message names the Goal
	 * that is current at delivery — the identity whose newest snapshot precedes it.
	 * A work message queued for a Goal that has since been replaced, cleared, or
	 * completed names a different identity, so it opens nothing; the generic
	 * `[pi-goal]` prefix alone never authorizes admission.
	 *
	 * This is also the boundary that closes a superseded identity's admission: the
	 * replacement kept the old segment open for its in-flight tail, and the first
	 * delivered user message is where that tail is frozen onto the old identity's
	 * durable record (see `GoalStore.closeSupersededSegment`).
	 */
	function applyDeliveredUserMessage(message: { content: unknown }, pi: ExtensionAPI): void {
		const goal = store.get();
		const admittedId = goalWorkGoalId(messageText(message.content));
		const isGoalWork =
			goal != null && goal.status !== "complete" && admittedId !== null && admittedId === goal.id;
		store.closeSupersededAdmission(pi);
		if (isGoalWork) {
			store.beginGoalWork(goal.id);
			return;
		}
		store.endGoalWork();
	}

	/**
	 * Deliver a work-start (or work-redirect) message without ever waiting for an
	 * active run to finish.
	 *
	 * An active Goal keeps Pi nearly continuously busy (every settlement starts
	 * the next continuation), so `waitForIdle()` here would deadlock the command
	 * behind the Goal's own loop. Instead: idle sends the message as a fresh user
	 * turn; busy queues it as steering, which Pi delivers after the current
	 * turn's tool calls — exactly the safe steering mechanism the objective
	 * change of an active run is supposed to use. `pi.sendUserMessage` is
	 * fire-and-forget: delivery failures surface as Pi extension errors, never as
	 * a state lie ("steered" is reported only for the queueing itself).
	 *
	 * The message may carry image content blocks (a Goal whose manifest has
	 * images): Pi accepts `TextContent | ImageContent` arrays here, normalizing
	 * images exactly as it does for any user prompt.
	 *
	 * The admission segment is *not* opened here. It opens when the message is
	 * delivered, in {@link applyDeliveredUserMessage}, because a steer reaches the
	 * branch only after the work that was already in flight.
	 */
	function deliverWorkMessage(content: GoalMessageContent, ctx: ExtensionContext): "started" | "steered" {
		return deliverMessage(content, ctx);
	}

	/**
	 * Deliver one extension-authored user message without waiting for a run to end.
	 *
	 * The delivery mechanism is shared by every user-role message pi-goal sends: a
	 * Goal work message (kickoff, edit, resume) and the Objective-clarification
	 * interview instruction. Idle sends a fresh user turn; busy queues steering,
	 * which Pi delivers after the current turn's tool calls. The clarification
	 * instruction needs exactly this too, because the user may type `/goal` while
	 * an unrelated run is still streaming.
	 */
	function deliverMessage(content: GoalMessageContent, ctx: ExtensionContext): "started" | "steered" {
		if (ctx.isIdle()) {
			pi.sendUserMessage(content);
			return "started";
		}
		pi.sendUserMessage(content, { deliverAs: "steer" });
		return "steered";
	}

	/** Report a failed durable transition uniformly (the previous state stands). */
	function notifyMutationFailure(ctx: ExtensionContext, action: string, failure: { reason: string; message?: string; error?: unknown }): void {
		if (failure.reason === "persistence") {
			ctx.ui.notify(
				`Goal not ${action}: writing the Goal to the session failed (${describeError(failure.error)}). ` +
					"The previous Goal state is unchanged; fix the cause and try again.",
				"error",
			);
			return;
		}
		ctx.ui.notify(`Goal not ${action}: ${failure.message ?? "the current Goal state does not allow it"}.`, "warning");
	}

	/**
	 * The artifact store root for the current session, or null when the session
	 * file cannot be resolved (a Goal can only exist in a persistent session, so
	 * this is a defensive null rather than an expected state).
	 */
	function attachmentRoot(ctx: ExtensionContext): string | null {
		try {
			const file = ctx.sessionManager.getSessionFile();
			return file ? attachmentStoreRoot(file) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Deterministic-suite seams for the local remote-image TLS fixture.
	 *
	 * The production fetch refuses loopback and every private destination, so the
	 * tests run a local HTTPS fixture and must opt that exact origin in. The
	 * override is read only when the real-Pi test harness is driving this process
	 * (`PI_GOAL_TEST_SCRIPT`), applies only to exact HTTPS origins, and shortens
	 * the overall timeout only for the timeout scenario. A third seam supplies a
	 * fixed host-name-to-addresses map so no test consults the host's resolver.
	 * Users never configure remote fetching through these variables; see
	 * `docs/testing.md`.
	 */
	function remoteImageFetchOptions(): RemoteImageFetchOptions | undefined {
		if (!process.env.PI_GOAL_TEST_SCRIPT) return undefined;
		const origins = (process.env.PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS ?? "")
			.split(",")
			.map((origin) => origin.trim())
			.filter((origin) => origin !== "");
		const rawTimeout = process.env.PI_GOAL_TEST_REMOTE_IMAGE_TIMEOUT_MS;
		const timeout = rawTimeout === undefined ? Number.NaN : Number(rawTimeout);
		const timeoutMs = Number.isSafeInteger(timeout) && timeout > 0 ? timeout : undefined;
		const resolver = testRemoteImageResolver(process.env.PI_GOAL_TEST_REMOTE_IMAGE_DNS);
		if (origins.length === 0 && timeoutMs === undefined && resolver === undefined) return undefined;
		const testOnly = {
			...(origins.length === 0 ? {} : { allowedOrigins: origins }),
			...(resolver === undefined ? {} : { resolver }),
		};
		return {
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(Object.keys(testOnly).length === 0 ? {} : { testOnly }),
		};
	}

	/**
	 * Parse the deterministic DNS fixture for the real-Pi suite.
	 *
	 * The value is a JSON object of host name to a fixed address list. A malformed
	 * value becomes an empty, still-authoritative stub: every host name then fails
	 * to resolve instead of silently falling back to the host's resolver, so a
	 * typo can never make a test reach `/etc/hosts`, a local resolver, or the
	 * public internet.
	 */
	function testRemoteImageResolver(
		raw: string | undefined,
	): Record<string, readonly string[]> | undefined {
		if (raw === undefined || raw.trim() === "") return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {};
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const resolver: Record<string, readonly string[]> = {};
		for (const [name, addresses] of Object.entries(parsed)) {
			if (!Array.isArray(addresses) || addresses.some((address) => typeof address !== "string")) return {};
			resolver[name.toLowerCase()] = addresses as string[];
		}
		return resolver;
	}

	/** The refusal for work whose attachments cannot be verified. */
	function attachmentIntegrityError(goal: GoalRecord, problems: readonly string[]): string {
		return (
			`pi-goal could not verify the attachments of Goal ${goal.id}: ${problems.join("; ")}. The Goal keeps its ` +
			"Lifecycle status and its manifest — attachments are never silently dropped and the Goal is never completed " +
			"for this reason — but no automatic continuation is requested while the artifacts cannot be verified. Restore " +
			"the original bytes (content-addressed by their sha256) under the pi-goal-store directory beside the session " +
			"file, or /goal:clear this Goal and create a new one that re-attaches the files."
		);
	}

	/**
	 * Verify the current Goal's manifest against the artifact store.
	 *
	 * Runs on restore (session start and tree navigation) and before admitting
	 * work that would re-send the attachments (a continuation, a resume, an
	 * active-Goal edit): a missing or corrupt artifact suppresses the automatic
	 * Continuation and surfaces this explicit error instead — the Goal is never
	 * silently stripped of its attachments, completed, or moved to another
	 * Lifecycle status because of an artifact problem.
	 */
	function verifyGoalArtifacts(goal: GoalRecord, ctx: ExtensionContext): { ok: true } | { ok: false; problems: string[] } {
		const manifest = goal.attachments ?? [];
		if (manifest.length === 0) return { ok: true };
		const root = attachmentRoot(ctx);
		if (!root) return { ok: false, problems: ["the session file could not be resolved"] };
		return verifyAttachments(root, goal.id, manifest);
	}

	/** Surface a failed verification, naming the recovery path. */
	function notifyAttachmentIntegrityFailure(goal: GoalRecord, ctx: ExtensionContext, problems: readonly string[]): void {
		notify(ctx, attachmentIntegrityError(goal, problems), "error");
	}

	/** The session working directory relative attachment sources resolve against. */
	function sessionWorkingDirectory(ctx: ExtensionContext): string {
		try {
			return ctx.sessionManager.getCwd();
		} catch {
			return ctx.cwd;
		}
	}

	/**
	 * Load and authenticate the current Goal's attachments in one read path.
	 *
	 * The loader verifies the manifest's recorded size, the per-file and total
	 * limits, and the content hash on the exact bytes it returns. A work-admitting
	 * transition (resume, an active-Goal edit, a continuation) therefore renders
	 * those verified bytes and never re-reads a path that could have changed after
	 * a separate verification.
	 */
	function loadGoalAttachments(
		goal: GoalRecord,
		ctx: ExtensionContext,
	): { ok: true; contents: AttachmentContent[] } | { ok: false; problems: string[] } {
		const manifest = goal.attachments ?? [];
		if (manifest.length === 0) return { ok: true, contents: [] };
		const root = attachmentRoot(ctx);
		if (!root) return { ok: false, problems: ["the session file could not be resolved"] };
		const loaded = loadAttachments(root, goal.id, manifest);
		if (!loaded.ok) return { ok: false, problems: [loaded.error] };
		return { ok: true, contents: loaded.contents };
	}

	function pauseGoal(ctx: ExtensionCommandContext): void {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(admission.enabled), "info");
			return;
		}
		if (goal.status === "paused") {
			ctx.ui.notify(`Goal ${goal.id} is already paused. Use /goal:resume to restart work.`, "info");
			return;
		}
		if (goal.status !== "active") {
			ctx.ui.notify(
				`Goal ${goal.id} is ${goal.status}; there is nothing to pause. A complete Goal is finished — use /goal <objective> to set a new one.`,
				"warning",
			);
			return;
		}
		const paused = store.markPaused(pi);
		if (!paused.ok) {
			notifyMutationFailure(ctx, "paused", paused);
			return;
		}
		updateStatus(ctx);
		// The transition is durable (appendEntry wrote through) before this
		// announcement. The in-flight run, if any, finishes on its own: pause
		// stops admission of further automatic runs, it never aborts work.
		ctx.ui.notify(
			`Goal ${goal.id} paused (revision ${paused.goal!.revision}). No further automatic Goal runs will start; ` +
				"work already in flight finishes safely. Use /goal:resume to restart, /goal:clear to remove the Goal.",
			"info",
		);
	}

	/**
	 * Offer the opt-in paused-Goal resume prompt for a restored `paused` Goal.
	 *
	 * The prompt is convenience, never authority. It asks once per session start,
	 * and every answer other than an explicit "yes" leaves the Goal untouched:
	 * declining, dismissing, timing out, an unavailable UI, and a Goal that moved
	 * while the dialog was open all change nothing. Acceptance is delegated to
	 * {@link resumeGoal}, so it is literally `/goal:resume`: the durable
	 * `markResumed` transition, the same identity and history, and a fresh Blocked
	 * audit. That is also why the prompt is never offered for any other status —
	 * `blocked` and `usage_limited` recovery is a user decision with its own
	 * reasoning, and `budget_limited` recovery needs valid new headroom.
	 *
	 * Nothing here blocks a headless path. Print and JSON modes have no
	 * dialog-capable UI, so the prompt is never opened; RPC mode can answer it, and
	 * the dialog is created without being awaited by the `session_start` handler,
	 * so the session becomes usable while the request is still pending. A UI-less
	 * caller is told what happened rather than left to guess why a paused Goal was
	 * not resumed.
	 */
	function offerResumePrompt(ctx: ExtensionContext): void {
		if (!resumePrompt.enabled) return;
		const goal = store.get();
		if (!goal || goal.status !== "paused") return;
		// A disabled extension cannot admit the resume this prompt would perform, so
		// it must not ask a question it will refuse. The clear outcome is a notice
		// naming the disabled condition and the two explicit ways forward.
		if (!admission.enabled) {
			notify(
				ctx,
				`Goal ${goal.id} restored (paused). The resume prompt is enabled, but pi-goal is disabled (goal.enabled is ` +
					"false), so no resume was offered and nothing was resumed: the Goal stays paused and no new Goal work is " +
					"admitted. Re-enable goal.enabled and run /goal:resume to restart it, or leave it paused.",
				"warning",
			);
			return;
		}
		if (!ctx.hasUI) {
			notify(
				ctx,
				`Goal ${goal.id} restored (paused). The resume prompt is enabled, but this Pi mode has no interactive UI to ` +
					"ask it, so nothing was asked and the Goal stays paused. Use /goal:resume to restart it.",
				"info",
			);
			return;
		}
		// Deliberately not awaited: `session_start` must return so the host can start
		// dispatching input, and an RPC host answers the dialog only after that.
		void askResumePrompt(ctx, goal).catch((error) => {
			notify(ctx, `pi-goal resume prompt error: ${describeError(error)}`, "error");
		});
	}

	/**
	 * Ask the one resume question and act on the answer, revalidating first.
	 *
	 * The dialog's timeout resolves to "no" in every mode, and the Goal is re-read
	 * after the answer because a Goal can be edited, paused, resumed, replaced, or
	 * cleared while a dialog is open: the answer only ever applies to the exact
	 * record the dialog described.
	 */
	async function askResumePrompt(ctx: ExtensionContext, goal: GoalRecord): Promise<void> {
		let confirmed: boolean;
		try {
			confirmed = await ctx.ui.confirm(
				"Resume the paused Goal?",
				`Goal ${goal.id} is paused: "${previewObjective(goal.objective)}". Resuming restarts work with the same ` +
					"identity, history, and retained progress and starts a fresh blocked audit — the same durable transition " +
					"as /goal:resume. Declining, dismissing, or not answering leaves the Goal paused and changes nothing.",
				{ timeout: dialogTimeoutMs(RESUME_PROMPT_TIMEOUT_MS) },
			);
		} catch (error) {
			notify(
				ctx,
				`Goal ${goal.id} stays paused: the resume prompt could not be displayed (${describeError(error)}). ` +
					"Use /goal:resume to restart it.",
				"warning",
			);
			return;
		}
		const current = store.get();
		if (!current || current.id !== goal.id || current.revision !== goal.revision) {
			notify(
				ctx,
				`Resume prompt closed without resuming: the Goal changed while the prompt was open` +
					(current ? ` (now ${current.status}, revision ${current.revision})` : " (no Goal is set anymore)") +
					", so the prompt no longer described the current state. The current Goal state stands; use /goal:resume " +
					"to restart the Goal you want.",
				"warning",
			);
			return;
		}
		if (!confirmed) {
			// Decline, dismissal, and timeout all resolve to "no" in Pi's dialog API, so
			// the notice names every one of them rather than inventing a distinction the
			// extension cannot observe.
			notify(
				ctx,
				`Resume prompt not confirmed (declined, dismissed, or timed out): Goal ${current.id} stays paused and ` +
					"nothing changed. Use /goal:resume to restart it.",
				"info",
			);
			return;
		}
		if (!admission.enabled) {
			notify(ctx, admissionDisabledRefusal("Goal not resumed from the resume prompt:"), "warning");
			return;
		}
		if (current.status !== "paused") {
			notify(
				ctx,
				`Goal ${current.id} is ${current.status}; the resume prompt only resumes a paused Goal, so nothing was ` +
					"resumed.",
				"warning",
			);
			return;
		}
		resumeGoal(ctx, { kind: "none" });
	}

	function resumeGoal(ctx: ExtensionContext, budget: ResumeBudgetRequest): void {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(admission.enabled), "info");
			return;
		}
		// A resume admits new Goal work — the resume message restarts the loop — so a
		// disabled extension refuses it and the Goal keeps whatever status it has.
		if (!admission.enabled) {
			ctx.ui.notify(admissionDisabledRefusal("Goal not resumed:"), "warning");
			return;
		}
		if (budget.kind === "value" && goal.status !== "budget_limited") {
			ctx.ui.notify(
				`Goal ${goal.id} is ${goal.status}; the --budget option only resumes a budget_limited Goal. ` +
					"Use /goal:resume without --budget.",
				"warning",
			);
			return;
		}
		if (budget.kind === "none" && goal.status === "budget_limited") {
			ctx.ui.notify(
				`Goal ${goal.id} is budget_limited at ${store.getUsage().totalTokens} tokens of its ` +
					`${goal.tokenBudget}-token budget. Resume it with a higher cumulative total: ` +
					"/goal:resume --budget <new-total>.",
				"warning",
			);
			return;
		}
		if (goal.status === "active") {
			ctx.ui.notify(`Goal ${goal.id} is already active; work continues at every settlement.`, "info");
			return;
		}
		if (
			goal.status !== "paused" &&
			goal.status !== "blocked" &&
			goal.status !== "usage_limited" &&
			goal.status !== "budget_limited"
		) {
			ctx.ui.notify(
				`Goal ${goal.id} is ${goal.status} and cannot be resumed. A complete Goal is finished — use /goal <objective> to set a new one.`,
				"warning",
			);
			return;
		}
		// The resume message re-sends the Goal's attachments, so load and
		// authenticate them *before* the durable resume transition. If the load
		// fails, the Goal stays paused with an actionable integrity error instead of
		// becoming active and then failing to start work (which would make the
		// suggested `/goal:resume` a no-op).
		let contents: AttachmentContent[] = [];
		if (goal.attachments?.length) {
			const loaded = loadGoalAttachments(goal, ctx);
			if (!loaded.ok) {
				notifyAttachmentIntegrityFailure(goal, ctx, loaded.problems);
				return;
			}
			contents = loaded.contents;
		}
		// A stop the user is overruling is a user action, so every anti-loop counter
		// and the in-memory audit chain start over with the resumed Goal. The durable
		// audit itself is dropped by the store, so what resumes is the objective and
		// its retained progress rather than the count that stopped it.
		safety.reset();
		const resumed = store.markResumed(
			pi,
			budget.kind === "value"
				? { tokenBudget: budget.value, maxTokenBudget: budgetSettings.maxTokenBudget }
				: {},
		);
		if (!resumed.ok) {
			notifyMutationFailure(ctx, "resumed", resumed);
			return;
		}
		// The old budget gate is lifted only after the new ceiling is durably
		// authorized. An in-flight old-episode wrap-up keeps its admitted usage, and
		// the steered resume message is what runs the resumed work; no second
		// old-budget wrap-up is sent.
		budgetGateActive = false;
		wrapUpArmed = false;
		updateStatus(ctx);
		const updated = resumed.goal!;
		const previousStatus = goal.status;
		// Durable first, then restart work — busy-safely, so resuming while
		// another run is in flight steers instead of waiting for idle. The message
		// renders the bytes authenticated before the transition; it never re-reads.
		const delivery = deliverWorkMessage(formatResumeMessage(updated, previousStatus, contents), ctx);
		const restarted = resumeRestartNotice(previousStatus, updated.tokenBudget, store.getUsage().totalTokens);
		ctx.ui.notify(
			`Goal ${updated.id} resumed (revision ${updated.revision}). ${restarted} Work ${delivery === "started" ? "restarted" : "steered into the running work"}.`,
			"info",
		);
	}

	function clearGoal(ctx: ExtensionCommandContext): void {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(admission.enabled), "info");
			return;
		}
		const cleared = store.clear(pi);
		if (!cleared.ok) {
			notifyMutationFailure(ctx, "cleared", cleared);
			return;
		}
		updateStatus(ctx);
		// The tombstone is durable before this announcement, so a crash right
		// here still restores "no Goal". Work in flight finishes normally; with
		// no Goal, its settlement cannot continue.
		ctx.ui.notify(
			`Goal ${goal.id} cleared (was ${goal.status}). The session is back to ordinary prompt behavior.`,
			"info",
		);
	}

	/**
	 * Resolve a dialog promise with a fallback when the host does not answer in
	 * time.
	 *
	 * Pi's `editor` dialog has no timeout option of its own, so a host that never
	 * answers the editor request would otherwise leave the command waiting
	 * forever. The fallback only affects this command: the dialog request itself
	 * remains pending on the host, and a later answer is ignored.
	 */
	function withDialogTimeout<T>(dialog: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			dialog,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), timeoutMs);
			}),
		]).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});
	}

	/**
	 * Interactive objective editing.
	 *
	 * Bare `/goal:edit` opens Pi's multi-line editor prefilled with the current
	 * objective. The dialog is only opened when a dialog-capable UI exists
	 * (`ctx.hasUI` is true in TUI and RPC modes); in print/JSON mode there is no
	 * terminal-only dialog to open, so the command explains the typed form instead
	 * of blocking. RPC hosts answer the same editor request through the
	 * extension-UI subprotocol, so headless RPC is not blocked either.
	 *
	 * Cancelling (or a dialog that is never answered) leaves the objective
	 * unchanged.
	 */
	async function editGoalInteractively(ctx: ExtensionCommandContext): Promise<void> {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify("There is no Goal to edit. Create one with /goal <objective> first.", "warning");
			return;
		}
		// Refuse before opening the dialog: an edit of an active Goal is
		// work-admitting, so a disabled extension must not invite the user to write a
		// new objective it will then decline to deliver.
		if (goal.status === "active" && !admission.enabled) {
			refuseWorkAdmittingEdit(ctx, goal);
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"Interactive objective editing needs a UI, which this Pi mode does not have. " +
					"Use /goal:edit <new objective> to type the new objective instead.",
				"warning",
			);
			return;
		}
		const edited = await withDialogTimeout(
			ctx.ui.editor("Edit Goal objective", goal.objective),
			dialogTimeoutMs(EDIT_TIMEOUT_MS),
			undefined,
		);
		if (edited === undefined) {
			ctx.ui.notify(`Goal ${goal.id} objective edit cancelled; the current objective is unchanged.`, "info");
			return;
		}
		editGoal({ objective: edited }, ctx);
	}

	/**
	 * Apply one in-place Goal edit: the objective, the title, or both in one revision.
	 *
	 * Both fields are validated before anything is read or written, so an invalid
	 * objective or title refuses the whole edit and mutates nothing. The two kinds
	 * of change differ deliberately after validation:
	 *
	 * - an **objective** edit keeps every existing rule. It is work-admitting for an
	 *   active Goal, so it is refused while `goal.enabled` is false; its immutable
	 *   attachment manifest is verified before the edit steers new work; and a
	 *   complete Goal refuses it (use `/goal <objective>` for a new identity).
	 * - a **title-only** edit changes a label. It reopens no work, so it is admitted
	 *   while the extension is disabled and for a complete Goal, it never sends a
	 *   work message, and it never reloads attachments. That is what makes
	 *   `/goal:edit --title` usable for relabeling without side effects.
	 */
	function editGoal(changes: GoalEditChanges, ctx: ExtensionCommandContext): void {
		let objective: string | undefined;
		if (changes.objective !== undefined) {
			const validation = validateObjective(changes.objective);
			if (!validation.ok) {
				ctx.ui.notify(validation.error, "error");
				return;
			}
			objective = validation.objective;
		}
		let title: string | undefined;
		if (changes.title !== undefined) {
			const validation = validateGoalTitle(changes.title);
			if (!validation.ok) {
				ctx.ui.notify(validation.error, "error");
				return;
			}
			title = validation.title;
		}
		const changingObjective = objective !== undefined;
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify("There is no Goal to edit. Create one with /goal <objective> first.", "warning");
			return;
		}
		// Only an *objective* edit of an *active* Goal is work-admitting: it steers a
		// new objective into the running work. A title-only edit is a label change,
		// and an edit of a Goal that is already stopped admits nothing either, so
		// both stay available while the extension is disabled.
		if (changingObjective && goal.status === "active" && !admission.enabled) {
			refuseWorkAdmittingEdit(ctx, goal);
			return;
		}
		// An objective edit keeps the immutable attachment manifest, and the edit
		// message of an active Goal re-sends it, so the artifacts must verify before
		// the edit steers new work. A title-only edit sends no message, so it never
		// needs the contents; a stopped Goal's objective edit rewrites durable state
		// only and is verified again when work is eventually resumed.
		let contents: AttachmentContent[] = [];
		if (changingObjective && goal.attachments?.length && goal.status === "active") {
			const loaded = loadGoalAttachments(goal, ctx);
			if (!loaded.ok) {
				ctx.ui.notify(attachmentIntegrityError(goal, loaded.problems), "error");
				return;
			}
			contents = loaded.contents;
		}
		const edited = store.editInPlace(pi, {
			...(changingObjective ? { objective } : {}),
			...(title === undefined ? {} : { title }),
		});
		if (!edited.ok) {
			notifyMutationFailure(ctx, "edited", edited);
			return;
		}
		updateStatus(ctx);
		const updated = edited.goal!;
		if (!changingObjective) {
			ctx.ui.notify(
				`Goal ${updated.id} title set to ${JSON.stringify(updated.title ?? title ?? "")} (revision ${updated.revision}). ` +
					`The Goal stays ${updated.status}; a title is a label, so no work was started or redirected.`,
				"info",
			);
			return;
		}
		const titleNote = title === undefined ? "" : ` Title set to ${JSON.stringify(title)}.`;
		if (updated.status === "active") {
			// Redirect the active run through Pi's steering (or start work when
			// idle, e.g. after an aborted run left the Goal dormant). The manifest is
			// immutable across the edit, so the same attachments ride along.
			const delivery = deliverWorkMessage(formatEditMessage(updated, contents), ctx);
			ctx.ui.notify(
				`Goal ${updated.id} objective updated (revision ${updated.revision}); usage history is preserved.${titleNote} Work ${delivery === "started" ? "started" : "steered"} on the new objective.`,
				"info",
			);
			return;
		}
		// Nothing was started for a Goal that is already stopped, so the notice says
		// what restarts it — and, while the extension is disabled, that nothing was
		// started because admission is off rather than because the Goal moved.
		const restart = admission.enabled
			? updated.status === "budget_limited"
				? "/goal:resume --budget <new-total> restarts work with a higher cumulative ceiling."
				: "/goal:resume restarts work."
			: "pi-goal is disabled (goal.enabled is false), so no work was started and /goal:resume stays refused " +
					"until it is re-enabled.";
		ctx.ui.notify(
			`Goal ${updated.id} objective updated (revision ${updated.revision}).${titleNote} The Goal stays ${updated.status}; ${restart}`,
			"info",
		);
	}

	/**
	 * Refuse `/goal <objective>` while an unfinished Goal holds the session's single
	 * Goal slot (ADR-0003: one session works one Goal at a time).
	 *
	 * Abandoning a Goal is the user's explicit `/goal:clear` — or finishing it — never
	 * a side effect of a creation dialog, so there is nothing to confirm and nothing
	 * for a UI to answer: the refusal is identical with or without one, opens no
	 * dialog, and mutates nothing. It is a warning, which is also what makes the
	 * command bridge and the RPC companion answer `refused` rather than `declined`.
	 * A *complete* Goal never reaches this: finished work does not get in the way of
	 * the next Goal, which supersedes it through the ordinary replacement machinery.
	 *
	 * The message is returned as well as notified, so a caller that has to answer the
	 * model (a confirmation save that lost the race to another Goal) can carry the
	 * same diagnostic instead of paraphrasing it.
	 */
	function refuseUnfinishedGoal(ctx: ExtensionContext, existing: GoalRecord): string {
		const message =
			`Goal not created: an unfinished Goal is already set (${existing.status}, "${previewObjective(existing.objective)}"). ` +
			"/goal does not replace an unfinished Goal. Finish the current Goal, or run /goal:clear first and then " +
			"run /goal <objective> again. The current Goal is unchanged.";
		ctx.ui.notify(message, "warning");
		return message;
	}

	/**
	 * A fully parsed and validated creation request, ready to commit.
	 *
	 * `/goal <objective>` builds one from the command line; the confirmed Objective
	 * clarification builds one from the user-edited confirmation document plus the
	 * budget and attachment flags it held while the interview ran. Everything
	 * downstream — the single-Goal refusal, attachment materialization and remote
	 * fetching, the durable commit, the kickoff, the durability poll — is identical
	 * for both, which is what makes the editor a creation authority rather than a
	 * second lifecycle path.
	 */
	interface GoalCreationRequest {
		/** The validated Objective. */
		objective: string;
		/** The budget flag the user typed, resolved at commit time. */
		budget: GoalBudgetRequest;
		/** The attachment flags the user typed; materialized only inside the commit. */
		attachments: readonly AttachmentRequest[];
		/** The confirmed Goal title; only the clarified path supplies one. */
		title?: string;
		/**
		 * How the initial work message is delivered.
		 *
		 * The command path waits for idle before a *fresh* creation: the user's own
		 * `/goal` may arrive while an unrelated run is streaming, and the wait lets a
		 * later clear or edit win. A confirmation editor is answered from inside a
		 * running tool call, where waiting for idle would deadlock — the run cannot
		 * finish until the tool returns — so the clarified path always steers (or
		 * starts when the session is genuinely idle).
		 */
		kickoff: "wait-idle" | "steer";
	}

	/** What one creation commit did, for callers that must report it to the model. */
	type GoalCreationOutcome =
		| { ok: true; goal: GoalRecord; delivery: "started" | "steered" }
		| { ok: false; message: string };

	/**
	 * The context one creation commit needs.
	 *
	 * Both Pi's command and tool contexts provide it. Only the command path asks for
	 * `waitForIdle` (the clarified path always steers), and a tool context has no such
	 * method — a tool cannot wait for the run it is part of — which is why it is
	 * optional here and only the `wait-idle` kickoff mode requires it.
	 */
	type GoalCreationContext = ExtensionContext & { waitForIdle?(): Promise<void> };

	/** The creation request `/goal <objective>` builds from its parsed arguments. */
	function creationRequestFromCommand(parsed: ParsedGoalArgs, objective: string): GoalCreationRequest {
		return {
			objective,
			budget: parsed.budget,
			attachments: parsed.attachments,
			kickoff: "wait-idle",
		};
	}

	/**
	 * Refuse a creation that asked for clarification in a host that cannot complete it.
	 *
	 * Direct creation is authorized in exactly two cases: `goal.clarifyOnCreate:
	 * false`, and a UI-less host that has no confirmation editor to open. A
	 * UI-capable host with the setting on has **one** creation authority — the saved
	 * confirmation editor — so when `propose_goal` could not be registered (or did
	 * not survive registration) falling back to a direct, title-less commit would
	 * silently bypass the mandatory confirmation. Fail closed instead: no Goal, no
	 * pending interview that could never be confirmed, and a diagnostic naming both
	 * ways forward.
	 */
	function refuseUnavailableClarification(ctx: ExtensionCommandContext): void {
		ctx.ui.notify(
			"Goal not created: Objective clarification is enabled (goal.clarifyOnCreate is true), but the " +
				`${PROPOSE_GOAL_TOOL_NAME} tool could not be registered (another extension may already own that name), so ` +
				"there is no confirmation editor to authorize a Goal. No Goal was created and no clarification was started. " +
				"Rename the conflicting tool (or unload that extension) and run /goal again, or set goal.clarifyOnCreate " +
				"to false to create directly without confirmation.",
			"error",
		);
	}

	async function createOrReplaceGoal(rawObjective: string, ctx: ExtensionCommandContext): Promise<void> {
		// Admission control before anything else: a disabled extension refuses every
		// creation — including the one that would supersede a complete Goal — and it
		// refuses before anything else is validated, asked of the user, or recorded as
		// a pending clarification.
		if (!admission.enabled) {
			ctx.ui.notify(admissionDisabledRefusal("Goal not created:"), "warning");
			return;
		}
		// Budget and attachment flags are a leading prefix of a create (`/goal --budget 5000 --file spec.md <objective>`),
		// so an objective that merely contains the word `--budget` is never truncated.
		// `--no-budget` asks for an unbounded Goal even when a default is configured.
		const parsed = parseGoalArgs(rawObjective);
		for (const problem of parsed.problems) {
			ctx.ui.notify(problem, "error");
			return;
		}
		// `resolveGoalTokenBudget` owns the request kinds, so an explicit unbounded
		// request is refused (never clamped) while a maximum is configured. The
		// clarified path resolves the held flag again at commit time; validating it
		// here refuses a bad budget before an interview starts instead of after it.
		const budget = resolveGoalTokenBudget(
			parsed.budget.kind === "none" ? "none" : parsed.budget.kind === "value" ? parsed.budget.value : undefined,
			budgetSettings,
		);
		if (!budget.ok) {
			ctx.ui.notify(budget.error, "error");
			return;
		}
		const validation = validateObjective(parsed.objective);
		if (!validation.ok) {
			ctx.ui.notify(validation.error, "error");
			return;
		}

		if (!store.isPersistentSession(ctx)) {
			ctx.ui.notify(
				"Goal not created: this session is not persistent (started with --no-session), " +
					"so a Goal could not be restored after a restart. Start Pi with a persisted session to use Goals.",
				"error",
			);
			return;
		}

		const request = creationRequestFromCommand(parsed, validation.objective);

		// Objective clarification (ADR-0003). Two host shapes are decided here; the
		// third is decided inside `startClarification`, under the creation lock:
		//
		// - the setting is on but the host has no dialog-capable UI: create directly
		//   from the raw idea, with the notice that says so (there is no interview it
		//   could confirm);
		// - the setting is on and the host has a UI: clarify — and `startClarification`
		//   refuses when an unfinished Goal is in the way (that check stays outermost),
		//   or when the confirmation tool could not be registered. The latter fails
		//   closed: the saved editor is the only creation authority here, so a direct
		//   commit would silently bypass the mandatory confirmation;
		// - the setting is off: the unchanged direct creation.
		if (clarifyOnCreate.enabled) {
			if (!ctx.hasUI) {
				const outcome = await commitGoalCreation(request, ctx);
				if (!outcome.ok) return;
				endSupersededPendingClarification(ctx);
				ctx.ui.notify(
					"Objective clarification was skipped: this Pi mode has no dialog-capable UI, so the confirmation " +
						"editor could not be opened. The Goal was created directly from the raw idea; start Pi with a " +
						"dialog-capable UI (TUI or RPC) to review and edit a drafted Goal before it is created.",
					"info",
				);
				return;
			}
			await startClarification(request, ctx);
			return;
		}
		const outcome = await commitGoalCreation(request, ctx);
		if (!outcome.ok) return;
		// A `/goal` that did not clarify still supersedes an earlier clarification: this
		// command is the user's answer to the interview, so a durable pending entry it
		// leaves behind must not come back after a restart.
		endSupersededPendingClarification(ctx);
	}

	/**
	 * Retire a pending clarification that a non-clarifying creation made moot.
	 *
	 * Reached after a successful creation that did not go through the confirmation
	 * editor: a direct `/goal` (`goal.clarifyOnCreate: false`, or a host without a
	 * dialog-capable UI), and the `create_goal` tool. Any of them can be issued while
	 * an earlier interview is open — a restart may have offered it, or the model may
	 * create a Goal mid-interview — and a Goal now occupies the slot the draft would
	 * have acted on. Writing the terminal end keeps the branch honest; the base
	 * identity recorded with the draft is the load-bearing guarantee, because a
	 * crash between the Goal commit and this write is resolved by that identity
	 * check instead of by this write.
	 *
	 * Only a branch that actually holds an open or confirming entry is touched, so
	 * the common case writes nothing. The Goal is already committed when this runs:
	 * a failed end-write cannot undo it and is reported as a warning, and the
	 * in-memory clarification is dropped anyway because the Goal now owns the slot.
	 */
	function endSupersededPendingClarification(ctx: ExtensionContext): void {
		let read: ReturnType<typeof readPendingClarification>;
		try {
			read = readPendingClarification(ctx.sessionManager.getBranch());
		} catch {
			return;
		}
		// `superseded` is still an open (or confirming) record — its base identity moved,
		// but the durable entry itself is not terminal. Ending it here keeps the branch
		// tidy; the base check is what already makes it unofferable if this write fails.
		if (read.kind !== "pending" && read.kind !== "superseded") return;
		try {
			pi.appendEntry(CLARIFICATION_ENTRY_TYPE, endedClarificationEntry());
		} catch (error) {
			notify(
				ctx,
				`Goal created, but the superseded Objective clarification could not be recorded as ended ` +
					`(${describeError(error)}). The Goal is unaffected; the draft stays abandoned, and run /goal again to ` +
					"replace the leftover entry.",
				"warning",
			);
		}
		// The Goal is current, so a draft against a different identity can never be
		// confirmed again in this session. Reconstruction would reject it anyway.
		pendingClarification = null;
		pendingConfirmation = null;
	}

	/**
	 * Rebuild the pending clarification from the selected branch.
	 *
	 * Called at the same two seams Goal reconstruction uses — `session_start`
	 * (startup, resume, reload, new, fork/clone) and `session_tree` (branch
	 * navigation) — so an open interview survives a graceful or unclean restart with
	 * the raw idea and flags the user typed. Nothing is read, materialized, or
	 * fetched here: the held flags stay flags, exactly as before the restart.
	 *
	 * Three conditions decide whether the reconstructed state is *offered*:
	 *
	 * - Goal reconstruction must have trusted the branch. When the newest snapshot
	 *   is unreadable, `store.reconstruct` fails closed to "no Goal"; offering a
	 *   draft over that unknown slot would let a confirmation write a new snapshot
	 *   on top of a corrupt one and orphan whatever Goal the branch really held, so
	 *   nothing is offered (and `propose_goal` refuses) until the branch is repaired.
	 * - the flow must be on, `propose_goal` must still be pi-goal's own tool, and the
	 *   host must have a dialog-capable UI. An interview this session could not
	 *   confirm is a dead end, and falling back to a direct creation would bypass the
	 *   confirmation the entry exists for, so the fail-closed direction is to offer
	 *   nothing. The registry is re-read here rather than trusting the session-start
	 *   flag: another extension may have taken the name since.
	 * - the newest entry must be readable *and* still belong to this Goal slot. A
	 *   malformed newest entry is surfaced instead of guessed, and an entry whose
	 *   recorded base Goal identity no longer matches the branch (a Goal was created,
	 *   replaced, or cleared after the interview started) is abandoned silently.
	 *
	 * Memory is cleared first, on every call: stale runtime state from a previous
	 * session or branch must never authorize a Goal in this one, even when the read
	 * throws.
	 */
	function reconstructPendingClarification(ctx: ExtensionContext): void {
		pendingClarification = null;
		pendingConfirmation = null;
		// An unreadable Goal branch is not a branch to offer a draft over.
		if (store.reconstructionFailedClosed()) return;
		let read: ReturnType<typeof readPendingClarification>;
		try {
			read = readPendingClarification(ctx.sessionManager.getBranch());
		} catch (error) {
			// A broken branch must not break the session; report and stay closed.
			console.error("[pi-goal] failed to reconstruct the pending objective clarification:", error);
			return;
		}
		if (read.kind === "malformed") {
			notify(ctx, formatPendingClarificationMalformedNotice(), "warning");
			return;
		}
		// `none` and `superseded` are both silent: the former ended normally, the
		// latter belongs to a Goal slot the user already moved on from.
		if (read.kind !== "pending") return;
		// The confirmation editor is the only creation authority on the clarified
		// path, so an interview this session cannot confirm is not offered at all.
		if (!clarifyOnCreate.enabled || !toolSurvivedRegistration(PROPOSE_GOAL_TOOL_NAME) || !ctx.hasUI) return;
		pendingClarification = read.pending;
		pendingConfirmation =
			read.confirmed === null ? null : { pending: read.pending, draft: read.confirmed };
		notify(
			ctx,
			formatPendingClarificationRestoredNotice(read.pending, { confirmed: read.confirmed !== null }),
			"info",
		);
	}

	/**
	 * Withdraw an offered clarification whose confirmation tool is no longer pi-goal's.
	 *
	 * `/goal` re-reads tool ownership under the creation lock, and `propose_goal`
	 * checks it at execution, but an interview that is already open when another
	 * extension takes the name would otherwise sit there as a confirmation the user
	 * cannot complete. The durable entry is deliberately not rewritten: a later
	 * session that owns the name offers it again, while this session says why it is
	 * no longer offered.
	 */
	function reconcileClarificationToolOwnership(ctx: ExtensionContext): void {
		if (pendingClarification === null) return;
		if (!clarifyOnCreate.enabled) return;
		if (toolSurvivedRegistration(PROPOSE_GOAL_TOOL_NAME)) return;
		pendingClarification = null;
		pendingConfirmation = null;
		notify(
			ctx,
			"Objective clarification paused: another extension took over the propose_goal tool, so the confirmation " +
				"editor is unavailable in this session. The pending clarification is kept in the session and is offered " +
				"again when pi-goal owns the tool; run /goal <new idea> to start one now.",
			"warning",
		);
	}

	/**
	 * Record the pending clarification durably and send the model the interview.
	 *
	 * The entry is appended before the model is asked anything, so the raw idea and
	 * the flags it started with are durable from the moment the command returns.
	 * Nothing else happens: no Goal snapshot, no store mutation, no attachment read,
	 * no remote fetch — those belong to the confirmed save, or to nothing at all.
	 *
	 * The unfinished-Goal refusal is the same one the direct creation uses and is
	 * checked under the same lock, so a `/goal` that races another creation is
	 * refused before it records a pending entry. A **complete** Goal does not block:
	 * the save supersedes it through the ordinary replacement machinery, exactly like
	 * a direct creation. A second `/goal` replaces the pending entry and starts the
	 * interview over with the new idea and flags (issue #85): the newest durable
	 * entry wins on the branch, so a restart reconstructs the replacement and not the
	 * abandoned idea, and the model is told the earlier interview is abandoned.
	 */
	async function startClarification(request: GoalCreationRequest, ctx: ExtensionCommandContext): Promise<void> {
		await runExclusive(async () => {
			const previous = store.get();
			// The single-Goal refusal is the outermost creation rule, so it is decided
			// before the host's ability to clarify: an unfinished Goal refuses `/goal`
			// identically whether or not the confirmation tool exists.
			if (previous && previous.status !== "complete") {
				refuseUnfinishedGoal(ctx, previous);
				return;
			}
			// Only now is the host's ability to complete the flow relevant. A
			// UI-capable host with the setting on has one creation authority — the
			// saved confirmation editor — so a missing tool fails closed instead of
			// recording an interview that could never be confirmed (see
			// `refuseUnavailableClarification`). The registry is re-read here, under the
			// creation lock, rather than trusting the session-start flag: another
			// extension can take the `propose_goal` name after pi-goal registered it, and
			// an interview whose editor is no longer pi-goal's could never be confirmed.
			if (!proposeGoalRegistered || !toolSurvivedRegistration(PROPOSE_GOAL_TOOL_NAME)) {
				refuseUnavailableClarification(ctx);
				return;
			}
			// A branch whose newest Goal snapshot is unreadable cannot authorize a new
			// Goal slot: the confirmation editor would either write over a corrupt entry
			// (orphaning the Goal it hid) or create a Goal against state pi-goal cannot
			// see. Fail closed before recording anything; `propose_goal` refuses too.
			if (store.reconstructionFailedClosed()) {
				ctx.ui.notify(
					unreadableGoalStateRefusal(
						"pi-goal will not record an Objective clarification that could create or replace a Goal it " +
							"cannot see",
					),
					"error",
				);
				return;
			}
			// A second `/goal` replaces the pending clarification: the newest entry wins
			// on the branch, and the new idea and flags are what the next save commits.
			// The old interview is abandoned as a conversation too (the model is told so
			// below), and an editor still open for it can never commit anything because
			// the captured pending is no longer current (see `endPendingClarification`).
			// Any confirmed draft awaiting a commit is abandoned with it.
			const replaced = pendingClarification !== null;
			const pending: PendingClarification = {
				idea: request.objective,
				budget: request.budget,
				attachments: request.attachments,
				// The Goal slot this interview may act on. A Goal created, replaced, or
				// cleared after this point makes the draft stale wherever it is replayed.
				baseGoalId: previous?.id ?? null,
			};
			try {
				pi.appendEntry(CLARIFICATION_ENTRY_TYPE, openClarificationEntry(pending));
			} catch (error) {
				// The previous pending (if any) is unchanged: memory and branch still agree
				// that it is the current interview.
				ctx.ui.notify(
					`Goal not created: recording the Objective clarification in the session failed (${describeError(error)}). ` +
						"Nothing was created; fix the cause and run /goal again. Any earlier open clarification is unchanged.",
					"error",
				);
				return;
			}
			pendingConfirmation = null;
			pendingClarification = pending;
			// The user-facing half of the contract: no Goal exists, the model interviews
			// them, and the editor is where both the title and the Objective become real.
			ctx.ui.notify(
				replaced
					? "Objective clarification restarted: no Goal was created for the previous idea, and no Goal is committed " +
							"for this one yet. Answer the model's questions about the new idea, then review and save the drafted " +
							"Goal in the confirmation editor. Cancelling it creates nothing."
					: "Objective clarification started: no new Goal is committed yet. Answer the model's questions about the " +
							"objective, constraints, and acceptance criteria, then review and save the drafted Goal in the " +
							"confirmation editor. Cancelling it creates nothing.",
				"info",
			);
			// The first Goal-work message is the interview, so it is delivered the same
			// busy-safe way: idle starts a turn, an in-flight run receives a steer.
			deliverMessage(formatClarificationInterviewMessage(pending.idea, { replaced }), ctx);
		});
	}

	/** What ending one captured pending clarification did. */
	type PendingClarificationEnd =
		/** The captured clarification was current and its end is durable. */
		| { kind: "ended" }
		/** It is no longer the current pending clarification; nothing was cleared. */
		| { kind: "stale" }
		/** The durable end entry could not be written; memory still holds the state. */
		| { kind: "persistence"; error: unknown };

	/**
	 * Record durably that the clarification is over, and clear it from memory.
	 *
	 * The terminal `ended` state is reserved for an outcome that really is final:
	 * the user cancelled, the dialog timed out, a stale confirmation lost the race,
	 * or the Goal committed. An *uncommitted save* is never recorded here — it is
	 * the `confirming` state written before the commit, so a failed or interrupted
	 * creation can still reopen the user's draft.
	 *
	 * Durability before memory: the entry is appended first and the in-memory view
	 * is cleared only after the append succeeded, so a failed append leaves memory
	 * and branch agreeing that the clarification is still open and the caller
	 * surfaces the failure instead of reporting a clear that never landed.
	 */
	function clearPendingClarification(): PendingClarificationEnd {
		try {
			pi.appendEntry(CLARIFICATION_ENTRY_TYPE, endedClarificationEntry());
		} catch (error) {
			return { kind: "persistence", error };
		}
		pendingClarification = null;
		pendingConfirmation = null;
		return { kind: "ended" };
	}

	/**
	 * End one captured clarification, but only while it is still the current one.
	 *
	 * The identity rule is what keeps a stale confirmation — the model can issue
	 * concurrent `propose_goal` calls, and a newer `/goal` can replace the pending
	 * entry — from ending state that is not its own: the newer clarification, or the
	 * Goal another confirmation committed, is left exactly as it is.
	 */
	function endPendingClarification(pending: PendingClarification): PendingClarificationEnd {
		if (pendingClarification !== pending) return { kind: "stale" };
		return clearPendingClarification();
	}

	/**
	 * The refusal for a branch whose newest Goal snapshot cannot be read.
	 *
	 * Shared by the clarification command and the confirmation tool so both fail
	 * closed with the same recovery: repair the newest snapshot in the session file,
	 * restart, and start over. Acting anyway would write a new valid snapshot on top
	 * of the corrupt one, making the previously authoritative Goal unreachable.
	 */
	function unreadableGoalStateRefusal(what: string): string {
		return (
			`Goal not created: this branch's newest Goal snapshot is unreadable (malformed data or an unsupported ` +
			`version), so ${what}. Inspect the goal-state entries in the session file, remove or repair the newest ` +
			"one, then restart Pi and run /goal again."
		);
	}

	/**
	 * The tool result for a confirmation that created no Goal.
	 *
	 * Cancel, timeout, a host without a dialog, and a stale duplicate all land here.
	 * The result is built from what actually happened, never from the assumption that
	 * the captured clarification is still current:
	 *
	 * - still current and ended durably: zero side effects, and the model is told so;
	 * - no longer current (another confirmation committed, or a newer `/goal` replaced
	 *   it): nothing is cleared and the text names the state that is actually current,
	 *   because the structured payload must not contradict the prose;
	 * - the durable clear failed: reported as a tool error, because the clarification
	 *   is still open in the session and claiming a successful cancellation would be a
	 *   lie about durable state.
	 */
	function clarificationNotCreated(pending: PendingClarification, reason: string, ctx: ExtensionContext) {
		const current = store.get();
		const state = current ? toPublicState(current) : null;
		const ended = endPendingClarification(pending);
		if (ended.kind === "persistence") {
			const message =
				`No Goal was created: ${reason}. The pending clarification could not be recorded as ended ` +
				`(${describeError(ended.error)}), so it is still open and could be confirmed later. Nothing was created ` +
				"or materialized. Fix the session write and retry, or run /goal again to start over.";
			// Both surfaces: the model must not treat this as a clean cancel, and the
			// user must see that their cancellation did not become durable.
			ctx.ui.notify(message, "error");
			return goalToolError(message, state);
		}
		if (ended.kind === "stale") {
			const detail = current
				? `The current Goal ${current.id} (${current.status}) was not changed by this confirmation.`
				: "No Goal is current.";
			const pendingDetail =
				pendingClarification === null ? "" : " A newer clarification is open; it is unchanged.";
			return {
				content: [
					{
						type: "text" as const,
						text:
							`No Goal was created by this confirmation: ${reason}, and it was no longer the current ` +
							`clarification (another confirmation or a newer /goal took over). ${detail}${pendingDetail} ` +
							"Do not call propose_goal again for this document.",
					},
				],
				structuredContent: { goal: state },
				details: { goal: state },
			};
		}
		return {
			content: [
				{
					type: "text" as const,
					text:
						`No Goal was created: ${reason}. The pending clarification is cleared, no Goal state was written, ` +
						"no attachment was materialized, and no remote image was fetched" +
						(current ? "; the current Goal is untouched" : "") +
						". Tell the user no Goal was created and stop; do not call propose_goal again. They can start over " +
						"with /goal <objective>.",
				},
			],
			structuredContent: { goal: state },
			details: { goal: state },
		};
	}

	/**
	 * The `propose_goal` tool: draft → confirmation editor → command-origin commit.
	 *
	 * Only a pending clarification makes this tool mean anything: without one it
	 * refuses and touches nothing, so a model that calls it from an ordinary turn
	 * cannot create a Goal behind the user's back. The editor is the creation
	 * authority — saving it commits exactly the title and Objective the user left in
	 * the document, through the same commit the typed `/goal` uses — and the model's
	 * arguments are only the prefill.
	 *
	 * An invalid title structure (a first line that is not `Title: …`, an over-long
	 * title, a line break) reopens the document for correction instead of discarding
	 * what the user wrote. Cancel and timeout are the safe default: nothing is
	 * created, nothing is fetched, and the pending entry is cleared.
	 */
	async function proposeGoal(params: { title: string; objective: string }, ctx: ExtensionToolContext) {
		const currentState = () => {
			const goal = store.get();
			return goal ? toPublicState(goal) : null;
		};
		// The tool's ownership is re-read here, not trusted from session_start: another
		// extension can take the name after pi-goal registered it, and a confirmation
		// opened by a tool pi-goal no longer owns could never commit.
		if (!clarifyOnCreate.enabled || !proposeGoalRegistered || !toolSurvivedRegistration(PROPOSE_GOAL_TOOL_NAME)) {
			return goalToolError(
				"Goal not created: Objective clarification is off for this session (goal.clarifyOnCreate is false, or the " +
					"propose_goal tool was not registered or is no longer pi-goal's), so there is no clarification to " +
					"confirm. The user creates a Goal with /goal <objective>.",
				currentState(),
			);
		}
		// A branch whose Goal state failed closed is never written over: a confirmation
		// would create or replace a Goal slot pi-goal cannot see. Checked before the
		// pending lookup so the diagnostic names the real cause.
		if (store.reconstructionFailedClosed()) {
			return goalToolError(
				unreadableGoalStateRefusal("pi-goal will not commit a confirmation over a Goal slot it cannot see"),
				currentState(),
			);
		}
		const pending = pendingClarification;
		if (pending === null) {
			return goalToolError(
				"Goal not created: no Objective clarification is in progress. propose_goal is accepted only while the " +
					"interview /goal <raw idea> starts is open, so no confirmation editor was opened and nothing was " +
					"created. Ask the user to run /goal <objective> if they want a Goal.",
				currentState(),
			);
		}
		// Admission is checked before the editor opens: a disabled extension refuses
		// every new Goal, and it must not invite the user to type a document it would
		// then decline to commit. The pending clarification stays open, so re-enabling
		// the setting lets the same draft be confirmed.
		if (!admission.enabled) return admissionDisabledToolError("Goal not created:");
		// A retry after a failed or interrupted commit reopens the user's saved
		// document; a fresh model draft never overwrites text the user already
		// confirmed. The reopened document is validated on save like any other editor
		// content, so a corrupt stored draft is refused and corrected rather than
		// committed.
		const retry =
			pendingConfirmation !== null && pendingConfirmation.pending === pending ? pendingConfirmation.draft : null;
		let document: string;
		if (retry !== null) {
			document = formatClarificationDocument(retry.title, retry.objective);
		} else {
			const title = validateGoalTitle(String(params.title ?? ""), "created");
			if (!title.ok) return goalToolError(title.error, currentState());
			const objective = validateObjective(String(params.objective ?? ""));
			if (!objective.ok) return goalToolError(objective.error, currentState());
			document = formatClarificationDocument(title.title, objective.objective);
		}
		if (!ctx.hasUI) {
			return clarificationNotCreated(
				pending,
				"this Pi mode has no dialog-capable UI to confirm the Goal in, so the confirmation editor could not be opened",
				ctx,
			);
		}
		for (;;) {
			// Only the host call is guarded: everything after it is validation or the
			// commit, and a throw there must never be reported as a cancelled editor.
			let edited: string | undefined;
			try {
				edited = await withDialogTimeout(
					ctx.ui.editor(CLARIFICATION_EDITOR_TITLE, document),
					dialogTimeoutMs(EDIT_TIMEOUT_MS),
					undefined,
				);
			} catch (error) {
				return clarificationNotCreated(
					pending,
					`the confirmation editor failed (${describeError(error)})`,
					ctx,
				);
			}
			if (edited === undefined) {
				return clarificationNotCreated(pending, "the user cancelled the confirmation, or it timed out unanswered", ctx);
			}
			const parsed = parseClarificationDocument(edited);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				document = edited;
				continue;
			}
			const confirmedTitle = validateGoalTitle(parsed.title, "created");
			if (!confirmedTitle.ok) {
				ctx.ui.notify(confirmedTitle.error, "error");
				document = edited;
				continue;
			}
			const confirmedObjective = validateObjective(parsed.objective);
			if (!confirmedObjective.ok) {
				ctx.ui.notify(confirmedObjective.error, "error");
				document = edited;
				continue;
			}
			// The captured clarification must still be the current one: a newer `/goal`,
			// or another confirmation that already committed, took over while the editor
			// was open. Checked before the confirming record so a stale save records
			// nothing at all.
			if (pendingClarification !== pending) {
				return goalToolError(
					"Goal not created: this confirmation was no longer the current clarification when it was saved " +
						"(a newer /goal replaced it, or another confirmation already committed). Nothing was created " +
						"from this document; use the current state instead.",
					currentState(),
				);
			}
			const draft: ConfirmedClarificationDraft = {
				title: confirmedTitle.title,
				objective: confirmedObjective.objective,
			};
			// Durable intent before the commit, never a terminal end: a failed creation
			// or a crash mid-fetch must leave the user's edited draft and held flags open
			// to retry. The terminal end is written only after the Goal commit succeeds.
			try {
				pi.appendEntry(CLARIFICATION_ENTRY_TYPE, confirmingClarificationEntry(pending, draft));
			} catch (error) {
				const message =
					`Goal not created: the confirmed draft could not be recorded in the session ` +
					`(${describeError(error)}), so nothing was committed and the clarification is still open. ` +
					"The draft was not saved; fix the session write and save again.";
				ctx.ui.notify(message, "error");
				return goalToolError(message, currentState());
			}
			// While the commit runs no confirmation is open: a concurrent propose_goal
			// must not start a second save against the same draft.
			const attempt = { pending, draft };
			pendingConfirmation = attempt;
			pendingClarification = null;
			const outcome = await commitGoalCreation(
				{
					objective: draft.objective,
					budget: pending.budget,
					attachments: pending.attachments,
					title: draft.title,
					kickoff: "steer",
				},
				ctx,
			);
			if (!outcome.ok) {
				// Nothing was committed. Reopen the confirmation with the saved draft and
				// held flags — unless a newer `/goal` replaced this attempt while the commit
				// ran, in which case the newer state is not this call's to overwrite.
				const restored = pendingConfirmation === attempt && pendingClarification === null;
				if (restored) pendingClarification = pending;
				if (restored) {
					ctx.ui.notify(
						"The confirmation is still open with your saved draft and held flags; ask the model to retry " +
							"propose_goal to review and save it again.",
						"info",
					);
				}
				const kept = restored
					? " The saved draft and held flags are kept: call propose_goal again to reopen the confirmation with " +
						"that draft, or run /goal <new idea> to start over."
					: "";
				return goalToolError(`${outcome.message}${kept}`, currentState());
			}
			// The Goal is durable. End the clarification durably; the confirming record is
			// already stale by base identity if this final write fails, so a crash here can
			// never resurrect the draft. A newer `/goal` that replaced this attempt keeps
			// its own state untouched.
			if (pendingConfirmation === attempt && pendingClarification === null) {
				const cleared = clearPendingClarification();
				if (cleared.kind === "persistence") {
					pendingClarification = null;
					pendingConfirmation = null;
					ctx.ui.notify(
						`Goal ${outcome.goal.id} was created, but the Objective clarification's end could not be ` +
							`recorded (${describeError(cleared.error)}). The Goal is unaffected; the leftover draft is ` +
							"abandoned by the new Goal's identity.",
						"warning",
					);
				}
			}
			const state = toPublicState(outcome.goal);
			const delivery =
				outcome.delivery === "started"
					? "Initial work started."
					: "Initial work was steered into the run that was already in flight.";
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Goal ${outcome.goal.id} created and activated from the confirmed clarification. ` +
							`Title: ${JSON.stringify(outcome.goal.title ?? "")}. ` +
							`The user edited and saved this Objective, so it is the Goal contract: ${JSON.stringify(outcome.goal.objective)}. ${delivery} ` +
							"Continue toward it and call get_goal if the objective or its status is absent or truncated.",
					},
				],
				structuredContent: { goal: state },
				details: { goal: state },
			};
		}
	}

	/**
	 * Commit one validated creation request: the command-origin creation path.
	 *
	 * Everything a creation must do to be real happens here, in this order, for both
	 * entry points: the single-Goal refusal, the superseded-tail safeguards, attachment
	 * materialization and remote fetching, the durable stage/commit, the kickoff, the
	 * on-disk durability poll, and the success announcement. The clarification only
	 * decides *what* title and Objective are committed and *when*; it never bypasses
	 * one of these steps.
	 *
	 * A refusal notifies the user exactly as it always did and also returns its
	 * message, so the confirmation tool can hand the model the same diagnostic.
	 */
	async function commitGoalCreation(
		request: GoalCreationRequest,
		ctx: GoalCreationContext,
	): Promise<GoalCreationOutcome> {
		// A refusal notifies the user exactly as it always did and returns its text, so
		// a caller that must answer the model can carry the same diagnostic.
		const refuse = (message: string, level: "warning" | "error" = "warning"): GoalCreationOutcome => {
			ctx.ui.notify(message, level);
			return { ok: false, message };
		};
		// Only `createOrReplaceGoal` asks for the idle wait, and its context always has
		// `waitForIdle`. A tool context never does, which is why the clarified path
		// always steers instead of asking for this mode.
		if (request.kickoff === "wait-idle" && ctx.waitForIdle === undefined) {
			return refuse(
				"Goal not created: this creation path cannot wait for the current run to finish, so no kickoff could be " +
					"delivered. Nothing was stored.",
				"error",
			);
		}
		// The budget flag is resolved at commit time, so the durable pending
		// clarification keeps the user's flag rather than a number derived from
		// settings that may be read again.
		const budget = resolveGoalTokenBudget(
			request.budget.kind === "none" ? "none" : request.budget.kind === "value" ? request.budget.value : undefined,
			budgetSettings,
		);
		if (!budget.ok) return refuse(budget.error, "error");

		// Serialized create-or-replace: concurrent /goal commands (for example two
		// sent while Pi is busy) run exclusively, and the authoritative existing-Goal
		// check happens inside the lock, so the second command always sees the first's
		// committed Goal and is refused by it. Every await is followed by a
		// revalidation of the Goal the command captured: a kickoff that was prepared
		// against older state must never override the lifecycle commands the user ran
		// in the meantime.
		return runExclusive(async (): Promise<GoalCreationOutcome> => {
			const previous = store.get();
			// Single-Goal creation (ADR-0003): an unfinished Goal — active, paused,
			// blocked, usage_limited, or budget_limited — is never replaced from the
			// command path. Abandoning it is the user's explicit /goal:clear (or
			// finishing it), never a side effect of a creation, so the command refuses
			// here, before any dialog and before any durable transition. A complete Goal
			// does not block: the creation below supersedes it through the ordinary
			// replacement machinery, which keeps its record on the branch as history.
			if (previous && previous.status !== "complete") {
				return { ok: false, message: refuseUnfinishedGoal(ctx, previous) };
			}
			const replacing = previous != null;

			// A fresh create (for example after a Clear) has no current Goal to preserve,
			// but a superseded identity's open admission still has to be closed before the
			// new snapshot. Creating a Goal leaves no marker of its own on the branch, so
			// replay only closes that admission at a durable freeze: refuse rather than
			// lose admitted work, or let the live path and the replay disagree about it.
			if (!replacing) {
				if (!store.closeSupersededForCreation(pi)) {
					return refuse(
						"Goal not created: the replaced Goal's admitted work could not be written to the session. " +
							"Nothing was stored; fix the cause and run /goal again.",
						"error",
					);
				}
			}

			const goal = store.create(request.objective, "command", {
				tokenBudget: budget.tokenBudget,
				...(request.title === undefined ? {} : { title: request.title }),
			});
			const sameRecord = (candidate: GoalRecord | null | undefined) =>
				candidate != null && candidate.id === goal.id && candidate.revision === goal.revision;
			// Loaded attachment content for the kickoff message; filled by the
			// materialization below and empty for a Goal without attachments.
			let attachmentContents: AttachmentContent[] = [];
			// Retract artifacts only while no snapshot has committed them. Once the
			// commit succeeds, clear/replacement/rollback retention applies.
			let uncommittedAttachmentRoot: string | null = null;
			try {
				// Materialize the requested attachments into the immutable,
				// extension-owned store keyed by this Goal's identity *before* the
				// snapshot is staged: validation and materialization failures refuse
				// the whole creation here — the previous Goal (if any) is untouched,
				// nothing was appended, and no success event was emitted. A refused
				// materialization retracts only the uncommitted store directory; a
				// Goal whose snapshot committed keeps its artifacts forever.
				//
				// For a clarified creation this is the first moment an attachment is
				// read or a remote image is fetched: the flags were held, unread, while
				// the interview ran, so a cancelled clarification never touches them.
				if (request.attachments.length > 0) {
					const root = attachmentRoot(ctx);
					if (!root) {
						throw new Error("the session file could not be resolved for the attachment store");
					}
					uncommittedAttachmentRoot = root;
					const materialized = await materializeAttachmentRequests(root, goal.id, request.attachments, {
						cwd: sessionWorkingDirectory(ctx),
						remote: remoteImageFetchOptions(),
					});
					if (!materialized.ok) {
						// Not a write failure of the Goal path: refuse with the validation
						// error, retracting the uncommitted artifacts on the way out.
						discardUncommittedArtifacts(root, goal.id);
						return refuse(materialized.error, "error");
					}
					goal.attachments = materialized.attachments;
					attachmentContents = materialized.contents;
				}
				// The remote fetch is a real network await, and the create lock
				// excludes only other create/replace commands: a /goal:clear, an
				// edit, a lifecycle command, or a create_goal tool call can run
				// while DNS and the body read are pending. Revalidate the exact
				// record this command captured — null included, for a fresh
				// creation — immediately after materialization and before any
				// durable transition (the superseded freeze, the stage, and the
				// commit). On a mismatch the current Goal stays untouched, the
				// never-committed artifacts are retracted, and no success event
				// is emitted.
				const captured = previous ?? null;
				const afterMaterialization = store.get();
				const unchanged =
					captured === null
						? afterMaterialization == null
						: afterMaterialization != null &&
							afterMaterialization.id === captured.id &&
							afterMaterialization.revision === captured.revision;
				if (!unchanged) {
					if (uncommittedAttachmentRoot) {
						discardUncommittedArtifacts(uncommittedAttachmentRoot, goal.id);
					}
					return refuse(
						"Goal not created: the Goal changed while the remote image was being fetched" +
							(afterMaterialization
								? ` (now ${afterMaterialization.status}, revision ${afterMaterialization.revision})`
								: " (no Goal is set anymore)") +
							", so this command no longer described the current state. Nothing was replaced and the " +
							"fetched artifact was retracted; the current Goal is unchanged. Run /goal again to create " +
							"it against the current state.",
						"warning",
					);
				}
				// Replacement must preserve the superseded Goal's already-accounted
				// totals as a durable historical record before the new identity takes
				// over the session's Goal slot and resets the live ledger. If that
				// freeze fails, the replacement must not proceed.
				if (replacing && !store.preserveSupersededForReplacement(pi)) {
					throw new Error("could not freeze the replaced Goal's admitted work");
				}
				// Stage and commit before any wait: the new record is what a
				// concurrent /goal:clear, edit, pause, or resume acts on, and
				// revalidating it after the wait detects exactly that change.
				store.stage(pi, goal);
				store.commit(goal);
				uncommittedAttachmentRoot = null;
				updateStatus(ctx);
			} catch (error) {
				if (uncommittedAttachmentRoot) {
					discardUncommittedArtifacts(uncommittedAttachmentRoot, goal.id);
				}
				if (replacing) {
					// A failed *replacement* write must not erase the existing
					// Goal: nothing was appended, so the previous record stays
					// current in memory and on disk. The creation rollback
					// (tombstone + no Goal) would be wrong here - it would drop
					// the Goal the user still has.
					const reason = error instanceof Error ? error.message : String(error);
					return refuse(
						`Goal not created: writing the replacement to the session failed (${reason}). ` +
							"The current Goal is unchanged; fix the cause and run /goal again.",
						"error",
					);
				}
				// Nothing durable was confirmed for a brand-new Goal: retract it
				// so no phantom state survives a failed stage.
				store.rollback(pi);
				updateStatus(ctx);
				return { ok: false, message: notifyWriteFailure(ctx, error) };
			}

			let delivery: "started" | "steered";
			if (!replacing && request.kickoff === "wait-idle") {
				// There is no Goal continuation loop that could starve this wait
				// (abort also settles a stuck run), and the seam above declines to
				// adopt the run we are waiting for. Revalidate afterwards: a
				// clear/edit/pause issued while creation waited must win over
				// starting the objective the user has already moved away from.
				pendingInitialKickoff = { id: goal.id, revision: goal.revision };
				try {
					// Defined for every `wait-idle` caller (see GoalCreationContext).
					await ctx.waitForIdle?.();
				} finally {
					pendingInitialKickoff = null;
				}
				const waited = store.get();
				if (!sameRecord(waited)) {
					const message = waited
						? `Goal ${goal.id} was not started: it changed while creation waited for the current run to finish ` +
								`(now ${waited.status}, revision ${waited.revision}). Initial work was not started; the current state stands.`
						: `Goal ${goal.id} was not started: it was cleared while creation waited for the current run to finish. ` +
								"Nothing remains active; run /goal <objective> again to start over.";
					updateStatus(ctx);
					return refuse(message, "warning");
				}
				// A new Goal identity starts every audit and every anti-loop counter
				// from zero, and the kickoff it is about to send is a Goal turn for
				// the blocked audit but attended work: the user just typed /goal, so it
				// must not consume one of the automatic turns an anti-loop bound
				// allows.
				safety.reset();
				pendingRunKind = "kickoff";
				// The admission segment opens when the kickoff is delivered, in
				// `applyDeliveredUserMessage`, like every other work message.
				pi.sendUserMessage(formatKickoffMessage(goal, attachmentContents));
				delivery = "started";
			} else {
				// The superseded Goal is complete, but its completing run may still be in
				// flight (the model's final summary), and the user's next Goal is never
				// parked behind the previous Goal's last words: the kickoff is steered into
				// the active run or starts immediately when idle. A clarified creation is
				// always delivered this way: the confirmation is answered from inside a
				// running tool call, where waiting for idle would deadlock.
				delivery = deliverWorkMessage(formatKickoffMessage(goal, attachmentContents), ctx);
				if (!replacing) {
					// A clarified fresh creation is still a new identity, and its kickoff is
					// the attended work the user just confirmed.
					safety.reset();
				}
			}

			// Confirm durability before announcing success: the *last* goal-state
			// entry on disk must be this Goal (a tombstone written by a /goal
			// clear during the wait counts as not durable). Re-read the current
			// record after the wait so the announcement describes reality.
			const durable = await waitForDurability(ctx, goal.id);
			const now = store.get();
			if (now?.id === goal.id && !durable) {
				// Retract only this command's record. A replacement must restore
				// the previous Goal; clearing the slot with a tombstone would throw
				// away a Goal that was never replaced on disk.
				if (replacing && previous) store.restore(pi, previous);
				else store.rollback(pi);
				updateStatus(ctx);
				return { ok: false, message: notifyWriteFailure(ctx, new Error("the Goal snapshot did not reach the session file in time")) };
			}
			if (!now || now.id !== goal.id) {
				// The Goal this command created was cleared (or otherwise removed)
				// before creation could be announced; report that instead of
				// claiming success for state that no longer exists.
				const message =
					`Goal ${goal.id} was cleared before creation finished; nothing remains active. ` +
					"Run /goal <objective> again to start over.";
				updateStatus(ctx);
				return refuse(message, "warning");
			}

			// The creation (or replacement) was announced on the event stream by the
			// store's commit, at the moment its snapshot's append succeeded — the same
			// durable bar every other transition uses. This announcement waits for the
			// on-disk poll instead, because the user-facing message must not outlive a
			// session file that never appeared.
			//
			// A *fresh* creation may also name the session, and only a fresh one: a
			// replacement is a new Goal in a session that already has Goal history, so
			// naming it would relabel a session the user may already recognize by its
			// old name. Every failure path above returned before this point, so a
			// refused, failed, or rolled-back creation never names anything.
			if (!replacing) nameSessionFromGoal(ctx, now);
			ctx.ui.notify(
				replacing
					? `Goal ${goal.id} created and activated, replacing ${previous!.id}. Initial work ${delivery === "started" ? "started" : "steered into the running work"}.`
					: `Goal ${goal.id} created and activated. Initial work ${delivery === "started" ? "started" : "steered into the running work"}.`,
				"info",
			);
			return { ok: true, goal: now, delivery };
		});
	}

	/** Report a failed creation write and return the same text for a model-facing caller. */
	function notifyWriteFailure(ctx: ExtensionContext, cause: unknown): string {
		const reason = cause instanceof Error ? cause.message : String(cause);
		const message =
			`Goal not created: writing the Goal to the session failed (${reason}). ` +
			"Nothing was stored; fix the cause and run /goal again.";
		ctx.ui.notify(message, "error");
		return message;
	}

	async function waitForDurability(ctx: ExtensionContext, goalId: string): Promise<boolean> {
		const deadline = Date.now() + DURABILITY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (store.isDurable(ctx, goalId)) return true;
			await new Promise((resolve) => setTimeout(resolve, DURABILITY_POLL_MS));
		}
		return store.isDurable(ctx, goalId);
	}

	async function reportStatus(ctx: ExtensionCommandContext): Promise<void> {
		const goal = store.get();
		if (!goal) {
			// An open clarification is the one piece of user-facing state a branch can
			// hold without a Goal, and it is exactly what a restart must not hide: bare
			// `/goal` names it and the flags it is still holding. It is not advertised
			// when this session cannot confirm it (the flow is off, or another extension
			// has taken the tool), because either would be a dead end.
			const offered =
				pendingClarification !== null &&
				clarifyOnCreate.enabled &&
				toolSurvivedRegistration(PROPOSE_GOAL_TOOL_NAME)
					? pendingClarification
					: null;
			ctx.ui.notify(
				offered === null
					? formatNoGoal(admission.enabled)
					: `${formatNoGoal(admission.enabled)} ${formatOpenClarificationStatus(offered, {
							confirmed: pendingConfirmation !== null && pendingConfirmation.pending === offered,
						})}`,
				"info",
			);
			return;
		}
		ctx.ui.notify(formatGoalSummary(toPublicState(goal), { admissionEnabled: admission.enabled }), "info");
	}

	/**
	 * Render the branch-local Goal history.
	 *
	 * Read-only by construction: the handler reads the selected branch's history
	 * entries and notifies a formatted timeline. There is no mutation here and no
	 * mutation anywhere else that takes a history record as input — the timeline is
	 * derived diagnostic data whose only purpose is to be read, so `/goal:history`
	 * can never become a second interface for changing Goal state.
	 *
	 * A branch with no history renders an explicit "no history" line rather than
	 * silence, and unreadable entries are counted and surfaced as a notice instead
	 * of being silently dropped: a timeline that quietly omits a record would
	 * understate what the branch holds. Neither case touches the Goal — the notice
	 * is a rendering diagnostic, and the authoritative Goal is unaffected.
	 */
	function reportHistory(ctx: ExtensionCommandContext): void {
		ctx.ui.notify(formatGoalHistory(store.readHistory(ctx)), "info");
	}
}
