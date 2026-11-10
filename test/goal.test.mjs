/**
 * Issue #2 acceptance tests: create and restore a persistent Goal.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: RPC events, extension UI
 * notifications, tool results, and persisted session entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertOnlyFailures,
	lastGoalSnapshot,
	readSessionEntries,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/**
 * Stop an active Goal's continuation loop deliberately.
 *
 * A missing scripted-provider step would also stop it, but that settles the test
 * on a provider error rather than on the Goal lifecycle. An aborted run is Pi's
 * documented hard exit, so the Goal stays active and the stop is explicit: the
 * caller asserts the aborted outcome instead of hiding it.
 *
 * `runs` is the number of agent runs the test expects before the abort, so the
 * abort always has a run in flight.
 */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

test("loading the extension exposes /goal and leaves Goal-less sessions unchanged", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "Hello from the scripted provider." }], session);
	try {
		// /goal is discoverable as an extension command.
		const { commands } = await session.getCommands();
		assert.ok(commands.some((c) => c.name === "goal" && c.source === "extension"));

		// An ordinary prompt runs exactly one agent run and settles normally.
		const response = await session.prompt("Hello there");
		assert.equal(response.success, true);
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 1);
		assert.equal(session.extensionErrors().length, 0);

		// The session stays Goal-free: no goal entries were persisted.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(entries.filter((e) => e.type === "custom" && e.customType === "goal-state").length, 0);

		// Bare /goal in a Goal-less session reports that clearly (no run started).
		const status = await session.prompt("/goal");
		assert.equal(status.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		assert.equal(notify.notifyType, "info");
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 1);
		// Goal-less sessions never report a restored Goal.
		assert.ok(!session.records.some((r) => r.type === "extension_ui_request" && r.message?.includes("restored")));
	} finally {
		await session.stop();
	}
});

