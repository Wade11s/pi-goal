/**
 * Issue #43: accept the *released* pi-rex-subagent v0.2.0 provider against
 * pi-goal's existing accounting and Token budget behavior.
 *
 * Everything asserted here crosses the two seams the parent spec fixed for Rex:
 * the parent custom tool result (persisted `usage` plus accounting `details`)
 * and the child extension's real session-event behavior (a real child Pi
 * publishing usage snapshots from real Pi session events, loaded from the
 * vendored v0.2.0 release tree — not a local checkout, not a fake in front of
 * pi-goal). pi-goal itself must keep working with no Rex knowledge, which the
 * static isolation test pins.
 *
 * The live scenarios need a `rex` CLI to run an isolated Rex server; without
 * one they skip loudly, because the acceptance they certify is about the real
 * released provider, not about green ticks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CHILD_ACCOUNTED,
	CHILD_USAGE,
	REX_ARTIFACT_DIR,
	REX_PROVENANCE,
	rexAvailable,
	startRexAcceptanceEnv,
} from "./helpers/rex-acceptance.mjs";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	continuationEntries,
	customMessageEntries,
	lastGoalSnapshot,
	liveUsage,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Land the delegated work through the Rex subagent";
const live = rexAvailable();
const skipLive = { skip: !live };

/** The parent-model steps before the handle is known; step 1 is held at its gate. */
function spawnScriptSteps(gate) {
	return [
		{
			toolCalls: [
				{
					name: "rex_spawn",
					args: { prompt: "Say CHILD_DONE", name: "child", provider: "rexdeterministic", model: "child-model" },
				},
			],
			usage: { input: 10, output: 2 },
		},
		{ text: "Child spawned; proceeding.", waitForFile: gate, usage: { input: 3, output: 1 } },
	];
}

/**
 * Rewrite the script with the freshly spawned handle while step 1 is held at
 * its gate, exactly the chained-gate pattern the blocked-audit scenarios use:
 * the held step is byte-identical in both script versions, so whichever version
 * the provider reads for it, the later steps carry the real handle.
 */
function rewriteWithHandle(session, steps) {
	const [spawn, held] = spawnScriptSteps(join(session.cwd, "handle-gate"));
	script([spawn, held, ...steps], session);
}

/** Deep-clone scripted steps with the spawned handle substituted in. */
function withHandle(steps, handle) {
	return JSON.parse(JSON.stringify(steps).replaceAll("__HANDLE__", handle));
}

/** The persisted toolResult entries of one rex tool, in branch order. */
function rexToolResults(entries, toolName) {
	return entries.filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === toolName);
}

/** The `usage` of a persisted tool result, or undefined when it carried none. */
function toolResultUsage(entry) {
	return entry?.message?.usage;
}

test("the vendored provider artifact is the released v0.2.0 tree with recorded provenance", () => {
	const manifest = JSON.parse(readFileSync(join(REX_ARTIFACT_DIR, "package.json"), "utf8"));
	assert.equal(manifest.name, "pi-rex-subagent");
	assert.equal(manifest.version, REX_PROVENANCE.tag.replace(/^v/, ""), "the artifact must be the released version");
	assert.equal(REX_PROVENANCE.tag, "v0.2.0");
	assert.equal(REX_PROVENANCE.releaseCommit, "b2dd0d04c4697ea69e69ede89c69f54fc9d5334c");
	assert.match(REX_PROVENANCE.tarballSha256, /^[0-9a-f]{64}$/, "the release tarball checksum is recorded");
	assert.equal(REX_PROVENANCE.repository, "Wade11s/pi-rex-subagent");
	assert.equal(REX_ARTIFACT_DIR, join(import.meta.dirname, "fixtures", "rex-subagent-v0.2.0"),
		"the live suite loads exactly the vendored release tree");
});

test("pi-goal core contains no Rex import, run-directory parser, or provider-specific accounting branch", () => {
	const srcDir = join(import.meta.dirname, "..", "src");
	const sources = readdirSync(srcDir);
	assert.deepEqual(
		sources.filter((name) => name.endsWith(".ts") && /rex/i.test(readFileSync(join(srcDir, name), "utf8"))),
		[],
		"no src file may mention Rex: the provider seam is Pi's standard tool-result usage",
	);
	const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.equal(manifest.dependencies, undefined, "pi-goal stays dependency-free");
	assert.equal(manifest.peerDependencies["pi-rex-subagent"], undefined);
	assert.equal(manifest.devDependencies["pi-rex-subagent"], undefined);
});

