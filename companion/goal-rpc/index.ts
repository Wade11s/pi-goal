/**
 * pi-goal RPC companion — Codex-shaped Goal `get`/`set`/`clear` for host
 * integrations (pi-goal issue #56; bridge request shape revised in #79).
 *
 * ## What this is
 *
 * An **independently installable** Pi extension that gives an external consumer
 * three Codex-shaped methods over pi-goal's *user* command surface:
 *
 * | Method | pi-goal equivalent |
 * | --- | --- |
 * | `thread/goal/get` | bare `/goal` (inspect) |
 * | `thread/goal/set` | `/goal [--budget N\|--no-budget] [--file p] [--image p] <objective>` |
 * | `thread/goal/clear` | `/goal:clear` |
 *
 * It is a thin adapter, not a second lifecycle. Every method is translated into
 * the Goal command family command a user would type and its exact argument text,
 * and executed by pi-goal's own command handler through the documented in-process
 * command bridge (`pi-goal:command-bridge`). The single-Goal creation rule, its
 * refusal against an unfinished Goal (with the silent supersede of a complete one),
 * `goal.enabled` admission, Token-budget and attachment validation, and the
 * durable-before-announced ordering therefore all live in pi-goal, in one place:
 * this package never reads a Goal snapshot, never writes one, never touches a
 * tombstone or a usage checkpoint, and imports nothing from pi-goal.
 *
 * Because the bridge carries Pi's own dispatch shape — a command name plus the
 * text after it — this package holds no copy of pi-goal's parser. An Objective is
 * only ever the argument of `/goal`, so a `set` cannot render a lifecycle
 * command: `get` sends `/goal`, `set` sends `/goal <objective>`, and `clear`
 * sends `/goal:clear`. An Objective that is the bare word `clear` or `pause` is
 * refused by pi-goal's own creation path (the reserved-word guard that corrects
 * the old space-separated spelling), and that refusal comes back through the
 * bridge verbatim: one parser, one source of truth.
 *
 * ## Why it is optional
 *
 * The companion declares no dependency on pi-goal and speaks to it only over a
 * versioned bus protocol. With pi-goal absent (or too old to answer), every
 * method returns the structured `unavailable` error below instead of failing at
 * load time; pi-goal is never a dependency of this package and this package is
 * never a dependency of pi-goal. Installing or removing either one is free.
 *
 * ## Creation authority
 *
 * Every mutating method must declare `"authority": "external-user"`, which is how
 * the embedding host asserts that a real user action (a click, a keystroke, an
 * authenticated RPC call) is behind the request — the same assertion Pi's own RPC
 * `prompt` makes when a user types `/goal`. A request that declares any other
 * authority, or none, is refused without running anything, and `"model"` is
 * called out explicitly: model-driven Goal creation stays in pi-goal's
 * `create_goal` tool, where pi-goal's creation-authority corroboration applies.
 * This package registers **no model-callable tools**, so a model has no path to
 * these methods at all; the declaration is defence in depth, not the only gate.
 * The companion cannot *verify* that a declared user action is genuine — no Pi
 * extension can — and does not claim to; see `docs/behavior/companion.md`.
 *
 * ## Protocol
 *
 * The methods are carried by one Pi extension command, so a host drives them
 * exactly the way it drives any other Pi interaction — an RPC `prompt`, a TUI
 * keystroke, or an extension-dispatched command:
 *
 * ```
 * /goal-rpc {"version":1,"id":"1","method":"thread/goal/set","params":{"objective":"Ship the release notes","budget":40000},"authority":"external-user"}
 * ```
 *
 * The envelope is strict and versioned: `version` must be present and equal to
 * {@link GOAL_RPC_VERSION}, and a request carries only `version`, `id`, `method`,
 * `params`, and `authority`. An unknown version, an unknown top-level field, an
 * unknown parameter, and an unknown method are all `invalid-request` rather than
 * ignored — this is a protocol boundary, not a permissive config reader, and a
 * field the package does not read is a field the caller expected something to
 * read.
 *
 * One response is appended to the session as a `goal-rpc-response` custom entry,
 * which Pi also publishes on its RPC stream as `entry_appended`. The response is
 * the JSON object documented by {@link GoalRpcResponse}; the request `id` is
 * echoed, and `error` is non-null exactly when `ok` is false. The response is
 * written **after** pi-goal has answered, so `ok: true` always describes a
 * commit that already reached the session file.
 *
 * This is intentionally *not* Codex's private in-tree app-server protocol. The
 * method names are Codex-shaped for host familiarity; the envelope, the transport
 * (a Pi extension command), and the payloads are this package's own, and a Codex
 * app-server client cannot talk to it without an adapter. Nothing here claims
 * wire compatibility.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** The extension command that carries every method. */
