/**
 * Tool-name ownership: whether pi-goal may register a tool name, and whether the
 * declaration now in force is pi-goal's own.
 *
 * Pi's tool registry is keyed by name across every loaded extension, and it is
 * **filtered by the session's tool policy**: `pi.getAllTools()` returns only the
 * tools the session's `--tools` allowlist and `--exclude-tools` denylist admit. So
 * the absence of a tool from that list says nothing about who owns the name — it is
 * exactly as consistent with "this session hides it" as with "nobody registered it".
 *
 * That distinction is the whole point of this module, and it is where the old guard
 * went wrong: it read pi-goal's own identity out of `get_goal`, so any session whose
 * policy filtered that one tool looked like a session where another extension owned
 * `propose_goal`. `propose_goal` was then never registered and `/goal` refused
 * creation, with a message that named a cause that did not exist.
 *
 * Two rules replace it:
 *
 * 1. **Ownership is decided by what this runtime registered, never by inferring
 *    pi-goal's identity from a Goal tool.** A same-named tool that is in force
 *    before this runtime registers it is foreign; a name this runtime registered
 *    stays ours; a name another extension has since taken over stays refused.
 * 2. **"The host filtered our tools" is never reported as a takeover.** A
 *    registration that succeeded but is no longer in the readable registry is
 *    *hidden*, not stolen, and it is silent at startup; a registry that cannot be
 *    read is *unverifiable*, not foreign.
 *
 * Both registrations pi-goal performs — `propose_goal` and the opt-in `update_plan`
 * — go through the one flow in {@link registerOwnedTool}, so the rule and the
 * wording cannot drift apart between them. Every outcome stays fail-closed: not
 * knowing costs a convenience, while replacing another extension's tool costs that
 * extension its tool.
 */
import { PROPOSE_GOAL_TOOL_NAME } from "./clarification.ts";
import { PLAN_TOOL_NAME } from "./plan.ts";

/**
 * Every model tool name pi-goal itself registers, most load-bearing first.
 *
 * This is the candidate set pi-goal's *own* source path is derived from: any of
 * them being visible identifies this extension in the registry. The three
 * unconditional Goal tools come first because they are registered at extension
 * load and are therefore the likeliest to be visible; the two opt-in tools come
 * last because a session that admits them may still hide the rest.
 */
export const PI_GOAL_TOOL_NAMES: readonly string[] = [
	"get_goal",
	"create_goal",
	"update_goal",
	PROPOSE_GOAL_TOOL_NAME,
	PLAN_TOOL_NAME,
];

/** The part of Pi's `ToolInfo` an ownership decision reads. */
export interface ToolRegistryEntry {
	name: string;
	sourceInfo?: { path?: string };
}

/** Whether a tool name is pi-goal's to register. */
export type ToolNameOwnership =
	/** No tool of that name is in force: the name is free. */
	| { kind: "free" }
	/** A tool of that name is in force from another extension, which pi-goal must not replace. */
	| { kind: "foreign" }
	/** This runtime registered the name, and another extension's declaration is the one in force. */
	| { kind: "takeover" }
	/** Ownership could not be determined, so the name is treated as taken. */
	| { kind: "unverifiable"; reason: string };

/** What became of a registration this runtime was allowed to attempt. */
export type ToolSurvival =
	/** pi-goal's own declaration of the tool is the one in force. */
	| { kind: "owned" }
	/** Another extension's declaration displaced the one this runtime registered. */
	| { kind: "takeover" }
	/** The name is not in the readable registry at all, which only the session's tool policy can explain. */
	| { kind: "hidden" }
	/** pi-goal could not confirm that its own declaration is the one in force. */
	| { kind: "unverifiable"; reason: string };

/** Reads the registry as Pi exposes it. Throwing is a legitimate outcome. */
export type ToolRegistryReader = () => ToolRegistryEntry[];

