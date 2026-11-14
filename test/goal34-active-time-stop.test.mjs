/**
 * Issue #34: Active elapsed time stops at the blocked threshold, in a real Pi.
 *
 * Real-Pi acceptance for #28 found Active elapsed time still accruing after a
 * Goal became blocked — about +72 seconds of blocked time after a blocked Goal
 * edit, and a blocked Goal that kept accruing across a restart. The live clock,
 * the durable snapshot, and the reconstruction must all agree that the interval
 * after the stop is not Goal work.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded and the scripted test provider, and follows the suite's honesty rules:
 * the script is sized exactly, the run/continuation counts are asserted, and the
 * run ends with `assertCleanRun`, so a green result can only come from the Goal
 * lifecycle and never from an exhausted script.
 *
 * The blocked audit is chained the way a real model does it: each report's
 * structured result publishes the Blocker identity the extension has open, the
 * later turns pass it back verbatim, and each Goal turn's trailing response is
 * held at a gate file so the test can prove the clock accrues *while the Goal is
 * still active and idle* — the interval that must be billed — before the third
 * report stops it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
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
import { scriptAuditChain, structuredGoal } from "./helpers/blocked-audit.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
/** The one genuine condition the model reports across consecutive Goal turns. */
const BLOCKER = "the upstream release API token has not been issued yet";
/** Keep in sync with the customTypes registered by the extension. */
const USAGE_ENTRY_TYPE = "goal-usage";
/** Held while the Goal is still active and idle, so its clock must accrue. */
const ACTIVE_HOLD_MS = 1500;
/** Idle time after the stop, long enough that a running clock would show it. */
const STOPPED_IDLE_MS = 2000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every persisted Goal snapshot, in the order the session recorded them. */
function goalSnapshots(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/** Every durable accounting checkpoint, in append order. */
function usageCheckpoints(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === USAGE_ENTRY_TYPE);
}

/** Fail unless exactly `steps` provider responses were consumed. */
function assertStepsConsumed(session, steps) {
	const outcomes = assistantOutcomes(session);
	assert.equal(outcomes.length, steps, `expected exactly ${steps} provider responses, got ${outcomes.length}`);
	assertOnlyFailures(session, []);
}

/** Wait for the next settlement after the records accumulated so far. */
async function waitForNextSettled(session) {
	const settled = session.records.filter((r) => r.type === "agent_settled").length;
	return session.waitForSettled(settled + 1);
}

/**
 * Parse the fields bare `/goal` reports. The status report is the user-facing
 * contract for "usage, active time, budget, and remaining capacity", so parsing it
 * pins the format instead of duplicating it.
 */