export const GOAL_RPC_COMMAND = "goal-rpc";

/** Bumps only if this package's request or response envelope changes. */
export const GOAL_RPC_VERSION = 1;

/** The custom session entry type every response is appended as. */
export const GOAL_RPC_RESPONSE_ENTRY = "goal-rpc-response";

/** Channel on Pi's shared extension event bus carrying the bridged command. */
export const GOAL_COMMAND_BRIDGE = "pi-goal:command-bridge";

/** The bridge envelope version this package speaks: version 2 carries a command name plus its argument text. */
export const GOAL_COMMAND_BRIDGE_VERSION = 2;

/**
 * How long to wait for pi-goal to answer one bridged command.
 *
 * Generous, because a `set` can wait for a dialog (the interactive objective
 * editor) or for the session to go idle. A host that wants to fail fast shortens it with
 * `PI_GOAL_RPC_TIMEOUT_MS`; the timeout produces a structured `unavailable`
 * error, never a success.
 */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 120_000;

/** The Codex-shaped methods this companion implements, in canonical order. */
export const GOAL_RPC_METHODS = ["thread/goal/get", "thread/goal/set", "thread/goal/clear"] as const;
export type GoalRpcMethod = (typeof GOAL_RPC_METHODS)[number];

/**
 * Who claims to be behind a mutating request.
 *
 * `external-user` is the assertion the embedding host makes for a genuine user
 * action. `model` exists so a host that (incorrectly) forwards a model-initiated
 * request gets a clear, named refusal pointing at `create_goal` instead of a
 * silent success.
 */
export type GoalRpcAuthority = "external-user" | "model";

/** Machine-readable error codes. No code ever means "maybe it committed". */
export type GoalRpcErrorCode =
	/** The request was not a well-formed request for this package. */
	| "invalid-request"
	/** The request did not declare an authoritative external user action. */
	| "unauthorized"
	/** pi-goal did not answer: not installed, too old, or still busy past the timeout. */
	| "unavailable"
	/**
	 * pi-goal ran the command and refused it (disabled, an unfinished Goal already
	 * set, a reserved-word Objective, rolled back, ...).
	 */
	| "refused"
	/**
	 * pi-goal ran the command, changed nothing, and reported no problem (for example
	 * clearing when no Goal is set, or a cancelled objective editor).
	 */
	| "declined"
	/** pi-goal answered that the named command was not a registered command at dispatch time, so nothing ran. */
	| "invalid-command";

/** The structured outcome of one method call. */
export interface GoalRpcResponse {
	version: typeof GOAL_RPC_VERSION;
	/** The request id, echoed (generated when the request omitted one). */
	id: string;
	method: string;
	/** True only when the requested effect is in place (and, for a mutation, durable). */
	ok: boolean;
	/** The bridge disposition, or `unavailable` when pi-goal never answered. */
	disposition: string;
	/** pi-goal's public Goal projection after the command, passed through verbatim; null when no Goal is current. */
	goal: unknown;
	/** Whether `goal.enabled` admission was on while the command ran; null when unknown. */
	admissionEnabled: boolean | null;
	/** Committed transitions that answer this command, passed through verbatim. */
	transitions: unknown[];
	/** pi-goal's own diagnostics, in order, verbatim. */
	diagnostics: { level: string; text: string }[];
	/** Non-null exactly when `ok` is false. */
	error: { code: GoalRpcErrorCode; message: string } | null;
}

