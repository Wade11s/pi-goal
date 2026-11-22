/**
 * Issue #44: P0-2 recovery, ownership, and final-collection acceptance against
 * the released pi-rex-subagent v0.2.0 provider.
 *
 * These are real parent Pi RPC sessions and real child Pi processes. Assertions
 * use public tool-result Usage/details, Goal snapshots, and session branches;
 * pi-goal never learns a Rex run-directory or cursor format. The few direct
 * run-record operations below are fixture administration (CLI adoption and
 * crash/missing-snapshot setup), not an accounting adapter.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_ACCOUNTED, CHILD_USAGE, rexAvailable, startRexAcceptanceEnv } from "./helpers/rex-acceptance.mjs";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assertStepsConsumed,
	assistantOutcomes,
	goalSnapshots,
	lastGoalSnapshot,
	liveUsage,
	readSessionEntries,
	script,
	submitCommand,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Accept released Rex recovery and ownership";
const TREE_NAV = fileURLToPath(new URL("./extensions/tree-nav.ts", import.meta.url));
const live = rexAvailable();
const skipLive = { skip: live ? false : "needs a local `rex` CLI to run the isolated Rex server", timeout: 120_000 };

function spawnSteps(gate, names = ["child"]) {
	return [
		{
			toolCalls: names.map((name) => ({
				name: "rex_spawn",
				args: { prompt: `Run ${name}`, name, provider: "rexdeterministic", model: "child-model" },
			})),
			usage: { input: 10, output: 2 },
		},
		{ text: "Delegation baselines are durable.", waitForFile: gate, usage: { input: 3, output: 1 } },
	];
}

function substitute(value, replacements) {
	let encoded = JSON.stringify(value);
	for (const [needle, replacement] of Object.entries(replacements)) encoded = encoded.replaceAll(needle, replacement);
	return JSON.parse(encoded);
}

function resultText(event) {
	return event.result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

function assertChildDelta(event, count = 1) {
	assert.equal(event.isError, false, resultText(event));
	assert.deepEqual(event.result.usage, {
		input: CHILD_USAGE.input * count,
		output: CHILD_USAGE.output * count,
		cacheRead: CHILD_USAGE.cacheRead * count,
		cacheWrite: CHILD_USAGE.cacheWrite * count,
		reasoning: CHILD_USAGE.reasoning * count,
		totalTokens: (CHILD_USAGE.input + CHILD_USAGE.output + CHILD_USAGE.cacheRead + CHILD_USAGE.cacheWrite) * count,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
	});
}

async function awaitProviderSteps(session, count) {
	await session.waitFor(`${count} finalized parent provider responses`, () =>
		assistantOutcomes(session).length >= count ? true : undefined,
	);
}

async function abortContinuation(session) {
	await session.waitFor("the automatic continuation", (records) =>
		records.filter((record) => record.type === "agent_start").length >= 2 ? true : undefined,
	);
	await session.sendSimple("abort");
	await session.waitForSettled(1);
}

async function navigateTo(session, entryId) {
	const mark = session.records.length;
	await session.prompt(`/nav ${entryId}`);
	await session.notifyAfter(mark, (record) => record.message.includes(`navigated to ${entryId}`));
}

/** A second parent must neither observe nor adopt this owner's run. */
async function assertForeignRunRejected(t, env, handle) {
	const foreign = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await foreign.stop();
		rmSync(foreign.cwd, { recursive: true, force: true });
	});
	script(
		[
			{ toolCalls: [{ name: "rex_observe", args: { handles: [handle] } }] },
			{ toolCalls: [{ name: "rex_adopt", args: { handle } }] },
			{ text: "Foreign ownership checks finished." },
		],
		foreign,
	);
	await foreign.prompt("Try to inspect another parent's run");
	const observed = await foreign.waitForToolResult("rex_observe", 1);
	const adopted = await foreign.waitForToolResult("rex_adopt", 1);
	await awaitProviderSteps(foreign, 3);
	assert.equal(observed.isError, true);
	assert.equal(observed.result.usage, undefined);
	assert.equal(adopted.isError, true);
	assert.equal(adopted.result.usage, undefined);
	assert.match(resultText(observed), /another parent|different parent|owned by|ownership/i);
	assert.match(resultText(adopted), /another parent|different parent|owned by|ownership/i);
	assertStepsConsumed(foreign, 3);
	assert.equal(foreign.extensionErrors().length, 0, JSON.stringify(foreign.extensionErrors()));
}