/** The tool-specific clauses every registration warning is built from. */
export interface ToolRegistrationWording {
	/** What the session loses while the tool is missing, and why that matters. */
	consequence: string;
	/** The same, for a registration whose own declaration is not the one in force. */
	consequenceDisplaced: string;
	/** How to make the name available to pi-goal again. */
	repairOwner: string;
	/** How to recover when the registration itself failed or could not be confirmed. */
	repairRegistration: string;
	/** How to carry on without the tool. */
	without: string;
}

/**
 * The ownership state of every tool name this runtime registered, plus the source
 * path that identifies pi-goal in the registry.
 *
 * Per-runtime state lives here rather than in a module-level variable so a second
 * runtime in the same process starts from a clean slate: a name one runtime
 * registered says nothing about what another runtime may register.
 */
export interface ToolOwnershipGuard {
	/** Whether pi-goal may register `name` now, and why not when it may not. */
	checkName(name: string): ToolNameOwnership;
	/** Whether the declaration of `name` now in force is pi-goal's own. */
	checkSurvival(name: string): ToolSurvival;
	/** Record that this runtime registered `name` itself. */
	noteRegistered(name: string): void;
}

/** The cause sentence shared by every "another extension owns this name" warning. */
const FOREIGN_CAUSE = "another extension already provides a tool with that name, and pi-goal will not replace it.";
/** The cause sentence shared by every "another extension took this name over" warning. */
const TAKEOVER_CAUSE = "another extension's tool of the same name took its place.";

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Join the non-empty sentences of one warning, so an empty clause leaves no gap. */
function joinSentences(...sentences: (string | undefined)[]): string {
	return sentences.filter((sentence) => sentence !== undefined && sentence !== "").join(" ");
}

/** `pi-goal did not register <name>: <cause> <consequence> <repair>, or <without>.` */
function notRegisteredWarning(
	name: string,
	cause: string,
	wording: ToolRegistrationWording,
	consequence: string,
	repair: string,
): string {
	return joinSentences(
		`pi-goal did not register ${name}:`,
		cause,
		consequence,
		`${repair}, or ${wording.without}.`,
	);
}

/** `pi-goal registered <name>, but <cause> <consequence> <repair>, or <without>.` */
function notInForceWarning(
	name: string,
	cause: string,
	wording: ToolRegistrationWording,
	consequence: string,
	repair: string,
): string {
	return joinSentences(
		`pi-goal registered ${name}, but`,
		cause,
		consequence,
		`${repair}, or ${wording.without}.`,
	);
}

/**
 * The cause sentence for a registry that could not be read.
 *
 * Deliberately cause-neutral: it says what pi-goal could not find out and what it
 * did instead, and it never claims that another extension owns the name.
 */
function unreadableRegistryCause(reason: string): string {
	return (
		"it could not read this session's tool registry to check whether the name is already taken " +
		`(${reason}), so it declined to register rather than risk replacing another extension's tool.`
	);
}

/**
 * The source path that identifies pi-goal in the registry.
 *
 * Derived from any *visible* pi-goal tool rather than from one hard-coded name,
 * because a session's tool policy can hide any single one of them. The tool under
 * test is skipped on the first pass so a foreign declaration of that name can never
 * define pi-goal's own identity; whatever an earlier session in this runtime derived
 * is reused before falling back to it, and only a path derived from a tool *other*
 * than the one under test is remembered — that cache is what keeps a session which
 * hides every other pi-goal tool from concluding that the tool it is examining is
 * its own.
 */
function ownSourceOf(
	tools: ToolRegistryEntry[],
	exclude: string | undefined,
	cached: string | undefined,
): { path: string | undefined; cacheable: boolean } {
	for (const tool of tools) {
		if (tool.name === exclude) continue;
		if (!PI_GOAL_TOOL_NAMES.includes(tool.name)) continue;
		const path = tool.sourceInfo?.path;
		if (typeof path === "string" && path !== "") return { path, cacheable: true };
	}
	if (cached !== undefined) return { path: cached, cacheable: false };
	if (exclude !== undefined) {
		const self = tools.find((tool) => tool.name === exclude);
		const path = self?.sourceInfo?.path;
		if (typeof path === "string" && path !== "") return { path, cacheable: false };
	}
	return { path: undefined, cacheable: false };
}

