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
 * Lifecycle subcommands (edit/pause/resume/clear), blocked and usage-limit
 * handling, token budgets and usage accounting, status UI, and the final
 * documentation land in their own later tickets; this milestone deliberately
 * does not implement them.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CUSTOM_MESSAGE_TYPE,
	formatContinuationMessage,
	formatGoalSummary,
	formatKickoffMessage,
	formatNoGoal,
	getGoalOutputSchema,
	MAX_OBJECTIVE_LENGTH,
	MIN_OBJECTIVE_LENGTH,
	type GoalPublicState,
	toPublicState,
} from "./goal.ts";
import { GoalStore, validateObjective } from "./store.ts";

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
		const goal = store.get();
		if (goal) {
			ctx.ui.notify(`Goal ${goal.id} restored (${goal.status}).`, "info");
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		store.reconstruct(ctx);
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
	 * - a Goal exists and is active (completed, paused, cleared, and absent Goals
	 *   never continue), and
	 * - the run completed (aborted and errored runs are hard exits: Pi owns
	 *   retries, so re-driving them here would be an unattended retry loop).
	 *
	 * Composition: entries proposed by other extensions are chained, never
	 * replaced, and `continue: true` only *ensures* one further provider request.
	 * If queued work already causes that request, Pi satisfies the decision with
	 * it and makes no extra one, so this adds exactly one Goal turn per
	 * settlement and no more.
	 */
	pi.on("agent_before_settle", async (event, _ctx) => {
		const goal = store.get();
		if (!goal || goal.status !== "active") return;
		if (event.outcome !== "completed") return;
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
			"Update the current Goal. The only supported action is marking it complete, which the " +
			"model may do after verifying every requirement of the objective against " +
			"current-state evidence. Completing a Goal stops its automatic continuation.",
		parameters: Type.Object({
			action: Type.String({
				description:
					"Only the value complete is supported. Pause, resume, clear, and blocked transitions are user-owned and arrive in a later milestone.",
			}),
		}),
		outputSchema: getGoalOutputSchema,
		promptSnippet: "Mark the current Goal complete after an evidence-based completion audit",
		promptGuidelines: [
			"Call update_goal with action complete only after every explicit requirement of the objective is verified by current-state evidence.",
			"Completing a Goal stops its automatic continuation, so never call it to escape a difficult or merely tiring task.",
		],
		/**
		 * Compatibility shim for the spellings a model reaches for when it means
		 * complete: `{ status: "complete" }` and `{ complete: true }`. Without it a
		 * drifted call fails schema validation, the model sees only an arguments
		 * error, and the Goal keeps burning turns. Anything else is passed through
		 * untouched so an unsupported action is refused with a real explanation
		 * instead of being silently ignored.
		 */
		prepareArguments: (args: unknown): { action: string } => {
			if (typeof args !== "object" || args === null) return { action: "" };
			const record = args as Record<string, unknown>;
			if (record.action !== undefined) return { action: String(record.action) };
			if (record.status === "complete" || record.complete === true) return { action: "complete" };
			return { action: "" };
		},
		async execute(_toolCallId: string, params: { action?: string }) {
			const goal = store.get();
			if (!goal) {
				return goalToolError(formatNoGoal(), null);
			}
			if (params?.action !== "complete") {
				return goalToolError(
					"update_goal only supports action complete in this milestone of pi-goal. " +
						"Pause, resume, clear, and blocked transitions stay with the user.",
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
