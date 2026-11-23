/**
 * Issue #28 integrated acceptance: cross-contract regressions.
 *
 * The four repair batches each proved their own contract. These scenarios drive
 * the intersections the batch-local suites do not reach, through the same real
 * `pi --mode rpc` seam and the same honesty rules: every script is sized exactly,
 * every test ends with `assertCleanRun` or an exact `assertOnlyFailures`, and
 * `assertStepsConsumed` fails on an exhausted script.
 *
 * The intersections covered here:
 * - stale model transitions across a budget-raising resume (batch 1 × batch 2);
 * - a tool-created Goal replaced by `/goal`, including what the superseded record
 *   may charge (batch 4 × batch 1 attribution and replacement);
 * - a tool-created Goal's budget exhaustion and cumulative recovery (batch 4 ×
 *   batch 2);
 * - a tool-created Goal's blocked audit issuing and advancing a Blocker identity
 *   (batch 4 × batch 3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assertStepsConsumed,
	continuationEntries,
	currentGoalSnapshot,
	lastGoalSnapshot,
	liveUsage,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";
import { structuredGoal } from "./helpers/blocked-audit.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
const REQUEST = "Please create a Goal for the release";
const BLOCKER = "the upstream release API token has not been issued yet";

function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

function goalStates(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/** The newest snapshot marked `superseded`, or null. */
function supersededSnapshot(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state" && entry.data?.superseded === true) {
			snapshot = entry;
		}
	}
	return snapshot;
}

/**
 * A 100-token Goal whose kickoff accounts 85 and whose continuation fails after
 * 30 more (115 total). The failed run is a hard exit, so the Goal is durably
 * `budget_limited` with the wrap-up still owed.
 */
