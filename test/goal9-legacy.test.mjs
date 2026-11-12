/**
 * Issue #24 batch 1: durable branch-local 0.1.0 cutover.
 *
 * Every scenario loads an immutable pre-repair (0.1.0) session fixture through a
 * real `pi --mode rpc` subprocess and asserts observable behavior: the restored
 * status, the durable repaired snapshot and cutover marker, the migration
 * notices, the exact legacy reconstructed totals, and the absence of any work or
 * provider request triggered by loading alone.
 *
 * The fixtures were produced by the pre-repair writer (pi-goal 0.1.0) and are
 * byte-fixed: the derived variants replace only the newest `goal-state` payload
 * and truncate everything after it, so each baseline is deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
const FIXTURES = join(import.meta.dirname, "fixtures", "legacy");

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/** Copy one immutable fixture into a fresh session dir and start Pi on it. */
async function startLegacy(fixture, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-legacy-"));
	const sessionFile = join(dir, "legacy.jsonl");
	copyFileSync(join(FIXTURES, fixture), sessionFile);
	// Pi refuses to resume a session whose stored working directory is missing. The
	// fixtures were captured in a throwaway temp dir, so recreate that exact path.
	const stored = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
	if (stored.cwd) mkdirSync(stored.cwd, { recursive: true });
	const session = await PiRpcSession.start({ ...options, sessionFile, cwd: options.cwd ?? dir });
	return { session, dir, sessionFile };
}

