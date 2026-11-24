import { realpathSync } from "node:fs";

/**
 * Tool-name ownership: whether pi-goal may register a tool name, and whether the
 * declaration now in force is the one this runtime handed to Pi.
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
 * What replaced it has to survive three further facts about Pi's registry, and all
 * three are about *who* a declaration belongs to rather than whether it exists:
 *
 * 1. **Pi keeps the first extension in *load order* that declares a name**, not the
 *    first one to register it, and extension handlers run in load order. So an
 *    extension loaded before pi-goal can win a name pi-goal already registered —
 *    from its own `session_start`, or, because `registerTool` synchronously refreshes
 *    the registry and applying the loadout runs active tools' `prepareLoadout` hooks,
 *    from *inside* pi-goal's own `registerTool` call, between its ownership check and
 *    its confirmation.
 * 2. **Being in the registry is not being reachable.** `getAllTools()` still lists
 *    tools a peer removed with `pi.setActiveTools()`, so a tool the model can no
 *    longer call must not be promised.
 *
 * So identity is a **conjunction**, and each half covers what the other cannot:
 *
 * - the **schema object** — Pi returns the very `parameters` object that was handed to
 *   `registerTool`, by reference, so a declaration carries the object this runtime
 *   passed. That half is what survives policy filtering and two runtimes of one file;
 * - **pi-goal's own module path** — derived from this module's own location, never
 *   from the registry, and compared against the declaration's `sourceInfo.path`, which
 *   Pi assigns from the registering extension's file.
 *
 * Neither half is sufficient alone. The schema is *not* unforgeable: `getAllTools()`
 * hands every extension the `parameters` object of every registered tool, so a peer
 * can copy the reference into its own `registerTool` call and be believed. The path is
 * not sufficient either, because two runtimes of one file share it, and because a
 * session's tool policy can hide every tool that would reveal it. Together they are:
 * only this module can be loaded from this file, and only this runtime holds the
 * schema object it passed. Availability adds the third condition: the tool must also
 * be in the session's active loadout.
 *
 * Both registrations pi-goal performs — `propose_goal` and the opt-in `update_plan`
 * — go through the one flow in {@link registerOwnedTool}, so the rule and the
 * wording cannot drift apart. Every outcome stays fail-closed: not knowing costs a
 * convenience, while replacing another extension's tool costs that extension its
 * tool.
 */

/** The part of Pi's `ToolInfo` an ownership decision reads. */
export interface ToolRegistryEntry {
	name: string;
	/**
	 * The tool's parameter schema, as Pi returns it: the *same object* the
	 * registering extension handed to `registerTool`. Optional only so a fake that
	 * does not model the seam still type-checks; a missing value simply never
	 * matches, which is the fail-closed direction.
	 */
	parameters?: unknown;
	/**
	 * Where the registering extension was loaded from, as Pi assigned it. Optional for
	 * the same reason; a missing value never matches, which is fail-closed.
	 */
	sourceInfo?: { path?: string };
}

/** Whether a tool name is pi-goal's to register. */
export type ToolNameOwnership =
	/** Nothing of that name is in force: the name is free. */
	| { kind: "free" }
	/** A tool of that name is in force from another extension, which pi-goal must not replace. */
	| { kind: "foreign" }
	/** This runtime registered the name, and a different declaration is the one in force. */
	| { kind: "takeover" }
	/** The registry could not be read. */
	| { kind: "unreadable"; reason: string };

/** What became of a registration this runtime was allowed to attempt. */
export type ToolSurvival =
	/** The declaration in force is the very one this runtime handed to Pi. */
	| { kind: "owned" }
	/** A different declaration is in force, so the registration was displaced. */
	| { kind: "takeover" }
	/** The name is not in the readable registry at all, which only the session's tool policy can explain. */
	| { kind: "hidden" }
	/** The registry could not be read. */
	| { kind: "unreadable"; reason: string };

/** What a tool this runtime registered is worth to the model right now. */
export type ToolAvailability =
	/** It is pi-goal's own declaration and the session's active loadout declares it. */
	| { kind: "available" }
	/** A different declaration is in force. */
	| { kind: "takeover" }
	/** The name is not in the readable registry, so the session's tool policy hid it. */
	| { kind: "hidden" }
	/** It is pi-goal's own declaration, but the session's active loadout does not declare it. */
	| { kind: "inactive" }
	/** The registry or the active loadout could not be read. */
	| { kind: "unreadable"; reason: string }
	/**
	 * This runtime never registered the name. Defensive: the callers that ask about
	 * availability gate on their own registration flag first, so a well-formed seam
	 * never reaches it.
	 */
	| { kind: "unregistered" };

/** Reads the registry as Pi exposes it. Throwing is a legitimate outcome. */
export type ToolRegistryReader = () => ToolRegistryEntry[];

/** Reads the session's model-visible tool names, or undefined on a host without the seam. */
export type ActiveToolReader = () => string[] | undefined;

