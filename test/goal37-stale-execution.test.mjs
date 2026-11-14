/**
 * Issue #37: reject stale lifecycle transitions from pre-replacement runs.
 *
 * A model `update_goal` call made in a *follow-up* provider turn of a run that
 * was admitted against an older Goal must not rebind to a Goal that appeared
 * after Clear/Replacement, because the model decided on state it never saw.
 * `turnGoal` used to be snapshotted at every `turn_start`, so a follow-up turn
 * that started after the replacement re-bound to the new identity and its
 * `complete` / `blocked` / `pause` was accepted.
 *
 * The same rule closes the null-binding case: a turn that started before any Goal
 * existed holds no binding, so a `blocked` report it prepared must not record an
 * audit on a Goal that a `/goal <objective>` created while the response was in
 * flight. And because Pi's retry of a failed request, and its retry after a
 * compaction, are the *same* execution, the binding must survive both windows:
 * a Clear/creation that lands inside one cannot become the target of the retried
 * run's transition either.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded and the scripted provider, holds the old run open at a provider gate
 * while the lifecycle commands run, and asserts the new Goal is untouched and
 * still kicks off and continues normally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assistantOutcomes,
	continuationEntries,
	customMessageEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OLD_OBJECTIVE = "Verify the original objective in this repository";
const NEW_OBJECTIVE = "Ship the replacement objective in this repository";
/** An explicit Goal-creation request, for the model-side `create_goal` boundary. */
const REQUEST = "Please create a Goal for the replacement objective";

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

/** Wait until `count` provider turns have started. */
function waitForTurns(session, count) {
	return session.waitFor(`${count} turn start(s)`, (records) =>
		records.filter((r) => r.type === "turn_start").length >= count ? true : undefined,
	);
}

/** Wait until the on-disk snapshot satisfies `predicate`. */
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

function submitCommand(session, id, message) {
	const responsePromise = session.waitFor(
		`response for ${id}`,
		(records) => records.find((r) => r.type === "response" && r.id === id),
	);
	session.writeCommand({ id, type: "prompt", message });
	return responsePromise;
}

/** Fail unless exactly `steps` provider responses were consumed. */
function assertStepsConsumed(session, steps, expectedFailures = []) {
	const outcomes = assistantOutcomes(session);
	assert.equal(outcomes.length, steps, `expected exactly ${steps} provider responses, got ${outcomes.length}`);
	assertOnlyFailures(session, expectedFailures);
}

/**
 * Read the live Goal state bare `/goal` reports.
 *
 * The status report is the user-facing contract for "status, revision, and
 * accounted usage", so parsing it pins the observable view rather than a
 * snapshot field that only a durable transition folds.
 */
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
		objective: one(/^Objective: (.*)$/m),
	};
}