test("/goal <objective> stores an active Goal, starts initial work, and get_goal returns structured state", async () => {
	const session = await PiRpcSession.start();
	// Kickoff run, the continuation it triggers, and a held response so the loop
	// can be stopped deliberately instead of by a missing scripted step.
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }], usage: { input: 120, output: 8 } },
			{ text: "Goal retrieved. Starting work.", usage: { input: 150, output: 12 } },
			{ hang: true },
		],
		session,
	);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.success, true);
		assert.equal(response.data.disposition, "handled");

		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The kickoff message started initial work: one run with a get_goal tool call.
		await session.waitForToolResult("get_goal", 1);
		// Stop the continuing loop deliberately. The abort is the only non-clean
		// outcome, and it is the reason the session settled.
		const settled = await abortActiveLoop(session, 2);
		assert.equal(settled.aborted, true);
		assert.equal(session.extensionErrors().length, 0);

		// get_goal returned the structured state to the model.
		const toolEnd = session.records.find((r) => r.type === "tool_execution_end" && r.toolName === "get_goal");
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.objective, OBJECTIVE);
		assert.equal(state.status, "active");
		assert.equal(state.revision, 0);
		assert.ok(state.id.startsWith("goal_"));
		assert.equal(state.tokenBudget, null);
		assert.equal(state.usage.totalTokens, null);
		assert.equal(state.usage.activeSeconds, null);

		// The kickoff user message carried the objective into model context.
		const kickoffEnd = session.records.find(
			(r) => r.type === "message_end" && r.message.role === "user" && JSON.stringify(r.message.content).includes(OBJECTIVE),
		);
		assert.ok(kickoffEnd, "kickoff user message was sent");

		// The Goal snapshot is persisted as a custom entry outside model context.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries);
		assert.ok(snapshot, "goal-state custom entry persisted");
		assert.equal(snapshot.data.version, 1);
		assert.equal(snapshot.data.goal.objective, OBJECTIVE);
		assert.equal(snapshot.data.goal.status, "active");
		assert.ok(
			entries.some(
				(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(OBJECTIVE),
			),
			"kickoff user message persisted in the session file",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("bare /goal reports objective, lifecycle status, and available usage fields", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, its continuation, and a held response so the loop can be stopped
	// deliberately with the Goal still active.
	script([{ text: "On it." }, { text: "Continuing." }, { hang: true }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await abortActiveLoop(session, 3);

		const runsBefore = session.records.filter((r) => r.type === "agent_start").length;
		const response = await session.prompt("/goal");
		assert.equal(response.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes(OBJECTIVE));
		assert.equal(notify.notifyType, "info");
		assert.match(notify.message, /active/);
		assert.match(notify.message, /Revision: 0/);
		assert.match(notify.message, /Token usage: not tracked yet/);
		assert.match(notify.message, /Active time: not tracked yet/);

		// Status reporting never starts an agent run by itself.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, runsBefore);

		// The reported fields agree with get_goal's structured state.
		const toolEnd = session.records.find((r) => r.type === "tool_execution_end" && r.toolName === "get_goal");
		if (toolEnd) {
			const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
			assert.equal(state.objective, OBJECTIVE);
			assert.equal(state.status, "active");
		}
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("restart and resume reconstruct the Goal without restating it", async () => {
	// Pi resumes a session in its stored working directory, so both processes
	// share one test-owned work dir.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-workdir-"));
	// Process 1: create the Goal and let the initial work settle.
	const first = await PiRpcSession.start({ cwd: workDir });
	// Kickoff, its continuation, and a held response so the loop can be stopped
	// deliberately with the Goal still active.
	script([{ text: "On it." }, { text: "Continuing." }, { hang: true }], first);
	// The session outlives process 1's temp dirs: copy it aside before cleanup.
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	let sessionFile;
	try {
		await first.prompt("/goal Ship the release notes page");
		await abortActiveLoop(first, 3);
		sessionFile = await first.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	// Process 2: a fresh Pi process resumes the persisted session.
	const second = await PiRpcSession.start({ sessionFile, cwd: workDir });
	// One run, its continuation, and a held response so the loop can be stopped
	// deliberately with the Goal still active.
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ text: "Resumed and working." },
			{ hang: true },
		],
		second,
	);
	try {
		// Restoration is visible at session start, before any prompt.
		const restored = await second.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.match(restored.message, /goal_[0-9a-f]+/);

		const resumed = await second.prompt("Please continue working on the current objective");
		assert.equal(resumed.data.disposition, "started");
		const toolEnd = await second.waitForToolResult("get_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.objective, "Ship the release notes page");
		assert.equal(state.status, "active");
		await abortActiveLoop(second, 2);

		// Bare /goal also reports the restored objective.
		await second.prompt("/goal");
		const notify = await second.waitForNotify((r) => r.message.includes("Ship the release notes page"));
		assert.match(notify.message, /active/);

		// The persisted identity is stable across the restart.
		const entries = readSessionEntries(sessionFile);
		const snapshot = lastGoalSnapshot(entries);
		assert.equal(snapshot.data.goal.id, state.id);
		assertOnlyFailures(second, [{ stopReason: "aborted" }]);
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("extension reload reconstructs the Goal (runtime replacement via session switch)", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, its continuation, and a held response so the loop can be stopped
	// deliberately with the Goal still active.
	script([{ text: "On it." }, { text: "Continuing." }, { hang: true }], session);
	try {
		await session.prompt("/goal Restore me after reload");
		await abortActiveLoop(session, 3);
		const sessionFile = await session.sessionFile();

		// No runtime replacement has happened yet: no restored notification exists.
		assert.ok(
			!session.records.some((r) => r.type === "extension_ui_request" && r.message?.includes("restored")),
			"startup had no Goal, so nothing was restored yet",
		);

		// Switching to the same session file replaces the extension runtime
		// (session_shutdown -> reload -> session_start), the same reconstruction
		// path an interactive /reload exercises.
		const id = "switch-1";
		const switchResponse = session.waitFor(
			"switch_session response",
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		session.proc.stdin.write(JSON.stringify({ id, type: "switch_session", sessionPath: sessionFile }) + "\n");
		const switched = await switchResponse;
		assert.equal(switched.success, true);
		assert.equal(switched.data.cancelled, false);

		// The replaced runtime proves it reloaded: the new extension instance
		// reports the restored Goal from its own session_start handler. The
		// notification is emitted during the replacement, before the switch
		// response is sent, so it could not come from the old runtime.
		const restored = await session.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.match(restored.message, /Restore me after reload|goal_[0-9a-f]+/);

		// The reloaded extension reports the same Goal.
		await session.prompt("/goal");
		const notify = await session.waitForNotify(
			(r) => r.message.includes("Restore me after reload") && r.message.includes("active"),
		);
		assert.ok(notify);

		const entries = readSessionEntries(sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, "Restore me after reload");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("ephemeral sessions return a clear persistence error and create nothing", async () => {
	const session = await PiRpcSession.start({ noSession: true });
	script([{ text: "should never run" }], session);
	try {
		const response = await session.prompt("/goal This goal cannot persist");
		assert.equal(response.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes("not persistent"));
		assert.equal(notify.notifyType, "error");
		assert.match(notify.message, /--no-session/);

		// No run was started and no Goal was claimed.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0);
		assert.equal(session.records.filter((r) => r.type === "message_end" && r.message.role === "custom").length, 0);
		const state = await session.getState();
		assert.equal(state.sessionFile, undefined);
	} finally {
		await session.stop();
	}
});

test("a failed session write leaves no phantom Goal and permits a retry", async () => {
	const session = await PiRpcSession.start();
	// Step 0 warms up the session, step 1 serves the retried kickoff, step 2 its
	// continuation, and the last step is held so the loop stops deliberately.
	script([{ text: "On it." }, { text: "Retry worked." }, { text: "Continuing." }, { hang: true }], session);
	let sessionFile;
	try {
		// Establish a known session file with one ordinary run.
		await session.prompt("warm up");
		await session.waitForSettled(1);
		sessionFile = await session.sessionFile();

		// Make the session file unwritable so the Goal snapshot cannot be persisted.
		chmodSync(sessionFile, 0o444);
		const failed = await session.prompt("/goal This goal cannot be stored");
		assert.equal(failed.data.disposition, "handled");
		const error = await session.waitForNotify((r) =>
			r.message.includes("writing the Goal to the session failed"),
		);
		assert.equal(error.notifyType, "error");

		// No phantom Goal in memory: bare /goal reports none and no kickoff ran.
		await session.prompt("/goal");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 1);

		// The session file contains no goal-state entry from the failed attempt.
		const entriesAfterFailure = readSessionEntries(sessionFile);
		assert.equal(entriesAfterFailure.filter((e) => e.type === "custom" && e.customType === "goal-state").length, 0);

		// Once the write failure is resolved, creating a Goal succeeds.
		chmodSync(sessionFile, 0o644);
		const retry = await session.prompt("/goal This goal persists after the write failure");
		assert.equal(retry.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		// Warm-up run, kickoff, continuation, then the held response.
		await abortActiveLoop(session, 4);
		const snapshot = lastGoalSnapshot(readSessionEntries(sessionFile));
		assert.ok(snapshot, "goal-state entry persisted after retry");
		assert.equal(snapshot.data.goal.objective, "This goal persists after the write failure");
		assert.equal(snapshot.data.goal.status, "active");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		// Restore writability so shutdown flushes cleanly.
		if (sessionFile) {
			try {
				chmodSync(sessionFile, 0o644);
			} catch {
				// best effort
			}
		}
		await session.stop();
	}
});

test("interrupting the kickoff run preserves the durable Goal", async () => {
	// Fresh persistent session; the provider hangs so the kickoff run never
	// produces an assistant response. Both processes share one work dir because
	// Pi resumes a session in its stored working directory.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-workdir-"));
	const session = await PiRpcSession.start({ cwd: workDir });
	script([{ hang: true }], session);
	// The killed session must outlive process 1's temp-dir cleanup.
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	let killedSessionFile;
	try {
		const response = await session.prompt("/goal Survive an interrupted kickoff");
		assert.equal(response.data.disposition, "handled");

		// Success is announced only after the snapshot is confirmed on disk.
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.equal(
			session.records.filter((r) => r.type === "message_end" && r.message.role === "assistant").length,
			0,
			"no assistant response was produced before the kill",
		);

		// Hard-kill Pi mid-run: no graceful shutdown, no atexit flush.
		session.killNow();
		await session.waitForExit();

		// The Goal (and the kickoff user message) survived on disk.
		killedSessionFile = session.findSessionFile();
		const entries = readSessionEntries(killedSessionFile);
		const snapshot = lastGoalSnapshot(entries);
		assert.ok(snapshot, "goal-state entry is on disk after the kill");
		assert.equal(snapshot.data.goal.objective, "Survive an interrupted kickoff");
		assert.equal(snapshot.data.goal.status, "active");
		assert.ok(
			entries.some(
				(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("Survive an interrupted kickoff"),
			),
			"kickoff user message is on disk after the kill",
		);
		copyFileSync(killedSessionFile, join(resumedDir, basename(killedSessionFile)));
	} finally {
		await session.stop();
	}
	killedSessionFile = join(resumedDir, basename(killedSessionFile));

	// A later process restores the interrupted Goal from the killed session.
	const resumed = await PiRpcSession.start({ sessionFile: killedSessionFile, cwd: workDir });
	try {
		const restored = await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.match(restored.message, /Survive an interrupted kickoff|goal_[0-9a-f]+/);
		await resumed.prompt("/goal");
		await resumed.waitForNotify(
			(r) => r.message.includes("Survive an interrupted kickoff") && r.message.includes("active"),
		);
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("two /goal commands issued while Pi is busy create exactly one Goal", async () => {
	const session = await PiRpcSession.start();
	// Step 0 hangs the ordinary run; step 1 answers the winner's kickoff.
	// The hanging run is aborted; the winner's kickoff and its continuation each
	// need a step, and the last one is held so the loop stops deliberately.
	script([{ hang: true }, { text: "Kickoff done." }, { text: "Continuing." }, { hang: true }], session);
	try {
		// Start an ordinary run that never settles.
		const started = await session.prompt("start something slow");
		assert.equal(started.data.disposition, "started");
		// Wait until the hanging request is provably in flight: the scripted
		// provider has emitted the assistant message_start of the stuck stream.
		// This pins which run consumes the hang step and guarantees the abort
		// below has an active run to abort.
		await session.waitFor(
			"hanging run streaming",
			(records) =>
				records.some((r) => r.type === "message_start" && r.message?.role === "assistant") ? true : undefined,
		);

		// Two /goal commands while busy: both handlers must wait for idle and
		// then serialize — the second has to refuse, not replace the first.
		session.writeCommand({ id: "goal-1", type: "prompt", message: "/goal First concurrent objective" });
		session.writeCommand({ id: "goal-2", type: "prompt", message: "/goal Second concurrent objective" });

		// Abort the hanging run: idle returns, both queued creations run.
		session.writeCommand({ id: "abort-1", type: "abort" });

		// Exactly one creation succeeds.
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.equal(
			session.records.filter((r) => r.type === "extension_ui_request" && r.message?.includes("created and activated")).length,
			1,
			"exactly one Goal was created",
		);

		// The loser's handler is serialized behind the winner's, and it waits for
		// idle — which the new active Goal keeps busy. So the continuation loop has
		// to be stopped deliberately before the refusal can be reached, and that
		// stop is also what releases the loser. Runs so far: the aborted hang, the
		// kickoff, its continuation, and a held response.
		await abortActiveLoop(session, 4);

		// Now the loser confirms: replacing an existing Goal needs the user's
		// explicit confirmation, and the test declines on the user's behalf.
		await session.respondToConfirm(() => true, false);
		await session.waitForNotify((r) => r.message.includes("Replacement cancelled"));
		assert.equal(
			session.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm").length,
			1,
			"exactly one replacement confirmation was asked",
		);

		// No kickoff delivery was rejected (the original defect surfaced as an
		// extension error from the loser's sendUserMessage while streaming).
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));

		const first = await session.waitFor(
			"goal-1 response",
			(records) => records.find((r) => r.type === "response" && r.id === "goal-1"),
		);
		const second = await session.waitFor(
			"goal-2 response",
			(records) => records.find((r) => r.type === "response" && r.id === "goal-2"),
		);
		assert.equal(first.data.disposition, "handled");
		assert.equal(second.data.disposition, "handled");

		// Exactly one Goal snapshot was persisted: the first command's.
		const entries = readSessionEntries(await session.sessionFile());
		const goalStates = entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
		assert.equal(goalStates.length, 1, "only one goal-state entry was persisted");
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, "First concurrent objective");

		// The loser's objective never became visible anywhere.
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && r.message?.includes("Second concurrent objective"),
			),
		);
		await session.prompt("/goal");
		const status = await session.waitForNotify(
			(r) => r.message.includes("First concurrent objective") && r.message.includes("active"),
		);
		assert.ok(status);
		// Two deliberate stops: the aborted ordinary run and the aborted
		// continuation loop. No provider error anywhere.
		assertOnlyFailures(session, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("objectives that merely begin with a reserved subcommand word are accepted", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, its continuation, and a held response so the loop stops
	// deliberately with the Goal still active.
	script([{ text: "On it." }, { text: "Continuing." }, { hang: true }], session);
	try {
		const objective = "clear the lint errors and make the build green";
		const response = await session.prompt(`/goal ${objective}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 3);

		await session.prompt("/goal");
		const notify = await session.waitForNotify(
			(r) => r.message.includes(objective) && r.message.includes("active"),
		);
		assert.ok(notify);

		// Exact reserved words are now real subcommands: /goal clear clears the
		// active Goal (durably — a tombstone snapshot), and the session reports
		// that no Goal is set anymore.
		await session.prompt("/goal clear");
		const cleared = await session.waitForNotify((r) => r.message.includes("cleared"));
		assert.equal(cleared.notifyType, "info");
		assert.match(cleared.message, /back to ordinary prompt behavior/);
		await session.prompt("/goal");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		const clearedEntries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(clearedEntries).data.goal, null, "clear wrote a tombstone snapshot");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("create rejects invalid objectives and refuses to replace an existing Goal", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, its continuation, and a held response so the loop stops
	// deliberately with the Goal still active.
	script([{ text: "On it." }, { text: "Continuing." }, { hang: true }], session);
	try {
		// Too short (validation).
		await session.prompt("/goal ab");
		const invalid = await session.waitForNotify((r) => r.message.includes("must be between"));
		assert.equal(invalid.notifyType, "error");

		// Subcommands with no Goal to act on report that clearly instead of
		// pretending a Goal exists.
		await session.prompt("/goal pause");
		const noGoal = await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		assert.equal(noGoal.notifyType, "info");

		// Nothing was created so far.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0);

		// Create one Goal, then attempt to replace it: confirmation is required.
		// The command's response only arrives after the dialog is answered, so the
		// prompt is submitted without awaiting it and the dialog is answered first.
		await session.prompt(`/goal ${OBJECTIVE}`);
		await abortActiveLoop(session, 3);
		const replaceId = "replace-objective";
		const replaceResponse = session.waitFor(
			"response for the replacement attempt",
			(records) => records.find((r) => r.type === "response" && r.id === replaceId),
		);
		session.writeCommand({ id: replaceId, type: "prompt", message: "/goal A different objective entirely" });
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), false);
		const replaced = await replaceResponse;
		assert.equal(replaced.data.disposition, "handled");
		const kept = await session.waitForNotify((r) => r.message.includes("Replacement cancelled"));
		assert.equal(kept.notifyType, "info");

		// The original objective is intact.
		await session.prompt("/goal");
		const notify = await session.waitForNotify((r) => r.message.includes(OBJECTIVE) && r.message.includes("active"));
		assert.ok(notify);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, OBJECTIVE);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});
