/**
 * Issue #7 acceptance tests: Goal state across session branches.
 *
 * Every test drives a real `pi --mode rpc` subprocess through real Pi session
 * operations — RPC `fork`/`clone` (which copy the selected branch into a new
 * session file), and real `ctx.navigateTree()` tree navigation invoked through
 * the test-only /nav helper extension — and asserts the public behavior of
 * pi-goal: which Goal the selected branch reconstructs, that abandoned branches
 * never leak their changes, that clear tombstones stay durable, that fork/clone
 * inherit the branch-point snapshot without touching the source session, and
 * that Goal transitions bind to the identity and revision of the selected
 * branch.
 *
 * One Pi behavior these tests deliberately pin down: restart/resume loads the
 * session's most recently appended leaf, so a *navigated* branch selection does
 * not survive a process restart (Pi core semantics). pi-goal reconstructs from
 * whatever branch Pi selects — the test asserts that consistency, not a
 * selection Pi never promised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	PiRpcSession,
	assertOnlyFailures,
	continuationEntries,
	lastGoalSnapshot,
	readSessionEntries,
} from "./helpers/rpc-harness.mjs";
import { structuredGoal } from "./helpers/blocked-audit.mjs";

const TREE_NAV = fileURLToPath(new URL("./extensions/tree-nav.ts", import.meta.url));

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/**
 * Stop an active Goal's continuation loop deliberately (Pi's documented hard exit).
 *
 * Waits for the run that is in flight to settle after the abort, so the next
 * command is never queued behind a run that has not finished dying: without
 * that wait a prompt could start the next run (and consume a scripted-provider
 * step) before the abort landed.
 */
async function abortActiveLoop(session, runs) {
	const settledBefore = session.records.filter((r) => r.type === "agent_settled").length;
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	const target = settledBefore + 1;
	return session.waitFor(`${target} agent_settled events`, (records) => {
		const settled = records.filter((r) => r.type === "agent_settled");
		return settled.length >= target ? settled[target - 1] : undefined;
	});
}

