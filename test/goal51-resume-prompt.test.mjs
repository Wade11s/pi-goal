/**
 * Issue #51: the opt-in paused-Goal resume prompt.
 *
 * The prompt is convenience over the user-owned `/goal resume` transition, so
 * every test here asserts the transition it does (or does not) perform, never a
 * private flag:
 *
 * - a real `pi --mode rpc` subprocess reaches a durable Goal state, is stopped,
 *   and is reopened from a copy of its session file — which is exactly what a
 *   session start looks like to the extension;
 * - the reopened process runs with `goal.resumePrompt` (and, where relevant,
 *   `goal.enabled`) in its own settings file, and the test answers the dialog over
 *   the RPC extension-UI subprotocol: accept, decline, dismiss, or not at all;
 * - the assertions read the durable `goal-state` entries, the RPC record stream,
 *   run and continuation counts, and the extension notifications.
 *
 * `PI_GOAL_DIALOG_TIMEOUT_MS` shortens the dialog safety bound for the timeout
 * case only, so the suite does not wait the production interval out; the default
 * timeout is exercised implicitly by every case that answers or ignores the
 * prompt without one.
 *
 * A UI-less Pi mode (print/JSON) is exercised against the extension's own
 * `session_start` handler with a fake Pi API, the same seam
 * `test/goal8-headless.test.mjs` uses for the editor guard: those modes have no
 * dialog to observe through the RPC harness, and the behavior under test is that
 * the handler asks nothing and starts nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	PiRpcSession,
	assertOnlyFailures,
	assertStepsConsumed,
	continuationEntries,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";
import { runAuditChain } from "./helpers/blocked-audit.mjs";
import { parseResumePromptSettings } from "../src/accounting.ts";
import goalExtension from "../src/index.ts";

const OBJECTIVE = "Ship the release notes page";
const BLOCKER = "The upstream API key rotation is still incomplete.";
const USAGE_LIMIT_ERROR = "429 insufficient_quota: you exceeded your current quota for this organization";
const PROMPT_TITLE = "Resume the paused Goal?";
const PROMPT_SETTINGS = { goal: { resumePrompt: true } };

/** Every confirm dialog this suite's extension can open. */
function confirmRequests(session) {
	return session.records.filter((record) => record.type === "extension_ui_request" && record.method === "confirm");
}

/** The resume prompt request, by its user-facing title. */
function isResumePrompt(record) {
	return record.method === "confirm" && record.title === PROMPT_TITLE;
}

/** The newest durable Goal record on the session file. */
async function durableGoal(session) {
	return lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
}

/** Scratch directories shared by the builder process and the reopened one. */
function scratch() {
	return {
		workDir: mkdtempSync(join(tmpdir(), "pi-goal-resume-work-")),
		sessionsDir: mkdtempSync(join(tmpdir(), "pi-goal-resume-sessions-")),
	};
}

async function cleanup(dirs, ...sessions) {
	for (const session of sessions) {
		try {
			await session?.stop();
		} catch {
			session?.killNow();
		}
	}
	rmSync(dirs.workDir, { recursive: true, force: true });
	rmSync(dirs.sessionsDir, { recursive: true, force: true });
}

