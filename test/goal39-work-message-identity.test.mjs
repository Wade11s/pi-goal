/**
 * Issue #39: bind delivered Goal work messages to their admitted identity.
 *
 * A pi-goal work message queued for a Goal that is then cleared or replaced is
 * delivered after the new Goal commits. It carries the `[pi-goal]` prefix, so
 * `applyDeliveredUserMessage` used to treat it as the *new* Goal's own admission
 * segment and the old run's subsequent provider turns were charged to the new
 * identity. A Goal created with `--budget 1` became `budget_limited` from the
 * old run's usage even though its own kickoff was never started.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess with the scripted
 * provider, holds the old run open at a provider gate while the lifecycle
 * commands run, and asserts the exact old/new identity totals, the new Goal's
 * own kickoff, the persisted ownership/snapshot ordering, clean outcomes, and
 * the exact run/continuation counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PiRpcSession,
	assertStepsConsumed,
	continuationEntries,
	currentGoalSnapshot,
	customMessageEntries,
	goalSnapshots,
	lastGoalSnapshot,
	readSessionEntries,
	script,
	submitCommand,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE_B = "Verify objective B in this repository";
const OBJECTIVE_C = "Ship objective C in this repository";
const WRAPUP_CUSTOM_TYPE = "goal-budget-wrapup";

/** The newest *current* goal-state snapshot: the one that selects the session's Goal. */
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

/** Text of a session-entry message content (string or block array). */
function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
				? block.text
				: "",
		)
		.join("\n");
}

/** Every pi-goal work message on the branch, in append order. */
function workMessages(entries) {
	return entries.filter(
		(e) =>
			e.type === "message" &&
			e.message?.role === "user" &&
			messageText(e.message.content).startsWith("[pi-goal]"),
	);
}

/** The Goal id named by a pi-goal work message, or null. */
function namedGoal(text) {
	const match = /\[pi-goal\][^\n]*?\bGoal\s+(goal_[0-9a-f]{8})\b/.exec(text);
	return match ? match[1] : null;
}

function namedWorkMessages(entries, goalId) {
	return workMessages(entries).filter((e) => namedGoal(messageText(e.message.content)) === goalId);
}

/** Every extension notification message this process has produced, in order. */
function notifyMessages(session) {
	return session.records
		.filter((r) => r.type === "extension_ui_request" && r.method === "notify")
		.map((r) => r.message);
}

