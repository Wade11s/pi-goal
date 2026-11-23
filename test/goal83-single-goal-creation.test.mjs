/**
 * Issue #83: single-Goal creation semantics (ADR-0003).
 *
 * `/goal <objective>` no longer replaces an unfinished Goal. While one holds the
 * session's single Goal slot — active, paused, blocked, usage_limited, or
 * budget_limited — the command refuses with a warning that names `/goal:clear`,
 * opens no dialog, and changes no Goal bytes. Because the refusal is a warning,
 * the command bridge and the RPC companion answer `refused` for it (those seams
 * are pinned in `goal56-command-bridge.test.mjs` and
 * `goal56-goal-rpc-companion.test.mjs`); the old declined-replacement outcome can
 * no longer be produced. A *complete* Goal does not block: the next
 * `/goal <objective>` is created without a dialog and supersedes the complete
 * record through the ordinary replacement machinery, and the branch still
 * reconstructs and renders that history after a restart.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess with the pi-goal
 * package loaded and the scripted test provider, and asserts public behavior
 * only: the command's own RPC response, extension notifications, absence of an
 * extension-UI `confirm` request, tool results, and the durable session entries.
 * Each script is sized exactly and every test ends in `assertCleanRun` /
 * `assertStepsConsumed`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertStepsConsumed,
	currentGoalSnapshot,
	goalSnapshots,
	lastGoalSnapshot,
	liveUsage,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";
import { structuredGoal } from "./helpers/blocked-audit.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
const NEXT = "Another objective entirely";
/** A usage-limit failure Pi will not retry (quota exhaustion, not a throttle). */
const USAGE_LIMIT_ERROR = "429 insufficient_quota: you exceeded your current quota for this organization";

/** Every raw `goal-state` line of the session, as bytes, for a before/after "nothing happened" proof. */
async function goalBytes(session) {
	return readFileSync(await session.sessionFile(), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "" && line.includes('"goal-state"'))
		.join("\n");
}

/** The number of `goal-history` records on the branch. */
async function historyCount(session) {
	return readSessionEntries(await session.sessionFile()).filter((entry) => entry.customType === "goal-history").length;
}

/** The `goal-history` records on the branch, in commit order. */
function historyRecords(entries) {
	return entries.filter((entry) => entry.customType === "goal-history").map((entry) => entry.data);
}

/** Extension-UI `confirm` requests the host received — one per dialog pi-goal opened. */
function confirmRequests(session) {
	return session.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm").length;
}

/** Create a Goal and wait for its creation announcement; `args` is leading option text such as `--budget 100`. */
async function createGoal(session, objective = OBJECTIVE, args = "") {
	const response = await session.prompt(args === "" ? `/goal ${objective}` : `/goal ${args} ${objective}`);
	assert.equal(response.data.disposition, "handled");
	await session.waitForNotify((r) => r.message.includes("created and activated"));
}

/** Stop an active Goal's continuation loop deliberately with an aborted run (Pi's hard exit). */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/** Hold the scripted provider's next response until `release` is called. */
function gate(session, name = "provider-gate") {
	const path = join(session.cwd, name);
	return {
		step: (step) => ({ ...step, waitForFile: path }),
		release: () => writeFileSync(path, "", "utf8"),
	};
}

/**
 * Create a Goal and pause it while its kickoff response is still held, so the
 * pause is durably in place before the settlement boundary that would otherwise
 * continue the Goal. The kickoff then finishes cleanly and nothing else runs.
 */
async function createPausedGoal(session) {
	const held = gate(session);
	script([held.step({ text: "On it." })], session);
	await createGoal(session);
	await session.waitFor("kickoff turn started", (records) =>
		records.some((r) => r.type === "turn_start") ? true : undefined,
	);
	await session.prompt("/goal:pause");
	await session.waitForNotify((r) => r.message.includes("paused (revision"));
	held.release();
	await session.waitForSettled(1);
	return currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
}

/** The bare `/goal` status reports, in order. */
function statusReports(session) {
	return session.records.filter(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && /^Goal goal_[0-9a-f]+ — /.test(r.message),
	);
}

/**
 * The bare `/goal` report as a comparable value.
 *
 * Only the `Active time` line is dropped: it is a live clock reading, so two
 * reports of the same unchanged active Goal legitimately differ there. Every
 * other line — identity, status, objective, revision, budget, usage — is
 * compared verbatim.
 */
