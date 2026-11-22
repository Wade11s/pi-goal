/**
 * The in-process Goal command bridge (issue #56).
 *
 * pi-goal's `/goal` command is the *user* command surface: it owns replacement
 * confirmation, `goal.enabled` admission, Token-budget validation, attachment
 * materialization, the on-disk durability gate, and the durable-before-announced
 * announcement order. A host integration (a Codex-shaped RPC client, an IDE, a
 * companion package) that re-implemented any of that would be a second lifecycle
 * path, and the second path is always the one that forgets a safety rule.
 *
 * So the bridge is deliberately not a lifecycle API. It carries **the same text a
 * user types after `/goal`** to the same handler, and returns a structured
 * description of what that handler did: the committed transitions it announced,
 * the diagnostics it reported, the public state afterwards, and whether the
 * requested effect is still in place and durable. Nothing here reads or writes a
 * snapshot, a tombstone, or a `goal-usage` checkpoint; the only writer is the
 * store behind the command handler.
 *
 * Two properties keep the result honest:
 *
 * - **Success is derived from the commit, never from a message.** A transition is
 *   recorded only when the store announces a *durable* transition, so a refused,
 *   declined, failed, or rolled-back command records none. A recorded transition
 *   still has to have *landed* — the current Goal must be the one that was
 *   committed, and its snapshot must be on disk — because `/goal <objective>`
 *   retracts a creation whose on-disk durability poll fails.
 * - **Nothing is classified from message text.** Diagnostics are forwarded
 *   verbatim (they are the user-facing contract) and classified only by severity:
 *   a warning or error means the command refused, info-only means it either
 *   reported state or changed nothing. No wording is parsed, so rewording a
 *   message can never change a machine-readable outcome.
 *
 * Transport is Pi's shared extension event bus, which is in-process and
 * fire-and-forget, so the request carries its own `reply` callback rather than
 * inventing a second protocol. The bus is a public seam any loaded extension can
 * already use; the bridge therefore confers **no authority beyond command
 * dispatch**, which a loaded extension already has (`/goal ...` through
 * `pi.sendUserMessage(..., { expandPromptTemplates: true })`). The companion is
 * where an authoritative external user action is asserted; the bridge is not able
 * to verify that and does not pretend to. See `docs/behavior/companion.md`.
 */
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalTransitionKind } from "./events.ts";
import type { GoalPublicState } from "./goal.ts";

/** Channel on Pi's shared extension event bus carrying a {@link GoalCommandBridgeRequest}. */
export const GOAL_COMMAND_BRIDGE = "pi-goal:command-bridge";

/** Bumps only if the request or result shape itself changes. */
export const GOAL_COMMAND_BRIDGE_VERSION = 1;

/**
 * The command family a `/goal` argument string belongs to.
 *
 * Deliberately coarser than the parsed command: the bridge only needs to know
 * which durable transitions could be the *answer* to a request, so an unknown or
 * malformed argument string is its own family (`invalid`) rather than a guess.
 */
export type GoalBridgeAction = "status" | "create" | "edit" | "pause" | "resume" | "clear" | "invalid";

/**
 * The transitions that can legitimately answer each mutating action.
 *
 * Filtering by this set is what keeps an unrelated concurrent transition — a
 * continuation that completes while a confirmation dialog is open — from being
 * reported as the outcome of this request. A transition outside the set is
 * simply not this command's answer.
 */
const COMMITTING_KINDS: Record<Exclude<GoalBridgeAction, "status" | "invalid">, readonly GoalTransitionKind[]> = {
	create: ["created", "replaced"],
	edit: ["objective-edited"],
	pause: ["paused"],
	resume: ["resumed", "budget-recovered"],
	clear: ["cleared"],
};

/** The transition kinds that answer `action`; empty for a read or an invalid command. */
export function committedKindsFor(action: GoalBridgeAction): readonly GoalTransitionKind[] {
	if (action === "status" || action === "invalid") return [];
	return COMMITTING_KINDS[action];
}

/** What the command did, as far as the durable record can prove it. */
export type GoalBridgeDisposition =
	/** A durable transition committed and is still the current state. */
	| "committed"
	/** A read-only status query answered (there is nothing to commit). */
	| "reported"
	/** Nothing committed, and the command reported no problem: the user said no, or there was nothing to do. */
	| "declined"
	/** Nothing committed, and the command reported a warning or error. */
	| "refused"
	/** The argument string was not a valid `/goal` command. */
	| "invalid";

/** One notification the command handler reported, in order, with its severity. */
export interface GoalBridgeDiagnostic {
	level: "info" | "warning" | "error";
	text: string;
}

