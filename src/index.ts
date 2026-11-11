/**
 * pi-goal — Codex-style persistent Goals for Pi.
 *
 * Registers the /goal command, the get_goal / create_goal / update_goal model
 * tools, and the automatic-continuation seam. A Goal is a durable,
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
 * The full lifecycle is user-controlled. `/goal edit <objective>` changes the
 * objective in place (same identity, same history) and steers an active run;
 * `/goal pause` stops admission of further automatic runs immediately;
 * `/goal resume` restarts eligible work; `/goal clear` writes a durable
 * tombstone and returns the session to ordinary prompt behavior. Replacing an
 * unfinished objective through `/goal <objective>` requires confirmation
 * first. None of these commands wait for an active run to become idle — an
 * active Goal's own continuation loop would otherwise starve them — so every
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
 * Token budgets, usage accounting, status UI, and the final documentation pass
 * land in their own later milestones.
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
	corroboratePauseRequest,
	formatContinuationMessage,
	formatEditMessage,
	formatGoalSummary,
	formatKickoffMessage,
	formatNoGoal,
	formatResumeMessage,
	getGoalOutputSchema,
	MAX_BLOCKER_LENGTH,
	MAX_OBJECTIVE_LENGTH,
	MIN_BLOCKER_LENGTH,
	MIN_OBJECTIVE_LENGTH,
	MIN_USER_REQUEST_LENGTH,
	type GoalBinding,
	type GoalPublicState,
	type GoalRecord,
	previewObjective,
	toPublicState,
} from "./goal.ts";
import { GoalStore, validateBlocker, validateObjective, type GoalMutationFailure } from "./store.ts";
import {
	classifyProviderFailure,
	GoalSafetyMonitor,
	type GoalRunKind,
	type ProviderFailureEvidence,
	type SafetyStop,
} from "./safety.ts";

/** Auto-decline a replacement confirmation after this long (safe default: no discard). */
const REPLACE_CONFIRM_TIMEOUT_MS = 120_000;

/** How long creation waits for the snapshot to become durable on disk. */
const DURABILITY_TIMEOUT_MS = 5000;
const DURABILITY_POLL_MS = 15;

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
type GoalCommand =
	| { kind: "status" }
	| { kind: "create"; objective: string }
	| { kind: "edit"; objective: string }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "clear" }
	| { kind: "invalid"; message: string };

/**
 * Parse /goal arguments.
 *
 * `pause`, `resume`, and `clear` are subcommands only when they are the entire
 * argument, so an objective that merely begins with one of them ("clear the
 * lint errors") stays a valid objective. `edit` is a subcommand whenever it is
 * the first word, because its remainder is the new objective; bare `/goal edit`
 * is a usage error rather than an objective literally named "edit".
 */
function parseGoalCommand(args: string): GoalCommand {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "status" };
	const spaceIndex = trimmed.search(/\s/);
	const first = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const remainder = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
	const word = first.toLowerCase();
	if (remainder === "" && (word === "pause" || word === "resume" || word === "clear")) {
		return { kind: word };
	}
	if (word === "edit") {
		if (remainder === "") {
			return {
				kind: "invalid",
				message: 'Usage: /goal edit <new objective>. Bare "/goal edit" does not say what the new objective is.',
			};
		}
		return { kind: "edit", objective: remainder };
	}
	return { kind: "create", objective: trimmed };
}

