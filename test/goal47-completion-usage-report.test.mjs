/**
 * Issue #47: the budgeted-Goal completion usage report.
 *
 * Completing a *budgeted* Goal must tell the final response to report the cost
 * and duration of the work — accounted tokens, Active elapsed time, Token
 * budget, remaining capacity, and the accounting approximations behind them —
 * inside the structured `update_goal` result, without asking the provider for
 * another turn. Completing an unbudgeted Goal must not claim a budget or any
 * remaining capacity.
 *
 * Both scenarios drive a real `pi --mode rpc` subprocess with the pi-goal
 * package loaded and a scripted provider, and assert the *actual* finalized
 * `update_goal` tool result plus the run count, so the report cannot come from
 * an extra model turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	continuationEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
	script,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";

/** The model-visible text of one finalized tool result. */
function resultText(result) {
	return result.content
		.filter((block) => block && block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Run one Goal to completion, returning the settled session's tool result. */
async function completeOnce(session, createCommand) {
	script(
		[
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 60, output: 20, cacheWrite: 5 },
			},
			{ text: "Done." },
		],
		session,
	);
	await session.prompt(createCommand);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	const end = await session.waitForToolResult("update_goal", 1);
	assert.notEqual(end.isError, true, `completion was refused: ${resultText(end.result)}`);
	await session.waitForSettled(1);
	return end;
}

test("completing a budgeted Goal reports its usage in the structured tool result without another provider request", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const end = await completeOnce(session, `/goal --budget 100 ${OBJECTIVE}`);

	// The structured result is the contract: the Goal state is unchanged in
	// meaning, and the completion report rides alongside it.
	const structured = end.result.structuredContent;
	assert.equal(structured.goal.status, "complete");
	assert.equal(structured.goal.tokenBudget, 100);
	assert.equal(structured.goal.usage.totalTokens, 85);
	assert.equal(structured.goal.remainingTokens, 15);

	const report = structured.completionReport;
	assert.ok(report, "a budgeted completion carries a completion report");
	assert.equal(report.accountedTokens, 85);
	assert.equal(report.activeSeconds, structured.goal.usage.activeSeconds);
	assert.equal(report.tokenBudget, 100);
	assert.equal(report.remainingTokens, 15);

	const instruction = report.instruction;
	assert.match(instruction, /final response must report/, "it instructs the final response");
	assert.match(instruction, /85 (accounted )?tokens/, "it includes the accounted total");
	assert.match(instruction, /100-token Token budget/, "it includes the Token budget");
	assert.match(instruction, /15 tokens of remaining capacity/, "it includes remaining capacity");
	assert.match(instruction, /Active elapsed time/, "it names Active elapsed time");
	assert.match(instruction, /approximation/i, "it presents accounted usage as an approximation");
	assert.doesNotMatch(instruction, /exact/i, "it never describes accounted usage as invoice-exact");

	// The applicable accounting approximations travel with the instruction.
	const notes = report.accountingNotes.join(" ");
	assert.ok(report.accountingNotes.length > 0, "the report carries the accounting notes");
	assert.match(notes, /input \+ output \+ cache writes/, "the token formula is stated");
	assert.match(notes, /cached read/i, "excluded cached reads are stated");
	assert.match(notes, /process downtime/, "the Active elapsed time approximation is stated");

	// The model sees the instruction too, or it could not report anything.
	assert.match(resultText(end.result), /final response must report/);

	// Completion and accounting behavior are unchanged: one durable complete
	// snapshot, no continuation, and no extra provider request for the report.
	const entries = readSessionEntries(await session.sessionFile());
	const snapshot = lastGoalSnapshot(entries);
	assert.equal(snapshot.data.goal.status, "complete");
	assert.equal(snapshot.data.goal.usage.totalTokens, 85);
	assert.equal(continuationEntries(entries).length, 0, "a complete Goal never continues");
	assert.equal(runCount(session), 1, "the report needs no extra Goal run");
	assertStepsConsumed(session, 2);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("a budgeted Goal completed by an automatic Continuation reports cumulative usage", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 70, output: 10 } },
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 5, output: 5 },
			},
			{ text: "Done." },
		],
		session,
	);
	await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));

	// The Goal continues once after the kickoff, and that continuation completes it.
	const end = await session.waitForToolResult("update_goal", 1);
	assert.notEqual(end.isError, true, `completion was refused: ${resultText(end.result)}`);
	await session.waitForSettled(1);

	const structured = end.result.structuredContent;
	const report = structured.completionReport;
	assert.ok(report, "a completion from a Continuation carries the report too");
	assert.equal(report.accountedTokens, 90, "the report carries cumulative Goal usage, not just the last turn");
	assert.equal(report.remainingTokens, 10);
	assert.match(report.instruction, /90 accounted tokens of the 100-token Token budget/);
	assert.match(report.instruction, /10 tokens of remaining capacity/);

	const entries = readSessionEntries(await session.sessionFile());
	assert.equal(continuationEntries(entries).length, 1, "the completing continuation is the only one");
	assert.equal(runCount(session), 2, "kickoff plus one continuation, then nothing");
	assertStepsConsumed(session, 3);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("completing an unbudgeted Goal claims no budget and no remaining capacity", async (t) => {
	const session = await PiRpcSession.start();
	t.after(async () => {
		await session.stop();
	});
	const end = await completeOnce(session, `/goal --no-budget ${OBJECTIVE}`);

	const structured = end.result.structuredContent;
	assert.equal(structured.goal.status, "complete");
	assert.equal(structured.goal.tokenBudget, null);
	assert.equal(structured.goal.remainingTokens, null);
	assert.equal(structured.completionReport, undefined, "an unbudgeted completion carries no completion report");

	const text = resultText(end.result);
	assert.match(text, /marked complete/);
	assert.doesNotMatch(text, /remaining capacity/i, "no remaining capacity is claimed");
	assert.doesNotMatch(text, /token budget/i, "no Token budget is claimed");

	const entries = readSessionEntries(await session.sessionFile());
	assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
	assert.equal(continuationEntries(entries).length, 0);
	assert.equal(runCount(session), 1);
	assertStepsConsumed(session, 2);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});
