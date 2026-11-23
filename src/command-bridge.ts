/**
 * The in-process Goal command bridge (issue #56; request shape revised in #79).
 *
 * pi-goal's Goal command family is the *user* command surface: it owns
 * replacement confirmation, `goal.enabled` admission, Token-budget validation,
 * attachment materialization, the on-disk durability gate, and the
 * durable-before-announced announcement order. A host integration (a
 * Codex-shaped RPC client, an IDE, a companion package) that re-implemented any
 * of that would be a second lifecycle path, and the second path is always the
 * one that forgets a safety rule.
 *
 * So the bridge is deliberately not a lifecycle API. It carries **the same
 * dispatch Pi performs for a typed command** — a command name and the text
 * typed after it — to the same handler, and returns a structured description of
 * what that handler did: the committed transitions it announced, the
 * diagnostics it reported, the public state afterwards, and whether the
 * requested effect is still in place and durable. Nothing here reads or writes
 * a snapshot, a tombstone, or a `goal-usage` checkpoint; the only writer is the
 * store behind the command handler.
 *
 * Carrying Pi's own dispatch shape rather than "the text after `/goal`" is what
 * lets the bridge stay free of a parser: a request names `/goal:pause`, it does
 * not spell `pause` after `/goal` and hope both sides parse it the same way. The
 * companion that used to mirror pi-goal's parser so that a `set` could never
 * render the clear command therefore no longer needs a mirror at all — an
 * Objective is only ever the argument of `/goal`.
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

/** Bumps only if the request or result shape itself changes. Version 2 carries a command name plus argument text. */
export const GOAL_COMMAND_BRIDGE_VERSION = 2;

/**
 * The Goal command family: the only command names a bridge request may carry.
 *
 * The same list the extension registers, in `/` menu order. A request naming
 * anything else is malformed, like a bad version, because the bridge has no
 * handler to run for it and will not guess which one was meant.
 */
export const GOAL_COMMAND_NAMES = ["goal", "goal:pause", "goal:resume", "goal:clear", "goal:history", "goal:edit"] as const;

export type GoalCommandName = (typeof GOAL_COMMAND_NAMES)[number];

/**
 * The action a request asks for, derived from its command name — and, for
 * `/goal` itself, from whether it carries an Objective.
 *
 * Deliberately coarser than any handler internals: the bridge only needs to know
 * which durable transitions could be the *answer* to a request. `invalid` is
 * never produced from the request text (nothing is parsed); it is reserved for a
 * name that is valid for the protocol but is not a registered command at
 * dispatch time.
 */
export type GoalBridgeAction = "status" | "create" | "edit" | "pause" | "resume" | "clear" | "history" | "invalid";

/**
 * The transitions that can legitimately answer each mutating action.
 *
 * Filtering by this set is what keeps an unrelated concurrent transition — a
 * continuation that completes while a confirmation dialog is open — from being
 * reported as the outcome of this request. A transition outside the set is
 * simply not this command's answer.
 */
const COMMITTING_KINDS: Record<Exclude<GoalBridgeAction, "status" | "history" | "invalid">, readonly GoalTransitionKind[]> = {
	create: ["created", "replaced"],
	edit: ["objective-edited"],
	pause: ["paused"],
	resume: ["resumed", "budget-recovered"],
	clear: ["cleared"],
};

/** The transition kinds that answer `action`; empty for a read or an invalid command. */
export function committedKindsFor(action: GoalBridgeAction): readonly GoalTransitionKind[] {
	if (action === "status" || action === "history" || action === "invalid") return [];
	return COMMITTING_KINDS[action];
}

/** What the command did, as far as the durable record can prove it. */
export type GoalBridgeDisposition =
	/** A durable transition committed and is still the current state. */
	| "committed"
	/** A read-only query answered (there is nothing to commit). */
	| "reported"
	/** Nothing committed, and the command reported no problem: the user said no, or there was nothing to do. */
	| "declined"
	/** Nothing committed, and the command reported a warning or error. */
	| "refused"
	/** The named command is not one the bridge can run: it is not registered at dispatch time. */
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

