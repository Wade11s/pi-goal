/**
 * Issue #56: the optional Codex-shaped Goal RPC companion (`companion/goal-rpc`).
 *
 * Everything here goes through the companion's own public protocol — one
 * `/goal-rpc <json>` extension command sent as an ordinary RPC prompt, answered by
 * a `goal-rpc-response` entry that Pi publishes as `entry_appended` — and asserts
 * only externally visible behavior: the structured response, pi-goal's own
 * notifications, the durable `goal-state` entries, and the session's run count.
 *
 * The proving rule for every refusal is the same: the response says `ok: false`
 * with a named error code, **and** the Goal's durable bytes are unchanged. The
 * companion appends its own responses to the same session, so "unchanged" is
 * asserted over the raw `goal-state` lines rather than the whole file — a Goal
 * snapshot or tombstone that was written, rewritten, or retracted would show up
 * there, while the adapter's own response entries would not.
 *
 * Three Pi behaviors shape the scenarios, and each is the contract a real host
 * depends on:
 *
 * - an extension command's RPC `prompt` response arrives after the handler runs,
 *   so a method that waits for a confirmation dialog is submitted without
 *   awaiting its prompt response and the dialog is answered first;
 * - a reply is the appended entry, so a host correlates on the request id;
 * - the scripted provider's `waitForFile` gate holds a run open deterministically,
 *   which is how "get while an unfinished Goal is active" is asserted without a
 *   sleep.
 *
 * The suite never needs credentials or a network: the scripted provider answers
 * every model request, and the only external command is the installed Pi binary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	goalSnapshots,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";

const COMPANION = join(import.meta.dirname, "..", "companion", "goal-rpc");
const RESPONSE_ENTRY = "goal-rpc-response";
/** The request envelope version the companion requires. */
const REQUEST_VERSION = 1;
const OBJECTIVE = "Ship the release notes page";
const REPLACEMENT = "Ship the migration guide instead";

/** Every response entry appended so far, parsed from the session branch. */
async function responses(session) {
	const file = await session.sessionFile();
	if (!existsSync(file)) return [];
	return readSessionEntries(file)
		.filter((entry) => entry.type === "custom" && entry.customType === RESPONSE_ENTRY)
		.map((entry) => entry.data);
}

/** The raw durable Goal bytes: every `goal-state` line, exactly as written. */
async function goalBytes(session) {
	const file = await session.sessionFile();
	if (!existsSync(file)) return "";
	const text = readFileSync(file, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "" && line.includes('"goal-state"'))
		.join("\n");
}

/** Wait for the companion's response for one request id. */
async function waitForResponse(session, id) {
	return session.waitFor(`goal-rpc response ${id}`, (records) => {
		for (const record of records) {
			if (record.type !== "entry_appended") continue;
			const entry = record.entry;
			if (entry?.customType === RESPONSE_ENTRY && entry.data?.id === id) return entry.data;
		}
		return undefined;
	});
}

/**
 * Wait until the branch carries a finalized superseded record for a replaced
 * identity. The freeze happens at the next durable boundary, not at the
 * replacement commit, so the test waits for the record instead of assuming it.
 */
