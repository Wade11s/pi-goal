/**
 * The opt-in structured progress-plan tool (issue #53).
 *
 * A long Goal is mostly invisible: the model knows where it is, and every
 * Continuation has to reconstruct that from the transcript. `update_plan` is the
 * conventional seam for making it visible — one ordered list of steps, each
 * `pending`, `in_progress`, or `completed`, at most one of them in progress.
 *
 * Three rules shape the whole module, and each one is a property of the code
 * rather than of a caller's discipline:
 *
 * 1. **It is a thin tool over Pi's registered-tool seam.** The tool is registered
 *    through `pi.registerTool()` like any other, and its durability is the
 *    ordinary persisted tool result: Pi already writes a tool result's `details`
 *    onto the session branch as part of the tool-result message, so the plan
 *    survives a restart and is visible to the model in its own context without
 *    pi-goal keeping a copy, reconstructing one, or adding a Goal field. There is
 *    deliberately **no plan state in `GoalStore`**: a second durable record would
 *    be a second source of truth for the same Goal.
 * 2. **It never touches the Lifecycle.** Nothing here calls into the store, so a
 *    plan update cannot complete, pause, block, or budget-limit a Goal, cannot
 *    advance a revision, cannot write a `goal-state` entry, and cannot emit a
 *    `pi-goal:updated` event. The completion contract stays with the evidence
 *    audit and `update_goal`; a plan that marks every step completed is still
 *    narration, and both the tool's own result text and the Continuation say so.
 * 3. **It is opt-in and validated.** `goal.planTool` defaults to `false`, and a
 *    malformed value is reported once and ignored exactly like the other
 *    extension settings, so a typo can never silently register a tool the user
 *    did not ask for. The step rules — ordered, one of three statuses, at most one
 *    in progress — are enforced here, before anything is persisted, because a
 *    refused plan must leave the durable record untouched.
 *
 * The tool is named for what it does, not for parity with any host: Pi's
 * registered-tool seam is the interface, and no other extension's tool is
 * shadowed or duplicated for the sake of matching a name.
 */

/** The model-facing tool name. Conventional, and owned by this extension alone. */
export const PLAN_TOOL_NAME = "update_plan";

/** Longest accepted step list. A plan is a progress summary, not a task database. */
export const MAX_PLAN_STEPS = 20;

/** Longest accepted single step, counted in code points. */
export const MAX_PLAN_STEP_LENGTH = 200;

/** The three statuses a step may carry. Exactly one may be `in_progress`. */
export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;

export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** One validated plan step, as it is persisted in the tool result's details. */
export type PlanStepRecord = {
	/** What this step is, trimmed. */
	step: string;
	/** Where this step stands. */
	status: PlanStepStatus;
};

/** How many steps stand in each status. */
export type PlanCounts = {
	total: number;
	completed: number;
	inProgress: number;
	pending: number;
};

/**
 * The plan record: the tool result's `details` payload, and its
 * `structuredContent`. This is the whole durable representation of a plan.
 *
 * Declared as a type alias rather than an interface so it is assignable to Pi's
 * `JsonValue`: `structuredContent` and the persisted `details` both require a
 * plain JSON object, and an interface would not satisfy that index signature.
 */
export type PlanRecord = {
	/** The ordered steps, in the order the model gave them. */
	steps: PlanStepRecord[];
	counts: PlanCounts;
};

/**
 * Extension-level plan-tool configuration (`goal.planTool`).
 *
 * The default is `false` for the same reason the resume prompt and session naming
 * default to false: this is a convenience the user has to ask for, and an
 * opt-out default would quietly put another tool in every model's loadout.
 */
export interface PlanToolSettings {
	/** Whether the plan tool may be registered. Defaults to false. */
	enabled: boolean;
	/** Human-readable configuration problems, reported once per session. */
	problems: string[];
}

/** Read an optional boolean setting; anything other than a boolean is invalid. */
function readPlanToolValue(value: unknown): boolean | undefined | "invalid" {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") return "invalid";
	return value;
}

/**
 * Read the `goal.planTool` opt-in from Pi's effective settings.
 *
 * The default is `false` and an invalid value also resolves to `false`, which is
 * the fail-closed direction for a *registration* decision: a configuration
 * mistake must not put a tool in the model's loadout that the user never asked
 * for. The mistake is reported once, exactly like the budget, admission,
 * resume-prompt, and session-naming settings.
 */
