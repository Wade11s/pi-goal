/**
 * Issue #25 repair batch 2: cumulative budget recovery and per-episode wrap-ups.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: the command surface, extension
 * notifications, persisted session entries, exact run/continuation/wrap-up
 * counts, and the accounting totals.
 *
 * The honesty rules are the same as the earlier milestones: every script is sized
 * through the last natural turn, every test ends with `assertCleanRun` or an exact
 * `assertOnlyFailures`, and `assertStepsConsumed` fails on an exhausted script, so
 * a green result can only come from the Goal lifecycle under test.
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
	assistantOutcomes,
	continuationEntries,
	customMessageEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
const EDITED_OBJECTIVE = "Land the refined objective end to end";
const BLOCKER = "the upstream release API token has not been issued yet";
const WRAPUP_CUSTOM_TYPE = "goal-budget-wrapup";
const FIXTURES = join(import.meta.dirname, "fixtures", "legacy");

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapUpEntries(entries) {
	return customMessageEntries(entries, WRAPUP_CUSTOM_TYPE);
}

function goalStates(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

function cutovers(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-cutover");
}

/** Find a durable Goal snapshot on the branch by predicate. */
function findGoalSnapshot(entries, predicate) {
	return goalStates(entries).find((s) => predicate(s.data.goal))?.data.goal;
}

/** Fail unless exactly `steps` provider responses were consumed. */
function assertStepsConsumed(session, steps, expectedFailures = []) {
	assert.equal(
		assistantOutcomes(session).length,
		steps,
		`expected exactly ${steps} provider responses, got ${assistantOutcomes(session).length}`,
	);
	assertOnlyFailures(session, expectedFailures);
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

/** Every pi-goal resume work message on the branch, in append order. */
function resumeMessages(entries) {
	return entries.filter(
		(e) =>
			e.type === "message" &&
			e.message?.role === "user" &&
			messageText(e.message.content).startsWith("[pi-goal] The user resumed Goal"),
	);
}

/** Poll the session file until the newest Goal snapshot satisfies `predicate`. */
async function waitForSnapshot(session, predicate, description, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		if (snapshot && predicate(snapshot)) return snapshot;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await sleep(20);
	}
}

/** The live accounted total reported by bare `/goal`. */
async function liveUsage(session) {
	const seen = session.records.filter(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && /Token usage: \d+ tokens/.test(r.message),
	).length;
	await session.prompt("/goal");
	const notify = await session.waitFor("a fresh /goal report", (records) => {
		const matches = records.filter(
			(r) => r.type === "extension_ui_request" && r.method === "notify" && /Token usage: \d+ tokens/.test(r.message),
		);
		return matches.length > seen ? matches.at(-1) : undefined;
	});
	const match = /Token usage: (\d+) tokens/.exec(notify.message);
	assert.ok(match, `no usage in: ${notify.message}`);
	return Number(match[1]);
}

/** Copy one immutable legacy fixture into a fresh session dir and start Pi on it. */
async function startLegacy(fixture, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-legacy-"));
	const sessionFile = join(dir, "legacy.jsonl");
	copyFileSync(join(FIXTURES, fixture), sessionFile);
	const stored = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
	if (stored.cwd) mkdirSync(stored.cwd, { recursive: true });
	const session = await PiRpcSession.start({ ...options, sessionFile, cwd: options.cwd ?? dir });
	return { session, dir, sessionFile };
}

/**
 * The pending-wrap-up fixture: a 100-token Goal whose kickoff accounts 85 tokens
 * and whose continuation fails after accounting 30 more (115 total). The failed
 * run is a hard exit, so the Goal is durably `budget_limited` with the wrap-up
 * still owed and no wrap-up delivered.
 */