async function waitForSuperseded(session, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const file = await session.sessionFile();
		if (existsSync(file)) {
			const entries = readSessionEntries(file).filter(
				(entry) => entry.type === "custom" && entry.customType === "goal-state" && entry.data?.superseded === true,
			);
			if (entries.length > 0) return entries;
		}
		if (Date.now() > deadline) throw new Error("timed out waiting for the superseded Goal record");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Send one method call without waiting for either answer.
 *
 * Both are returned because the two arrive in different orders depending on the
 * method: a plain `get` answers its prompt only after the handler finishes, while
 * a `set` that opens a confirmation dialog blocks that prompt response until the
 * host answers the dialog.
 */
function submit(session, id, method, params, authority) {
	const request = { version: REQUEST_VERSION, id, method };
	if (params !== undefined) request.params = params;
	if (authority !== undefined) request.authority = authority;
	const promptId = `goal-rpc-${id}`;
	const accepted = session.waitFor(`prompt response ${promptId}`, (records) =>
		records.find((record) => record.type === "response" && record.id === promptId),
	);
	session.writeCommand({ id: promptId, type: "prompt", message: `/goal-rpc ${JSON.stringify(request)}` });
	return { accepted, response: waitForResponse(session, id) };
}

/**
 * Submit one arbitrary request object, including envelopes the helper would never
 * build (a missing or future `version`, an unknown top-level field).
 */
function submitRaw(session, id, request) {
	const promptId = `goal-rpc-raw-${id}`;
	const accepted = session.waitFor(`prompt response ${promptId}`, (records) =>
		records.find((record) => record.type === "response" && record.id === promptId),
	);
	session.writeCommand({ id: promptId, type: "prompt", message: `/goal-rpc ${JSON.stringify(request)}` });
	return { accepted, response: waitForResponse(session, id) };
}

/** Submit one method call that needs no dialog, and return its structured response. */
async function call(session, id, method, params, authority) {
	const { accepted, response } = submit(session, id, method, params, authority);
	const prompt = await accepted;
	assert.equal(prompt.success, true, `the request was rejected: ${JSON.stringify(prompt)}`);
	assert.equal(prompt.data.disposition, "handled", "an extension command handles the prompt instead of starting a run");
	return response;
}

/** Submit one raw request object and return its structured response. */
async function callRaw(session, id, request) {
	const { accepted, response } = submitRaw(session, id, request);
	const prompt = await accepted;
	assert.equal(prompt.success, true, `the request was rejected: ${JSON.stringify(prompt)}`);
	assert.equal(prompt.data.disposition, "handled", "an extension command handles the prompt instead of starting a run");
	return response;
}

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-goal-rpc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("get, set, and clear round-trip through the companion's public protocol", async (t) => {
	const dir = tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());
	// Hold the kickoff run open so "get while active" is asserted without a sleep,
	// then let it complete the Goal through the ordinary completion audit.
	const gate = join(dir, "release-kickoff");
	script(
		[
			{ waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Reported the accounted tokens and elapsed time." },
		],
		session,
	);

	// get: no Goal yet. A read reports, and needs no commit to prove it.
	const empty = await call(session, "get-1", "thread/goal/get");
	assert.equal(empty.ok, true);
	assert.equal(empty.disposition, "reported");
	assert.equal(empty.goal, null);
	assert.equal(empty.admissionEnabled, true);
	assert.equal(empty.error, null);

	// set: the same leading options a user would type, executed by /goal.
	const created = await call(
		session,
		"set-1",
		"thread/goal/set",
		{ objective: OBJECTIVE, budget: 40000 },
		"external-user",
	);
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.equal(created.disposition, "committed");
	assert.deepEqual(
		created.transitions.map((transition) => transition.kind),
		["created"],
	);
	assert.equal(created.goal.objective, OBJECTIVE);
	assert.equal(created.goal.status, "active");
	assert.equal(created.goal.tokenBudget, 40000);
	assert.equal(created.goal.origin, "command", "a bridged set is the user goal-creation path, not create_goal");

	// The response is written after the commit, so the Goal is already durable.
	const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
	assert.equal(snapshot.data.goal.id, created.goal.id);
	assert.equal(snapshot.data.goal.tokenBudget, 40000);
	assert.equal(snapshot.data.goal.origin, "command");

	// get again, while the Goal is still unfinished and its kickoff run is in flight.
	const found = await call(session, "get-2", "thread/goal/get");
	assert.equal(found.ok, true);
	assert.equal(found.goal.id, created.goal.id);
	assert.equal(found.goal.status, "active");
	assert.equal(found.goal.objective, OBJECTIVE);

	writeFileSync(gate, "release\n");
	await waitForSnapshot(
		session,
		(snapshot) => snapshot.data.goal?.status === "complete",
		"the Goal to complete through its continuation",
	);

	// clear: the durable tombstone, reported as committed with no current Goal.
	const cleared = await call(session, "clear-1", "thread/goal/clear", undefined, "external-user");
	assert.equal(cleared.ok, true, JSON.stringify(cleared));
	assert.equal(cleared.disposition, "committed");
	assert.deepEqual(
		cleared.transitions.map((transition) => transition.kind),
		["cleared"],
	);
	assert.equal(cleared.goal, null);
	const entries = readSessionEntries(await session.sessionFile());
	assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone is the newest durable Goal entry");

	const afterClear = await call(session, "get-3", "thread/goal/get");
	assert.equal(afterClear.ok, true);
	assert.equal(afterClear.goal, null);

	// The protocol is the only surface, and every answer is one entry in order.
	assert.deepEqual(
		(await responses(session)).map((response) => response.id),
		["get-1", "set-1", "get-2", "clear-1", "get-3"],
	);
	assertStepsConsumed(session, 3);
	assertCleanRun(session);
});

test("set against an unfinished Goal surfaces the replacement decision", async (t) => {
	const dir = tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());
	const gate = join(dir, "release-kickoff");
	script(
		[
			{ waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "The completion attempt was refused; reporting that." },
			{ hang: true },
		],
		session,
	);

	const first = await call(session, "set-first", "thread/goal/set", { objective: OBJECTIVE, budget: null }, "external-user");
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.equal(first.goal.tokenBudget, null, "a null budget is the explicit unbounded request");
	const before = await goalBytes(session);
	const beforeIds = goalSnapshots(readSessionEntries(await session.sessionFile())).length;

	// Declining is a decision, not a failure of the Goal: nothing changes, and the
	// response names the decision instead of claiming a replacement happened.
	const decline = submit(session, "set-declined", "thread/goal/set", { objective: REPLACEMENT }, "external-user");
	await session.respondToConfirm((request) => request.title.includes("Replace the current Goal"), false);
	const declined = await decline.response;
	assert.equal(declined.ok, false);
	assert.equal(declined.disposition, "declined");
	assert.equal(declined.error.code, "declined");
	assert.deepEqual(declined.transitions, []);
	assert.equal(declined.goal.id, first.goal.id, "the current Goal is still the first one");
	assert.match(declined.error.message, /Replacement cancelled/);
	assert.equal(await goalBytes(session), before, "a declined replacement writes no Goal bytes");
	assert.equal(goalSnapshots(readSessionEntries(await session.sessionFile())).length, beforeIds);

	// Accepting replaces the Goal: new identity, and the old one is kept as a
	// superseded historical record rather than rewritten.
	const replace = submit(session, "set-accepted", "thread/goal/set", { objective: REPLACEMENT }, "external-user");
	await session.respondToConfirm((request) => request.title.includes("Replace the current Goal"), true);
	const replaced = await replace.response;
	assert.equal(replaced.ok, true, JSON.stringify(replaced));
	assert.equal(replaced.disposition, "committed");
	assert.deepEqual(
		replaced.transitions.map((transition) => transition.kind),
		["replaced"],
	);
	assert.notEqual(replaced.goal.id, first.goal.id, "a Replacement Goal is a new identity");
	assert.equal(replaced.goal.objective, REPLACEMENT);
	assert.equal(replaced.goal.usage.totalTokens, 0, "the replacement starts with no Goal-owned usage");
	// Release the held kickoff. The run that was admitted for the replaced identity
	// is still bound to it, so its `update_goal complete` is refused as stale rather
	// than completing a Goal it was never prepared for — the execution binding (#37)
	// survives the adapter unchanged.
	writeFileSync(gate, "release\n");
	const stale = await session.waitForToolResult("update_goal", 1);
	assert.equal(stale.isError, true);
	assert.match(String(stale.result.content[0].text), /prepared against a Goal state that has since changed/);
	assert.ok(
		String(stale.result.content[0].text).includes(first.goal.id),
		"the refusal names the Goal identity the run was bound to",
	);

	// The freeze boundary that finalizes the replaced identity's in-flight tail is
	// the delivery of the next message (here the replacement's steered kickoff), so
	// its superseded history record lands at that boundary, not at the commit.
	const superseded = await waitForSuperseded(session);
	assert.equal(superseded.length, 1, "the replaced Goal identity is preserved as history");
	assert.equal(superseded[0].data.goal.id, first.goal.id);

	// The replacement is still the current Goal and was not touched by the stale call.
	const afterStale = await call(session, "get-after-stale", "thread/goal/get");
	assert.equal(afterStale.ok, true);
	assert.equal(afterStale.goal.id, replaced.goal.id);
	assert.equal(afterStale.goal.status, "active");
	assertCleanRun(session);
});

