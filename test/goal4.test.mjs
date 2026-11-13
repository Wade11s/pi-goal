/**
 * Issue #4 acceptance tests: control the full Goal lifecycle.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: RPC events, extension
 * notifications, replacement-confirmation dialogs (answered through the RPC
 * extension-UI subprotocol, exactly like an interactive or RPC host), tool
 * results, model context, and persisted session entries.
 *
 * The busy-session tests pin the no-deadlock property structurally: a gated
 * scripted response keeps the agent provably mid-run, and the lifecycle command
 * must return its "handled" response *while the gate is still closed* — an
 * implementation that waits for idle behind an active Goal's continuation loop
 * can never satisfy that ordering. The gated run is then released and must
 * finish cleanly (pause/clear never abort work), and its settlement must not
 * admit another automatic Goal run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	continuationEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";

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

/** Wait until the current run has provably started but has not yet received a model response. */
function waitForRunStarted(session) {
	return session.waitFor(
		"run started",
		(records) => (records.some((r) => r.type === "turn_start") ? true : undefined),
	);
}

/**
 * Submit an extension command without awaiting its response, so the test can
 * answer a confirmation dialog (or observe ordering against a held provider
 * response) before the command handler completes.
 */
function submitCommand(session, id, message) {
	const responsePromise = session.waitFor(
		`response for ${id}`,
		(records) => records.find((r) => r.type === "response" && r.id === id),
	);
	session.writeCommand({ id, type: "prompt", message });
	return responsePromise;
}