function pendingWrapUpScript() {
	return [
		{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
		{ error: "invalid api key", usage: { input: 20, output: 10 } },
	];
}

async function reachPendingWrapUp(session) {
	script(pendingWrapUpScript(), session);
	await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	const snapshot = await waitForSnapshot(
		session,
		(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.wrapUpPending === true,
		"the durable budget stop with a pending wrap-up",
	);
	assert.equal(snapshot.data.goal.usage.totalTokens, 115);
	assert.equal(wrapUpEntries(readSessionEntries(await session.sessionFile())).length, 0);
	return snapshot.data.goal;
}

test("/goal resume --budget <new-total> resumes a budget_limited Goal, cancels the pending wrap-up, and preserves identity and usage", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const before = await reachPendingWrapUp(session);
	const revisionBefore = before.revision;
	const snapshotsBefore = goalStates(readSessionEntries(await session.sessionFile())).length;
	// The resumed run starts immediately after the resume command, so the script
	// must already carry its steps.
	script(
		[
			...pendingWrapUpScript(),
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);

	await session.prompt("/goal resume --budget 200");
	const resumed = await session.waitForNotify((r) => r.message.includes("resumed (revision"));
	assert.match(resumed.message, /cumulative token ceiling is now 200 tokens/);
	assert.match(resumed.message, /115 tokens already accounted/);
	assert.match(resumed.message, /old episode's wrap-up is cancelled/);

	await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
	const entries = readSessionEntries(await session.sessionFile());
	const goal = findGoalSnapshot(entries, (g) => g?.status === "active" && g?.tokenBudget === 200);
	assert.ok(goal, "the durable budget-raising resume is on the branch");
	assert.equal(goal.id, before.id, "identity preserved");
	assert.equal(goal.objective, before.objective, "objective preserved");
	assert.equal(goal.origin, before.origin, "origin preserved");
	assert.equal(goal.createdAt, before.createdAt, "creation time preserved");
	assert.equal(goal.revision, revisionBefore + 1, "revision advances exactly once");
	assert.equal(goal.status, "active");
	assert.equal(goal.tokenBudget, 200, "the new ceiling is absolute");
	assert.equal(goal.wrapUpPending, false, "the pending old-episode wrap-up is cancelled");
	assert.equal(goal.usage.totalTokens, 115, "complete usage history is preserved");
	assert.equal(goalStates(entries).length, snapshotsBefore + 2, "one snapshot for the resume and one for the completion");

	// Commit-before-work: the resume snapshot precedes the resume work message and
	// the resumed run's first assistant message.
	const snapshotIndex = entries.findIndex(
		(e) =>
			e.type === "custom" &&
			e.customType === "goal-state" &&
			e.data?.goal?.status === "active" &&
			e.data?.goal?.tokenBudget === 200,
	);
	const resumeIndex = entries.findIndex(
		(e) =>
			e.type === "message" &&
			e.message?.role === "user" &&
			messageText(e.message.content).startsWith("[pi-goal] The user resumed Goal"),
	);
	const assistantAfterResume = entries.findIndex(
		(e, index) => index > resumeIndex && e.type === "message" && e.message?.role === "assistant",
	);
	assert.ok(snapshotIndex !== -1 && resumeIndex !== -1, "the resume snapshot and work message are on the branch");
	assert.ok(snapshotIndex < resumeIndex, "the durable transition precedes the resumed work message");
	assert.ok(resumeIndex < assistantAfterResume, "the resumed work message precedes its response");

	// The old episode's wrap-up was cancelled, so none is ever delivered.
	assert.equal(wrapUpEntries(entries).length, 0, "no wrap-up for the cancelled episode");

	// The resumed work completes the Goal through the normal contract.
	await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
	const final = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(final.tokenBudget, 200, "the new ceiling survives completion");
	assert.equal(final.usage.totalTokens, 130, "115 preserved + the completing turn's 15");

	assert.equal(runCount(session), 3, "kickoff, the failed continuation, and the resumed run");
	assert.equal(continuationEntries(readSessionEntries(await session.sessionFile())).length, 1);
	assertStepsConsumed(session, 4, [{ stopReason: "error", errorMessage: "invalid api key" }]);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);
});

test("/goal resume --budget=<new-total> is an absolute ceiling: resumed work that immediately crosses it earns exactly one fresh wrap-up", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	await reachPendingWrapUp(session);
	// The resumed run starts immediately after the resume command.
	script(
		[
			...pendingWrapUpScript(),
			{ text: "Resumed work.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
		],
		session,
	);

	// 115 accounted, new ceiling 120: only 5 tokens of headroom.
	await session.prompt("/goal resume --budget=120");
	await session.waitForNotify((r) => r.message.includes("resumed (revision"));

	// The resumed run's first response (30 tokens) immediately exhausts 120.
	await waitForSnapshot(
		session,
		(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.tokenBudget === 120,
		"the new episode's budget stop",
	);
	const entries = readSessionEntries(await session.sessionFile());
	const resumed = findGoalSnapshot(entries, (g) => g?.status === "active" && g?.tokenBudget === 120);
	assert.ok(resumed, "the durable budget-raising resume is on the branch");
	assert.equal(resumed.usage.totalTokens, 115, "usage is preserved at the resume");
	assert.equal(resumed.wrapUpPending, false, "the old episode's wrap-up is cancelled");

	const wrapUps = wrapUpEntries(entries);
	assert.equal(wrapUps.length, 1, "exactly one wrap-up: the old episode's was cancelled");
	assert.match(wrapUps[0].content, /Accounted usage: 145 tokens of the 120-token budget/);
	assert.match(wrapUps[0].content, /This is NOT completion/);

	const final = lastGoalSnapshot(entries).data.goal;
	assert.equal(final.wrapUpPending, false, "the new episode's wrap-up was delivered");
	assert.equal(final.usage.totalTokens, 145, "the durable stop snapshot carries 115 + the resumed run's 30");
	assert.equal(await liveUsage(session), 160, "the live total includes the wrap-up's 15");

	assert.equal(runCount(session), 4, "kickoff, failed continuation, resumed run, and the new wrap-up");
	assert.equal(continuationEntries(entries).length, 1, "the failed run continued once; the new stop continued nothing");
	assertStepsConsumed(session, 4, [{ stopReason: "error", errorMessage: "invalid api key" }]);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);
});

test("a budget-raising resume validates positive headroom and the configured maximum, and never clamps or uses the default", async (t) => {
	const session = await PiRpcSession.start({
		settings: { goal: { defaultTokenBudget: 5000, maxTokenBudget: 200 } },
	});
	t.after(async () => {
		await session.stop();
	});
	const before = await reachPendingWrapUp(session);
	const revisionBefore = before.revision;
	// The resumed run starts immediately after the resume command.
	script(
		[
			...pendingWrapUpScript(),
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);

	// No headroom: 115 accounted, so 115 and 100 are refused even though a 5000
	// default is configured.
	for (const requested of [115, 100]) {
		await session.prompt(`/goal resume --budget ${requested}`);
		const refused = await session.waitForNotify((r) => r.message.includes("strictly greater than"));
		assert.match(refused.message, /115 tokens/);
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(snapshot.status, "budget_limited", `${requested} leaves the Goal budget_limited`);
		assert.equal(snapshot.tokenBudget, 100, `${requested} keeps the old budget`);
		assert.equal(snapshot.wrapUpPending, true, `${requested} keeps the owed wrap-up`);
		assert.equal(snapshot.revision, revisionBefore, `${requested} writes nothing`);
	}

	// Above the configured maximum: refused, never clamped to 200.
	await session.prompt("/goal resume --budget 250");
	const aboveMax = await session.waitForNotify((r) => r.message.includes("exceeds the configured maximum of 200"));
	assert.match(aboveMax.message, /Raise goal\.maxTokenBudget/);
	let snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(snapshot.tokenBudget, 100, "the refused raise keeps the old budget");
	assert.equal(snapshot.revision, revisionBefore, "the refused raise writes nothing");

	// Exactly at the maximum is accepted, and the default (5000) is not applied.
	await session.prompt("/goal resume --budget=200");
	await session.waitForNotify((r) => r.message.includes("resumed (revision"));
	const entriesAfterResume = readSessionEntries(await session.sessionFile());
	snapshot = findGoalSnapshot(entriesAfterResume, (g) => g?.status === "active" && g?.tokenBudget === 200);
	assert.ok(snapshot, "the durable budget-raising resume is on the branch");
	assert.equal(snapshot.status, "active");
	assert.equal(snapshot.tokenBudget, 200, "the explicit total wins over the configured default");
	assert.equal(snapshot.usage.totalTokens, 115, "usage is preserved");
	assert.equal(snapshot.wrapUpPending, false);
	assert.equal(snapshot.revision, revisionBefore + 1);

	await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
	assert.equal(wrapUpEntries(readSessionEntries(await session.sessionFile())).length, 0, "no wrap-up was owed");
	assertStepsConsumed(session, 4, [{ stopReason: "error", errorMessage: "invalid api key" }]);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);
});

test("malformed budget resume arguments are refused with guidance and change nothing", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const before = await reachPendingWrapUp(session);
	const snapshotsBefore = goalStates(readSessionEntries(await session.sessionFile())).length;
	// The resumed run starts immediately after a valid resume command.
	script(
		[
			...pendingWrapUpScript(),
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);

	for (const [command, pattern] of [
		["/goal resume --budget", /needs a new total/],
		["/goal resume --budget abc", /not a number/],
		["/goal resume --budget 12.5", /whole number/],
		["/goal resume --budget 200 extra", /unexpected argument/],
		["/goal resume --budget 200 --budget 300", /unexpected argument/],
	]) {
		const mark = session.records.length;
		await session.prompt(command);
		const refused = await session.notifyAfter(mark, (r) => r.message.includes("Goal not resumed"));
		assert.match(refused.message, pattern, `${command} is refused with guidance`);
		assert.equal(
			goalStates(readSessionEntries(await session.sessionFile())).length,
			snapshotsBefore,
			`${command} writes nothing`,
		);
	}

	const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(snapshot.status, "budget_limited");
	assert.equal(snapshot.tokenBudget, 100);
	assert.equal(snapshot.wrapUpPending, true);
	assert.equal(snapshot.revision, before.revision);

	// A valid resume still works afterwards.
	await session.prompt("/goal resume --budget 200");
	await session.waitForNotify((r) => r.message.includes("resumed (revision"));
	await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
	assertStepsConsumed(session, 4, [{ stopReason: "error", errorMessage: "invalid api key" }]);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);
});

test("a bare resume of a budget_limited Goal is guidance, and the budget option is refused in every other status", async (t) => {
	// budget_limited: bare resume is refused with guidance and changes nothing.
	{
		const session = await PiRpcSession.start();
		t.after(async () => {
			await session.stop();
		});
		const before = await reachPendingWrapUp(session);
		await session.prompt("/goal resume");
		const guidance = await session.waitForNotify((r) => r.message.includes("higher cumulative total"));
		assert.match(guidance.message, /budget_limited/);
		assert.match(guidance.message, /--budget <new-total>/);
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(snapshot.status, "budget_limited");
		assert.equal(snapshot.tokenBudget, 100);
		assert.equal(snapshot.wrapUpPending, true);
		assert.equal(snapshot.revision, before.revision, "the bare resume writes nothing");
	}

	// active: the budget option is refused; the bare resume is a no-op.
	{
		const session = await PiRpcSession.start();
		t.after(async () => {
			await session.stop();
		});
		const gate = join(session.cwd, "kickoff-gate");
		script(
			[
				{ text: "Kickoff answer.", waitForFile: gate },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			session,
		);
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitFor("the kickoff run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 1 ? true : undefined,
		);
		await session.prompt("/goal resume --budget 100");
		const refused = await session.waitForNotify((r) =>
			r.message.includes("--budget option only resumes a budget_limited Goal"),
		);
		assert.match(refused.message, /\bactive\b/);
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("already active"));
		writeFileSync(gate, "release");
		await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the Goal to complete");
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0);
		assertCleanRun(session);
	}

	// paused: the budget option is refused; the bare resume still restarts work.
	{
		const session = await PiRpcSession.start();
		t.after(async () => {
			await session.stop();
		});
		const gate = join(session.cwd, "kickoff-gate");
		script(
			[
				{ text: "Kickoff answer.", waitForFile: gate },
				{ text: "Resumed answer." },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			session,
		);
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitFor("the kickoff run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 1 ? true : undefined,
		);
		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision"));
		await session.prompt("/goal resume --budget 100");
		await session.waitForNotify((r) => r.message.includes("--budget option only resumes a budget_limited Goal"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed (revision"));
		writeFileSync(gate, "release");
		await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
		assertStepsConsumed(session, 4);
		assert.equal(session.extensionErrors().length, 0);
		assertCleanRun(session);
	}

	// blocked: the budget option is refused; the bare resume still restarts work.
	{
		const session = await PiRpcSession.start();
		t.after(async () => {
			await session.stop();
		});
		script(
			[
				{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
				{ text: "Waiting." },
				{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
				{ text: "Waiting." },
				{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
				{ text: "Reporting the blocker." },
				{ text: "Resumed answer." },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			session,
		);
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForSnapshot(session, (s) => s.data.goal?.status === "blocked", "the blocked Goal");
		await session.prompt("/goal resume --budget 100");
		await session.waitForNotify((r) => r.message.includes("--budget option only resumes a budget_limited Goal"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed (revision"));
		await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
		assertStepsConsumed(session, 9);
		assert.equal(session.extensionErrors().length, 0);
		assertCleanRun(session);
	}

	// usage_limited: the budget option is refused; the bare resume still restarts work.
	{
		const session = await PiRpcSession.start();
		t.after(async () => {
			await session.stop();
		});
		script(
			[
				{ text: "Kickoff answer." },
				{ error: "insufficient_quota: current quota exhausted" },
				{ text: "Resumed answer." },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			session,
		);
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForSnapshot(session, (s) => s.data.goal?.status === "usage_limited", "the usage-limited Goal");
		await session.prompt("/goal resume --budget 100");
		await session.waitForNotify((r) => r.message.includes("--budget option only resumes a budget_limited Goal"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed (revision"));
		await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");
		assertStepsConsumed(session, 5, [{ stopReason: "error", errorMessage: "insufficient_quota" }]);
		assert.equal(session.extensionErrors().length, 0);
		assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "insufficient_quota" }]);
	}

	// complete: the budget option is refused; the bare resume is still terminal.
	{
		const session = await PiRpcSession.start();
		t.after(async () => {
			await session.stop();
		});
		script(
			[
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			session,
		);
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the completed Goal");
		await session.prompt("/goal resume --budget 100");
		await session.waitForNotify((r) => r.message.includes("--budget option only resumes a budget_limited Goal"));
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("cannot be resumed"));
		assertStepsConsumed(session, 2);
		assert.equal(session.extensionErrors().length, 0);
		assertCleanRun(session);
	}
});

test("an objective edit without a resume preserves budget_limited and the owed wrap-up uses the latest objective", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const before = await reachPendingWrapUp(session);
	const runsBefore = runCount(session);

	await session.prompt(`/goal edit ${EDITED_OBJECTIVE}`);
	const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
	assert.match(edited.message, /stays budget_limited/);
	assert.match(edited.message, /--budget <new-total>/);
	assert.equal(runCount(session), runsBefore, "an edit of a budget-limited Goal starts no work");

	const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(snapshot.status, "budget_limited", "the edit preserves budget_limited");
	assert.equal(snapshot.wrapUpPending, true, "the edit does not cancel the owed wrap-up");
	assert.equal(snapshot.objective, EDITED_OBJECTIVE);
	assert.equal(snapshot.revision, before.revision + 1, "the edit is its own revision");
	assert.equal(snapshot.usage.totalTokens, 115, "usage is preserved");

	// A completed ordinary run settles, and the owed wrap-up is requested with the
	// latest durable objective.
	script(
		[
			...pendingWrapUpScript(),
			{ text: "Ordinary answer.", usage: { input: 20, output: 2 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
			{ text: "After the wrap-up.", usage: { input: 5, output: 1 } },
		],
		session,
	);
	await session.prompt("anything else?");
	await session.waitForSettled(1);
	await waitForSnapshot(session, (s) => s.data.goal?.wrapUpPending === false, "the owed wrap-up to be delivered");
	const entries = readSessionEntries(await session.sessionFile());
	const wrapUps = wrapUpEntries(entries);
	assert.equal(wrapUps.length, 1, "exactly one wrap-up");
	assert.ok(wrapUps[0].content.includes(JSON.stringify(EDITED_OBJECTIVE)), "the wrap-up uses the latest objective");

	// A second ordinary run must not duplicate the in-flight or completed wrap-up.
	await session.prompt("anything else again?");
	await session.waitForSettled(2);
	const after = readSessionEntries(await session.sessionFile());
	assert.equal(wrapUpEntries(after).length, 1, "no duplicate wrap-up");
	const final = lastGoalSnapshot(after).data.goal;
	assert.equal(final.status, "budget_limited");
	assert.equal(final.usage.totalTokens, 115, "the durable stop snapshot carries the preserved 115");
	assert.equal(await liveUsage(session), 130, "the live total adds the wrap-up's 15; ordinary prompts are excluded");

	assertStepsConsumed(session, 5, [{ stopReason: "error", errorMessage: "invalid api key" }]);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);
});

test("an in-flight old-episode wrap-up stays charged, the gate lifts only after the durable raise, and no second old wrap-up is sent", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const gate = join(session.cwd, "wrapup-gate");
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 }, waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await waitForSnapshot(session, (s) => s.data.goal?.status === "budget_limited", "the budget stop");
	await session.waitFor("the wrap-up run started", (records) =>
		records.filter((r) => r.type === "agent_start").length >= 3 ? true : undefined,
	);
	assert.equal(wrapUpEntries(readSessionEntries(await session.sessionFile())).length, 1, "the old wrap-up is in flight");

	// Resume while the old wrap-up is still in flight. The durable raise lands
	// before the steered resume message, and the gate lifts only then.
	await session.prompt("/goal resume --budget 200");
	await session.waitForNotify((r) => r.message.includes("resumed (revision"));
	const resumed = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(resumed.status, "active");
	assert.equal(resumed.tokenBudget, 200);
	assert.equal(resumed.wrapUpPending, false);

	// Release the held wrap-up response: it is old-episode Goal work and stays charged.
	writeFileSync(gate, "release");
	await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the resumed Goal to complete");

	const entries = readSessionEntries(await session.sessionFile());
	assert.equal(wrapUpEntries(entries).length, 1, "no second old-budget wrap-up");
	const resumeIndex = entries.findIndex(
		(e) =>
			e.type === "message" &&
			e.message?.role === "user" &&
			messageText(e.message.content).startsWith("[pi-goal] The user resumed Goal"),
	);
	const wrapUpIndex = entries.findIndex((e) => e.type === "custom_message" && e.customType === WRAPUP_CUSTOM_TYPE);
	assert.ok(wrapUpIndex !== -1 && resumeIndex !== -1, "both messages are on the branch");
	assert.ok(wrapUpIndex < resumeIndex, "the in-flight wrap-up precedes the steered resume");
	const final = lastGoalSnapshot(entries).data.goal;
	assert.equal(final.usage.totalTokens, 145, "115 + the in-flight wrap-up's 15 + the completing turn's 15");

	assert.equal(runCount(session), 3, "kickoff, continuation, and the run that carries the in-flight wrap-up plus the steered resume");
	assert.equal(continuationEntries(entries).length, 1);
	assertStepsConsumed(session, 5);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertCleanRun(session);
});

test("an in-flight old wrap-up can immediately exhaust the new ceiling, and the new episode still earns its own wrap-up", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const gate = join(session.cwd, "wrapup-gate");
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 }, waitForFile: gate },
			{ text: "Resumed work.", usage: { input: 10, output: 5 } },
			{ text: "Second wrap-up summary.", usage: { input: 10, output: 5 } },
		],
		session,
	);
	await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await session.waitFor("the wrap-up run started", (records) =>
		records.filter((r) => r.type === "agent_start").length >= 3 ? true : undefined,
	);

	// 115 accounted, new ceiling 120: the in-flight wrap-up's 15 tokens cross it.
	await session.prompt("/goal resume --budget 120");
	await session.waitForNotify((r) => r.message.includes("resumed (revision"));
	writeFileSync(gate, "release");

	await waitForSnapshot(
		session,
		(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.tokenBudget === 120,
		"the new episode's budget stop",
	);
	const entries = readSessionEntries(await session.sessionFile());
	const wrapUps = wrapUpEntries(entries);
	assert.equal(wrapUps.length, 2, "the old in-flight wrap-up plus the new episode's one");
	assert.match(wrapUps[1].content, /Accounted usage: 145 tokens of the 120-token budget/);

	const final = lastGoalSnapshot(entries).data.goal;
	assert.equal(final.status, "budget_limited");
	assert.equal(final.tokenBudget, 120);
	assert.equal(
		final.usage.totalTokens,
		145,
		"the durable stop snapshot carries 115 + the old wrap-up's 15 + the resumed run's 15",
	);
	assert.equal(final.wrapUpPending, false);
	assert.equal(await liveUsage(session), 160, "the live total adds the new wrap-up's 15");

	assert.equal(runCount(session), 4, "kickoff, continuation, the run carrying the old wrap-up plus the steered resume, and the new wrap-up");
	assert.equal(continuationEntries(entries).length, 1);
	assertStepsConsumed(session, 5);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertCleanRun(session);
});

test("a completed old-episode wrap-up is not reused when the new ceiling is later exhausted", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
			{ text: "Resumed work.", usage: { input: 60, output: 40 } },
			{ text: "More resumed work.", usage: { input: 60, output: 40 } },
			{ text: "Second wrap-up summary.", usage: { input: 10, output: 5 } },
			{ text: "After the second wrap-up.", usage: { input: 5, output: 1 } },
		],
		session,
	);
	await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await waitForSnapshot(session, (s) => s.data.goal?.status === "budget_limited", "the first budget stop");
	const firstStop = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(firstStop.usage.totalTokens, 115, "the durable stop snapshot carries 115");
	assert.equal(await liveUsage(session), 130, "the live total adds the first wrap-up's 15");
	assert.equal(wrapUpEntries(readSessionEntries(await session.sessionFile())).length, 1, "one wrap-up for the first episode");

	// Resume with a higher ceiling; the completed wrap-up is not reused.
	await session.prompt("/goal resume --budget 300");
	await session.waitForNotify((r) => r.message.includes("resumed (revision"));

	// The resumed work later exhausts 300, earning exactly one fresh wrap-up.
	await waitForSnapshot(
		session,
		(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.tokenBudget === 300,
		"the second budget stop",
	);
	const entries = readSessionEntries(await session.sessionFile());
	const resumed = findGoalSnapshot(entries, (g) => g?.status === "active" && g?.tokenBudget === 300);
	assert.ok(resumed, "the durable budget-raising resume is on the branch");
	assert.equal(resumed.usage.totalTokens, 130, "usage is preserved across the resume");
	const wrapUps = wrapUpEntries(entries);
	assert.equal(wrapUps.length, 2, "exactly one wrap-up per exhaustion episode");
	assert.match(wrapUps[1].content, /Accounted usage: 330 tokens of the 300-token budget/);

	// The new stop never automatically resumes: an ordinary run settles, adds no
	// third wrap-up, and leaves the Goal budget_limited.
	await session.prompt("anything else?");
	await session.waitForSettled(1);
	const after = readSessionEntries(await session.sessionFile());
	assert.equal(wrapUpEntries(after).length, 2, "no third wrap-up");
	const final = lastGoalSnapshot(after).data.goal;
	assert.equal(final.status, "budget_limited");
	assert.equal(final.tokenBudget, 300);
	assert.equal(final.wrapUpPending, false);
	assert.equal(final.usage.totalTokens, 330, "the durable stop snapshot carries 130 + 100 + 100");
	assert.equal(await liveUsage(session), 345, "the live total adds the second wrap-up's 15");

	assert.equal(
		runCount(session),
		7,
		"kickoff, continuation, first wrap-up, resumed run, continuation, second wrap-up, ordinary run",
	);
	assert.equal(continuationEntries(after).length, 2);
	assertStepsConsumed(session, 7);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertCleanRun(session);
});

test("ordinary prompts and model tools cannot authorize a resume or a budget raise", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary.", usage: { input: 10, output: 5 } },
			{ text: "Ordinary answer.", usage: { input: 20, output: 2 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "resume" } }] },
			{ text: "After the resume attempt.", usage: { input: 20, output: 2 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "After the complete attempt.", usage: { input: 20, output: 2 } },
			{ toolCalls: [{ name: "create_goal", args: { objective: "A different objective", tokenBudget: 999 } }] },
			{ text: "After the create attempt.", usage: { input: 20, output: 2 } },
		],
		session,
	);
	await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await waitForSnapshot(session, (s) => s.data.goal?.status === "budget_limited", "the budget stop");
	const before = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	const revisionBefore = before.revision;

	// An ordinary prompt asking for a resume changes nothing.
	await session.prompt("please resume the goal with a higher budget");
	await session.waitForSettled(1);

	// The model's own tools cannot resume, complete, or replace the Goal either.
	await session.prompt("try update_goal with action resume");
	const resumeAttempt = await session.waitForToolResult("update_goal", 1);
	assert.equal(resumeAttempt.isError, true);
	assert.match(String(resumeAttempt.result.content[0].text), /supports only action complete/);

	await session.prompt("try update_goal with action complete");
	const completeAttempt = await session.waitForToolResult("update_goal", 2);
	assert.equal(completeAttempt.isError, true);
	assert.match(String(completeAttempt.result.content[0].text), /only an active Goal can be completed/);

	await session.prompt("try create_goal with a huge budget");
	const createAttempt = await session.waitForToolResult("create_goal", 1);
	assert.equal(createAttempt.isError, true);
	assert.match(String(createAttempt.result.content[0].text), /Goal is already set/);

	const entries = readSessionEntries(await session.sessionFile());
	assert.equal(resumeMessages(entries).length, 0, "no resume work message was admitted");
	const final = lastGoalSnapshot(entries).data.goal;
	assert.equal(final.status, "budget_limited", "no transition happened");
	assert.equal(final.tokenBudget, 100, "no budget raise happened");
	assert.equal(final.revision, revisionBefore, "no revision advanced");
	assert.equal(final.usage.totalTokens, 115, "the durable stop snapshot carries the preserved 115");
	assert.equal(await liveUsage(session), 130, "the live total adds the wrap-up's 15; ordinary work is excluded");

	assertStepsConsumed(session, 10);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	assertCleanRun(session);
});