test("a disabled extension refuses set and never rewrites an existing Goal", async (t) => {
	tempDir(t);
	const session = await PiRpcSession.start({
		extraExtensions: [COMPANION],
		settings: { goal: { enabled: false } },
	});
	t.after(() => session.stop());

	const state = await call(session, "get-disabled", "thread/goal/get");
	assert.equal(state.ok, true, "inspection stays available while disabled");
	assert.equal(state.admissionEnabled, false);
	assert.equal(state.goal, null);

	const refused = await call(session, "set-disabled", "thread/goal/set", { objective: OBJECTIVE }, "external-user");
	assert.equal(refused.ok, false);
	assert.equal(refused.disposition, "refused");
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /disabled/);
	assert.deepEqual(refused.transitions, []);
	assert.equal(refused.goal, null);
	assert.equal(await goalBytes(session), "", "a disabled creation writes no Goal bytes");
	assert.equal(runCount(session), 0, "no provider run was started");

	// Clearing while nothing is set changes nothing and does not claim success.
	const clear = await call(session, "clear-disabled", "thread/goal/clear", undefined, "external-user");
	assert.equal(clear.ok, false);
	assert.equal(clear.disposition, "declined");
	assert.equal(clear.error.code, "declined");
	assert.equal(await goalBytes(session), "");
	assertCleanRun(session);
});

