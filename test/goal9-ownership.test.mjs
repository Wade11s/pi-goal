/**
 * Issue #24 batch 1: identity-scoped Goal-owned attribution.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess and asserts the exact
 * accounted totals at public seams (`/goal`), plus the durable entries. The rule
 * under test: only explicitly admitted Goal-owned work is charged — a kickoff, an
 * edit, a resume, an automatic Continuation, or the one Budget wrap-up. Ordinary
 * prompts, creation controls, pre-creation responses, and unrelated same-batch
 * tool results are excluded in every lifecycle status.
 *
 * Single-Goal creation (issue #83, ADR-0003) removed the one live path that could
 * replace an *unfinished* Goal, so the replacement scenarios here supersede a
 * complete Goal and the abandoned-run ones are expressed through `/goal:clear`.
 * The retired machinery is still load-bearing for historical branches, which is
 * why the recovered-tail cases replay the immutable 0.2.0 fixture in
 * `test/fixtures/historical/` instead of driving the removed command behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { NESTED_LEAF_ACCOUNTED, NESTED_OUTER_TOOL } from "./extensions/nested-usage.ts";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	continuationEntries,
	currentGoalSnapshot,
	customMessageEntries,
	goalSnapshots,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
	script,
	submitCommand,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
/** Test-only extension whose outer tool reports nested model usage on its result. */
const NESTED_EXTENSION = join(import.meta.dirname, "extensions", "nested-usage.ts");

function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
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

		await session.prompt("/goal:pause");
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

