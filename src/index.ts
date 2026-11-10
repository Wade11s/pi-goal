/**
 * pi-goal — Codex-style persistent Goals for Pi (milestone 1).
 *
 * Registers the /goal command and the get_goal model tool. A Goal is a durable,
 * session-scoped record persisted as custom session entries and reconstructed
 * from the active branch on session start (restart, resume, reload, fork) and
 * after tree navigation.
 *
 * Creating a Goal sends the objective into model context as a user message and
 * starts initial work. Pi 1.5.1 creates the session file only once a session
 * has a user or assistant message, so the kickoff is delivered as a user
 * message (a conversation entry, via the public sendUserMessage API): staging
 * the snapshot and sending the kickoff flushes the file, and the command
 * confirms durability on disk before announcing success. The custom-message
 * channel (`goal-continuation`) is reserved for the automatic-continuation seam
 * of a later milestone.
 *
 * Later milestones add automatic continuation at agent_before_settle, lifecycle
 * subcommands (edit/pause/resume/clear), create_goal/update_goal, and usage
 * accounting. This milestone intentionally does not implement them.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatGoalSummary,
	formatKickoffMessage,
	formatNoGoal,
	getGoalOutputSchema,
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

					const goal = store.create(validation.objective);
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