test("invalid budgets are refused by pi-goal's own budget rules", async (t) => {
	tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());

	// Below pi-goal's minimum: refused by the command surface, not re-implemented
	// here, so the companion cannot silently disagree with `/goal --budget 0`.
	const tooSmall = await call(session, "set-small", "thread/goal/set", { objective: OBJECTIVE, budget: 0 }, "external-user");
	assert.equal(tooSmall.ok, false);
	assert.equal(tooSmall.disposition, "refused");
	assert.match(tooSmall.error.message, /budget/i);
	assert.equal(await goalBytes(session), "");
	assert.equal(runCount(session), 0);

	// A negative budget and a fractional one are refused by the same whole-number
	// rule pi-goal applies to `/goal --budget`.
	for (const [id, budget] of [
		["set-negative", -5],
		["set-fractional", 1.5],
	]) {
		const invalid = await call(session, id, "thread/goal/set", { objective: OBJECTIVE, budget }, "external-user");
		assert.equal(invalid.ok, false, `${budget} must be refused`);
		assert.equal(invalid.disposition, "refused");
		assert.match(invalid.error.message, /whole number/i);
		assert.equal(await goalBytes(session), "");
	}

	// A non-numeric budget cannot even be rendered into command text.
	const notNumber = await call(
		session,
		"set-text-budget",
		"thread/goal/set",
		{ objective: OBJECTIVE, budget: "lots" },
		"external-user",
	);
	assert.equal(notNumber.ok, false);
	assert.equal(notNumber.error.code, "invalid-request");
	assert.match(notNumber.error.message, /params\.budget must be a finite number or null/);
	assert.equal(await goalBytes(session), "");

	// The same command surface still accepts a valid budget afterwards: the
	// refusals did not poison anything.
	script([{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] }, { text: "Done." }], session);
	const valid = await call(session, "set-valid", "thread/goal/set", { objective: OBJECTIVE, budget: 40000 }, "external-user");
	assert.equal(valid.ok, true, JSON.stringify(valid));
	assert.equal(valid.goal.tokenBudget, 40000);
	await waitForSnapshot(
		session,
		(snapshot) => snapshot.data.goal?.status === "complete",
		"the valid Goal to complete",
	);
	assertStepsConsumed(session, 2);
	assertCleanRun(session);
});

