/**
 * Issue #8 acceptance tests: compact status rendering, interactive objective
 * editing, and the documented package workflow.
 *
 * The status and editor tests drive a real `pi --mode rpc` subprocess with the
 * pi-goal package loaded and a scripted test model provider, so they observe the
 * same public extension-UI subprotocol an interactive or RPC host uses. The
 * package test exercises `pi install` in an isolated agent directory.
 *
 * The same honesty rules as the earlier milestones apply: every script is sized
 * through the last natural post-tool turn, and every test ends with an explicit
 * outcome assertion, so a green result can only come from the Goal lifecycle and
 * never from a scripted-provider error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	lastGoalSnapshot,
	readSessionEntries,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";
const EDITED_OBJECTIVE = "Ship the release notes page instead";

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/** The last status-bar update pi-goal published, or undefined before one. */
function lastStatus(session) {
	const statuses = session.records.filter(
		(r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "goal",
	);
	return statuses.length > 0 ? statuses[statuses.length - 1] : undefined;
}

function statusText(session) {
	return lastStatus(session)?.statusText;
}

/** Wait until the newest status-bar update matches `pattern`. */
function waitForStatus(session, pattern) {
	return session.waitFor("matching status update", (records) => {
		const statuses = records.filter(
			(r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "goal",
		);
		if (statuses.length === 0) return undefined;
		const text = statuses[statuses.length - 1]?.statusText;
		return text !== undefined && pattern.test(text) ? text : undefined;
	});
}

test("the compact status line follows create, pause, resume, complete, and clear", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "kickoff-gate");
	script(
		[
			// Hold the kickoff response so the run is provably busy while the
			// user pauses and resumes it.
			{ text: "Kickoff answer.", waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.match(statusText(session) ?? "", /\bactive\b/);

		await session.waitFor("kickoff run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 1 ? true : undefined,
		);

		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision"));
		assert.match(statusText(session) ?? "", /\bpaused\b/);

		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed (revision"));
		assert.match(statusText(session) ?? "", /\bactive\b/);

		// Release the kickoff response: the steered resume message runs next.
		writeFileSync(gate, "release");
		await session.waitForToolResult("update_goal", 1);
		assert.match(statusText(session) ?? "", /\bcomplete\b/);

		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared (was complete)"));
		const cleared = lastStatus(session);
		assert.ok(cleared, "a final status update was published");
		assert.equal(cleared.statusText, undefined, "clearing removes the status indicator");

		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("the status line reports budget_limited when the token budget is exhausted", async () => {
	const session = await PiRpcSession.start();
	// 85 tokens, then 30 more (115 of a 100-token budget), then the wrap-up,
	// then one ordinary response for the follow-up prompt.
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
		const exhausted = await session.waitForNotify((r) => r.message.includes("reached its token budget"));
		assert.equal(exhausted.notifyType, "warning");
		assert.match(await waitForStatus(session, /\bbudget_limited\b/), /\bbudget_limited\b/);

		await session.waitForSettled(1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("the status line reports blocked once the blocked audit threshold is met", async () => {
	const session = await PiRpcSession.start();
	const blocker = "The required API credential is missing from the environment";
	script(
		[
			// The kickoff Goal turn reports the blocker, then two automatic
			// continuations report the same blocker: the third report satisfies
			// the three-consecutive-Goal-turn audit.
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker } }] },
			{ text: "Still working." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker } }] },
			{ text: "Still working." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker } }] },
			{ text: "Still working." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const blocked = await session.waitForNotify((r) => r.message.includes("is now blocked"));
		assert.equal(blocked.notifyType, "warning");
		assert.match(await waitForStatus(session, /\bblocked\b/), /\bblocked\b/);

		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("the status line reports usage_limited after a provider usage-limit failure", async () => {
	const session = await PiRpcSession.start();
	script(
		[
			{ text: "Kickoff answer." },
			{ error: "insufficient_quota: current quota exhausted", stopReason: "error" },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		const limited = await session.waitForNotify((r) => r.message.includes("is now usage_limited"));
		assert.equal(limited.notifyType, "warning");
		assert.match(await waitForStatus(session, /\busage_limited\b/), /\busage_limited\b/);

		assertOnlyFailures(session, [{ stopReason: "error", errorMessage: "insufficient_quota" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("bare /goal edit opens an RPC editor dialog prefilled with the objective", async () => {
	const session = await PiRpcSession.start();
	const gate = join(session.cwd, "kickoff-gate");
	script(
		[
			// Hold the kickoff response so the edit dialog is opened while a run
			// is provably in flight, then let the steered edit message run.
			{ text: "Kickoff answer.", waitForFile: gate },
			{ text: "Edited answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitFor("kickoff run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 1 ? true : undefined,
		);

		// Bare /goal edit opens the editor through the RPC extension-UI
		// subprotocol; the host answers it exactly like an interactive user.
		const editPrompt = session.prompt("/goal edit");
		const request = await session.respondToEditor(() => true, EDITED_OBJECTIVE);
		assert.equal(request.title, "Edit Goal objective");
		assert.equal(request.prefill, OBJECTIVE);
		await editPrompt;

		await session.waitForNotify((r) => r.message.includes("objective updated"));
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		assert.equal(snapshot.data.goal.objective, EDITED_OBJECTIVE);
		assert.equal(snapshot.data.goal.status, "active");
		assert.match(lastStatus(session)?.statusText ?? "", /\bactive\b/, "the status indicator follows the edit");

		// Release the kickoff response so the steered edit message can run.
		writeFileSync(gate, "release");
		await session.waitForSettled(1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
