/**
 * Issue #26 repair batch 3: opaque Blocker identity and the legacy-audit handoff.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test provider, and temporary working/session/agent
 * directories. Assertions target public behavior only: RPC events, extension
 * notifications, tool results, model context, and persisted session entries.
 *
 * The honesty rules are the ones the rest of the suite uses:
 *
 * - every script is sized exactly, and every test asserts the number of assistant
 *   outcomes equals the number of steps it wrote, so a step can neither be
 *   requested twice nor go missing;
 * - every test asserts the exact run, continuation, and snapshot counts;
 * - every test ends with `assertCleanRun()` (or `assertOnlyFailures()` when a
 *   provider error or an abort is the subject), so a stop caused by a scripted
 *   error can never be mistaken for the Goal lifecycle under test.
 *
 * A chain is scripted through `test/helpers/blocked-audit.mjs`: the scripted
 * provider re-reads its script on every request and a `waitForFile` step holds its
 * response until the test releases it, so the identity the extension issues can be
 * read out of a structured tool result and passed back by the later turns exactly
 * the way a real model does after calling `get_goal`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assistantOutcomes,
	continuationEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";
import {
	FOREIGN_ID,
	assertAudit,
	auditChainStepCount,
	runAuditChain,
	structuredGoal,
} from "./helpers/blocked-audit.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
const EDITED_OBJECTIVE = "Ship the release notes page instead";
/** The one genuine condition the model reports across Goal turns. */
const BLOCKER = "the upstream release API token has not been issued yet";
/** The same condition, reworded: reusing its identity must still advance the audit. */
const REWORDED_BLOCKER =
	"Still blocked on the release API token: the upstream maintainers have not issued it, and requesting it again would unblock the work";
/** A genuinely different condition, which must restart the audit at one. */
const OTHER_BLOCKER = "the test database migration has not been written";
const LEGACY_BLOCKER = "The test database is unavailable";
const LEGACY_FIXTURES = join(import.meta.dirname, "fixtures", "legacy");

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/** Tool results for one tool, in the order the calls finalized. */
function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