export function parsePlanToolSettings(settings: unknown): PlanToolSettings {
	const goal = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).goal : undefined) as
		| Record<string, unknown>
		| undefined;
	const raw = readPlanToolValue(goal?.planTool);
	if (raw === "invalid") {
		return {
			enabled: false,
			problems: [
				"pi-goal: goal.planTool must be a boolean (true or false); ignoring it and leaving the progress-plan " +
					"tool unregistered.",
			],
		};
	}
	return { enabled: raw ?? false, problems: [] };
}

/** A refused plan: why, in the words the model needs to correct its own call. */
export interface PlanValidationFailure {
	ok: false;
	error: string;
}
export type PlanValidation = { ok: true; plan: PlanRecord } | PlanValidationFailure;

/** Count steps per status. */
function countSteps(steps: readonly PlanStepRecord[]): PlanCounts {
	const counts: PlanCounts = { total: steps.length, completed: 0, inProgress: 0, pending: 0 };
	for (const step of steps) {
		if (step.status === "completed") counts.completed += 1;
		else if (step.status === "in_progress") counts.inProgress += 1;
		else counts.pending += 1;
	}
	return counts;
}

/** Whether a value is one of the three accepted statuses. */
function isPlanStepStatus(value: unknown): value is PlanStepStatus {
	return typeof value === "string" && (PLAN_STEP_STATUSES as readonly string[]).includes(value);
}

/**
 * Validate a raw `plan` argument and normalize it into a {@link PlanRecord}.
 *
 * Deliberately independent of Pi's schema validation, which the tool's parameters
 * already provide: this is the semantic layer — at most one in-progress step, no
 * empty step text, bounded list — that a JSON Schema cannot express, and it runs
 * before anything is persisted so a refused call leaves the durable record
 * untouched.
 *
 * The error text names the rule that was broken rather than echoing the whole
 * argument back, because a Goal turn spent re-reading a rejected payload is a
 * Goal turn not spent on the work.
 */
export function validatePlanArgument(raw: unknown): PlanValidation {
	if (!Array.isArray(raw)) {
		return {
			ok: false,
			error:
				`Plan not recorded: plan must be an array of steps, each an object with a step and a status ` +
				`(${PLAN_STEP_STATUSES.join(", ")}).`,
		};
	}
	if (raw.length === 0) {
		return {
			ok: false,
			error:
				"Plan not recorded: pass at least one step. A plan cannot be cleared: a later update replaces it, so pass " +
				"the steps that remain.",
		};
	}
	if (raw.length > MAX_PLAN_STEPS) {
		return {
			ok: false,
			error: `Plan not recorded: at most ${MAX_PLAN_STEPS} steps are accepted, got ${raw.length}.`,
		};
	}
	const steps: PlanStepRecord[] = [];
	let inProgress = 0;
	for (const [index, entry] of raw.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return {
				ok: false,
				error: `Plan not recorded: step ${index + 1} must be an object with a step and a status.`,
			};
		}
		const record = entry as Record<string, unknown>;
		const text = typeof record.step === "string" ? record.step.trim() : "";
		if (text === "") {
			return {
				ok: false,
				error: `Plan not recorded: step ${index + 1} has no text. Describe what that step is.`,
			};
		}
		if (Array.from(text).length > MAX_PLAN_STEP_LENGTH) {
			return {
				ok: false,
				error:
					`Plan not recorded: step ${index + 1} is longer than ${MAX_PLAN_STEP_LENGTH} characters. ` +
					"Shorten it; the objective stays the authoritative description of the work.",
			};
		}
		const status = record.status;
		if (!isPlanStepStatus(status)) {
			return {
				ok: false,
				error:
					`Plan not recorded: step ${index + 1} has status ${JSON.stringify(status)}; a step is ` +
					`${PLAN_STEP_STATUSES.join(", ")}.`,
			};
		}
		if (status === "in_progress") inProgress += 1;
		steps.push({ step: text, status });
	}
	if (inProgress > 1) {
		return {
			ok: false,
			error:
				`Plan not recorded: ${inProgress} steps are in_progress, and at most one may be. Mark the others ` +
				"pending or completed.",
		};
	}
	return { ok: true, plan: { steps, counts: countSteps(steps) } };
}

/** One plan line for the model-facing text, so the record is readable inline. */
function formatPlanLine(step: PlanStepRecord): string {
	return `- [${step.status}] ${step.step}`;
}

/**
 * The model-facing text of a successful plan update.
 *
 * It restates the plan (a tool result the model can re-read without re-reading
 * the whole transcript) and then states the one thing a plan must never be
 * mistaken for: Goal state. That sentence is load-bearing rather than decorative
 * — a model that has just marked every step completed is exactly the model that
 * might otherwise read its own plan as a completion, and the completion contract
 * requires current-state evidence the plan cannot carry.
 */
