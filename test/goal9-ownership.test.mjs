/**
 * Issue #24 batch 1: identity-scoped Goal-owned attribution.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess and asserts the exact
 * accounted totals at public seams (`/goal`), plus the durable entries. The rule
 * under test: only explicitly admitted Goal-owned work is charged — a kickoff, an
 * edit, a resume, an automatic Continuation, or the one Budget wrap-up. Ordinary
 * prompts, creation controls, pre-creation responses, and unrelated same-batch
 * tool results are excluded in every lifecycle status.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	continuationEntries,
	customMessageEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
/** Test-only extension whose outer tool reports nested model usage on its result. */
const NESTED_EXTENSION = join(import.meta.dirname, "extensions", "nested-usage.ts");
const NESTED_OUTER_TOOL = "nested_usage_outer";
/** The leaf's accounted contribution: 40 input + 7 output + 3 cache write. */
const NESTED_LEAF_ACCOUNTED = 50;

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

function goalSnapshots(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/**
 * The newest *current* goal-state snapshot: the one that selects the session's Goal.
 *
 * A snapshot marked `superseded` is a finalized historical record of a replaced
 * identity. It is valid and replayable, but it never becomes the current Goal, so
 * the newest goal-state entry on the branch is not necessarily this one.
 */
function currentGoalSnapshot(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state" && entry.data?.superseded !== true) {
			snapshot = entry;
		}
	}
	return snapshot;
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

async function waitForStoredGoal(session, predicate, description = "stored Goal") {
	const file = await session.sessionFile();
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		let entries;
		try {
			entries = readSessionEntries(file);
		} catch (error) {
			// Pi defers creating the session file until the first user/assistant
			// message, so the path can be reported before it exists.
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

async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/**
 * Read a session file, ignoring a line Pi is still writing.
 *
 * A crash test kills the process at an exact branch position, so it has to observe
 * the file as it is rather than assume a complete last line.
 */
function readBranchEntries(file) {
	const entries = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A partially written line is not an entry yet.
		}
	}
	return entries;
}

/**
 * Wait until the session file holds an entry matching `predicate`, and return the
 * branch *up to and including it*.
 *
 * A crash test needs an exact branch position, and Pi keeps appending while the
 * poll runs, so the prefix is cut at the matching entry rather than taken as the
 * whole file.
 */
