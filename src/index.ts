/**
 * pi-goal — Codex-style persistent Goals for Pi.
 *
 * Registers the /goal command, the get_goal / create_goal / update_goal model
 * tools, and the automatic-continuation seam. A Goal is a durable,
 * session-scoped record persisted as custom session entries and reconstructed
 * from the active branch on session start (restart, resume, reload, fork) and
 * after tree navigation.
 *
 * Creating a Goal sends the objective into model context as a user message and
 * starts initial work. Pi 1.5.1 creates the session file only once a session
 * has a user or assistant message, so the kickoff is delivered as a user
 * message (a conversation entry, via the public sendUserMessage API): staging
 * the snapshot and sending the kickoff flushes the file, and the command
 * confirms durability on disk before announcing success.
 *
 * While a Goal is active, work continues at Pi's safe settlement boundary
 * (`agent_before_settle`), never from a timer or an `agent_end` self-loop, so
 * Pi keeps owning retries, compaction recovery, and queued follow-ups. Each
 * continuation restates the objective verbatim and asks for an evidence audit;
 * the model ends the loop by calling update_goal, and a complete, paused, or
 * absent Goal never continues.
 *
 * Stopping is conservative and mostly independent of the model
 * (`./safety.ts`): repeated activity-free automatic Goal turns, repeated turns
 * in which commands could not be executed at all, and terminal provider
 * failures all stop automatic continuation deterministically, and a provider
 * usage limit moves the Goal to `usage_limited`. The model can end the loop
 * itself by completing the Goal, or by reporting the same genuine blocker for
 * three consecutive Goal turns. User actions reset every anti-loop counter.
 *
 * Lifecycle subcommands (edit/pause/resume/clear), token budgets and usage
 * accounting, status UI, and the final documentation land in their own later
 * milestones; this milestone deliberately does not implement them.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BLOCKED_AUDIT_THRESHOLD,
	CUSTOM_MESSAGE_TYPE,
	formatContinuationMessage,
	formatGoalSummary,
	formatKickoffMessage,
	formatNoGoal,
	getGoalOutputSchema,
	MAX_BLOCKER_LENGTH,
	MAX_OBJECTIVE_LENGTH,
	MIN_BLOCKER_LENGTH,
	MIN_OBJECTIVE_LENGTH,
	type GoalPublicState,
	type GoalRecord,
	toPublicState,
} from "./goal.ts";
import { GoalStore, validateBlocker, validateObjective } from "./store.ts";
import {
	classifyProviderFailure,
	GoalSafetyMonitor,
	type ProviderFailureEvidence,
} from "./safety.ts";

/**
 * Subcommand words reserved for later milestones. Refused only when they are
 * the entire argument; objectives that merely begin with one of these words
 * (for example "clear the lint errors") are valid.
 */
const RESERVED_SUBCOMMANDS = new Set(["edit", "pause", "resume", "clear"]);

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