/** Every persisted Goal snapshot, in the order the session recorded them. */
function goalSnapshots(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/** Every audit count the branch recorded, in order. */
function auditTurns(entries) {
	return goalSnapshots(entries)
		.map((e) => e.data.goal.blockedAudit?.turns)
		.filter((turns) => turns !== undefined);
}

/** The audit of the newest persisted snapshot. */
function lastAuditOf(entries) {
	return lastGoalSnapshot(entries).data.goal.blockedAudit;
}

/** Fail unless exactly `steps` provider responses were consumed. */
function assertStepsConsumed(session, steps, expectedFailures = []) {
	const outcomes = assistantOutcomes(session);
	assert.equal(outcomes.length, steps, `expected exactly ${steps} provider responses, got ${outcomes.length}`);
	assertOnlyFailures(session, expectedFailures);
}

/** Create the Goal and confirm the kickoff run started. */
async function startGoal(session, objective = OBJECTIVE) {
	await session.prompt(`/goal ${objective}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await session.waitFor("run started", (records) =>
		records.some((r) => r.type === "turn_start") ? true : undefined,
	);
}

/** Report the current Goal through bare /goal. */
async function reportStatus(session) {
	await session.prompt("/goal");
	return session.waitFor("a /goal report", (records) => {
		const matches = records.filter(
			(r) =>
				r.type === "extension_ui_request" &&
				r.method === "notify" &&
				(/^Goal \S+ — /.test(r.message) || r.message.includes("No Goal is set")),
		);
		return matches.length ? matches.at(-1) : undefined;
	});
}

/** Send a command without awaiting it, so a blocking dialog can be answered first. */
function submitCommand(session, id, message) {
	const responsePromise = session.waitFor(
		`response for ${id}`,
		(records) => records.find((r) => r.type === "response" && r.id === id),
	);
	session.writeCommand({ id, type: "prompt", message });
	return responsePromise;
}

/** Copy one immutable legacy fixture into a fresh session dir and start Pi on it. */
async function startLegacy(fixture, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-legacy-"));
	const sessionFile = join(dir, "legacy.jsonl");
	copyFileSync(join(LEGACY_FIXTURES, fixture), sessionFile);
	// Pi refuses to resume a session whose stored working directory is missing.
	const stored = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
	if (stored.cwd) mkdirSync(stored.cwd, { recursive: true });
	const session = await PiRpcSession.start({ ...options, sessionFile, cwd: options.cwd ?? dir });
	return { session, dir, sessionFile };
}

test("the first report issues an opaque identity that every later turn passes back", async () => {
	const session = await PiRpcSession.start();
	const reports = [{ blocker: BLOCKER }, { blocker: BLOCKER, id: "issued" }, { blocker: BLOCKER, id: "issued" }];
	try {
		const issued = await runAuditChain(session, reports, [{ text: "Nothing else to do." }], () =>
			startGoal(session),
		);
		assert.match(issued, /^blocker_[0-9a-f]{8}$/);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 3);
		// The structured response publishes the identity on every report, so the model
		// can reuse it without guessing it or deriving it from the wording.
		for (const result of results) {
			assert.equal(structuredGoal(result.result).blockerId, issued);
			assert.equal(structuredGoal(result.result).blocker, BLOCKER);
		}
		assert.equal(structuredGoal(results[0].result).blockedTurns, 1);
		assert.equal(structuredGoal(results[1].result).blockedTurns, 2);
		assert.equal(structuredGoal(results[2].result).blockedTurns, 3);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(auditTurns(entries), [1, 2, 3], "one durable audit step per Goal turn");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "blocked");
		assertAudit(lastAuditOf(entries), BLOCKER, 3);
		assert.equal(continuationEntries(entries).length, 3, "one continuation per Goal turn before the stop");
		assert.equal(runCount(session), 4, "kickoff plus exactly three Goal turns");
		assertStepsConsumed(session, auditChainStepCount(reports));
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a reworded report reusing the identity advances, an omitted one starts a fresh chain", async () => {
	const session = await PiRpcSession.start();
	const reports = [
		{ blocker: BLOCKER },
		{ blocker: REWORDED_BLOCKER, id: "issued" },
		{ blocker: OTHER_BLOCKER },
		{ blocker: OTHER_BLOCKER, id: "issued" },
		{ blocker: OTHER_BLOCKER, id: "issued" },
	];
	try {
		await runAuditChain(session, reports, [], () => startGoal(session));
		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 5);
		// Reworded, same condition: the audit advanced instead of restarting.
		assert.match(String(results[1].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(structuredGoal(results[1].result).blocker, REWORDED_BLOCKER);
		// A genuinely different condition restarts the audit at one with a fresh identity.
		assert.match(String(results[2].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.notEqual(
			structuredGoal(results[2].result).blockerId,
			structuredGoal(results[1].result).blockerId,
			"the old chain cannot resume",
		);
		assert.equal(results[4].isError, false, "the new condition for three turns satisfies the audit");
		assertAudit(lastAuditOf(readSessionEntries(await session.sessionFile())), OTHER_BLOCKER, 3);
		assertStepsConsumed(session, auditChainStepCount(reports));
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("an unknown identity is refused without Goal mutation and does not own the turn", async () => {
	const session = await PiRpcSession.start();
	// Goal turn 1 reports and is issued an identity. Goal turn 2 first passes an
	// identity the extension never issued — refused, nothing written — and then
	// reports the same condition with the current one, which is the turn's first
	// valid report.
	const gate = join(session.cwd, "pi-goal-audit-gate");
	const steps = (id) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting (Goal turn 1).", waitForFile: gate },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: FOREIGN_ID } }] },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Waiting (Goal turn 2)." },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		{ text: "Wrapping up." },
	];
	try {
		writeFileSync(session.scriptPath, JSON.stringify(steps(null)), "utf8");
		await startGoal(session);
		const issued = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(steps(issued)), "utf8");
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 4);
		assert.match(String(results[0].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		// The unknown identity is refused and writes nothing.
		assert.equal(results[1].isError, true);
		assert.match(String(results[1].result.content[0].text), /is not the Blocker identity of the audit currently open/);
		assert.match(String(results[1].result.content[0].text), /never compares blocker text/);
		// The corrected call in the same turn records the turn's first valid report.
		assert.equal(results[2].isError, true);
		assert.match(String(results[2].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(results[3].isError, false, "the Goal completed normally");
		assert.deepEqual(auditTurns(readSessionEntries(await session.sessionFile())), [1, 2]);
		assert.equal(runCount(session), 4, "kickoff plus three Goal turns");
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a stale identity from an ended chain is refused, and a corrected call starts a fresh one", async () => {
	const session = await PiRpcSession.start();
	// Goal turn 2 makes no report, so the chain breaks durably and the identity turn 1
	// was issued is spent. Goal turn 3 tries it (refused) and then reports the same
	// condition with no identity, which starts a fresh chain at one; turns 4 and 5
	// reuse that chain's identity and satisfy the audit.
	const firstGate = join(session.cwd, "pi-goal-audit-gate-1");
	const secondGate = join(session.cwd, "pi-goal-audit-gate-3");
	const steps = (chainedId) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting (Goal turn 1).", waitForFile: firstGate },
		{ toolCalls: [{ name: "get_goal", args: {} }] },
		{ text: "I inspected the repository and kept working." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: stale } }] },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting (Goal turn 3).", waitForFile: secondGate },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: chainedId } }] },
		{ text: "Waiting (Goal turn 4)." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: chainedId } }] },
		{ text: "Reporting the blocker." },
	];
	let stale;
	try {
		writeFileSync(session.scriptPath, JSON.stringify(steps(null)), "utf8");
		await startGoal(session);
		stale = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(steps(null)), "utf8");
		writeFileSync(firstGate, "", "utf8");
		// The restarted chain issues its own identity, which the last two turns reuse.
		const chained = structuredGoal((await session.waitForToolResult("update_goal", 3)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(steps(chained)), "utf8");
		writeFileSync(secondGate, "", "utf8");
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 5);
		assert.match(String(results[0].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		// The spent identity is refused without touching the Goal.
		assert.equal(results[1].isError, true);
		assert.match(String(results[1].result.content[0].text), /is not the Blocker identity of the audit currently open/);
		assert.notEqual(structuredGoal(results[1].result).blockerId, stale, "no audit is open any more");
		// The corrected call reports a genuinely different condition: a fresh chain.
		assert.match(String(results[2].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.match(String(results[3].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(results[4].isError, false, "the fresh chain reaches the threshold on its third turn");
		assertAudit(lastAuditOf(readSessionEntries(await session.sessionFile())), BLOCKER, 3);
		assert.equal(runCount(session), 6, "kickoff plus five Goal turns");
		assertStepsConsumed(session, 12);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("only the third consecutive Goal turn transitions, and no turn can double-count", async () => {
	const session = await PiRpcSession.start();
	// Each Goal turn makes two calls: the report, then a reworded repeat with a
	// foreign identity. Only the report counts, so three turns are still required.
	const gate = join(session.cwd, "pi-goal-audit-gate");
	const steps = (id) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting (Goal turn 1).", waitForFile: gate },
		{
			toolCalls: [
				{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } },
				{ name: "update_goal", args: { action: "blocked", blocker: "A different wording", blocker_id: FOREIGN_ID } },
			],
		},
		{ text: "Waiting (Goal turn 2)." },
		{
			toolCalls: [
				{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } },
				{ name: "update_goal", args: { action: "blocked", blocker: "Another wording", blocker_id: FOREIGN_ID } },
			],
		},
		{ text: "Reporting the blocker." },
	];
	try {
		writeFileSync(session.scriptPath, JSON.stringify(steps(null)), "utf8");
		await startGoal(session);
		const issued = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(steps(issued)), "utf8");
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 5);
		assert.match(String(results[0].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.match(String(results[1].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.match(
			String(results[2].result.content[0].text),
			/already recorded for the current Goal turn \(2 of 3 consecutive Goal turns\)/,
			"the repeat is one audit step",
		);
		assert.equal(results[3].isError, false, "the third consecutive Goal turn transitions");
		assert.equal(structuredGoal(results[3].result).status, "blocked");
		// The Goal is stopped, so the trailing repeat has nothing left to advance.
		assert.equal(results[4].isError, true);
		assert.match(String(results[4].result.content[0].text), /no active Goal to block/);
		assert.deepEqual(auditTurns(readSessionEntries(await session.sessionFile())), [1, 2, 3]);
		assertStepsConsumed(session, 7);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a Replacement Goal starts a fresh audit and inherits no chain", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "pi-goal-audit-gate");
	const chained = (id) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting.", waitForFile: gate },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Waiting." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Reporting the blocker." },
		// The replacement's own kickoff, then one report of the same condition.
		{ text: "Replacement kickoff." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting." },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		{ text: "Wrapping up." },
	];
	try {
		writeFileSync(session.scriptPath, JSON.stringify(chained("@issued")), "utf8");
		await startGoal(session);
		const issued = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(chained(issued)), "utf8");
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);
		const blocked = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assertAudit(blocked.blockedAudit, BLOCKER, 3);

		// A Replacement Goal is a new identity, so it starts with no audit at all.
		const replace = submitCommand(session, "replace", `/goal ${EDITED_OBJECTIVE}`);
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		await replace;
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		await session.waitForSettled(2);

		const results = toolResults(session, "update_goal");
		assert.equal(
			results.length,
			5,
			"three reports that blocked the old Goal, one for the new one, and the completion",
		);
		const replaced = structuredGoal(results[3].result);
		assert.notEqual(replaced.id, blocked.id, "a Replacement Goal is a new identity");
		assert.match(String(results[3].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.notEqual(replaced.blockerId, issued, "the old chain cannot resume under the new identity");
		assert.equal(replaced.blockedTurns, 1);
		assertStepsConsumed(session, 12);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a compacted Goal turn keeps the audit chain, and the identity survives the retry", async () => {
	const session = await PiRpcSession.start({ settings: { compaction: { keepRecentTokens: 1 } } });
	// Goal turn 2's first response is truncated: Pi compacts and retries the same Goal
	// turn, so its report is still the second consecutive turn rather than a fresh one.
	const gate = join(session.cwd, "pi-goal-audit-gate");
	const steps = (id) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting.", waitForFile: gate },
		{ stopReason: "length" },
		{ text: "Compaction summary A." },
		{ text: "Compaction summary B." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Waiting." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Reporting the blocker." },
	];
	try {
		writeFileSync(session.scriptPath, JSON.stringify(steps(null)), "utf8");
		await startGoal(session);
		const issued = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(steps(issued)), "utf8");
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 3);
		assert.match(String(results[1].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(results[2].isError, false, "the compacted turn still counted as one Goal turn");
		assertAudit(lastAuditOf(readSessionEntries(await session.sessionFile())), BLOCKER, 3);
		assert.equal(runCount(session), 5, "kickoff plus a two-run Goal turn plus two more");
		// A truncated response is a recoverable length stop, not a failed outcome.
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("the Continuation restates the open audit, and get_goal publishes its identity", async () => {
	const session = await PiRpcSession.start();
	// Goal turn 2 also reads the Goal, so get_goal is observed while the audit is open.
	const gate = join(session.cwd, "pi-goal-audit-gate");
	const steps = (id) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting (Goal turn 1).", waitForFile: gate },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ toolCalls: [{ name: "get_goal", args: {} }] },
		{ text: "Waiting (Goal turn 2)." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Reporting the blocker." },
	];
	try {
		writeFileSync(session.scriptPath, JSON.stringify(steps(null)), "utf8");
		await startGoal(session);
		const issued = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(steps(issued)), "utf8");
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		// Every Continuation drafted while the audit is open restates its identity,
		// latest description, and count.
		const entries = readSessionEntries(await session.sessionFile());
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 3, "one continuation per Goal turn before the stop");
		const restatements = continuations.filter((c) => c.content.includes("Open blocked audit on this Goal right now"));
		assert.equal(restatements.length, 2, "the two drafted after the first report restate the open audit");
		for (const continuation of restatements) {
			const message = continuation.content;
			assert.ok(message.includes(`Blocker identity: ${issued}`), "the identity is restated");
			assert.ok(message.includes(`Latest description: ${BLOCKER}`), "the description is restated");
			assert.match(message, /Count: \d of 3 consecutive Goal turns\./, "the count is restated");
		}
		for (const continuation of continuations) {
			assert.match(continuation.content, /Identity, not wording, decides equivalence/);
			assert.match(continuation.content, /pi-goal never compares blocker text/);
			assert.doesNotMatch(
				continuation.content,
				/equivalent blockers|normaliz|similar/i,
				"no text-similarity equivalence survives in the model-facing contract",
			);
		}

		// get_goal publishes the identity in both its structured payload and its text.
		const read = toolResults(session, "get_goal")[0];
		const state = structuredGoal(read.result);
		assert.equal(state.blockerId, issued, "the structured payload carries the identity");
		assert.equal(state.blocker, BLOCKER);
		assert.equal(state.blockedTurns, 2);
		assert.ok(
			String(read.result.content[0].text).includes(`Blocker identity: ${issued}`),
			"the model-facing text carries it too",
		);

		assert.deepEqual(auditTurns(entries), [1, 2, 3]);
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("the human status shows the description and the count but never the opaque identity", async () => {
	const session = await PiRpcSession.start();
	const reports = [
		{ blocker: BLOCKER },
		{ blocker: BLOCKER, id: "issued" },
		{ blocker: BLOCKER, id: "issued" },
	];
	try {
		const issued = await runAuditChain(session, reports, [], () => startGoal(session));
		const status = await reportStatus(session);
		assert.ok(status.message.includes(`Blocker: ${BLOCKER}`), "the description is shown");
		assert.ok(
			status.message.includes("Blocked audit: 3 of 3 consecutive Goal turns reported this blocker"),
			"and the count",
		);
		assert.ok(!status.message.includes(issued), "the opaque identity is not displayed to the human");
		// The audit itself is untouched by the status report.
		assert.deepEqual(auditTurns(readSessionEntries(await session.sessionFile())), [1, 2, 3]);
		assertStepsConsumed(session, auditChainStepCount(reports));
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a legacy open audit is handed a fresh identity that survives a reload", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-open-audit.jsonl");
	let issued;
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const repaired = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal;
		assert.equal(repaired.blockedAudit.blocker, LEGACY_BLOCKER, "description preserved");
		assert.equal(repaired.blockedAudit.turns, 2, "count preserved");
		issued = repaired.blockedAudit.blockerId;
		assert.match(issued, /^blocker_[0-9a-f]{8}$/, "a fresh opaque identity was issued and persisted");
		assert.notEqual(issued, LEGACY_BLOCKER, "the identity is not derived from the blocker text");
		assertStepsConsumed(session, 0, []);
		assert.equal(runCount(session), 0, "the cutover admits no work");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}

	// A reload reconstructs the same audit and the same identity, so a later Goal
	// turn can advance the preserved chain instead of restarting it.
	const reloaded = await PiRpcSession.start({ sessionFile, cwd: dir });
	try {
		await reloaded.waitForNotify((r) => r.message.includes("restored (active)"));
		const again = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal;
		assert.equal(again.blockedAudit.blocker, LEGACY_BLOCKER);
		assert.equal(again.blockedAudit.turns, 2);
		assert.equal(again.blockedAudit.blockerId, issued, "the identity survives the reload");
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 2, "no second cutover");
		assert.ok(issued, "the first process issued an identity");
		assertStepsConsumed(reloaded, 0, []);
		assert.equal(reloaded.extensionErrors().length, 0);
	} finally {
		await reloaded.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the legacy handoff grants no extra unattended turns and alters no reset rule", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-open-audit.jsonl");
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const issued = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal.blockedAudit.blockerId;

		// A user prompt is a user action: the preserved audit is reset durably, exactly
		// as it always was, so the handoff grants no extra unattended turns.
		script(
			[
				{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: LEGACY_BLOCKER, blocker_id: issued } }] },
				{ text: "Waiting." },
				{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: LEGACY_BLOCKER } }] },
				{ text: "Waiting." },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Wrapping up." },
			],
			session,
		);
		await session.prompt("keep going");
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 3);
		// The spent identity cannot resume the chain the user action reset.
		assert.equal(results[0].isError, true);
		assert.match(String(results[0].result.content[0].text), /is not the Blocker identity of the audit currently open/);
		// Omitting it reports a genuinely different condition: a fresh chain at one.
		assert.match(String(results[1].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.equal(results[2].isError, false, "the Goal completed normally");
		// Legacy, cutover, the durable reset from the user action, the fresh chain's
		// first report, and the completion. The refused report wrote nothing.
		const snapshots = goalSnapshots(readSessionEntries(sessionFile));
		assert.equal(snapshots.length, 5);
		assert.equal(snapshots[0].data.goal.blockedAudit.turns, 2, "the legacy audit");
		assert.equal(snapshots[1].data.goal.blockedAudit.blockerId, issued, "the cutover's fresh identity");
		assert.equal(snapshots[2].data.goal.blockedAudit, undefined, "the user action reset the preserved audit");
		assertAudit(snapshots[3].data.goal.blockedAudit, LEGACY_BLOCKER, 1);
		assert.notEqual(snapshots[3].data.goal.blockedAudit.blockerId, issued, "a fresh identity was issued");
		assert.equal(runCount(session), 3, "the prompted run plus two Goal turns");
		assertStepsConsumed(session, 6);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stopped legacy Goal keeps its audit as history and is never advanced", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-blocked.jsonl");
	try {
		await session.waitForNotify((r) => r.message.includes("restored (blocked)"));
		const repaired = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal;
		assert.equal(repaired.status, "blocked");
		assert.equal(repaired.blockedAudit.blocker, LEGACY_BLOCKER);
		assert.equal(repaired.blockedAudit.turns, 3);
		assert.equal(repaired.blockedAudit.blockerId, undefined, "a stopped Goal's audit gets no identity");
		script([{ text: "Never requested." }, { text: "Never requested." }], session);
		await session.prompt("anything else to do?");
		await session.waitForSettled(1);
		assert.equal(toolResults(session, "update_goal").length, 0, "a blocked Goal never continues");
		assert.equal(continuationEntries(readSessionEntries(sessionFile)).length, 0);
		assert.equal(runCount(session), 1, "only the ordinary prompt ran");
		assertStepsConsumed(session, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
