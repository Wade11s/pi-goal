/**
 * Issue #5 acceptance tests: stop safely on blockers and failures.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: RPC events, extension
 * notifications, tool results, model context, and persisted session entries.
 *
 * The anti-loop tests share one discipline, because a Goal also stops when the
 * scripted provider runs out of steps and a test could otherwise pass for the
 * wrong reason:
 *
 * - every script is sized exactly, and every test asserts the number of
 *   assistant outcomes equals the number of steps it wrote, so a step can
 *   neither be requested twice nor go missing;
 * - every test asserts the exact continuation and run counts, so the loop
 *   stopped where the test says it did;
 * - every test ends with `assertCleanRun()` (or `assertOnlyFailures()` when a
 *   provider error or an abort is the subject), so a stop caused by a provider
 *   error or an exhausted script can never be mistaken for the Goal lifecycle
 *   under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

const OBJECTIVE = "Make the full test suite pass in this repository";
/** The one genuine blocker the model reports across Goal turns. */
const BLOCKER = "the upstream release API token has not been issued yet";
/** The same blocker, reworded: equivalent, so the audit must still advance. */
const REWORDED_BLOCKER = "The upstream release API token has not been issued yet.";
/** A genuinely different blocker, which must restart the audit at one. */
const OTHER_BLOCKER = "the test database migration has not been written";
/** A model response with nothing in it: no text, no tool call, no reasoning. */
const EMPTY_RESPONSE = {};
/** A shell command that fails the ordinary way: it runs and exits non-zero. */
const FAILING_COMMAND = { command: "exit 7" };
/** A usage-limit failure Pi will not retry (quota exhaustion, not a throttle). */
const USAGE_LIMIT_ERROR = "429 insufficient_quota: you exceeded your current quota for this organization";
/** A terminal provider failure that is not a usage limit. */
const TERMINAL_ERROR = "invalid api key";

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/** Tool results for one tool, in the order the calls finalized. */
function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

/** The structured `{ goal }` payload of a finalized tool call. */
function structuredGoal(result) {
	return result.structuredContent?.goal ?? result.details?.goal;
}

/** The audit of the last persisted snapshot. */
function lastAudit(entries) {
	return lastGoalSnapshot(entries).data.goal.blockedAudit;
}

/**
 * Assert the scripted provider was asked for exactly `steps` responses.
 *
 * One provider request consumes one step and finalizes one assistant message,
 * so equality proves the test neither exhausted the script (which would stop the
 * Goal for the wrong reason) nor replayed a step.
 */
function assertStepsConsumed(session, steps, expectedFailures = []) {
	const outcomes = assistantOutcomes(session);
	assert.equal(
		outcomes.length,
		steps,
		`expected exactly ${steps} provider responses, got ${outcomes.length}`,
	);
	assertOnlyFailures(session, expectedFailures);
}

/** Wait until the current run has provably started but has not yet answered. */
function waitForRunStarted(session) {
	return session.waitFor("run started", (records) => (records.some((r) => r.type === "turn_start") ? true : undefined));
}