/** A validated request: the method and the parameters it may read. */
interface ParsedGoalRpcRequest {
	id: string;
	method: GoalRpcMethod;
	params: Record<string, unknown>;
	authority: unknown;
}

type ParseOutcome =
	| { ok: true; request: ParsedGoalRpcRequest }
	| { ok: false; id: string; method: string; message: string };

/** The accepted parameter names per method; anything else is a typo, not a hint. */
const ACCEPTED_PARAMS: Record<GoalRpcMethod, ReadonlySet<string>> = {
	"thread/goal/get": new Set(),
	"thread/goal/set": new Set(["objective", "budget", "files", "images"]),
	"thread/goal/clear": new Set(),
};

/**
 * The accepted top-level request fields; anything else is a typo or a protocol
 * from the future, and both are refused rather than ignored.
 *
 * A stricter envelope is the only honest one here: this is a protocol boundary,
 * so a field the package does not read is a field the caller expected *something*
 * to read. Ignoring it would run a request the host did not send while answering
 * `ok: true`, which is exactly the sort of plausible-looking default this package
 * refuses to invent.
 */
const ACCEPTED_FIELDS: ReadonlySet<string> = new Set(["version", "id", "method", "params", "authority"]);

let generatedIds = 0;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The bridge timeout, with the test/operator override; an invalid value keeps the default. */
function bridgeTimeoutMs(): number {
	const raw = process.env.PI_GOAL_RPC_TIMEOUT_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_BRIDGE_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_BRIDGE_TIMEOUT_MS;
}

/**
 * Validate one request envelope.
 *
 * Strict on purpose. The companion is a protocol boundary, so a typo must be a
 * typed error rather than a plausible-looking default: an unknown top-level
 * field, an unknown parameter, an unknown method, a missing or future `version`,
 * or a non-object `params` is refused instead of ignored, because ignoring any of
 * them would silently run a *different* request than the host sent. The version
 * is required — not defaulted — for the same reason: a request that never
 * declared a protocol is not this package's request, and guessing which version
 * it meant is how a compatibility shim becomes a second command surface.
 */