function budgetStopScript() {
	return [
		{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
		{ error: "invalid api key", usage: { input: 20, output: 10 } },
	];
}

test("a held model transition is stale after a budget-raising resume", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	// Kickoff 85, failed continuation +30 = 115 (budget_limited, wrap-up owed),
	// an ordinary prompt whose settlement delivers the one wrap-up, then a held
	// `update_goal(complete)` prepared against the budget_limited Goal.
	script(
		[
			...budgetStopScript(),
			{ text: "Ordinary answer.", usage: { input: 10, output: 5 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				waitForFile: gate,
			},
			{ text: "Resumed work.", usage: { input: 20, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const limited = await waitForSnapshot(
			session,
			(s) => s.data.goal?.status === "budget_limited",
			"the durable budget stop",
		);

		// The ordinary prompt delivers the owed wrap-up and leaves the Goal
		// budget_limited with no pending wrap-up. The revision it leaves is the one
		// the held turn binds.
		await session.prompt("an ordinary prompt");
		const delivered = await waitForSnapshot(
			session,
			(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.wrapUpPending === false,
			"the delivered wrap-up",
		);
		const heldRevision = delivered.data.goal.revision;
		const heldId = delivered.data.goal.id;

		// A run whose response is held: its `turn_start` binds the budget_limited
		// Goal, and its `update_goal(complete)` is prepared against that revision.
		const held = session.prompt("start a run");
		await session.waitFor("the held turn started", (records) =>
			records.filter((r) => r.type === "turn_start").length >= 5 ? true : undefined,
		);

		// The budget-raising resume changes identity state while the response is in
		// flight. It is the user's decision, so it proceeds.
		await session.prompt("/goal:resume --budget 200");
		const resumed = await session.waitForNotify((r) => r.message.includes("resumed (revision"));
		assert.match(resumed.message, /cumulative token ceiling is now 200 tokens/);

		// Release the held transition: it was prepared against the budget_limited
		// revision and must be refused rather than completing the resumed Goal.
		writeFileSync(gate, "", "utf8");
		const blocked = await session.waitForToolResult("update_goal", 1);
		assert.equal(blocked.isError, true, "the held transition is refused");
		assert.match(String(blocked.result.content[0].text), /prepared against a Goal state that has since changed/);
		assert.match(
			String(blocked.result.content[0].text),
			new RegExp(`expected ${heldId} revision ${heldRevision}, current ${heldId} revision ${heldRevision + 1}`),
		);
		assert.equal((await held).data.disposition, "started");

		const after = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(after.status, "active", "the resume stands; the stale call changed nothing");
		assert.equal(after.revision, heldRevision + 1, "only the resume advanced the revision");
		assert.notEqual(after.status, "complete");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assert.equal(
			runCount(session),
			6,
			"the kickoff, the failed continuation, the ordinary prompt, its wrap-up, the held run, and the resumed continuation",
		);
		assert.equal(
			continuationEntries(readSessionEntries(await session.sessionFile())).length,
			2,
			"the kickoff's continuation and the one after the resumed run; the wrap-up is a budget message",
		);
		assertStepsConsumed(session, 7, [{ stopReason: "error", errorMessage: "invalid api key" }, { stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		assertOnlyFailures(session, [
			{ stopReason: "error", errorMessage: "invalid api key" },
			{ stopReason: "aborted" },
		]);
	} finally {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	}
});

test("a tool-created Goal replaced by /goal charges only its Goal-owned Continuation work to the superseded record", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	// Turn 1 is the creating run (ordinary, 140 tokens). Turn 2 closes it. Turn 3
	// is the first Continuation, the first Goal-owned work (40 tokens). The
	// replacement then runs and is aborted.
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: REQUEST } }], usage: { input: 120, output: 20 } },
			{ text: "Creating run closing response.", usage: { input: 30, output: 10 } },
			{ text: "Continuation answer.", waitForFile: gate, usage: { input: 30, output: 10 } },
			{ text: "Replacement kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(REQUEST);
		await session.waitForToolResult("create_goal", 1);
		const created = structuredGoal(toolResults(session, "create_goal")[0].result);
		assert.equal(created.origin, "tool");
		assert.equal(created.status, "active");

		// Wait until the first Continuation's response is in flight, held at the gate.
		await session.waitFor("the continuation turn started", (records) =>
			records.filter((r) => r.type === "turn_start").length >= 3 ? true : undefined,
		);

		// Replace the Goal while its first Continuation is still in flight, held at
		// the gate. The confirmation describes the tool-created Goal.
		const replacePromise = session.prompt(`/goal A replacement objective`);
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		assert.equal((await replacePromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		// Release the held Continuation response: it belongs to the old identity and
		// is frozen onto its superseded record at the replacement boundary.
		writeFileSync(gate, "", "utf8");
		const deadline = Date.now() + 15_000;
		let entries;
		for (;;) {
			entries = readSessionEntries(await session.sessionFile());
			const superseded = supersededSnapshot(entries);
			if (superseded?.data.goal?.id === created.id && superseded.data.goal.usage.totalTokens === 40) break;
			if (Date.now() > deadline) throw new Error("the old identity's Continuation tail was not frozen");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		// The scripted turns so far: 1–2 the creating run, 3 the held Continuation, and
		// 4 the replacement kickoff, delivered as that run's steered next turn. Turn 5
		// is the replacement's own Continuation, and it can only start after turn 4's
		// `turn_end` — the boundary Pi emits after appending the kickoff message and
		// pi-goal flushes accounting. Waiting for it keeps the 22-token read below
		// deterministic (an early read can catch the kickoff mid-flight and see 0) and
		// makes the final abort land on this run's hanging tail instead of its start.
		await session.waitFor("the replacement's continuation after its accounted kickoff", (records) =>
			records.filter((r) => r.type === "turn_start").length >= 5 ? true : undefined,
		);

		// The replacement's own kickoff is the only work charged to the new identity.
		const replacementTotal = await liveUsage(session);
		assert.equal(replacementTotal, 22, "the replacement accounts only its own kickoff");

		await session.sendSimple("abort");
		await session.waitForSettled(1);

		assert.equal(
			runCount(session),
			3,
			"the creating run, the run carrying the held Continuation and the replacement kickoff, and the replacement's continuation",
		);
		assert.equal(
			continuationEntries(readSessionEntries(await session.sessionFile())).length,
			2,
			"the old identity's Continuation and the replacement's",
		);

		entries = readSessionEntries(await session.sessionFile());
		const oldRecords = entries.filter((e) => e.type === "custom" && e.customType === "goal-state" && e.data?.goal?.id === created.id);
		const oldTotal = oldRecords.reduce((sum, e) => sum + (e.data.goal.usage?.totalTokens ?? 0), 0);
		// The old identity's records must not include the creating run's 140 tokens
		// or the replacement's 22: only its own Continuation work.
		assert.equal(oldTotal, 40, "the superseded records carry only Goal-owned work");
		assert.ok(
			oldRecords.every((e) => e.data.goal.usage.totalTokens <= 40),
			"no creating-run usage leaked into the old identity",
		);

		const current = currentGoalSnapshot(entries).data.goal;
		assert.notEqual(current.id, created.id, "the replacement is current");
		assert.equal(current.origin, "command");

		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	}
});

test("a tool-created Goal's budget exhaustion recovers through a cumulative raise", async () => {
	const session = await PiRpcSession.start();
	// The creating run is ordinary (140 tokens). The first Continuation accounts
	// 90 tokens against a 100-token budget, then a second Continuation crosses it
	// (30 more = 120). The wrap-up is delivered, then a cumulative raise resumes.
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, tokenBudget: 100, userRequest: REQUEST } }], usage: { input: 120, output: 20 } },
			{ text: "Creating run closing response.", usage: { input: 30, output: 10 } },
			{ text: "Continuation answer.", usage: { input: 60, output: 30 } },
			{ text: "Crossing answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
			{ text: "Resumed work.", usage: { input: 20, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(REQUEST);
		await session.waitForToolResult("create_goal", 1);
		const created = structuredGoal(toolResults(session, "create_goal")[0].result);
		assert.equal(created.origin, "tool");
		assert.equal(created.tokenBudget, 100);

		const limited = await waitForSnapshot(
			session,
			(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.wrapUpPending === false,
			"the tool-created Goal to exhaust and deliver its wrap-up",
		);
		assert.equal(limited.data.goal.origin, "tool", "origin survives the stop");
		// The durable stop snapshot carries the crossing work; the wrap-up's own 15
		// tokens are in the live ledger and its checkpoint.
		assert.equal(limited.data.goal.usage.totalTokens, 120, "90 + the 30-token crossing");
		assert.equal(await liveUsage(session), 135, "the live total includes the 15-token wrap-up");

		await session.prompt("/goal:resume --budget 200");
		const resumed = await session.waitForNotify((r) => r.message.includes("resumed (revision"));
		assert.match(resumed.message, /cumulative token ceiling is now 200 tokens/);
		assert.match(resumed.message, /135 tokens already accounted/);

		const active = await waitForSnapshot(
			session,
			(s) => s.data.goal?.status === "active" && s.data.goal?.tokenBudget === 200,
			"the resumed tool-created Goal",
		);
		assert.equal(active.data.goal.id, created.id, "identity preserved");
		assert.equal(active.data.goal.origin, "tool", "origin preserved");
		assert.equal(active.data.goal.usage.totalTokens, 135, "usage preserved at the resume");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		const final = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(final.status, "active");
		assert.equal(await liveUsage(session), 180, "135 + the resumed run's 30 + the aborted continuation's 15");
		assert.equal(
			runCount(session),
			6,
			"the creating run, its continuation, the crossing continuation, the wrap-up, the resumed run, and the continuation after it",
		);
		assert.equal(
			continuationEntries(readSessionEntries(await session.sessionFile())).length,
			3,
			"the kickoff's continuation, the crossing continuation, and the one after the resumed run",
		);
		assertStepsConsumed(session, 7, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	}
});

test("a tool-created Goal's blocked audit issues and advances a Blocker identity", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	const chained = (id) => [
		{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: REQUEST } }], usage: { input: 120, output: 20 } },
		{ text: "Creating run closing response.", usage: { input: 30, output: 10 } },
		{ text: "Kickoff answer.", usage: { input: 10, output: 5 } },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }], usage: { input: 5, output: 5 } },
		{ text: "Waiting.", waitForFile: gate },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: "The release API token still has not arrived", ...(id ? { blocker_id: id } : {}) } }], usage: { input: 5, output: 5 } },
		{ text: "Waiting." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, ...(id ? { blocker_id: id } : {}) } }], usage: { input: 5, output: 5 } },
		{ text: "Reporting the blocker.", usage: { input: 5, output: 5 } },
		{ hang: true },
	];
	writeFileSync(session.scriptPath, JSON.stringify(chained(undefined)), "utf8");
	try {
		await session.prompt(REQUEST);
		await session.waitForToolResult("create_goal", 1);
		const created = structuredGoal(toolResults(session, "create_goal")[0].result);
		assert.equal(created.origin, "tool");

		// First report: the extension issues an opaque identity.
		const first = await session.waitForToolResult("update_goal", 1);
		assert.equal(first.isError, true, "the first report is recorded and refused below the threshold");
		assert.match(String(first.result.content[0].text), /Blocker recorded \(1 of 3 consecutive Goal turns\)/);
		const issued = structuredGoal(first.result).blockerId;
		assert.match(issued, /^blocker_[0-9a-f]{8}$/);

		// Re-drive the remaining turns with the issued identity, exactly as a model
		// would after reading get_goal.
		writeFileSync(session.scriptPath, JSON.stringify(chained(issued)), "utf8");
		writeFileSync(gate, "", "utf8");

		const blocked = await waitForSnapshot(
			session,
			(s) => s.data.goal?.status === "blocked",
			"the tool-created Goal to reach the blocked threshold",
		);
		assert.equal(blocked.data.goal.id, created.id, "one identity across creation and the audit");
		assert.equal(blocked.data.goal.origin, "tool", "origin survives the stop");
		assert.equal(blocked.data.goal.blockedAudit.blockerId, issued, "the issued identity is persisted");
		assert.equal(blocked.data.goal.blockedAudit.turns, 3);

		assert.equal(
			runCount(session),
			5,
			"the creating run, the kickoff, and the three audited Goal turns",
		);
		assert.equal(
			continuationEntries(readSessionEntries(await session.sessionFile())).length,
			4,
			"the kickoff plus one continuation per audited Goal turn",
		);
		assertStepsConsumed(session, 9);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		assertCleanRun(session);
	} finally {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	}
});