test("parallel children, repeated handles, and concurrent observations charge each snapshot once", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(() => env.stop());
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});
	const handleGate = join(session.cwd, "handles");
	const secondTurnGate = join(session.cwd, "second-turn");
	const [spawn, held] = spawnSteps(handleGate, ["parallel-a", "parallel-b"]);
	const tail = [
		{ toolCalls: [{ name: "rex_wait", args: { handles: ["__A__", "__A__", "__B__", "__B__"], timeoutMs: 60_000 } }], usage: { input: 5, output: 1 } },
		{ text: "First snapshots collected.", waitForFile: secondTurnGate, usage: { input: 3, output: 1 } },
		{
			toolCalls: [
				{ name: "rex_observe", args: { handles: ["__A__", "__B__"] } },
				{ name: "rex_observe", args: { handles: ["__B__", "__A__"] } },
			],
			usage: { input: 5, output: 1 },
		},
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } },
		{ text: "Done.", usage: { input: 4, output: 1 } },
	];
	script([spawn, held, ...tail], session);
	const kickoff = session.prompt(`/goal --no-budget ${OBJECTIVE}: parallel`);
	const [spawnA, spawnB] = await Promise.all([
		session.waitForToolResult("rex_spawn", 1),
		session.waitForToolResult("rex_spawn", 2),
	]);
	const a = spawnA.result.details.runs[0].handle;
	const b = spawnB.result.details.runs[0].handle;
	assert.notEqual(a, b);
	script([spawn, held, ...substitute(tail, { __A__: a, __B__: b })], session);
	writeFileSync(handleGate, "", "utf8");

	const first = await session.waitForToolResult("rex_wait", 1);
	assertChildDelta(first, 2);
	assert.equal(first.result.details.runs.length, 2, "duplicate handles collapse to one cursor per child");
	await Promise.all([env.waitForRun(a), env.waitForRun(b)]);
	await Promise.all([env.send(a, "second turn"), env.send(b, "second turn")]);
	await Promise.all([env.waitForRun(a), env.waitForRun(b)]);
	writeFileSync(secondTurnGate, "", "utf8");

	const concurrent = [await session.waitForToolResult("rex_observe", 1), await session.waitForToolResult("rex_observe", 2)];
	assert.equal(concurrent.filter((event) => event.result.usage !== undefined).length, 1, "only one overlapping call charges");
	assertChildDelta(concurrent.find((event) => event.result.usage !== undefined), 2);
	assert.equal(concurrent.find((event) => event.result.usage === undefined).isError, false);
	for (const event of concurrent) assert.equal(event.result.details.runs.length, 2);

	await awaitProviderSteps(session, 7);
	await kickoff;
	const goal = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(goal.status, "complete");
	assert.equal(goal.usage.nestedTokens, 4 * CHILD_ACCOUNTED, "two children × two turns, each exactly once");
	assert.equal(goal.usage.totalTokens, 42 + 4 * CHILD_ACCOUNTED);
	assertStepsConsumed(session, 7);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	await assertForeignRunRejected(t, env, a);
});

