/**
 * Opt-in session naming from the Objective (issue #52).
 *
 * Pi owns the session name. It is a `session_info` entry in the session file that
 * the session selector and the interactive footer read, and its only public seams
 * are `pi.getSessionName()` and `pi.setSessionName(name)`. pi-goal therefore never
 * keeps a name of its own and never writes one into a Goal snapshot: a name is
 * host metadata about the *session*, not Goal state, so it is not reconstructed
 * from a branch, is not part of the Lifecycle, and is not part of any event
 * payload.
 *
 * The convenience is opt-in (`goal.sessionNameFromObjective`, default false) and
 * one-shot in effect. A name is written only after a Goal has been created
 * durably *and* only when the session still has no name, so:
 *
 * - a name the user typed (or that an earlier Goal wrote) is never overwritten;
 * - an Objective edit and a Replacement Goal never rename anything, because
 *   neither is a fresh creation of the session's first Goal;
 * - a creation that failed, was refused, or was rolled back never names anything,
 *   because the write happens after the durable commit it is allowed to describe.
 *
 * Nothing here touches Goal creation authority, the Lifecycle, accounting, or the
 * event stream. The name is a best-effort host write, so a failure to name is
 * reported as a warning and can never be mistaken for a failed creation.
 *
 * The name is derived from the Objective text and from nothing else. Attachments
 * are supporting material with their own trust boundary and lifetime, so their
 * contents never contribute to a name; the derivation takes a single string and
 * has no attachment input at all, which is what keeps that rule true by
 * construction rather than by a filter that a future caller could forget.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Longest session name pi-goal will set from an Objective. */
export const MAX_SESSION_NAME_LENGTH = 80;

/**
 * Extension-level session-naming configuration, read from Pi's effective settings
 * at every session start, exactly like the admission and budget settings.
 */
export interface SessionNamingSettings {
	/** Whether a successful creation may name an unnamed session. Defaults to false. */
	nameFromObjective: boolean;
	/** Human-readable configuration problems, reported once per session. */
	problems: string[];
}

/** The two Pi seams this module needs, so a test can supply them without a session. */
export type SessionNameSurface = {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
};

/**
 * What one naming attempt did.
 *
 * `off` is the default: nothing was even read. `already-named` is the rule doing
 * its job — the session had a name, so it was left alone. `empty` means the
 * Objective yielded no usable text, which cannot happen for a validated Objective
 * (validation trims it) and is reported rather than guessed at. `failed` is a host
 * write failure: the Goal stands, the name does not.
 */
export type SessionNamingOutcome =
	| { kind: "off" }
	| { kind: "already-named"; name: string }
	| { kind: "empty" }
	| { kind: "named"; name: string }
	| { kind: "failed"; reason: string };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readNamingValue(value: unknown): boolean | undefined | "invalid" {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") return "invalid";
	return value;
}

/**
 * Read the `goal.sessionNameFromObjective` opt-in from Pi's effective settings.
 *
 * The default is `false`, so a session that never configured the setting keeps the
 * pre-existing behavior: pi-goal never touches the session name. A non-boolean
 * value is dropped and reported rather than silently coerced, which is the same
 * fail-loud-but-harmless shape the admission and budget settings use — guessing at
 * `"false"` or `1` would rename sessions the user never asked to have renamed.
 */
export function parseSessionNamingSettings(settings: unknown): SessionNamingSettings {
	const goal = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).goal : undefined) as
		| Record<string, unknown>
		| undefined;
	const raw = readNamingValue(goal?.sessionNameFromObjective);
	if (raw === "invalid") {
		return {
			nameFromObjective: false,
			problems: [
				"pi-goal: goal.sessionNameFromObjective must be a boolean (true or false); ignoring it and leaving " +
					"the session name alone.",
			],
		};
	}
	return { nameFromObjective: raw ?? false, problems: [] };
}

/**
 * Derive a session name from an Objective: its **first line**, whitespace-collapsed,
 * capped at {@link MAX_SESSION_NAME_LENGTH} code points.
 *
 * The first line is taken before anything is collapsed, so a multi-line Objective
 * contributes only its opening line and never a run-on of every line it has. The
 * cap is a hard truncation with no ellipsis: a session name is a label in a
 * selector, so a predictable width matters more than signalling that text was
 * dropped, and the Objective itself remains the authoritative text.
 *
 * The cap counts *code points*, not UTF-16 code units, because a name is persisted
 * verbatim into the session file: slicing code units could cut a surrogate pair in
 * half and store a lone surrogate, and it would also hold astral-heavy text to half
 * the intended width. `Array.from` iterates code points, so a truncation can never
 * land inside a pair.
 *
 * The input is the Objective alone. Attachment contents are not a parameter, so
 * they cannot reach a name.
 */
export function deriveSessionName(objective: string): string {
	const firstLine = objective.split(/\r\n|\r|\n/, 1)[0] ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	const codePoints = Array.from(collapsed);
	return codePoints.length > MAX_SESSION_NAME_LENGTH
		? codePoints.slice(0, MAX_SESSION_NAME_LENGTH).join("").trimEnd()
		: collapsed;
}

/**
 * Name the session from a freshly created Goal's Objective, when the user opted in
 * and the session has no name yet.
 *
 * The order is deliberate: the setting is checked first (an opted-out session is
 * not even read), then the existing name, then the derivation, and only then the
 * write. Every early return leaves the session name exactly as it was, which is
 * what makes "never overwrite a user-provided name" a property of the code path
 * rather than of a caller's discipline.
 *
 * `enabled` is passed in rather than read from module state so the decision stays
 * a pure function of its arguments and is unit-testable without a session.
 */
export function applySessionNameFromObjective(
	session: SessionNameSurface,
	objective: string,
	enabled: boolean,
): SessionNamingOutcome {
	if (!enabled) return { kind: "off" };
	let current: string | undefined;
	try {
		current = session.getSessionName();
	} catch (error) {
		return { kind: "failed", reason: describeError(error) };
	}
	// A name that exists is a name the user (or an earlier Goal) chose. Pi reports
	// an empty name as absent, and the trim keeps a whitespace-only name from
	// reading as a real one.
	const existing = current?.trim();
	if (existing) return { kind: "already-named", name: existing };
	const name = deriveSessionName(objective);
	if (name === "") return { kind: "empty" };
	try {
		session.setSessionName(name);
	} catch (error) {
		return { kind: "failed", reason: describeError(error) };
	}
	return { kind: "named", name };
}

/** Pi's session-name seams, which is all of `ExtensionAPI` this module touches. */
export function sessionNameSurface(pi: ExtensionAPI): SessionNameSurface {
	return {
		getSessionName: () => pi.getSessionName(),
		setSessionName: (name: string) => pi.setSessionName(name),
	};
}