test("released Rex v0.2.0 child usage is charged once inside the Goal admission segment", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(async () => {
		await env.stop();
	});
	// Keep the child mid-turn until its pre-turn snapshot has been observed.
	env.provider.armHold();

	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});

	const handleGate = join(session.cwd, "handle-gate");
	const observeGate = join(session.cwd, "observe-gate");
	const expected = {
		spawn: { input: 10, output: 2 },
		held: { input: 3, output: 1 },
		observeIdle: { input: 5, output: 1 },
		wait: { input: 5, output: 1 },
		repeat: { input: 5, output: 1 },
		stop: { input: 5, output: 1 },
		answer: { input: 10, output: 3 },
		complete: { input: 8, output: 2 },
		done: { input: 4, output: 1 },
	};
	const parentAccounted =
		expected.spawn.input + expected.spawn.output + // kickoff run model work
		expected.held.input + expected.held.output +
		expected.observeIdle.input + expected.observeIdle.output +
		expected.wait.input + expected.wait.output +
		expected.repeat.input + expected.repeat.output +
		expected.stop.input + expected.stop.output +
		expected.answer.input + expected.answer.output +
		expected.complete.input + expected.complete.output; // the completing turn

	// The first observe runs while the child is provably mid-turn: its published
	// snapshot carries the spawn baseline's zero usage, so the cursor advances free.
	const tailSteps = [
		{ toolCalls: [{ name: "rex_observe", args: { handles: ["__HANDLE__"] } }], waitForFile: observeGate, usage: expected.observeIdle },
		{ toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: expected.wait },
		{ toolCalls: [{ name: "rex_observe", args: { handles: ["__HANDLE__"] } }], usage: expected.repeat },
		{ toolCalls: [{ name: "rex_stop", args: { handle: "__HANDLE__", remove: true, killSession: true } }], usage: expected.stop },
		{ text: "All child work observed and collected.", usage: expected.answer },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: expected.complete },
		{ text: "Done.", usage: expected.done },
	];
	script([...spawnScriptSteps(handleGate), ...tailSteps], session);

	const kickoff = session.prompt(`/goal --no-budget ${OBJECTIVE}`);
	const spawnEnd = await session.waitForToolResult("rex_spawn", 1);
	const handle = spawnEnd.result?.details?.runs?.[0]?.handle;
	assert.ok(handle, "the released spawn tool reports a run handle");
	rewriteWithHandle(session, withHandle(tailSteps, handle));
	writeFileSync(handleGate, "", "utf8");

	// The child has requested its held turn, so its pre-turn snapshot exists.
	await env.provider.waitForChildRequest();
	writeFileSync(observeGate, "", "utf8");
	const midTurn = await session.waitForToolResult("rex_observe", 1);

	// Release the child only now; the later wait collects the finished turn.
	env.provider.releaseChild();
	const waitEnd = await session.waitForToolResult("rex_wait", 1);
	const repeatEnd = await session.waitForToolResult("rex_observe", 2);
	const stopEnd = await session.waitForToolResult("rex_stop", 1);
	await kickoff;

	const entries = readSessionEntries(await session.sessionFile());
	const complete = await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the durable completion");
	const goal = complete.data.goal;

	// Persisted parent tool-result usage and cursor details (acceptance: the
	// durable evidence the accounting replay charges from).
	assert.equal(midTurn.isError, false, "observing a held child succeeds");
	assert.equal(midTurn.result.usage, undefined, "a zero-delta observation returns no usage");
	assert.equal(midTurn.result.details.kind, "observation");
	assert.equal(midTurn.result.details.runs[0].handle, handle);
	assert.equal(midTurn.result.details.runs[0].sequence, 1, "the cursor advanced from the spawn baseline");
	assert.deepEqual(
		midTurn.result.details.runs[0].cumulative.input,
		0,
		"the advanced cursor still carries the pre-turn zero usage",
	);

	assert.equal(waitEnd.isError, false);
	assert.deepEqual(
		toolResultUsage(rexToolResults(entries, "rex_wait")[0]),
		{
			input: CHILD_USAGE.input,
			output: CHILD_USAGE.output,
			cacheRead: CHILD_USAGE.cacheRead,
			cacheWrite: CHILD_USAGE.cacheWrite,
			reasoning: CHILD_USAGE.reasoning,
			totalTokens: CHILD_USAGE.input + CHILD_USAGE.output + CHILD_USAGE.cacheRead + CHILD_USAGE.cacheWrite,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
				totalFromProvider: false,
			},
		},
		"the first charged observation carries the full child delta as standard tool-result usage",
	);
	assert.equal(repeatEnd.isError, false);
	assert.equal(repeatEnd.result.usage, undefined, "the repeated observation of the same snapshot charges nothing");
	assert.equal(stopEnd.isError, false);
	assert.equal(stopEnd.result.usage, undefined, "collecting the final snapshot adds no usage");
	assert.equal(stopEnd.result.details.runs[0].final, true, "the stop collected the child's final snapshot");
	assert.ok(stopEnd.result.details.runs[0].sequence > repeatEnd.result.details.runs[0].sequence, "the cursor advanced again");

	// Cached reads stay visible but outside the total; reasoning is reported
	// once (inside output) and never added again.
	assert.equal(goal.usage.totalTokens, parentAccounted + CHILD_ACCOUNTED);
	assert.equal(goal.usage.nestedTokens, CHILD_ACCOUNTED, "the child delta is accounted as tool-result work");
	assert.equal(goal.usage.cachedReadTokens, CHILD_USAGE.cacheRead, "cached reads are visible");
	assert.equal(goal.usage.cacheWriteTokens, CHILD_USAGE.cacheWrite);
	assert.equal(goal.usage.reasoningTokens, CHILD_USAGE.reasoning, "reasoning is reported");
	assert.equal(
		goal.usage.inputTokens,
		expected.spawn.input + expected.held.input + expected.observeIdle.input + expected.wait.input +
			expected.repeat.input + expected.stop.input + expected.answer.input + expected.complete.input + CHILD_USAGE.input,
	);
	assert.equal(
		goal.usage.outputTokens,
		expected.spawn.output + expected.held.output + expected.observeIdle.output + expected.wait.output +
			expected.repeat.output + expected.stop.output + expected.answer.output + expected.complete.output + CHILD_USAGE.output,
		"child output (which already contains its reasoning) is counted once, never twice",
	);
	assert.equal(await liveUsage(session), parentAccounted + CHILD_ACCOUNTED);
	assert.ok(env.provider.requests.length >= 1, "the child really ran on the deterministic provider");
	assert.equal(continuationEntries(entries).length, 2, "the kickoff's continuation and the completing one");
	assert.equal(runCount(session), 3, "the kickoff, the Continuation that collects the child, and the completing one");
	assertStepsConsumed(session, 9);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("released Rex v0.2.0 child usage exhausts the Token budget at the existing accounting boundary", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(async () => {
		await env.stop();
	});
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});

	// Kickoff model work 12 + 4, the collecting turn 6, the child 100: the
	// observation crosses the 120-token budget exactly at the tool-result charge.
	const handleGate = join(session.cwd, "handle-gate");
	const kickoffModel = { input: 10, output: 2 };
	const heldModel = { input: 3, output: 1 };
	const waitModel = { input: 5, output: 1 };
	const gatedToolStep = { input: 5, output: 1 };
	const wrapUpModel = { input: 10, output: 5 };
	const accountedTotal =
		kickoffModel.input + kickoffModel.output + heldModel.input + heldModel.output +
		waitModel.input + waitModel.output + CHILD_ACCOUNTED + gatedToolStep.input + gatedToolStep.output +
		wrapUpModel.input + wrapUpModel.output;

	const tailSteps = [
		{ toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: waitModel },
		{ toolCalls: [{ name: "get_goal", args: {} }], usage: gatedToolStep },
		{ text: "Budget wrap-up: the delegated work is collected; the Objective is not complete; the next useful action is a budget raise.", usage: wrapUpModel },
	];
	script([...spawnScriptSteps(handleGate), ...tailSteps], session);

	const kickoff = session.prompt(`/goal --budget 120 ${OBJECTIVE}`);
	const spawnEnd = await session.waitForToolResult("rex_spawn", 1);
	const handle = spawnEnd.result?.details?.runs?.[0]?.handle;
	assert.ok(handle, "the released spawn tool reports a run handle");
	rewriteWithHandle(session, withHandle(tailSteps, handle));
	writeFileSync(handleGate, "", "utf8");

	const waitEnd = await session.waitForToolResult("rex_wait", 1);
	const gated = await session.waitForToolResult("get_goal", 1);
	const limited = await waitForSnapshot(
		session,
		(s) => s.data.goal?.status === "budget_limited" && s.data.goal?.wrapUpPending === false,
		"the durable budget stop with the wrap-up delivered",
	);
	await kickoff;
	// The wrap-up run's one response is Goal-owned work; let it land, then read
	// the durable stop the chain finally committed.
	await session.waitForSettled(1);

	const entries = readSessionEntries(await session.sessionFile());
	const goal = lastGoalSnapshot(entries).data.goal;
	assert.equal(goal.status, "budget_limited");
	assert.equal(goal.wrapUpPending, false);

	assert.equal(waitEnd.isError, false);
	assert.ok(toolResultUsage(rexToolResults(entries, "rex_wait")[0]), "the child delta was observed and persisted");
	assert.equal(gated.isError, true, "the tool gate blocked the crossing run's next tool call");
	assert.match(
		JSON.stringify(gated.result.content),
		/exhausted its token budget, so this run may not call tools/,
		"the gate names the budget as its reason",
	);
	assert.equal(customMessageEntries(entries, "goal-budget-wrapup").length, 1, "exactly one bounded wrap-up");
	// The durable stop froze the crossing totals; the wrap-up run's one response
	// is Goal-owned work on top of it, exactly as the live report must show.
	assert.equal(goal.usage.nestedTokens, CHILD_ACCOUNTED, "the exhaustion was crossed by child usage");
	assert.equal(await liveUsage(session), accountedTotal);
	assert.equal(goal.tokenBudget, 120);
	assert.equal(continuationEntries(entries).length, 1, "the collecting Continuation; the wrap-up is a budget message, not a Continuation");
	assert.equal(runCount(session), 3, "the kickoff, the collecting Continuation, and the wrap-up run");
	assertStepsConsumed(session, 5);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("identical released-provider child usage observed during an ordinary non-Goal prompt is excluded from Goal accounting", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(async () => {
		await env.stop();
	});
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});

	// The /goal kickoff spawns the child, then an ordinary user steer arrives while
	// the kickoff's closing response is still held. Pi delivers it after that
	// response, so the collecting rex_wait/rex_observe tool results land after the
	// user message: persisted on the branch as standard parent tool results, but
	// outside every open admission segment. The Continuation that follows is
	// Goal-owned work again.
	const handleGate = join(session.cwd, "handle-gate");
	const charged = { spawn: { input: 10, output: 2 }, held: { input: 3, output: 1 }, complete: { input: 8, output: 2 } };
	const excluded = { wait: { input: 5, output: 1 }, observe: { input: 5, output: 1 }, answer: { input: 9, output: 3 } };
	const goalTotal =
		charged.spawn.input + charged.spawn.output + charged.held.input + charged.held.output +
		charged.complete.input + charged.complete.output;

	const tailSteps = [
		{ toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: excluded.wait },
		{ toolCalls: [{ name: "rex_observe", args: { handles: ["__HANDLE__"] } }], usage: excluded.observe },
		{ text: "Ordinary answer: the subagent is done.", usage: excluded.answer },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: charged.complete },
		{ text: "Done.", usage: { input: 4, output: 1 } },
	];
	script([...spawnScriptSteps(handleGate), ...tailSteps], session);

	const kickoff = session.prompt(`/goal --no-budget ${OBJECTIVE}`);
	const spawnEnd = await session.waitForToolResult("rex_spawn", 1);
	const handle = spawnEnd.result?.details?.runs?.[0]?.handle;
	assert.ok(handle, "the released spawn tool reports a run handle");
	rewriteWithHandle(session, withHandle(tailSteps, handle));

	// The ordinary steer queues while the held kickoff response is still in
	// flight, and Pi delivers it right after that response: the segment the
	// kickoff opened is closed by a genuine user prompt.
	await session.steer("Check the subagent's result and usage now.");
	writeFileSync(handleGate, "", "utf8");
	await kickoff;
	await session.waitForSettled(1);
	const complete = await waitForSnapshot(session, (s) => s.data.goal?.status === "complete", "the durable completion");

	const entries = readSessionEntries(await session.sessionFile());
	const goal = complete.data.goal;
	const waitUsage = toolResultUsage(rexToolResults(entries, "rex_wait")[0]);

	assert.deepEqual(
		waitUsage,
		{
			input: CHILD_USAGE.input,
			output: CHILD_USAGE.output,
			cacheRead: CHILD_USAGE.cacheRead,
			cacheWrite: CHILD_USAGE.cacheWrite,
			reasoning: CHILD_USAGE.reasoning,
			totalTokens: CHILD_USAGE.input + CHILD_USAGE.output + CHILD_USAGE.cacheRead + CHILD_USAGE.cacheWrite,
			cost: waitUsage.cost,
		},
		"the ordinary run observed and persisted the identical child delta",
	);
	assert.equal(goal.usage.totalTokens, goalTotal, "none of the child usage reached the Goal total");
	assert.equal(goal.usage.nestedTokens, 0);
	assert.equal(goal.usage.cachedReadTokens, 0, "the excluded observation leaves no cached-read trace either");
	assert.equal(await liveUsage(session), goalTotal);
	assert.ok(env.provider.requests.length >= 1, "the child really ran on the deterministic provider");
	assert.equal(continuationEntries(entries).length, 1, "the completing Continuation after the ordinary work");
	assert.equal(runCount(session), 2, "the steered kickoff run and the completing Continuation");
	assertStepsConsumed(session, 7);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});