async function inspection(session) {
	const seen = statusReports(session).length;
	await session.prompt("/goal");
	const report = await session.waitFor("a fresh /goal report", () => {
		const reports = statusReports(session);
		return reports.length > seen ? reports.at(-1) : undefined;
	});
	return report.message
		.split("\n")
		.filter((line) => !line.startsWith("Active time:"))
		.join("\n");
}

/**
 * Assert that one `/goal <...>` command was refused by the unfinished Goal.
 *
 * The command is sent with `prompt`, which awaits its own response: a dialog in
 * the way could only time out here, so "handled" is itself proof that nothing
 * was asked of the user.
 */
async function assertRefused(session, command, status) {
	const before = await goalBytes(session);
	const historyBefore = await historyCount(session);
	const runs = runCount(session);
	const confirms = confirmRequests(session);

	const response = await session.prompt(command);
	assert.equal(response.data.disposition, "handled", command);
	const refusal = await session.waitForNotify((r) =>
		r.message.startsWith("Goal not created: an unfinished Goal is already set"),
	);
	assert.equal(refusal.notifyType, "warning", `${command}: a warning, which is what the bridge reports as refused`);
	assert.ok(refusal.message.includes(`(${status}, "`), `${command}: names the Lifecycle status`);
	assert.ok(refusal.message.includes(OBJECTIVE), `${command}: names the Goal that is in the way`);
	assert.match(refusal.message, /\/goal does not replace an unfinished Goal\./);
	assert.match(
		refusal.message,
		/Finish the current Goal, or run \/goal:clear first and then run \/goal <objective> again\./,
	);
	assert.match(refusal.message, /The current Goal is unchanged\.$/);

	assert.equal(confirmRequests(session), confirms, `${command}: no dialog was opened`);
	assert.equal(await goalBytes(session), before, `${command}: wrote no Goal bytes`);
	assert.equal(await historyCount(session), historyBefore, `${command}: appended no history record`);
	assert.equal(runCount(session), runs, `${command}: started no run`);
}

/**
 * Reach each unfinished Lifecycle status through its own real transition, with
 * the session idle afterwards so the refused command is the only thing running.
 *
 * `steps` is the number of provider responses the fixture consumes, and
 * `failures` the assistant outcomes that are the fixture's own deliberate stop.
 */