export function formatPlanMessage(plan: PlanRecord): string {
	const { completed, inProgress, pending, total } = plan.counts;
	const parts = [
		`Plan updated (${total} ${total === 1 ? "step" : "steps"}: ${completed} completed, ${inProgress} in progress, ${pending} pending).`,
		...plan.steps.map(formatPlanLine),
		"",
		"This plan is progress narration, not Goal state: it does not change the Goal's Lifecycle status, and marking " +
			"every step completed does not complete the Goal. Only update_goal with action complete does that, and only " +
			"after every requirement of the objective is verified by current-state evidence.",
	];
	return parts.join("\n");
}

/** The refusal for a plan call in a session with no Goal. */
export function formatPlanNoGoalMessage(): string {
	return (
		"Plan not recorded: no Goal is set for this session, so there is no progress to record. The plan tool tracks " +
		"progress on the current Goal; use get_goal to inspect it, or /goal <objective> to set one."
	);
}

/** The refusal for a plan call while the setting is off but the tool is still registered. */
export function formatPlanDisabledMessage(): string {
	return (
		"Plan not recorded: the progress-plan tool is disabled (goal.planTool is false). A setting changed after this " +
		"session started still leaves the registration in place, so the call is refused rather than silently recorded; " +
		"reload the session for the registration to match the setting."
	);
}

/**
 * The tool's argument schema, written as a plain JSON Schema object.
 *
 * Pi accepts any JSON Schema here (its own tool definitions are built the same
 * way), and a plain object is used rather than a TypeBox builder for one concrete
 * reason: a drifted `status` must fail with a message that names all three
 * accepted values. A TypeBox union of literals reports only its first member —
 * `expected "pending"` — which reads as though `pending` were the only valid
 * status and would push a model toward recording a wrong plan. A JSON Schema
 * `enum` reports `expected one of ["pending","in_progress","completed"]`, so the
 * correction is unambiguous.
 *
 * Unknown extra properties are deliberately *not* rejected: a model that adds an
 * `explanation` field has still said everything the tool needs, and refusing the
 * call would spend a Goal turn on a field the tool simply ignores.
 */
export const planParametersSchema = {
	type: "object",
	properties: {
		plan: {
			type: "array",
			minItems: 1,
			maxItems: MAX_PLAN_STEPS,
			description:
				"The whole ordered plan, replacing any previous one: every step, in order, with its status. " +
				"At most one step may be in_progress.",
			items: {
				type: "object",
				properties: {
					step: {
						type: "string",
						minLength: 1,
						maxLength: MAX_PLAN_STEP_LENGTH,
						description: "What this step is, in one line.",
					},
					status: {
						type: "string",
						enum: PLAN_STEP_STATUSES,
						description: "Where this step stands: pending, in_progress, or completed.",
					},
				},
				required: ["step", "status"],
			},
		},
	},
	required: ["plan"],
} as const;

/** The tool's arguments after schema validation (and after `prepareArguments`). */
export type PlanToolArguments = {
	plan: PlanStepRecord[];
};

/** JSON Schema of a plan record, for the tool's declared `structuredContent`. */
export const planOutputSchema = {
	type: "object",
	properties: {
		plan: {
			type: "object",
			properties: {
				steps: {
					type: "array",
					items: {
						type: "object",
						properties: {
							step: { type: "string" },
							status: { type: "string", enum: PLAN_STEP_STATUSES },
						},
						required: ["step", "status"],
					},
				},
				counts: {
					type: "object",
					properties: {
						total: { type: "integer" },
						completed: { type: "integer" },
						inProgress: { type: "integer" },
						pending: { type: "integer" },
					},
					required: ["total", "completed", "inProgress", "pending"],
				},
			},
			required: ["steps", "counts"],
		},
	},
	required: ["plan"],
} as const;

/**
 * The one-line summary Pi's default system prompt shows for this tool while it is
 * active, and the guideline bullets that accompany it.
 *
 * Both are part of the tool's own registration rather than of the Continuation, so
 * the model learns the tool exists from the seam that actually provides it — and
 * so a session that never opted in shows neither.
 */
export const PLAN_TOOL_PROMPT_SNIPPET = "Record the current Goal's ordered progress steps (pending, in_progress, completed)";

export const PLAN_TOOL_PROMPT_GUIDELINES: readonly string[] = [
	"Call update_plan when the current Goal has several ordered steps, and keep it current as steps start and finish: pass the whole ordered plan, each step pending, in_progress, or completed, with at most one in_progress.",
	"A plan update is progress narration, not Goal state: it never changes the Goal's Lifecycle status and can never mark the Goal complete. Only update_goal with action complete does that, after the evidence audit.",
];