test("set carries explicit local attachments through to the command surface", async (t) => {
	const dir = tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());
	const notes = join(dir, "notes.md");
	writeFileSync(notes, "# Release notes\n\nCover the migration.\n");
	script([{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] }, { text: "Done." }], session);

	const created = await call(
		session,
		"set-file",
		"thread/goal/set",
		{ objective: OBJECTIVE, files: [notes] },
		"external-user",
	);
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.deepEqual(
		created.goal.attachments.map((attachment) => [attachment.mediaType, attachment.label]),
		[["text/plain", "notes.md"]],
		"the attachment reached pi-goal's own materialization",
	);
	assert.match(created.goal.attachments[0].hash, /^[0-9a-f]{64}$/);
	await waitForSnapshot(
		session,
		(snapshot) => snapshot.data.goal?.status === "complete",
		"the Goal to complete",
	);
	assertStepsConsumed(session, 2);
	assertCleanRun(session);

	// A path with whitespace cannot be rendered into the command surface (it has no
	// quoting), so it is a stated refusal rather than a truncated path.
	await call(session, "clear-file", "thread/goal/clear", undefined, "external-user");
	const spaced = join(dir, "with space.md");
	writeFileSync(spaced, "x");
	const before = await goalBytes(session);
	const refused = await call(session, "set-spaced", "thread/goal/set", { objective: OBJECTIVE, files: [spaced] }, "external-user");
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "invalid-request");
	assert.match(refused.error.message, /contains whitespace/);
	assert.equal(await goalBytes(session), before, "a refused attachment request writes no Goal bytes");
	assertCleanRun(session);
});

test("creation authority: model-originated set is refused and unreachable", async (t) => {
	tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());

	// Declared model authority is named and refused: model-driven creation stays in
	// `create_goal`, where pi-goal corroborates the user's request verbatim.
	const asModel = await call(session, "set-model", "thread/goal/set", { objective: OBJECTIVE }, "model");
	assert.equal(asModel.ok, false);
	assert.equal(asModel.error.code, "unauthorized");
	assert.match(asModel.error.message, /create_goal/);
	assert.equal(await goalBytes(session), "");

	// A mutating call with no declared user action fails closed too.
	const noAuthority = await call(session, "set-no-authority", "thread/goal/set", { objective: OBJECTIVE });
	assert.equal(noAuthority.ok, false);
	assert.equal(noAuthority.error.code, "unauthorized");
	assert.match(noAuthority.error.message, /external-user/);
	assert.equal(await goalBytes(session), "");

	// The companion registers no model-callable tool, so a model has no path to
	// these methods, and pi-goal's own creation authority is untouched.
	script(
		[
			{ toolCalls: [{ name: "goal_set", args: { objective: OBJECTIVE } }] },
			{ toolCalls: [{ name: "create_goal", args: { objective: "Escaped model Goal" } }] },
			{ text: "Neither path created a Goal." },
		],
		session,
	);
	await session.prompt("Please create a Goal for the escaped objective");
	await session.waitForToolResult("create_goal", 1);
	await session.waitForSettled(1);

	const ends = session.records.filter((record) => record.type === "tool_execution_end");
	assert.deepEqual(
		ends.map((record) => record.toolName),
		["goal_set", "create_goal"],
		"both model-side attempts reached the refusal boundary",
	);
	for (const end of ends) {
		assert.equal(end.isError, true, `${end.toolName} must be refused`);
	}
	assert.match(ends[0].result.content[0].text, /not found/i, "the companion exposes no model tool");
	assert.match(ends[1].result.content[0].text, /Goal not created/, "create_goal still requires its authority quote");
	assert.equal(await goalBytes(session), "", "no model-originated path created a Goal");
	assertStepsConsumed(session, 3);
	assertCleanRun(session);
});