export default function goalExtension(pi: ExtensionAPI): void {
	const store = new GoalStore();
	const safety = new GoalSafetyMonitor();

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
	 * against, snapshotted at every `turn_start` — before the provider request,
	 * hence before the model could have seen anything newer. Model-side lifecycle
	 * transitions (`update_goal`) are bound to this snapshot: a held response
	 * released after a user edit, replacement, pause, or resume executes against
	 * a revised Goal and must be refused instead of mutating it, because the
	 * model decided on state it can no longer see reflected. `null` while no
	 * turn has started or no Goal existed when the turn began.
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

	pi.on("turn_start", () => {
		const goal = store.get();
		turnGoal = goal ? { id: goal.id, revision: goal.revision } : null;
	});

	/**
	 * Serializes Goal creation across concurrent /goal commands. Commands that
	 * arrive while Pi is busy both wait for idle; without serialization both
	 * could pass the existing-Goal check before either persists, and the second
	 * would silently replace the first. Every create-or-replace runs its guards,
	 * confirmation, write, kickoff, and durability confirmation exclusively, so
	 * a losing command always sees the winner's committed Goal and has to be
	 * confirmed by the user before replacing it.
	 */
	let createLock: Promise<void> = Promise.resolve();
	function runExclusive(fn: () => Promise<void>): Promise<void> {
		const run = createLock.then(fn, fn);
		createLock = run.catch(() => {});
		return run;
	}

	pi.on("session_start", (_event, ctx) => {
		store.reconstruct(ctx);
		// Runtime-only counters must not survive into a new runtime; the durable
		// blocked audit is reconstructed with the Goal.
		safety.reset();
		const goal = store.get();
		if (goal) {
			ctx.ui.notify(`Goal ${goal.id} restored (${goal.status}).`, "info");
		}
	});
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
			ctx.ui.notify(
				`Goal ${after.id} restored from the selected branch (${after.status}).` +
					(after.status === "active"
						? " It continues at the next settlement once a run starts; navigation alone starts no run."
						: ""),
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
	 * turn's model transitions were prepared against; Pi rejects navigation while
	 * a turn is streaming, so at this point the binding is either already fresh
	 * for the selected branch or will be refreshed at the next `turn_start`. If a
	 * turn somehow raced a navigation, leaving the binding untouched keeps the
	 * execute-time identity+revision check refusing the stale transition instead
	 * of handing it a fresh binding it was never prepared against.
	 */
	pi.on("session_tree", (_event, ctx) => {
		const before = store.get() ?? null;
		const after = store.reconstruct(ctx);
		notifyBranchChange(ctx, before, after);
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
	pi.on("input", (_event, ctx) => {
		continuesGoalTurn = false;
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
	 * Automatic continuation, at Pi's safe settlement boundary only.
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
		if (!goal || goal.status !== "active") {
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

		// The Goal turn is over: evaluate it before deciding whether to continue.
		const stop = safety.evaluateRun(event.outcome);
		closeGoalTurn(ctx);
		if (stop) {
			applySafetyStop(stop, ctx);
			return;
		}

		// The next run is Goal work, whether Pi starts it for our continuation or
		// for queued work that already satisfies the decision.
		pendingRunKind = "automatic";
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: CUSTOM_MESSAGE_TYPE,
					content: formatContinuationMessage(goal),
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
					"Automatic continuation has stopped; /goal resume restarts it with a fresh blocked audit once the " +
					"blocker is resolved.",
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Goal ${goal.id} reached a conservative stop (${stop.kind}) but could not be persisted as blocked ` +
				`(${describeError(result.reason === "persistence" ? result.error : undefined)}). The Goal stays ` +
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
	 */
	function handleProviderFailure(goal: GoalRecord, ctx: ExtensionContext): void {
		const failure = classifyProviderFailure(providerFailure ?? {});
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
						`(${failure.evidence}). Automatic continuation has stopped; /goal resume restarts it once the ` +
						"limit is resolved, because a usage-limited Goal never continues on its own.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Goal ${goal.id} hit a provider usage limit (${failure.evidence}) but could not be persisted as ` +
						`usage_limited (${describeError(result.reason === "persistence" ? result.error : undefined)}). The ` +
					"Goal stays active; fix the cause and it will stop again on the next failure.",
				"error",
			);
			return;
		}
		ctx.ui.notify(
			`Goal ${goal.id} is still active, but automatic continuation stopped for this run: the provider failed ` +
				`and Pi is not retrying it (${failure.evidence}). The Goal continues on the next successful run.`,
			"warning",
		);
	}

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Get the current session Goal: objective, lifecycle status, revision, token budget, " +
			"and the usage fields that are currently available. Returns goal: null when no Goal is set.",
		parameters: Type.Object({}),
		outputSchema: getGoalOutputSchema,
		promptSnippet: "Fetch the current session Goal objective and lifecycle status",
		promptGuidelines: [
			"Use get_goal when the session Goal objective or its lifecycle status is absent or truncated in the current context.",
		],
		async execute() {
			const goal = store.get();
			if (!goal) {
				return {
					content: [{ type: "text", text: formatNoGoal() }],
					structuredContent: { goal: null },
					details: { goal: null as GoalPublicState | null },
				};
			}
			const state = toPublicState(goal);
			return {
				content: [{ type: "text", text: formatGoalSummary(state) }],
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
			"Refuses when this session already has a Goal.",
		parameters: Type.Object({
			objective: Type.String({ minLength: MIN_OBJECTIVE_LENGTH, maxLength: MAX_OBJECTIVE_LENGTH }),
		}),
		outputSchema: getGoalOutputSchema,
		promptSnippet: "Create a persistent session Goal from an explicit user or system request",
		promptGuidelines: [
			"Call create_goal only when the user or the system explicitly asked for a Goal. Never infer one because a task looks large.",
			"Do not call create_goal while this session already has a Goal; it is refused. Use get_goal to inspect the current Goal instead.",
		],
		async execute(_toolCallId: string, params: { objective: string }, _signal, _onUpdate, ctx) {
			const validation = validateObjective(String(params.objective ?? ""));
			if (!validation.ok) {
				return goalToolError(validation.error, null);
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
				// session's single Goal slot. Replacing or clearing one is a user-owned
				// action (/goal <objective> confirms a replacement; /goal clears).
				return goalToolError(
					"A Goal is already set for this session (status: " +
						`${existing.status}); cannot create another one. ` +
						"Use get_goal to inspect it, or update_goal to complete it. Only the user can replace " +
						"or clear a Goal, with /goal <objective> or /goal clear.",
					toPublicState(existing),
				);
			}
			const goal = store.create(validation.objective, "tool");
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
			// No separate durability poll is needed here, unlike the /goal command whose
			// kickoff is what creates the session file: a tool call implies a running
			// session whose file already exists, and appendEntry writes synchronously
			// and throws on failure. The existing-Goal guard, the stage, and the commit
			// above also contain no await, so two create_goal calls issued in one
			// assistant turn cannot both pass the guard.
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
			"\"blocked\" once the same genuine blocker has persisted for at least three consecutive Goal turns, " +
			"and \"pause\" after an explicit user request, which must be quoted verbatim in user_request. " +
			"Complete and blocked are terminal: they stop the Goal's automatic continuation. " +
			"The model cannot resume, clear, replace, or budget-limit a Goal.",
		parameters: Type.Object({
			action: Type.String({
				description:
					"complete, blocked, or pause. Pause requires user_request quoting the user's exact request; " +
					"resume and clear are user-owned (/goal resume, /goal clear).",
			}),
			blocker: Type.Optional(
				Type.String({
					description:
						`Required for action blocked: the genuine blocker in plain language (${MIN_BLOCKER_LENGTH}-${MAX_BLOCKER_LENGTH} characters). ` +
						"Say what is actually blocking the work and what would unblock it.",
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
		outputSchema: getGoalOutputSchema,
		promptSnippet:
			"Mark the current Goal complete after an evidence audit, blocked after a persistent blocker, or paused at the user's explicit request",
		promptGuidelines: [
			"Call update_goal with action complete only after every explicit requirement of the objective is verified by current-state evidence.",
			`Call update_goal with action blocked only when the same genuine blocker has persisted for at least ${BLOCKED_AUDIT_THRESHOLD} consecutive Goal turns, and never because the work is merely hard, slow, uncertain, or incomplete.`,
			"Completing or blocking a Goal stops its automatic continuation, so never use either to escape a difficult or merely tiring task.",
			"Call update_goal with action pause only when the user explicitly asked to pause this Goal, and quote their exact words in user_request. Never pause on your own initiative.",
			"Never call update_goal to resume or clear a Goal; the user owns those transitions.",
		],
		/**
		 * Compatibility shim for the spellings a model reaches for: `{ status: … }`
		 * and `{ complete: true }` / `{ blocked: true }` / `{ paused: true }`. Without
		 * it a drifted call fails schema validation, the model sees only an arguments
		 * error, and the Goal keeps burning turns. Anything else is passed through
		 * with an empty action so an unsupported action is refused with a real
		 * explanation instead of being silently ignored.
		 */
		prepareArguments: (args: unknown): { action: string; blocker?: string; userRequest?: string } => {
			if (typeof args !== "object" || args === null) return { action: "" };
			const record = args as Record<string, unknown>;
			const blocker = typeof record.blocker === "string" ? record.blocker : undefined;
			const rawRequest = record.userRequest ?? record.user_request;
			const userRequest = typeof rawRequest === "string" ? rawRequest : undefined;
			const withBlocker = (action: string) => ({
				action,
				...(blocker === undefined ? {} : { blocker }),
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
			params: { action: string; blocker?: string; userRequest?: string },
			_signal,
			_onUpdate,
			ctx: ExtensionToolContext,
		) {
			const goal = store.get();
			if (!goal) {
				return goalToolError(formatNoGoal(), null);
			}
			if (params?.action === "blocked") {
				return reportBlocker(goal, params.blocker, ctx);
			}
			/**
			 * Refuse a call whose decision was prepared against a different Goal
			 * state. The binding comes from `turn_start` of the turn whose model
			 * request proposed this call, so a held response released after a user
			 * edit / replacement / pause / resume is refused instead of mutating
			 * the revised Goal the model never saw.
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
				return {
					content: [{ type: "text", text: `Goal ${completed.goal!.id} marked complete.` }],
					structuredContent: { goal: state },
					details: { goal: state },
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
							"keep working; the user can also pause directly with /goal pause.",
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
								"supersedes the request. If the user does want a pause they can run /goal pause; otherwise keep working.",
							toPublicState(goal),
						);
					}
					return goalToolError(
						"update_goal could not verify an explicit user request to pause this Goal: no recent " +
							`user message contains ${JSON.stringify(previewObjective(quote, 200))}. ` +
							"If the user did ask, repeat the call quoting their exact words in user_request; " +
							"otherwise keep working. Pausing also stays available to the user as /goal pause.",
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
				const state = toPublicState(paused.goal!);
				return {
					content: [
						{
							type: "text",
							text:
								`Goal ${goal.id} paused at the user's explicit request (verified). ` +
								"Report the pause and the current progress, then stop Goal work for this turn; " +
								"the user restarts work with /goal resume.",
						},
					],
					structuredContent: { goal: state },
					details: { goal: state },
				};
			}
			return goalToolError(
				"update_goal supports only action complete, action blocked with a plain-language blocker, " +
					"and action pause after an explicit user request (quote it in user_request). " +
					"Resuming and clearing stay with the user (/goal resume, /goal clear).",
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
	 * durable across compaction and a session restore) and refused with the
	 * current count, which is also what tells the model to keep working.
	 */
	function reportBlocker(
		goal: GoalRecord,
		rawBlocker: string | undefined,
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
		const result = store.markBlockedReport(pi, {
			blocker: validation.blocker,
			turn: safety.currentTurn,
		});
		if (result.ok && !result.repeat) blockerCountedThisRun = true;
		if (!result.ok) {
			const message =
				result.reason === "persistence"
					? `Blocker not recorded: writing the Goal to the session failed (${describeError(result.error)}). The Goal is still active; fix the cause and call update_goal again.`
					: "Blocker not recorded: no active Goal to block.";
			return goalToolError(message, toPublicState(goal));
		}
		const state = toPublicState(result.goal);
		if (result.thresholdMet) {
			ctx.ui.notify(
				`Goal ${result.goal.id} is now blocked: ${validation.blocker} ` +
					`(the same blocker for ${result.turns} consecutive Goal turns). Automatic continuation has stopped; ` +
					"resolving the blocker and running /goal resume is a user decision, and the resume starts a fresh audit.",
				"warning",
			);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Goal ${result.goal.id} is blocked after the same blocker persisted for ${result.turns} ` +
							"consecutive Goal turns. Automatic continuation has stopped. Report to the user what is " +
							"blocking the work and what would unblock it; /goal resume restarts it with a fresh blocked audit.",
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
			`${counted} The Goal stays active: the same genuine blocker must persist for at least ` +
				`${BLOCKED_AUDIT_THRESHOLD} consecutive Goal turns before it may be marked blocked, so a transient ` +
				"failure cannot stop useful work. " +
				(result.turns > 1
					? `The blocker on record for this Goal is: ${result.goal.blockedAudit?.blocker ?? validation.blocker}. `
					: "") +
				"Re-verify against the current state, take the next available safe action, and report again only if " +
				"the same blocker persists. Never report a blocker because the work is hard, slow, uncertain, or " +
				"incomplete.",
			state,
		);
	}

	pi.registerCommand("goal", {
		description:
			"Create (/goal <objective>), inspect (bare /goal), edit (/goal edit <objective>), pause, resume, or clear the session Goal",
		handler: async (args, ctx) => {
			try {
				const command = parseGoalCommand(args);
				switch (command.kind) {
					case "status":
						await reportStatus(ctx);
						return;
					case "create":
						await createOrReplaceGoal(command.objective, ctx);
						return;
					case "edit":
						editGoal(command.objective, ctx);
						return;
					case "pause":
						pauseGoal(ctx);
						return;
					case "resume":
						resumeGoal(ctx);
						return;
					case "clear":
						clearGoal(ctx);
						return;
					case "invalid":
						ctx.ui.notify(command.message, "error");
						return;
				}
			} catch (error) {
				ctx.ui.notify(`pi-goal error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

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
	 */
	function deliverWorkMessage(content: string, ctx: ExtensionCommandContext): "started" | "steered" {
		if (ctx.isIdle()) {
			pi.sendUserMessage(content);
			return "started";
		}
		pi.sendUserMessage(content, { deliverAs: "steer" });
		return "steered";
	}

	/** Report a failed durable transition uniformly (the previous state stands). */
	function notifyMutationFailure(ctx: ExtensionCommandContext, action: string, failure: { reason: string; message?: string; error?: unknown }): void {
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

	function pauseGoal(ctx: ExtensionCommandContext): void {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(), "info");
			return;
		}
		if (goal.status === "paused") {
			ctx.ui.notify(`Goal ${goal.id} is already paused. Use /goal resume to restart work.`, "info");
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
		// The transition is durable (appendEntry wrote through) before this
		// announcement. The in-flight run, if any, finishes on its own: pause
		// stops admission of further automatic runs, it never aborts work.
		ctx.ui.notify(
			`Goal ${goal.id} paused (revision ${paused.goal!.revision}). No further automatic Goal runs will start; ` +
				"work already in flight finishes safely. Use /goal resume to restart, /goal clear to remove the Goal.",
			"info",
		);
	}

	function resumeGoal(ctx: ExtensionCommandContext): void {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(), "info");
			return;
		}
		if (goal.status === "active") {
			ctx.ui.notify(`Goal ${goal.id} is already active; work continues at every settlement.`, "info");
			return;
		}
		if (goal.status !== "paused" && goal.status !== "blocked" && goal.status !== "usage_limited") {
			ctx.ui.notify(
				`Goal ${goal.id} is ${goal.status} and cannot be resumed. A complete Goal is finished — use /goal <objective> to set a new one.`,
				"warning",
			);
			return;
		}
		// A stop the user is overruling is a user action, so every anti-loop counter
		// and the in-memory audit chain start over with the resumed Goal. The durable
		// audit itself is dropped by the store, so what resumes is the objective and
		// its retained progress rather than the count that stopped it.
		safety.reset();
		const resumed = store.markResumed(pi);
		if (!resumed.ok) {
			notifyMutationFailure(ctx, "resumed", resumed);
			return;
		}
		const updated = resumed.goal!;
		// Durable first, then restart work — busy-safely, so resuming while
		// another run is in flight steers instead of waiting for idle.
		const delivery = deliverWorkMessage(formatResumeMessage(updated), ctx);
		const restarted =
			goal.status === "paused"
				? "Work restarted from retained progress."
				: goal.status === "blocked"
					? "The blocked audit that ended it is cleared, so work restarts from retained progress with a fresh audit."
					: "The usage-limit stop that ended it is cleared, so work restarts from retained progress.";
		ctx.ui.notify(
			`Goal ${updated.id} resumed (revision ${updated.revision}). ${restarted} Work ${delivery === "started" ? "restarted" : "steered into the running work"}.`,
			"info",
		);
	}

	function clearGoal(ctx: ExtensionCommandContext): void {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(), "info");
			return;
		}
		const cleared = store.clear(pi);
		if (!cleared.ok) {
			notifyMutationFailure(ctx, "cleared", cleared);
			return;
		}
		// The tombstone is durable before this announcement, so a crash right
		// here still restores "no Goal". Work in flight finishes normally; with
		// no Goal, its settlement cannot continue.
		ctx.ui.notify(
			`Goal ${goal.id} cleared (was ${goal.status}). The session is back to ordinary prompt behavior.`,
			"info",
		);
	}

	function editGoal(rawObjective: string, ctx: ExtensionCommandContext): void {
		const validation = validateObjective(rawObjective);
		if (!validation.ok) {
			ctx.ui.notify(validation.error, "error");
			return;
		}
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify("There is no Goal to edit. Create one with /goal <objective> first.", "warning");
			return;
		}
		const edited = store.editObjective(pi, validation.objective);
		if (!edited.ok) {
			notifyMutationFailure(ctx, "edited", edited);
			return;
		}
		const updated = edited.goal!;
		if (updated.status === "active") {
			// Redirect the active run through Pi's steering (or start work when
			// idle, e.g. after an aborted run left the Goal dormant).
			const delivery = deliverWorkMessage(formatEditMessage(updated), ctx);
			ctx.ui.notify(
				`Goal ${updated.id} objective updated (revision ${updated.revision}); usage history is preserved. Work ${delivery === "started" ? "started" : "steered"} on the new objective.`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			`Goal ${updated.id} objective updated (revision ${updated.revision}). The Goal stays ${updated.status}; /goal resume restarts work.`,
			"info",
		);
	}

	/**
	 * Ask the user to confirm replacing an unfinished Goal. Auto-declines on
	 * timeout or dismissal, so a mistaken or unattended command can never
	 * discard work. Without any UI (for example print mode) there is no way to
	 * confirm, so the current Goal is kept and the user is told how to proceed.
	 */
	async function confirmReplacement(ctx: ExtensionCommandContext, existing: GoalRecord): Promise<boolean> {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"Replacing the current Goal needs a confirmation this Pi mode cannot display (no UI), " +
					"so the current Goal was kept. Use /goal clear followed by /goal <objective> instead.",
				"warning",
			);
			return false;
		}
		return ctx.ui.confirm(
			"Replace the current Goal?",
			`The current ${existing.status} Goal "${previewObjective(existing.objective)}" would be discarded ` +
				"(a new Goal replaces it, with a fresh identity and no retained usage history). Replace it?",
			{ timeout: REPLACE_CONFIRM_TIMEOUT_MS },
		);
	}

	async function createOrReplaceGoal(rawObjective: string, ctx: ExtensionCommandContext): Promise<void> {
		const validation = validateObjective(rawObjective);
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

		// Serialized create-or-replace: concurrent /goal commands (for example two
		// sent while Pi is busy) run exclusively; the authoritative existing-Goal
		// check and the replacement confirmation both happen inside the lock, so
		// the second command always sees the first's committed Goal and must be
		// confirmed before replacing it. Every await is followed by a revalidation
		// of the Goal the command captured: a confirmation or kickoff that was
		// prepared against older state must never override the lifecycle commands
		// the user ran in the meantime.
		await runExclusive(async () => {
			const existing = store.get();
			if (existing && existing.status !== "complete") {
				const confirmed = await confirmReplacement(ctx, existing);
				// The answer applies only to the exact record the dialog described.
				// If the Goal was cleared, edited, paused, resumed, or replaced
				// while the dialog was open, neither answer may act on it.
				const current = store.get();
				if (!current || current.id !== existing.id || current.revision !== existing.revision) {
					ctx.ui.notify(
						`Replacement cancelled: the Goal changed while the confirmation was open` +
							(current ? ` (now ${current.status}, revision ${current.revision})` : " (no Goal is set anymore)") +
							", so the confirmation no longer described the current state. Nothing was replaced; " +
							"run /goal <objective> again to confirm against the current Goal.",
						"warning",
					);
					return;
				}
				if (!confirmed) {
					ctx.ui.notify(
						`Replacement cancelled: the current ${existing.status} Goal was kept. ` +
							"Use /goal edit <objective> to change the objective without replacing the Goal.",
						"info",
					);
					return;
				}
			}
			const previous = store.get();
			const replacing = previous != null;

			const goal = store.create(validation.objective, "command");
			const sameRecord = (candidate: GoalRecord | null | undefined) =>
				candidate != null && candidate.id === goal.id && candidate.revision === goal.revision;
			try {
				// Stage and commit before any wait: the new record is what a
				// concurrent /goal clear, edit, pause, or resume acts on, and
				// revalidating it after the wait detects exactly that change.
				store.stage(pi, goal);
				store.commit(goal);
			} catch (error) {
				if (replacing) {
					// A failed *replacement* write must not erase the existing
					// Goal: nothing was appended, so the previous record stays
					// current in memory and on disk. The creation rollback
					// (tombstone + no Goal) would be wrong here - it would drop
					// the Goal the user still has.
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(
						`Goal not created: writing the replacement to the session failed (${reason}). ` +
							"The current Goal is unchanged; fix the cause and run /goal again.",
						"error",
					);
					return;
				}
				// Nothing durable was confirmed for a brand-new Goal: retract it
				// so no phantom state survives a failed stage.
				store.rollback(pi);
				notifyWriteFailure(ctx, error);
				return;
			}

			let delivery: "started" | "steered";
			if (replacing) {
				// Replacing must work while the discarded Goal's own run is still
				// in flight - waiting for idle would deadlock behind its
				// continuation loop - so the kickoff is steered into the active
				// run or starts immediately when idle.
				delivery = deliverWorkMessage(formatKickoffMessage(goal), ctx);
			} else {
				// There is no Goal continuation loop that could starve this wait
				// (abort also settles a stuck run), and the seam above declines to
				// adopt the run we are waiting for. Revalidate afterwards: a
				// clear/edit/pause issued while creation waited must win over
				// starting the objective the user has already moved away from.
				pendingInitialKickoff = { id: goal.id, revision: goal.revision };
				try {
					await ctx.waitForIdle();
				} finally {
					pendingInitialKickoff = null;
				}
				const waited = store.get();
				if (!sameRecord(waited)) {
					ctx.ui.notify(
						waited
							? `Goal ${goal.id} was not started: it changed while creation waited for the current run to finish ` +
									`(now ${waited.status}, revision ${waited.revision}). Initial work was not started; the current state stands.`
							: `Goal ${goal.id} was not started: it was cleared while creation waited for the current run to finish. ` +
									"Nothing remains active; run /goal <objective> again to start over.",
						"warning",
					);
					return;
				}
				// A new Goal identity starts every audit and every anti-loop counter
				// from zero, and the kickoff it is about to send is a Goal turn for
				// the blocked audit but attended work: the user just typed /goal, so it
				// must not consume one of the automatic turns an anti-loop bound
				// allows.
				safety.reset();
				pendingRunKind = "kickoff";
				pi.sendUserMessage(formatKickoffMessage(goal));
				delivery = "started";
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
				notifyWriteFailure(
					ctx,
					new Error("the Goal snapshot did not reach the session file in time"),
				);
				return;
			}
			if (!now || now.id !== goal.id) {
				// The Goal this command created was cleared (or otherwise removed)
				// before creation could be announced; report that instead of
				// claiming success for state that no longer exists.
				ctx.ui.notify(
					`Goal ${goal.id} was cleared before creation finished; nothing remains active. ` +
						"Run /goal <objective> again to start over.",
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				replacing
					? `Goal ${goal.id} created and activated, replacing ${previous!.id}. Initial work ${delivery === "started" ? "started" : "steered into the running work"}.`
					: `Goal ${goal.id} created and activated. Initial work started.`,
				"info",
			);
		});
	}

	function notifyWriteFailure(ctx: ExtensionCommandContext, cause: unknown): void {
		const reason = cause instanceof Error ? cause.message : String(cause);
		ctx.ui.notify(
			`Goal not created: writing the Goal to the session failed (${reason}). ` +
				"Nothing was stored; fix the cause and run /goal again.",
			"error",
		);
	}

	async function waitForDurability(ctx: ExtensionCommandContext, goalId: string): Promise<boolean> {
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
			ctx.ui.notify(formatNoGoal(), "info");
			return;
		}
		ctx.ui.notify(formatGoalSummary(toPublicState(goal)), "info");
	}
}
