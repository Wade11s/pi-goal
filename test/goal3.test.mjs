/**
 * Issue #3 acceptance tests: continue and complete an active Goal.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: RPC events, extension
 * notifications, tool results, model context, and persisted session entries.
 *
 * Two properties are load-bearing throughout:
 *
 * - `agent_settled` fires only when Pi will not continue automatically, so an
 *   active Goal produces *no* settle until it is completed (or the run aborts or
 *   errors). Waiting for the n-th settle is therefore a sound barrier, and the
 *   number of `agent_start` events minus the number of continuation entries is
 *   exactly the number of runs that were not Goal continuations.
 * - The scripted provider consumes one step per model request, so every script
 *   below is sized to the runs it expects and terminates in a Goal completion.
 *   A script that runs out makes the provider fail, which is itself a hard exit
 *   (see the error test) — it never silently extends the loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	continuationEntries,
	customMessageEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
/** Keep in sync with the customType registered by test/extensions/boundary-peer.ts. */
const PEER_CUSTOM_TYPE = "peer-boundary";
const PEER_EXTENSION = join(import.meta.dirname, "extensions", "boundary-peer.ts");

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

/**
 * Wait until the current run has provably started but has not yet received a model
 * response. Queuing a follow-up here is deterministic: `turn_start` is emitted
 * before the provider request, whereas queueing after the assistant message starts
 * streaming loses the message.
 */
function waitForRunStarted(session) {
	return session.waitFor(
		"run started",
		(records) => (records.some((r) => r.type === "turn_start") ? true : undefined),
	);
}

async function reportStatus(session, matcher) {
	await session.prompt("/goal");
	const notify = await session.waitForNotify(matcher);
	return notify;
}