/**
 * Build the ownership guard over one registry reader.
 *
 * The reader is Pi's `getAllTools`, and it is allowed to throw: a host without that
 * seam, or one that fails mid-session, is an outcome rather than a crash.
 */
export function createToolOwnershipGuard(readTools: ToolRegistryReader): ToolOwnershipGuard {
	/** Every name this runtime passed to `registerTool`. */
	const registered = new Set<string>();
	/** The source path an earlier session in this runtime derived for pi-goal. */
	let cachedOwnSource: string | undefined;

	const read = (): { ok: true; tools: ToolRegistryEntry[] } | { ok: false; reason: string } => {
		try {
			return { ok: true, tools: readTools() };
		} catch (error) {
			return { ok: false, reason: describeError(error) };
		}
	};

	return {
		checkName(name: string): ToolNameOwnership {
			const attempt = read();
			if (!attempt.ok) return { kind: "unverifiable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			// Nothing of that name is in force. That is the only reading of an absent
			// entry: the session's tool policy filters the registry, so absence is never
			// evidence about ownership either way.
			if (existing === undefined) return { kind: "free" };
			// A name this runtime has not registered is somebody else's, whoever it is.
			if (!registered.has(name)) return { kind: "foreign" };
			// This runtime registered the name, so it stays ours unless the declaration
			// in force provably comes from somewhere else.
			const own = ownSourceOf(attempt.tools, name, cachedOwnSource);
			if (own.path === undefined) {
				return {
					kind: "unverifiable",
					reason: "pi-goal's own tool source could not be identified in this session's tool registry",
				};
			}
			if (own.cacheable) cachedOwnSource = own.path;
			return existing.sourceInfo?.path === own.path ? { kind: "free" } : { kind: "takeover" };
		},

		checkSurvival(name: string): ToolSurvival {
			const attempt = read();
			if (!attempt.ok) return { kind: "unverifiable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			// pi-goal just registered the name, so a readable registry that no longer
			// lists it is the session's tool policy hiding it — never a takeover.
			if (existing === undefined) return { kind: "hidden" };
			const own = ownSourceOf(attempt.tools, name, cachedOwnSource);
			if (own.path === undefined) {
				return {
					kind: "unverifiable",
					reason: "pi-goal's own tool source could not be identified in this session's tool registry",
				};
			}
			if (own.cacheable) cachedOwnSource = own.path;
			return existing.sourceInfo?.path === own.path ? { kind: "owned" } : { kind: "takeover" };
		},

		noteRegistered(name: string): void {
			registered.add(name);
		},
	};
}

/** What one registration attempt needs from its caller. */
export interface RegisterOwnedToolOptions {
	guard: ToolOwnershipGuard;
	/** The tool name being registered. */
	name: string;
	/** The tool-specific clauses every warning is built from. */
	wording: ToolRegistrationWording;
	/** The registration itself, which may throw. */
	register: () => void;
	/** Surfaces a startup warning. */
	notify: (message: string) => void;
}

/**
 * Register one of pi-goal's own tools, and report exactly what happened.
 *
 * The order is the contract. Ownership is decided *before* anything is registered,
 * so pi-goal never replaces another extension's tool; the registration is then
 * confirmed rather than assumed, because a registration that was allowed can still
 * lose the name; and each failure is its own outcome with its own wording:
 *
 * - **foreign** — another extension already owns the name: pi-goal registers nothing;
 * - **takeover** — this runtime registered the name and another extension's
 *   declaration is the one in force: pi-goal registers nothing and keeps refusing;
 * - **unverifiable** — the registry could not be read, or pi-goal's own source could
 *   not be identified: pi-goal registers nothing, with a cause-neutral warning;
 * - **failed** — `registerTool` threw;
 * - **hidden** — the registration landed but the session's tool policy keeps the
 *   tool out of the model's reach. Silent at startup, because nothing went wrong
 *   and there is nobody to tell; `/goal` explains it instead;
 * - **owned** — pi-goal's own declaration is the one in force.
 *
 * Everything except **owned** answers `false`, which is the fail-closed direction:
 * the caller then declines to promise the tool rather than naming a tool the model
 * cannot call.
 */
export function registerOwnedTool(options: RegisterOwnedToolOptions): boolean {
	const { guard, name, wording, register, notify } = options;
	const ownership = guard.checkName(name);
	if (ownership.kind === "foreign") {
		notify(notRegisteredWarning(name, FOREIGN_CAUSE, wording, wording.consequence, wording.repairOwner));
		return false;
	}
	if (ownership.kind === "takeover") {
		notify(notInForceWarning(name, TAKEOVER_CAUSE, wording, wording.consequenceDisplaced, wording.repairOwner));
		return false;
	}
	if (ownership.kind === "unverifiable") {
		notify(
			notRegisteredWarning(
				name,
				unreadableRegistryCause(ownership.reason),
				wording,
				wording.consequence,
				wording.repairRegistration,
			),
		);
		return false;
	}
	try {
		register();
	} catch (error) {
		notify(
			joinSentences(
				`pi-goal could not register the ${name} tool (${describeError(error)}).`,
				wording.consequence,
				`${wording.repairRegistration}, or ${wording.without}.`,
			),
		);
		return false;
	}
	guard.noteRegistered(name);
	const survival = guard.checkSurvival(name);
	if (survival.kind === "owned") return true;
	if (survival.kind === "hidden") return false;
	if (survival.kind === "takeover") {
		notify(notInForceWarning(name, TAKEOVER_CAUSE, wording, wording.consequenceDisplaced, wording.repairOwner));
		return false;
	}
	notify(
		joinSentences(
			`pi-goal registered ${name}, but it could not confirm that its own declaration is the one in force ` +
				`(${survival.reason}).`,
			wording.consequenceDisplaced,
			`${wording.repairRegistration}, or ${wording.without}.`,
		),
	);
	return false;
}

/**
 * Every registration warning's wording for the Objective-clarification tool.
 *
 * One object, so the `propose_goal` warnings and the rule that produces them stay
 * in step with `update_plan`'s: both flow through {@link registerOwnedTool}.
 */
export const PROPOSE_GOAL_REGISTRATION_WORDING: ToolRegistrationWording = {
	consequence:
		"Because Objective clarification is enabled (goal.clarifyOnCreate is true), /goal <objective> will refuse " +
		"rather than create a Goal without the confirmation editor that is its creation authority.",
	consequenceDisplaced:
		"Because Objective clarification is enabled (goal.clarifyOnCreate is true), /goal <objective> will refuse " +
		"rather than create a Goal without the confirmation editor that is its creation authority.",
	repairOwner: "Rename that extension's tool (or unload it)",
	repairRegistration: "Fix the registration failure",
	without: "set goal.clarifyOnCreate to false to create directly without confirmation",
};

/** Every registration warning's wording for the opt-in progress-plan tool. */
export const PLAN_TOOL_REGISTRATION_WORDING: ToolRegistrationWording = {
	consequence: "No Continuation will mention the plan tool.",
	consequenceDisplaced: "No Continuation will mention the plan tool, and pi-goal will not tell the model to call it.",
	repairOwner: "Rename that extension's tool to use pi-goal's own",
	repairRegistration: "Fix the registration failure",
	without: "set goal.planTool to false to stop pi-goal from offering one",
};