/** goal-state entries of a session file, in append order. */
function goalStateEntries(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/** Navigate the tree to an entry id and wait until Pi reports the navigation done. */
async function navigateTo(session, entryId) {
	const mark = session.records.length;
	await session.prompt(`/nav ${entryId}`);
	await session.notifyAfter(mark, (r) => r.message.includes(`navigated to ${entryId}`));
}

/** Bare /goal status on the currently selected branch. */
async function goalStatus(session) {
	const mark = session.records.length;
	await session.prompt("/goal");
	const notify = await session.notifyAfter(mark, () => true);
	return notify.message;
}

/** Every user message entry available for RPC forking. */
async function forkableMessages(session) {
	const { messages } = await session.sendSimple("get_fork_messages");
	return messages;
}

/** Real delay, so an idle active Goal crosses the accounting checkpoint interval. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Longer than `ACCOUNTING_CHECKPOINT_MS`, so an idle active Goal has more
 * unpersisted active time than one checkpoint interval when the replacement runs.
 * The wait itself must not write anything: checkpoints are event-driven, and an
 * idle session has no boundary to fire one.
 */
const IDLE_PAST_CHECKPOINT_MS = 1300;

/** Every `goal-usage` accounting checkpoint in a session file, in append order. */
function usageCheckpoints(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-usage");
}

test("tree navigation reconstructs the selected branch: an older snapshot, a tombstone, and a different Goal", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// warm-up, Goal 1 kickoff/continuation/hold, Goal 2 kickoff/continuation/hold,
	// then a get_goal run, its text turn, and a hold for the final continuation.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff one" },
			{ text: "continuing one" },
			{ hang: true },
			{ text: "kickoff two" },
			{ text: "continuing two" },
			{ hang: true },
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ text: "beta state read" },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal First objective ALPHA");
		await abortActiveLoop(session, 4);
		const goalOne = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;

		// Clear Goal 1, then create Goal 2 on the same linear branch: the branch now
		// holds [G1 create, tombstone, G2 create, ...].
		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		await session.prompt("/goal Second objective BETA");
		await abortActiveLoop(session, 7);
		const goalTwo = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.notEqual(goalOne.id, goalTwo.id);

		const { entries } = await session.getEntries();
		const states = goalStateEntries(entries);
		assert.equal(states.length, 3, "create, tombstone, create");
		const [g1Create, tombstone, g2Create] = states;

		// Navigating to the *older snapshot* of Goal 1 reconstructs Goal 1 at that
		// revision; the tombstone and Goal 2 are not on that branch and do not
		// apply. Leaving Goal 2's branch for Goal 1's is an observable change.
		const markOne = session.records.length;
		await navigateTo(session, g1Create.id);
		await session.notifyAfter(markOne, (r) =>
			r.message.includes("Goal changed with the selected branch") && r.message.includes("a different Goal identity"),
		);
		let status = await goalStatus(session);
		assert.match(status, /First objective ALPHA/);
		assert.match(status, /Revision: 0/);

		// Navigating to the tombstone reconstructs "no Goal": on this branch the
		// durable tombstone beats the older Goal 1 snapshot ahead of it.
		const markTomb = session.records.length;
		await navigateTo(session, tombstone.id);
		await session.notifyAfter(markTomb, (r) => r.message.includes("No Goal on the selected branch"));
		status = await goalStatus(session);
		assert.match(status, /No Goal is set/);

		// Navigating to Goal 2's snapshot reconstructs the other Goal identity.
		const markTwo = session.records.length;
		await navigateTo(session, g2Create.id);
		await session.notifyAfter(markTwo, (r) => r.message.includes("restored from the selected branch (active)"));
		status = await goalStatus(session);
		assert.match(status, /Second objective BETA/);
		assert.match(status, new RegExp(goalTwo.id));

		// The model sees the same branch-correct state through get_goal.
		await session.prompt("check the current objective");
		const toolEnd = await session.waitForToolResult("get_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.id, goalTwo.id);
		assert.equal(state.objective, "Second objective BETA");
		assert.equal(state.status, "active");
		// The inherited-on-this-branch active Goal continues at settlement. The
		// get_goal run (tool call plus its closing text turn) is run 8; the
		// continuation it triggers is run 9, so aborting at 9 keeps that
		// continuation entry.
		await abortActiveLoop(session, 9);
		assert.ok(
			continuationEntries(readSessionEntries(await session.sessionFile())).some((e) =>
				e.content.includes(goalTwo.id),
			),
			"continuation on the selected branch names that branch's Goal",
		);

		// Navigation changed nothing on disk: every snapshot is still there,
		// append-only, including Goal 1's and the tombstone.
		const finalStates = goalStateEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(finalStates[0].data.goal.id, goalOne.id);
		assert.equal(finalStates[1].data.goal, null);
		assert.equal(finalStates[2].data.goal.id, goalTwo.id);
		// Three holds were stopped deliberately: Goal 1's, Goal 2's, and the
		// final continuation on the selected branch.
		assertOnlyFailures(session, [
			{ stopReason: "aborted" },
			{ stopReason: "aborted" },
			{ stopReason: "aborted" },
		]);
	} finally {
		await session.stop();
	}
});

