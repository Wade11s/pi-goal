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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
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
		status: one(/^Goal \S+ — (\S+)/),
		totalTokens: Number(one(/Token usage: (\d+) tokens/)),
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
		assert.notEqual(
			lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.id,
			original.id,
		);
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