test("restart restores totals and cursors; paused work joins only the later observing segment", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(() => env.stop());
	const root = mkdtempSync(join(tmpdir(), "pi-goal-rex-restart-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(sessionDir);
	const options = { ...env.sessionOptions(), cwd, sessionDir, scriptPath: join(root, "parent-script.json") };
	const first = await PiRpcSession.start(options);
	const handleGate = join(cwd, "handle");
	const [spawn, held] = spawnSteps(handleGate);
	script(
		[
			spawn,
			held,
			{ toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: { input: 5, output: 1 } },
			{ text: "First observation complete.", usage: { input: 3, output: 1 } },
			{ hang: true, usage: { input: 0, output: 0 } },
		],
		first,
	);
	let handle;
	let sessionFile;
	try {
		await first.prompt(`/goal --no-budget ${OBJECTIVE}: restart`);
		const spawned = await first.waitForToolResult("rex_spawn", 1);
		handle = spawned.result.details.runs[0].handle;
		script(
			[
				spawn,
				held,
				{ toolCalls: [{ name: "rex_wait", args: { handles: [handle], timeoutMs: 60_000 } }], usage: { input: 5, output: 1 } },
				{ text: "First observation complete.", usage: { input: 3, output: 1 } },
				{ hang: true, usage: { input: 0, output: 0 } },
			],
			first,
		);
		writeFileSync(handleGate, "", "utf8");
		assertChildDelta(await first.waitForToolResult("rex_wait", 1));
		await abortContinuation(first);
		await first.prompt("/goal pause");
		assert.equal(await liveUsage(first), 26 + CHILD_ACCOUNTED);
		sessionFile = await first.sessionFile();
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
		assertStepsConsumed(first, 5, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}

	// This turn runs entirely while the Goal is paused. Observation-time V1 does
	// not retroactively assign it to the paused segment; resume will observe it.
	await env.waitForRun(handle);
	await env.send(handle, "work while parent Goal is paused");
	await env.waitForRun(handle);

	const second = await PiRpcSession.start({ ...options, sessionFile });
	t.after(() => second.stop());
	script(
		[
			{ toolCalls: [{ name: "rex_observe", args: { handles: [handle] } }], usage: { input: 5, output: 1 } },
			{ toolCalls: [{ name: "rex_observe", args: { handles: [handle] } }], usage: { input: 5, output: 1 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } },
			{ text: "Done.", usage: { input: 4, output: 1 } },
		],
		second,
	);
	await second.waitForNotify((record) => record.message.includes("restored (paused)"));
	assert.equal(await liveUsage(second), 26 + CHILD_ACCOUNTED, "restart reconstruction itself charges nothing");
	assertStepsConsumed(second, 0);
	await second.prompt("/goal resume");
	const collected = await second.waitForToolResult("rex_observe", 1);
	const repeated = await second.waitForToolResult("rex_observe", 2);
	assertChildDelta(collected, 1); // exactly the paused turn's delta, not the full cumulative 200
	assert.equal(repeated.result.usage, undefined, "the restored cursor also suppresses a repeated read");
	assert.ok(collected.result.details.runs[0].sequence > 1);
	await awaitProviderSteps(second, 4);
	const goal = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
	assert.equal(goal.status, "complete");
	assert.equal(goal.usage.nestedTokens, 2 * CHILD_ACCOUNTED);
	assert.equal(goal.usage.totalTokens, 26 + 2 * CHILD_ACCOUNTED + 6 + 6 + 10);
	assertStepsConsumed(second, 4);
	assertCleanRun(second);
	assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
});

test("selected-parent-branch replay drops the abandoned observation but retains its spawn baseline", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(() => env.stop());
	const session = await PiRpcSession.start({ ...env.sessionOptions(), extraExtensions: [...env.sessionOptions().extraExtensions, TREE_NAV] });
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});
	const handleGate = join(session.cwd, "handle");
	const [spawn, held] = spawnSteps(handleGate);
	const firstObserve = { toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: { input: 5, output: 1 } };
	const firstText = { text: "Original branch observed the child.", usage: { input: 3, output: 1 } };
	const hang = { hang: true, usage: { input: 0, output: 0 } };
	script([spawn, held, firstObserve, firstText, hang], session);
	await session.prompt(`/goal --no-budget ${OBJECTIVE}: branch`);
	const spawned = await session.waitForToolResult("rex_spawn", 1);
	const handle = spawned.result.details.runs[0].handle;
	script([spawn, held, ...substitute([firstObserve], { __HANDLE__: handle }), firstText, hang], session);
	writeFileSync(handleGate, "", "utf8");
	assertChildDelta(await session.waitForToolResult("rex_wait", 1));
	await abortContinuation(session);
	assert.equal(await liveUsage(session), 26 + CHILD_ACCOUNTED);

	const { entries } = await session.getEntries();
	const spawnEntry = entries.find((entry) =>
		entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === spawned.toolCallId,
	);
	assert.ok(spawnEntry, "the durable spawn baseline is a navigable branch entry");
	await navigateTo(session, spawnEntry.id);
	assert.equal(await liveUsage(session), 12, "the selected prefix contains model work and the free baseline, not the abandoned delta");

	const branchSteps = [
		spawn,
		held,
		substitute(firstObserve, { __HANDLE__: handle }),
		firstText,
		hang,
		{ toolCalls: [{ name: "rex_observe", args: { handles: [handle] } }], usage: { input: 5, output: 1 } },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } },
		{ text: "Done.", usage: { input: 4, output: 1 } },
	];
	script(branchSteps, session);
	await session.prompt(`/goal edit ${OBJECTIVE}: selected branch`);
	const observed = await session.waitForToolResult("rex_observe", 1);
	assertChildDelta(observed, 1); // zero spawn baseline, not the abandoned branch's later cursor
	await awaitProviderSteps(session, 8);
	const goal = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(goal.status, "complete");
	assert.equal(goal.usage.nestedTokens, CHILD_ACCOUNTED);
	assert.equal(goal.usage.totalTokens, 12 + 6 + CHILD_ACCOUNTED + 10);
	assertStepsConsumed(session, 8, [{ stopReason: "aborted" }]);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("Replacement Goal keeps historical and late observed Rex work on the superseded identity", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(() => env.stop());
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});
	const handleGate = join(session.cwd, "handle");
	const lateGate = join(session.cwd, "late");
	const [spawn, held] = spawnSteps(handleGate);
	const historical = { toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: { input: 5, output: 1 } };
	const late = { toolCalls: [{ name: "rex_observe", args: { handles: ["__HANDLE__"] } }], waitForFile: lateGate, usage: { input: 6, output: 1 } };
	const replacementText = { text: "Replacement kickoff.", usage: { input: 20, output: 2 } };
	const complete = { toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } };
	const done = { text: "Done.", usage: { input: 4, output: 1 } };
	script([spawn, held, historical, late, replacementText, complete, done], session);
	const kickoff = session.prompt(`/goal --no-budget ${OBJECTIVE}: original`);
	const spawned = await session.waitForToolResult("rex_spawn", 1);
	const handle = spawned.result.details.runs[0].handle;
	const original = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	script([spawn, held, ...substitute([historical, late], { __HANDLE__: handle }), replacementText, complete, done], session);
	writeFileSync(handleGate, "", "utf8");
	assertChildDelta(await session.waitForToolResult("rex_wait", 1));
	await session.waitFor("the held late-observation turn", (records) => records.filter((record) => record.type === "turn_start").length >= 3 ? true : undefined);
	await env.waitForRun(handle);
	await env.send(handle, "late turn for the original Goal");
	await env.waitForRun(handle);

	const replacement = submitCommand(session, "replace-rex", `/goal --no-budget ${OBJECTIVE}: replacement`);
	await session.respondToConfirm((record) => record.title.includes("Replace the current Goal"), true);
	assert.equal((await replacement).data.disposition, "handled");
	await session.waitForNotify((record) => record.message.includes("created and activated, replacing"));
	writeFileSync(lateGate, "", "utf8");
	const lateObserved = await session.waitForToolResult("rex_observe", 1);
	assertChildDelta(lateObserved, 1);
	await awaitProviderSteps(session, 7);
	await kickoff;

	const entries = readSessionEntries(await session.sessionFile());
	const oldEntry = goalSnapshots(entries).filter((entry) => entry.data.goal?.id === original.id).at(-1);
	const old = oldEntry.data.goal;
	const current = lastGoalSnapshot(entries).data.goal;
	assert.equal(oldEntry.data.superseded, true, "the old identity is retained only as a historical record");
	assert.equal(old.usage.nestedTokens, 2 * CHILD_ACCOUNTED, "both historical and late observations stay with the old Goal");
	assert.equal(old.usage.totalTokens, 12 + 4 + 6 + 7 + 2 * CHILD_ACCOUNTED);
	assert.notEqual(current.id, original.id);
	assert.equal(current.status, "complete");
	assert.equal(current.usage.nestedTokens, 0, "nothing transfers to the replacement identity");
	assert.equal(current.usage.totalTokens, 22 + 10);
	assertStepsConsumed(session, 7);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("adoption excludes pre-adoption work and enforces ownership and re-adoption rules", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(() => env.stop());

	// Adoption: a CLI-created unowned child finishes 100 accounted tokens before
	// the Goal claims it. Only the later turn is chargeable.
	const spawned = await env.cli([
		"spawn", "--name", "adopted", "--provider", "rexdeterministic", "--model", "child-model", "--prompt", "pre-adoption", "--json",
	]);
	const adoptedHandle = JSON.parse(spawned.stdout).handle;
	await env.waitForRun(adoptedHandle);
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});
	const secondTurnGate = join(session.cwd, "second-turn");
	script(
		[
			{ toolCalls: [{ name: "rex_adopt", args: { handle: adoptedHandle } }], usage: { input: 10, output: 2 } },
			{ toolCalls: [{ name: "rex_observe", args: { handles: [adoptedHandle] } }], usage: { input: 5, output: 1 } },
			{ text: "Adoption baseline established.", waitForFile: secondTurnGate, usage: { input: 3, output: 1 } },
			{ toolCalls: [{ name: "rex_observe", args: { handles: [adoptedHandle] } }], usage: { input: 5, output: 1 } },
			{ toolCalls: [{ name: "rex_adopt", args: { handle: adoptedHandle } }], usage: { input: 4, output: 1 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } },
			{ text: "Done.", usage: { input: 4, output: 1 } },
		],
		session,
	);
	await session.prompt(`/goal --no-budget ${OBJECTIVE}: adoption`);
	const adoption = await session.waitForToolResult("rex_adopt", 1);
	assert.equal(adoption.isError, false, resultText(adoption));
	assert.equal(adoption.result.usage, undefined, "the current snapshot is a free adoption baseline");
	assert.equal(adoption.result.details.runs[0].cumulative.input, CHILD_USAGE.input);
	const baselineRead = await session.waitForToolResult("rex_observe", 1);
	assert.equal(baselineRead.result.usage, undefined, "pre-adoption work is not charged retroactively");
	await env.send(adoptedHandle, "post-adoption turn");
	await env.waitForRun(adoptedHandle);
	writeFileSync(secondTurnGate, "", "utf8");
	assertChildDelta(await session.waitForToolResult("rex_observe", 2));
	const reAdoption = await session.waitForToolResult("rex_adopt", 2);
	assert.equal(reAdoption.isError, true);
	assert.equal(reAdoption.result.usage, undefined);
	await awaitProviderSteps(session, 7);
	const goal = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(goal.usage.nestedTokens, CHILD_ACCOUNTED);
	assert.equal(goal.usage.totalTokens, 43 + CHILD_ACCOUNTED);
	assertStepsConsumed(session, 7);
	assertCleanRun(session);
	await assertForeignRunRejected(t, env, adoptedHandle);
});

