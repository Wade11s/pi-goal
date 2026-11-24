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
 * That distinction is the whole point of this module, and it is where the first
 * version of this guard went wrong: it read pi-goal's own identity out of
 * `get_goal`, so any session whose policy filtered that one tool looked like a
 * session where another extension owned `propose_goal`. `propose_goal` was then
 * never registered and `/goal` refused creation, with a message that named a cause
 * that did not exist.
 *
 * The rule that replaced it has to survive two further facts about Pi's registry,
 * and both are about *who* a declaration belongs to rather than whether it exists:
 *
 * 1. **A tool is never its own witness.** Deriving pi-goal's identity from the very
 *    declaration under test makes any foreign owner of that name authenticate
 *    itself as pi-goal, which is fail-open in the worst direction.
 * 2. **Pi keeps the first extension in *load order* that declares a name**, not the
 *    first one to register it. An extension loaded before pi-goal can therefore
 *    register a name on a later event (`turn_start`) and displace a registration
 *    pi-goal already made, so "we registered it" is not by itself proof that the
 *    declaration in force is ours.
 *
 * Identity is therefore established once per runtime, from a source that cannot be
 * the tool under test:
 *
 * - a **load-time witness** on the first registry read of the runtime — one of the
 *   three tools pi-goal registers unconditionally at extension load. Pi refuses to
 *   load two extensions that register the same name at load, so such a name being
 *   visible then is pi-goal's. Seeded once and never re-seeded, so a peer that takes
 *   a witness name later cannot rewrite the cache;
 * - a **bootstrap** from the declaration visible in the same synchronous
 *   confirmation of a registration this runtime just made — the one moment a tool
 *   may vouch for itself, because nothing has had the chance to take the name since
 *   `checkName` found it free.
 *
 * With neither, ownership is **unverifiable** and every path fails closed. Both
 * registrations pi-goal performs — `propose_goal` and the opt-in `update_plan` — go
 * through the one flow in {@link registerOwnedTool}, so the rule and the wording
 * cannot drift apart. Every outcome stays fail-closed: not knowing costs a
 * convenience, while replacing another extension's tool costs that extension its
 * tool.
 */
/**
 * The three tools pi-goal registers unconditionally at extension load.
 *
 * These — and only these — may witness pi-goal's own identity, because Pi refuses to
 * load two extensions that register the same name at load: a load-time pi-goal name
 * that is visible on the first read of a runtime is pi-goal's. The two opt-in tools
 * are deliberately absent from this set. Another extension may legitimately own
 * `update_plan`, so accepting it as a witness would let a foreign declaration define
 * this extension's identity — and a foreign `update_plan` is exactly what a peer
 * that wants the conventional name registers.
 */
const LOAD_TIME_WITNESS_TOOL_NAMES: readonly string[] = ["get_goal", "create_goal", "update_goal"];

/**
 * Why ownership could not be determined, in the two shapes that need different
 * wording: a registry that could not be read at all, and one that was read but in
 * which pi-goal's own declarations could not be identified.
 */
type UnverifiableCause = { kind: "unreadable"; reason: string } | { kind: "unidentified"; reason: string };

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
	| UnverifiableCause;

/** What became of a registration this runtime was allowed to attempt. */
export type ToolSurvival =
	/** pi-goal's own declaration of the tool is the one in force. */
	| { kind: "owned" }
	/** Another extension's declaration displaced the one this runtime registered. */
	| { kind: "takeover" }
	/** The name is not in the readable registry at all, which only the session's tool policy can explain. */
	| { kind: "hidden" }
	/** pi-goal could not confirm that its own declaration is the one in force. */
	| UnverifiableCause;

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
	/**
	 * Confirm a registration this runtime has *just* made, and record what became
	 * of it. Only this method may seed identity from the declaration under test,
	 * because only here is that declaration provably the one pi-goal just handed to
	 * Pi; every other seam must go through {@link checkSurvival}.
	 */
	confirmRegistration(name: string): ToolSurvival;
	/** Whether the declaration of `name` now in force is pi-goal's own. */
	checkSurvival(name: string): ToolSurvival;
	/** Record that this runtime registered `name` itself. */
	noteRegistered(name: string): void;
}

