/**
 * Deterministic regressions for the PR #12 review blockers.
 *
 * Each case holds a real scripted provider response open (or a blocking RPC
 * confirmation dialog) while user lifecycle commands run, so the ordering is
 * explicit rather than timing-dependent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

function structuredGoal(result) {
	return result.structuredContent?.goal ?? result.details?.goal;
}

function goalSnapshots(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

function submitCommand(session, id, message) {
	const responsePromise = session.waitFor(
		`response for ${id}`,
		(records) => records.find((r) => r.type === "response" && r.id === id),
	);
	session.writeCommand({ id, type: "prompt", message });
	return responsePromise;
}

function waitForTurns(session, count) {
	return session.waitFor(`${count} turn start(s)`, (records) =>
		records.filter((r) => r.type === "turn_start").length >= count ? true : undefined,
	);
}

/** Wait until the on-disk snapshot is the Goal this command has already staged. */
async function waitForStoredGoal(session, predicate, description = "stored Goal") {
	const file = await session.sessionFile();
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		let entries;
		try {
			entries = readSessionEntries(file);
		} catch (error) {
			// Pi defers creating the session file until the first user/assistant
			// message, so the path can be reported before it exists. Treat that as
			// "not written yet" and keep polling instead of failing the first read:
			// under a full parallel `npm test` that window is reachable.
			if (error.code !== "ENOENT") throw error;
			entries = [];
		}
		const snapshot = lastGoalSnapshot(entries);
		const goal = snapshot?.data?.goal;
		if (goal && predicate(goal)) return goal;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

/** Pause the active Goal after deliberately aborting its continuation loop. */
async function createPausedGoal(session) {
	await session.prompt(`/goal ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await abortActiveLoop(session, 2);
	await session.prompt("/goal pause");
	await session.waitForNotify((r) => r.message.includes("paused"));
}

async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

test("a held completion cannot complete the Goal a user edited while it was in flight", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Starting work." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], waitForFile: gate },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 2);
		const before = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		const editResponse = await session.prompt("/goal edit Verify a completely different new objective");
		assert.equal(editResponse.data.disposition, "handled");
		const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(edited.message, /revision 1/);

		// The completion was prepared against revision 0. Release it only now.
		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true);
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, before.id);
		assert.equal(refused.objective, "Verify a completely different new objective");
		assert.equal(refused.status, "active");
		assert.equal(refused.revision, 1);

		// Stop the refusing run's continuation loop; the edited Goal stays active.
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "active:1"],
			"the stale completion added no snapshot",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, "Verify a completely different new objective");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a held completion cannot complete a Goal the user replaced while it was in flight", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Working toward the original objective." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], waitForFile: gate },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 2);

		const replacePromise = submitCommand(session, "replace-held", "/goal The replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		const replacement = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true);
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, replacement.id);
		assert.equal(refused.objective, "The replacement objective");
		assert.equal(refused.status, "active");
		assert.equal(refused.revision, 0);

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		await replacePromise;

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => s.data.goal.id === replacement.id ? `new:${s.data.goal.status}:${s.data.goal.revision}` : `old:${s.data.goal.status}:${s.data.goal.revision}`),
			["old:active:0", "old:active:0", "new:active:0"],
			"replacement preserves a durable superseded old-goal record and the stale completion cannot complete the replacement",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.id, replacement.id);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a held completion cannot undo pause then resume", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Starting work." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], waitForFile: gate },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 2);

		await session.prompt("/goal pause");
		const paused = await session.waitForNotify((r) => r.message.includes("paused") && r.message.includes("revision 1"));
		await session.prompt("/goal resume");
		const resumed = await session.waitForNotify((r) => r.message.includes("resumed") && r.message.includes("revision 2"));
		assert.match(resumed.message, /retained progress/);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.status, "active");
		assert.equal(refused.revision, 2);

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "paused:1", "active:2"],
			"resume remains the newest transition",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a held model pause cannot pause the Goal a user edited while it was in flight", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "I will pause later." },
			{ text: "Starting the Goal." },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "please pause the goal" } }], waitForFile: gate },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("When the setup is verified, please pause the goal");
		await session.waitForSettled(1);

		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 3);

		await session.prompt("/goal edit A revised objective");
		const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(edited.message, /revision 1/);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true);
		assert.equal(structuredGoal(stale.result).status, "active");

		await session.sendSimple("abort");
		await session.waitForSettled(2);
		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "active:1"],
			"the held model pause never persisted",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, "A revised objective");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("replacing after a clear in the confirmation consults the cleared state, for either answer", async () => {
	for (const confirmed of [true, false]) {
		const session = await PiRpcSession.start();
		script([{ text: "Old work." }, { hang: true }], session);
		try {
			await createPausedGoal(session);
			const replacePromise = submitCommand(session, `replace-${confirmed}`, "/goal A replacement objective");
			await session.waitFor("replacement confirmation", (records) =>
				records.find((r) => r.type === "extension_ui_request" && r.method === "confirm"),
			);

			const cleared = await session.prompt("/goal clear");
			assert.equal(cleared.data.disposition, "handled");
			const clearedNotify = await session.waitForNotify((r) => r.message.includes("cleared"));
			assert.equal(clearedNotify.notifyType, "info");

			await session.respondToConfirm(() => true, confirmed);
			const replaceResponse = await replacePromise;
			assert.equal(replaceResponse.data.disposition, "handled");
			const cancelled = await session.waitForNotify(
				(r) => r.message.includes("Replacement cancelled") && r.message.includes("no Goal is set anymore"),
			);
			assert.equal(cancelled.notifyType, "warning");
			assert.ok(
				!cancelled.message.includes("current active Goal was kept"),
				"a cleared Goal was not described as kept",
			);

			const entries = readSessionEntries(await session.sessionFile());
			assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone remains last");
			assert.ok(
				goalSnapshots(entries).every((s) => s.data.goal?.objective !== "A replacement objective"),
				"neither answer created the replacement",
			);
			assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		} finally {
			await session.stop();
		}
	}
});

test("replacing after an edit in the confirmation still describes and acts on the current Goal", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "Old work." }, { hang: true }], session);
	try {
		await createPausedGoal(session);
		const replacePromise = submitCommand(session, "replace-after-edit", "/goal A replacement objective");
		const dialog = await session.waitFor("replacement confirmation", (records) =>
			records.find((r) => r.type === "extension_ui_request" && r.method === "confirm"),
		);
		assert.match(String(dialog.message), new RegExp(OBJECTIVE));

		const edited = await session.prompt("/goal edit The revised objective");
		assert.equal(edited.data.disposition, "handled");
		const editNotify = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(editNotify.message, /revision 2/);

		await session.respondToConfirm(() => true, true);
		assert.equal((await replacePromise).data.disposition, "handled");
		const cancelled = await session.waitForNotify((r) => r.message.includes("Replacement cancelled"));
		assert.equal(cancelled.notifyType, "warning");
		assert.match(cancelled.message, /changed while the confirmation was open/);

		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.objective, "The revised objective");
		assert.equal(goal.status, "paused");
		assert.equal(goal.revision, 2);
		assert.ok(
			goalSnapshots(entries).every((s) => s.data.goal?.objective !== "A replacement objective"),
			"Yes discarded nothing and created nothing",
		);
		assert.equal(runCount(session), 2, "no initial work started after the pause");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

async function startHeldOrdinaryRun() {
	const session = await PiRpcSession.start();
	script([{ hang: true }, { text: "Unexpected kickoff run." }], session);
	await session.prompt("hold the run open");
	await session.waitFor("held assistant response started", (records) =>
		records.some((r) => r.type === "message_start" && r.message?.role === "assistant") ? true : undefined,
	);
	await session.sessionFile();
	return session;
}

test("a clear issued while initial creation waits for idle wins over the queued kickoff", async () => {
	const session = await startHeldOrdinaryRun();
	try {
		const createPromise = submitCommand(session, "create-wait-clear", "/goal Creation that must be cancelled");
		const staged = await waitForStoredGoal(
			session,
			(goal) => goal.objective === "Creation that must be cancelled" && goal.status === "active",
			"staged creation",
		);

		const cleared = await session.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		const clearedNotify = await session.waitForNotify((r) => r.message.includes(`Goal ${staged.id} cleared`));
		assert.equal(clearedNotify.notifyType, "info");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assert.equal((await createPromise).data.disposition, "handled");

		const warning = await session.waitForNotify((r) => r.message.includes("was not started"));
		assert.equal(warning.notifyType, "warning");
		assert.match(warning.message, /cleared while creation waited/);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone is last");
		assert.equal(goalSnapshots(entries).filter((s) => s.data.goal?.objective === "Creation that must be cancelled").length, 1, "only the staged creation snapshot");
		assert.equal(runCount(session), 1, "the queued kickoff never ran");
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && r.method === "notify" && r.message.includes("created and activated"),
			),
			"the cancelled creation was never announced as active",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("an edit issued while initial creation waits for idle wins and suppresses the stale kickoff", async () => {
	const session = await startHeldOrdinaryRun();
	try {
		const createPromise = submitCommand(session, "create-wait-edit", "/goal Creation that must be redirected");
		const staged = await waitForStoredGoal(
			session,
			(goal) => goal.objective === "Creation that must be redirected" && goal.status === "active",
			"staged creation",
		);

		const edited = await session.prompt("/goal edit The objective the user chose instead");
		assert.equal(edited.data.disposition, "handled");
		const editNotify = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(editNotify.message, /revision 1/);

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assert.equal((await createPromise).data.disposition, "handled");

		const warning = await session.waitForNotify((r) => r.message.includes("was not started"));
		assert.equal(warning.notifyType, "warning");
		assert.match(warning.message, /changed while creation waited/);

		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.id, staged.id);
		assert.equal(goal.objective, "The objective the user chose instead");
		assert.equal(goal.revision, 1);
		assert.equal(runCount(session), 1, "the queued original kickoff never ran");
		assert.ok(
			!session.records.some(
				(r) =>
					r.type === "message_end" &&
					r.message.role === "user" &&
					JSON.stringify(r.message.content).includes("Creation that must be redirected"),
			),
			"the stale kickoff message was never delivered",
		);
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && r.method === "notify" && r.message.includes("created and activated"),
			),
			"the superseded creation was never announced",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a pause issued while initial creation waits for idle leaves the Goal paused and starts nothing", async () => {
	const session = await startHeldOrdinaryRun();
	try {
		const createPromise = submitCommand(session, "create-wait-pause", "/goal Creation that must be paused");
		const staged = await waitForStoredGoal(
			session,
			(goal) => goal.objective === "Creation that must be paused" && goal.status === "active",
			"staged creation",
		);

		const paused = await session.prompt("/goal pause");
		assert.equal(paused.data.disposition, "handled");
		const pauseNotify = await session.waitForNotify((r) => r.message.includes("paused") && r.message.includes("revision 1"));
		assert.equal(pauseNotify.notifyType, "info");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assert.equal((await createPromise).data.disposition, "handled");

		const warning = await session.waitForNotify((r) => r.message.includes("was not started"));
		assert.equal(warning.notifyType, "warning");
		assert.match(warning.message, /changed while creation waited/);

		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.id, staged.id);
		assert.equal(goal.status, "paused");
		assert.equal(goal.revision, 1);
		assert.equal(continuationEntries(entries).length, 0, "the staged kickoff never continued");
		assert.equal(runCount(session), 1);
		assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && r.method === "notify" && r.message.includes("created and activated"),
			),
			"the paused creation was never announced as active",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a failed replacement write keeps the previous Goal and restores it after a restart", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const session = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "Old Goal work." }, { hang: true }], session);
	let sessionFile;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		sessionFile = await session.sessionFile();

		// The replacement snapshot cannot be appended.
		chmodSync(sessionFile, 0o444);
		const replacePromise = submitCommand(session, "replace-write-failure", "/goal A replacement that cannot be written");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		const failure = await session.waitForNotify((r) =>
			r.message.includes("writing the replacement to the session failed"),
		);
		assert.equal(failure.notifyType, "error");
		assert.match(failure.message, /current Goal is unchanged/);

		// Memory and disk both still hold the original Goal: no tombstone.
		await session.prompt("/goal");
		const status = await session.waitForNotify((r) => r.message.includes(OBJECTIVE));
		assert.match(status.message, /active/);
		assert.match(status.message, new RegExp(`Goal ${original.id}`));
		const onDisk = goalSnapshots(readSessionEntries(sessionFile));
		assert.equal(onDisk.length, 1, "the failed replacement appended no snapshot");
		assert.equal(onDisk[0].data.goal.id, original.id);
		assert.equal(onDisk[0].data.goal.objective, OBJECTIVE);

		chmodSync(sessionFile, 0o644);
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		if (sessionFile) {
			try {
				chmodSync(sessionFile, 0o644);
			} catch {
				// best effort
			}
		}
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const second = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Restored work." }, { hang: true }], second);
	try {
		const restored = await second.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.match(restored.message, /goal_[0-9a-f]+/);
		await second.prompt("/goal");
		const status = await second.waitForNotify((r) => r.message.includes(OBJECTIVE) && r.message.includes("active"));
		assert.ok(status);
		assert.equal(lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal.objective, OBJECTIVE);
		await second.prompt("continue the restored goal");
		await abortActiveLoop(second, 2);
		assertOnlyFailures(second, [{ stopReason: "aborted" }]);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("model pause rejects negated, whole-negated-sentence, and incidental-fragment quotes", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "I will keep working." },
			{ text: "The logs are checked; the migration continues." },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "pause the goal" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "Do not pause the goal; keep working." } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "the" } }] },
			{ text: "No pause was authorized; continuing." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt("Do not pause the goal; keep working.");
		await session.waitForSettled(1);
		await session.prompt("Check the logs and keep going on the migration.");
		await session.waitForSettled(2);

		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForToolResult("update_goal", 3);
		await session.waitForSettled(3);

		const attempts = toolResults(session, "update_goal");
		assert.equal(attempts.length, 4, "three pause attempts then completion");
		assert.equal(attempts[0].isError, true, "the fragment inside a negation is refused");
		assert.match(String(attempts[0].result.content[0].text), /not an affirmative pause instruction/);
		assert.equal(attempts[1].isError, true, "quoting the whole negated sentence is refused");
		assert.match(String(attempts[1].result.content[0].text), /not an affirmative pause instruction/);
		assert.equal(attempts[2].isError, true, "the common word is not a pause request");
		assert.match(String(attempts[2].result.content[0].text), /not itself a pause request/);
		assert.equal(attempts[3].isError, false);
		assert.equal(structuredGoal(attempts[3].result).status, "complete");

		const entries = readSessionEntries(await session.sessionFile());
		assert.ok(
			goalSnapshots(entries).every((s) => s.data.goal.status !== "paused"),
			"the model never persisted a paused status",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(continuationEntries(entries).length, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a newer keep-working message supersedes an older pause request", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Understood: pause when the setup is verified." },
			{ text: "Understood: continue and do not pause." },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "please pause the goal" } }] },
			{ text: "The pause request was superseded; continuing." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt("When the setup is verified, please pause the goal");
		await session.waitForSettled(1);
		await session.prompt("Actually, keep working and do not pause the goal.");
		await session.waitForSettled(2);

		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(3);

		const [stalePause, complete] = toolResults(session, "update_goal");
		assert.equal(stalePause.isError, true);
		assert.match(String(stalePause.result.content[0].text), /not an affirmative pause instruction/);
		assert.equal(complete.isError, false);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.ok(goalSnapshots(entries).every((s) => s.data.goal.status !== "paused"));
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("/goal issued during an ordinary run starts its own kickoff after that run settles", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Ordinary answer.", waitForFile: gate },
			{ text: "Goal kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		const ordinary = await session.prompt("ordinary request");
		assert.equal(ordinary.data.disposition, "started");
		await waitForTurns(session, 1);

		const createPromise = submitCommand(session, "create-busy", "/goal Busy-created objective");
		const staged = await waitForStoredGoal(
			session,
			(goal) => goal.objective === "Busy-created objective" && goal.status === "active",
			"staged Goal",
		);

		// Let the ordinary run finish. Creation must wait for it and then send its
		// own kickoff; the ordinary run must not be adopted as the Goal's first turn.
		writeFileSync(gate, "", "utf8");
		assert.equal((await createPromise).data.disposition, "handled");
		await session.waitForToolResult("update_goal", 1);

		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = goalSnapshots(entries).map((s) => s.data.goal);
		assert.equal(snapshots.length, 2, "creation plus completion");
		assert.equal(snapshots[0].id, staged.id);
		assert.equal(snapshots[0].status, "active");
		assert.equal(snapshots[1].id, staged.id);
		assert.equal(snapshots[1].status, "complete");
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 1);
		assert.ok(continuations[0].content.includes("Busy-created objective"));
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("an edit while initial creation waits ends naturally instead of adopting the run", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Ordinary answer.", waitForFile: gate },
			{ text: "Edited objective answer." },
			{ text: "Unbounded Goal continuation after the ordinary run was adopted." },
			{ hang: true },
		],
		session,
	);
	try {
		const ordinary = await session.prompt("ordinary request");
		assert.equal(ordinary.data.disposition, "started");
		await waitForTurns(session, 1);

		const createPromise = submitCommand(session, "create-edit-natural", "/goal Creation that must not adopt the run");
		const staged = await waitForStoredGoal(
			session,
			(goal) => goal.objective === "Creation that must not adopt the run" && goal.status === "active",
			"staged creation",
		);
		const edited = await session.prompt("/goal edit Edited while creation waited");
		assert.equal(edited.data.disposition, "handled");
		const editNotify = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(editNotify.message, /revision 1/);

		// Release the ordinary run. It must settle naturally; the edit must not
		// turn it into an unbounded continuation or leave the create command
		// waiting for idle forever.
		writeFileSync(gate, "", "utf8");
		const createResponse = await createPromise;
		assert.equal(createResponse.data.disposition, "handled");
		const warning = await session.waitForNotify((r) => r.message.includes("was not started"));
		assert.equal(warning.notifyType, "warning");
		assert.match(warning.message, /changed while creation waited/);
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.id, staged.id);
		assert.equal(goal.objective, "Edited while creation waited");
		assert.equal(goal.status, "active", "the edited Goal remains active but controlled");
		assert.equal(goal.revision, 1);
		assert.equal(runCount(session), 1, "the ordinary run was never restarted as Goal work");
		assert.equal(continuationEntries(entries).length, 0, "the ordinary run was not adopted");
		assert.ok(
			!entries.some(
				(e) =>
					e.type === "message" &&
					e.message.role === "user" &&
					JSON.stringify(e.message.content).includes("Creation that must not adopt the run"),
			),
			"the stale creation kickoff was never delivered",
		);
			assert.ok(
			!session.records.some(
				(r) => r.type === "extension_ui_request" && r.method === "notify" && r.message.includes("created and activated"),
			),
			"the superseded creation was never announced",
		);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("model pause rejects trailing negation and an unrelated park verb", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Okay; no pause." },
			{ text: "The car is parked; no pause." },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "please pause the goal" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "please pause the goal, do not" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", user_request: "please park the car" } }] },
			{ text: "No pause was authorized; continuing." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt("please pause the goal, do not");
		await session.waitForSettled(1);
		await session.prompt("please park the car");
		await session.waitForSettled(2);

		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForToolResult("update_goal", 3);
		await session.waitForSettled(3);

		const attempts = toolResults(session, "update_goal");
		assert.equal(attempts.length, 4, "three pause attempts then completion");
		assert.equal(attempts[0].isError, true, "the clause before a trailing negation is refused");
		assert.match(String(attempts[0].result.content[0].text), /not an affirmative pause instruction/);
		assert.equal(attempts[1].isError, true, "quoting the trailing negation is refused");
		assert.match(String(attempts[1].result.content[0].text), /not an affirmative pause instruction/);
		assert.equal(attempts[2].isError, true, "parking a car is not pausing the Goal");
		assert.match(String(attempts[2].result.content[0].text), /not itself a pause request/);
		assert.equal(attempts[3].isError, false);
		assert.equal(structuredGoal(attempts[3].result).status, "complete");

		const entries = readSessionEntries(await session.sessionFile());
		assert.ok(
			goalSnapshots(entries).every((s) => s.data.goal.status !== "paused"),
			"the model never persisted a paused status",
		);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(continuationEntries(entries).length, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