function parseStatus(message) {
	const one = (pattern) => {
		const match = pattern.exec(message);
		assert.ok(match, `no ${pattern} in:\n${message}`);
		return match[1];
	};
	const output = /output (\d+) including reasoning (\d+)/.exec(message);
	assert.ok(output, `no output/reasoning split in:\n${message}`);
	return {
		status: one(/^Goal \S+ — (\S+)/),
		revision: Number(one(/Revision: (\d+)/)),
		totalTokens: Number(one(/Token usage: (\d+) tokens/)),
		inputTokens: Number(one(/\(input (\d+),/)),
		outputTokens: Number(output[1]),
		reasoningTokens: Number(output[2]),
		activeSeconds: Number(one(/Active time: (\d+)s/)),
	};
}

/**
 * Report the current Goal through bare `/goal` and return everything it says.
 *
 * Notifications are counted rather than matched from the start of the session, so a
 * later report cannot be answered by an earlier one.
 */
async function reportUsage(session, matcher) {
	const seen = session.records.filter(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && matcher(r),
	).length;
	await session.prompt("/goal");
	const notify = await session.waitFor("a fresh matching /goal report", (records) => {
		const matches = records.filter(
			(r) => r.type === "extension_ui_request" && r.method === "notify" && matcher(r),
		);
		return matches.length > seen ? matches[matches.length - 1] : undefined;
	});
	return parseStatus(notify.message);
}

/** Create the Goal and confirm the kickoff run started. */
async function startGoal(session) {
	await session.prompt(`/goal ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await session.waitFor("kickoff run started", (records) =>
		records.some((r) => r.type === "turn_start") ? true : undefined,
	);
}

/**
 * Wait for Goal turn `index`'s report to be finalized, hold the Goal active and
 * idle for `holdMs`, substitute the identity the extension now has open into the
 * remaining turns, and only then release that turn's trailing response.
 *
 * Holding before the rewrite is what makes the accrual window real: the Goal is
 * active with no run in flight, which is exactly the idle-active time the
 * Active-elapsed-time contract bills and the defect was dropping.
 */
async function holdThenAdvanceGate(session, chain, index, holdMs) {
	const result = await session.waitForToolResult("update_goal", index + 1);
	const currentId = structuredGoal(result.result)?.blockerId ?? undefined;
	writeFileSync(session.scriptPath, JSON.stringify(chain.build(currentId)), "utf8");
	await sleep(holdMs);
	writeFileSync(chain.gates[index], "", "utf8");
	return currentId;
}

/** Every checkpoint written at or after the newest snapshot's position. */
function checkpointsAfterLastSnapshot(entries) {
	const snapshots = goalSnapshots(entries);
	const newest = snapshots.at(-1);
	const boundary = entries.indexOf(newest);
	return usageCheckpoints(entries).filter((entry) => entries.indexOf(entry) > boundary);
}

test("a blocked Goal stops its active-time clock, and a restart never resumes it", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const firstSessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));

	const session = await PiRpcSession.start({ cwd: workDir, sessionDir: firstSessionDir });
	// The chain is scripted before the Goal exists: the kickoff is the scripted
	// provider's first request. Three consecutive reports of the same condition
	// reach the blocked threshold on the third.
	const chain = scriptAuditChain(
		session,
		[{ blocker: BLOCKER }, { blocker: BLOCKER, id: "issued" }, { blocker: BLOCKER, id: "issued" }],
		[{ text: "Ordinary work after the block." }],
	);
	let sessionFile;
	// The folded active time the stop committed; the restart must resume from exactly this.
	let frozenMs = 0;
	try {
		await startGoal(session);

		// Goal turn 2 reports the blocker (1 of 3) and holds its trailing response:
		// the Goal is still active, so the clock accrues while nothing runs.
		await holdThenAdvanceGate(session, chain, 0, ACTIVE_HOLD_MS);
		// Goal turn 3 reports the same condition (2 of 3) and holds again.
		await holdThenAdvanceGate(session, chain, 1, ACTIVE_HOLD_MS);
		// Goal turn 4's third consecutive report reaches the threshold: the Goal
		// becomes blocked before its trailing response is written.
		await session.waitForToolResult("update_goal", 3);
		await session.waitForNotify((r) => r.message.includes("is now blocked"));

		const blockedSnapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(blockedSnapshot.status, "blocked", "the stop is durable before anything else happens");
		const frozen = blockedSnapshot.usage.activeMs;
		frozenMs = frozen;

		const before = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(before.status, "blocked");
		assert.equal(before.revision, 3, "each counted report is its own revision");
		assert.equal(before.totalTokens, 105, "the kickoff plus three Goal turns are Goal work");
		assert.ok(
			before.activeSeconds >= 3,
			`the active interval before the stop was billed (${before.activeSeconds}s < 3s)`,
		);
		assert.equal(
			before.activeSeconds,
			Math.floor(frozenMs / 1000),
			"the live view and the durable snapshot agree on the frozen value",
		);

		// The defect: with the clock still running, this idle window is billed to a
		// Goal that has already stopped.
		await sleep(STOPPED_IDLE_MS);
		const after = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(after.status, "blocked");
		assert.equal(after.activeSeconds, before.activeSeconds, "a blocked Goal accrues no further active time");
		assert.equal(after.totalTokens, before.totalTokens, "and accounts no further tokens");

		// An ordinary run after the stop is not Goal work at all.
		await session.prompt("anything else to do?");
		await waitForNextSettled(session);
		const afterOrdinary = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(afterOrdinary.activeSeconds, before.activeSeconds, "an ordinary run adds no active time");
		assert.equal(afterOrdinary.totalTokens, before.totalTokens, "and no Goal-owned tokens");

		// Nothing after the stop may checkpoint a larger active time either.
		const entries = readSessionEntries(await session.sessionFile());
		for (const checkpoint of checkpointsAfterLastSnapshot(entries)) {
			assert.equal(
				checkpoint.data.usage.activeMs,
				frozenMs,
				"a checkpoint written after the stop keeps the frozen value",
			);
		}

		assert.equal(continuationEntries(entries).length, 3, "one continuation per Goal turn before the stop");
		assert.equal(runCount(session), 5, "kickoff, three Goal turns, and one ordinary run");
		assertStepsConsumed(session, 8);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(session.findSessionFile()));
	copyFileSync(join(firstSessionDir, basename(sessionFile)), sessionFile);

	// Process downtime: it must not accrue either, and the stopped clock must not
	// restart with the new process.
	await sleep(3000);

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	// Nothing may run: loading a Goal admits no work, and a blocked Goal never
	// continues on its own.
	writeFileSync(resumed.scriptPath, JSON.stringify([{ text: "Never requested." }, { text: "Never requested." }]), "utf8");
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (blocked)"));
		const restarted = await reportUsage(resumed, (r) => r.message.includes(OBJECTIVE));
		assert.equal(restarted.status, "blocked", "the stopped status survives the restart");
		assert.equal(
			restarted.activeSeconds,
			Math.floor(frozenMs / 1000),
			"the restart resumes from the frozen value, adding neither the stopped interval nor the downtime",
		);
		assert.equal(restarted.totalTokens, 105, "exact token accounting survives the restart");
		assert.equal(continuationEntries(readSessionEntries(sessionFile)).length, 3, "no continuation after the stop");
		assert.equal(runCount(resumed), 0, "loading a blocked Goal admits no work");
		assertStepsConsumed(resumed, 0);
		assertCleanRun(resumed);
		assert.equal(resumed.extensionErrors().length, 0);
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(firstSessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});