test("a migrated exhausted legacy Goal recovers with positive headroom, and no resume is possible until the configured maximum rises", async (t) => {
	// Part A: a legacy exhausted Goal with a raised configured maximum recovers.
	{
		const { session, dir, sessionFile } = await startLegacy("legacy-exhausted-active.jsonl", {
			settings: { goal: { maxTokenBudget: 500 } },
		});
		script(
			[
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			session,
		);
		try {
			await session.waitForNotify((r) => r.message.includes("already at its token budget"));
			const cutovered = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
			assert.equal(cutovered.status, "budget_limited");
			assert.equal(cutovered.tokenBudget, 100, "the legacy budget is kept when it is within the maximum");
			assert.equal(cutovered.usage.totalTokens, 110, "the legacy reconstructed total is preserved");
			assert.equal(cutovers(readSessionEntries(sessionFile)).length, 1, "the branch is cut over");

			await session.prompt("/goal resume --budget 200");
			await session.waitForNotify((r) => r.message.includes("resumed (revision"));
			const resumed = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
			assert.equal(resumed.status, "active");
			assert.equal(resumed.tokenBudget, 200);
			assert.equal(resumed.usage.totalTokens, 110, "positive headroom from 110 to 200");
			assert.equal(resumed.wrapUpPending, false, "the pending legacy wrap-up is cancelled");

			await waitForSnapshot(
				session,
				(s) => s.data.goal?.status === "complete",
				"the recovered legacy Goal to complete",
			);
			assert.equal(wrapUpEntries(readSessionEntries(sessionFile)).length, 0, "no legacy wrap-up was delivered");
			assertStepsConsumed(session, 2);
			assert.equal(session.extensionErrors().length, 0);
			assertCleanRun(session);
		} finally {
			await session.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// Part B: when the configured maximum equals the usage, no positive-headroom
	// resume exists; raising the maximum in a later session unlocks it.
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-goal-legacy-"));
		const sessionFile = join(dir, "legacy.jsonl");
		copyFileSync(join(FIXTURES, "legacy-exhausted-active.jsonl"), sessionFile);
		const stored = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
		if (stored.cwd) mkdirSync(stored.cwd, { recursive: true });

		const first = await PiRpcSession.start({
			sessionFile,
			cwd: dir,
			settings: { goal: { maxTokenBudget: 110 } },
		});
		try {
			await first.waitForNotify((r) => r.message.includes("already at its token budget"));
			const migrated = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
			assert.equal(migrated.tokenBudget, 100, "the legacy budget is within the maximum, so it is not migrated");
			assert.equal(migrated.status, "budget_limited");
			assert.equal(migrated.usage.totalTokens, 110);
			const revision = migrated.revision;

			await first.prompt("/goal resume --budget 110");
			await first.waitForNotify((r) => r.message.includes("strictly greater than"));
			await first.prompt("/goal resume --budget 115");
			await first.waitForNotify((r) => r.message.includes("exceeds the configured maximum of 110"));
			const still = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
			assert.equal(still.status, "budget_limited");
			assert.equal(still.tokenBudget, 100);
			assert.equal(still.revision, revision, "the refused resumes wrote nothing");
			assertStepsConsumed(first, 0, []);
			assert.equal(first.extensionErrors().length, 0);
		} finally {
			await first.stop();
		}

		// The configured maximum rises; the already-cut-over branch resumes.
		const second = await PiRpcSession.start({
			sessionFile,
			cwd: dir,
			settings: { goal: { maxTokenBudget: 200 } },
		});
		script(
			[
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			second,
		);
		try {
			await second.waitForNotify((r) => r.message.includes("restored (budget_limited)"));
			await second.prompt("/goal resume --budget 150");
			await second.waitForNotify((r) => r.message.includes("resumed (revision"));
			const resumed = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
			assert.equal(resumed.status, "active");
			assert.equal(resumed.tokenBudget, 150);
			assert.equal(resumed.usage.totalTokens, 110);
			await waitForSnapshot(
				second,
				(s) => s.data.goal?.status === "complete",
				"the recovered legacy Goal to complete",
			);
			assert.equal(wrapUpEntries(readSessionEntries(sessionFile)).length, 0, "the pending legacy wrap-up was cancelled");
			assertStepsConsumed(second, 2);
			assert.equal(second.extensionErrors().length, 0);
			assertCleanRun(second);
		} finally {
			await second.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