function goalStates(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

function cutovers(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-cutover");
}

test("a legacy active Goal is cut over once, keeps its reconstructed baseline, and continues under repaired attribution", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-active.jsonl");
	// The provider is only read when a request is made, so the script also proves
	// that loading alone triggered no provider request.
	script(
		[
			{ text: "Ordinary prompt.", usage: { input: 20, output: 2 } },
			{ text: "Continuation answer.", usage: { input: 30, output: 3 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.equal(runCount(session), 0, "loading and cutover start no run");

		// The repaired snapshot and the branch-local cutover are durable.
		const afterLoad = readSessionEntries(sessionFile);
		const snapshots = goalStates(afterLoad);
		assert.equal(snapshots.length, 2, "the legacy snapshot plus the repaired one");
		assert.equal(snapshots[0].data.repaired, undefined, "the original stays a 0.1.0 snapshot");
		assert.equal(snapshots[1].data.repaired, true, "the cutover writes a repaired snapshot");
		assert.equal(snapshots[1].data.goal.id, snapshots[0].data.goal.id, "identity is preserved");
		assert.equal(snapshots[1].data.goal.status, "active");
		assert.equal(snapshots[1].data.goal.usage.totalTokens, 180, "legacy reconstructed total is frozen");
		assert.equal(cutovers(afterLoad).length, 1, "one branch-local cutover marker");
		assert.equal(cutovers(afterLoad)[0].data.goalId, snapshots[0].data.goal.id);

		// The user-facing report is the legacy reconstructed total, not a reclassification.
		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 180);

		// A later restart does not migrate again.
		await session.stop();
		const second = await PiRpcSession.start({ sessionFile, cwd: dir });
		script([{ text: "Never requested." }, { text: "Never requested." }], second);
		try {
			await second.waitForNotify((r) => r.message.includes("restored (active)"));
			const again = readSessionEntries(sessionFile);
			assert.equal(goalStates(again).length, 2, "no second cutover");
			assert.equal(cutovers(again).length, 1);
			assertOnlyFailures(second, []);
		} finally {
			await second.stop();
		}

		// Continue: an ordinary prompt is excluded, the automatic Continuation is
		// Goal-owned, and the loop is stopped deliberately.
		const third = await PiRpcSession.start({ sessionFile, cwd: dir });
		script(
			[
				{ text: "Ordinary prompt.", usage: { input: 20, output: 2 } },
				{ text: "Continuation answer.", usage: { input: 30, output: 3 } },
				{ hang: true },
			],
			third,
		);
		try {
			await third.waitForNotify((r) => r.message.includes("restored (active)"));
			await third.prompt("Please keep going");
			await third.waitFor(
				"the continuation run started",
				(records) => (records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined),
			);
			await third.sendSimple("abort");
			await third.waitForSettled(1);
			const continued = await reportStatus(third);
			assert.equal(
				continued.totalTokens,
				228,
				"180 legacy + 33 Goal-owned Continuation + 15 aborted continuation (ordinary prompt excluded)",
			);
			assertOnlyFailures(third, [{ stopReason: "aborted" }]);
			assert.equal(third.extensionErrors().length, 0);
		} finally {
			await third.stop();
		}
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("non-active legacy statuses stay stopped, complete stays terminal, and a tombstone leaves no Goal", async () => {
	for (const fixture of [
		"legacy-paused.jsonl",
		"legacy-blocked.jsonl",
		"legacy-usage-limited.jsonl",
		"legacy-complete.jsonl",
	]) {
		const { session, dir, sessionFile } = await startLegacy(fixture);
		script([{ text: "Never requested." }, { text: "Never requested." }], session);
		try {
			await session.waitForNotify((r) => r.message.includes("restored ("));
			assert.equal(runCount(session), 0, `${fixture}: loading starts no run`);
			const entries = readSessionEntries(sessionFile);
			assert.equal(goalStates(entries).length, 2, `${fixture}: cut over once`);
			const status = await reportStatus(session);
			assert.equal(status.totalTokens, 165, `${fixture}: legacy total preserved`);
			assert.notEqual(status.status, "active");
			// No continuation is ever requested for a stopped Goal.
			await session.prompt("anything else?");
			await session.waitForSettled(1);
			assert.equal(runCount(session), 1, `${fixture}: only the ordinary prompt ran`);
			assertCleanRun(session);
			assert.equal(session.extensionErrors().length, 0);
		} finally {
			await session.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	const tombstone = await startLegacy("legacy-tombstone.jsonl");
	script([{ text: "Never requested." }], tombstone.session);
	try {
		const status = await reportStatus(tombstone.session);
		assert.equal(status, null);
		assert.equal(runCount(tombstone.session), 0, "loading a tombstone starts no run");
		const entries = readSessionEntries(tombstone.sessionFile);
		assert.equal(cutovers(entries).length, 0, "a tombstone is not a legacy Goal to migrate");
		assertCleanRun(tombstone.session);
		assert.equal(tombstone.session.extensionErrors().length, 0);
	} finally {
		await tombstone.session.stop();
		rmSync(tombstone.dir, { recursive: true, force: true });
	}
});

test("a malformed or unrecognized newest legacy snapshot fails closed with guidance and starts no work", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-malformed-latest.jsonl");
	script([{ text: "Never requested." }], session);
	try {
		const notice = await session.waitForNotify((r) => r.message.includes("could not read the newest Goal snapshot"));
		assert.equal(notice.notifyType, "error");
		assert.match(notice.message, /remove or repair the newest one/);
		assert.equal(runCount(session), 0, "fail-closed loading starts no run");
		const status = await reportStatus(session);
		assert.equal(status, null);
		const entries = readSessionEntries(sessionFile);
		assert.equal(goalStates(entries).length, 2, "no repaired snapshot is written for a corrupt latest entry");
		assert.equal(cutovers(entries).length, 0);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("0.1.0 optional-field defaults are preserved: origin command, zero usage, no wrap-up, no audit", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-optional-defaults.jsonl");
	script([{ text: "Never requested." }, { text: "Never requested." }], session);
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const status = await reportStatus(session);
		assert.equal(status.status, "active");
		assert.equal(status.totalTokens, 0, "absent usage is a zero baseline");
		assert.equal(status.tokenBudget, "none (unbounded)", "absent budget stays unbounded");
		assert.equal(session.records.some((r) => r.message?.includes("Blocker:")), false);
		const entries = readSessionEntries(sessionFile);
		const repaired = goalStates(entries).at(-1).data.goal;
		assert.equal(repaired.origin, undefined, "the 0.1.0 snapshot stays byte-fixed");
		assert.equal(repaired.usage.totalTokens, 0);
		assert.equal(repaired.wrapUpPending, undefined);
		assert.equal(repaired.blockedAudit, undefined);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the configured maximum clamps an unbounded legacy Goal with an explicit notice, never the default", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-active-baseline.jsonl", {
		settings: { goal: { defaultTokenBudget: 999, maxTokenBudget: 500 } },
	});
	script([{ text: "Never requested." }, { text: "Never requested." }], session);
	try {
		const notice = await session.waitForNotify((r) => r.message.includes("configured maximum token budget"));
		assert.equal(notice.notifyType, "warning");
		assert.match(notice.message, /500 tokens/);
		assert.match(notice.message, /unbounded/);
		assert.doesNotMatch(notice.message, /999/);
		const status = await reportStatus(session);
		assert.equal(status.tokenBudget, "500 tokens");
		assert.equal(status.totalTokens, 165, "usage is preserved");
		assert.equal(status.remaining, "335 tokens");
		const repaired = goalStates(readSessionEntries(sessionFile)).at(-1).data.goal;
		assert.equal(repaired.tokenBudget, 500);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an active legacy Goal already at its budget becomes budget_limited before work and earns one wrap-up", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-exhausted-active.jsonl", {
		settings: { goal: { maxTokenBudget: 500 } },
	});
	script(
		[
			{ text: "Ordinary prompt.", usage: { input: 20, output: 2 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
		],
		session,
	);
	try {
		const notice = await session.waitForNotify((r) => r.message.includes("already at its token budget"));
		assert.equal(notice.notifyType, "warning");
		assert.match(notice.message, /budget_limited/);
		assert.equal(runCount(session), 0, "the cutover itself admits no work");

		const status = await reportStatus(session);
		assert.equal(status.status, "budget_limited");
		assert.equal(status.totalTokens, 110);

		// A completed ordinary run settles, and the one bounded wrap-up is requested.
		await session.prompt("anything else?");
		await session.waitForSettled(1);
		const entries = readSessionEntries(sessionFile);
		const wrapUps = entries.filter((e) => e.type === "custom_message" && e.customType === "goal-budget-wrapup");
		assert.equal(wrapUps.length, 1, "exactly one bounded wrap-up");
		const after = await reportStatus(session);
		assert.equal(after.status, "budget_limited");
		assert.equal(after.totalTokens, 125, "110 legacy + 15 wrap-up (ordinary prompt excluded)");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a pending legacy wrap-up is delivered at most once", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-pending-wrapup.jsonl");
	script(
		[
			{ text: "Ordinary prompt.", usage: { input: 20, output: 2 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
			{ text: "After the wrap-up.", usage: { input: 5, output: 1 } },
		],
		session,
	);
	try {
		await session.waitForNotify((r) => r.message.includes("restored (budget_limited)"));
		await session.prompt("anything else?");
		await session.waitForSettled(1);
		let entries = readSessionEntries(sessionFile);
		assert.equal(
			entries.filter((e) => e.type === "custom_message" && e.customType === "goal-budget-wrapup").length,
			1,
			"the owed wrap-up is delivered",
		);
		assert.equal(goalStates(entries).at(-1).data.goal.wrapUpPending, false);

		// A second ordinary run must not produce a duplicate historical wrap-up.
		await session.prompt("anything else again?");
		await session.waitForSettled(2);
		entries = readSessionEntries(sessionFile);
		assert.equal(
			entries.filter((e) => e.type === "custom_message" && e.customType === "goal-budget-wrapup").length,
			1,
			"no duplicate wrap-up",
		);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a legacy open audit is preserved for the Blocker-identity handoff without text equivalence", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-open-audit.jsonl");
	script([{ text: "Never requested." }, { text: "Never requested." }], session);
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const status = await reportStatus(session);
		assert.equal(status.blocker, "The test database is unavailable");
		assert.equal(status.blockedTurns, 2);
		const repaired = goalStates(readSessionEntries(sessionFile)).at(-1).data.goal;
		assert.deepEqual(repaired.blockedAudit, { blocker: "The test database is unavailable", turns: 2 });
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an existing tool-created legacy Goal stays a valid historical Goal", async () => {
	const { session, dir, sessionFile } = await startLegacy("legacy-tool-origin.jsonl");
	script([{ text: "Never requested." }, { text: "Never requested." }], session);
	try {
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const status = await reportStatus(session);
		assert.match(status.origin, /the model \(create_goal\)/);
		assert.equal(status.totalTokens, 165);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Report the current Goal, or null when bare /goal says there is none. */
async function reportStatus(session) {
	await session.prompt("/goal");
	const notify = await session.waitFor("a /goal report", (records) => {
		const matches = records.filter(
			(r) =>
				r.type === "extension_ui_request" &&
				r.method === "notify" &&
				(/^Goal \S+ — /.test(r.message) || r.message.includes("No Goal is set")),
		);
		return matches.length ? matches.at(-1) : undefined;
	});
	if (notify.message.includes("No Goal is set")) return null;
	const one = (pattern) => {
		const match = pattern.exec(notify.message);
		assert.ok(match, `no ${pattern} in:\n${notify.message}`);
		return match[1];
	};
	return {
		status: one(/^Goal \S+ — (\S+)/),
		origin: one(/Created by: (.+)/),
		tokenBudget: one(/Token budget: (.+)/),
		totalTokens: Number(one(/Token usage: (\d+) tokens/)),
		remaining: one(/Remaining capacity: (.+)/),
		blocker: notify.message.includes("Blocker: ") ? one(/Blocker: (.+)/) : null,
		blockedTurns: /Blocked audit: (\d+) of/.exec(notify.message)
			? Number(/Blocked audit: (\d+) of/.exec(notify.message)[1])
			: 0,
	};
}