/** The tool-specific clauses every registration warning is built from. */
export interface ToolRegistrationWording {
	/** What the session loses while the tool is missing, and why that matters. */
	consequence: string;
	/** The same, for a registration whose own declaration is not the one in force. */
	consequenceDisplaced: string;
	/** How to make the name available to pi-goal again. */
	repairOwner: string;
	/** How to recover when the registration call itself threw. */
	repairRegistration: string;
	/** How to carry on without the tool. */
	without: string;
}

/**
 * How to recover from a tool registry that could not be read.
 *
 * Shared by both tools rather than part of either one's wording, because the repair
 * is about the host or the extension that broke the read, not about the tool.
 */
const REPAIR_UNREADABLE = "fix the host or extension whose getAllTools() throws";

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

/** The cause clause for a registration pi-goal declined because it could not read the registry. */
function unreadableRegistryCause(reason: string): string {
	return (
		`it could not read this session's tool registry to check whether the name is already taken ` +
		`(${reason}), so it declined to register rather than risk replacing another extension's tool`
	);
}

/** The cause clause for a registration whose own declaration could not be confirmed. */
function unconfirmedRegistryCause(reason: string): string {
	return `the session's tool registry could not be read (${reason}).`;
}

/**
 * The ownership state of every tool name this runtime registered, keyed by the exact
 * schema object it handed to Pi.
 *
 * Per-runtime state lives here rather than in a module-level variable so a second
 * runtime in the same process starts from a clean slate: a name one runtime
 * registered says nothing about what another runtime may register, and the two
 * runtimes' schema objects are different objects even when they come from the same
 * source file.
 */
export interface ToolOwnershipGuard {
	/** Whether pi-goal may register `name` now, and why not when it may not. */
	checkName(name: string): ToolNameOwnership;
	/**
	 * Confirm a registration this runtime has *just* made, and record what became of
	 * it. Only this method may establish identity, and only through object identity,
	 * so a reentrant peer cannot make its own declaration look like the one pi-goal
	 * just handed to Pi.
	 */
	confirmRegistration(name: string): ToolSurvival;
	/** Whether the tool this runtime registered is usable by the model right now. */
	checkAvailability(name: string): ToolAvailability;
	/** Record the schema this runtime handed to Pi for `name`. */
	noteRegistered(name: string, schema: object): void;
}

/**
 * Build the ownership guard over Pi's registry read, its active-loadout read, and this
 * module's own canonical path.
 *
 * The readers are allowed to throw, and the active-loadout reader is allowed to be
 * absent: a host without these seams is an outcome rather than a crash. A host
 * without `getActiveTools` falls back to ownership alone, because that is all it can
 * answer — the fail-closed half (no Continuation naming a tool the model cannot
 * call) then rests on the registry read, which such a host does provide.
 *
 * `selfPath` is this extension's own file, canonicalized by the caller from
 * `import.meta.url`. It is the one piece of identity that never comes from the
 * registry. `undefined` means the host could not resolve it — a synthetic install
 * path — and the path half of the conjunction is then unavailable, so identity falls
 * back to the schema alone. That is a documented weakening rather than a silent one;
 * see `docs/limitations.md`.
 */