/** A bridge request: one Goal command family command name and its argument text, plus where to answer. */
export interface GoalCommandBridgeRequest {
	version: typeof GOAL_COMMAND_BRIDGE_VERSION;
	/** Correlation id, echoed in the result. Never interpreted. */
	id: string;
	/**
	 * The command the user would type, without the leading slash: one of
	 * {@link GOAL_COMMAND_NAMES}. The verbs are reached by their own names, never
	 * spelled into `/goal`'s argument.
	 */
	name: GoalCommandName;
	/**
	 * The exact text a user would type after the command name. For `goal` an empty
	 * string is the bare status report and anything else is a creation (with its
	 * leading `--budget` / `--no-budget` / `--file` / `--image` / `--remote-image`
	 * options); for `goal:resume` it is empty or `--budget <new-total>`; for
	 * `goal:edit` it is the new objective or empty for the editor; the other verbs
	 * take nothing.
	 */
	args: string;
	/** Where the result is delivered. Called exactly once. */
	reply: (result: GoalCommandBridgeResult) => void;
}

/** The structured outcome of one bridged command. */
export interface GoalCommandBridgeResult {
	version: typeof GOAL_COMMAND_BRIDGE_VERSION;
	id: string;
	/** The request's command name, echoed. */
	name: GoalCommandName;
	/** The request's argument text, echoed. */
	args: string;
	/** True only for `committed` and `reported`: the requested effect is in place. */
	ok: boolean;
	disposition: GoalBridgeDisposition;
	/** The action the command name (and, for `goal`, its argument) asks for, or `invalid` for a name not registered at dispatch time. */
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

/** Bound on the accepted argument text, matching nothing in particular but not unbounded. */
const MAX_BRIDGE_ARGS_LENGTH = 100_000;

/**
 * Validate an inbound bridge payload.
 *
 * Strict on purpose: a malformed payload has no trustworthy `reply`, so the
 * bridge drops it and says why instead of half-executing a request. A request
 * from a *future* version is refused for the same reason — an unknown field could
 * mean anything, and guessing is how a compatibility shim becomes a lifecycle
 * path. A `name` outside the Goal command family is malformed for the same
 * reason again: there is no such command to run.
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
	if (typeof candidate.name !== "string" || !(GOAL_COMMAND_NAMES as readonly string[]).includes(candidate.name)) {
		return {
			ok: false,
			message:
				`the bridge request must carry a string name that is one of the Goal command family (${GOAL_COMMAND_NAMES.join(", ")}); ` +
				`got ${JSON.stringify(candidate.name)}`,
		};
	}
	if (typeof candidate.args !== "string") {
		return { ok: false, message: "the bridge request must carry a string args" };
	}
	if (candidate.args.length > MAX_BRIDGE_ARGS_LENGTH) {
		return { ok: false, message: `the bridge request args exceed ${MAX_BRIDGE_ARGS_LENGTH} characters` };
	}
	if (typeof candidate.reply !== "function") {
		return { ok: false, message: "the bridge request must carry a reply function" };
	}
	return {
		ok: true,
		request: {
			version: GOAL_COMMAND_BRIDGE_VERSION,
			id: candidate.id,
			name: candidate.name as GoalCommandName,
			args: candidate.args,
			reply: candidate.reply as GoalCommandBridgeRequest["reply"],
		},
	};
}

/**
 * The action a well-formed request asks for, from its command name alone.
 *
 * `/goal` is the one command with two meanings: an empty (or whitespace) argument
 * is the status report, anything else is a creation — including an argument the
 * creation path then refuses, because a refusal is still the create action's
 * answer and must be reported as `refused`, never as `invalid`. Every verb is
 * its own action whatever its argument says.
 */
export function goalBridgeActionFor(name: GoalCommandName, args: string): Exclude<GoalBridgeAction, "invalid"> {
	switch (name) {
		case "goal":
			return args.trim() === "" ? "status" : "create";
		case "goal:pause":
			return "pause";
		case "goal:resume":
			return "resume";
		case "goal:clear":
			return "clear";
		case "goal:history":
			return "history";
		case "goal:edit":
			return "edit";
	}
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
 * Order matters and is the whole contract: a read reports, an unregistered name
 * is invalid, a recorded transition decides on its own (committed when it
 * landed, refused when it was rolled back), and only with no transition at all do
 * the diagnostics' severities decide between declined and refused.
 */
export function classifyGoalBridgeOutcome(input: GoalBridgeOutcomeInput): {
	ok: boolean;
	disposition: GoalBridgeDisposition;
} {
	if (input.action === "invalid") return { ok: false, disposition: "invalid" };
	if (input.action === "status" || input.action === "history") {
		// A read has nothing to commit, so there is no durable proof to wait for —
		// but a read that reported a problem did not answer either, and calling
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

/**
 * A refusal the bridge produced itself: no command ran, so nothing committed.
 *
 * `action` is null because no action was ever derived — the request never reached
 * a handler — and the request's name and argument are echoed so the caller can
 * correlate the answer with what it sent.
 */
export function goalBridgeRefusal(input: {
	id: string;
	name: GoalCommandName;
	args: string;
	message: string;
	goal: GoalPublicState | null;
	admissionEnabled: boolean;
}): GoalCommandBridgeResult {
	return {
		version: GOAL_COMMAND_BRIDGE_VERSION,
		id: input.id,
		name: input.name,
		args: input.args,
		ok: false,
		disposition: "refused",
		action: null,
		goal: input.goal,
		admissionEnabled: input.admissionEnabled,
		transitions: [],
		diagnostics: [{ level: "error", text: input.message }],
	};
}

/**
 * The answer to a request whose `name` is valid for the protocol but is not a
 * registered command when the request is dispatched. Nothing ran, so nothing
 * committed; the disposition is `invalid` because the fault is in what was asked
 * for, not in what the Goal state allowed.
 */
export function goalBridgeUnregisteredCommand(
	request: Pick<GoalCommandBridgeRequest, "id" | "name" | "args">,
	goal: GoalPublicState | null,
	admissionEnabled: boolean,
): GoalCommandBridgeResult {
	return {
		version: GOAL_COMMAND_BRIDGE_VERSION,
		id: request.id,
		name: request.name,
		args: request.args,
		ok: false,
		disposition: "invalid",
		action: "invalid",
		goal,
		admissionEnabled,
		transitions: [],
		diagnostics: [
			{
				level: "error",
				text: `Goal command not run: /${request.name} is not a registered command, so there is nothing to run. Nothing was changed.`,
			},
		],
	};
}

/** Poll interval for the synthesized `waitForIdle`, in milliseconds. */
const IDLE_POLL_MS = 15;

/**
 * Build the command-capable view of a plain extension context.
 *
 * Pi hands a full {@link ExtensionCommandContext} only to a command handler, while
 * a bridge request arrives from an event-bus listener. The Goal command handlers need
 * exactly one capability the base context lacks — `waitForIdle()` — and Pi's own
 * implementation is "resolve once the session is idle, where idle means no agent
 * run is active and no compaction is running". `ctx.isIdle()` is bound to that
 * same predicate, so waiting is an observable poll of it rather than a second
 * interpretation of idleness.
 *
 * The capabilities a bridged command must never use are absent by contract: Pi
 * hands a command handler session control (`newSession`, `fork`, `navigateTree`,
 * `switchSession`, `reload`) and agent/process control (`abort`, `shutdown`,
 * `compact`), while a bridged command is one Goal command on behalf of an
 * external client. The Goal command family uses none of them, so they are present
 * but throw: a future change that started to would fail loudly instead of silently
 * switching, compacting, aborting, or shutting down a user's session out from
 * under an external caller. That is the whole session-control surface of
 * {@link ExtensionCommandContext}/{@link ExtensionContext}, so "no session
 * control" is an exhaustive promise rather than a list of favourite methods.
 * `signal` stays readable (it is the *current* run's signal, and reading it
 * cannot cancel anything); only the mutating entry points throw.
 */
export function commandContextForBridge(ctx: ExtensionContext): ExtensionCommandContext {
	const base = ctx as ExtensionContext & Partial<ExtensionCommandContext>;
	const forbidden = (name: string) => (): never => {
		throw new Error(
			`a bridged Goal command may not call ${name}(): the bridge runs one Goal command and never changes the session`,
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
				// Session control: none of these can be undone from a command that an
				// external caller is waiting on.
				case "newSession":
				case "fork":
				case "navigateTree":
				case "switchSession":
				case "reload":
				// Agent and process control: aborting the user's run, compacting the
				// context, or exiting Pi are all outside one Goal command's scope.
				case "abort":
				case "shutdown":
				case "compact":
					return forbidden(String(property));
				case "getSystemPromptOptions":
					if (typeof base.getSystemPromptOptions === "function") return base.getSystemPromptOptions.bind(ctx);
					return () => {
						throw new Error("system-prompt options are not available to a bridged Goal command");
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
