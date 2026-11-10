/**
 * pi-goal — Codex-style persistent Goals for Pi (milestone 1).
 *
 * Registers the /goal command and the get_goal model tool. A Goal is a durable,
 * session-scoped record persisted as custom session entries and reconstructed
 * from the active branch on session start (restart, resume, reload, fork) and
 * after tree navigation. Creating a Goal sends the objective into model context
 * as a custom message and starts initial work.
 *
 * Later milestones add automatic continuation at agent_before_settle, lifecycle
 * subcommands (edit/pause/resume/clear), create_goal/update_goal, and usage
 * accounting. This milestone intentionally does not implement them.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CUSTOM_MESSAGE_TYPE,
	formatGoalSummary,
	formatKickoffMessage,
	formatNoGoal,
	getGoalOutputSchema,
	type GoalPublicState,
	toPublicState,
} from "./goal.ts";
import { GoalStore, validateObjective } from "./store.ts";

/** Subcommands reserved by later milestones; refuse them instead of treating them as objectives. */
const RESERVED_SUBCOMMANDS = new Set(["edit", "pause", "resume", "clear"]);

export default function goalExtension(pi: ExtensionAPI): void {
	const store = new GoalStore();

	pi.on("session_start", (_event, ctx) => {
		store.reconstruct(ctx);
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

				const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
				if (RESERVED_SUBCOMMANDS.has(firstWord)) {
					ctx.ui.notify(
						`"/goal ${firstWord}" is not implemented in this milestone of pi-goal. ` +
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

				const goal = store.create(validation.objective);
				store.persist(pi, goal);

				// Start initial work: continuation instructions live in model context
				// (custom_message entry), attributed as user-provided Goal data.
				pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: formatKickoffMessage(goal),
						display: true,
						details: { goalId: goal.id, revision: goal.revision, kind: "kickoff" },
					},
					{ triggerTurn: true },
				);

				ctx.ui.notify(`Goal ${goal.id} created and activated. Initial work started.`, "info");
			} catch (error) {
				ctx.ui.notify(`pi-goal error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	async function reportStatus(ctx: ExtensionCommandContext): Promise<void> {
		const goal = store.get();
		if (!goal) {
			ctx.ui.notify(formatNoGoal(), "info");
			return;
		}
		ctx.ui.notify(formatGoalSummary(toPublicState(goal)), "info");
	}
}