function parseRequest(text: string): ParseOutcome {
	const fallbackId = `goal-rpc-${++generatedIds}`;
	const trimmed = text.trim();
	if (trimmed === "") {
		return {
			ok: false,
			id: fallbackId,
			method: "",
			message:
				`Send one JSON request after /${GOAL_RPC_COMMAND}. Example: ` +
				`/${GOAL_RPC_COMMAND} {"version":${GOAL_RPC_VERSION},"id":"1","method":"thread/goal/get"} ` +
				`(methods: ${GOAL_RPC_METHODS.join(", ")}).`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		return { ok: false, id: fallbackId, method: "", message: `the request is not valid JSON: ${describeError(error)}` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, id: fallbackId, method: "", message: "the request must be a JSON object" };
	}
	const candidate = parsed as Record<string, unknown>;
	const id = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : fallbackId;
	const rawMethod = typeof candidate.method === "string" ? candidate.method : "";
	if (candidate.version !== GOAL_RPC_VERSION) {
		return {
			ok: false,
			id,
			method: rawMethod,
			message:
				candidate.version === undefined
					? `the request must declare "version": ${GOAL_RPC_VERSION}; this one declared none. Re-send it with the version field.`
					: `unsupported request version ${JSON.stringify(candidate.version)}; this companion speaks version ${GOAL_RPC_VERSION}. ` +
						"Upgrade the host or the companion so both speak the same version; nothing was run.",
		};
	}
	for (const name of Object.keys(candidate)) {
		if (ACCEPTED_FIELDS.has(name)) continue;
		return {
			ok: false,
			id,
			method: rawMethod,
			message:
				`unknown top-level field ${JSON.stringify(name)}; a request carries only ${[...ACCEPTED_FIELDS].join(", ")}. ` +
				"Nothing was run: an ignored field could have meant anything.",
		};
	}
	if (!(GOAL_RPC_METHODS as readonly string[]).includes(rawMethod)) {
		return {
			ok: false,
			id,
			method: rawMethod,
			message: `unknown method ${JSON.stringify(candidate.method)}; known methods are ${GOAL_RPC_METHODS.join(", ")}.`,
		};
	}
	const method = rawMethod as GoalRpcMethod;
	if (candidate.params !== undefined && (candidate.params === null || typeof candidate.params !== "object" || Array.isArray(candidate.params))) {
		return { ok: false, id, method, message: "params must be a JSON object when present" };
	}
	const params = (candidate.params ?? {}) as Record<string, unknown>;
	const accepted = ACCEPTED_PARAMS[method];
	for (const name of Object.keys(params)) {
		if (accepted.has(name)) continue;
		const allowed = accepted.size === 0 ? "no parameters" : `only ${[...accepted].join(", ")}`;
		return { ok: false, id, method, message: `unknown parameter ${JSON.stringify(name)}; ${method} accepts ${allowed}.` };
	}
	return { ok: true, request: { id, method, params, authority: candidate.authority } };
}

/** A shell-inert token check: pi-goal's creation option scanner splits on whitespace and has no quoting. */
function hasUnsupportedWhitespace(value: string): boolean {
	return /\s/.test(value);
}

/** The Goal command family commands this package can send: the only three a `get`/`set`/`clear` maps onto. */
export type GoalBridgeCommandName = "goal" | "goal:clear";

/** A bridged command: the command name Pi dispatches on, and the exact text a user would type after it. */
export interface GoalBridgeCommand {
	name: GoalBridgeCommandName;
	args: string;
}

/**
 * Translate one method call into a Goal command family command.
 *
 * The translation is the whole mapping, and it is deliberately shallow: `get`
 * is `/goal`, `clear` is `/goal:clear`, and `set` is `/goal` with exactly the
 * leading options a user would type, in the documented order (`--budget`/
 * `--no-budget`, then `--file`/`--image`, then the objective). Nothing about
 * the objective is interpreted here — a budget below pi-goal's minimum, a path
 * pi-goal will refuse, an oversized objective, or the bare word `clear` (which
 * pi-goal's creation path refuses, naming `/goal:clear`): all of it is validated
 * by pi-goal, so the companion cannot silently disagree with the command surface
 * about what is acceptable.
 */
function buildCommand(
	method: GoalRpcMethod,
	params: Record<string, unknown>,
): { ok: true; command: GoalBridgeCommand } | { ok: false; message: string } {
	if (method === "thread/goal/get") return { ok: true, command: { name: "goal", args: "" } };
	if (method === "thread/goal/clear") return { ok: true, command: { name: "goal:clear", args: "" } };

	const objective = params.objective;
	if (typeof objective !== "string" || objective.trim() === "") {
		return { ok: false, message: "thread/goal/set requires a non-empty string params.objective" };
	}

	const parts: string[] = [];
	if (params.budget === null) {
		parts.push("--no-budget");
	} else if (params.budget !== undefined) {
		if (typeof params.budget !== "number" || !Number.isFinite(params.budget)) {
			return { ok: false, message: "params.budget must be a finite number or null (null means unbounded)" };
		}
		parts.push(`--budget ${params.budget}`);
	}
	for (const [name, flag] of [
		["files", "--file"],
		["images", "--image"],
	] as const) {
		const requested = params[name];
		if (requested === undefined) continue;
		if (!Array.isArray(requested) || requested.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
			return { ok: false, message: `params.${name} must be an array of non-empty strings` };
		}
		for (const entry of requested as string[]) {
			if (hasUnsupportedWhitespace(entry)) {
				return {
					ok: false,
					message:
						`params.${name} entry ${JSON.stringify(entry)} contains whitespace, and pi-goal's command surface has no ` +
						"quoting: the path would be truncated. Move or rename the file so its path has no whitespace.",
				};
			}
			parts.push(`${flag} ${entry}`);
		}
	}
	parts.push(objective.trim());
	return { ok: true, command: { name: "goal", args: parts.join(" ") } };
}

type BridgeCall = { ok: true; result: Record<string, unknown> } | { ok: false; message: string };

/**
 * Ask pi-goal to run one command and wait for its structured answer.
 *
 * The request is fire-and-forget on the bus, so the reply arrives through the
 * callback. A timeout is reported as `unavailable` — the one thing this function
 * must never do is assume the command succeeded because it stopped waiting.
 */
function callBridge(pi: ExtensionAPI, id: string, command: GoalBridgeCommand, timeoutMs: number): Promise<BridgeCall> {
	return new Promise<BridgeCall>((resolve) => {
		let settled = false;
		const settle = (outcome: BridgeCall): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		const timer = setTimeout(() => {
			settle({
				ok: false,
				message:
					`pi-goal did not answer within ${timeoutMs}ms. The pi-goal extension is probably not installed (or predates ` +
					`version ${GOAL_COMMAND_BRIDGE_VERSION} of the ${GOAL_COMMAND_BRIDGE} bridge, added in pi-goal 0.2.0), or ` +
					"another bridged command is still waiting for a confirmation dialog. Install or upgrade pi-goal, then retry.",
			});
		}, timeoutMs);
		// A pending bridge wait must never hold the process open on its own.
		timer.unref?.();
		try {
			pi.events.emit(GOAL_COMMAND_BRIDGE, {
				version: GOAL_COMMAND_BRIDGE_VERSION,
				id,
				name: command.name,
				args: command.args,
				reply: (result: unknown): void => {
					if (result === null || typeof result !== "object") {
						settle({ ok: false, message: "pi-goal answered the bridge request with a non-object result" });
						return;
					}
					const candidate = result as Record<string, unknown>;
					if (candidate.version !== GOAL_COMMAND_BRIDGE_VERSION) {
						settle({
							ok: false,
							message:
								`pi-goal answered with bridge version ${JSON.stringify(candidate.version)}, not ` +
								`${GOAL_COMMAND_BRIDGE_VERSION}. Upgrade pi-goal or this companion so both speak the same version.`,
						});
						return;
					}
					settle({ ok: true, result: candidate });
				},
			});
		} catch (error) {
			settle({ ok: false, message: `the bridge request could not be emitted: ${describeError(error)}` });
		}
	});
}

/** The response for a request that never reached pi-goal. */
function errorResponse(input: {
	id: string;
	method: string;
	code: GoalRpcErrorCode;
	message: string;
}): GoalRpcResponse {
	return {
		version: GOAL_RPC_VERSION,
		id: input.id,
		method: input.method,
		ok: false,
		disposition: input.code,
		goal: null,
		admissionEnabled: null,
		transitions: [],
		diagnostics: [],
		error: { code: input.code, message: input.message },
	};
}

const KNOWN_DISPOSITIONS = new Set(["committed", "reported", "declined", "refused", "invalid"]);

/** Map one bridge answer into this package's response envelope. */
function responseFromBridge(input: { id: string; method: string; result: Record<string, unknown> }): GoalRpcResponse {
	const { result } = input;
	const disposition = typeof result.disposition === "string" && KNOWN_DISPOSITIONS.has(result.disposition)
		? result.disposition
		: "refused";
	const ok = result.ok === true && (disposition === "committed" || disposition === "reported");
	const diagnostics = Array.isArray(result.diagnostics)
		? result.diagnostics
				.filter((entry): entry is { level: string; text: string } => entry !== null && typeof entry === "object")
				.map((entry) => ({
					level: typeof entry.level === "string" ? entry.level : "info",
					text: typeof entry.text === "string" ? entry.text : String(entry.text ?? ""),
				}))
		: [];
	const code: GoalRpcErrorCode =
		disposition === "declined" ? "declined" : disposition === "invalid" ? "invalid-command" : "refused";
	const reason = diagnostics.length > 0 ? diagnostics.map((entry) => entry.text).join(" ") : "pi-goal did not report a reason.";
	return {
		version: GOAL_RPC_VERSION,
		id: input.id,
		method: input.method,
		ok,
		disposition,
		goal: result.goal ?? null,
		admissionEnabled: typeof result.admissionEnabled === "boolean" ? result.admissionEnabled : null,
		transitions: Array.isArray(result.transitions) ? result.transitions : [],
		diagnostics,
		error: ok ? null : { code, message: reason },
	};
}

/** One short human line; the machine-readable answer is the appended entry. */
function summarize(response: GoalRpcResponse): string {
	const prefix = `${response.method || "request"}${response.ok ? "" : ` ${response.error?.code ?? "refused"}`}`;
	if (response.ok) return `goal-rpc ${prefix}: ${response.disposition}`;
	const detail = response.error?.message ?? "no reason reported";
	const clipped = detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
	return `goal-rpc ${prefix}: ${clipped}`;
}

/**
 * The mutating methods require the host to assert an authoritative external user
 * action. `get` is a read and needs no assertion.
 */
function authorityRefusal(request: ParsedGoalRpcRequest): string | null {
	if (request.method === "thread/goal/get") return null;
	if (request.authority === "external-user") return null;
	if (request.authority === "model") {
		return (
			`${request.method} refused: this request declared model authority, and pi-goal's Goal creation authority belongs ` +
			"to an explicit user or system request, never to a model-initiated call. Model-driven Goal creation goes through " +
			"pi-goal's create_goal tool, which corroborates a verbatim quotation of the user's request; the companion will not " +
			"launder that into a user command. Ask the user to act, or let the model call create_goal."
		);
	}
	return (
		`${request.method} refused: the request did not declare "authority":"external-user". A mutating method needs the ` +
		"embedding host to assert that a real user action is behind it (a click, a keystroke, an authenticated RPC call). " +
		"pi-goal never creates, replaces, or clears a Goal on a model's or an unrelated extension's initiative."
	);
}

export default function goalRpcCompanion(pi: ExtensionAPI): void {
	/**
	 * Drive one method call end to end and answer with the appended entry.
	 *
	 * Ordering is deliberate: pi-goal answers first (so a commit is already on
	 * disk), then the response is appended, then a one-line notification tells a
	 * human what happened. A refused, declined, unavailable, or unauthorized call
	 * answers with `ok: false` and exactly the same shape, so a host never has to
	 * distinguish "no Goal" from "the call did not run".
	 */
	async function runRequest(text: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseRequest(text);
		let response: GoalRpcResponse;
		if (!parsed.ok) {
			response = errorResponse({ id: parsed.id, method: parsed.method, code: "invalid-request", message: parsed.message });
		} else {
			const request = parsed.request;
			const unauthorized = authorityRefusal(request);
			if (unauthorized !== null) {
				response = errorResponse({ id: request.id, method: request.method, code: "unauthorized", message: unauthorized });
			} else {
				const built = buildCommand(request.method, request.params);
				if (!built.ok) {
					response = errorResponse({
						id: request.id,
						method: request.method,
						code: "invalid-request",
						message: built.message,
					});
				} else {
					const call = await callBridge(pi, request.id, built.command, bridgeTimeoutMs());
					response = call.ok
						? responseFromBridge({ id: request.id, method: request.method, result: call.result })
						: errorResponse({ id: request.id, method: request.method, code: "unavailable", message: call.message });
				}
			}
		}
		try {
			pi.appendEntry(GOAL_RPC_RESPONSE_ENTRY, response);
		} catch (error) {
			// The structured answer is the appended entry; if it cannot be written, the
			// host has no machine-readable outcome, so say exactly that instead of
			// letting a notification pass for one. The command surface has no second
			// channel, and inventing a success here is the one thing that is never
			// allowed.
			ctx.ui.notify(
				`goal-rpc ${response.method || "request"}: pi-goal reported ${response.disposition}, but the structured ` +
					`response entry could not be appended (${describeError(error)}). Treat this call as unconfirmed and inspect ` +
					"the Goal with /goal before retrying.",
				"error",
			);
			return;
		}
		ctx.ui.notify(
			summarize(response),
			response.ok ? "info" : response.error?.code === "declined" ? "info" : "warning",
		);
	}

	pi.registerCommand(GOAL_RPC_COMMAND, {
		description:
			"Goal get/set/clear for host integrations: " +
			`/${GOAL_RPC_COMMAND} {"method":"thread/goal/get|set|clear",...} (requires the optional pi-goal extension)`,
		handler: runRequest,
	});
}