test("an active Goal continues at settlement with the intact objective and the evidence audit", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, two continuations, then the model completes the Goal. Nothing else
	// can stop the loop, so the script is the loop's bound.
	script(
		[
			{ text: "Kickoff answer." },
			{ text: "First continuation answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 80, output: 25 } },
			{ text: "Unused: the Goal is already complete." },
		],
		session,
	);
	try {
		const created = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(created.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The first settle happens only when the Goal is complete.
		await session.waitForSettled(1);

		// One run per settlement: kickoff + exactly two continuations.
		const entries = readSessionEntries(await session.sessionFile());
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 2, "one continuation per settlement");
		assert.equal(runCount(session), 3, "kickoff plus exactly one run per continuation");

		// Each continuation carries the objective verbatim and the audit contract.
		for (const entry of continuations) {
			assert.match(entry.content, new RegExp(OBJECTIVE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(entry.content, /Original objective \(immutable/);
			assert.match(entry.content, /Evidence audit before continuing/);
			assert.match(entry.content, /Inspect the current files|Read the current files/);
			assert.match(entry.content, /Separate meaningful progress from narration/);
			assert.match(entry.content, /every requirement|every explicit requirement/);
			assert.match(entry.content, /update_goal/);
		}

		// The continuation reached the model as an extension-authored message.
		const { messages } = await session.sendSimple("get_messages");
		const inContext = messages.filter((m) => m.role === "custom" && m.customType === "goal-continuation");
		assert.equal(inContext.length, 2);
		assert.ok(inContext.every((m) => String(m.content).includes(OBJECTIVE)));

		// The model completed the Goal through the tool, with structured output.
		const [completed] = toolResults(session, "update_goal");
		assert.equal(completed.isError, false);
		assert.equal(structuredGoal(completed.result).status, "complete");
		assert.equal(structuredGoal(completed.result).revision, 1);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, OBJECTIVE);

		// A complete Goal never continues: a further completed run adds no entry.
		const response = await session.prompt("anything else to do?");
		assert.equal(response.success, true);
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 2, "no continuation after completion");
		assert.equal(runCount(session), 4, "the new prompt ran once and settled");
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a session without a Goal never continues (negative control for self-loops)", async () => {
	const session = await PiRpcSession.start();
	// Two steps: a Goal-less session must consume only the first.
	script([{ text: "Only answer." }, { text: "Never requested." }], session);
	try {
		const response = await session.prompt("Hello there");
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);

		assert.equal(runCount(session), 1, "exactly one run, no self-loop");
		assert.equal(
			session.records.filter((r) => r.type === "message_end" && r.message.role === "assistant").length,
			1,
			"the second scripted step was never requested",
		);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 0);
		assert.equal(entries.filter((e) => e.customType === "goal-state").length, 0);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("an aborted run does not continue, and the Goal resumes on the next run", async () => {
	const session = await PiRpcSession.start();
	script([{ hang: true }, { text: "Work after the abort." }, { toolCalls: [{ name: "update_goal", args: { action: "complete" } }] }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForRunStarted(session);

		await session.sendSimple("abort");
		const settled = await session.waitForSettled(1);
		assert.equal(settled.aborted, true);

		// The aborted run produced no continuation and the Goal is still active.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 0);
		assert.equal(runCount(session), 1);
		const status = await reportStatus(session, (r) => r.message.includes(OBJECTIVE) && r.message.includes("active"));
		assert.ok(status);

		// The next ordinary run continues normally.
		await session.prompt("Please keep going");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 1);
		assert.equal(runCount(session), 3, "aborted run, ordinary run, one continuation");
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a failed run is a hard exit that does not continue, and the Goal survives it", async () => {
	const session = await PiRpcSession.start();
	// "invalid api key" matches none of Pi's retryable provider-error patterns, so
	// this is a terminal provider failure rather than a transient one.
	script(
		[
			{ text: "Kickoff answer." },
			{ error: "invalid api key" },
			{ text: "Recovered answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		// The errored run ended the session-level run without a continuation, and
		// without any retry: Pi owns retries, the Goal must not add its own loop.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 1, "only the kickoff settled into a continuation");
		assert.equal(runCount(session), 2, "kickoff plus the failed run");
		assert.equal(session.records.filter((r) => r.type === "auto_retry_start").length, 0);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active", "the Goal outlives the failure");

		// The Goal still continues once a run succeeds again.
		await session.prompt("Please recover and finish");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 2);
		assert.equal(runCount(session), 4);
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("automatic retry keeps its normal semantics and adds no Goal continuation", async () => {
	const session = await PiRpcSession.start({
		// Fast, deterministic retry backoff so the retry path is exercised without
		// waiting out Pi's default 2s/4s/8s delays.
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
	});
	// A retryable transient error, retried until Pi's budget is exhausted, then a
	// successful run and the completion.
	script(
		[
			{ text: "Kickoff answer." },
			{ error: "503 upstream overloaded" },
			{ error: "503 upstream overloaded" },
			{ error: "503 upstream overloaded" },
			{ text: "Recovered answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		// Pi retried the transient failure on its own.
		const retries = session.records.filter((r) => r.type === "auto_retry_start");
		assert.ok(retries.length >= 1, "Pi retried the transient provider error");
		assert.equal(session.records.filter((r) => r.type === "auto_retry_end" && r.success === false).length, 1);

		// The Goal contributed exactly one continuation (from the kickoff's
		// settlement) and none for the failed attempts.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 1);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active");

		// Continuation resumes normally afterwards.
		await session.prompt("Please recover and finish");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 2);
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("create_goal creates a durable Goal for an explicit request and refuses a second one", async () => {
	const session = await PiRpcSession.start();
	// The model creates the Goal, immediately tries to create another, works, and
	// completes. All four requests belong to two runs.
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE } }], usage: { input: 120, output: 8 } },
			{ toolCalls: [{ name: "create_goal", args: { objective: "A second objective" } }], usage: { input: 140, output: 8 } },
			{ text: "Working on the objective." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		const response = await session.prompt("Please create a Goal for this task");
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);

		const results = toolResults(session, "create_goal");
		assert.equal(results.length, 2);
		assert.equal(results[0].isError, false, "the first creation succeeds");
		assert.equal(results[1].isError, true, "the second creation is refused");
		assert.match(String(results[1].result.content[0].text), /already set/);

		const created = structuredGoal(results[0].result);
		assert.equal(created.objective, OBJECTIVE);
		assert.equal(created.status, "active");
		assert.equal(created.revision, 0);
		assert.ok(created.id.startsWith("goal_"));

		// Exactly one Goal was persisted: the creation snapshot plus the
		// completion snapshot for that same identity.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = entries.filter((e) => e.customType === "goal-state");
		assert.equal(snapshots.length, 2, "creation and completion snapshots");
		assert.equal(snapshots[0].data.goal.objective, OBJECTIVE);
		assert.equal(snapshots[0].data.goal.id, created.id);
		assert.equal(snapshots[1].data.goal.id, created.id);
		assert.equal(continuationEntries(entries).length, 1, "a model-created Goal continues too");
		assert.equal(runCount(session), 2);

		// The refusal kept the original Goal: it is the one that completes.
		const [completed] = toolResults(session, "update_goal");
		assert.equal(completed.isError, false);
		assert.equal(structuredGoal(completed.result).id, created.id);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("concurrent create_goal calls in one turn create exactly one Goal", async () => {
	const session = await PiRpcSession.start();
	// Two create_goal calls in a single assistant response: they run concurrently,
	// so the existing-Goal guard has to hold without an await between the check
	// and the commit.
	script(
		[
			{
				toolCalls: [
					{ name: "create_goal", args: { objective: "First concurrent objective" } },
					{ name: "create_goal", args: { objective: "Second concurrent objective" } },
				],
			},
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		await session.prompt("Please create a Goal for this task");
		await session.waitForSettled(1);

		const results = toolResults(session, "create_goal");
		assert.equal(results.length, 2);
		assert.equal(results.filter((r) => r.isError).length, 1, "exactly one creation is refused");
		assert.equal(results.filter((r) => !r.isError).length, 1);

		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = entries.filter((e) => e.customType === "goal-state");
		// Creation plus completion of one and the same Goal identity.
		assert.equal(snapshots.length, 2);
		assert.equal(snapshots[0].data.goal.objective, "First concurrent objective");
		assert.equal(snapshots[1].data.goal.id, snapshots[0].data.goal.id);
		assert.equal(
			snapshots.filter((s) => s.data.goal?.objective === "Second concurrent objective").length,
			0,
			"the refused objective never became a Goal",
		);
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && r.message?.includes("Second concurrent objective"),
			),
			"the refused objective was never announced",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("update_goal only completes an active Goal and refuses other transitions", async () => {
	const session = await PiRpcSession.start();
	// An unsupported action, then a call with no action at all, then completion,
	// then a refused repeat once the Goal is already complete.
	script(
		[
			{ toolCalls: [{ name: "update_goal", args: { action: "pause" } }] },
			{ toolCalls: [{ name: "update_goal", args: {} }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Acknowledged." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		const results = toolResults(session, "update_goal");
		assert.equal(results.length, 3);
		assert.equal(results[0].isError, true);
		assert.match(String(results[0].result.content[0].text), /only supports action complete/);
		assert.equal(results[1].isError, true);
		assert.match(String(results[1].result.content[0].text), /only supports action complete/);

		// The refusals left the Goal active; the third call completed it, and the
		// session settled without ever continuing.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 0, "no settlement happened before completion");
		assert.equal(results[2].isError, false);
		assert.equal(structuredGoal(results[2].result).status, "complete");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(runCount(session), 1, "the whole exchange was one run");

		// A second completion attempt is refused rather than double-counted.
		await session.prompt("mark it complete again");
		await session.waitForSettled(2);
		const again = toolResults(session, "update_goal");
		assert.equal(again.length, 4);
		assert.equal(again[3].isError, true);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("update_goal without a Goal reports that none is set and creates nothing", async () => {
	const session = await PiRpcSession.start();
	script([{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] }, { text: "Understood." }], session);
	try {
		const response = await session.prompt("Finish the Goal");
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);

		const [result] = toolResults(session, "update_goal");
		assert.equal(result.isError, true);
		assert.match(String(result.result.content[0].text), /No Goal is set/);
		assert.equal(structuredGoal(result.result), null);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(entries.filter((e) => e.customType === "goal-state").length, 0);
		assert.equal(continuationEntries(entries).length, 0);
		assert.equal(runCount(session), 1);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("create_goal refuses an ephemeral session instead of promising durability", async () => {
	const session = await PiRpcSession.start({ noSession: true });
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE } }] },
			{ text: "Understood." },
		],
		session,
	);
	try {
		const response = await session.prompt("Please create a Goal for this task");
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);

		const [result] = toolResults(session, "create_goal");
		assert.equal(result.isError, true);
		assert.match(String(result.result.content[0].text), /ephemeral/);
		assert.match(String(result.result.content[0].text), /--no-session/);
		assert.equal(structuredGoal(result.result), null);

		// Nothing was created, and the session behaves exactly as before.
		assert.equal(runCount(session), 1);
		const state = await session.getState();
		assert.equal(state.sessionFile, undefined);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("queued follow-up messages keep their normal semantics while a Goal is active", async () => {
	const session = await PiRpcSession.start();
	// The delayed first response holds the run open so the follow-up can be queued
	// while Pi is provably busy.
	script(
		[
			{ text: "Kickoff answer.", delayMs: 800 },
			{ text: "Follow-up answered." },
			{ text: "Continuation after the follow-up." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForRunStarted(session);

		const queued = await session.followUp("also check the tests");
		assert.equal(queued.data.disposition, "queued");

		await session.waitForSettled(1);

		// The queued message was delivered by Pi, inside the run that was already
		// active, and the Goal continued after it.
		const { messages } = await session.sendSimple("get_messages");
		const roles = messages.map((m) => m.role);
		assert.ok(roles.includes("user"), "the follow-up user message reached the model");
		assert.ok(
			messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("also check the tests")),
			"the queued text was delivered verbatim",
		);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 2, "the Goal kept continuing around the queued work");
		assert.equal(runCount(session), 3, "one run carried the queued message; two continuations followed");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("compaction preserves the Goal, and continuation keeps working afterwards", async () => {
	const session = await PiRpcSession.start({
		// Keep almost nothing recent, so a tiny session still has history to
		// summarize and the compaction path is exercised deterministically.
		settings: { compaction: { keepRecentTokens: 1 } },
	});
	// Kickoff, a terminal failure (to reach an idle, settled session), the
	// compaction summary, then the resumption and the completion.
	script(
		[
			{ text: "Kickoff answer." },
			{ error: "pause the session for compaction" },
			{ text: "Compaction summary." },
			{ text: "Answer after compaction." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);
		const goalId = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.id;

		const compacted = await session.sendSimple("compact");
		assert.ok(compacted.summary, "the compaction produced a summary");
		assert.ok(compacted.firstKeptEntryId, "the compaction kept a recent tail");

		// Compaction kept the durable Goal snapshot on the active branch.
		const afterCompact = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(afterCompact);
		assert.ok(snapshot, "the goal-state entry survived compaction");
		assert.equal(snapshot.data.goal.id, goalId);
		assert.equal(snapshot.data.goal.status, "active");
		assert.ok(afterCompact.some((e) => e.type === "compaction"), "a compaction entry was appended");

		// The Goal continues after compaction, and the objective is still in the
		// model context (restated by the continuation, retrievable via get_goal).
		await session.prompt("Please keep going");
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 2, "continuation resumed after compaction");
		assert.equal(runCount(session), 4);

		const { messages } = await session.sendSimple("get_messages");
		assert.ok(
			messages.some((m) => m.role === "custom" && JSON.stringify(m.content).includes(OBJECTIVE)),
			"the objective is still available to the model after compaction",
		);
		assert.equal(lastGoalSnapshot(after).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("boundary entries proposed by another extension are chained, not replaced", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [PEER_EXTENSION] });
	script(
		[
			{ text: "Kickoff answer." },
			{ text: "Continuation answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		const goalEntries = continuationEntries(entries);
		const peerEntries = customMessageEntries(entries, PEER_CUSTOM_TYPE);

		// Both extensions' proposals survived, in handler order.
		assert.equal(goalEntries.length, 2);
		assert.equal(peerEntries.length, 2);
		assert.ok(
			peerEntries.every((e) => e.content === "peer boundary note"),
			"the peer's own entry content survived",
		);
		const order = entries
			.filter((e) => e.type === "custom_message")
			.map((e) => e.customType);
		assert.deepEqual(order, ["goal-continuation", PEER_CUSTOM_TYPE, "goal-continuation", PEER_CUSTOM_TYPE]);

		// Two continuation requests still produced exactly one run per settlement.
		assert.equal(runCount(session), 3, "kickoff plus one run per settlement");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("restoring a completed Goal reconstructs a Goal that will not continue", async () => {
	// The session outlives this process's temp dirs, so it is copied aside.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));

	const first = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "Kickoff answer." }, { toolCalls: [{ name: "update_goal", args: { action: "complete" } }] }], first);
	let sessionFile;
	let continuationsBefore;
	try {
		await first.prompt(`/goal ${OBJECTIVE}`);
		await first.waitForSettled(1);
		sessionFile = await first.sessionFile();
		continuationsBefore = continuationEntries(readSessionEntries(sessionFile)).length;
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const second = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], second);
	try {
		await second.waitForNotify((r) => r.message.includes("restored (complete)"));

		// A restored complete Goal settles an ordinary run without continuing.
		const response = await second.prompt("Do anything else?");
		assert.equal(response.data.disposition, "started");
		await second.waitForSettled(1);
		assert.equal(runCount(second), 1, "a complete Goal never continues, even after a restart");
		assert.equal(
			continuationEntries(readSessionEntries(sessionFile)).length,
			continuationsBefore,
			"no continuation was appended after the restart",
		);

		const entries = readSessionEntries(sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(second.extensionErrors().length, 0);
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});