export function createToolOwnershipGuard(
	readTools: ToolRegistryReader,
	readActiveTools: ActiveToolReader,
	selfPath: string | undefined,
): ToolOwnershipGuard {
	/** The exact schema object this runtime handed to Pi, per tool name. */
	const schemas = new Map<string, object>();
	/** Canonical paths already resolved, so a comparison costs one syscall at most. */
	const canonicalPaths = new Map<string, string | undefined>();

	const canonicalPath = (path: string | undefined): string | undefined => {
		if (path === undefined || path === "") return undefined;
		const cached = canonicalPaths.get(path);
		if (cached !== undefined) return cached;
		let resolved: string | undefined;
		try {
			resolved = realpathSync(path);
		} catch {
			// Unresolvable: a synthetic host path, or a file that moved since it was
			// loaded. Never treat an unresolvable path as a match.
			resolved = undefined;
		}
		canonicalPaths.set(path, resolved);
		return resolved;
	};

	const read = (): { ok: true; tools: ToolRegistryEntry[] } | { ok: false; reason: string } => {
		try {
			return { ok: true, tools: readTools() };
		} catch (error) {
			return { ok: false, reason: describeError(error) };
		}
	};

	/**
	 * Whether the declaration of `name` now in force is the one this runtime registered.
	 *
	 * A conjunction, because neither half stands alone. The schema object is what this
	 * runtime handed to Pi — but `getAllTools()` publishes every tool's `parameters`
	 * object to every extension, so a peer can copy the reference and satisfy that half
	 * alone. Pi assigns `sourceInfo` from the registering extension's own file, which no
	 * peer can copy, so the declaration must also come from this extension's path. The
	 * per-runtime schema record is checked by the caller, which is what separates this
	 * runtime from another runtime of the same file.
	 */
	const owns = (existing: ToolRegistryEntry, schema: object | undefined): boolean => {
		if (schema === undefined || existing.parameters !== schema) return false;
		// No self path: the host could not resolve this module's own location, so the
		// path half is unavailable and the schema alone answers.
		if (selfPath === undefined) return true;
		return canonicalPath(existing.sourceInfo?.path) === selfPath;
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
			// The name is in force. Whether it is pi-goal's to register is decided by the
			// schema object, which no other extension can present: a name this runtime has
			// never registered is somebody else's, and a name this runtime registered but
			// whose declaration has since been displaced is a takeover.
			const schema = schemas.get(name);
			if (schema === undefined) return { kind: "foreign" };
			return owns(existing, schema) ? { kind: "free" } : { kind: "takeover" };
		},

		confirmRegistration(name: string): ToolSurvival {
			const attempt = read();
			if (!attempt.ok) return { kind: "unreadable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			// pi-goal just registered the name, so a readable registry that does not
			// list it is the session's tool policy hiding it — never a takeover.
			if (existing === undefined) return { kind: "hidden" };
			// Object identity, checked in the same synchronous moment as the
			// registration: a peer that squatted the name reentrantly presents its own
			// schema, so this answers `takeover` rather than believing it.
			return owns(existing, schemas.get(name)) ? { kind: "owned" } : { kind: "takeover" };
		},

		checkAvailability(name: string): ToolAvailability {
			const schema = schemas.get(name);
			if (schema === undefined) return { kind: "unregistered" };
			const attempt = read();
			if (!attempt.ok) return { kind: "unreadable", reason: attempt.reason };
			const existing = attempt.tools.find((tool) => tool.name === name);
			if (existing === undefined) return { kind: "hidden" };
			if (!owns(existing, schema)) return { kind: "takeover" };
			// Ours and in force. The model can still only call it while the session's
			// active loadout declares it: `getAllTools()` keeps every tool a peer
			// removed with `setActiveTools`, so the registry alone would promise a tool
			// the model cannot reach.
			let active: string[] | undefined;
			try {
				active = readActiveTools();
			} catch (error) {
				return { kind: "unreadable", reason: `the active tool loadout could not be read (${describeError(error)})` };
			}
			if (active === undefined) return { kind: "available" };
			return active.includes(name) ? { kind: "available" } : { kind: "inactive" };
		},

		noteRegistered(name: string, schema: object): void {
			schemas.set(name, schema);
		},
	};
}

/** What one registration attempt needs from its caller. */
export interface RegisterOwnedToolOptions {
	guard: ToolOwnershipGuard;
	/** The tool name being registered. */
	name: string;
	/** The exact schema object handed to Pi. It is the tool's identity. */
	schema: object;
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
 * - **takeover** — this runtime registered the name and a different declaration is
 *   the one in force: pi-goal registers nothing and keeps refusing;
 * - **unreadable** — the registry could not be read: pi-goal registers nothing;
 * - **failed** — `registerTool` threw;
 * - **hidden** — the registration landed but the session's tool policy keeps the
 *   tool out of the registry. Silent at startup, because nothing went wrong and
 *   there is nobody to tell; `/goal` explains it instead;
 * - **owned** — the declaration in force is the one this runtime handed to Pi.
 *
 * Everything except **owned** answers `false`, which is the fail-closed direction:
 * the caller then declines to promise the tool rather than naming a tool the model
 * cannot call.
 */
export function registerOwnedTool(options: RegisterOwnedToolOptions): boolean {
	const { guard, name, schema, wording, register, notify } = options;
	const ownership = guard.checkName(name);
	if (ownership.kind === "foreign") {
		notify(notRegisteredWarning(name, FOREIGN_CAUSE, wording, wording.consequence, wording.repairOwner));
		return false;
	}
	if (ownership.kind === "takeover") {
		notify(notInForceWarning(name, TAKEOVER_CAUSE, wording, wording.consequenceDisplaced, wording.repairOwner));
		return false;
	}
	if (ownership.kind === "unreadable") {
		notify(
			notRegisteredWarning(
				name,
				unreadableRegistryCause(ownership.reason),
				wording,
				wording.consequence,
				REPAIR_UNREADABLE,
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
	guard.noteRegistered(name, schema);
	const survival = guard.confirmRegistration(name);
	if (survival.kind === "owned") return true;
	if (survival.kind === "hidden") return false;
	if (survival.kind === "takeover") {
		notify(notInForceWarning(name, TAKEOVER_CAUSE, wording, wording.consequenceDisplaced, wording.repairOwner));
		return false;
	}
	notify(
		notInForceWarning(
			name,
			unconfirmedRegistryCause(survival.reason),
			wording,
			wording.consequenceDisplaced,
			REPAIR_UNREADABLE,
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