async function waitForBranchEntry(file, predicate, description) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		let entries;
		try {
			entries = readBranchEntries(file);
		} catch (error) {
			// Pi defers creating the session file until the first user/assistant
			// message, so the path can be reported before it exists.
			if (error.code !== "ENOENT") throw error;
			entries = [];
		}
		const index = entries.findIndex(predicate);
		if (index !== -1) return entries.slice(0, index + 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

/**
 * Stop the process and start a fresh one on a copy of its session file.
 *
 * A second process reconstructs from the branch exactly as a restart, reload, fork,
 * or tree navigation does, so this is the seam that proves live accounting and
 * replay draw the same line. The working and session directories are passed in by
 * the caller and therefore outlive `stop()`, which is what makes the copy possible.
 */
async function reload(session, workDir) {
	const file = await session.sessionFile();
	await session.stop();
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-reload-"));
	const copy = join(dir, basename(file));
	copyFileSync(file, copy);
	const resumed = await PiRpcSession.start({ sessionFile: copy, cwd: workDir });
	return { resumed, dir };
}

/**
 * Fail unless exactly `steps` provider responses were consumed. One provider
 * request consumes one scripted step, so equality proves the scenario neither
 * exhausted the script nor left a step unconsumed.
 */
function assertStepsConsumed(session, steps, expectedFailures = []) {
	const outcomes = session.records.filter(
		(r) => r.type === "message_end" && r.message.role === "assistant",
	);
	assert.equal(outcomes.length, steps, `expected exactly ${steps} provider responses, got ${outcomes.length}`);
	assertOnlyFailures(session, expectedFailures);
}

/** Every extension notification message this process has produced, in order. */
function notifyMessages(session) {
	return session.records
		.filter((r) => r.type === "extension_ui_request" && r.method === "notify")
		.map((r) => r.message);
}

async function reportStatus(session, matcher = /Token usage/) {
	await session.prompt("/goal");
	const notify = await session.waitFor("a /goal report", (records) => {
		const matches = records.filter(
			(r) => r.type === "extension_ui_request" && r.method === "notify" && matcher.test(r.message),
		);
		return matches.length ? matches.at(-1) : undefined;
	});
	const one = (pattern) => {
		const match = pattern.exec(notify.message);
		assert.ok(match, `no ${pattern} in:\n${notify.message}`);
		return match[1];
	};
	return {
		goalId: one(/^Goal (\S+) — /),
		status: one(/^Goal \S+ — (\S+)/),
		totalTokens: Number(one(/Token usage: (\d+) tokens/)),
		nestedTokens: Number(one(/nested (\d+) counted once/)),
		message: notify.message,
	};
}

test("/goal issued during an ordinary run never adopts that run's work", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Ordinary answer.", waitForFile: gate, usage: { input: 100, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		const ordinary = await session.prompt("ordinary request");
		assert.equal(ordinary.data.disposition, "started");
		await waitForTurns(session, 1);

		const createPromise = submitCommand(session, "create-busy", `/goal ${OBJECTIVE}`);
		await waitForStoredGoal(
			session,
			(goal) => goal.objective === OBJECTIVE && goal.status === "active",
			"staged Goal",
		);

		// Release the ordinary run. Creation waits for it, then sends its own kickoff.
		writeFileSync(gate, "", "utf8");
		assert.equal((await createPromise).data.disposition, "handled");
		await session.waitFor(
			"the kickoff run started",
			(records) => (records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined),
		);
		// The kickoff response hangs, so it contributes no usage; the ordinary run's
		// 110 tokens must not be attributed to the Goal.
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 15, "only the aborted kickoff request is charged; the ordinary run is never adopted");
		const persisted = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		assert.equal(persisted.data.goal.id, status.message.match(/^Goal (\S+)/)[1]);
		assert.equal(persisted.data.goal.usage.totalTokens, 0, "the durable creation snapshot is not polluted");
		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("an ordinary prompt while a Goal is paused is not charged", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 100, output: 10 } },
			{ hang: true },
			{ text: "Ordinary while paused.", usage: { input: 50, output: 5 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const before = await reportStatus(session);
		// 110 kickoff + 15 for the aborted continuation request.
		assert.equal(before.totalTokens, 125);

		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused"));

		await session.prompt("anything else while paused?");
		await session.waitForSettled(2);
		const after = await reportStatus(session);
		assert.equal(after.status, "paused");
		assert.equal(after.totalTokens, 125, "the ordinary prompt while paused is excluded");
		const persisted = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		assert.equal(persisted.data.goal.status, "paused");
		assert.equal(persisted.data.goal.usage.totalTokens, 125, "the pause snapshot carries the admitted work");
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a Replacement Goal starts at zero and never inherits the old identity's usage", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Original kickoff.", waitForFile: gate, usage: { input: 100, output: 10 } },
			{ text: "Replacement kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		const replacePromise = submitCommand(session, "replace-busy", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		writeFileSync(gate, "", "utf8");

		// The steered replacement response and the aborted continuation are the new
		// Goal's only work: 22 + 15.
		await abortActiveLoop(session, 2);
		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 37, "the replacement starts at zero and inherits nothing");
		// The newest *current* snapshot is the replacement. The newest goal-state entry
		// may be the old identity's finalized historical record: it is marked
		// superseded, so it never selects the current Goal.
		const current = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(current.id, status.goalId);
		assert.notEqual(current.id, original.id);
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("Clear publishes no further usage for the cleared identity and transfers nothing to a future Goal", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 100, output: 10 } },
			{ hang: true },
			{ text: "Ordinary after clear.", usage: { input: 50, output: 5 } },
			{ text: "New Goal kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const cleared = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		const before = await reportStatus(session);
		assert.equal(before.totalTokens, 125);

		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		// An ordinary run after the clear is not Goal work.
		await session.prompt("anything else?");
		await session.waitForSettled(2);
		const afterClear = readSessionEntries(await session.sessionFile());
		const clearedSnapshot = goalSnapshots(afterClear).at(-1);
		assert.equal(clearedSnapshot.data.goal, null, "the tombstone is the newest state");
		assert.equal(
			goalSnapshots(afterClear).find((e) => e.data.goal?.id === cleared.id).data.goal.usage.totalTokens,
			0,
			"the cleared identity's durable snapshot is unchanged by later runs",
		);

		// A future Goal starts at zero; the cleared identity's usage is not transferred.
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const status = await reportStatus(session);
		assert.equal(status.totalTokens, 37, "the new Goal accounts only its own work");
		assert.notEqual(
			lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.id,
			cleared.id,
		);
		assertStepsConsumed(session, 5, [
			{ stopReason: "aborted" },
			{ stopReason: "aborted" },
		]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a held blocked report prepared against an edited Goal is refused without mutation", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Starting work." },
			{
				toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: "The test database is down" } }],
				waitForFile: gate,
			},
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 2);
		const before = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(before.revision, 0);
		assert.equal(before.blockedAudit, undefined);

		const editResponse = await session.prompt("/goal edit Verify a completely different new objective");
		assert.equal(editResponse.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("objective updated"));

		// Release the held blocked report only after the edit advanced the revision.
		writeFileSync(gate, "", "utf8");
		const blocked = await session.waitForToolResult("update_goal", 1);
		assert.equal(blocked.isError, true, "the stale blocked report is refused");
		assert.match(String(blocked.result.content[0].text), /prepared against a Goal state that has since changed/);
		assert.match(String(blocked.result.content[0].text), /revision 0/);

		// No mutation, no extra revision, no audit, no continuation.
		const after = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(after.revision, 1, "only the edit advanced the revision");
		assert.equal(after.blockedAudit, undefined, "the stale report recorded no audit");
		assert.equal(after.status, "active");
		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a steered Replacement attributes the old identity's in-flight work to the old identity", async () => {
	// The replacement is staged while the previous identity's run is still in flight,
	// so the branch reads: the old kickoff, the old response, the replacement
	// snapshot, the old response's tool result, and only then the steered replacement
	// kickoff. The response and its nested tool result were admitted for the old
	// identity, so they stay with it — durably — and are never charged to the
	// replacement, live or replayed.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
	});
	const gate = join(workDir, "provider-gate");
	script(
		[
			{
				toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }],
				waitForFile: gate,
				usage: { input: 100, output: 10 },
			},
			{ text: "Replacement kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Replace while the provider request that holds the old kickoff is streaming.
		const replacePromise = submitCommand(session, "replace-busy", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		// Release the old response: it is finalized *after* the replacement snapshot,
		// and its nested tool result lands after that.
		writeFileSync(gate, "", "utf8");
		await session.waitForToolResult(NESTED_OUTER_TOOL, 1);
		await abortActiveLoop(session, 2);

		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(
			status.totalTokens,
			37,
			"22 for the steered replacement response + 15 for the aborted continuation; the old identity's " +
				"response and nested tool result are not charged to the replacement",
		);
		assert.equal(status.nestedTokens, 0, "the old identity's nested usage is not transferred");

		// The old identity's in-flight assistant response (110) and nested tool result
		// (50) are frozen onto its superseded snapshot, at exact totals.
		const liveFile = await session.sessionFile();
		const liveStates = goalSnapshots(readSessionEntries(liveFile));
		const oldSnapshots = liveStates.filter((e) => e.data.goal?.id === original.id);
		const finalized = oldSnapshots.at(-1);
		assert.equal(finalized.data.goal.usage.totalTokens, 160, "the exact assistant plus tool-result tail");
		assert.equal(finalized.data.goal.usage.nestedTokens, 50);
		assert.equal(finalized.data.goal.status, "active");
		// The freeze is a single append and the newest goal-state entry on the branch.
		// There is no re-affirmation to lose: the superseded marker is what keeps this
		// historical record from becoming the current Goal.
		assert.equal(liveStates.at(-1).data.goal.id, original.id);
		assert.equal(liveStates.at(-1).data.superseded, true);

		// A fresh process reconstructs from the branch. The old tail must stay on the
		// old identity's durable record and must not be charged to the replacement.
		const { resumed, dir } = await reload(session, workDir);
		script([{ text: "Never requested." }, { hang: true }], resumed);
		try {
			await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
			const restored = await reportStatus(resumed);
			assert.equal(restored.status, "active");
			assert.equal(restored.totalTokens, 37, "the reload converges on the live total");
			assert.equal(restored.nestedTokens, 0);
			const reloadedOld = goalSnapshots(readSessionEntries(await resumed.sessionFile()))
				.filter((e) => e.data.goal?.id === original.id)
				.at(-1);
			assert.equal(
				reloadedOld.data.goal.usage.totalTokens,
				160,
				"the old identity's durable total survives reload",
			);
			assert.equal(reloadedOld.data.goal.status, "active");
			// The reload neither re-affirms the replacement nor rewrites the historical
			// snapshot: the tail it recovers is already durable.
			assert.equal(
				goalSnapshots(readSessionEntries(await resumed.sessionFile())).length,
				liveStates.length,
				"the reload appends no snapshot of its own",
			);
			assertStepsConsumed(resumed, 0, []);
			assert.equal(resumed.extensionErrors().length, 0);
		} finally {
			await resumed.stop();
			rmSync(dir, { recursive: true, force: true });
		}
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("Clear during the superseded identity's in-flight response keeps the tail attributed", async () => {
	// A replacement commits while the old identity's request is streaming, then the
	// user clears the replacement before that response is finalized. Clear of the
	// replacement must not erase the old identity's admitted work: the response and
	// its nested tool result land after the tombstone and stay on the old identity's
	// superseded record.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
	});
	const gate = join(workDir, "provider-gate");
	script(
		[
			{
				toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }],
				waitForFile: gate,
				usage: { input: 100, output: 10 },
			},
			{ text: "Replacement kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Replace A→B while A's request is streaming, then Clear B before A's
		// response is finalized.
		const replacePromise = submitCommand(session, "replace-busy", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		const clearPromise = submitCommand(session, "clear-busy", "/goal clear");
		assert.equal((await clearPromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		// Release the old response: it lands after the tombstone and must still be
		// charged to A.
		writeFileSync(gate, "", "utf8");
		await session.waitForToolResult(NESTED_OUTER_TOOL, 1);
		await session.waitForSettled(1);

		// The session has no Goal, and the old identity's tail is frozen on its
		// superseded record.
		const statusPromise = submitCommand(session, "status", "/goal");
		assert.equal((await statusPromise).data.disposition, "handled");
		await session.waitFor("a no-Goal report", (records) =>
			records.find(
				(r) =>
					r.type === "extension_ui_request" &&
					r.method === "notify" &&
					r.message.includes("No Goal is set"),
			),
		);

		const liveStates = goalSnapshots(readSessionEntries(await session.sessionFile()));
		assert.equal(currentGoalSnapshot(liveStates).data.goal, null, "the tombstone is the newest current state");
		const oldSnapshots = liveStates.filter((e) => e.data.goal?.id === original.id);
		const finalized = oldSnapshots.at(-1);
		assert.equal(finalized.data.superseded, true, "the tail is frozen as history");
		assert.equal(finalized.data.goal.usage.totalTokens, 160, "the exact assistant plus tool-result tail");
		assert.equal(finalized.data.goal.usage.nestedTokens, 50);

		// A fresh process reconstructs no Goal and keeps the old identity's total.
		const { resumed, dir } = await reload(session, workDir);
		script([{ text: "Never requested." }, { hang: true }], resumed);
		try {
			// A session with no Goal emits no startup notify; the status line is the
			// observable signal that session_start has finished.
			await resumed.waitFor("the startup status line", (records) =>
				records.find((r) => r.type === "extension_ui_request" && r.method === "setStatus"),
			);
			const reloadedStates = goalSnapshots(readSessionEntries(await resumed.sessionFile()));
			const reloadedOld = reloadedStates.filter((e) => e.data.goal?.id === original.id).at(-1);
			assert.equal(reloadedOld.data.goal.usage.totalTokens, 160, "the old total survives reload");
			assert.equal(reloadedOld.data.superseded, true);
			assertStepsConsumed(resumed, 0, []);
			assert.equal(resumed.extensionErrors().length, 0);
		} finally {
			await resumed.stop();
			rmSync(dir, { recursive: true, force: true });
		}
		assertStepsConsumed(session, 2, []);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("creating a Goal after a Clear closes the old admission so live and replay agree", async () => {
	// A replacement commits while A's request is streaming, the user clears the
	// replacement, and a new Goal C is created before A's response is finalized.
	// Creating a Goal is a boundary that leaves no marker of its own on the branch, so
	// the old admission has to be closed durably there: a live path that merely dropped
	// it would refuse A's response while the replay still charged it to A and froze a
	// 110-token record the live path never accounted.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	const gate = join(workDir, "provider-gate");
	script(
		[
			{ text: "Original kickoff.", waitForFile: gate, usage: { input: 100, output: 10 } },
			{ text: "Steered kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Replace A→B while A's request is streaming, then Clear B before it lands.
		const replacePromise = submitCommand(session, "replace-busy", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		const clearPromise = submitCommand(session, "clear-busy", "/goal clear");
		assert.equal((await clearPromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		// Create Goal C while A's request is still streaming. The creation boundary closes
		// A's admission, and that close is durable before C's own snapshot.
		const createPromise = submitCommand(session, "create-c", "/goal A third objective");
		await waitForStoredGoal(session, (goal) => goal.objective === "A third objective", "the new Goal's snapshot");
		const statesAtCreation = goalSnapshots(readSessionEntries(await session.sessionFile()));
		assert.equal(currentGoalSnapshot(statesAtCreation).data.goal.objective, "A third objective");
		const closeAtCreation = statesAtCreation.filter((e) => e.data.goal?.id === original.id).at(-1);
		assert.equal(closeAtCreation.data.superseded, true, "the old admission is closed with durable evidence");
		assert.equal(closeAtCreation.data.goal.usage.totalTokens, 0, "A's response had not landed yet");

		// Release A's response: it lands after the creation boundary and is charged to
		// nobody, live and on replay.
		writeFileSync(gate, "", "utf8");
		await abortActiveLoop(session, 2);
		assert.equal((await createPromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(
			status.totalTokens,
			37,
			"22 for the steered response + 15 for the aborted kickoff; A's late response is charged to nobody",
		);
		assert.equal(status.nestedTokens, 0);

		const liveStates = goalSnapshots(readSessionEntries(await session.sessionFile()));
		assert.equal(
			liveStates.length,
			statesAtCreation.length,
			"the live path appends nothing after the creation boundary",
		);
		const oldStates = liveStates.filter((e) => e.data.goal?.id === original.id);
		assert.equal(oldStates.length, 3, "creation, the replacement's preserve, and the durable close");
		assert.equal(oldStates.at(-1).data.superseded, true);
		for (const state of oldStates) {
			assert.equal(state.data.goal.usage.totalTokens, 0, "the late response was never accounted, live");
		}

		// A fresh process reconstructs from the branch and must reach the same totals.
		const { resumed, dir } = await reload(session, workDir);
		script([{ text: "Ordinary after reload.", usage: { input: 50, output: 5 } }], resumed);
		try {
			await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
			const restored = await reportStatus(resumed);
			assert.equal(restored.status, "active");
			assert.equal(restored.totalTokens, 37, "the reload converges on the live total");
			assert.equal(
				goalSnapshots(readSessionEntries(await resumed.sessionFile())).length,
				liveStates.length,
				"the reload appends no snapshot of its own",
			);

			// The next delivered user message is a freeze boundary. It must not invent a
			// historical record for the old identity's late response: live refused it, so the
			// replay has to refuse it too instead of freezing a total nobody accounted.
			await resumed.prompt("/goal pause");
			await resumed.waitForNotify((r) => r.message.includes("paused"));
			await resumed.prompt("anything else after the reload?");
			await resumed.waitForSettled(1);
			const afterBoundary = goalSnapshots(readSessionEntries(await resumed.sessionFile()));
			const oldAfterBoundary = afterBoundary.filter((e) => e.data.goal?.id === original.id);
			assert.equal(oldAfterBoundary.length, 3, "no historical freeze is invented for the late response");
			for (const state of oldAfterBoundary) {
				assert.equal(state.data.goal.usage.totalTokens, 0, "and the old identity's total stays exact");
			}
			assertStepsConsumed(resumed, 1, []);
			assert.equal(resumed.extensionErrors().length, 0, JSON.stringify(resumed.extensionErrors()));
		} finally {
			await resumed.stop();
			rmSync(dir, { recursive: true, force: true });
		}
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("old-budget exhaustion is recorded on the superseded identity and admits no old continuation", async () => {
	// The old identity's in-flight tail crosses its own budget. The exhaustion belongs
	// to the old identity's durable record only: the replacement keeps its fresh
	// ledger and its own admission, and the superseded identity never continues or
	// earns a wrap-up.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
	});
	const gate = join(workDir, "provider-gate");
	script(
		[
			{
				toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }],
				waitForFile: gate,
				usage: { input: 100, output: 10 },
			},
			{ text: "Replacement kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		const replacePromise = submitCommand(session, "replace-busy", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		writeFileSync(gate, "", "utf8");
		await session.waitForToolResult(NESTED_OUTER_TOOL, 1);
		await abortActiveLoop(session, 2);

		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 37, "the replacement keeps its own fresh ledger");

		const oldSnapshots = goalSnapshots(readSessionEntries(await session.sessionFile())).filter(
			(e) => e.data.goal?.id === original.id,
		);
		const finalized = oldSnapshots.at(-1);
		assert.equal(finalized.data.goal.status, "budget_limited", "the old identity's exhaustion is recorded");
		assert.equal(finalized.data.goal.usage.totalTokens, 160, "the in-flight tail is attributed to the old identity");
		assert.equal(finalized.data.goal.usage.nestedTokens, 50);

		// No old continuation and no old wrap-up: the superseded identity never continues.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(
			continuationEntries(entries).filter((e) => e.content.includes(original.id)).length,
			0,
			"the superseded identity earns no continuation",
		);
		assert.equal(
			customMessageEntries(entries, "goal-budget-wrapup").filter((e) => e.content.includes(original.id)).length,
			0,
			"the superseded identity earns no wrap-up",
		);

		const { resumed, dir } = await reload(session, workDir);
		script([{ text: "Never requested." }, { hang: true }], resumed);
		try {
			await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
			const restored = await reportStatus(resumed);
			assert.equal(restored.status, "active");
			assert.equal(restored.totalTokens, 37);
			const reloadedOld = goalSnapshots(readSessionEntries(await resumed.sessionFile()))
				.filter((e) => e.data.goal?.id === original.id)
				.at(-1);
			assert.equal(reloadedOld.data.goal.status, "budget_limited", "the old status survives reload");
			assert.equal(reloadedOld.data.goal.usage.totalTokens, 160, "the old total survives reload");
			assertStepsConsumed(resumed, 0, []);
			assert.equal(resumed.extensionErrors().length, 0);
		} finally {
			await resumed.stop();
			rmSync(dir, { recursive: true, force: true });
		}
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("a hard crash between the old identity's tail and its freeze boundary recovers the tail on reload", async () => {
	// The crash window: the process dies after the old identity's in-flight response and
	// its nested tool result landed, but before any freeze boundary ran. The branch that
	// leaves behind carries the tail with no historical snapshot after it, so the next
	// load has to recover the tail from the branch instead of dropping work the live
	// path had already charged to the superseded identity.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
	});
	const gate = join(workDir, "provider-gate");
	script(
		[
			{
				toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }],
				waitForFile: gate,
				usage: { input: 100, output: 10 },
			},
			{ text: "Replacement kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	let crashEntries;
	let crashFile;
	let original;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		const replacePromise = submitCommand(session, "replace-crash", "/goal A replacement objective");
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		// Release the old response: it is finalized *after* the replacement snapshot,
		// and its nested tool result lands after that.
		writeFileSync(gate, "", "utf8");
		await session.waitForToolResult(NESTED_OUTER_TOOL, 1);

		// Pi emits the tool-execution record before it appends the tool result, so wait
		// for the entry itself to be on the branch before dying.
		crashFile = await session.sessionFile();
		crashEntries = await waitForBranchEntry(
			crashFile,
			(entry) => entry.type === "message" && entry.message?.role === "toolResult",
			"the old identity's tool result on the branch",
		);

		// Die here — before the replacement's kickoff is delivered, and therefore before
		// any freeze boundary could have run.
		session.killNow();
		await session.waitForExit();
	} finally {
		await session.stop();
	}

	// The branch the crash leaves: everything through the old identity's tool result.
	// A checkpoint, the freeze, and the steered kickoff all come after it, so keeping
	// this prefix is exactly the state a SIGKILL at that point produces.
	const crashGoalStates = crashEntries.filter(
		(entry) => entry.type === "custom" && entry.customType === "goal-state",
	);
	assert.ok(crashEntries.length > 1, "the old identity's tool result is on the branch");
	assert.equal(
		crashEntries.at(-1).message.role,
		"toolResult",
		"the crash position is the old identity's nested tool result",
	);
	assert.equal(
		crashGoalStates.filter((entry) => entry.data.superseded === true).length,
		0,
		"no freeze boundary ran before the crash",
	);

	const dir = mkdtempSync(join(tmpdir(), "pi-goal-reload-"));
	const copy = join(dir, basename(crashFile));
	writeFileSync(copy, crashEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

	const resumed = await PiRpcSession.start({ sessionFile: copy, cwd: workDir });
	script([{ text: "Never requested." }, { hang: true }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
		const restored = await reportStatus(resumed);
		assert.equal(restored.status, "active");
		assert.equal(restored.totalTokens, 0, "the replacement is not charged for the old identity's tail");

		// The recovered tail is frozen at the first durable boundary of this runtime.
		const resumedEntries = readSessionEntries(await resumed.sessionFile());
		const frozen = goalSnapshots(resumedEntries).filter((entry) => entry.data.superseded === true);
		assert.equal(frozen.length, 1, "exactly one historical snapshot is recovered from the branch");
		assert.equal(frozen[0].data.goal.id, original.id, "the tail stays with the identity that was replaced");
		assert.equal(frozen[0].data.goal.usage.totalTokens, 160, "the exact assistant plus tool-result tail");
		assert.equal(frozen[0].data.goal.usage.nestedTokens, 50);
		assert.equal(
			resumedEntries.filter((entry) => entry.type === "custom" && entry.customType === "goal-state").length,
			crashGoalStates.length + 1,
			"the reload appends the recovered freeze and nothing else",
		);
		assertStepsConsumed(resumed, 0, []);
		assert.equal(resumed.extensionErrors().length, 0, JSON.stringify(resumed.extensionErrors()));
	} finally {
		await resumed.stop();
		rmSync(dir, { recursive: true, force: true });
	}
	rmSync(workDir, { recursive: true, force: true });
	rmSync(sessionDir, { recursive: true, force: true });
});

test("an ordinary prompt typed during an admitted Goal response stays attributed and converges", async () => {
	// The prompt is typed while the provider request is still streaming, which is when
	// Pi dispatches `input`. The response was admitted when its turn started, so it
	// stays attributable: closing the segment at `input` would drop it live while the
	// replay — where the assistant message is appended *before* the prompt that
	// interrupted it — charges it. That divergence also loses the budget stop, because
	// the only live check runs at the dropped report's `message_end`.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	const gate = join(workDir, "provider-gate");
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 25, output: 5 } },
			{ text: "Continuation answer.", waitForFile: gate, usage: { input: 75, output: 5 } },
			{ text: "Ordinary answer.", usage: { input: 50, output: 5 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
		],
		session,
	);
	try {
		const createPromise = submitCommand(session, "create", `/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		// The automatic Continuation is admitted Goal work and its request is held, so
		// the agent is provably busy when the prompt is typed.
		await session.waitFor(
			"the continuation run started",
			(records) => (records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.steer("anything else while you work?");
		writeFileSync(gate, "", "utf8");

		// 30 (kickoff) + 80 (the admitted in-flight response) crosses the 100-token
		// budget, so the Goal stops now rather than only after a reload.
		await session.waitForSettled(1);
		const stopped = notifyMessages(session).filter((m) => m.includes("reached its token budget"));
		assert.equal(
			stopped.length,
			1,
			`the live path must stop at the crossing; notifications were ${JSON.stringify(notifyMessages(session))}`,
		);
		assert.match(stopped[0], /100 tokens \(110 accounted\)/);

		const status = await reportStatus(session);
		assert.equal(status.status, "budget_limited");
		// 110 Goal work + 15 for the one bounded wrap-up. The ordinary prompt's own
		// response (55) is excluded, and the Goal admits no further work.
		assert.equal(status.totalTokens, 125);

		// A fresh process must reach the same state. If the in-flight response had been
		// dropped live, the reload would replay it onto an `active` Goal and the
		// continuation seam would admit a turn the live session had already paid for.
		const { resumed, dir } = await reload(session, workDir);
		script([{ text: "Never requested." }], resumed);
		try {
			await resumed.waitForNotify((r) => r.message.includes("restored (budget_limited)"));
			const restored = await reportStatus(resumed);
			assert.equal(restored.status, "budget_limited", "the reload keeps the stop");
			assert.equal(restored.totalTokens, 125, "the reload converges on the live total");
			assert.equal(runCount(resumed), 0, "the restored Goal admits no further Goal work");
			assertStepsConsumed(resumed, 0, []);
			assert.equal(resumed.extensionErrors().length, 0);
		} finally {
			await resumed.stop();
			rmSync(dir, { recursive: true, force: true });
		}
		assert.equal((await createPromise).data.disposition, "handled");
		assertStepsConsumed(session, 4, []);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("already-admitted in-flight Goal work stays attributable through a pause", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }], usage: { input: 100, output: 10 } },
			{ text: "Working.", waitForFile: gate, usage: { input: 40, output: 4 } },
			{ text: "After pause.", usage: { input: 20, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForToolResult("get_goal", 1);
		// Pause while the second provider request is held: the in-flight work is
		// already admitted and must still be accounted.
		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused"));
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		const status = await reportStatus(session);
		assert.equal(status.status, "paused");
		// 110 (first turn) + 44 (the held in-flight response) + 15 (aborted? no: the
		// response completes, so no aborted usage). The post-pause response is the
		// held one and is admitted; nothing after the pause is charged.
		assert.equal(status.totalTokens, 154);
		assertStepsConsumed(session, 2, []);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});