/** The cause sentence shared by every "another extension owns this name" warning. */
const FOREIGN_CAUSE = "another extension already provides a tool with that name, and pi-goal will not replace it.";
/** The cause sentence shared by every "another extension took this name over" warning. */
const TAKEOVER_CAUSE = "another extension's tool of the same name took its place.";
/** Why a registry that was read still cannot tell pi-goal which declarations are its own. */
const OWN_SOURCE_UNKNOWN_REASON =
	"no pi-goal tool was visible in this session's tool registry, so pi-goal could not tell which declarations " +
	"in it are its own";

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
	return joinSentences(`pi-goal did not register ${name}:`, cause, consequence, `${repair}, or ${wording.without}.`);
}

/** `pi-goal registered <name>, but <cause> <consequence> <repair>, or <without>.` */
function notInForceWarning(
	name: string,
	cause: string,
	wording: ToolRegistrationWording,
	consequence: string,
	repair: string,
): string {
	return joinSentences(`pi-goal registered ${name}, but`, cause, consequence, `${repair}, or ${wording.without}.`);
}

/**
 * The cause clause for a registration pi-goal declined because it could not verify
 * the name at all.
 *
 * Deliberately cause-neutral in both shapes: each says what pi-goal could not find
 * out and what it did instead, and neither claims that another extension owns the
 * name.
 */
function notRegisteredCause(cause: UnverifiableCause): string {
	return cause.kind === "unreadable"
		? `it could not read this session's tool registry to check whether the name is already taken ` +
				`(${cause.reason}), so it declined to register rather than risk replacing another extension's tool`
		: `${cause.reason}; it declined to register rather than risk replacing another extension's tool`;
}

/** The cause clause for a registration whose own declaration could not be confirmed. */
function notConfirmedCause(cause: UnverifiableCause): string {
	return cause.kind === "unreadable"
		? `the session's tool registry could not be read (${cause.reason})`
		: cause.reason;
}