/** Wait for the n-th run to start, then abort it and wait for the settlement. */
async function abortRun(session, run) {
	await session.waitFor(`${run} agent run(s) started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= run ? true : undefined,
	);
	await session.sendSimple("abort");
	await session.waitForSettled(1);
}

/** The newest *current* goal-state snapshot: the one that selects the session's Goal. */
function currentGoal(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state" && entry.data?.superseded !== true) {
			snapshot = entry;
		}
	}
	return snapshot.data.goal;
}

test("an old run's follow-up turn cannot complete a Goal created after Clear", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// The old Goal's kickoff turn runs a command and is held at the gate, so
			// the run is provably in flight while the Goal is cleared and replaced.
			{ toolCalls: [{ name: "bash", args: { command: "true" } }], waitForFile: gate },
			// The old run's follow-up turn, which starts only once the new Goal exists.
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			// The old run closes itself after the refusal.
			{ text: "The stale completion was refused." },
			// The new Goal's own kickoff run.
			{ text: "Working on the replacement objective." },
			// Its first automatic Continuation, aborted to bound the scenario.
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);

		const cleared = await session.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		const mark = session.records.length;
		const createPromise = submitCommand(session, "create-new", `/goal ${NEW_OBJECTIVE}`);
		const created = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the Goal created after the Clear",
		);

		// The old run never saw the new Goal: no get_goal, no kickoff message.
		assert.equal(toolResults(session, "get_goal").length, 0, "the old run never read Goal state");

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true, "the stale completion is refused");
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, created.id);
		assert.equal(refused.objective, NEW_OBJECTIVE);
		assert.equal(refused.status, "active", "the new Goal is not completed");
		assert.equal(refused.revision, 0, "the new Goal is not mutated");

		// The new Goal's own kickoff still runs: the refusal suppressed nothing.
		await createPromise;
		const announced = await session.notifyAfter(mark, (r) => r.message.includes("created and activated"));
		assert.ok(announced, "the new Goal was announced");
		await abortRun(session, 3);

		const entries = readSessionEntries(await session.sessionFile());
		const snapshots = goalSnapshots(entries).map((s) => (s.data.goal === null ? "tombstone" : `${s.data.goal.status}:${s.data.goal.revision}`));
		assert.deepEqual(snapshots, ["active:0", "tombstone", "active:0"], "the stale completion added no snapshot");
		assert.equal(currentGoal(entries).status, "active");
		assert.equal(currentGoal(entries).revision, 0);
		assert.equal(currentGoal(entries).objective, NEW_OBJECTIVE);
		assert.equal(
			entries.filter((e) => e.type === "custom" && e.customType === "goal-state" && e.data.goal?.status === "complete").length,
			0,
			"no Goal was completed",
		);
		// The new Goal keeps its legitimate kickoff and continuation behavior.
		const kickoff = entries.filter(
			(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(NEW_OBJECTIVE),
		);
		assert.equal(kickoff.length, 1, "the new Goal's kickoff was delivered exactly once");
		const continuations = continuationEntries(entries);
		assert.equal(continuations.length, 1, "the new Goal continued exactly once");
		assert.ok(continuations[0].content.includes(NEW_OBJECTIVE));
		assert.equal(customMessageEntries(entries, "goal-continuation").length, 1);
		assert.equal(runCount(session), 3, "the old run, the new kickoff, and one continuation");
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("an old run's follow-up turn cannot complete a Goal that replaced it while it was in flight", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ toolCalls: [{ name: "bash", args: { command: "true" } }], waitForFile: gate },
			// The old run's follow-up turn, after the replacement's steered kickoff.
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "The stale completion was refused." },
			// The replacement Goal's first automatic Continuation, aborted to bound it.
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);
		const original = await waitForStoredGoal(session, (goal) => goal.objective === OLD_OBJECTIVE);

		const replacePromise = submitCommand(session, "replace-held", `/goal ${NEW_OBJECTIVE}`);
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		const replaced = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the replacement Goal",
		);
		assert.notEqual(replaced.id, original.id, "the replacement is a new identity");

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true, "the stale completion is refused");
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, replaced.id);
		assert.equal(refused.objective, NEW_OBJECTIVE);
		assert.equal(refused.status, "active", "the replacement is not completed");
		assert.equal(refused.revision, 0, "the replacement is not mutated");

		await replacePromise;
		await abortRun(session, 2);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map(
				(s) =>
					`${s.data.goal.id === replaced.id ? "new" : "old"}:${s.data.goal.status}:${s.data.goal.revision}:${
						s.data.superseded === true ? "superseded" : "current"
					}`,
			),
			["old:active:0:current", "old:active:0:current", "new:active:0:current", "old:active:0:superseded"],
			"the replacement keeps its durable superseded record and the stale completion added nothing",
		);
		const current = currentGoal(entries);
		assert.equal(current.id, replaced.id);
		assert.equal(current.status, "active");
		assert.equal(current.revision, 0);
		const live = await reportStatus(session);
		assert.equal(live.goalId, replaced.id);
		assert.equal(live.status, "active");
		assert.equal(live.revision, 0);
		assert.equal(live.objective, NEW_OBJECTIVE);
		assert.equal(live.totalTokens, 45, "only the old run's post-kickoff turns and the continuation are charged to the replacement");
		const superseded = goalSnapshots(entries).filter((s) => s.data.goal.id !== replaced.id).at(-1);
		assert.equal(superseded.data.superseded, true);
		assert.equal(superseded.data.goal.usage.totalTokens, 15, "the old identity keeps only the turn admitted before the replacement");
		assert.equal(
			entries.filter((e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(NEW_OBJECTIVE)).length,
			1,
			"the replacement's kickoff was delivered exactly once",
		);
		assert.equal(continuationEntries(entries).length, 1, "the replacement continued exactly once");
		assert.equal(runCount(session), 2, "the old run plus one continuation");
		assertStepsConsumed(session, 4, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("an old run's follow-up turn cannot report a blocker against a Goal created after Clear", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ toolCalls: [{ name: "bash", args: { command: "true" } }], waitForFile: gate },
			// The old run's follow-up turn reports a blocker it never re-verified.
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: "The old run could not verify anything." } }] },
			{ text: "The stale blocker report was refused." },
			{ text: "Working on the replacement objective." },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);

		const cleared = await session.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		const createPromise = submitCommand(session, "create-new", `/goal ${NEW_OBJECTIVE}`);
		const created = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the Goal created after the Clear",
		);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true, "the stale blocker report is refused");
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, created.id);
		assert.equal(refused.status, "active");
		assert.equal(refused.revision, 0, "the stale report recorded no audit and bumped no revision");
		assert.ok(!refused.blockedAudit, "the stale report opened no blocked audit");
		assert.ok(!refused.blockerId, "the stale report issued no Blocker identity");

		await createPromise;
		await abortRun(session, 3);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => (s.data.goal === null ? "tombstone" : `${s.data.goal.status}:${s.data.goal.revision}`)),
			["active:0", "tombstone", "active:0"],
			"the stale blocker report added no snapshot",
		);
		const current = currentGoal(entries);
		assert.equal(current.status, "active");
		assert.equal(current.revision, 0);
		assert.ok(!current.blockedAudit, "the new Goal opened no blocked audit");
		const live = await reportStatus(session);
		assert.equal(live.goalId, created.id);
		assert.equal(live.status, "active");
		assert.equal(live.revision, 0);
		assert.equal(live.totalTokens, 30, "only the new Goal's own kickoff and continuation turns are charged to it");
		assert.equal(continuationEntries(entries).length, 1, "the new Goal continued exactly once");
		assert.equal(runCount(session), 3, "the old run, the new kickoff, and one continuation");
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("an old run's follow-up turn cannot pause a Goal created after Clear", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// A human pause request is on the branch, so the corroboration the model's
			// pause needs is satisfiable: only the execution binding may refuse it.
			{ text: "Understood." },
			{ toolCalls: [{ name: "bash", args: { command: "true" } }], waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", userRequest: "please pause the goal" } }] },
			{ text: "The stale pause was refused." },
			{ text: "Working on the replacement objective." },
			{ hang: true },
		],
		session,
	);
	try {
		const request = await session.prompt("please pause the goal");
		assert.equal(request.data.disposition, "started");
		await session.waitForSettled(1);

		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 2);

		const cleared = await session.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		const createPromise = submitCommand(session, "create-new", `/goal ${NEW_OBJECTIVE}`);
		const created = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the Goal created after the Clear",
		);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true, "the stale model pause is refused");
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, created.id);
		assert.equal(refused.status, "active", "the new Goal is not paused");
		assert.equal(refused.revision, 0, "the new Goal is not mutated");

		await createPromise;
		await abortRun(session, 4);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => (s.data.goal === null ? "tombstone" : `${s.data.goal.status}:${s.data.goal.revision}`)),
			["active:0", "tombstone", "active:0"],
			"the stale pause added no snapshot",
		);
		assert.equal(currentGoal(entries).status, "active");
		assert.equal(currentGoal(entries).revision, 0);
		const live = await reportStatus(session);
		assert.equal(live.goalId, created.id);
		assert.equal(live.status, "active", "the new Goal was never paused");
		assert.equal(live.revision, 0);
		assert.equal(live.totalTokens, 30, "only the new Goal's own kickoff and continuation turns are charged to it");
		assert.equal(continuationEntries(entries).length, 1, "the new Goal continued exactly once");
		assert.equal(runCount(session), 4, "the request run, the old kickoff, the new kickoff, and one continuation");
		assertStepsConsumed(session, 6, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a run admitted before any Goal cannot report a blocker against a Goal it never saw", async () => {
	// The null-binding asymmetry: an ordinary prompt's turn starts with no Goal, so
	// its execution holds no Goal binding. A `/goal <objective>` that lands while
	// that turn's response is still in flight must not become the target of a
	// `blocked` report the model prepared before the Goal existed. `complete` and
	// `pause` are already refused for want of a binding; `blocked` used to fall
	// through to the store and mutate the new Goal's audit and revision.
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// The ordinary turn's response is held at the gate, so the Goal is created
			// after the turn that carries this report already started.
			{
				toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: "Nothing could be verified." } }],
				waitForFile: gate,
			},
			{ text: "The blocker report was refused." },
			{ text: "Working on the new objective." },
			{ hang: true },
		],
		session,
	);
	try {
		const prompt = await session.prompt("Inspect the repository without a Goal");
		assert.equal(prompt.data.disposition, "started");
		await waitForTurns(session, 1);

		const createPromise = submitCommand(session, "create-new", `/goal ${NEW_OBJECTIVE}`);
		const created = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the Goal created during the ordinary run",
		);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.equal(stale.isError, true, "the unbound blocker report is refused");
		assert.match(String(stale.result.content[0].text), /cannot verify which Goal revision/);
		assert.ok(!/Blocker recorded/.test(String(stale.result.content[0].text)), "nothing was recorded");
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, created.id);
		assert.equal(refused.status, "active", "the new Goal keeps running");
		assert.equal(refused.revision, 0, "the unbound report bumped no revision");
		assert.ok(!refused.blockedAudit, "the unbound report opened no blocked audit");
		assert.ok(!refused.blockerId, "the unbound report issued no Blocker identity");

		await createPromise;
		await abortRun(session, 3);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => (s.data.goal === null ? "tombstone" : `${s.data.goal.status}:${s.data.goal.revision}`)),
			["active:0"],
			"the unbound blocker report added no snapshot",
		);
		const current = currentGoal(entries);
		assert.equal(current.id, created.id);
		assert.equal(current.status, "active");
		assert.equal(current.revision, 0);
		assert.ok(!current.blockedAudit, "the new Goal opened no blocked audit");
		const live = await reportStatus(session);
		assert.equal(live.goalId, created.id);
		assert.equal(live.status, "active");
		assert.equal(live.revision, 0);
		assert.equal(live.objective, NEW_OBJECTIVE);
		assert.equal(
			entries.filter(
				(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(NEW_OBJECTIVE),
			).length,
			1,
			"the new Goal's kickoff was delivered exactly once",
		);
		assert.equal(continuationEntries(entries).length, 1, "the new Goal continued exactly once");
		assert.equal(runCount(session), 3, "the ordinary run, the new kickoff, and one continuation");
		assertStepsConsumed(session, 4, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a Pi retry of a run whose Goal was cleared keeps its old binding", async () => {
	// The retry window is the *same* execution, so the binding the failed attempt was
	// admitted against must survive it. Clear plus a new Goal landing inside that
	// window therefore leaves the retried run bound to the cleared identity: its
	// completion is refused instead of completing a Goal it never saw.
	const session = await PiRpcSession.start({
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
	});
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// The old Goal's kickoff request fails, held at the gate so the Clear and the
			// new Goal land while the old execution is still in flight.
			{ error: "503 upstream overloaded", waitForFile: gate },
			// Pi's retry is the same execution and proposes a completion.
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "The stale completion was refused." },
			{ text: "Working on the new objective." },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);

		const cleared = await session.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		const createPromise = submitCommand(session, "create-new", `/goal ${NEW_OBJECTIVE}`);
		const created = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the Goal created inside the retry window",
		);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.ok(
			session.records.some((r) => r.type === "auto_retry_start"),
			"Pi retried the failed request inside one execution",
		);
		assert.equal(stale.isError, true, "the retried run's stale completion is refused");
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, created.id);
		assert.equal(refused.objective, NEW_OBJECTIVE);
		assert.equal(refused.status, "active", "the new Goal is not completed");
		assert.equal(refused.revision, 0, "the new Goal is not mutated");

		await createPromise;
		await abortRun(session, 4);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => (s.data.goal === null ? "tombstone" : `${s.data.goal.status}:${s.data.goal.revision}`)),
			["active:0", "tombstone", "active:0"],
			"the stale completion added no snapshot",
		);
		const current = currentGoal(entries);
		assert.equal(current.id, created.id);
		assert.equal(current.status, "active");
		assert.equal(current.revision, 0);
		const live = await reportStatus(session);
		assert.equal(live.goalId, created.id);
		assert.equal(live.status, "active");
		assert.equal(live.revision, 0);
		assert.equal(live.objective, NEW_OBJECTIVE);
		assert.equal(
			entries.filter(
				(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(NEW_OBJECTIVE),
			).length,
			1,
			"the new Goal's kickoff was delivered exactly once",
		);
		assert.equal(continuationEntries(entries).length, 1, "the new Goal continued exactly once");
		assert.equal(runCount(session), 4, "the failed run, its retry, the new kickoff, and one continuation");
		assertStepsConsumed(session, 5, [
			{ stopReason: "error", errorMessage: "503 upstream overloaded" },
			{ stopReason: "aborted" },
		]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a compaction retry of a run whose Goal was cleared keeps its old binding", async () => {
	// A recoverable length stop compacts and retries the response inside the same
	// execution, so that retried run keeps the binding too. A Clear plus a new Goal
	// landing inside the compaction window therefore cannot turn the retried run's
	// blocker report into an audit on a Goal it never saw.
	const session = await PiRpcSession.start({ settings: { compaction: { keepRecentTokens: 1 } } });
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// The old Goal's kickoff response is truncated, held at the gate so the Clear
			// and the new Goal land before Pi compacts and retries it.
			{ text: "Held response.", stopReason: "length", waitForFile: gate },
			{ text: "Compaction summary A." },
			// The retried run reports a blocker it decided on before the Clear.
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: "The old run could not verify anything." } }] },
			{ text: "The stale blocker report was refused." },
			{ text: "Working on the new objective." },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);

		const cleared = await session.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		const createPromise = submitCommand(session, "create-new", `/goal ${NEW_OBJECTIVE}`);
		const created = await waitForStoredGoal(
			session,
			(goal) => goal.objective === NEW_OBJECTIVE && goal.status === "active",
			"the Goal created inside the compaction window",
		);

		writeFileSync(gate, "", "utf8");
		const stale = await session.waitForToolResult("update_goal", 1);
		assert.ok(
			session.records.some((r) => r.type === "compaction_start") ||
				session.records.some((r) => r.type === "session_compact"),
			"Pi compacted the truncated response and retried it",
		);
		assert.equal(stale.isError, true, "the retried run's blocker report is refused");
		assert.match(String(stale.result.content[0].text), /prepared against/);
		const refused = structuredGoal(stale.result);
		assert.equal(refused.id, created.id);
		assert.equal(refused.status, "active");
		assert.equal(refused.revision, 0, "the stale report recorded no audit and bumped no revision");
		assert.ok(!refused.blockedAudit, "the stale report opened no blocked audit");
		assert.ok(!refused.blockerId, "the stale report issued no Blocker identity");

		await createPromise;
		await abortRun(session, 4);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => (s.data.goal === null ? "tombstone" : `${s.data.goal.status}:${s.data.goal.revision}`)),
			["active:0", "tombstone", "active:0"],
			"the stale blocker report added no snapshot",
		);
		const current = currentGoal(entries);
		assert.equal(current.id, created.id);
		assert.equal(current.status, "active");
		assert.equal(current.revision, 0);
		assert.ok(!current.blockedAudit, "the new Goal opened no blocked audit");
		const live = await reportStatus(session);
		assert.equal(live.goalId, created.id);
		assert.equal(live.status, "active");
		assert.equal(live.revision, 0);
		assert.equal(live.objective, NEW_OBJECTIVE);
		assert.equal(
			entries.filter(
				(e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(NEW_OBJECTIVE),
			).length,
			1,
			"the new Goal's kickoff was delivered exactly once",
		);
		assert.equal(continuationEntries(entries).length, 1, "the new Goal continued exactly once");
		assert.equal(runCount(session), 4, "the truncated run, its retry, the new kickoff, and one continuation");
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a model completion stays legitimate across a Pi provider retry inside one execution", async () => {
	const session = await PiRpcSession.start({
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
	});
	script(
		[
			{ error: "503 upstream overloaded" },
			// Pi's retry of the failed request is the same execution, so the binding
			// the model's completion is checked against must survive it.
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForToolResult("update_goal", 1);
		await session.waitForSettled(1);
		assert.ok(
			session.records.some((r) => r.type === "auto_retry_start"),
			"Pi retried the transient provider error into a second run",
		);
		const complete = toolResults(session, "update_goal")[0];
		assert.equal(complete.isError, false, "the retried run's completion is legitimate");
		assert.equal(structuredGoal(complete.result).status, "complete");
		assert.equal(runCount(session), 2, "the failed run plus the retried run");
		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "complete:1"],
			"the retried completion is the only transition",
		);
		assertStepsConsumed(session, 3, [{ stopReason: "error", errorMessage: "503 upstream overloaded" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a model completion stays legitimate in a Pi retry after the user revised the Goal", async () => {
	const session = await PiRpcSession.start({
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
	});
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			// The failed request is held at the gate, so the run is provably in flight
			// while the user revises the Goal it was admitted against.
			{ error: "503 upstream overloaded", waitForFile: gate },
			// Pi's retry of that run is the same execution, and the revision change was
			// steered into the running work, so its completion stays legitimate.
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OLD_OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForTurns(session, 1);

		const edited = await session.prompt(`/goal edit ${NEW_OBJECTIVE}`);
		assert.equal(edited.data.disposition, "handled");
		const revision = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(revision.message, /revision 1/);

		writeFileSync(gate, "", "utf8");
		const complete = await session.waitForToolResult("update_goal", 1);
		assert.equal(complete.isError, false, "the retried run's completion is legitimate");
		const completed = structuredGoal(complete.result);
		assert.equal(completed.objective, NEW_OBJECTIVE);
		assert.equal(completed.status, "complete");
		assert.equal(completed.revision, 2, "the revised Goal is completed, not the pre-edit one");
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "active:1", "complete:2"],
			"the edit and the retried completion are the only transitions",
		);
		assert.equal(runCount(session), 2, "the failed run plus the retried run");
		assertStepsConsumed(session, 3, [{ stopReason: "error", errorMessage: "503 upstream overloaded" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a run whose own create_goal built the Goal may still complete it", async () => {
	// The boundary of the repair: a run admitted against no Goal at all may act on a
	// Goal its own `create_goal` built, because the tool result is what showed it
	// that Goal. The creating run stays ordinary and no Continuation is started.
	const session = await PiRpcSession.start();
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ toolCalls: [{ name: "create_goal", args: { objective: NEW_OBJECTIVE, userRequest: REQUEST } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await session.prompt(REQUEST);
		const create = await session.waitForToolResult("create_goal", 1);
		assert.equal(create.isError, false, "the explicit request authorizes the creation");
		const created = structuredGoal(create.result);

		const complete = await session.waitForToolResult("update_goal", 1);
		assert.equal(complete.isError, false, "the creating run may complete the Goal it built");
		assert.equal(structuredGoal(complete.result).id, created.id);
		assert.equal(structuredGoal(complete.result).status, "complete");

		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			goalSnapshots(entries).map((s) => `${s.data.goal.status}:${s.data.goal.revision}`),
			["active:0", "complete:1"],
			"creation plus completion",
		);
		assert.equal(continuationEntries(entries).length, 0, "a complete Goal never continues");
		assert.equal(runCount(session), 1, "the prompt run is the only run");
		assertStepsConsumed(session, 4);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