async function reportStatus(session) {
	await session.prompt("/goal");
	const notify = await session.waitFor("a /goal report", (records) => {
		const matches = records.filter(
			(r) => r.type === "extension_ui_request" && r.method === "notify" && /Token usage/.test(r.message),
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
		revision: Number(one(/Revision: (\d+)/)),
		totalTokens: Number(one(/Token usage: (\d+) tokens/)),
		message: notify.message,
	};
}

test("a stale queued resume for a cleared Goal cannot open the new Goal's admission", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// Goal B's kickoff, held so the run is provably in flight while the
			// lifecycle commands run. Its usage is never charged: B is cleared.
			{ text: "B kickoff response.", waitForFile: gate, usage: { input: 100, output: 10 } },
			// The old run's turn after the queued B resume message is delivered.
			// This is the usage the defect charged to the new Goal C.
			{ text: "B resumed turn.", usage: { input: 100, output: 40 } },
			// Goal C's own kickoff, which must still run exactly once. Its 22
			// tokens exceed the 1-token budget, so C earns its own bounded wrap-up.
			{ text: "C kickoff response.", usage: { input: 20, output: 2 } },
			// C's wrap-up run, aborted to bound the scenario.
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE_B}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const b = currentGoalSnapshot(goalSnapshots(readSessionEntries(await session.sessionFile()))).data.goal;
		assert.equal(b.status, "active");

		// Pause then resume while B's kickoff is in flight: the resume work message
		// is queued as a steer and has not been delivered yet.
		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed"));

		// Clear B, then create C with a token budget of 1. C commits active and
		// waits for the in-flight B run.
		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		const createPromise = submitCommand(session, "create-c", `/goal --budget 1 ${OBJECTIVE_C}`);
		const c = await waitForStoredGoal(
			session,
			(goal) => goal.objective === OBJECTIVE_C && goal.status === "active",
			"Goal C active",
		);
		assert.equal(c.usage.totalTokens, 0, "C starts at zero");

		// Release the old gate. The queued B resume message is delivered after C
		// exists; it must not open C's admission.
		writeFileSync(gate, "", "utf8");
		assert.equal((await createPromise).data.disposition, "handled");
		assert.equal(
			notifyMessages(session).filter((m) => m.includes("was not started")).length,
			0,
			"C's own kickoff was not suppressed",
		);
		await session.waitFor(
			"C's own kickoff run started",
			(records) => (records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const status = await reportStatus(session);
		assert.equal(status.goalId, c.id, "C is still the current Goal");
		assert.equal(status.totalTokens, 37, "only C's own kickoff and wrap-up are charged, never B's 140-token resumed turn");
		// C's own 22 tokens exceed its 1-token budget, so its stop is legitimate
		// and belongs to C alone.
		assert.equal(status.status, "budget_limited", "C's budget stop is derived from its own kickoff");

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(namedWorkMessages(entries, b.id).length, 2, "B's kickoff and queued resume messages are on the branch");
		assert.equal(namedWorkMessages(entries, c.id).length, 1, "C's kickoff is delivered exactly once");
		assert.equal(
			continuationEntries(entries).filter((e) => e.content.includes(c.id)).length,
			0,
			"an over-budget Goal earns no Continuation",
		);
		assert.equal(
			continuationEntries(entries).filter((e) => e.content.includes(b.id)).length,
			0,
			"B earns no Continuation",
		);
		assert.equal(
			customMessageEntries(entries, WRAPUP_CUSTOM_TYPE).filter((e) => e.content.includes(c.id)).length,
			1,
			"C earns exactly one Budget wrap-up for its own exhaustion",
		);
		assert.equal(
			customMessageEntries(entries, WRAPUP_CUSTOM_TYPE).filter((e) => e.content.includes(b.id)).length,
			0,
			"B earns no wrap-up",
		);

		const states = goalSnapshots(entries);
		const current = currentGoalSnapshot(states);
		assert.equal(current.data.goal.id, c.id, "the newest current snapshot is C");
		assert.equal(current.data.goal.usage.totalTokens, 22, "C's durable total is its own kickoff");
		const bStates = states.filter((e) => e.data.goal?.id === b.id);
		assert.equal(bStates.length, 3, "B's creation, pause, and resume snapshots");
		for (const state of bStates) {
			assert.equal(state.data.goal.usage.totalTokens, 0, "B's stale work is never charged");
		}
		assert.equal(states.filter((e) => e.data.goal === null).length, 1, "Clear writes one tombstone");

		assertStepsConsumed(session, 4, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a stale queued resume for a replaced Goal stays on the old identity and never opens the replacement", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// B's kickoff, held. Its response lands after the replacement snapshot,
			// so it is the old identity's already-admitted in-flight tail.
			{ text: "B kickoff response.", waitForFile: gate, usage: { input: 100, output: 10 } },
			// The old run's turn after the queued B resume message is delivered.
			{ text: "B resumed turn.", usage: { input: 100, output: 40 } },
			// The replacement's own kickoff, steered into the same run.
			{ text: "C kickoff response.", usage: { input: 20, output: 2 } },
			// C's first automatic Continuation, aborted to bound the scenario.
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE_B}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const b = currentGoalSnapshot(goalSnapshots(readSessionEntries(await session.sessionFile()))).data.goal;

		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed"));

		// Replace B with C while B's kickoff is in flight. The replacement confirms,
		// writes C's snapshot, and steers C's own kickoff into the running work.
		const replacePromise = submitCommand(session, "replace-b", `/goal ${OBJECTIVE_C}`);
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		const c = currentGoalSnapshot(goalSnapshots(readSessionEntries(await session.sessionFile()))).data.goal;
		assert.equal(c.id !== b.id, true, "the replacement is a new identity");

		writeFileSync(gate, "", "utf8");
		await session.waitFor(
			"C's continuation run started",
			(records) => (records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const status = await reportStatus(session);
		assert.equal(status.goalId, c.id, "the replacement is the current Goal");
		assert.equal(status.status, "active", "the replacement is not budget_limited by B's stale work");
		assert.equal(status.totalTokens, 37, "only the replacement's own kickoff and aborted Continuation are charged");

		const entries = readSessionEntries(await session.sessionFile());
		const superseded = goalSnapshots(entries).filter((e) => e.data.superseded === true);
		assert.equal(superseded.length, 1, "the old identity's tail is frozen once");
		assert.equal(superseded[0].data.goal.id, b.id, "the frozen tail belongs to B");
		assert.equal(
			superseded[0].data.goal.usage.totalTokens,
			110,
			"B's already-admitted in-flight response stays on its superseded record",
		);
		assert.equal(namedWorkMessages(entries, c.id).length, 1, "C's kickoff is delivered exactly once");
		assert.equal(
			continuationEntries(entries).filter((e) => e.content.includes(c.id)).length,
			1,
			"C earns exactly one Continuation",
		);
		assert.equal(
			continuationEntries(entries).filter((e) => e.content.includes(b.id)).length,
			0,
			"B earns no Continuation",
		);
		assertStepsConsumed(session, 4, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a legitimate same-identity resume still opens its own Goal's admission", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Kickoff response.", waitForFile: gate, usage: { input: 100, output: 10 } },
			// The turn after the resume is delivered: it must be charged to the same Goal.
			{ text: "Resumed turn.", usage: { input: 30, output: 3 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE_B}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const goal = currentGoalSnapshot(goalSnapshots(readSessionEntries(await session.sessionFile()))).data.goal;

		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed"));

		writeFileSync(gate, "", "utf8");
		await session.waitFor(
			"the resumed run settled",
			(records) => (records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const status = await reportStatus(session);
		assert.equal(status.goalId, goal.id);
		assert.equal(status.status, "active");
		assert.equal(
			status.totalTokens,
			158,
			"the kickoff, the resumed turn, and the aborted Continuation are charged to the same identity",
		);
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