/** A non-empty source path, or undefined. */
function sourcePathOf(entry: ToolRegistryEntry | undefined): string | undefined {
	const path = entry?.sourceInfo?.path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

/**
 * Whether a declaration that is in force is the one this extension owns.
 *
 * The shared tail of both checks, phrased without either caller's vocabulary so the
 * registration guard and the survival check cannot disagree about what they saw.
 */
type DeclarationAttribution =
	/** The declaration in force carries pi-goal's own source path. */
	| { kind: "ours" }
	/** The declaration in force comes from somewhere else. */
	| { kind: "takeover" }
	/** pi-goal's own source path is not known, so the declaration cannot be attributed. */
	| UnverifiableCause;

/** Attribute a declaration that is in force to pi-goal or to somebody else. */
function attribute(existing: ToolRegistryEntry, ownSource: string | undefined): DeclarationAttribution {
	if (ownSource === undefined) return { kind: "unidentified", reason: OWN_SOURCE_UNKNOWN_REASON };
	return sourcePathOf(existing) === ownSource ? { kind: "ours" } : { kind: "takeover" };
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
	/**
	 * The source path that identifies pi-goal in the registry, established at most
	 * once per runtime by a load-time witness or by the bootstrap of a registration
	 * this runtime just made. Never derived from a declaration under suspicion.
	 */
	let cachedOwnSource: string | undefined;
	/** Whether the one load-time witness seed has been attempted on a read that succeeded. */
	let witnessSeedAttempted = false;

	const read = (): { ok: true; tools: ToolRegistryEntry[] } | { ok: false; reason: string } => {
		let tools: ToolRegistryEntry[];
		try {
			tools = readTools();
		} catch (error) {
			return { ok: false, reason: describeError(error) };
		}
		// Seed identity once per runtime, on the first read that actually succeeded:
		// a read that threw leaves the seed for the next one, so a transient failure
		// at startup does not forfeit it. Never re-seeded afterwards, so a peer that
		// takes a witness name on a later event cannot rewrite what this runtime
		// already knows about itself.
		if (!witnessSeedAttempted) {
			witnessSeedAttempted = true;
			if (cachedOwnSource === undefined) {
				for (const name of LOAD_TIME_WITNESS_TOOL_NAMES) {
					const path = sourcePathOf(tools.find((tool) => tool.name === name));
					if (path !== undefined) {
						cachedOwnSource = path;
						break;
					}
				}
			}
		}
		return { ok: true, tools };
	};

	return {
		checkName(name: string): ToolNameOwnership {
			const attempt = read();
			if (!attempt.ok) return { kind: "unreadable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			// Nothing of that name is in force. That is the only reading of an absent
			// entry: the session's tool policy filters the registry, so absence is never
			// evidence about ownership either way.
			if (existing === undefined) return { kind: "free" };
			// A name this runtime has not registered is somebody else's, whoever it is.
			if (!registered.has(name)) return { kind: "foreign" };
			// This runtime registered the name, so it stays ours only while the
			// declaration in force is the one this extension owns.
			const attribution = attribute(existing, cachedOwnSource);
			return attribution.kind === "ours" ? { kind: "free" } : attribution;
		},

		confirmRegistration(name: string): ToolSurvival {
			const attempt = read();
			if (!attempt.ok) return { kind: "unreadable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			// pi-goal just registered the name, so a readable registry that does not
			// list it is the session's tool policy hiding it — never a takeover.
			if (existing === undefined) return { kind: "hidden" };
			// Bootstrap. This is the one seam where the declaration under test may
			// establish identity: `checkName` found the name free, this runtime then
			// registered it, and nothing has run in between, so the declaration now in
			// force is the one pi-goal just handed to Pi.
			if (cachedOwnSource === undefined) {
				const path = sourcePathOf(existing);
				if (path !== undefined) cachedOwnSource = path;
			}
			const attribution = attribute(existing, cachedOwnSource);
			return attribution.kind === "ours" ? { kind: "owned" } : attribution;
		},

		checkSurvival(name: string): ToolSurvival {
			const attempt = read();
			if (!attempt.ok) return { kind: "unreadable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			// Same reading as the confirmation: a registration that is no longer in the
			// readable registry was hidden by the session's tool policy, not stolen.
			if (existing === undefined) return { kind: "hidden" };
			// No bootstrap here. A tool that is in force is never its own witness: a
			// foreign owner of the name would authenticate itself as pi-goal.
			const attribution = attribute(existing, cachedOwnSource);
			return attribution.kind === "ours" ? { kind: "owned" } : attribution;
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
 * - **unreadable** — the registry could not be read: pi-goal registers nothing, with
 *   a cause-neutral warning;
 * - **unidentified** — the registry was read but pi-goal's own declarations could
 *   not be identified in it, so the name is treated as taken;
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
	if (ownership.kind === "unreadable" || ownership.kind === "unidentified") {
		notify(
			notRegisteredWarning(
				name,
				notRegisteredCause(ownership),
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
	const survival = guard.confirmRegistration(name);
	if (survival.kind === "owned") return true;
	if (survival.kind === "hidden") return false;
	if (survival.kind === "takeover") {
		notify(notInForceWarning(name, TAKEOVER_CAUSE, wording, wording.consequenceDisplaced, wording.repairOwner));
		return false;
	}
	notify(
		joinSentences(
			`pi-goal registered ${name}, but it could not confirm that its own declaration is the one in force ` +
				`(${notConfirmedCause(survival)}).`,
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