const UNFINISHED = [
	{
		status: "active",
		steps: 2,
		failures: [{ stopReason: "aborted" }],
		async reach(session) {
			script([{ text: "On it." }, { hang: true }], session);
			await createGoal(session);
			await abortActiveLoop(session, 2);
		},
	},
	{
		status: "paused",
		steps: 1,
		failures: [],
		async reach(session) {
			await createPausedGoal(session);
		},
	},
	{
		status: "blocked",
		steps: 4,
		failures: [],
		async reach(session) {
			// A kickoff, then three automatic Goal turns that answer with nothing at
			// all: the conservative stop makes the Goal blocked without any report.
			script([{ text: "On it." }, {}, {}, {}], session);
			await createGoal(session);
			await session.waitForNotify((r) => r.message.includes("stopped and is now blocked"));
			await session.waitForSettled(1);
		},
	},
	{
		status: "usage_limited",
		steps: 2,
		failures: [{ stopReason: "error", errorMessage: USAGE_LIMIT_ERROR }],
		async reach(session) {
			script([{ text: "On it." }, { error: USAGE_LIMIT_ERROR }], session);
			await createGoal(session);
			await session.waitForNotify((r) => r.message.includes("is now usage_limited"));
			await session.waitForSettled(1);
		},
	},
	{
		status: "budget_limited",
		steps: 3,
		failures: [],
		async reach(session) {
			// 85 tokens at the kickoff, 30 more at the continuation: the 100-token
			// budget is crossed, the one bounded wrap-up is delivered, and the Goal
			// rests at budget_limited with the wrap-up no longer owed.
			script(
				[
					{ text: "On it.", usage: { input: 60, output: 20, cacheWrite: 5 } },
					{ text: "More.", usage: { input: 20, output: 10 } },
					{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
				],
				session,
			);
			await createGoal(session, OBJECTIVE, "--budget 100");
			await waitForSnapshot(session, (s) => s.data.goal?.status === "budget_limited", "the budget stop");
			await session.waitForSettled(1);
		},
	},
];

test("/goal <objective> with an unfinished Goal refuses with a warning naming /goal:clear, for every unfinished Lifecycle status", async () => {
	for (const scenario of UNFINISHED) {
		const session = await PiRpcSession.start();
		const label = scenario.status;
		try {
			await scenario.reach(session);
			const goal = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
			assert.equal(goal.status, scenario.status, `${label}: the fixture reached the status`);
			assert.equal(goal.objective, OBJECTIVE, `${label}: the fixture Goal is the one under test`);

			// The plain spelling, and a spelling that carries a leading option and an
			// Objective whose first word is a verb: the unfinished Goal is what refuses
			// the command, so both get the same warning — never a reserved-word error,
			// a budget error, or a dialog.
			await assertRefused(session, `/goal ${NEXT}`, label);
			await assertRefused(session, "/goal --no-budget Clear the lint errors", label);

			// Bare `/goal` is unchanged: the same report as before the refusals, with
			// the Goal exactly as it was.
			const report = await inspection(session);
			assert.ok(report.includes(`— ${scenario.status}`), `${label}: the report shows the status`);
			assert.ok(report.includes(OBJECTIVE), `${label}: the report shows the objective`);
			assert.ok(
				report.includes(`Revision: ${goal.revision}`),
				`${label}: the report shows the revision the refusals left untouched`,
			);
			assert.equal(
				currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.id,
				goal.id,
				`${label}: still the same Goal`,
			);
			assert.equal(confirmRequests(session), 0, `${label}: no dialog was opened anywhere in the scenario`);

			assertStepsConsumed(session, scenario.steps, scenario.failures);
			assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		} finally {
			await session.stop();
		}
	}
});

test("the named escape hatch works: after /goal:clear the same /goal <objective> creates a fresh Goal with no dialog", async () => {
	const session = await PiRpcSession.start();
	// The refused Goal's kickoff and held continuation; then the fresh Goal's
	// kickoff and its own held continuation.
	script([{ text: "On it." }, { hang: true }, { text: "On the new one." }, { hang: true }], session);
	try {
		await createGoal(session);
		await abortActiveLoop(session, 2);
		const first = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		await assertRefused(session, `/goal ${NEXT}`, "active");

		// Abandoning the Goal is the explicit command the refusal named.
		await session.prompt("/goal:clear");
		const cleared = await session.waitForNotify((r) => r.message.includes("cleared"));
		assert.equal(cleared.notifyType, "info");

		// Nothing unfinished is left, so the same command creates — a fresh identity,
		// announced as a creation rather than a replacement, with no dialog.
		const response = await session.prompt(`/goal ${NEXT}`);
		assert.equal(response.data.disposition, "handled");
		const created = await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.doesNotMatch(created.message, /replacing/);
		const second = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.notEqual(second.id, first.id, "a fresh Goal identity");
		assert.equal(second.objective, NEXT);
		assert.equal(second.status, "active");
		assert.equal(confirmRequests(session), 0, "no dialog was opened");

		await abortActiveLoop(session, 4);
		assertStepsConsumed(session, 4, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("create_goal is unchanged: it still refuses while any Goal exists, with its own diagnostic, and changes nothing", async () => {
	const session = await PiRpcSession.start();
	try {
		await createPausedGoal(session);
		const goal = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(goal.status, "paused");
		const before = await goalBytes(session);

		// The provider's script index continues past the held kickoff, so the
		// ordinary prompt's run consumes the two steps that follow it.
		script(
			[
				{ text: "On it." },
				{ toolCalls: [{ name: "create_goal", args: { objective: NEXT, userRequest: "please create a goal" } }] },
				{ text: "Refused; reporting that." },
			],
			session,
		);
		await session.prompt("please create a goal");
		const refused = await session.waitForToolResult("create_goal", 1);
		assert.equal(refused.isError, true, "create_goal refused");
		assert.match(
			String(refused.result.content[0].text),
			/A Goal is already set for this session \(status: paused\); cannot create another one\./,
		);
		assert.equal(structuredGoal(refused.result).id, goal.id, "the refusal describes the existing Goal");
		await session.waitForSettled(2);

		assert.equal(await goalBytes(session), before, "the refused create_goal wrote no Goal bytes");
		assert.equal(currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.id, goal.id);
		assert.equal(confirmRequests(session), 0);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a complete Goal does not block: the next /goal <objective> is created with no dialog, supersedes the complete record, and survives a restart", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const session = await PiRpcSession.start({ cwd: workDir });
	// First Goal: kickoff (40), the completing turn (25), and the post-completion
	// summary (7). Second Goal: its kickoff (40) and a held, then aborted,
	// continuation (15: an aborted response is still accounted work).
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 30, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 5 } },
			{ text: "Wrapping up.", usage: { input: 5, output: 2 } },
			{ text: "Working on the new objective.", usage: { input: 30, output: 10 } },
			{ hang: true },
		],
		session,
	);
	let first;
	let second;
	let liveEntries;
	let liveSessionFile;
	try {
		await createGoal(session);
		await session.waitForSettled(1);
		first = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(first.status, "complete");
		assert.equal(
			first.usage.totalTokens,
			65,
			"kickoff plus the completing turn; the post-completion summary that follows is nobody's Goal work",
		);

		const response = await session.prompt("/goal A brand new objective");
		assert.equal(response.data.disposition, "handled");
		const replaced = await session.waitForNotify((r) => r.message.includes("created and activated, replacing"));
		assert.match(replaced.message, new RegExp(`replacing ${first.id}`));
		await abortActiveLoop(session, 3);

		liveEntries = readSessionEntries(await session.sessionFile());
		const snapshots = goalSnapshots(liveEntries);
		second = currentGoalSnapshot(liveEntries).data.goal;
		assert.notEqual(second.id, first.id, "the new Goal is a fresh identity");
		assert.equal(second.objective, "A brand new objective");
		assert.equal(second.status, "active");
		assert.equal(confirmRequests(session), 0, "no confirmation was asked for a complete Goal");

		// The complete record is superseded through the ordinary machinery: its
		// already-accounted totals are preserved as a durable snapshot immediately
		// before the new identity's own, unchanged and never rewritten afterwards.
		const oldRecords = snapshots.filter((s) => s.data.goal?.id === first.id);
		assert.deepEqual(
			oldRecords.map((s) => `${s.data.goal.status}:${s.data.goal.revision}:${s.data.goal.usage.totalTokens}`),
			["active:0:0", "complete:1:65", "complete:1:65"],
			"the creation snapshot, the completion snapshot, and the preserved record that precedes the replacement",
		);
		assert.equal(snapshots.at(-2).data.goal.id, first.id, "the preserved record directly precedes the new identity");
		assert.equal(snapshots.at(-1).data.goal.id, second.id, "the new identity's snapshot is the newest, so it is the current Goal");
		// Usage attribution: the new Goal starts at zero and inherits nothing — neither
		// the complete record's 65 nor anything after it — and is charged only its own
		// kickoff (40) and its aborted continuation (15).
		assert.equal(snapshots.at(-1).data.goal.usage.totalTokens, 0, "the creation snapshot starts at zero");
		assert.equal(await liveUsage(session), 55, "only the new Goal's own work is charged to it");

		// The audit history records the replacement from the status the complete
		// record had, and never re-records the old identity after its completion.
		assert.deepEqual(
			historyRecords(liveEntries).map((r) => `${r.kind}:${r.goalId === first.id ? "old" : "new"}:${r.from}>${r.to}`),
			["created:old:null>active", "completed:old:active>complete", "replaced:new:complete>active"],
		);
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		liveSessionFile = await session.sessionFile();
		copyFileSync(liveSessionFile, join(resumedDir, basename(liveSessionFile)));
	} finally {
		await session.stop();
	}

	// History reconstruction: a fresh process rebuilds the same branch.
	const sessionFile = join(resumedDir, basename(liveSessionFile));
	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	try {
		const restored = await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.ok(restored.message.includes(second.id), "the replacement — never the superseded record — is current");
		await resumed.prompt("/goal");
		const report = await resumed.waitForNotify((r) => r.message.includes("A brand new objective") && r.message.includes("— active"));
		assert.match(report.message, /Token usage: 55 tokens/, "the live total is rebuilt from the branch");
		await resumed.prompt("/goal:history");
		const history = await resumed.waitForNotify((r) => r.message.includes("Goal history on this branch (3 records"));
		for (const expected of ["created", "completed", "replaced", first.id, second.id]) {
			assert.ok(history.message.includes(expected), `the timeline names ${expected}`);
		}
		assert.equal(confirmRequests(resumed), 0);
		assertStepsConsumed(resumed, 0);
		assert.equal(resumed.extensionErrors().length, 0, JSON.stringify(resumed.extensionErrors()));
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});