/**
 * Stop the active continuation loop deliberately.
 *
 * A missing scripted step would also stop it, but that settles on a provider
 * error instead of the Goal lifecycle, so every scenario aborts and asserts the
 * exact outcome.
 */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((record) => record.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/**
 * Copy the builder's session into the test-owned directory, give the reopened
 * process its own provider script (each process starts the scripted provider at
 * step 0), and start it with the settings under test.
 */
async function reopen(first, dirs, options = {}) {
	const source = await first.sessionFile();
	const copy = join(dirs.sessionsDir, basename(source));
	copyFileSync(source, copy);
	writeFileSync(
		join(dirs.workDir, "provider-script.json"),
		JSON.stringify(options.resumeScript ?? [{ hang: true }]),
		"utf8",
	);
	const session = await PiRpcSession.start({
		sessionFile: copy,
		cwd: dirs.workDir,
		settings: options.settings,
		env: options.env,
	});
	return { session, sessionFile: copy };
}

/** Create a Goal, let one continuation run, abort it, and pause the Goal. */
async function reachPaused(first) {
	script([{ text: "Kickoff answer." }, { hang: true }], first);
	await first.prompt(`/goal ${OBJECTIVE}`);
	await first.waitForNotify((record) => record.message.includes("created and activated"));
	await abortActiveLoop(first, 2);
	await first.prompt("/goal pause");
	await first.waitForNotify((record) => record.message.includes("paused"));
	assertOnlyFailures(first, [{ stopReason: "aborted" }]);
}

/**
 * Reach a `paused` Goal that still carries a partial Blocked audit.
 *
 * The blocker report is below the threshold, so it is persisted while the Goal
 * stays active; the user then pauses while that turn's response is still held,
 * which stops the loop without the response being lost. The durable audit is
 * therefore a real one the resume has to drop.
 */
async function reachAuditedPaused(first, dirs) {
	const gate = join(dirs.workDir, "pi-goal-resume-audit-gate");
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Still waiting on the rotation.", waitForFile: gate },
		],
		first,
	);
	await first.prompt(`/goal ${OBJECTIVE}`);
	await first.waitForNotify((record) => record.message.includes("created and activated"));
	await first.waitForToolResult("update_goal", 1);
	await waitForSnapshot(
		first,
		(snapshot) => snapshot.data.goal?.blockedAudit?.turns === 1,
		"the durable partial blocked audit",
	);
	await first.prompt("/goal pause");
	await first.waitForNotify((record) => record.message.includes("paused"));
	writeFileSync(gate, "", "utf8");
	await first.waitForSettled(1);
	assertStepsConsumed(first, 3);
}

/** Reach an `active` Goal by aborting its continuation loop. */
async function reachActive(first) {
	script([{ text: "Kickoff answer." }, { hang: true }], first);
	await first.prompt(`/goal ${OBJECTIVE}`);
	await first.waitForNotify((record) => record.message.includes("created and activated"));
	await abortActiveLoop(first, 2);
	assertOnlyFailures(first, [{ stopReason: "aborted" }]);
}

/** Reach a `complete` Goal. */
async function reachComplete(first) {
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		first,
	);
	await first.prompt(`/goal ${OBJECTIVE}`);
	await first.waitForNotify((record) => record.message.includes("created and activated"));
	await first.waitForToolResult("update_goal", 1);
	await first.waitForSettled(1);
	assertStepsConsumed(first, 3);
}

/** Reach a `blocked` Goal through the real three-turn Blocker identity chain. */
async function reachBlocked(first) {
	await runAuditChain(
		first,
		[{ blocker: BLOCKER }, { blocker: BLOCKER, id: "issued" }, { blocker: BLOCKER, id: "issued" }],
		[],
		async () => {
			await first.prompt(`/goal ${OBJECTIVE}`);
			await first.waitForNotify((record) => record.message.includes("created and activated"));
		},
	);
	assert.match((await durableGoal(first)).status, /^blocked$/);
}

/** Reach a `usage_limited` Goal from a provider usage-limit failure. */
async function reachUsageLimited(first) {
	script([{ text: "Kickoff answer." }, { error: USAGE_LIMIT_ERROR }], first);
	await first.prompt(`/goal ${OBJECTIVE}`);
	await first.waitForNotify((record) => record.message.includes("created and activated"));
	await first.waitForSettled(1);
	assert.equal((await durableGoal(first)).status, "usage_limited");
}

/** Reach a `budget_limited` Goal with its one bounded wrap-up still owed. */
async function reachBudgetLimited(first) {
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ error: "invalid api key", usage: { input: 20, output: 10 } },
		],
		first,
	);
	await first.prompt(`/goal --budget 100 ${OBJECTIVE}`);
	await first.waitForNotify((record) => record.message.includes("created and activated"));
	const snapshot = await waitForSnapshot(
		first,
		(entry) => entry.data.goal?.status === "budget_limited" && entry.data.goal?.wrapUpPending === true,
		"the durable budget stop with a pending wrap-up",
	);
	assert.equal(snapshot.data.goal.usage.totalTokens, 115);
}