test("the companion works without pi-goal and reports it as unavailable", async (t) => {
	tempDir(t);
	// Load only the companion: no pi-goal package, no bridge listener, no crash.
	const session = await PiRpcSession.start({
		extraExtensions: [COMPANION],
		loadPiGoal: false,
		env: { PI_GOAL_RPC_TIMEOUT_MS: "400" },
	});
	t.after(() => session.stop());

	const unavailable = await call(session, "get-orphan", "thread/goal/get");
	assert.equal(unavailable.ok, false);
	assert.equal(unavailable.disposition, "unavailable");
	assert.equal(unavailable.error.code, "unavailable");
	assert.match(unavailable.error.message, /pi-goal/);
	assert.equal(unavailable.goal, null);
	assert.equal(unavailable.admissionEnabled, null);

	// The refusal is structured, and the extension is still loaded and healthy.
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	const setOrphan = await call(session, "set-orphan", "thread/goal/set", { objective: OBJECTIVE }, "external-user");
	assert.equal(setOrphan.ok, false);
	assert.equal(setOrphan.error.code, "unavailable");

	// Envelope validation happens before the bridge, so a typo is a typed error
	// even with no pi-goal to ask.
	const unknownParam = await call(session, "get-typo", "thread/goal/get", { verbose: true });
	assert.equal(unknownParam.ok, false);
	assert.equal(unknownParam.error.code, "invalid-request");
	assert.match(unknownParam.error.message, /unknown parameter/);

	// A request that is not JSON at all still gets one structured answer: the
	// companion generates the correlation id and names the problem.
	const seen = (await responses(session)).length;
	await session.prompt("/goal-rpc this is not json");
	const malformed = await session.waitFor("a structured invalid-request answer", (records) => {
		const answered = records.filter(
			(record) => record.type === "entry_appended" && record.entry?.customType === RESPONSE_ENTRY,
		);
		return answered.length > seen ? answered.at(-1).entry.data : undefined;
	});
	assert.equal(malformed.ok, false);
	assert.equal(malformed.error.code, "invalid-request");
	assert.match(malformed.error.message, /not valid JSON/);
	assert.equal(malformed.method, "");
	assertStepsConsumed(session, 0);
});