export default function goalExtension(pi: ExtensionAPI): void {
	const store = new GoalStore();
	const safety = new GoalSafetyMonitor();

	/**
	 * Set when the next run is Goal work: the kickoff the /goal command sends, or
	 * a continuation this extension just requested. Consumed by `agent_start`, so
	 * the anti-loop counters can tell an unattended Goal turn from a run the user
	 * started themselves.
	 */
	let goalTurnPending = false;

	/** Evidence of the provider failure that ended the current run, if any. */
	let providerFailure: ProviderFailureEvidence | undefined = undefined;

	/**
	 * Serializes Goal creation across concurrent /goal commands. Commands that
	 * arrive while Pi is busy both wait for idle; without serialization both
	 * could pass the existing-Goal check before either persists, and the second
	 * would silently replace the first. Every create runs its guards, write,
	 * kickoff, and durability confirmation exclusively, so a losing command
	 * always sees the winner's committed Goal and refuses.
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
	pi.on("session_tree", (_event, ctx) => {
		store.reconstruct(ctx);
		safety.reset();
	});

	/**
	 * A prompt the user typed is a user action: the loop is no longer unattended,
	 * so every anti-loop counter starts over. Extension commands (`/goal ...`) do
	 * not fire `input`; creating a Goal already starts from a fresh record.
	 */
	pi.on("input", () => {
		safety.reset();
		store.resetBlockedAudit(pi);
	});

	pi.on("agent_start", () => {
		safety.beginRun(goalTurnPending);
		goalTurnPending = false;
		providerFailure = undefined;
	});
	pi.on("agent_end", () => {
		safety.endRun();
	});

	/**
	 * An abort is the strongest possible user action: the run the user stopped
	 * must not be counted as a Goal malfunction, and a continuation Pi suppressed
	 * because of the abort must not mark the next run as a Goal turn.
	 */
	pi.on("agent_settled", (event) => {
		if (!event.aborted) return;
		goalTurnPending = false;
		safety.reset();
		store.resetBlockedAudit(pi);
	});

	/**
	 * Observe the finalized assistant message: it is what "activity" means for a
	 * Goal turn, and a failed one is the evidence a provider failure is
	 * classified from.
	 */
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		safety.noteAssistantMessage(message);
		if (message.stopReason === "error") {
			providerFailure = {
				errorMessage: message.errorMessage,
				diagnostics: message.diagnostics,
			};
		}
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
	 * Evaluate one finished turn against the anti-loop bounds.
	 *
	 * The stop is applied here rather than at the next settlement so the Goal is
	 * already `blocked` before the boundary could ask for another continuation:
	 * a malfunctioning loop gets exactly one more turn to finish what it was
	 * doing, and no more.
	 */
	pi.on("turn_end", (event, ctx) => {
		const stop = safety.evaluateTurn(event.outcome);
		if (!stop) return;
		const goal = store.get();
		if (!goal || goal.status !== "active") return;
		const result = store.stopGoal(pi, { status: "blocked", blocker: stop.blocker, turns: stop.turns });
		if (result.ok) {
			ctx.ui.notify(
				`Goal ${result.goal.id} stopped and is now blocked (${stop.kind}): ${stop.blocker} ` +
					"Automatic continuation has stopped; the Goal needs a user decision to continue.",
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
	 * - the run completed (aborted and errored runs are hard exits: Pi owns
	 *   retries, so re-driving them here would be an unattended retry loop).
	 *
	 * An errored run is additionally classified from the evidence Pi exposes, so a
	 * provider usage limit becomes `usage_limited` while any other terminal
	 * provider error stops the continuation for that run and is surfaced.
	 *
	 * Composition: entries proposed by other extensions are chained, never
	 * replaced, and `continue: true` only *ensures* one further provider request.
	 * If queued work already causes that request, Pi satisfies the decision with
	 * it and makes no extra one, so this adds exactly one Goal turn per
	 * settlement and no more.
	 */
	pi.on("agent_before_settle", async (event, ctx) => {
		const goal = store.get();
		if (!goal || goal.status !== "active") return;
		if (event.outcome === "error") {
			handleProviderFailure(goal, ctx);
			return;
		}
		if (event.outcome !== "completed") return;
		// The next run is Goal work, whether Pi starts it for our continuation or
		// for queued work that already satisfies the decision.
		goalTurnPending = true;
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
						`(${failure.evidence}). Automatic continuation has stopped; resolving the limit needs a user ` +
						"decision, because a usage-limited Goal never continues on its own.",
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
				// Conservative for this milestone: a Goal of any status, including a
				// complete one, still occupies the session's single Goal slot.
				// Replacement and clearing arrive with the lifecycle ticket.
				return goalToolError(
					"A Goal is already set for this session (status: " +
						`${existing.status}); cannot create another one. ` +
						"Use get_goal to inspect it, or update_goal to complete it. Replacing or clearing a Goal arrives in a later milestone.",
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
			"Update the current Goal. Supported actions: \"complete\" after an evidence-based completion audit, and " +
			"\"blocked\" once the same genuine blocker has persisted for at least three consecutive Goal turns. " +
			"Both are terminal: they stop the Goal's automatic continuation.",
		parameters: Type.Object({
			action: Type.String({
				description:
					"complete or blocked. Pause, resume, clear, usage-limit, and budget-limit transitions are " +
					"user-owned and arrive in a later milestone.",
			}),
			blocker: Type.Optional(
				Type.String({
					description:
						`Required for action blocked: the genuine blocker in plain language (${MIN_BLOCKER_LENGTH}-${MAX_BLOCKER_LENGTH} characters). ` +
						"Say what is actually blocking the work and what would unblock it.",
				}),
			),
		}),
		outputSchema: getGoalOutputSchema,
		promptSnippet: "Mark the current Goal complete after an audit, or blocked after a persistent blocker",
		promptGuidelines: [
			"Call update_goal with action complete only after every explicit requirement of the objective is verified by current-state evidence.",
			`Call update_goal with action blocked only when the same genuine blocker has persisted for at least ${BLOCKED_AUDIT_THRESHOLD} consecutive Goal turns, and never because the work is merely hard, slow, uncertain, or incomplete.`,
			"Completing or blocking a Goal stops its automatic continuation, so never use either to escape a difficult or merely tiring task.",
		],
		/**
		 * Compatibility shim for the spellings a model reaches for: `{ status: … }`
		 * and `{ complete: true }` / `{ blocked: true }`. Without it a drifted call
		 * fails schema validation, the model sees only an arguments error, and the
		 * Goal keeps burning turns. Anything else is passed through with an empty
		 * action so an unsupported action is refused with a real explanation
		 * instead of being silently ignored.
		 */
		prepareArguments: (args: unknown): { action: string; blocker?: string } => {
			if (typeof args !== "object" || args === null) return { action: "" };
			const record = args as Record<string, unknown>;
			const blocker = typeof record.blocker === "string" ? record.blocker : undefined;
			const withBlocker = (action: string) => (blocker === undefined ? { action } : { action, blocker });
			if (record.action !== undefined) return withBlocker(String(record.action));
			if (record.status === "complete" || record.complete === true) return withBlocker("complete");
			if (record.status === "blocked" || record.blocked === true) return withBlocker("blocked");
			return withBlocker("");
		},
		async execute(
			_toolCallId: string,
			params: { action: string; blocker?: string },
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
			if (params?.action !== "complete") {
				return goalToolError(
					"update_goal only supports the actions complete and blocked in this milestone of pi-goal. " +
						"Pause, resume, clear, usage-limit, and budget-limit transitions stay with the user.",
					toPublicState(goal),
				);
			}
			const completed = store.markComplete(pi);
			if (!completed.ok) {
				// Distinguish a lifecycle refusal from a persistence failure: the Goal
				// is still active in the second case, and saying otherwise would hide a
				// real durability problem behind a lifecycle message.
				const message =
					completed.reason === "persistence"
						? `Goal not marked complete: writing the Goal to the session failed (${describeError(completed.error)}). The Goal is still active; fix the cause and call update_goal again.`
						: "Goal could not be marked complete: no active Goal to complete.";
				return goalToolError(message, toPublicState(goal));
			}
			const state = toPublicState(completed.goal);
			return {
				content: [{ type: "text", text: `Goal ${completed.goal.id} marked complete.` }],
				structuredContent: { goal: state },
				details: { goal: state },
			};
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
					"resolving the blocker and resuming the Goal is a user decision.",
				"warning",
			);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Goal ${result.goal.id} is blocked after the same blocker persisted for ${result.turns} ` +
							"consecutive Goal turns. Automatic continuation has stopped. Report to the user what is " +
							"blocking the work and what would unblock it; only the user can resume this Goal.",
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
		description: "Create a persistent Goal (/goal <objective>) or report the current one (bare /goal)",
		handler: async (args, ctx) => {
			try {
				const trimmed = args.trim();
				if (trimmed === "") {
					await reportStatus(ctx);
					return;
				}

				if (RESERVED_SUBCOMMANDS.has(trimmed.toLowerCase())) {
					ctx.ui.notify(
						`"/goal ${trimmed.toLowerCase()}" is not implemented in this milestone of pi-goal. ` +
							"Bare /goal reports the current Goal; /goal <objective> creates one.",
						"warning",
					);
					return;
				}

				const validation = validateObjective(trimmed);
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

				if (store.hasGoal()) {
					ctx.ui.notify(
						"A Goal is already set for this session. Use bare /goal to inspect it. " +
							"Replacing or editing the objective arrives in a later pi-goal milestone.",
						"warning",
					);
					return;
				}

				// Serialized creation: concurrent /goal commands (for example two
				// sent while Pi is busy) each wait for idle and then run
				// exclusively; the authoritative existing-Goal check happens
				// inside the lock, so the second command always sees the first's
				// committed Goal and refuses instead of silently replacing it.
				await runExclusive(async () => {
					// sendUserMessage needs an idle agent; wait for any active run
					// to settle (abort also settles a stuck run).
					await ctx.waitForIdle();

					// Authoritative recheck: a concurrent command may have
					// committed a Goal while this handler was waiting above.
					if (store.hasGoal()) {
						ctx.ui.notify(
							"A Goal is already set for this session. Use bare /goal to inspect it. " +
								"Replacing or editing the objective arrives in a later pi-goal milestone.",
							"warning",
						);
						return;
					}

					const goal = store.create(validation.objective, "command");
					try {
						// Stage the snapshot first: a write failure here abandons
						// creation with no visible state change and the attempt
						// can be retried.
						store.stage(pi, goal);
						// Make the Goal visible to get_goal for the kickoff run
						// that starts now.
						store.commit(goal);
						// A new Goal identity starts every audit from zero, and the
						// kickoff is the first Goal turn, so the anti-loop counters
						// treat it as unattended Goal work rather than as a run the
						// user started.
						safety.reset();
						goalTurnPending = true;
						// Start initial work. The kickoff is a user message: it
						// carries the objective into model context as
						// user-provided Goal data and, as the session's first
						// conversation entry, makes Pi flush the session file
						// with the staged snapshot.
						pi.sendUserMessage(formatKickoffMessage(goal));
					} catch (error) {
						// Nothing durable was confirmed: retract the committed
						// Goal so no phantom state survives a failed stage or
						// kickoff delivery.
						store.rollback(pi);
						notifyWriteFailure(ctx, error);
						return;
					}

					// Confirm durability before announcing success. If the
					// snapshot never reaches disk (unwritable storage,
					// interrupted flush), retract the Goal with a tombstone and
					// report a retryable persistence error.
					const durable = await waitForDurability(ctx, goal.id);
					if (!durable) {
						store.rollback(pi);
						notifyWriteFailure(
							ctx,
							new Error("the Goal snapshot did not reach the session file in time"),
						);
						return;
					}

					ctx.ui.notify(`Goal ${goal.id} created and activated. Initial work started.`, "info");
				});
			} catch (error) {
				ctx.ui.notify(`pi-goal error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

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