test("a Goal created while a complete Goal's run is still in flight starts at zero and never inherits its usage", async () => {
	// One session works one Goal at a time (ADR-0003): an unfinished Goal refuses
	// `/goal <objective>`, so the only replacement the command surface can still
	// produce supersedes a *complete* Goal. That Goal's completing run may still be
	// in flight (its final wrap-up response), which is the seam this test pins: the
	// creation takes the slot with a fresh ledger and the old run's late work is
	// charged to nobody, never to the new identity.
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Original kickoff.", usage: { input: 100, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 2 } },
			{ text: "Wrapping up.", waitForFile: gate, usage: { input: 20, output: 2 } },
			{ text: "New Goal kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const original = await waitForStoredGoal(session, (goal) => goal.status === "complete", "the Goal to complete");
		assert.equal(original.usage.totalTokens, 132, "the kickoff (110) and the completing turn (22)");

		// The completing run's wrap-up response is held, so the creation happens while
		// that run is still in flight. A complete Goal does not block it, and nothing
		// is asked of the user.
		const created = await session.prompt("/goal A new objective entirely");
		assert.equal(created.data.disposition, "handled");
		const replaced = await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		assert.match(replaced.message, new RegExp(`replacing ${original.id}`));
		assert.equal(
			session.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm").length,
			0,
			"a complete Goal never asks for a replacement confirmation",
		);
		writeFileSync(gate, "", "utf8");

		// The new identity's own kickoff (22) and its aborted continuation (15) are its
		// only work; the held wrap-up (22) is not.
		await abortActiveLoop(session, 3);
		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 37, "the new Goal starts at zero and inherits nothing");
		const entries = readSessionEntries(await session.sessionFile());
		const current = currentGoalSnapshot(entries).data.goal;
		assert.equal(current.id, status.goalId);
		assert.notEqual(current.id, original.id);
		assert.equal(current.revision, 0, "a creation starts at revision 0");

		// The complete record keeps exactly the usage it had already accounted, and the
		// replacement's preserve snapshot is the old identity's own record: no late
		// report is added to it, because completion is terminal for accounting.
		const oldSnapshots = goalSnapshots(entries).filter((e) => e.data.goal?.id === original.id);
		assert.deepEqual(
			oldSnapshots.map((e) => `${e.data.goal.status}:${e.data.goal.usage.totalTokens}`),
			["active:0", "complete:132", "complete:132"],
			"creation, completion, and the preserved record that precedes the new identity",
		);
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
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

		await session.prompt("/goal:clear");
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

		const editResponse = await session.prompt("/goal:edit Verify a completely different new objective");
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

test("a Goal created while a complete Goal's nested run is still in flight is never charged its tail", async () => {
	// One session works one Goal at a time (ADR-0003), so the command surface's only
	// replacement supersedes a *complete* Goal. Its completing run can still be in
	// flight — here holding a nested tool call whose result lands after the creation
	// snapshot — and that tail was admitted for the old identity. Completion is
	// terminal for accounting, so it belongs to nobody: it is never charged to the new
	// identity, live or replayed, and the old record keeps exactly its accounted work.
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
			{ text: "Original kickoff.", usage: { input: 100, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 2 } },
			{
				toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }],
				waitForFile: gate,
				usage: { input: 20, output: 2 },
			},
			{ text: "New Goal kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const original = await waitForStoredGoal(session, (goal) => goal.status === "complete", "the Goal to complete");
		assert.equal(original.usage.totalTokens, 132, "the kickoff (110) and the completing turn (22)");

		// Create the next Goal while the completing run's nested call is still held.
		const created = await session.prompt("/goal A new objective entirely");
		assert.equal(created.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));

		// Release the old run's nested call: it finalizes *after* the creation snapshot,
		// and its nested tool result lands after that.
		writeFileSync(gate, "", "utf8");
		await session.waitForToolResult(NESTED_OUTER_TOOL, 1);
		await abortActiveLoop(session, 3);

		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(
			status.totalTokens,
			37,
			"22 for the new Goal's own kickoff + 15 for its aborted continuation; the old run's held response " +
				"and nested tool result are not charged to it",
		);
		assert.equal(status.nestedTokens, 0, "the old identity's nested usage is not transferred");

		// The nested usage arrives merged into the tool result's own `usage` — the
		// shape the store has to charge exactly once — so the report is read off the
		// branch entry the finalized call produced. It is real accounted-shaped work
		// that the creation boundary must leave with nobody.
		const liveFile = await session.sessionFile();
		const outerResult = toolResults(session, NESTED_OUTER_TOOL).at(-1);
		assert.equal(outerResult.isError, false, "the nested work ran and finalized cleanly");
		const liveEntries = readSessionEntries(liveFile);
		const outerEntry = liveEntries.find(
			(entry) => entry.type === "message" && entry.message?.toolCallId === outerResult.toolCallId,
		);
		assert.equal(outerEntry.message.usage.totalTokens, 150, "Pi reports the nested usage on the tool result");
		assert.equal(
			outerEntry.message.usage.totalTokens - outerEntry.message.usage.cacheRead,
			NESTED_LEAF_ACCOUNTED,
			"only the uncached part of the nested report would be accounted",
		);

		const liveStates = goalSnapshots(liveEntries);
		const oldSnapshots = liveStates.filter((e) => e.data.goal?.id === original.id);
		assert.equal(oldSnapshots.at(-1).data.goal.usage.totalTokens, 132, "the old identity's total is unchanged");
		assert.equal(oldSnapshots.at(-1).data.goal.usage.nestedTokens, 0, "no late nested usage was added");
		assert.equal(oldSnapshots.at(-1).data.goal.status, "complete");
		assert.equal(liveStates.at(-1).data.goal.id, currentGoalSnapshot(liveEntries).data.goal.id);
		assert.notEqual(liveStates.at(-1).data.goal.id, original.id, "the new identity is current");

		// A fresh process reconstructs from the branch and must reach the same totals:
		// the late tail belongs to neither identity.
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
			assert.equal(reloadedOld.data.goal.usage.totalTokens, 132, "the old identity's durable total survives reload");
			assert.equal(reloadedOld.data.goal.status, "complete");
			// The reload neither re-affirms the replacement nor rewrites the historical
			// snapshot: there is no tail to recover, so it appends nothing.
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
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("a refused creation during an in-flight nested response leaves the tail with the active identity", async () => {
	// The refusal #83 adds is the riskiest point to get wrong for accounting: it is a
	// command that runs *while* the active Goal's response is on the wire. It must
	// change no Goal bytes and no ownership, so the response and its nested tool
	// result that finalize afterwards are still charged to the identity that was
	// admitted for them — not to nobody, and not to a Goal that was never created.
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
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		const before = readFileSync(await session.sessionFile(), "utf8");

		// Refuse a second Goal while the kickoff's request is streaming.
		const refused = await session.prompt("/goal A replacement objective");
		assert.equal(refused.data.disposition, "handled");
		const refusal = await session.waitForNotify((r) =>
			r.message.startsWith("Goal not created: an unfinished Goal is already set"),
		);
		assert.equal(refusal.notifyType, "warning");
		assert.equal(
			readFileSync(await session.sessionFile(), "utf8"),
			before,
			"the refusal wrote no Goal bytes while the run was in flight",
		);

		// Release the response: it and its nested tool result were admitted for the
		// active identity, and the refusal did not disturb that.
		writeFileSync(gate, "", "utf8");
		await session.waitForToolResult(NESTED_OUTER_TOOL, 1);
		await abortActiveLoop(session, 1);

		const status = await reportStatus(session);
		assert.equal(status.goalId, original.id, "the refused command left the same Goal in place");
		assert.equal(status.status, "active");
		assert.equal(
			status.totalTokens,
			175,
			"the exact assistant (110) plus nested tool-result (50) tail, and the aborted continuation (15) it earned",
		);
		assert.equal(status.nestedTokens, NESTED_LEAF_ACCOUNTED);

		// A fresh process reconstructs the same attribution from the branch.
		const { resumed, dir } = await reload(session, workDir);
		script([{ text: "Never requested." }, { hang: true }], resumed);
		try {
			await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
			const restored = await reportStatus(resumed);
			assert.equal(restored.goalId, original.id);
			assert.equal(restored.totalTokens, 175, "the reload converges on the live total");
			assert.equal(restored.nestedTokens, NESTED_LEAF_ACCOUNTED);
			assertStepsConsumed(resumed, 0, []);
			assert.equal(resumed.extensionErrors().length, 0);
		} finally {
			await resumed.stop();
			rmSync(dir, { recursive: true, force: true });
		}
		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("clearing a refused Goal and creating its successor keeps live and replay agreement", async () => {
	// The escape hatch the refusal names is `/goal:clear` followed by a fresh creation,
	// and it can be taken while the abandoned Goal's response is still on the wire.
	// The clear is the boundary that abandons that admission, so the late response is
	// charged to nobody — never to the successor — and the replay of the branch has to
	// reach the same totals instead of retroactively charging it to the cleared
	// identity.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	const gate = join(workDir, "provider-gate");
	script(
		[
			{ text: "Original kickoff.", waitForFile: gate, usage: { input: 100, output: 10 } },
			{ text: "New Goal kickoff.", usage: { input: 20, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Refuse the successor first: that is the command that names /goal:clear.
		const refused = await session.prompt("/goal A third objective");
		assert.equal(refused.data.disposition, "handled");
		const refusal = await session.waitForNotify((r) =>
			r.message.startsWith("Goal not created: an unfinished Goal is already set"),
		);
		assert.match(refusal.message, /run \/goal:clear first/);

		// Take the escape hatch while the old response is still streaming.
		const cleared = await session.prompt("/goal:clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		// Create the successor while the old response is still streaming. The creation
		// boundary is durable before the successor's own snapshot; a *fresh* creation
		// then waits for the session to go idle before it delivers its kickoff, so the
		// command is submitted and its response awaited after the release.
		const createPromise = submitCommand(session, "create-c", "/goal A third objective");
		await waitForStoredGoal(session, (goal) => goal.objective === "A third objective", "the new Goal's snapshot");
		const statesAtCreation = goalSnapshots(readSessionEntries(await session.sessionFile()));
		assert.equal(currentGoalSnapshot(statesAtCreation).data.goal.objective, "A third objective");

		// Release the old response: it lands after the creation boundary and is charged
		// to nobody, live and on replay. The successor's own kickoff follows once the
		// session is idle, and its continuation is the aborted 15.
		writeFileSync(gate, "", "utf8");
		assert.equal((await createPromise).data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 3);

		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(
			status.totalTokens,
			37,
			"the successor's own kickoff (22) and aborted continuation (15); the cleared identity's " +
				"late response is charged to nobody",
		);
		assert.equal(status.nestedTokens, 0);

		const liveEntries = readSessionEntries(await session.sessionFile());
		const liveStates = goalSnapshots(liveEntries);
		assert.equal(
			liveStates.length,
			statesAtCreation.length,
			"the live path appends nothing after the creation boundary",
		);
		const oldStates = liveStates.filter((e) => e.data.goal?.id === original.id);
		assert.equal(oldStates.length, 1, "the cleared identity keeps its creation snapshot only");
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
			// historical record for the cleared identity's late response: live refused it,
			// so the replay has to refuse it too instead of freezing a total nobody accounted.
			await resumed.prompt("/goal:pause");
			await resumed.waitForNotify((r) => r.message.includes("paused"));
			await resumed.prompt("anything else after the reload?");
			await resumed.waitForSettled(1);
			const afterBoundary = goalSnapshots(readSessionEntries(await resumed.sessionFile()));
			const oldAfterBoundary = afterBoundary.filter((e) => e.data.goal?.id === original.id);
			assert.equal(oldAfterBoundary.length, 1, "no historical freeze is invented for the late response");
			for (const state of oldAfterBoundary) {
				assert.equal(state.data.goal.usage.totalTokens, 0, "and the cleared identity's total stays exact");
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

/**
 * Start a real Pi session on a copy of an immutable historical branch fixture.
 *
 * The fixtures were captured from a released pi-goal whose command surface could
 * still replace an unfinished Goal, a behavior #83 removed. Their header records
 * the capturing machine's working directory, so the copy gets a fresh one; every
 * other line is byte-identical, and `mutate` may derive a variant by rewriting
 * parsed entries (as the budget case below does) without touching the fixture.
 */
function prepareHistoricalSession(fixture, sessionFile, cwd, mutate) {
	copyFileSync(join(import.meta.dirname, "fixtures", "historical", fixture), sessionFile);
	const lines = readFileSync(sessionFile, "utf8").split("\n");
	const header = JSON.parse(lines[0]);
	header.cwd = cwd;
	lines[0] = JSON.stringify(header);
	if (!mutate) {
		writeFileSync(sessionFile, lines.join("\n"), "utf8");
		return;
	}
	const entries = lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
	mutate(entries);
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

const HISTORICAL_REPLACED = "v0.2.0-open-superseded-tail.jsonl";
/** The replaced identity and the replacement the fixture's `/goal` created. */
const HISTORICAL_OLD_ID = "goal_a59e4c80";
const HISTORICAL_NEW_ID = "goal_298e9038";

/** Start a session on the historical branch, with a script that must stay unread. */
async function startHistorical(fixture, mutate) {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-historical-"));
	const sessionFile = join(dir, "historical.jsonl");
	prepareHistoricalSession(fixture, sessionFile, workDir, mutate);
	const session = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Never requested." }, { hang: true }], session);
	return { session, workDir, dir, sessionFile };
}

test("a historical branch that replaced an unfinished Goal mid-flight recovers the old tail as history", async () => {
	// The branch was captured from pi-goal 0.2.0, which still replaced an unfinished
	// Goal after a confirmation dialog, and it died in the window the superseded
	// machinery exists for: the old identity's response landed after the replacement
	// snapshot, with no freeze boundary after it. The command surface can no longer
	// produce that branch (#83), which is exactly why the retained machinery has to
	// reconstruct it: the replacement is current at zero usage, the old tail is
	// recovered onto one superseded record, and the restored replacement is an
	// ordinary unfinished Goal that `/goal <objective>` now refuses.
	const { session, workDir, dir, sessionFile } = await startHistorical(HISTORICAL_REPLACED);
	try {
		const restored = await session.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.ok(restored.message.includes(HISTORICAL_NEW_ID), restored.message);
		const entries = readSessionEntries(sessionFile);
		const current = currentGoalSnapshot(entries).data.goal;
		assert.equal(current.id, HISTORICAL_NEW_ID, "the replacement — never the superseded record — is current");
		assert.equal(current.usage.totalTokens, 0, "the replacement is not charged for the old identity's tail");

		// The tail is frozen as one historical record at the first durable boundary of
		// this runtime, and it can never become the current Goal again.
		const frozen = goalSnapshots(entries).filter((entry) => entry.data.superseded === true);
		assert.equal(frozen.length, 1, "exactly one historical snapshot is recovered from the branch");
		assert.equal(frozen[0].data.goal.id, HISTORICAL_OLD_ID, "the tail stays with the identity that was replaced");
		assert.equal(frozen[0].data.goal.usage.totalTokens, 110, "the exact assistant tail the branch carries");
		assert.equal(frozen[0].data.goal.status, "active", "its Lifecycle status is the one it had when replaced");

		// The derived history timeline still renders both identities.
		await session.prompt("/goal:history");
		const history = await session.waitForNotify((r) => r.message.includes("Goal history on this branch (2 records"));
		for (const expected of ["created", "replaced", HISTORICAL_OLD_ID, HISTORICAL_NEW_ID]) {
			assert.ok(history.message.includes(expected), `the timeline names ${expected}`);
		}

		// The restored replacement is an unfinished Goal, so the single-Goal rule applies
		// to it without any special case for "recovered from a replacement".
		const status = await reportStatus(session);
		assert.equal(status.goalId, HISTORICAL_NEW_ID);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 0);
		const beforeRefusal = readFileSync(sessionFile, "utf8");
		await session.prompt(`/goal ${OBJECTIVE}`);
		const refusal = await session.waitForNotify((r) =>
			r.message.startsWith("Goal not created: an unfinished Goal is already set"),
		);
		assert.equal(refusal.notifyType, "warning");
		assert.match(refusal.message, /run \/goal:clear first/);
		assert.equal(readFileSync(sessionFile, "utf8"), beforeRefusal, "the refusal wrote no Goal bytes");
		assertStepsConsumed(session, 0, []);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a historical branch whose recovered tail crosses the old Goal's budget records the stop on its own record", async () => {
	// The live command surface can no longer replace an unfinished Goal, so the only
	// way an old identity's in-flight tail crosses a budget after it was replaced is a
	// branch like this one. The fixture's old Goal is derived into a budgeted Goal: the
	// recovered 110-token tail crosses the 100-token budget, so the exhaustion belongs
	// to the old identity's durable record only. The replacement keeps its fresh ledger
	// and its own admission, and the superseded identity never continues or earns a
	// wrap-up.
	const budgetTheOldGoal = (entries) => {
		for (const entry of entries) {
			if (entry.customType !== "goal-state") continue;
			if (entry.data?.goal?.id !== HISTORICAL_OLD_ID) continue;
			entry.data.goal.tokenBudget = 100;
		}
	};
	const { session, workDir, dir, sessionFile } = await startHistorical(HISTORICAL_REPLACED, budgetTheOldGoal);
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 0, "the replacement keeps its own fresh ledger");

		const entries = readSessionEntries(sessionFile);
		const oldSnapshots = goalSnapshots(entries).filter((e) => e.data.goal?.id === HISTORICAL_OLD_ID);
		const finalized = oldSnapshots.at(-1);
		assert.equal(finalized.data.superseded, true, "the recovered tail is historical");
		assert.equal(finalized.data.goal.status, "budget_limited", "the old identity's exhaustion is recorded");
		assert.equal(finalized.data.goal.usage.totalTokens, 110, "the in-flight tail stays attributed to it");
		assert.equal(finalized.data.goal.tokenBudget, 100);

		// No old continuation and no old wrap-up: the superseded identity never continues.
		assert.equal(
			continuationEntries(entries).filter((e) => e.content.includes(HISTORICAL_OLD_ID)).length,
			0,
			"the superseded identity earns no continuation",
		);
		assert.equal(
			customMessageEntries(entries, "goal-budget-wrapup").filter((e) => e.content.includes(HISTORICAL_OLD_ID)).length,
			0,
			"the superseded identity earns no wrap-up",
		);
		assertStepsConsumed(session, 0, []);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
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
		await session.prompt("/goal:pause");
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