/** Create the Goal and confirm the kickoff run was started. */
async function startGoal(session, objective = OBJECTIVE) {
	await session.prompt(`/goal ${objective}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await waitForRunStarted(session);
}

test("the continuation contract distinguishes progress, verified waits, and no progress", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		const [continuation] = continuationEntries(entries);
		assert.ok(continuation, "the Goal continued once");
		const message = continuation.content;

		// The no-progress classification is part of the contract.
		assert.match(message, /No-progress check \(classify the previous Goal turn before choosing the next action\):/);
		assert.match(
			message,
			/Progress changes authoritative state, completes work, or yields evidence that changes the next action\. Restating status and unexecuted plans are not progress\./,
		);
		assert.match(message, /A verified wait polls a specific process, session, job, or tool handle confirmed live now\./);
		assert.match(
			message,
			/Treat the work as stopped only when authoritative state says it is terminal or its handle is missing/,
		);
		assert.match(message, /an observation timeout or a transient polling failure is not terminal/);

		// Equivalent blockers are described as one condition across turns.
		assert.match(
			message,
			/Treat equivalent blockers as the same condition across turns even when their wording or stated next step changes\./,
		);

		// The blocked audit states the threshold and its consequences.
		assert.match(message, /Blocked audit \(3 consecutive Goal turns with the same genuine blocker\):/);
		assert.match(message, /Do not report a blocker the first time it appears/);
		assert.match(
			message,
			/at least 3 consecutive Goal turns, counting the turn the user started and every automatic continuation since/,
		);
		assert.match(message, /a reworded repetition still advances the audit; a genuinely different blocker restarts it at one/);
		assert.match(message, /A blocked Goal never continues automatically and only the user can resume it/);

		// The extension-enforced conservative stops are stated too, including the
		// distinction that keeps ordinary command failures out of them.
		assert.match(message, /Conservative stops pi-goal enforces by itself/);
		assert.match(message, /3 consecutive activity-free automatic Goal turns/);
		assert.match(message, /3 consecutive turns in which commands could not be executed at all/);
		assert.match(message, /An ordinary command failure \(a non-zero exit code\) is normal work, not an execution failure/);

		// And the objective data block still precedes every authoritative line.
		assert.ok(
			message.indexOf("INSTRUCTIONS FROM PI-GOAL") > message.indexOf("END GOAL OBJECTIVE DATA (nonce "),
			"the instructions come after the objective data block",
		);
		assertStepsConsumed(session, 3);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("update_goal(blocked) needs the same blocker for three consecutive Goal turns", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, then one blocker report per Goal turn: the first two are refused
	// and the Goal keeps working, the third satisfies the audit and blocks it.
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Still waiting for the token." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Still waiting for the token." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Reporting the blocker to the user." },
			{ text: "Nothing else to do." },
		],
		session,
	);
	try {
		await startGoal(session);
		// The first settle happens only when the Goal is blocked.
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 3);
		assert.equal(results[0].isError, true, "the first report is below the threshold");
		assert.match(String(results[0].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.equal(structuredGoal(results[0].result).status, "active", "the Goal stays active");
		assert.equal(results[1].isError, true, "the second report is still below the threshold");
		assert.match(String(results[1].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.match(String(results[1].result.content[0].text), /the same genuine blocker must persist/);
		assert.equal(structuredGoal(results[1].result).status, "active");
		assert.equal(results[2].isError, false, "the third report satisfies the audit");
		assert.equal(structuredGoal(results[2].result).status, "blocked");
		assert.equal(structuredGoal(results[2].result).blocker, BLOCKER);
		assert.equal(structuredGoal(results[2].result).blockedTurns, 3);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 3, "one continuation per Goal turn before the stop");
		assert.equal(runCount(session), 4, "kickoff plus exactly three Goal turns");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "blocked");
		assert.deepEqual(lastAudit(entries), { blocker: BLOCKER, turns: 3 });

		// The user is told why the Goal stopped.
		const blocked = await session.waitForNotify((r) => r.message.includes("is now blocked"));
		assert.ok(blocked.message.includes(BLOCKER), "the notification carries the blocker");
		assert.ok(blocked.message.includes("3 consecutive Goal turns"));

		// A blocked Goal never continues: a further completed run adds no entry.
		await session.prompt("anything else to do?");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 3, "a blocked Goal never auto-continues");
		assert.equal(runCount(session), 5, "the new prompt ran once and settled");
		assert.equal(lastGoalSnapshot(after).data.goal.status, "blocked");

		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a reworded equivalent blocker advances the audit, a different one restarts it", async () => {
	const session = await PiRpcSession.start();
	// Turn 1 reports the blocker, turn 2 reports the same condition with only its
	// case and trailing punctuation changed, and turn 3 reports a genuinely
	// different blocker, which restarts the audit.
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: REWORDED_BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: OTHER_BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: OTHER_BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: OTHER_BLOCKER } }] },
			{ text: "Reporting the blocker." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 5);
		// Reworded but equivalent: the audit advanced instead of restarting.
		assert.match(String(results[1].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(structuredGoal(results[1].result).blocker, REWORDED_BLOCKER);
		assert.equal(structuredGoal(results[1].result).status, "active");
		// A genuinely different blocker restarts the audit at one.
		assert.match(String(results[2].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.equal(structuredGoal(results[2].result).blocker, OTHER_BLOCKER);
		assert.match(String(results[3].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(results[4].isError, false, "the same new blocker for three turns satisfies the audit");
		assert.equal(structuredGoal(results[4].result).status, "blocked");

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "blocked");
		assert.deepEqual(lastAudit(entries), { blocker: OTHER_BLOCKER, turns: 3 });
		assert.equal(runCount(session), 6, "kickoff plus five Goal turns");
		assertStepsConsumed(session, 11);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("update_goal(blocked) requires a blocker description and refuses user-owned actions", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: "no" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "resume" } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 5);
		assert.equal(results[0].isError, true, "a blocked report without a blocker is refused");
		assert.match(String(results[0].result.content[0].text), /describe the blocker in 3 to 500 characters/);
		assert.equal(results[1].isError, true, "a too-short blocker is refused");
		assert.equal(results[2].isError, true, "the first real report is still below the threshold");
		assert.match(String(results[2].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		// The model cannot resume, clear, or pause a Goal through the tool.
		assert.equal(results[3].isError, true);
		assert.match(String(results[3].result.content[0].text), /only supports the actions complete and blocked/);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(
			lastGoalSnapshot(entries).data.goal.blockedAudit,
			undefined,
			"completion leaves no blocker story behind",
		);
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("two blocker reports inside one Goal turn count as one audit step", async () => {
	const session = await PiRpcSession.start();
	// A model that repeats its own tool call in one assistant turn must not be able
	// to satisfy a three-turn threshold inside a single turn.
	script(
		[
			{ text: "Kickoff answer." },
			{
				toolCalls: [
					{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } },
					{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } },
				],
			},
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 4);
		assert.match(String(results[0].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		assert.equal(results[1].isError, true, "the repeat is refused too");
		assert.match(
			String(results[1].result.content[0].text),
			/already recorded for the current Goal turn \(1 of 3 consecutive Goal turns\)/,
		);
		assert.match(String(results[2].result.content[0].text), /Blocker recorded \(2 of 3 consecutive Goal turns\)/);
		assert.equal(results[3].isError, false, "the Goal completed normally");

		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = entries.filter((e) => e.customType === "goal-state");
		// Two reports, one audit step: the first Goal turn left exactly one audit
		// snapshot, and the second Goal turn advanced it to two.
		const audits = snapshots.map((e) => e.data.goal.blockedAudit?.turns).filter((t) => t !== undefined);
		assert.deepEqual(audits, [1, 2], "each Goal turn advanced the audit exactly once");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(runCount(session), 4, "kickoff plus three Goal turns");
		assertStepsConsumed(session, 7);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("three activity-free automatic Goal turns stop the Goal as blocked", async () => {
	const session = await PiRpcSession.start();
	// A kickoff, then three automatic Goal turns that answer with nothing at all.
	script(
		[
			{ text: "Kickoff answer." },
			EMPTY_RESPONSE,
			EMPTY_RESPONSE,
			EMPTY_RESPONSE,
			{ text: "Unrequested." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 3, "exactly three Goal turns ran");
		assert.equal(runCount(session), 4, "kickoff plus three empty Goal turns");
		const snapshot = lastGoalSnapshot(entries).data.goal;
		assert.equal(snapshot.status, "blocked", "the loop stopped deterministically");
		assert.equal(snapshot.blockedAudit.turns, 3);
		assert.match(snapshot.blockedAudit.blocker, /3 consecutive automatic Goal turns produced no activity/);

		const stopped = await session.waitForNotify((r) => r.message.includes("stopped and is now blocked"));
		assert.ok(stopped.message.includes("activity-free"), "the stop reason is reported");

		// The fifth scripted step was never requested: the Goal stopped on its own
		// rather than by exhausting the script, and an empty answer is not an error.
		assertStepsConsumed(session, 4);
		assert.ok(
			assistantOutcomes(session).every((o) => o.stopReason === "stop"),
			"empty answers are clean stops, not provider errors",
		);

		// The blocked Goal survives a restart and still does not continue.
		const sessionFile = await session.sessionFile();
		const restarted = await PiRpcSession.start({ sessionFile });
		script([{ text: "Fresh answer." }, { text: "Unrequested." }], restarted);
		try {
			await restarted.prompt("/goal");
			const reported = await restarted.waitForNotify(
				(r) => r.message.includes(OBJECTIVE) && r.message.includes("blocked"),
			);
			assert.ok(reported, "the restored Goal is still blocked");
			assert.ok(reported.message.includes("Blocker:"), "the blocker is still explained");

			await restarted.prompt("keep going anyway");
			await restarted.waitForSettled(1);
			assert.equal(
				continuationEntries(readSessionEntries(sessionFile)).length,
				3,
				"a restored blocked Goal never auto-continues",
			);
			assert.equal(runCount(restarted), 1);
			assertCleanRun(restarted);
		} finally {
			await restarted.stop();
		}
	} finally {
		await session.stop();
	}
});

test("activity resets the activity-free counter, so the stop needs three in a row", async () => {
	const session = await PiRpcSession.start();
	// Two empty Goal turns, one turn that does something, then two more empty
	// turns: never three in a row, so the Goal is never stopped by the counter.
	script(
		[
			{ text: "Kickoff answer." },
			EMPTY_RESPONSE,
			EMPTY_RESPONSE,
			{ text: "A real answer with content." },
			EMPTY_RESPONSE,
			EMPTY_RESPONSE,
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 1);
		assert.equal(results[0].isError, false, "the Goal completed normally");

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(lastGoalSnapshot(entries).data.goal.blockedAudit, undefined);
		assert.equal(continuationEntries(entries).length, 6, "every settlement continued");
		assert.equal(runCount(session), 7);
		assert.ok(
			!session.records.some((r) => r.type === "extension_ui_request" && String(r.message).includes("activity-free")),
			"the counter never reached its limit",
		);
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("three execution-unavailable Goal turns stop the Goal, but ordinary command failures do not count", async () => {
	// A shell that cannot be spawned at all: every bash call fails before the
	// command runs, which is what "execution unavailable" means.
	const session = await PiRpcSession.start({ settings: { shellPath: "/definitely/not/a/shell" } });
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "bash", args: { command: "echo hello" } }] },
			{ text: "The shell would not start." },
			{ toolCalls: [{ name: "bash", args: { command: "echo hello" } }] },
			{ text: "The shell would not start." },
			{ toolCalls: [{ name: "bash", args: { command: "echo hello" } }] },
			{ text: "Reporting the execution failure." },
			{ text: "Unrequested." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const bashResults = toolResults(session, "bash");
		assert.equal(bashResults.length, 3, "the model tried to run a command in every Goal turn");
		assert.ok(
			bashResults.every((r) => r.isError),
			"every command failed",
		);
		assert.ok(
			bashResults.every((r) => /not a shell|not found|ENOENT|spawn/i.test(String(r.result.content[0].text))),
			"the shell itself failed, not the command",
		);

		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries).data.goal;
		assert.equal(snapshot.status, "blocked", "repeated execution unavailability stops the Goal");
		assert.equal(snapshot.blockedAudit.turns, 3);
		assert.match(snapshot.blockedAudit.blocker, /could not execute a command/);
		assert.ok(
			snapshot.blockedAudit.blocker.includes("not the same as a command exiting non-zero"),
			"the blocker explains the distinction",
		);
		const stopped = await session.waitForNotify((r) => r.message.includes("stopped and is now blocked"));
		assert.ok(stopped.message.includes("execution-unavailable"));

		assert.equal(continuationEntries(entries).length, 3);
		assert.equal(runCount(session), 4);
		assertStepsConsumed(session, 7);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a non-zero exit code is ordinary work and never stops the Goal", async () => {
	const session = await PiRpcSession.start();
	// The command runs and fails, three Goal turns in a row: that is a failing
	// test or build, not a broken agent, so the Goal keeps working.
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "bash", args: FAILING_COMMAND }] },
			{ text: "The command exited 7." },
			{ toolCalls: [{ name: "bash", args: FAILING_COMMAND }] },
			{ text: "The command exited 7." },
			{ toolCalls: [{ name: "bash", args: FAILING_COMMAND }] },
			{ text: "The command exited 7." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const bashResults = toolResults(session, "bash");
		assert.equal(bashResults.length, 3);
		assert.ok(bashResults.every((r) => r.isError), "the command failed each time");
		assert.ok(
			bashResults.every((r) => /Command exited with code 7/.test(String(r.result.content[0].text))),
			"each failure is an ordinary non-zero exit",
		);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete", "the Goal was never stopped");
		assert.equal(lastGoalSnapshot(entries).data.goal.blockedAudit, undefined);
		assert.equal(continuationEntries(entries).length, 4, "every settlement continued");
		assert.equal(runCount(session), 5);
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && String(r.message).includes("execution-unavailable"),
			),
			"no execution-unavailable stop was reported",
		);
		assertStepsConsumed(session, 9);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a provider usage limit becomes usage_limited and stops continuation", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer." },
			{ error: USAGE_LIMIT_ERROR },
			{ text: "Unrequested." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries).data.goal;
		assert.equal(snapshot.status, "usage_limited");
		assert.equal(snapshot.blockedAudit.turns, 0, "a usage limit is not a blocked audit");
		assert.match(snapshot.blockedAudit.blocker, /provider reported a usage limit/);
		assert.match(snapshot.blockedAudit.blocker, /insufficient_quota/, "the evidence is recorded");

		const stopped = await session.waitForNotify((r) => r.message.includes("is now usage_limited"));
		assert.ok(stopped.message.includes("insufficient_quota"), "the evidence is surfaced");
		assert.ok(stopped.message.includes("never continues on its own"));

		assert.equal(continuationEntries(entries).length, 1, "only the kickoff settlement continued");
		assert.equal(runCount(session), 2, "the failed run was not retried by the Goal");
		assertStepsConsumed(session, 2, [{ stopReason: "error", errorMessage: USAGE_LIMIT_ERROR }]);

		// A usage-limited Goal never continues, even after a successful run.
		await session.prompt("try again please");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 1, "no continuation after a usage limit");
		assert.equal(runCount(session), 3);
		assert.equal(lastGoalSnapshot(after).data.goal.status, "usage_limited");
		assertStepsConsumed(session, 3, [{ stopReason: "error", errorMessage: USAGE_LIMIT_ERROR }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a terminal provider error stops the continuation, surfaces the error, and keeps the Goal active", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer." },
			{ error: TERMINAL_ERROR },
			{ text: "Recovered answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		// The error is surfaced, with the reason it is not a usage limit.
		const surfaced = await session.waitForNotify((r) => r.message.includes("automatic continuation stopped for this run"));
		assert.ok(surfaced.message.includes(TERMINAL_ERROR), "the provider error text is surfaced");
		assert.ok(surfaced.message.includes("is still active"), "the Goal is not misreported as stopped");
		assert.ok(surfaced.message.includes("Pi is not retrying it"), "the retry position is stated accurately");

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active", "the Goal outlives the failure");
		assert.equal(continuationEntries(entries).length, 1, "the failed run added no continuation");
		assert.equal(runCount(session), 2);
		assertStepsConsumed(session, 2, [{ stopReason: "error", errorMessage: TERMINAL_ERROR }]);

		// The Goal continues once a run succeeds again.
		await session.prompt("Please recover and finish");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 2);
		assert.equal(runCount(session), 4);
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assertStepsConsumed(session, 5, [{ stopReason: "error", errorMessage: TERMINAL_ERROR }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a transient provider error Pi retries itself is neither a usage limit nor a Goal stop", async () => {
	const session = await PiRpcSession.start({
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
	});
	script(
		[
			{ text: "Kickoff answer." },
			{ error: "503 upstream overloaded" },
			{ error: "503 upstream overloaded" },
			{ error: "503 upstream overloaded" },
			{ text: "Recovered answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		await session.waitForSettled(1);

		assert.ok(session.records.some((r) => r.type === "auto_retry_start"), "Pi retried on its own");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active", "Pi gave up on its own retries");
		assert.equal(continuationEntries(entries).length, 1, "the Goal contributed one continuation");
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && /usage_limited/.test(String(r.message)),
			),
			"a retried transient failure is not classified as a usage limit",
		);
		assertStepsConsumed(session, 4, [
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
		]);

		// The Goal continues once a run succeeds again.
		await session.prompt("Please recover and finish");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 2);
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assert.equal(
			lastGoalSnapshot(after).data.goal.blockedAudit,
			undefined,
			"a transient failure never becomes a usage limit or a blocker",
		);
		assertStepsConsumed(session, 7, [
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
		]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("an abort resets the anti-loop counters instead of counting as a Goal malfunction", async () => {
	const session = await PiRpcSession.start();
	// Two empty Goal turns, then a Goal turn the user aborts, then one more empty
	// turn. Without the reset that last turn would be the third in a row.
	script(
		[
			{ text: "Kickoff answer." },
			EMPTY_RESPONSE,
			EMPTY_RESPONSE,
			{ hang: true },
			EMPTY_RESPONSE,
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		// Wait until the hanging Goal turn is provably in flight (kickoff plus two
		// empty Goal turns have been served).
		await session.waitFor(
			"the hanging Goal turn started",
			(records) => (records.filter((r) => r.type === "turn_start").length >= 4 ? true : undefined),
		);

		await session.sendSimple("abort");
		const settled = await session.waitForSettled(1);
		assert.equal(settled.aborted, true);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 3, "three Goal turns were drafted");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active", "the abort did not block the Goal");
		assert.equal(lastGoalSnapshot(entries).data.goal.blockedAudit, undefined);

		// The Goal resumes on the next run and completes normally.
		await session.prompt("Please keep going");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assert.equal(continuationEntries(after).length, 4);
		assert.ok(
			!session.records.some((r) => r.type === "extension_ui_request" && String(r.message).includes("activity-free")),
			"the abort reset the activity-free counter",
		);
		assertStepsConsumed(session, 7, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a queued user prompt restarts the blocked audit at one", async () => {
	const session = await PiRpcSession.start();
	// The gated response holds the first Goal turn open after its blocker report,
	// so the user's message is queued while Pi is provably busy, with no race.
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Still waiting.", waitForFile: gate },
			{ text: "I had another look." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Waiting." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await startGoal(session);
		// The kickoff turn plus the first Goal turn: the latter is provably held by
		// the gate, so queueing now cannot race with the run finishing.
		await session.waitFor(
			"the first Goal turn started",
			(records) => (records.filter((r) => r.type === "turn_start").length >= 2 ? true : undefined),
		);

		// The user acts while the Goal turn is in flight. That is a user action, so
		// the blocked audit restarts even though the Goal keeps running.
		const queued = await session.followUp("please take another look");
		assert.equal(queued.data.disposition, "queued");
		writeFileSync(gate, "", "utf8");

		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 3);
		assert.match(String(results[0].result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		// The same blocker again, but after a user action: a fresh audit.
		assert.match(
			String(results[1].result.content[0].text),
			/Blocker recorded \(1 of 3 consecutive Goal turns\)/,
			"the user action restarted the audit",
		);
		assert.equal(structuredGoal(results[1].result).status, "active");
		assert.equal(results[2].isError, false, "the Goal completed normally");

		// The user's message reached the model inside the run that was active.
		const { messages } = await session.sendSimple("get_messages");
		assert.ok(
			messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("please take another look")),
			"the queued user message was delivered",
		);

		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = entries.filter((e) => e.customType === "goal-state");
		// The reset is durable: a snapshot without the audit sits between the two
		// reports, so a reload cannot resurrect the count the user invalidated.
		assert.ok(
			snapshots.some((e) => e.data.goal.blockedAudit === undefined && e.data.goal.status === "active"),
			"the reset was persisted",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(runCount(session), 4, "kickoff plus three Goal turns");
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a session without a Goal keeps its ordinary behavior", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "Only answer." }, { text: "Never requested." }], session);
	try {
		const response = await session.prompt("Hello there");
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);

		assert.equal(runCount(session), 1, "exactly one run");
		assert.equal(assistantOutcomes(session).length, 1, "the second scripted step was never requested");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(entries.filter((e) => e.customType === "goal-state").length, 0);
		assert.equal(continuationEntries(entries).length, 0);
		assertStepsConsumed(session, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});
