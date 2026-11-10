/**
 * Issue #2 acceptance tests: create and restore a persistent Goal.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and temporary working/session/agent
 * directories. Assertions target public behavior: RPC events, extension UI
 * notifications, tool results, and persisted session entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { PiRpcSession, readSessionEntries, lastGoalSnapshot } from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

test("loading the extension exposes /goal and leaves Goal-less sessions unchanged", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "Hello from the scripted provider." }], session);
	try {
		// /goal is discoverable as an extension command.
		const { commands } = await session.getCommands();
		assert.ok(commands.some((c) => c.name === "goal" && c.source === "extension"));

		// An ordinary prompt runs exactly one agent run and settles normally.
		const response = await session.prompt("Hello there");
		assert.equal(response.success, true);
		assert.equal(response.data.disposition, "started");
		await session.waitForSettled(1);
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 1);
		assert.equal(session.extensionErrors().length, 0);

		// The session stays Goal-free: no goal entries were persisted.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(entries.filter((e) => e.type === "custom" && e.customType === "goal-state").length, 0);

		// Bare /goal in a Goal-less session reports that clearly (no run started).
		const status = await session.prompt("/goal");
		assert.equal(status.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes("No Goal is set"));
		assert.equal(notify.notifyType, "info");
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 1);
	} finally {
		await session.stop();
	}
});

test("/goal <objective> stores an active Goal, starts initial work, and get_goal returns structured state", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }], usage: { input: 120, output: 8 } },
			{ text: "Goal retrieved. Starting work.", usage: { input: 150, output: 12 } },
		],
		session,
	);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.success, true);
		assert.equal(response.data.disposition, "handled");

		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The kickoff message started initial work: one run with a get_goal tool call.
		await session.waitForToolResult("get_goal", 1);
		const settled = await session.waitForSettled(1);
		assert.equal(settled.aborted, false);
		assert.equal(session.extensionErrors().length, 0);

		// get_goal returned the structured state to the model.
		const toolEnd = session.records.find((r) => r.type === "tool_execution_end" && r.toolName === "get_goal");
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.objective, OBJECTIVE);
		assert.equal(state.status, "active");
		assert.equal(state.revision, 0);
		assert.ok(state.id.startsWith("goal_"));
		assert.equal(state.tokenBudget, null);
		assert.equal(state.usage.totalTokens, null);
		assert.equal(state.usage.activeSeconds, null);

		// The kickoff custom message carried the objective into model context.
		const kickoffEnd = session.records.find(
			(r) => r.type === "message_end" && r.message.role === "custom" && r.message.customType === "goal-continuation",
		);
		assert.ok(kickoffEnd, "kickoff custom message was sent");
		assert.ok(kickoffEnd.message.content.includes(OBJECTIVE));

		// The Goal snapshot is persisted as a custom entry outside model context.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries);
		assert.ok(snapshot, "goal-state custom entry persisted");
		assert.equal(snapshot.data.version, 1);
		assert.equal(snapshot.data.goal.objective, OBJECTIVE);
		assert.equal(snapshot.data.goal.status, "active");
	} finally {
		await session.stop();
	}
});

test("bare /goal reports objective, lifecycle status, and available usage fields", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "On it." }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForSettled(1);

		const runsBefore = session.records.filter((r) => r.type === "agent_start").length;
		const response = await session.prompt("/goal");
		assert.equal(response.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes(OBJECTIVE));
		assert.equal(notify.notifyType, "info");
		assert.match(notify.message, /active/);
		assert.match(notify.message, /Revision: 0/);
		assert.match(notify.message, /Token usage: not tracked yet/);
		assert.match(notify.message, /Active time: not tracked yet/);

		// Status reporting never starts an agent run by itself.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, runsBefore);

		// The reported fields agree with get_goal's structured state.
		const toolEnd = session.records.find((r) => r.type === "tool_execution_end" && r.toolName === "get_goal");
		if (toolEnd) {
			const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
			assert.equal(state.objective, OBJECTIVE);
			assert.equal(state.status, "active");
		}
	} finally {
		await session.stop();
	}
});

test("restart and resume reconstruct the Goal without restating it", async () => {
	// Process 1: create the Goal and let the initial work settle.
	const first = await PiRpcSession.start();
	script([{ text: "On it." }], first);
	let sessionFile;
	try {
		await first.prompt("/goal Ship the release notes page");
		await first.waitForSettled(1);
		sessionFile = await first.sessionFile();
	} finally {
		await first.stop();
	}

	// Process 2: a fresh Pi process resumes the persisted session.
	const second = await PiRpcSession.start({ sessionDir: first.sessionDir, sessionFile });
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ text: "Resumed and working." },
		],
		second,
	);
	try {
		const resumed = await second.prompt("Please continue working on the current objective");
		assert.equal(resumed.data.disposition, "started");
		const toolEnd = await second.waitForToolResult("get_goal", 1);
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.objective, "Ship the release notes page");
		assert.equal(state.status, "active");
		await second.waitForSettled(1);

		// Bare /goal also reports the restored objective.
		await second.prompt("/goal");
		const notify = await second.waitForNotify((r) => r.message.includes("Ship the release notes page"));
		assert.match(notify.message, /active/);

		// The persisted identity is stable across the restart.
		const entries = readSessionEntries(sessionFile);
		const snapshot = lastGoalSnapshot(entries);
		assert.equal(snapshot.data.goal.id, state.id);
	} finally {
		await second.stop();
	}
});

test("extension reload reconstructs the Goal (runtime replacement via session switch)", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "On it." }], session);
	try {
		await session.prompt("/goal Restore me after reload");
		await session.waitForSettled(1);
		const sessionFile = await session.sessionFile();

		// Switching to the same session file replaces the extension runtime
		// (session_shutdown -> reload -> session_start), the same reconstruction
		// path an interactive /reload exercises.
		const id = "switch-1";
		const switchResponse = session.waitFor(
			"switch_session response",
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		session.proc.stdin.write(JSON.stringify({ id, type: "switch_session", sessionPath: sessionFile }) + "\n");
		const switched = await switchResponse;
		assert.equal(switched.success, true);
		assert.equal(switched.data.cancelled, false);

		// The reloaded extension reports the same Goal.
		await session.prompt("/goal");
		const notify = await session.waitForNotify(
			(r) => r.message.includes("Restore me after reload") && r.message.includes("active"),
		);
		assert.ok(notify);

		const entries = readSessionEntries(sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, "Restore me after reload");
	} finally {
		await session.stop();
	}
});

test("ephemeral sessions return a clear persistence error and create nothing", async () => {
	const session = await PiRpcSession.start({ noSession: true });
	script([{ text: "should never run" }], session);
	try {
		const response = await session.prompt("/goal This goal cannot persist");
		assert.equal(response.data.disposition, "handled");
		const notify = await session.waitForNotify((r) => r.message.includes("not persistent"));
		assert.equal(notify.notifyType, "error");
		assert.match(notify.message, /--no-session/);

		// No run was started and no Goal was claimed.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0);
		assert.equal(session.records.filter((r) => r.type === "message_end" && r.message.role === "custom").length, 0);
		const state = await session.getState();
		assert.equal(state.sessionFile, undefined);
	} finally {
		await session.stop();
	}
});

test("create rejects invalid objectives and refuses to replace an existing Goal", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "On it." }], session);
	try {
		// Too short (validation).
		await session.prompt("/goal ab");
		const invalid = await session.waitForNotify((r) => r.message.includes("must be between"));
		assert.equal(invalid.notifyType, "error");

		// Reserved later-milestone subcommands are refused rather than treated as objectives.
		await session.prompt("/goal pause");
		const reserved = await session.waitForNotify((r) => r.message.includes("not implemented in this milestone"));
		assert.equal(reserved.notifyType, "warning");

		// Nothing was created so far.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0);

		// Create one Goal, then attempt to replace it.
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForSettled(1);
		await session.prompt("/goal A different objective entirely");
		const guard = await session.waitForNotify((r) => r.message.includes("already set"));
		assert.equal(guard.notifyType, "warning");

		// The original objective is intact.
		await session.prompt("/goal");
		const notify = await session.waitForNotify((r) => r.message.includes(OBJECTIVE) && r.message.includes("active"));
		assert.ok(notify);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, OBJECTIVE);
	} finally {
		await session.stop();
	}
});