/** One committed transition, projected to the public Goal state (never a record). */
export interface GoalBridgeTransition {
	kind: GoalTransitionKind;
	goal: GoalPublicState;
}

/** A bridge request: the `/goal` argument text, plus where to answer. */
export interface GoalCommandBridgeRequest {
	version: typeof GOAL_COMMAND_BRIDGE_VERSION;
	/** Correlation id, echoed in the result. Never interpreted. */
	id: string;
	/**
	 * The exact text a user would type after `/goal`. An empty string is the bare
	 * status report; `clear`, `pause`, `resume --budget 150`, `edit <objective>`,
	 * and `<objective>` mean exactly what they mean on the command line, including
	 * their leading `--budget` / `--no-budget` / `--file` / `--image` options.
	 */
	command: string;
	/** Where the result is delivered. Called exactly once. */
	reply: (result: GoalCommandBridgeResult) => void;
}

/** The structured outcome of one bridged command. */
export interface GoalCommandBridgeResult {
	version: typeof GOAL_COMMAND_BRIDGE_VERSION;
	id: string;
	command: string;
	/** True only for `committed` and `reported`: the requested effect is in place. */
	ok: boolean;
	disposition: GoalBridgeDisposition;
	/** The command family the text parsed into, or null when it could not be parsed. */
	action: GoalBridgeAction | null;
	/** The public state after the command; null when no Goal is current. */
	goal: GoalPublicState | null;
	/** Whether `goal.enabled` admission was on while the command ran. */
	admissionEnabled: boolean;
	/** The committed transitions that answer this command, in commit order. */
	transitions: GoalBridgeTransition[];
	/** Everything the command reported, in order, verbatim. */
	diagnostics: GoalBridgeDiagnostic[];
}

/** Request validation: either a well-formed request, or why it was dropped. */
export type GoalCommandBridgeParse =
	| { ok: true; request: GoalCommandBridgeRequest }
	| { ok: false; message: string };

/** Bound on the accepted command text, matching nothing in particular but not unbounded. */
const MAX_BRIDGE_COMMAND_LENGTH = 100_000;

/**
 * Validate an inbound bridge payload.
 *
 * Strict on purpose: a malformed payload has no trustworthy `reply`, so the
 * bridge drops it and says why instead of half-executing a request. A request
 * from a *future* version is refused for the same reason — an unknown field could
 * mean anything, and guessing is how a compatibility shim becomes a lifecycle
 * path.
 */
export function parseGoalCommandBridgeRequest(payload: unknown): GoalCommandBridgeParse {
	if (payload === null || typeof payload !== "object") {
		return { ok: false, message: "the bridge request must be an object" };
	}
	const candidate = payload as Record<string, unknown>;
	if (candidate.version !== GOAL_COMMAND_BRIDGE_VERSION) {
		return {
			ok: false,
			message:
				`the bridge request must declare version ${GOAL_COMMAND_BRIDGE_VERSION}; ` +
				`got ${JSON.stringify(candidate.version)}. Upgrade the companion or pi-goal so both speak the same version.`,
		};
	}
	if (typeof candidate.id !== "string" || candidate.id.length === 0) {
		return { ok: false, message: "the bridge request must carry a non-empty string id" };
	}
	if (typeof candidate.command !== "string") {
		return { ok: false, message: "the bridge request must carry a string command" };
	}
	if (candidate.command.length > MAX_BRIDGE_COMMAND_LENGTH) {
		return { ok: false, message: `the bridge request command exceeds ${MAX_BRIDGE_COMMAND_LENGTH} characters` };
	}
	if (typeof candidate.reply !== "function") {
		return { ok: false, message: "the bridge request must carry a reply function" };
	}
	return {
		ok: true,
		request: {
			version: GOAL_COMMAND_BRIDGE_VERSION,
			id: candidate.id,
			command: candidate.command,
			reply: candidate.reply as GoalCommandBridgeRequest["reply"],
		},
	};
}

/** Inputs the classifier needs, all of them facts about what already happened. */
export interface GoalBridgeOutcomeInput {
	action: GoalBridgeAction;
	/** Transitions already filtered to {@link committedKindsFor}`(action)`. */
	transitions: readonly GoalBridgeTransition[];
	diagnostics: readonly GoalBridgeDiagnostic[];
	/** Whether the last recorded transition is still the current, durable state. */
	committed: boolean;
}

/**
 * Classify an executed command.
 *
 * Order matters and is the whole contract: a status read reports, an invalid
 * command is invalid, a recorded transition decides on its own (committed when it
 * landed, refused when it was rolled back), and only with no transition at all do
 * the diagnostics' severities decide between declined and refused.
 */