test("a reserved-word Objective is refused by pi-goal itself, verbatim, and an Objective that begins with a verb word is created", async (t) => {
	tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());
	// The base Goal that must survive every refusal below, then one completion for
	// each of the four Objectives that are created afterwards.
	const completions = 5;
	script(
		Array.from({ length: completions }, () => [
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		]).flat(),
		session,
	);

	const created = await call(session, "set-base", "thread/goal/set", { objective: OBJECTIVE }, "external-user");
	assert.equal(created.ok, true, JSON.stringify(created));
	await waitForSnapshot(
		session,
		(snapshot) => snapshot.data.goal?.status === "complete",
		"the base Goal to complete",
	);
	// `set` sends `/goal <objective>`. The bare verb words are the old
	// space-separated spelling of the Goal command family, and pi-goal's own
	// creation path refuses them with the command to type instead — the companion
	// holds no parser of its own any more. Each refusal is therefore pi-goal's,
	// forwarded verbatim under the `refused` code, never the companion's own
	// `invalid-request`.
	const before = await goalBytes(session);
	const beforeSnapshots = goalSnapshots(readSessionEntries(await session.sessionFile())).length;
	const reserved = [
		["set-clear-word", "clear", "Goal not created: `clear` is a Goal command; use /goal:clear."],
		["set-pause-word", "pause", "Goal not created: `pause` is a Goal command; use /goal:pause."],
		["set-history-word", "history", "Goal not created: `history` is a Goal command; use /goal:history."],
		["set-resume-word", "resume", "Goal not created: `resume` is a Goal command; use /goal:resume."],
		["set-edit-word", "edit", "Goal not created: `edit` is a Goal command; use /goal:edit."],
		[
			"set-resume-budget",
			"resume --budget 90000",
			"Goal not created: `resume --budget` is a Goal command; use /goal:resume --budget <new-total> (or --budget=<new-total>).",
		],
	];
	for (const [id, objective, diagnostic] of reserved) {
		const refused = await call(session, id, "thread/goal/set", { objective }, "external-user");
		assert.equal(refused.ok, false, `${objective} must be refused`);
		assert.equal(refused.disposition, "refused", `${objective}: ${JSON.stringify(refused)}`);
		assert.equal(refused.error.code, "refused");
		assert.deepEqual(
			refused.diagnostics,
			[{ level: "error", text: diagnostic }],
			`${objective}: pi-goal's own diagnostic, verbatim`,
		);
		assert.equal(refused.error.message, diagnostic);
		assert.deepEqual(refused.transitions, [], `${objective} committed no transition`);
		assert.equal(await goalBytes(session), before, `${objective} wrote no Goal bytes`);
	}
	// The same Objective with creation options must be refused too: the companion
	// renders `{ budget: null }` as `--no-budget <objective>` and `{ budget: n }`
	// as `--budget n <objective>`, but the Objective is still the reserved word.
	for (const [id, params, diagnostic] of [
		["set-clear-unbounded", { objective: "clear", budget: null }, "Goal not created: `clear` is a Goal command; use /goal:clear."],
		["set-edit-budget", { objective: "edit", budget: 90000 }, "Goal not created: `edit` is a Goal command; use /goal:edit."],
		[
			"set-resume-budget-option",
			{ objective: "resume", budget: 90000 },
			"Goal not created: `resume` is a Goal command; use /goal:resume.",
		],
	]) {
		const refused = await call(session, id, "thread/goal/set", params, "external-user");
		assert.equal(refused.ok, false, `${JSON.stringify(params)} must be refused`);
		assert.equal(refused.disposition, "refused", `${JSON.stringify(params)}: ${JSON.stringify(refused)}`);
		assert.deepEqual(
			refused.diagnostics,
			[{ level: "error", text: diagnostic }],
			`${JSON.stringify(params)}: pi-goal's own diagnostic, verbatim`,
		);
		assert.deepEqual(refused.transitions, [], "the option-bearing refusal committed no transition");
		assert.equal(await goalBytes(session), before, "the option-bearing refusal wrote no Goal bytes");
	}

	// The current Goal is untouched: same identity, same status, same durable record.
	const survived = await call(session, "get-after-reserved", "thread/goal/get");
	assert.equal(survived.ok, true);
	assert.equal(survived.goal.id, created.goal.id);
	assert.equal(survived.goal.status, "complete");
	assert.equal(survived.goal.objective, OBJECTIVE);
	assert.equal(
		goalSnapshots(readSessionEntries(await session.sessionFile())).length,
		beforeSnapshots,
		"no snapshot or tombstone was appended by a reserved-word Objective",
	);

	// An Objective that begins with a verb word is an Objective, Objective rules
	// being the same whether the text is typed or sent over RPC. `edit …` is the
	// regression: the old parser applied it as an edit of the *current* Goal, and
	// the old companion refused it for that reason. It is created now.
	const edited = await call(
		session,
		"set-edit-objective",
		"thread/goal/set",
		{ objective: "edit the release notes" },
		"external-user",
	);
	assert.equal(edited.ok, true, JSON.stringify(edited));
	assert.equal(edited.disposition, "committed");
	// The base Goal still exists (complete), so this is a replacement: no
	// confirmation is asked for a finished Goal, and the transition kind says so.
	assert.deepEqual(
		edited.transitions.map((transition) => transition.kind),
		["replaced"],
	);
	assert.equal(edited.goal.objective, "edit the release notes");
	assert.equal(edited.goal.status, "active");
	await waitForSnapshot(
		session,
		(snapshot) => snapshot.data.goal?.status === "complete" && snapshot.data.goal?.objective === "edit the release notes",
		"the edit-leading Objective to complete",
	);

	// A leading option token is whatever pi-goal's creation path answers for it,
	// forwarded verbatim: the option is consumed exactly as if the user typed it.
	const option = await call(
		session,
		"set-leading-option",
		"thread/goal/set",
		{ objective: "--no-budget do something else" },
		"external-user",
	);
	assert.equal(option.ok, true, JSON.stringify(option));
	assert.equal(option.goal.objective, "do something else", "pi-goal's creation path consumed the leading option");
	assert.equal(option.goal.tokenBudget, null, "--no-budget is honoured as the explicit unbounded request");
	await waitForSnapshot(
		session,
		(snapshot) => snapshot.data.goal?.status === "complete" && snapshot.data.goal?.objective === "do something else",
		"the option-leading Objective to complete",
	);

	// The parse check is gone entirely, so an Objective that merely *begins* with a
	// verb word keeps creating, exactly as it always did.
	for (const [id, objective] of [
		["set-clear-sentence", "clear the cache"],
		["set-history-sentence", "history of the release"],
	]) {
		const ordinary = await call(session, id, "thread/goal/set", { objective }, "external-user");
		assert.equal(ordinary.ok, true, `${objective}: ${JSON.stringify(ordinary)}`);
		assert.equal(ordinary.goal.objective, objective, "the objective is not truncated or reinterpreted");
		assert.equal(ordinary.goal.status, "active");
		await waitForSnapshot(
			session,
			(snapshot) => snapshot.data.goal?.status === "complete" && snapshot.data.goal?.objective === objective,
			`${objective} to complete`,
		);
	}

	await call(session, "clear-final", "thread/goal/clear", undefined, "external-user");
	assertStepsConsumed(session, completions * 2);
	assertCleanRun(session);
});