test("abandoned-branch Goal changes never leak into the selected branch", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// warm-up, Goal kickoff/continuation/hold, then after the edit the edit run,
	// its continuation and a hold; the post-navigation completion run needs one
	// tool-call turn and one closing text turn.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff" },
			{ text: "continuing" },
			{ hang: true },
			{ text: "edited kickoff" },
			{ text: "edited continuing" },
			{ hang: true },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done with the original objective." },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal Original objective ONE");
		await abortActiveLoop(session, 4);

		// Edit on the current branch: revision 1, new objective.
		await session.prompt("/goal edit Edited objective TWO");
		await session.waitForNotify((r) => r.message.includes("objective updated"));
		await abortActiveLoop(session, 7);

		const { entries } = await session.getEntries();
		const states = goalStateEntries(entries);
		assert.equal(states.length, 2);
		const [rev0] = states;

		// Navigate back to the pre-edit snapshot: the abandoned edit must not leak.
		const mark = session.records.length;
		await navigateTo(session, rev0.id);
		await session.notifyAfter(mark, (r) => r.message.includes("Goal changed with the selected branch"));
		const status = await goalStatus(session);
		assert.match(status, /Original objective ONE/);
		assert.match(status, /Revision: 0/);

		// A completion prepared and executed on the selected branch completes that
		// branch's Goal (identity and revision both match the branch), and it is a
		// clean exit: no continuation follows a complete Goal.
		await session.prompt("finish the original objective");
		const toolEnd = await session.waitForToolResult("update_goal", 1);
		const completed = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(completed.status, "complete");
		assert.equal(completed.objective, "Original objective ONE");
		assert.equal(completed.revision, 1);
		// The completion run (tool call plus its closing text turn) settles the
		// session: the only earlier idle settles are the warm-up and the two
		// aborted holds.
		await session.waitForSettled(4);

		// The abandoned branch keeps its own state: its edited snapshot is still
		// active at revision 1, and selecting it again restores it.
		const finalStates = goalStateEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(finalStates.length, 3, "rev0, abandoned edit rev1, new complete rev1");
		assert.equal(finalStates[1].data.goal.status, "active");
		assert.equal(finalStates[1].data.goal.objective, "Edited objective TWO");
		const markTwo = session.records.length;
		await navigateTo(session, finalStates[1].id);
		await session.notifyAfter(markTwo, (r) => r.message.includes("active at revision 1"));
		const abandonedStatus = await goalStatus(session);
		assert.match(abandonedStatus, /Edited objective TWO/);
		assert.match(abandonedStatus, /active/);
		assertOnlyFailures(session, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("clone inherits the branch-point Goal without mutating the source session", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// Source: warm-up, kickoff, continuation, hold.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff" },
			{ text: "continuing" },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal Clone inherited objective");
		await abortActiveLoop(session, 4);
		const sourceFile = await session.sessionFile();
		const sourceBefore = readFileSync(sourceFile, "utf8");
		const sourceGoal = lastGoalSnapshot(readSessionEntries(sourceFile)).data.goal;

		// Clone duplicates the active branch into a new session at the leaf.
		const clone = await session.sendSimple("clone");
		assert.deepEqual(clone, { cancelled: false });
		const clonedFile = (await session.getState()).sessionFile;
		assert.notEqual(clonedFile, sourceFile);

		// The clone's runtime restored the Goal from its copied branch.
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const cloneEntries = readSessionEntries(clonedFile);
		const cloneGoal = lastGoalSnapshot(cloneEntries).data.goal;
		assert.equal(cloneGoal.id, sourceGoal.id);
		assert.equal(cloneGoal.objective, sourceGoal.objective);
		assert.equal(cloneGoal.revision, sourceGoal.revision);
		assert.equal(cloneGoal.status, "active");
		assert.equal(
			goalStateEntries(cloneEntries).length,
			goalStateEntries(readSessionEntries(sourceFile)).length,
			"the whole active branch was copied",
		);

		// The clone's runtime re-initializes the scripted provider, so its step
		// counter restarts. Rewrite the script for the post-clone phase: the
		// model reads the inherited Goal, closes the turn, and the active Goal
		// continues into a hold that the test aborts.
		script(
			[
				{ toolCalls: [{ name: "get_goal", args: {} }] },
				{ text: "clone working" },
				{ hang: true },
			],
			session,
		);
		// The inherited Goal is live state, not just a copied file: a prompt makes
		// the model read it and the settlement boundary continue it.
		await session.prompt("continue the objective");
		const toolEnd = await session.waitForToolResult("get_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.id, sourceGoal.id);
		// Clone runs: the get_goal run (tool call plus closing text) is run 5; the
		// continuation hold is run 6.
		await abortActiveLoop(session, 6);
		assert.ok(
			continuationEntries(readSessionEntries(clonedFile)).some((e) => e.content.includes(sourceGoal.id)),
			"inherited Goal continues in the clone",
		);

		// The source session was never mutated: not by the clone, and not by the
		// clone's own continuation afterwards.
		assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore);
		assertOnlyFailures(session, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("fork from before the kickoff inherits the Goal but not the run, and leaves the source untouched", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// Source: warm-up, kickoff, continuation, hold.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff" },
			{ text: "continuing" },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal Fork inherited objective");
		await abortActiveLoop(session, 4);
		const sourceFile = await session.sessionFile();
		const sourceBefore = readFileSync(sourceFile, "utf8");
		const sourceGoal = lastGoalSnapshot(readSessionEntries(sourceFile)).data.goal;

		// RPC fork uses position "before": the branch point is the parent of the
		// selected user message, so forking before the kickoff keeps the snapshot
		// (appended just before the kickoff message) but drops the kickoff itself.
		const messages = await forkableMessages(session);
		const kickoff = messages.find((m) => m.text.startsWith("[pi-goal]"));
		assert.ok(kickoff, "kickoff user message is forkable");
		const fork = await sendFork(session, kickoff.entryId);
		assert.equal(fork.success, true);
		assert.equal(fork.data.cancelled, false);

		const forkedFile = (await session.getState()).sessionFile;
		assert.notEqual(forkedFile, sourceFile);
		await session.waitForNotify((r) => r.message.includes("restored (active)"));

		// The fork inherited the snapshot at its branch point...
		const forkEntries = readSessionEntries(forkedFile);
		const forkStates = goalStateEntries(forkEntries);
		assert.equal(forkStates.length, 1);
		assert.equal(forkStates[0].data.goal.id, sourceGoal.id);
		assert.equal(forkStates[0].data.goal.objective, sourceGoal.objective);
		// ...but not the kickoff run or any continuation of the source branch.
		assert.ok(
			!forkEntries.some((e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("Fork inherited objective")),
			"kickoff message was not copied to the fork",
		);
		assert.equal(continuationEntries(forkEntries).length, 0);

		// The fork's runtime re-initializes the scripted provider, so its step
		// counter restarts. Rewrite the script for the post-fork phase: the model
		// reads the inherited Goal, closes the turn, and the active Goal continues
		// into a hold that the test aborts.
		script(
			[
				{ toolCalls: [{ name: "get_goal", args: {} }] },
				{ text: "fork working" },
				{ hang: true },
			],
			session,
		);
		// The inherited Goal stays in charge of the fork's next run and continues
		// at its own settlement boundary.
		await session.prompt("keep working on the objective");
		const toolEnd = await session.waitForToolResult("get_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.id, sourceGoal.id);
		assert.equal(state.status, "active");
		// Fork runs: the get_goal run (tool call plus closing text) is run 5; the
		// continuation hold is run 6.
		await abortActiveLoop(session, 6);
		assert.ok(
			continuationEntries(readSessionEntries(forkedFile)).some((e) => e.content.includes(sourceGoal.id)),
			"inherited Goal continues in the fork",
		);

		assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore);
		assertOnlyFailures(session, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

/** RPC fork command (not in the harness's typed helpers). */
async function sendFork(session, entryId) {
	const id = `fork-${entryId}`;
	const responsePromise = session.waitFor("fork response", (records) =>
		records.find((r) => r.type === "response" && r.id === id),
	);
	session.writeCommand({ id, type: "fork", entryId });
	return responsePromise;
}

test("a clone after an idle active Goal leaves the source bytes untouched", async () => {
	// A clone copies the branch *before* `session_shutdown` reaches the extension, so
	// anything the shutdown handler appends lands only on the source: the clone never
	// sees it, and the source has been mutated by an operation performed on a copy.
	// That is invisible while the clone happens quickly, because the shutdown handler
	// only writes when at least one checkpoint interval of active time is unpersisted
	// — which an idle active Goal crosses with no model work at all.
	const session = await PiRpcSession.start();
	script([{ text: "kickoff" }, { text: "continuing" }, { hang: true }], session);
	try {
		await session.prompt("/goal Idle clone probe objective");
		await abortActiveLoop(session, 2);
		const sourceFile = await session.sessionFile();
		const sourceBefore = readFileSync(sourceFile, "utf8");
		const sourceGoal = lastGoalSnapshot(readSessionEntries(sourceFile)).data.goal;
		assert.equal(sourceGoal.status, "active");
		assert.equal(usageCheckpoints(readSessionEntries(sourceFile)).length, 0, "no checkpoint yet");

		// Idle with the Goal active: the clock runs, but nothing is written, because
		// checkpoints are event-driven and an idle session has no boundary to fire one.
		await sleep(IDLE_PAST_CHECKPOINT_MS);
		assert.equal(
			readFileSync(sourceFile, "utf8"),
			sourceBefore,
			"the idle wait alone must not write anything",
		);

		// Now the replacement runs, with more than one checkpoint interval unpersisted.
		const clone = await session.sendSimple("clone");
		assert.deepEqual(clone, { cancelled: false });
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const clonedFile = (await session.getState()).sessionFile;
		assert.notEqual(clonedFile, sourceFile);

		assert.equal(
			readFileSync(sourceFile, "utf8"),
			sourceBefore,
			"the clone must not append anything to the source session",
		);
		assert.equal(
			usageCheckpoints(readSessionEntries(clonedFile)).length,
			0,
			"and the clone carries no checkpoint the source never had",
		);
		assert.equal(lastGoalSnapshot(readSessionEntries(clonedFile)).data.goal.id, sourceGoal.id);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("a fork after an idle active Goal leaves the source bytes untouched", async () => {
	// Same hazard through the RPC `fork` path, which is the same code as `clone` with
	// a different position. The fork copies the selected branch before the extension
	// hears about the shutdown, so a checkpoint written there would only ever reach
	// the source.
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	script([{ text: "kickoff" }, { text: "continuing" }, { hang: true }], session);
	try {
		await session.prompt("/goal Idle fork probe objective");
		await abortActiveLoop(session, 2);
		const sourceFile = await session.sessionFile();
		const sourceBefore = readFileSync(sourceFile, "utf8");
		const sourceGoal = lastGoalSnapshot(readSessionEntries(sourceFile)).data.goal;
		assert.equal(sourceGoal.status, "active");
		assert.equal(usageCheckpoints(readSessionEntries(sourceFile)).length, 0, "no checkpoint yet");

		await sleep(IDLE_PAST_CHECKPOINT_MS);
		assert.equal(
			readFileSync(sourceFile, "utf8"),
			sourceBefore,
			"the idle wait alone must not write anything",
		);

		const messages = await forkableMessages(session);
		const kickoff = messages.find((m) => m.text.startsWith("[pi-goal]"));
		assert.ok(kickoff, "the kickoff user message is forkable");
		const fork = await sendFork(session, kickoff.entryId);
		assert.equal(fork.success, true);
		assert.equal(fork.data.cancelled, false);
		// The fork's runtime binds and restores the inherited Goal, which is what makes
		// the fork usable at all.
		await session.waitForNotify((r) => r.message.includes("restored (active)"));
		const forkedFile = (await session.getState()).sessionFile;
		assert.notEqual(forkedFile, sourceFile);

		// The source is untouched, which is the whole point: the fork copied the branch
		// before this extension heard about the shutdown, so anything written there
		// would only ever have reached the source.
		assert.equal(
			readFileSync(sourceFile, "utf8"),
			sourceBefore,
			"the fork must not append anything to the source session",
		);

		// The inherited Goal is live state in the fork, not just a copied file: the
		// fork's session file is created lazily, so drive one run to make it exist and
		// to read the Goal back through the model-facing tool.
		script([{ toolCalls: [{ name: "get_goal", args: {} }] }, { text: "fork working" }], session);
		await session.prompt("continue the objective");
		const toolEnd = await session.waitForToolResult("get_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.id, sourceGoal.id, "the fork inherited the Goal");
		assert.equal(
			lastGoalSnapshot(readSessionEntries(forkedFile)).data.goal.id,
			sourceGoal.id,
			"and the fork's branch carries the same snapshot",
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("fork from before the Goal inherits no Goal, and that branch's slot is free", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// Source: warm-up, kickoff, continuation, hold.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff" },
			{ text: "continuing" },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal Not inherited by the early fork");
		await abortActiveLoop(session, 4);
		const sourceFile = await session.sessionFile();
		const sourceBefore = readFileSync(sourceFile, "utf8");
		const sourceGoal = lastGoalSnapshot(readSessionEntries(sourceFile)).data.goal;

		// Fork before the warm-up message: the copied branch predates every
		// goal-state entry, so the fork starts with no Goal at all. The fork's
		// session file is not created until its first message is appended, so the
		// no-Goal claim is read over RPC rather than from the file.
		const messages = await forkableMessages(session);
		const warmUp = messages.find((m) => m.text === "warm up");
		assert.ok(warmUp, "warm-up message is forkable");
		const fork = await sendFork(session, warmUp.entryId);
		assert.equal(fork.success, true);
		assert.equal(fork.data.cancelled, false);
		const forkedFile = (await session.getState()).sessionFile;
		assert.notEqual(forkedFile, sourceFile);
		const forkedEntries = (await session.getEntries()).entries;
		assert.equal(goalStateEntries(forkedEntries).length, 0);

		const status = await goalStatus(session);
		assert.match(status, /No Goal is set/);

		// The fork's runtime re-initializes the scripted provider, so its step
		// counter restarts. Rewrite the script for the post-fork phase: the model
		// creates a fresh Goal, closes the turn, and the new Goal continues into a
		// hold that the test aborts.
		script(
			[
				{ toolCalls: [{ name: "create_goal", args: { objective: "Fresh goal created in the fork" } }] },
				{ text: "created in fork" },
				{ hang: true },
			],
			session,
		);
		// The single-Goal slot is decided per selected branch: the abandoned
		// branch's Goal does not occupy the fork's slot, so the model can create
		// one here for an explicit request.
		await session.prompt("please create a goal: Fresh goal created in the fork");
		const toolEnd = await session.waitForToolResult("create_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.notEqual(state.id, sourceGoal.id);
		assert.equal(state.status, "active");
		// The new Goal is durable on the fork's branch and continues at settlement.
		// Fork runs: the create_goal run (tool call plus closing text) is run 5; the
		// continuation hold is run 6.
		await abortActiveLoop(session, 6);
		const forkStates = goalStateEntries(readSessionEntries(forkedFile));
		assert.equal(forkStates.length, 1);
		assert.equal(forkStates[0].data.goal.id, state.id);

		// The source session and its Goal were not touched.
		assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore);
		assertOnlyFailures(session, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("cloning after a clear inherits the durable tombstone, not the cleared Goal", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// Source: warm-up, kickoff, continuation, hold; the clone creates a fresh
	// Goal: kickoff, continuation, hold.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff" },
			{ text: "continuing" },
			{ hang: true },
			{ text: "fresh kickoff" },
			{ text: "fresh continuing" },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal Cleared before cloning");
		await abortActiveLoop(session, 4);
		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		const sourceFile = await session.sessionFile();
		const sourceBefore = readFileSync(sourceFile, "utf8");

		const absenceMark = session.records.length;
		const clone = await session.sendSimple("clone");
		assert.equal(clone.cancelled, false);
		const clonedFile = (await session.getState()).sessionFile;

		// The tombstone was copied with the branch, so the clone restores no Goal:
		// the older snapshot ahead of the tombstone cannot resurrect it.
		const cloneStates = goalStateEntries(readSessionEntries(clonedFile));
		assert.equal(cloneStates.length, 2, "create snapshot and tombstone were both copied");
		assert.equal(cloneStates[1].data.goal, null);
		const status = await goalStatus(session);
		assert.match(status, /No Goal is set/);
		assert.ok(
			!session.records.slice(absenceMark).some((r) => r.type === "extension_ui_request" && r.method === "notify" && r.message.includes("restored")),
			"no Goal was restored in the clone",
		);

		// The inherited tombstone blocks resurrection, not new work: creating a
		// fresh Goal on the clone's branch succeeds and persists after it.
		await session.prompt("/goal Fresh objective after the inherited tombstone");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 7);
		const finalStates = goalStateEntries(readSessionEntries(clonedFile));
		assert.equal(finalStates.length, 3);
		assert.equal(finalStates[2].data.goal.objective, "Fresh objective after the inherited tombstone");
		assert.equal(finalStates[2].data.goal.status, "active");

		assert.equal(readFileSync(sourceFile, "utf8"), sourceBefore);
		assertOnlyFailures(session, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("restart after tree navigation resumes Pi's selected branch and reconstructs from it", async () => {
	// Pi resumes a session at its most recently appended leaf, so a navigated
	// branch selection does not survive a restart; pi-goal must reconstruct from
	// whatever branch Pi selected, which here is the abandoned (edited) branch.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-nav-work-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-nav-res-"));
	const first = await PiRpcSession.start({ cwd: workDir, extraExtensions: [TREE_NAV] });
	// warm-up, kickoff, continuation, hold, then the edit run, its continuation,
	// and a hold; the resumed process runs nothing.
	script(
		[
			{ text: "warm" },
			{ text: "kickoff" },
			{ text: "continuing" },
			{ hang: true },
			{ text: "edited kickoff" },
			{ text: "edited continuing" },
			{ hang: true },
		],
		first,
	);
	let sessionFile;
	try {
		await first.prompt("warm up");
		await first.waitForSettled(1);
		await first.prompt("/goal Original restart objective");
		await abortActiveLoop(first, 4);
		await first.prompt("/goal edit Edited restart objective");
		await first.waitForNotify((r) => r.message.includes("objective updated"));
		await abortActiveLoop(first, 7);

		// Select the pre-edit branch live: the state follows the selection.
		const { entries } = await first.getEntries();
		const rev0 = goalStateEntries(entries)[0];
		await navigateTo(first, rev0.id);
		const liveStatus = await goalStatus(first);
		assert.match(liveStatus, /Original restart objective/);
		assert.match(liveStatus, /Revision: 0/);

		sessionFile = await first.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		assertOnlyFailures(first, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	// Restart: Pi loads its most recently appended leaf (the edited branch), and
	// the Goal is reconstructed from that selected branch.
	const second = await PiRpcSession.start({ sessionFile, cwd: workDir, extraExtensions: [TREE_NAV] });
	script([{ text: "no run expected" }], second);
	try {
		const restored = await second.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.match(restored.message, /goal_[0-9a-f]+/);
		const status = await goalStatus(second);
		assert.match(status, /Edited restart objective/);
		assert.match(status, /Revision: 1/);

		// A runtime replacement (reload / session switch) re-selects the same
		// branch and reconstructs the same state.
		const id = "reload-1";
		const switchPromise = second.waitFor("switch_session response", (records) =>
			records.find((r) => r.type === "response" && r.id === id),
		);
		second.writeCommand({ id, type: "switch_session", sessionPath: sessionFile });
		const switched = await switchPromise;
		assert.equal(switched.success, true);
		const mark = second.records.length;
		await second.waitForNotify((r) => r.message.includes("restored (active)"));
		const reloaded = await goalStatus(second);
		assert.match(reloaded, /Edited restart objective/);
		assert.ok(second.extensionErrors().length === 0);
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a blocked Goal reconstructed from a branch keeps its audit, and /goal resume clears it", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	// Kickoff, three blocker reports that block the Goal, a get_goal read of the
	// reconstructed branch, then the resumed work: its kickoff, one continuation,
	// and the completion.
	const BLOCKER = "the upstream release API token has not been issued yet";
	// The first report omits blocker_id and the extension issues the identity the
	// later turns pass back, so this is the same three-consecutive-turn audit.
	const gate = join(session.cwd, "pi-goal-audit-gate");
	const chained = (id) => [
		{ text: "Kickoff answer." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
		{ text: "Waiting.", waitForFile: gate },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Waiting." },
		{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER, blocker_id: id } }] },
		{ text: "Reporting the blocker." },
		{ toolCalls: [{ name: "get_goal", args: {} }] },
		{ text: "The Goal is blocked." },
		{ text: "Resumed work after the blocker was resolved." },
		{ text: "Still working." },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
		{ text: "Wrapping up." },
	];
	writeFileSync(session.scriptPath, JSON.stringify(chained("@issued")), "utf8");
	try {
		await session.prompt(`/goal Make the full test suite pass in this repository`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const issued = structuredGoal((await session.waitForToolResult("update_goal", 1)).result).blockerId;
		writeFileSync(session.scriptPath, JSON.stringify(chained(issued)), "utf8");
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		// Every snapshot of the chain is a branch point, so each is navigable.
		const states = goalStateEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(states.length, 4, "create plus the three blocker reports");
		assert.deepEqual(
			states.map((s) => `${s.data.goal.status}:${s.data.goal.revision}:${s.data.goal.blockedAudit?.turns}`),
			["active:0:undefined", "active:1:1", "active:2:2", "blocked:3:3"],
		);

		// The branch-isolation notices carry the reconstructed status and revision,
		// so the audit-bearing snapshots are observably reconstructed. The chain tip
		// is already selected, so the first navigation has to move away from it.
		const markOne = session.records.length;
		await navigateTo(session, states[1].id);
		await session.notifyAfter(markOne, (r) =>
			r.message.includes("Goal changed with the selected branch") && r.message.includes("active at revision 1"),
		);
		const markTwo = session.records.length;
		await navigateTo(session, states[2].id);
		await session.notifyAfter(markTwo, (r) => r.message.includes("active at revision 2"));
		const markBlocked = session.records.length;
		await navigateTo(session, states[3].id);
		await session.notifyAfter(markBlocked, (r) => r.message.includes("blocked at revision 3"));

		// The reconstructed Goal is read through the model tool, which reports the
		// audit as the public state. A blocked Goal is the one status a user prompt
		// cannot reset (the audit reset only applies to an active Goal), so this
		// reads the reconstruction itself rather than a reset of it.
		await session.prompt("what is the current goal?");
		const read = await session.waitForToolResult("get_goal");
		const state = read.result.structuredContent?.goal ?? read.result.details?.goal;
		assert.equal(state.status, "blocked", "the selected branch reconstructs the blocked Goal");
		assert.equal(state.blockedTurns, 3, "the blocked audit survived branch reconstruction");
		assert.equal(state.blocker, BLOCKER);

		await session.prompt("/goal resume");
		const resumed = await session.waitForNotify((r) => r.message.includes("resumed"));
		assert.match(resumed.message, /fresh audit/);
		assert.match(resumed.message, /revision 4/);

		await session.waitFor("the resumed Goal completes", async () => {
			const entries = readSessionEntries(await session.sessionFile());
			return lastGoalSnapshot(entries).data.goal.status === "complete" ? true : undefined;
		});
		await session.waitForSettled(2);

		const snapshots = goalStateEntries(readSessionEntries(await session.sessionFile())).map((s) => s.data.goal);
		assert.deepEqual(
			snapshots.map((g) => `${g.status}:${g.revision}:${g.blockedAudit?.turns ?? "-"}`),
			["active:0:-", "active:1:1", "active:2:2", "blocked:3:3", "active:4:-", "complete:5:-"],
			"navigation appends nothing, the resume clears the audit, and the loop finishes",
		);
		assert.ok(snapshots.every((g) => g.id === states[3].data.goal.id), "one Goal identity throughout");
		// Three while the audit was accumulating, two more after the resume: the
		// blocked runs themselves and the completing one continue nothing.
		assert.equal(continuationEntries(readSessionEntries(await session.sessionFile())).length, 5);
		assert.ok(session.extensionErrors().length === 0);
	} finally {
		await session.stop();
	}
});