export function classifyGoalBridgeOutcome(input: GoalBridgeOutcomeInput): {
	ok: boolean;
	disposition: GoalBridgeDisposition;
} {
	if (input.action === "invalid") return { ok: false, disposition: "invalid" };
	if (input.action === "status") {
		// A status read has nothing to commit, so there is no durable proof to wait
		// for — but a read that reported a problem did not answer either, and calling
		// that "reported" would be a success claim the caller cannot afford.
		const failed = input.diagnostics.some((diagnostic) => diagnostic.level !== "info");
		return { ok: !failed, disposition: failed ? "refused" : "reported" };
	}
	if (input.transitions.length > 0) {
		return input.committed ? { ok: true, disposition: "committed" } : { ok: false, disposition: "refused" };
	}
	const reported = input.diagnostics.some((diagnostic) => diagnostic.level !== "info");
	return { ok: false, disposition: reported ? "refused" : "declined" };
}

/** A refusal the bridge produced itself: no command ran, so nothing committed. */
export function goalBridgeRefusal(input: {
	id: string;
	command: string;
	message: string;
	goal: GoalPublicState | null;
	admissionEnabled: boolean;
}): GoalCommandBridgeResult {
	return {
		version: GOAL_COMMAND_BRIDGE_VERSION,
		id: input.id,
		command: input.command,
		ok: false,
		disposition: "refused",
		action: null,
		goal: input.goal,
		admissionEnabled: input.admissionEnabled,
		transitions: [],
		diagnostics: [{ level: "error", text: input.message }],
	};
}

/** Poll interval for the synthesized `waitForIdle`, in milliseconds. */
const IDLE_POLL_MS = 15;

/**
 * Build the command-capable view of a plain extension context.
 *
 * Pi hands a full {@link ExtensionCommandContext} only to a command handler, while
 * a bridge request arrives from an event-bus listener. The `/goal` handlers need
 * exactly one capability the base context lacks — `waitForIdle()` — and Pi's own
 * implementation is "resolve once the session is idle, where idle means no agent
 * run is active and no compaction is running". `ctx.isIdle()` is bound to that
 * same predicate, so waiting is an observable poll of it rather than a second
 * interpretation of idleness.
 *
 * The session-control methods a bridge must never perform (`newSession`, `fork`,
 * `navigateTree`, `switchSession`, `reload`) are present but throw: `/goal` does
 * not call them, so a future change that started to would fail loudly instead of
 * silently switching a user's session out from under an external client.
 */
export function commandContextForBridge(ctx: ExtensionContext): ExtensionCommandContext {
	const base = ctx as ExtensionContext & Partial<ExtensionCommandContext>;
	const forbidden = (name: string) => (): never => {
		throw new Error(
			`a bridged /goal command may not call ${name}(): the bridge runs one Goal command and never changes the session`,
		);
	};
	const view = new Proxy(ctx, {
		get(target, property, receiver) {
			switch (property) {
				case "waitForIdle":
					return async (): Promise<void> => {
						while (!target.isIdle()) {
							await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
						}
					};
				case "newSession":
				case "fork":
				case "navigateTree":
				case "switchSession":
				case "reload":
					return forbidden(String(property));
				case "getSystemPromptOptions":
					if (typeof base.getSystemPromptOptions === "function") return base.getSystemPromptOptions.bind(ctx);
					return () => {
						throw new Error("system-prompt options are not available to a bridged /goal command");
					};
				default:
					return Reflect.get(target, property, receiver ?? target);
			}
		},
	});
	return view as unknown as ExtensionCommandContext;
}

/**
 * Wrap a command context so every notification is also recorded for a bridge caller.
 *
 * The wrapper forwards to the real UI, so a bridged command looks exactly like the
 * same command typed by the user: the same dialog, the same notifications. It only
 * *adds* recording. Both the context and its `ui` are proxied because Pi exposes
 * `ui` as a getter onto the live UI context, and a copy would freeze whatever UI
 * happened to be bound at bridge time.
 */
export function recordingCommandContext(
	ctx: ExtensionCommandContext,
	sink: GoalBridgeDiagnostic[],
): ExtensionCommandContext {
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property !== "ui") return Reflect.get(target, property, receiver ?? target);
			const ui = target.ui;
			return new Proxy(ui, {
				get(uiTarget, uiProperty, uiReceiver) {
					if (uiProperty === "notify") {
						return (message: string, level?: "info" | "warning" | "error"): void => {
							sink.push({ level: level ?? "info", text: message });
							uiTarget.notify(message, level);
						};
					}
					const value = Reflect.get(uiTarget, uiProperty, uiReceiver ?? uiTarget);
					return typeof value === "function" ? value.bind(uiTarget) : value;
				},
			});
		},
	});
}