test("goal.resumePrompt defaults to off and a malformed value is reported and ignored", () => {
	assert.deepEqual(parseResumePromptSettings(undefined), { enabled: false, problems: [] });
	assert.deepEqual(parseResumePromptSettings({ goal: {} }), { enabled: false, problems: [] });
	assert.deepEqual(parseResumePromptSettings(PROMPT_SETTINGS), { enabled: true, problems: [] });

	const invalid = parseResumePromptSettings({ goal: { resumePrompt: "yes" } });
	assert.equal(invalid.enabled, false, "a malformed value can never opt the user into a prompt");
	assert.equal(invalid.problems.length, 1);
	assert.match(invalid.problems[0], /goal\.resumePrompt must be a boolean/);
	assert.match(invalid.problems[0], /leaving the paused-Goal resume prompt off/);
});

test("the default setting never asks about a restored paused Goal", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachPaused(first);
		const before = await durableGoal(first);
		const reopened = await reopen(first, dirs, { settings: undefined });
		second = reopened.session;

		// The restore notice is the barrier: `session_start` has finished, so a
		// prompt would already have been emitted.
		await second.waitForNotify((record) => record.message.includes(`restored (paused)`));
		const status = await second.prompt("/goal");
		assert.equal(status.data.disposition, "handled");
		assert.equal(confirmRequests(second).length, 0, "no resume prompt may be opened by default");
		assert.equal(runCount(second), 0, "nothing was resumed");
		const after = await durableGoal(second);
		assert.equal(after.status, "paused");
		assert.equal(after.revision, before.revision);
		assert.equal(continuationEntries(readSessionEntries(await second.sessionFile())).length, 1);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("accepting the resume prompt runs the durable user resume with a fresh Blocked audit", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachAuditedPaused(first, dirs);
		const before = await durableGoal(first);
		assert.equal(before.status, "paused");
		assert.equal(before.blockedAudit.turns, 1, "the paused Goal carries the audit the resume must drop");

		const reopened = await reopen(first, dirs, {
			settings: PROMPT_SETTINGS,
			resumeScript: [{ text: "Resumed work." }, { hang: true }],
		});
		second = reopened.session;

		const dialog = await second.respondToConfirm(isResumePrompt, true);
		assert.match(String(dialog.message), /the same durable transition as \/goal resume/);
		const resumedNotice = await second.waitForNotify((record) => record.message.includes("resumed"));
		assert.match(resumedNotice.message, new RegExp(`Goal ${before.id} resumed`));
		assert.match(resumedNotice.message, new RegExp(`revision ${before.revision + 1}`));
		assert.match(resumedNotice.message, /retained progress/);

		// The resume message restarted the loop; stop it deliberately.
		await abortActiveLoop(second, 2);
		const entries = readSessionEntries(await second.sessionFile());
		const after = lastGoalSnapshot(entries).data.goal;
		assert.equal(after.id, before.id, "the identity is preserved");
		assert.equal(after.createdAt, before.createdAt);
		assert.equal(after.objective, before.objective);
		assert.equal(after.status, "active");
		assert.equal(after.revision, before.revision + 1, "exactly one durable resume transition");
		assert.equal(after.blockedAudit, undefined, "a fresh Blocked audit starts from nothing");
		// The paused snapshot was written before the held turn finalized, so the
		// reconstructed ledger may already be a little ahead of it; what matters is
		// that the resume kept the history instead of restarting the accounting.
		assert.ok(
			after.usage.totalTokens >= before.usage.totalTokens && before.usage.totalTokens > 0,
			`resuming preserves the accounted history (before ${before.usage.totalTokens}, after ${after.usage.totalTokens})`,
		);
		assert.equal(confirmRequests(second).length, 1, "the prompt is asked exactly once");
		assert.equal(continuationEntries(entries).length, 2, "the resumed Goal continues normally");
		assertOnlyFailures(second, [{ stopReason: "aborted" }]);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("declining the resume prompt leaves the paused Goal unchanged and asks once", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachPaused(first);
		const before = await durableGoal(first);
		const continuationsBefore = continuationEntries(readSessionEntries(await first.sessionFile())).length;

		const reopened = await reopen(first, dirs, { settings: PROMPT_SETTINGS });
		second = reopened.session;
		await second.respondToConfirm(isResumePrompt, false);
		const declined = await second.waitForNotify((record) => record.message.includes("Resume prompt not confirmed"));
		assert.equal(declined.notifyType, "info");
		assert.match(declined.message, /stays paused/);
		assert.match(declined.message, /declined, dismissed, or timed out/);
		assert.match(declined.message, /\/goal resume/);

		const after = await durableGoal(second);
		assert.equal(after.status, "paused");
		assert.equal(after.revision, before.revision);
		assert.equal(runCount(second), 0, "a decline resumes nothing");
		assert.equal(continuationEntries(readSessionEntries(await second.sessionFile())).length, continuationsBefore);
		assert.equal(confirmRequests(second).length, 1);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("dismissing the resume prompt changes nothing and the session keeps working while it is open", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachPaused(first);
		const before = await durableGoal(first);

		const reopened = await reopen(first, dirs, { settings: PROMPT_SETTINGS });
		second = reopened.session;
		// Wait for the prompt to be *open*, then prove the session is not waiting on
		// it: commands are dispatched while the dialog is unanswered.
		const pending = await second.waitFor("the open resume prompt", (records) =>
			records.find((record) => record.type === "extension_ui_request" && isResumePrompt(record)),
		);
		assert.ok(Number(pending.timeout) > 0, "the dialog is bounded, so it cannot wait forever");
		const status = await second.prompt("/goal");
		assert.equal(status.data.disposition, "handled");
		assert.equal((await second.getState()).isStreaming, false);

		await second.dismissConfirm(isResumePrompt);
		const dismissed = await second.waitForNotify((record) => record.message.includes("Resume prompt not confirmed"));
		assert.match(dismissed.message, /declined, dismissed, or timed out/);
		const after = await durableGoal(second);
		assert.equal(after.status, "paused");
		assert.equal(after.revision, before.revision);
		assert.equal(runCount(second), 0);
		assert.equal(confirmRequests(second).length, 1);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("an unanswered resume prompt times out without resuming anything", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachPaused(first);
		const before = await durableGoal(first);

		const reopened = await reopen(first, dirs, {
			settings: PROMPT_SETTINGS,
			env: { PI_GOAL_DIALOG_TIMEOUT_MS: "400" },
		});
		second = reopened.session;
		// The prompt is never answered; the extension's own safety bound resolves it
		// to "no" and reports the outcome.
		const timedOut = await second.waitForNotify((record) =>
			record.message.includes("Resume prompt not confirmed"),
		);
		assert.match(timedOut.message, /timed out/);
		assert.match(timedOut.message, /stays paused/);
		const after = await durableGoal(second);
		assert.equal(after.status, "paused");
		assert.equal(after.revision, before.revision);
		assert.equal(runCount(second), 0);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("accepting after the Goal changed while the prompt was open resumes nothing", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachPaused(first);
		const before = await durableGoal(first);

		const reopened = await reopen(first, dirs, { settings: PROMPT_SETTINGS });
		second = reopened.session;
		await second.waitFor("the open resume prompt", (records) =>
			records.find((record) => record.type === "extension_ui_request" && isResumePrompt(record)),
		);
		// The user clears the Goal while the dialog is open. The prompt described the
		// paused record, so its answer may not act on the cleared session.
		const cleared = await second.prompt("/goal clear");
		assert.equal(cleared.data.disposition, "handled");
		await second.waitForNotify((record) => record.message.includes("cleared"));

		await second.respondToConfirm(isResumePrompt, true);
		const stale = await second.waitForNotify((record) => record.message.includes("changed while the prompt was open"));
		assert.equal(stale.notifyType, "warning");
		assert.match(stale.message, /no Goal is set anymore/);
		const entries = readSessionEntries(await second.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone remains the newest snapshot");
		assert.equal(runCount(second), 0, "the stale answer resumed nothing");
		assert.equal(confirmRequests(second).length, 1);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("every non-paused Lifecycle status is never prompted for", async (t) => {
	const cases = [
		["active", reachActive],
		["complete", reachComplete],
		["blocked", reachBlocked],
		["usage_limited", reachUsageLimited],
		["budget_limited", reachBudgetLimited],
	];
	for (const [status, reach] of cases) {
		await t.test(status, async () => {
			const dirs = scratch();
			let first;
			let second;
			try {
				first = await PiRpcSession.start({ cwd: dirs.workDir });
				await reach(first);
				const before = await durableGoal(first);
				assert.equal(before.status, status, `the builder reached ${status}`);

				const reopened = await reopen(first, dirs, {
					settings: PROMPT_SETTINGS,
					// A resumed run would have to consume this step; it must stay unused.
					resumeScript: [{ hang: true }],
				});
				second = reopened.session;
				await second.waitForNotify((record) => record.message.includes(`restored (${status})`));
				const report = await second.prompt("/goal");
				assert.equal(report.data.disposition, "handled");

				assert.equal(confirmRequests(second).length, 0, `${status} must never be prompted for`);
				assert.equal(runCount(second), 0, `${status} admits no resume work`);
				const after = await durableGoal(second);
				assert.equal(after.status, status);
				assert.equal(after.revision, before.revision);
				assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
			} finally {
				await cleanup(dirs, first, second);
			}
		});
	}
});

test("a disabled extension never offers the resume prompt and says why", async () => {
	const dirs = scratch();
	let first;
	let second;
	try {
		first = await PiRpcSession.start({ cwd: dirs.workDir });
		await reachPaused(first);
		const before = await durableGoal(first);

		const reopened = await reopen(first, dirs, {
			settings: { goal: { enabled: false, resumePrompt: true } },
		});
		second = reopened.session;
		const suppressed = await second.waitForNotify((record) =>
			record.message.includes("no resume was offered and nothing was resumed"),
		);
		assert.equal(suppressed.notifyType, "warning");
		assert.match(suppressed.message, /goal\.enabled is false/);
		assert.match(suppressed.message, /Re-enable goal\.enabled and run \/goal resume/);

		// The explicit path stays refused too, and the Goal is untouched either way.
		const refused = await second.prompt("/goal resume");
		assert.equal(refused.data.disposition, "handled");
		await second.waitForNotify((record) => record.message.includes("Goal not resumed:"));
		assert.equal(confirmRequests(second).length, 0, "the disabled extension asked nothing");
		assert.equal(runCount(second), 0, "nothing was resumed");
		const after = await durableGoal(second);
		assert.equal(after.status, "paused");
		assert.equal(after.revision, before.revision);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

/**
 * A durable paused Goal snapshot, in the shape the store restores.
 *
 * Written by hand because this seam deliberately has no real Pi process: the
 * assertion is that the extension's `session_start` handler asks nothing in a
 * mode without dialog-capable UI. The record only needs the fields the
 * reconstruction contract validates.
 */
const PAUSED_SNAPSHOT = {
	type: "custom",
	customType: "goal-state",
	data: {
		version: 1,
		goal: {
			id: "goal_paused01",
			objective: OBJECTIVE,
			status: "paused",
			origin: "command",
			createdAt: 1_800_000_000_000,
			updatedAt: 1_800_000_000_000,
			revision: 4,
		},
	},
};

/** A Pi API + `session_start` context with just enough surface for this guard. */
function uiLessSessionStart(mode) {
	const notifications = [];
	const confirms = [];
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerTool() {},
		registerCommand() {},
		getSettings() {
			return PROMPT_SETTINGS;
		},
		appendEntry() {},
		sendUserMessage() {
			throw new Error("a UI-less session start must not start Goal work");
		},
	};
	const ctx = {
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {},
			confirm: async (title, message) => {
				confirms.push({ title, message });
				return true;
			},
		},
		mode,
		hasUI: false,
		cwd: "/tmp",
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [PAUSED_SNAPSHOT],
			getSessionFile: () => "/tmp/pi-goal-resume-prompt-session.jsonl",
		},
	};
	return { pi, handlers, ctx, notifications, confirms };
}

test("print and JSON modes never ask: the resume prompt needs an interactive UI", async (t) => {
	for (const mode of ["print", "json"]) {
		await t.test(mode, () => {
			const { pi, handlers, ctx, notifications, confirms } = uiLessSessionStart(mode);
			goalExtension(pi);
			// The handler is synchronous for this path: it must return without awaiting
			// any dialog, and without opening one.
			handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);
			assert.deepEqual(confirms, [], "no dialog may be opened without a dialog-capable UI");
			const notice = notifications.find((entry) => entry.message.includes("has no interactive UI to ask it"));
			assert.ok(notice, `expected the UI-less notice, got ${JSON.stringify(notifications)}`);
			assert.match(notice.message, /nothing was asked and the Goal stays paused/);
			assert.match(notice.message, /Use \/goal resume/);
			assert.ok(
				notifications.some((entry) => entry.message.includes("restored (paused)")),
				"the ordinary restore notice still lands",
			);
		});
	}
});