test("the request envelope is strict: version is required and unknown fields are refused", async (t) => {
	tempDir(t);
	const session = await PiRpcSession.start({ extraExtensions: [COMPANION] });
	t.after(() => session.stop());

	// No version: refused rather than defaulted. A request that never declared a
	// protocol is not this package's request.
	const noVersion = await callRaw(session, "env-no-version", { id: "env-no-version", method: "thread/goal/get" });
	assert.equal(noVersion.ok, false);
	assert.equal(noVersion.error.code, "invalid-request");
	assert.match(noVersion.error.message, /must declare "version": 1/);

	// A future version is refused, not guessed at.
	const futureVersion = await callRaw(session, "env-future-version", {
		version: REQUEST_VERSION + 1,
		id: "env-future-version",
		method: "thread/goal/get",
	});
	assert.equal(futureVersion.ok, false);
	assert.equal(futureVersion.error.code, "invalid-request");
	assert.match(futureVersion.error.message, /unsupported request version 2/);

	// A field this package does not read is a field the caller expected something to
	// read: ignoring it would answer `ok: true` to a request that was never sent.
	const futureField = await callRaw(session, "env-future-field", {
		version: REQUEST_VERSION,
		id: "env-future-field",
		method: "thread/goal/get",
		futureField: true,
	});
	assert.equal(futureField.ok, false);
	assert.equal(futureField.error.code, "invalid-request");
	assert.match(futureField.error.message, /unknown top-level field "futureField"/);
	assert.equal(futureField.goal, null);

	// None of it reached pi-goal or the lifecycle.
	assert.equal(await goalBytes(session), "");
	assert.equal(runCount(session), 0);
	assertCleanRun(session);
});