test("nested delegation is charged only through the immediate child's aggregate", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv({ loadProviderGlobally: true });
	t.after(() => env.stop());
	env.provider.setResponder(({ index, body }) => {
		if (index === 0) {
			return {
				toolCalls: [{
					name: "rex_spawn",
					args: { prompt: "grandchild work", name: "grandchild", provider: "rexdeterministic", model: "child-model", allowNested: true },
				}],
			};
		}
		if (index === 1) {
			const toolMessage = [...body.messages].reverse().find((message) => message.role === "tool");
			const handle = /Spawned Rex subagent ([0-9a-f]+)/.exec(JSON.stringify(toolMessage))?.[1];
			assert.ok(handle, `immediate child received its grandchild handle: ${JSON.stringify(body.messages)}`);
			return { toolCalls: [{ name: "rex_wait", args: { handles: [handle], timeoutMs: 60_000 } }] };
		}
		if (index === 2) return { text: "GRANDCHILD_DONE" };
		if (index === 3) return { text: "IMMEDIATE_CHILD_DONE" };
		throw new Error(`unexpected nested child provider request ${index}`);
	});
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});
	const handleGate = join(session.cwd, "handle");
	const nestedGate = join(session.cwd, "nested");
	const [spawn, held] = spawnSteps(handleGate, ["immediate"]);
	const initialTail = [
		{ toolCalls: [{ name: "rex_wait", args: { handles: ["__HANDLE__"], timeoutMs: 60_000 } }], usage: { input: 5, output: 1 } },
		{ text: "Immediate child aggregate collected.", waitForFile: nestedGate, usage: { input: 3, output: 1 } },
	];
	script([spawn, held, ...initialTail], session);
	await session.prompt(`/goal --no-budget ${OBJECTIVE}: nested`);
	const immediateSpawn = await session.waitForToolResult("rex_spawn", 1);
	const immediate = immediateSpawn.result.details.runs[0].handle;
	script([spawn, held, ...substitute(initialTail, { __HANDLE__: immediate })], session);
	writeFileSync(handleGate, "", "utf8");
	const aggregate = await session.waitForToolResult("rex_wait", 1);
	assertChildDelta(aggregate, 4); // three immediate-child responses + one grandchild tool result
	const grandchild = env.records().find((record) => record.name === "grandchild")?.handle;
	assert.ok(grandchild, "the real immediate child spawned a real grandchild");
	assert.notEqual(grandchild, immediate);
	script(
		[
			spawn,
			held,
			...substitute(initialTail, { __HANDLE__: immediate }),
			{ toolCalls: [{ name: "rex_observe", args: { handles: [grandchild] } }], usage: { input: 4, output: 1 } },
			{ toolCalls: [{ name: "rex_adopt", args: { handle: grandchild } }], usage: { input: 4, output: 1 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } },
			{ text: "Done.", usage: { input: 4, output: 1 } },
		],
		session,
	);
	writeFileSync(nestedGate, "", "utf8");
	const direct = await session.waitForToolResult("rex_observe", 1);
	const adopt = await session.waitForToolResult("rex_adopt", 1);
	assert.equal(direct.isError, true, "the root cannot charge its grandchild directly");
	assert.equal(direct.result.usage, undefined);
	assert.equal(adopt.isError, true, "adoption does not override direct-child ownership");
	assert.equal(adopt.result.usage, undefined);
	await awaitProviderSteps(session, 8);
	const goal = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(goal.usage.nestedTokens, 4 * CHILD_ACCOUNTED, "the grandchild occurs once inside the immediate aggregate");
	assert.equal(goal.usage.totalTokens, 46 + 4 * CHILD_ACCOUNTED);
	assert.equal(env.provider.requests.length, 4);
	assertStepsConsumed(session, 8);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});

