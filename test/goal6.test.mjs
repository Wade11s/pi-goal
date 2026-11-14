/**
 * Issue #6 acceptance tests: enforce token and active-time budgets.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: RPC events, extension
 * notifications, tool results, model context, and persisted session entries.
 *
 * The same two honesty rules as the earlier milestones apply: every script is
 * sized through the last natural post-tool turn, and every test ends with an
 * explicit outcome assertion, so a green result can only come from the Goal
 * lifecycle and never from a scripted-provider error.
 *
 * Determinism notes:
 * - Token totals are exact, because the scripted provider reports the usage of
 *   every step. Nothing here depends on wall-clock timing.
 * - Active time is asserted with bounds (at least the time the test provably held
 *   the session open, and strictly less than that plus the process downtime), so a
 *   slow machine cannot make it pass for the wrong reason.
 * - Restart tests stop the first process *before* copying its session file, because
 *   the durable accounting checkpoint is written at shutdown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assistantOutcomes,
	continuationEntries,
	customMessageEntries,
	failedAssistantOutcomes,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
/** Keep in sync with the customTypes registered by the extension. */
const WRAPUP_CUSTOM_TYPE = "goal-budget-wrapup";
const USAGE_ENTRY_TYPE = "goal-usage";
/** Test-only extension that performs nested model work through ctx.executeTool(). */
const NESTED_EXTENSION = join(import.meta.dirname, "extensions", "nested-usage.ts");
const NESTED_OUTER_TOOL = "nested_usage_outer";
/** Outer tool that holds its call until a gate file exists, then does nested work. */
const NESTED_GATED_TOOL = "nested_usage_gated";
/** The leaf's accounted contribution: 40 input + 7 output + 3 cache write. */
const NESTED_LEAF_ACCOUNTED = 50;

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tool results for one tool, in the order the calls finalized. */
function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

/** The structured `{ goal }` payload of a finalized tool call. */
function structuredGoal(result) {
	return result.result.structuredContent?.goal ?? result.result.details?.goal;
}

/** Every entry of one custom-message channel, in append order. */
function wrapUpEntries(entries) {
	return customMessageEntries(entries, WRAPUP_CUSTOM_TYPE);
}

/** Every durable accounting checkpoint, in append order. */
function usageCheckpoints(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === USAGE_ENTRY_TYPE);
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
		tokenBudget: one(/Token budget: (.+)/),
		totalTokens: Number(one(/Token usage: (\d+) tokens/)),
		inputTokens: Number(one(/\(input (\d+),/)),
		outputTokens: Number(output[1]),
		reasoningTokens: Number(output[2]),
		cacheWriteTokens: Number(one(/cache write (\d+);/)),
		cachedReadTokens: Number(one(/cached read (\d+) excluded as reuse/)),
		nestedTokens: Number(one(/nested (\d+) counted once/)),
		activeSeconds: Number(one(/Active time: (\d+)s/)),
		remaining: one(/Remaining capacity: (.+)/),
	};
}

/**
 * Report the current Goal and return everything it says about usage.
 *
 * Notifications are counted rather than matched from the start of the session, so a
 * second report in the same session cannot be answered by the first one.
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

/**
 * Wait until a `goal-state` snapshot for this objective is on disk.
 *
 * Needed because `/goal` commits its snapshot *before* it waits for the run to go
 * idle, so the Goal exists on the branch while the run is still in flight — which
 * is precisely the ordering these probes are about.
 */
async function waitForGoalSnapshot(session, objective, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries);
		if (snapshot?.data?.goal?.objective === objective) return snapshot;
		if (Date.now() > deadline) throw new Error("no creation snapshot reached the session file in time");
		await sleep(20);
	}
}

/** Stop an active Goal's continuation loop deliberately (see goal.test.mjs). */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