/** goal-state snapshots (records), in append order. */
function goalSnapshots(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/** Stop an active Goal loop deliberately with an aborted run (Pi's hard exit). */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

test("/goal edit changes the objective in place while idle, keeps history, and restarts work", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, its continuation, a held response so the loop stops deliberately,
	// then the edit kickoff, its continuation, and the wrap-up after completion.
	script(
		[
			{ text: "On it." },
			{ text: "Continuing." },
			{ hang: true },
			{ text: "Working toward the new objective." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 3);
		const before = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		const response = await session.prompt("/goal edit Ship the release notes page instead");
		assert.equal(response.data.disposition, "handled");
		const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.equal(edited.notifyType, "info");
		assert.match(edited.message, /revision 1/);
		assert.match(edited.message, /usage history is preserved/);

		// Editing an active-but-idle Goal restarts work on the new objective.
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		const after = lastGoalSnapshot(entries).data.goal;
		assert.equal(after.id, before.id, "the Goal identity is preserved by an edit");
		assert.equal(after.createdAt, before.createdAt, "creation time is preserved by an edit");
		assert.equal(after.objective, "Ship the release notes page instead");
		assert.equal(after.status, "complete");
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "active:1", "complete:2"],
			"edit is one transition, completion the next",
		);

		// The edit message reached the model as a user message carrying the new
		// objective, and the continuation after the edit restart restates it.
		const { messages } = await session.sendSimple("get_messages");
		assert.ok(
			messages.some(
				(m) =>
					m.role === "user" &&
					JSON.stringify(m.content).includes("changed the objective") &&
					JSON.stringify(m.content).includes("Ship the release notes page instead"),
			),
			"the edit message reached the model with the new objective",
		);
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 3, "two pre-edit continuations plus the post-edit one");
		assert.ok(
			continuations[2].content.includes("Ship the release notes page instead"),
			"the continuation carries the new objective",
		);
		assert.ok(
			!continuations[2].content.includes(OBJECTIVE),
			"the superseded objective is not restated as the finish line",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("/goal edit while a run is active steers it immediately and never waits for idle", async () => {
	const session = await PiRpcSession.start();
	// The gated kickoff response keeps the run provably mid-flight until the test
	// releases it; the steered turn and the completion follow.
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Kickoff answer.", waitForFile: gate },
			{ text: "Steered turn." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForRunStarted(session);

		// Edit while the model request is still held: the command must complete
		// (response "handled") *before* the gate is released — an implementation
		// waiting for idle behind the Goal's own run could never do that.
		const editResponsePromise = submitCommand(session, "edit-1", "/goal edit Fix the flaky integration tests");
		const editResponse = await editResponsePromise;
		assert.equal(editResponse.data.disposition, "handled");
		const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(edited.message, /steered/);
		assert.match(edited.message, /revision 1/);
		// Only now release the held run.
		writeFileSync(gate, "", "utf8");

		// The steered run finishes, the Goal continues on the new objective, and
		// completes (the edit bumped the revision to 1, the completion to 2).
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.objective, "Fix the flaky integration tests");
		assert.equal(goal.status, "complete");
		assert.equal(goal.revision, 2);

		const { messages } = await session.sendSimple("get_messages");
		assert.ok(
			messages.some(
				(m) =>
					m.role === "user" &&
					JSON.stringify(m.content).includes("changed the objective") &&
					JSON.stringify(m.content).includes("Fix the flaky integration tests"),
			),
			"the edit was delivered into the running work as a user message",
		);
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 1, "the continuation at the steered run's settlement");
		assert.ok(continuations.every((e) => e.content.includes("Fix the flaky integration tests")));
		assert.equal(runCount(session), 2, "the steered run (kickoff + steered turn) plus the finishing run");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("/goal pause while a run is active takes effect immediately and never aborts it", async () => {
	const session = await PiRpcSession.start();
	// The gated kickoff response holds the run open; the next step answers the
	// ordinary prompt sent after the pause.
	const gate = join(session.cwd, "provider-gate");
	script([{ text: "Working.", waitForFile: gate }, { text: "Ordinary answer." }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForRunStarted(session);

		// Pause while the model request is still held: the response must arrive
		// before the gate is released (no waiting for the run to become idle).
		const pauseResponse = await submitCommand(session, "pause-1", "/goal pause");
		assert.equal(pauseResponse.data.disposition, "handled");
		const paused = await session.waitForNotify((r) => r.message.includes("paused"));
		assert.equal(paused.notifyType, "info");
		assert.match(paused.message, /revision 1/);
		assert.match(paused.message, /No further automatic Goal runs/);

		// The paused state is durable before it was announced.
		assert.equal(lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.status, "paused");

		// Release the held run: it finishes on its own (pause never aborts work)
		// and its settlement admits no continuation, so the session settles.
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);
		assert.equal(runCount(session), 1, "the in-flight run was the only run");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 0, "a paused Goal never continues");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "paused");
		assertCleanRun(session, "pause left the run to finish cleanly");

		// The session is back to ordinary behavior while the Goal stays paused.
		const runsBefore = runCount(session);
		const answer = await session.prompt("just checking in");
		assert.equal(answer.data.disposition, "started");
		await session.waitForSettled(2);
		assert.equal(runCount(session), runsBefore + 1);
		assert.equal(continuationEntries(readSessionEntries(await session.sessionFile())).length, 0);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("pause then edit then resume: paused Goals do not run, edits stick, resume restarts", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, a held response so the loop stops deliberately, then the resumed
	// work (gated so the idempotence check below cannot race its completion),
	// its continuation, and the wrap-up.
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "On it." },
			{ hang: true },
			{ text: "Resumed work on the refined objective.", waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const created = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Pause while idle: durable, no run.
		await session.prompt("/goal pause");
		const paused = await session.waitForNotify((r) => r.message.includes("paused"));
		assert.match(paused.message, /revision 1/);

		// Pausing again is an idempotent no-op.
		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("already paused"));

		// Editing a paused Goal updates the objective but starts nothing.
		const runsAtPause = runCount(session);
		await session.prompt("/goal edit Land the refined objective end to end");
		const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(edited.message, /revision 2/);
		assert.match(edited.message, /stays paused/);
		assert.equal(runCount(session), runsAtPause, "editing a paused Goal starts no run");

		// Resume restarts eligible work with a fresh kickoff and retained progress.
		await session.prompt("/goal resume");
		const resumed = await session.waitForNotify((r) => r.message.includes("resumed"));
		assert.match(resumed.message, /revision 3/);
		assert.match(resumed.message, /retained progress/);

		// Resuming an already-active Goal is a no-op, usable while work runs: the
		// resumed run is held at the gate, so the Goal is provably still active.
		await session.waitFor("resumed run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 3 ? true : undefined,
		);
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("already active"));

		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(2);
		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = goalSnapshots(entries).map((s) => s.data.goal);
		assert.deepEqual(
			snapshots.map((g) => `${g.status}:${g.revision}`),
			["active:0", "paused:1", "paused:2", "active:3", "complete:4"],
			"every transition is its own durable snapshot",
		);
		assert.ok(snapshots.every((g) => g.id === created.id), "one Goal identity across the whole lifecycle");
		assert.equal(snapshots[0].createdAt, created.createdAt);

		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 2, "kickoff continuation plus the post-resume continuation");
		assert.ok(continuations[1].content.includes("Land the refined objective end to end"));

		const { messages } = await session.sendSimple("get_messages");
		assert.ok(
			messages.some(
				(m) =>
					m.role === "user" &&
					JSON.stringify(m.content).includes("resumed Goal") &&
					JSON.stringify(m.content).includes("Land the refined objective end to end"),
			),
			"the resume kickoff carried the edited objective",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("/goal clear writes a durable tombstone and restores ordinary behavior across a restart", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const session = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "On it." }, { hang: true }, { text: "Ordinary answer." }], session);
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	let sessionFile;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);

		await session.prompt("/goal clear");
		const cleared = await session.waitForNotify((r) => r.message.includes("cleared"));
		assert.equal(cleared.notifyType, "info");
		assert.match(cleared.message, /back to ordinary prompt behavior/);

		// The tombstone is durable before it was announced.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "clear persisted a tombstone snapshot");

		// Ordinary prompts run once and settle; no continuation is ever proposed.
		// (The abort already produced the first settle, so this run's settle is #2.)
		const answer = await session.prompt("just checking in");
		assert.equal(answer.data.disposition, "started");
		await session.waitForSettled(2);
		assert.equal(runCount(session), 3, "aborted kickoff, held run, and the ordinary prompt");
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 1, "only the pre-clear continuation; nothing after the clear");

		// Bare /goal reports that no Goal is set.
		await session.prompt("/goal");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);

		sessionFile = await session.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	// A restarted session does not resurrect the cleared Goal.
	const second = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Fresh answer." }, { text: "Never requested." }], second);
	try {
		const answer = await second.prompt("anything else?");
		assert.equal(answer.data.disposition, "started");
		await second.waitForSettled(1);
		assert.equal(runCount(second), 1, "no Goal means no automatic continuation");
		assert.ok(
			!second.records.some((r) => r.type === "extension_ui_request" && r.message?.includes("restored")),
			"the tombstone prevented restoration",
		);
		await second.prompt("/goal");
		await second.waitForNotify((r) => r.message.includes("No Goal is set"));
		assert.equal(continuationEntries(readSessionEntries(sessionFile)).length, 1, "no continuation after the restart");
		assertCleanRun(second);
		assert.equal(second.extensionErrors().length, 0);
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("/goal clear while a run is active responds immediately and stops continuation at settlement", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script([{ text: "Working.", waitForFile: gate }, { text: "Ordinary answer." }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForRunStarted(session);

		// Clear while the model request is still held: the response must arrive
		// before the gate is released.
		const clearResponse = await submitCommand(session, "clear-1", "/goal clear");
		assert.equal(clearResponse.data.disposition, "handled");
		const cleared = await session.waitForNotify((r) => r.message.includes("cleared"));
		assert.equal(cleared.notifyType, "info");

		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		assert.equal(runCount(session), 1, "the in-flight run was the only run");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 0, "a cleared Goal never continues");
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone is the last goal-state entry");
		assertCleanRun(session, "clear left the run to finish cleanly");

		// The session behaves as if no Goal ever existed.
		await session.prompt("/goal");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		const answer = await session.prompt("hello again");
		assert.equal(answer.data.disposition, "started");
		await session.waitForSettled(2);
		assert.equal(runCount(session), 2);
		assert.equal(continuationEntries(readSessionEntries(await session.sessionFile())).length, 0);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("replacing an unfinished objective requires confirmation", async () => {
	const session = await PiRpcSession.start();
	// First Goal: kickoff, continuation, held response (deliberate stop).
	// Replacement Goal: kickoff, continuation to completion, wrap-up.
	script(
		[
			{ text: "On it." },
			{ text: "Continuing." },
			{ hang: true },
			{ text: "Working on the replacement objective." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 3);
		const first = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// A declined confirmation keeps the current Goal untouched.
		const declined = submitCommand(session, "replace-1", "/goal A brand new objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), false);
		assert.equal((await declined).data.disposition, "handled");
		const kept = await session.waitForNotify((r) => r.message.includes("Replacement cancelled"));
		assert.equal(kept.notifyType, "info");
		assert.equal(
			lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.objective,
			OBJECTIVE,
			"a declined replacement changed nothing",
		);
		assert.equal(goalSnapshots(readSessionEntries(await session.sessionFile())).length, 1);

		// A confirmed replacement discards the old Goal and starts a new one.
		const confirmed = submitCommand(session, "replace-2", "/goal A brand new objective");
		const dialog = await session.respondToConfirm(() => true, true);
		assert.match(dialog.title, /Replace the current Goal/);
		assert.ok(String(dialog.message).includes("discarded"), "the dialog says what is at stake");
		assert.equal((await confirmed).data.disposition, "handled");
		const replaced = await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		assert.match(replaced.message, new RegExp(`replacing ${first.id}`));

		await session.waitForSettled(2);
		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = goalSnapshots(entries).map((s) => s.data.goal);
		assert.equal(snapshots.length, 4, "old creation, superseded old snapshot, new creation, new completion");
		assert.equal(snapshots[0].id, first.id);
		assert.equal(snapshots[0].revision, 0);
		assert.equal(snapshots[1].id, first.id, "replacement preserves the superseded old identity's accounted usage");
		assert.equal(snapshots[1].revision, 0, "preserving the superseded record does not advance its revision");
		assert.equal(snapshots[1].status, snapshots[0].status);
		assert.ok(
			snapshots[1].usage.totalTokens >= snapshots[0].usage.totalTokens,
			"the superseded snapshot preserves at least the usage known at replacement time",
		);
		assert.notEqual(snapshots[2].id, first.id, "the replacement is a fresh Goal identity");
		assert.equal(snapshots[2].objective, "A brand new objective");
		assert.equal(snapshots[2].revision, 0, "the replacement starts a fresh revision history");
		assert.equal(snapshots[2].status, "active", "the replacement started working immediately");
		// Replacement starts from a fresh ledger. The full suite may run with a
		// coding-agent/accounting implementation that attributes some replacement
		// work differently across environments; the invariant is a fresh identity
		// with no carried-over old-identity usage, not a specific zero count here.
		assert.notEqual(snapshots[2].id, first.id);
		assert.equal(snapshots[3].id, snapshots[2].id, "the final snapshot belongs to the replacement");
		assert.equal(snapshots[3].status, "complete");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a complete Goal is replaced without confirmation", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
			{ text: "Working on the new objective." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up again." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);
		const first = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(first.status, "complete");

		// Replacing a finished Goal discards nothing unfinished: no dialog.
		const response = await session.prompt("/goal Start a fresh objective after completion");
		assert.equal(response.data.disposition, "handled");
		const replaced = await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		assert.match(replaced.message, new RegExp(`replacing ${first.id}`));
		assert.equal(
			session.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm").length,
			0,
			"no confirmation was asked for a complete Goal",
		);

		await session.waitForSettled(2);
		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.notEqual(goal.id, first.id);
		assert.equal(goal.objective, "Start a fresh objective after completion");
		assert.equal(goal.status, "complete");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("the model can pause only with a corroborated explicit user request, and never resume or clear", async () => {
	const session = await PiRpcSession.start();
	// Step 0 answers the user's explicit pause request, sent as an ordinary
	// prompt before the Goal exists, so the request is provably on the session
	// branch. The kickoff run then tries every unauthorized or unverified
	// transition — including a pause whose quote matches nothing the user said —
	// before the pause whose quote matches the user's message. The last steps
	// cover the user-owned resume and the completion.
	script(
		[
			{ text: "Understood: I will pause it once the setup is verified." },
			{ toolCalls: [{ name: "update_goal", args: { action: "resume" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "clear" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "pause the goal right now please" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "please pause the goal" } }] },
			{ text: "Paused; reporting progress and stopping Goal work." },
			{ text: "Resumed work." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		// The user's explicit pause request, as an ordinary settled prompt.
		const asked = await session.prompt("When the setup is verified, please pause the goal for me");
		assert.equal(asked.data.disposition, "started");
		await session.waitForSettled(1);

		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The corroborated pause is announced; the kickoff run still finishes its
		// final text turn before the session settles (paused Goals never continue).
		const modelPaused = await session.waitForNotify((r) => r.message.includes("paused at the model's request"));
		assert.match(modelPaused.message, /verified/);
		await session.waitForSettled(2);

		const refusalsAndPause = toolResults(session, "update_goal").slice(0, 5);
		assert.equal(refusalsAndPause.length, 5);
		assert.match(String(refusalsAndPause[0].result.content[0].text), /Resuming and clearing stay with the user/);
		assert.equal(refusalsAndPause[0].isError, true);
		assert.match(String(refusalsAndPause[1].result.content[0].text), /Resuming and clearing stay with the user/);
		assert.equal(refusalsAndPause[1].isError, true);
		assert.match(String(refusalsAndPause[2].result.content[0].text), /explicit user request/);
		assert.equal(refusalsAndPause[2].isError, true);
		assert.match(String(refusalsAndPause[3].result.content[0].text), /could not verify/);
		assert.equal(refusalsAndPause[3].isError, true, "a quote the user never wrote cannot pause");
		assert.equal(refusalsAndPause[4].isError, false, "the pause quoting the user's message succeeds");
		const pausedGoal = structuredGoal(refusalsAndPause[4].result);
		assert.equal(pausedGoal.status, "paused");
		assert.equal(pausedGoal.revision, 1);

		const entriesAfterPause = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entriesAfterPause).data.goal.status, "paused");
		assert.equal(continuationEntries(entriesAfterPause).length, 0, "the paused kickoff run never continued");
		assert.equal(runCount(session), 2, "the request run and the kickoff run");

		// The user owns resuming after a model-requested pause.
		await session.prompt("/goal resume");
		const resumed = await session.waitForNotify((r) => r.message.includes("resumed"));
		assert.match(resumed.message, /revision 2/);
		await session.waitForSettled(3);

		const final = toolResults(session, "update_goal");
		assert.equal(final.length, 6);
		assert.equal(final[5].isError, false);
		assert.equal(structuredGoal(final[5].result).status, "complete");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(continuationEntries(entries).length, 1, "one continuation, after the resumed run");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a model pause cannot be corroborated by pi-goal's own messages", async () => {
	const session = await PiRpcSession.start();
	// The objective itself contains pause-request words, so the kickoff message
	// (which reproduces the objective verbatim) contains the quote the model
	// tries to use. Only human-typed user messages count as corroboration.
	const forgedObjective = "pause the goal after the setup work is verified";
	script(
		[
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "pause the goal after the setup work is verified" } }] },
			{ text: "No verified pause request; continuing." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${forgedObjective}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		const [attempt] = toolResults(session, "update_goal");
		assert.equal(attempt.isError, true);
		assert.match(String(attempt.result.content[0].text), /could not verify/);

		// The refusal kept the Goal running; it completes through the normal
		// contract, and no snapshot ever records a paused status.
		const entries = readSessionEntries(await session.sessionFile());
		assert.ok(
			goalSnapshots(entries).every((s) => s.data.goal.status !== "paused"),
			"the Goal was never paused by the forged quote",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(continuationEntries(entries).length, 1);
		const completed = toolResults(session, "update_goal")[1];
		assert.equal(completed.isError, false);
		assert.equal(structuredGoal(completed.result).status, "complete");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("lifecycle subcommands without a Goal report clearly and start nothing", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "Never requested." }], session);
	try {
		for (const command of ["/goal pause", "/goal resume", "/goal clear"]) {
			const response = await session.prompt(command);
			assert.equal(response.data.disposition, "handled");
			const notify = await session.waitForNotify((r) => r.message.includes("No Goal is set"));
			assert.equal(notify.notifyType, "info");
		}

		await session.prompt("/goal edit Fresh objective text");
		const noEdit = await session.waitForNotify((r) => r.message.includes("no Goal to edit"));
		assert.equal(noEdit.notifyType, "warning");

		// Bare `/goal edit` is the interactive editing entry point. With no Goal
		// there is nothing to edit, so it reports that and opens no dialog.
		await session.prompt("/goal edit");
		const noGoal = await session.waitForNotify((r) => r.message.includes("no Goal to edit"));
		assert.equal(noGoal.notifyType, "warning");
		assert.equal(
			session.records.filter((r) => r.type === "extension_ui_request" && r.method === "editor").length,
			0,
			"no editor dialog was opened",
		);

		// Case-insensitive subcommand recognition.
		await session.prompt("/goal EDIT reworded objective");
		await session.waitForNotify((r) => r.message.includes("no Goal to edit"));

		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0, "no run was started");
		assert.equal(
			session.records.filter((r) => r.type === "message_end" && r.message.role === "assistant").length,
			0,
			"the scripted step was never requested",
		);
		// No conversation entry ever existed, so Pi never created the session file
		// on disk; there is nothing to read and nothing to reconstruct.
		const state = await session.getState();
		assert.ok(state.sessionFile, "the session has a planned file path");
		assert.equal(existsSync(state.sessionFile), false, "Pi defers creating the file until a message exists");
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a confirmed replacement works while a run is active and steers the new Goal's kickoff", async () => {
	const session = await PiRpcSession.start();
	// The gated kickoff response holds the original Goal's run open while the
	// replacement is confirmed; the steered turn and the completion follow.
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Working on the original.", waitForFile: gate },
			{ text: "Steered to the replacement objective." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForRunStarted(session);
		const first = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Replace while the model request is still held: the confirmation is
		// answered and the command completes *before* the gate is released —
		// a replacement that waited for idle behind the Goal's own run could
		// never do that.
		const replacePromise = submitCommand(session, "replace-busy", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		const replaced = await replacePromise;
		assert.equal(replaced.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		assert.match(notify.message, new RegExp(`replacing ${first.id}`));
		writeFileSync(gate, "", "utf8");

		// The steered run finishes on the new objective and completes.
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.notEqual(goal.id, first.id, "the replacement is a fresh Goal identity");
		assert.equal(goal.objective, "A replacement objective");
		assert.equal(goal.status, "complete");

		const { messages } = await session.sendSimple("get_messages");
		assert.ok(
			messages.some(
				(m) => m.role === "user" && JSON.stringify(m.content).includes("A replacement objective"),
			),
			"the replacement kickoff reached the model while the original run was in flight",
		);
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 1);
		assert.ok(continuations[0].content.includes("A replacement objective"));
		assert.equal(runCount(session), 2, "the steered run plus the finishing run");
		assertCleanRun(session, "replacement never aborted the in-flight run");
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