test("final stop/removal collects final, unconfirmed, and terminal-missing recovery outcomes", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(() => env.stop());
	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
		rmSync(session.cwd, { recursive: true, force: true });
	});
	const handleGate = join(session.cwd, "handles");
	const [spawn, held] = spawnSteps(handleGate, ["final-clean", "final-unconfirmed", "final-missing"]);
	const tail = [
		{ toolCalls: [{ name: "rex_stop", args: { handle: "__A__", remove: true } }], usage: { input: 5, output: 1 } },
		{ toolCalls: [{ name: "rex_stop", args: { handle: "__B__", remove: true } }], usage: { input: 5, output: 1 } },
		{ toolCalls: [{ name: "rex_stop", args: { handle: "__C__", remove: true } }], usage: { input: 5, output: 1 } },
		{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 8, output: 2 } },
		{ text: "Done.", usage: { input: 4, output: 1 } },
	];
	script([spawn, held, ...tail], session);
	await session.prompt(`/goal --no-budget ${OBJECTIVE}: final collection`);
	const ends = [];
	for (let count = 1; count <= 3; count++) ends.push(await session.waitForToolResult("rex_spawn", count));
	const [a, b, c] = ends.map((event) => event.result.details.runs[0].handle);
	script([spawn, held, ...substitute(tail, { __A__: a, __B__: b, __C__: c })], session);
	for (const handle of [a, b, c]) await env.waitForRun(handle); // durable non-final 100-token snapshots
	await env.killChild(b);
	await env.killChild(c);
	rmSync(join(env.runDir(c), "usage.json"), { force: true }); // fixture-induced terminal snapshot loss
	writeFileSync(handleGate, "", "utf8");

	const clean = await session.waitForToolResult("rex_stop", 1);
	const unconfirmed = await session.waitForToolResult("rex_stop", 2);
	const missing = await session.waitForToolResult("rex_stop", 3);
	assertChildDelta(clean, 1);
	assert.equal(clean.result.details.runs[0].final, true);
	assert.equal(JSON.parse(resultText(clean)).removed, true);
	assertChildDelta(unconfirmed, 1);
	assert.equal(unconfirmed.result.details.runs[0].final, false);
	assert.equal(unconfirmed.result.details.runs[0].finalization, "unconfirmed");
	assert.equal(JSON.parse(resultText(unconfirmed)).removed, true);
	assert.equal(missing.isError, false, resultText(missing));
	assert.equal(missing.result.usage, undefined, "missing history is zero observed recovery, never an invented charge");
	assert.equal(missing.result.details.runs[0].snapshot, "missing");
	assert.equal(missing.result.details.runs[0].finalization, "unconfirmed");
	assert.equal(missing.result.details.runs[0].sequence, 0);
	assert.equal(JSON.parse(resultText(missing)).removed, true);
	for (const handle of [a, b, c]) assert.equal(existsSync(env.runDir(handle)), false, `${handle} removed only after recovery succeeds`);

	await awaitProviderSteps(session, 7);
	const goal = lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	assert.equal(goal.usage.nestedTokens, 2 * CHILD_ACCOUNTED);
	assert.equal(goal.usage.totalTokens, 44 + 2 * CHILD_ACCOUNTED);
	assertStepsConsumed(session, 7);
	assertCleanRun(session);
	assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
});