test("accounted token usage excludes cached reads, keeps cache writes, and never double-counts reasoning", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "First step.", usage: { input: 120, output: 8, cacheRead: 900, cacheWrite: 30, reasoning: 5 } },
			{ text: "Second step.", usage: { input: 150, output: 12 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		// Completing the Goal is what settles the session, so the whole exchange is
		// observable in one barrier.
		await session.waitForSettled(1);

		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.status, "complete");
		// 158 + 162 + 15: cached reads contribute nothing, reasoning is not added
		// again, cache writes are real consumption. The turn that completes the Goal
		// is Goal work; the post-completion turn is not accounted at all.
		assert.equal(status.totalTokens, 335);
		assert.equal(status.inputTokens, 280);
		assert.equal(status.outputTokens, 25);
		assert.equal(status.reasoningTokens, 5, "reasoning is reported, not added to output");
		assert.equal(status.cacheWriteTokens, 30);
		assert.equal(status.cachedReadTokens, 900, "cached reads are reported, not counted");
		assert.equal(status.nestedTokens, 0);
		assert.equal(status.tokenBudget, "none (unbounded)");
		assert.equal(status.remaining, "unlimited");

		// The totals are durable: the completion snapshot carries them.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries);
		assert.equal(snapshot.data.goal.status, "complete");
		assert.equal(snapshot.data.goal.usage.totalTokens, 335);
		assert.equal(snapshot.data.goal.usage.cachedReadTokens, 900);
		assert.equal(snapshot.data.goal.usage.activeMs >= 0, true);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("reported nested usage is counted exactly once", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [NESTED_EXTENSION] });
	// Two concurrent calls in one assistant response, so nested work is reported
	// twice in the same turn and has to be charged once per call.
	script(
		[
			{
				toolCalls: [
					{ name: NESTED_OUTER_TOOL, args: {} },
					{ name: NESTED_OUTER_TOOL, args: {} },
				],
				usage: { input: 100, output: 20 },
			},
			{ text: "Second step.", usage: { input: 30, output: 5 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		// The nested calls really happened: Pi records them on the calling tool results.
		const entries = readSessionEntries(await session.sessionFile());
		const outerResults = entries.filter(
			(e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === NESTED_OUTER_TOOL,
		);
		assert.equal(outerResults.length, 2, "both concurrent calls were persisted");
		for (const outerResult of outerResults) {
			assert.equal(outerResult.message.nestedCalls?.calls.length, 1, "one nested call was recorded");
			assert.equal(outerResult.message.nestedCalls?.calls[0].name, "nested_usage_leaf");
			// Pi folds the nested usage into the tool result's own usage (its total
			// includes the cached reads), and the Goal accounts 40 + 7 + 3 from it.
			assert.equal(outerResult.message.usage?.totalTokens, 150);
			assert.equal(outerResult.message.usage?.cacheRead, 100);
		}

		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		// 120 + 2 x 50 (nested, each counted once) + 35 + 15.
		assert.equal(status.totalTokens, 270);
		assert.equal(status.nestedTokens, 2 * NESTED_LEAF_ACCOUNTED, "nested usage counted once per call");
		assert.equal(status.cachedReadTokens, 200, "the nested cached reads are still excluded");
		assert.equal(status.reasoningTokens, 8, "the nested reasoning is still not added again");
		assert.equal(status.inputTokens, 100 + 40 + 40 + 30 + 10);
		assert.equal(status.outputTokens, 20 + 7 + 7 + 5 + 5);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("usage accounting survives a restart and is never charged twice", async () => {
	// Pi resumes a session in its stored working directory, so both processes share
	// one test-owned work dir. The first session dir outlives its process, because
	// the durable accounting checkpoint is written at shutdown.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const firstSessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));

	const first = await PiRpcSession.start({ cwd: workDir, sessionDir: firstSessionDir });
	script(
		[
			{ text: "First step.", usage: { input: 100, output: 10 } },
			{ text: "Second step.", usage: { input: 50, output: 5 } },
			{ hang: true },
		],
		first,
	);
	let sessionFile;
	try {
		await first.prompt(`/goal ${OBJECTIVE}`);
		await first.waitForNotify((r) => r.message.includes("created and activated"));
		// Two runs completed (110 + 55 tokens) and the third is held, so the loop can
		// be stopped deliberately with the Goal still active.
		await abortActiveLoop(first, 3);
		const before = await reportUsage(first, (r) => r.message.includes(OBJECTIVE));
		// 110 + 55 from the two completed runs, plus the 15 Pi reports for the
		// aborted request: an aborted call still consumed its prompt.
		assert.equal(before.totalTokens, 180, "the first process accounted both completed runs");
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	sessionFile = first.findSessionFile();
	copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	sessionFile = join(resumedDir, basename(sessionFile));

	const second = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Third step.", usage: { input: 20, output: 2 } }, { hang: true }], second);
	try {
		await second.waitForNotify((r) => r.message.includes("restored (active)"));
		// Before any run: the restored totals are exactly what the first process
		// accounted. A reconstruction replay that double-charged would report 360.
		const restored = await reportUsage(second, (r) => r.message.includes(OBJECTIVE));
		assert.equal(restored.totalTokens, 180);

		// New work is charged on top of the restored totals, exactly once.
		await second.prompt("Please keep going");
		await abortActiveLoop(second, 2);
		const after = await reportUsage(second, (r) => r.message.includes(OBJECTIVE));
		// 180 restored + 15 for the aborted continuation. The ordinary prompt itself
		// ("Please keep going") is not Goal-owned work, so its 22 tokens are excluded.
		assert.equal(after.totalTokens, 195);
		assert.ok(after.activeSeconds >= restored.activeSeconds, "active time only grows");

		const entries = readSessionEntries(sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active");
		assertOnlyFailures(second, [{ stopReason: "aborted" }]);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(firstSessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("an extension-level default token budget applies to new Goals", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { defaultTokenBudget: 250 } } });
	script(
		[
			{ text: "First step.", usage: { input: 100, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);

		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.tokenBudget, "250 tokens", "the configured default applies");
		// 110 + 15 accounted: the completion turn is Goal work, the turn after it is not.
		assert.equal(status.totalTokens, 125);
		assert.equal(status.remaining, "125 tokens");
		assert.ok(!status.remaining.includes("exhausted"));

		// The default is durable with the Goal.
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		assert.equal(snapshot.data.goal.tokenBudget, 250);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("--no-budget creates an unbounded Goal even when a default is configured", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { defaultTokenBudget: 250 } } });
	script([{ text: "On it." }, { hang: true }], session);
	try {
		await session.prompt(`/goal --no-budget ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.tokenBudget, "none (unbounded)", "the flag prefix is stripped from the objective");
		assert.equal(status.remaining, "unlimited");
		assert.match(status.status, /active/);

		await abortActiveLoop(session, 2);
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		assert.equal(snapshot.data.goal.objective, OBJECTIVE);
		assert.equal(snapshot.data.goal.tokenBudget, undefined);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("an explicit per-Goal budget above the configured maximum is refused", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { maxTokenBudget: 500 } } });
	script([{ text: "On it." }, { hang: true }], session);
	try {
		// Above the maximum: refused, and nothing is created.
		await session.prompt(`/goal --budget 900 ${OBJECTIVE}`);
		const refused = await session.waitForNotify((r) => r.message.includes("exceeds the configured maximum"));
		assert.equal(refused.notifyType, "error");
		assert.match(refused.message, /900 tokens exceeds the configured maximum of 500/);
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0, "nothing was created");

		await session.prompt("/goal");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));

		// A non-numeric budget is refused too.
		await session.prompt(`/goal --budget soon ${OBJECTIVE}`);
		const invalid = await session.waitForNotify((r) => r.message.includes("whole number of at least 1"));
		assert.equal(invalid.notifyType, "error");
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0);

		// At the maximum: accepted.
		await session.prompt(`/goal --budget 500 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.tokenBudget, "500 tokens");
		assert.equal(status.remaining, "485 tokens", "the kickoff run was accounted");
		assert.match(status.status, /active/);

		await abortActiveLoop(session, 2);
		assert.equal(
			lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.tokenBudget,
			500,
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("create_goal validates its token budget against the configured maximum", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { maxTokenBudget: 500 } } });
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, tokenBudget: 900, userRequest: "Please create a Goal with a huge budget" } }] },
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, tokenBudget: 400, userRequest: "Please create a Goal with a huge budget" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt("Please create a Goal with a huge budget");
		await session.waitForSettled(1);

		const results = toolResults(session, "create_goal");
		assert.equal(results.length, 2);
		assert.equal(results[0].isError, true, "a budget above the maximum is refused");
		assert.match(String(results[0].result.content[0].text), /exceeds the configured maximum of 500/);
		assert.equal(structuredGoal(results[0]), null, "nothing was created");

		assert.equal(results[1].isError, false, "a budget at or below the maximum is accepted");
		const created = structuredGoal(results[1]);
		assert.equal(created.tokenBudget, 400);
		assert.equal(created.remainingTokens, 400);
		assert.equal(created.budgetExhausted, false);
		assert.equal(created.usage.totalTokens, 0);

		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		assert.equal(snapshot.data.goal.tokenBudget, 400);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("a default above the maximum is clamped to the maximum and reported", async () => {
	const session = await PiRpcSession.start({
		settings: { goal: { defaultTokenBudget: 900, maxTokenBudget: 400 } },
	});
	script([{ text: "On it." }, { hang: true }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		const problem = await session.waitForNotify((r) => r.message.includes("goal.defaultTokenBudget"));
		assert.equal(problem.notifyType, "warning");
		assert.match(problem.message, /exceeds goal.maxTokenBudget/);
		assert.match(problem.message, /using the maximum as the default/);

		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.tokenBudget, "400 tokens", "the maximum wins over a larger default");
		assert.equal(status.remaining, "385 tokens", "the kickoff run was accounted");
		await abortActiveLoop(session, 2);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("budget exhaustion stops continuation after exactly one bounded wrap-up and is never completion", async () => {
	const session = await PiRpcSession.start();
	// 85 tokens, then 30 more (115 of a 100-token budget), then the wrap-up, then
	// one ordinary response for the follow-up prompt.
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary." },
			{ text: "After the wrap-up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The exhaustion is announced to the user as soon as it is accounted.
		const exhausted = await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		assert.equal(exhausted.notifyType, "warning");
		assert.match(exhausted.message, /100 tokens \(115 accounted\)/);
		assert.match(exhausted.message, /Budget exhaustion is not completion/);

		// Exactly one run per settlement: kickoff, the last continuation, the
		// wrap-up, and then nothing.
		await session.waitForSettled(1);

		const entries = readSessionEntries(await session.sessionFile());
		const continuations = continuationEntries(entries);
		const wrapUps = wrapUpEntries(entries);
		assert.equal(continuations.length, 1, "the run before exhaustion continued normally");
		assert.equal(wrapUps.length, 1, "exactly one bounded wrap-up");
		assert.equal(runCount(session), 3, "kickoff, continuation, wrap-up");

		// The wrap-up states the budget facts, forbids false completion, and frames
		// the objective as data exactly like the continuation does.
		const wrapUp = wrapUps[0].content;
		assert.match(wrapUp, /exhausted its token budget and is now budget_limited/);
		assert.match(wrapUp, /Accounted usage: 115 tokens of the 100-token budget/);
		assert.match(wrapUp, /This is NOT completion/);
		assert.match(wrapUp, /Do not call update_goal/);
		assert.match(wrapUp, /Next useful action/);
		assert.ok(wrapUp.includes(">>> BEGIN GOAL OBJECTIVE DATA"), "the objective is delimited");
		assert.ok(
			wrapUp.indexOf("INSTRUCTIONS FROM PI-GOAL") > wrapUp.indexOf("END GOAL OBJECTIVE DATA (nonce "),
			"the instructions come after the objective data block",
		);

		// The durable state is budget_limited with the wrap-up already delivered.
		const snapshot = lastGoalSnapshot(entries);
		assert.equal(snapshot.data.goal.status, "budget_limited");
		assert.equal(snapshot.data.goal.wrapUpPending, false);
		assert.equal(snapshot.data.goal.tokenBudget, 100);
		// The snapshot is written when the wrap-up is *requested*, so it predates the
		// wrap-up run; the live total below includes it.
		assert.equal(snapshot.data.goal.usage.totalTokens, 115);

		// The model was never asked to complete the Goal, and never did.
		assert.equal(toolResults(session, "update_goal").length, 0);

		// No substantive post-budget continuation: an ordinary run settles.
		const response = await session.prompt("anything else to do?");
		assert.equal(response.success, true);
		await session.waitForSettled(2);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(after).length, 1, "no continuation after the budget ran out");
		assert.equal(wrapUpEntries(after).length, 1, "and no second wrap-up");
		assert.equal(runCount(session), 4, "the new prompt ran once and settled");
		assert.equal(lastGoalSnapshot(after).data.goal.status, "budget_limited");

		// Status reporting agrees, and says the budget is exhausted rather than done.
		// The wrap-up run (15) is Goal work; the ordinary follow-up prompt after it is
		// not, so the total is 115 + 15.
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.status, "budget_limited");
		assert.equal(status.totalTokens, 130);
		assert.equal(status.remaining, "0 tokens (budget exhausted)", "remaining capacity floors at zero");

		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
		assert.equal(failedAssistantOutcomes(session).length, 0);
	} finally {
		await session.stop();
	}
});

test("concurrent nested usage that lands after the budget crossing survives an unclean exit", async () => {
	// The crossing turn's nested calls are already in flight when the budget is
	// crossed, so their usage is charged *after* the transition and *before* the
	// boundary that makes it durable. A snapshot frozen at the crossing would omit
	// the second result, and because a snapshot is the replay baseline, the replay
	// could not recover it either: it sits before the snapshot on the branch.
	//
	// The response that follows fails, so no wrap-up run overwrites the transition
	// with a newer snapshot, and the process is killed instead of shut down, so the
	// transition snapshot is the only baseline a resume can use.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));

	const session = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
	});
	// 120 accounted for the crossing assistant response, 50 per nested result, and 15
	// for the failed response that follows: 235 in total, against a 150-token budget.
	script(
		[
			{
				toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }, { name: NESTED_OUTER_TOOL, args: {} }],
				usage: { input: 110, output: 10 },
			},
			{ error: "invalid api key", usage: { input: 10, output: 5 } },
			{ text: "Never requested." },
		],
		session,
	);
	let sessionFile;
	try {
		await session.prompt(`/goal --budget 150 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const exhausted = await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		assert.match(exhausted.message, /150 tokens \(170 accounted\)/);

		// Both concurrent calls really ran: the gate cannot stop a tool that is already
		// in flight, which is what makes the second result arrive after the crossing.
		await session.waitForSettled(1);
		assert.equal(toolResults(session, NESTED_OUTER_TOOL).length, 2, "both nested calls executed");

		// The failed response is accounted, and the run is a hard exit, so the wrap-up
		// is still owed and nothing overwrites the transition snapshot.
		const live = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(live.status, "budget_limited");
		assert.equal(live.totalTokens, 235, "120 + 2 x 50 nested + the failed response");
		assert.equal(live.nestedTokens, 2 * NESTED_LEAF_ACCOUNTED);
		assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);

		// The durable transition snapshot carries every usage already on the branch.
		// The boundary that writes it is the crossing turn's `turn_end`, which runs after
		// the assistant message *and* both tool results are appended, so both nested
		// results are inside it; the failed response that follows is charged afterwards
		// and is recovered by the replay instead.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries);
		assert.equal(snapshot.data.goal.status, "budget_limited");
		assert.equal(snapshot.data.goal.wrapUpPending, true, "the wrap-up is still owed");
		assert.equal(
			snapshot.data.goal.usage.totalTokens,
			220,
			"the deferred snapshot must not freeze the totals at the crossing (170)",
		);
		assert.equal(snapshot.data.goal.usage.nestedTokens, 2 * NESTED_LEAF_ACCOUNTED);

		// Unclean exit: no shutdown checkpoint, so the transition snapshot above is the
		// only reconstruction baseline.
		session.killNow();
		await session.waitForExit();
		sessionFile = session.findSessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (budget_limited)"));
		const restored = await reportUsage(resumed, (r) => r.message.includes(OBJECTIVE));
		// Live and restored must agree: the second nested result is neither lost nor
		// charged twice (a double charge would report 285).
		assert.equal(restored.status, "budget_limited");
		assert.equal(restored.totalTokens, 235, "the restored total equals the live total");
		assert.equal(restored.nestedTokens, 2 * NESTED_LEAF_ACCOUNTED);
		assert.equal(restored.remaining, "0 tokens (budget exhausted)");
		assert.equal(wrapUpEntries(readSessionEntries(sessionFile)).length, 0, "no wrap-up was delivered");
		assertCleanRun(resumed);
		assert.equal(resumed.extensionErrors().length, 0, JSON.stringify(resumed.extensionErrors()));
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

/**
 * The script for the mid-turn-creation probes.
 *
 * One ordinary assistant response asks for two tools in the same batch:
 * `create_goal`, which commits the Goal while the batch is still running, and a
 * gated tool that holds its call until the test releases it and then reports 50
 * accounted tokens of nested usage. Under the repaired Goal-owned-work contract
 * the creating run stays ordinary: neither its own response, nor the nested tool
 * result that lands after the creation snapshot, nor the response that follows the
 * batch is charged. Attribution starts at the first subsequent Continuation.
 */
const MID_TURN_STEPS = [
	{
		toolCalls: [
			{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: "create a Goal and run the gated tool" } },
			{ name: NESTED_GATED_TOOL, args: {} },
		],
		usage: { input: 10, output: 5 },
	},
	{ text: "Noted.", usage: { input: 5, output: 2 } },
	{ text: "Continuation work.", usage: { input: 20, output: 2 } },
	{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 10, output: 1 } },
	{ text: "Wrapping up.", usage: { input: 5, output: 1 } },
];

/**
 * Run the mid-turn-creation scenario once, stop the first process the way `stopMode`
 * says, and return what the live process and a fresh resume each account.
 *
 * `stopMode` is `"kill"` (SIGKILL, so no shutdown checkpoint is written and the
 * branch replay is the only recovery) or `"stop"` (a clean exit, which force-flushes
 * an accounting checkpoint). Both must land on the same total as the live process:
 * the creating run's nested tool is not Goal work, the first Continuation and the
 * completing turn are, and the replay must draw exactly that line.
 */
async function probeMidTurnCreation(stopMode) {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const gate = join(workDir, "provider-gate");
	// Read by the gated tool; a missing value would make it never block.
	process.env.PI_GOAL_TEST_GATE = gate;

	const first = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
	});
	script(MID_TURN_STEPS, first);
	let sessionFile;
	let live;
	try {
		await first.prompt("create a Goal and run the gated tool");
		await first.waitFor(
			"the gated tool started",
			(records) =>
				records.some((r) => r.type === "tool_execution_start" && r.toolName === NESTED_GATED_TOOL)
					? true
					: undefined,
		);
		// The Goal is committed before anything waits, so its snapshot is already on
		// the branch while the tool is still in flight.
		const created = await waitForGoalSnapshot(first, OBJECTIVE);
		assert.equal(created.data.goal.usage.totalTokens, 0, "the creation snapshot starts at zero");

		writeFileSync(gate, "", "utf8");
		await first.waitForSettled(1);

		live = await reportUsage(first, (r) => r.message.includes(OBJECTIVE));
		assert.equal(live.status, "complete", "the Goal completed on its first Continuation chain");
		// 22 (first Continuation) + 11 (completing turn). The creating run, its nested
		// tool, and the post-completion response are all excluded.
		assert.equal(live.totalTokens, 33);
		assert.equal(live.nestedTokens, 0, "the creating run's nested tool is not Goal-owned work");
		assertOnlyFailures(first, []);
		assert.equal(first.extensionErrors().length, 0, JSON.stringify(first.extensionErrors()));

		if (stopMode === "kill") {
			// Unclean exit: no shutdown checkpoint, so the replay is the only recovery.
			first.killNow();
			await first.waitForExit();
		}
	} finally {
		delete process.env.PI_GOAL_TEST_GATE;
		await first.stop();
	}
	// The session dir outlives the process, so the file is read *after* the exit: a
	// clean shutdown writes its accounting checkpoint during it, and that is exactly
	// what this probe is about.
	sessionFile = first.findSessionFile();
	copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	sessionFile = join(resumedDir, basename(sessionFile));

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (complete)"));
		const restored = await reportUsage(resumed, (r) => r.message.includes(OBJECTIVE));
		assert.equal(restored.status, "complete");
		assert.equal(restored.totalTokens, 33, "and it is restored, not lost");
		assert.equal(restored.nestedTokens, 0, "the replay draws the same ownership line");
		assertOnlyFailures(resumed, []);
		assert.equal(resumed.extensionErrors().length, 0, JSON.stringify(resumed.extensionErrors()));
		// Read the durable entries before the resumed session's temp dir goes away.
		return { live, restored, entries: readSessionEntries(sessionFile) };
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
}

test("create_goal leaves its creating run ordinary and starts attribution at the first Continuation", async () => {
	// The old status-only rule charged the nested tool that was still in flight when
	// the Goal was created. The repaired rule does not: the creating run is ordinary,
	// so its response, its same-batch tool results, and the response that follows the
	// batch are excluded. Live, unclean exit, and clean exit must all agree.
	const unclean = await probeMidTurnCreation("kill");
	assert.equal(
		unclean.restored.totalTokens,
		unclean.live.totalTokens,
		`an unclean exit restores the live total (${unclean.restored.totalTokens} vs ${unclean.live.totalTokens})`,
	);
	assert.equal(unclean.live.totalTokens, 33);

	const clean = await probeMidTurnCreation("stop");
	assert.equal(
		clean.restored.totalTokens,
		clean.live.totalTokens,
		`a clean exit restores the live total (${clean.restored.totalTokens} vs ${clean.live.totalTokens})`,
	);
	assert.equal(clean.live.totalTokens, unclean.live.totalTokens, "both probes account the same work");
	assert.equal(clean.live.nestedTokens, 0);
	assert.equal(clean.restored.nestedTokens, 0);

	// The durable baseline must agree with the live path: the shutdown checkpoint
	// records exactly what the replay recovers, so adopting it changes nothing.
	const checkpoints = usageCheckpoints(clean.entries);
	assert.ok(checkpoints.length >= 1, "the clean exit wrote an accounting checkpoint");
	const last = checkpoints[checkpoints.length - 1];
	assert.equal(
		last.data.usage.totalTokens,
		clean.live.totalTokens,
		"the shutdown checkpoint carries the live total",
	);
	assert.equal(last.data.usage.nestedTokens, 0);
});

test("a budget-limited Goal can be edited, keeps its accounted usage, and never continues", async () => {
	// The lifecycle milestone and the budget milestone compose: the budget stops
	// substantive work, and the user can still refine the finish line of the
	// exhausted Goal. The edit is a durable transition like any other, so it carries
	// the live accounting view, keeps the budget_limited status, and must neither
	// resurrect continuation nor deliver a second wrap-up.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	const EDITED_OBJECTIVE = "Make the full test suite pass and stay green";
	// 85, then 30 more (115 of a 100-token budget), then the wrap-up, then the
	// ordinary run that follows the edit.
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary." },
			{ text: "After the edit." },
		],
		session,
	);
	let sessionFile;
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		await session.waitForSettled(1);

		// Refining the finish line of an exhausted Goal is allowed (only a complete
		// Goal is finished), and it preserves the identity and the usage history.
		await session.prompt(`/goal edit ${EDITED_OBJECTIVE}`);
		const edited = await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.match(edited.message, /The Goal stays budget_limited/);

		// An ordinary run settles with neither a continuation nor a second wrap-up.
		const response = await session.prompt("anything else to do?");
		assert.equal(response.success, true);
		await session.waitForSettled(2);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 1, "only the pre-exhaustion continuation exists");
		assert.equal(wrapUpEntries(entries).length, 1, "the wrap-up is not delivered twice");
		assert.equal(runCount(session), 4, "kickoff, continuation, wrap-up, ordinary run");

		const snapshot = lastGoalSnapshot(entries);
		assert.equal(snapshot.data.goal.status, "budget_limited");
		assert.equal(snapshot.data.goal.objective, EDITED_OBJECTIVE);
		assert.equal(snapshot.data.goal.tokenBudget, 100, "the budget survives the edit");
		assert.equal(
			snapshot.data.goal.usage.totalTokens,
			130,
			"the edit snapshot carries 115 at the boundary plus the wrap-up run, not a frozen total",
		);

		const status = await reportUsage(session, (r) => r.message.includes("stay green"));
		assert.equal(status.status, "budget_limited");
		// 115 at the boundary + the wrap-up run. The ordinary run that followed the
		// edit is not Goal-owned work.
		assert.equal(status.totalTokens, 130);
		assert.equal(status.remaining, "0 tokens (budget exhausted)");

		// The edited, exhausted Goal survives an unclean exit with the same totals.
		session.killNow();
		await session.waitForExit();
		sessionFile = session.findSessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (budget_limited)"));
		const status = await reportUsage(resumed, (r) => r.message.includes("stay green"));
		assert.equal(status.status, "budget_limited");
		assert.equal(status.totalTokens, 130, "the edited Goal restores with the same usage");
		assert.equal(status.remaining, "0 tokens (budget exhausted)");
		assert.equal(
			lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal.objective,
			"Make the full test suite pass and stay green",
		);
		assertCleanRun(resumed);
		assert.equal(resumed.extensionErrors().length, 0, JSON.stringify(resumed.extensionErrors()));
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a run that fails after the budget ran out gets no wrap-up until a run completes", async () => {
	const session = await PiRpcSession.start();
	// The first turn exhausts the 100-token budget (85 + 30 = 115), the second turn
	// fails, and only the third turn completes.
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }], usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ error: "invalid api key" },
			{ text: "Recovered." },
			{ text: "Wrap-up summary." },
			{ text: "Never requested." },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("reached its token budget"));

		// The failed run is a hard exit: no wrap-up is requested for it, so the
		// extension never turns a provider error into an unattended retry.
		await session.waitForSettled(1);
		let entries = readSessionEntries(await session.sessionFile());
		assert.equal(wrapUpEntries(entries).length, 0, "no wrap-up for a failed run");
		assert.equal(continuationEntries(entries).length, 0, "and no continuation either");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, true, "the wrap-up is still owed");
		assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);

		// The next completed run settles into the one bounded wrap-up, and then the
		// Goal stops for good.
		await session.prompt("please recover and finish");
		await session.waitForSettled(2);
		entries = readSessionEntries(await session.sessionFile());
		assert.equal(wrapUpEntries(entries).length, 1, "exactly one wrap-up, delivered once");
		assert.equal(runCount(session), 3, "the failed run, the recovery run, the wrap-up");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, false);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");

		// Nothing continues afterwards.
		await session.prompt("anything else?");
		await session.waitForSettled(3);
		const after = readSessionEntries(await session.sessionFile());
		assert.equal(wrapUpEntries(after).length, 1, "no second wrap-up");
		assert.equal(continuationEntries(after).length, 0);
		assert.equal(runCount(session), 4);
		assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "invalid api key" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a configured maximum alone bounds new Goals, and --no-budget cannot bypass it", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { maxTokenBudget: 100 } } });
	script([{ text: "On it." }, { hang: true }], session);
	try {
		// An explicit unbounded request is refused, not silently clamped.
		await session.prompt(`/goal --no-budget ${OBJECTIVE}`);
		const refused = await session.waitForNotify((r) => r.message.includes("unbounded Goal is not allowed"));
		assert.equal(refused.notifyType, "error");
		assert.match(refused.message, /goal\.maxTokenBudget \(100 tokens\) is configured/);
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0, "nothing was created");

		// An omitted budget with no configured default is bounded by the maximum, so a
		// session that configures only a maximum never gets an unbounded Goal.
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.tokenBudget, "100 tokens", "the maximum is the bound");
		assert.equal(status.remaining, "85 tokens", "the kickoff run was accounted");
		await abortActiveLoop(session, 2);
		assert.equal(
			lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.tokenBudget,
			100,
		);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("the wrap-up is bounded to one response with no tool execution", async () => {
	const session = await PiRpcSession.start();
	// 85 tokens, then 30 more (115 of a 100-token budget). The wrap-up response then
	// reaches for a tool, and the final step must never be requested.
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ text: "Never requested." },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		await session.waitForSettled(1);

		// The wrap-up's tool call was refused, and the batch terminated, so the run
		// ended after that single response instead of driving another model request.
		const blocked = toolResults(session, "get_goal");
		assert.equal(blocked.length, 1, "the wrap-up attempted exactly one tool call");
		assert.equal(blocked[0].isError, true, "and it was blocked");
		assert.match(String(blocked[0].result.content[0].text), /exhausted its token budget/);
		assert.match(String(blocked[0].result.content[0].text), /may not call tools/);

		// Exactly one wrap-up, exactly one response after exhaustion, and no further
		// model turn: the fourth scripted step was never requested.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(wrapUpEntries(entries).length, 1, "exactly one bounded wrap-up");
		assert.equal(assistantOutcomes(session).length, 3, "kickoff, continuation, wrap-up");
		assert.equal(runCount(session), 3, "no additional run for the blocked call");
		assert.equal(continuationEntries(entries).length, 1);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, false);

		// The blocked call's own turn was still accounted.
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.totalTokens, 130);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("an unclean restart does not reclassify post-completion responses as Goal usage", async () => {
	// The session outlives the process, so it is read before the temp dirs go away.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	// 110 for the first turn, 15 for the completing turn, and 35 for the ordinary
	// response that follows completion.
	script(
		[
			{ text: "First step.", usage: { input: 100, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "After completion.", usage: { input: 30, output: 5 } },
		],
		session,
	);
	let sessionFile;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.totalTokens, 125, "the completing turn is Goal work");
		assert.equal(status.status, "complete");

		// No graceful shutdown: no accounting checkpoint is written, so the completion
		// snapshot is the only baseline an unclean restart can use.
		session.killNow();
		await session.waitForExit();
		sessionFile = session.findSessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (complete)"));
		const status = await reportUsage(resumed, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.status, "complete");
		assert.equal(status.totalTokens, 125, "post-completion responses are not Goal usage");
		assertCleanRun(resumed);
		assert.equal(resumed.extensionErrors().length, 0);
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a crash between message_end and settlement does not double-charge the turn", async () => {
	// The session outlives the process, so it is read before the temp dirs go away.
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	const gate = join(session.cwd, "provider-gate");
	// One 15-token response, held for longer than the checkpoint interval so the
	// accounting checkpoint is written in this window, then a held response so the
	// continuation run never settles.
	script([{ text: "Held response.", waitForFile: gate, usage: { input: 10, output: 5 } }, { hang: true }], session);
	let sessionFile;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitFor(
			"kickoff run started",
			(records) => (records.some((r) => r.type === "turn_start") ? true : undefined),
		);
		await sleep(1300);
		writeFileSync(gate, "", "utf8");
		// Wait for the assistant message_end, then for Pi to append the message and the
		// continuation to start. Killing here is the crash window: after an accounting
		// write and before the next one, with the Goal still active.
		await session.waitFor(
			"kickoff assistant message ended",
			(records) =>
				records.some((r) => r.type === "message_end" && r.message.role === "assistant") ? true : undefined,
		);
		await sleep(300);
		session.killNow();
		await session.waitForExit();
		sessionFile = session.findSessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	} finally {
		await session.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
		const status = await reportUsage(resumed, (r) => r.message.includes(OBJECTIVE));
		// Exactly the one assistant response that was accounted live. A checkpoint
		// written from inside message_end would sit ahead of that entry on the branch
		// and be replayed on top of it, reporting 30.
		assert.equal(status.totalTokens, 15, "the turn is charged once, not twice");
		assert.equal(status.status, "active");
		assertCleanRun(resumed);
		assert.equal(resumed.extensionErrors().length, 0);
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("the run that crosses the budget cannot execute substantive tools", async () => {
	const session = await PiRpcSession.start();
	const afterBudget = join(session.cwd, "after-budget.txt");
	// The kickoff accounts 80 of a 100-token budget; the next response accounts 80
	// more (160, over budget) *and* calls the built-in write tool.
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20 } },
			{
				toolCalls: [{ name: "write", args: { path: "after-budget.txt", content: "post budget" } }],
				usage: { input: 60, output: 20 },
			},
			{ text: "Wrap-up summary." },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		// The wrap-up is the only further Goal turn, so one settlement covers the whole
		// exchange.
		await session.waitForSettled(1);

		// The crossing response's tool call was refused, and the batch terminated, so the
		// run ended instead of continuing into another model turn.
		const blocked = toolResults(session, "write");
		assert.equal(blocked.length, 1, "the crossing response attempted one tool call");
		assert.equal(blocked[0].isError, true, "and it was blocked");
		assert.match(String(blocked[0].result.content[0].text), /may not call tools/);
		assert.equal(existsSync(afterBudget), false, "no post-budget side effect exists");

		// Three responses in total: kickoff, the crossing response, the wrap-up. A fourth
		// would mean the crossing run kept working after the budget was gone.
		const outcomes = assistantOutcomes(session);
		assert.equal(outcomes.length, 3, "kickoff, crossing response, wrap-up");
		assert.equal(runCount(session), 3, "kickoff, crossing run, wrap-up run");

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(wrapUpEntries(entries).length, 1, "exactly one bounded wrap-up");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, false);

		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.totalTokens, 175, "80 + 80 at the boundary, plus the wrap-up");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a retried wrap-up cannot run tools", async () => {
	const session = await PiRpcSession.start({
		// Fast, deterministic retry backoff so the retry path is exercised without
		// waiting out Pi's default delays.
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } },
	});
	// Budget 1: the kickoff already crosses it, so the wrap-up is requested at the first
	// settlement. The wrap-up attempt fails with a retryable provider error and Pi
	// retries it in a new run; the retry reaches for a tool.
	script(
		[
			{ text: "Kickoff answer." },
			{ error: "503 upstream overloaded" },
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ text: "Never requested." },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 1 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		await session.waitForSettled(1);

		// Pi retried the transient failure on its own, in a new run.
		const retries = session.records.filter((r) => r.type === "auto_retry_start");
		assert.ok(retries.length >= 1, "Pi retried the transient provider error");
		assert.equal(runCount(session), 3, "kickoff, failed wrap-up, retried wrap-up");

		// The retried wrap-up attempt was still gated: its tool call was blocked, so it
		// produced no work and drove no further model turn.
		const blocked = toolResults(session, "get_goal");
		assert.equal(blocked.length, 1, "the retried wrap-up attempted one tool call");
		assert.equal(blocked[0].isError, true, "and it was blocked");
		assert.match(String(blocked[0].result.content[0].text), /may not call tools/);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(wrapUpEntries(entries).length, 1, "exactly one wrap-up was requested");
		assert.equal(continuationEntries(entries).length, 0, "and no continuation");
		assert.equal(assistantOutcomes(session).length, 3, "kickoff, failed wrap-up, retried wrap-up");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, false);
		assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "503 upstream overloaded" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a restored budget-limited Goal never continues and keeps its accounted usage", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const firstSessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));

	const first = await PiRpcSession.start({ cwd: workDir, sessionDir: firstSessionDir });
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "Continuation answer.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up summary." },
		],
		first,
	);
	let sessionFile;
	try {
		await first.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await first.waitForNotify((r) => r.message.includes("reached its token budget"));
		await first.waitForSettled(1);
		assertCleanRun(first);
	} finally {
		await first.stop();
	}
	sessionFile = first.findSessionFile();
	copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	sessionFile = join(resumedDir, basename(sessionFile));

	const second = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to continue." }, { text: "Never requested." }], second);
	try {
		await second.waitForNotify((r) => r.message.includes("restored (budget_limited)"));

		// An ordinary run on a restored budget-limited Goal settles without any
		// continuation and without a second wrap-up.
		const response = await second.prompt("anything else to do?");
		assert.equal(response.data.disposition, "started");
		await second.waitForSettled(1);
		const entries = readSessionEntries(sessionFile);
		assert.equal(continuationEntries(entries).length, 1, "only the pre-exhaustion continuation exists");
		assert.equal(wrapUpEntries(entries).length, 1, "the wrap-up is not delivered twice");
		assert.equal(runCount(second), 1);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, false);

		// The replay recovers the wrap-up run (15) on top of the 115 the transition
		// snapshot recorded. The ordinary prompt is not Goal-owned work, so it adds
		// nothing: nothing is lost and nothing unrelated is charged across the restart.
		const status = await reportUsage(second, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.status, "budget_limited");
		assert.equal(status.totalTokens, 130);
		assert.equal(status.remaining, "0 tokens (budget exhausted)");
		assertCleanRun(second);
		assert.equal(second.extensionErrors().length, 0);
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(firstSessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("active time accrues while the Goal is active in a live session and excludes process downtime", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const firstSessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));

	const session = await PiRpcSession.start({ cwd: workDir, sessionDir: firstSessionDir });
	const gate = join(session.cwd, "provider-gate");
	script([{ text: "Held response.", waitForFile: gate }, { hang: true }], session);
	let sessionFile;
	let activeBefore;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitFor(
			"kickoff run started",
			(records) => (records.some((r) => r.type === "turn_start") ? true : undefined),
		);
		// Hold the response for over a second: the active clock must accrue it.
		await sleep(1200);
		writeFileSync(gate, "", "utf8");
		// The continuation's held response lets the loop be stopped deliberately.
		await abortActiveLoop(session, 2);

		// No run is in flight now, yet the Goal is active in a live session, so the
		// clock keeps running: active time is session-scoped, not run-scoped.
		await sleep(1200);
		const before = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.ok(before.activeSeconds >= 2, `expected at least 2 accounted seconds, got ${before.activeSeconds}`);
		activeBefore = before.activeSeconds;
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
	sessionFile = join(firstSessionDir, basename(session.findSessionFile()));
	copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
	sessionFile = join(resumedDir, basename(sessionFile));

	// Process downtime: it must not accrue. The margin below is deliberately wider
	// than the downtime so a slow host cannot fail the test for the wrong reason,
	// while still failing if the downtime were counted.
	await sleep(3000);

	const resumed = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Nothing to do." }, { text: "Never requested." }], resumed);
	try {
		await resumed.waitForNotify((r) => r.message.includes("restored (active)"));
		const after = await reportUsage(resumed, (r) => r.message.includes(OBJECTIVE));
		assert.ok(
			after.activeSeconds >= activeBefore,
			`the accounted time survived the restart (${after.activeSeconds} < ${activeBefore})`,
		);
		assert.ok(
			after.activeSeconds < activeBefore + 3,
			`process downtime must not accrue (${after.activeSeconds} >= ${activeBefore} + 3)`,
		);
		assertOnlyFailures(resumed, []);
		assert.equal(resumed.extensionErrors().length, 0);
	} finally {
		await resumed.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(firstSessionDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a completed Goal stops its active-time clock and keeps the accounted usage", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "provider-gate");
	script(
		[
			{ text: "Held response.", waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
			{ text: "After completion." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitFor(
			"kickoff run started",
			(records) => (records.some((r) => r.type === "turn_start") ? true : undefined),
		);
		await sleep(1200);
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(1);

		const before = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(before.status, "complete");
		assert.ok(before.activeSeconds >= 1, `expected at least one accounted second, got ${before.activeSeconds}`);
		assert.equal(before.totalTokens, 30, "the gated turn and the completion turn are Goal work");

		// A further ordinary run after completion adds no Goal usage and no time.
		await session.prompt("anything else?");
		await session.waitForSettled(2);
		const after = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(after.status, "complete");
		assert.equal(after.totalTokens, 30, "a complete Goal accounts no further usage");
		assert.equal(after.activeSeconds, before.activeSeconds, "a terminal Goal stops accruing active time");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
});

test("accounting is checkpointed durably, so nothing is lost at a settlement boundary", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const session = await PiRpcSession.start({ cwd: workDir, sessionDir });
	script(
		[
			{ text: "First step.", usage: { input: 100, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	let sessionFile;
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);
		const status = await reportUsage(session, (r) => r.message.includes(OBJECTIVE));
		assert.equal(status.totalTokens, 125, "no usage is lost at the settlement boundary");
		assertCleanRun(session);
	} finally {
		await session.stop();
	}
	sessionFile = join(sessionDir, basename(session.findSessionFile()));

	// The shutdown checkpoint carries the same totals as the completion snapshot,
	// so a restart converges on one value instead of replaying the whole branch.
	const entries = readSessionEntries(sessionFile);
	const snapshot = lastGoalSnapshot(entries);
	assert.equal(snapshot.data.goal.status, "complete");
	assert.equal(snapshot.data.goal.usage.totalTokens, 125, "the completion turn is accounted in its own snapshot");

	const checkpoints = usageCheckpoints(entries);
	assert.ok(checkpoints.length >= 1, "at least one durable accounting checkpoint");
	const last = checkpoints[checkpoints.length - 1];
	assert.equal(last.data.goalId, snapshot.data.goal.id);
	assert.equal(last.data.usage.totalTokens, 125);
	assert.equal(last.data.usage.activeMs >= 0, true);

	rmSync(sessionDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});
