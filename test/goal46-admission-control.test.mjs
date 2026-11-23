/**
 * Issue #46: the `goal.enabled` admission control.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded and a scripted provider, and asserts public behavior only: tool
 * results, extension notifications, RPC events, persisted session entries, run
 * and continuation counts, and accounted usage.
 *
 * The setting is a host preference Pi reloads on session start, so a mid-session
 * change is exercised the way a real user changes it: the session is stopped and
 * resumed with a different `<agent-dir>/settings.json`. That is also what makes
 * "active-but-disabled" observable — the restored Goal keeps its `active`
 * Lifecycle status while admission is off.
 *
 * The honesty rules are the rest of the suite's: every script is sized exactly,
 * and every test ends with `assertCleanRun()` (or `assertOnlyFailures()` when a
 * failure is the subject), so a green result can only come from the Goal
 * lifecycle and never from a scripted-provider error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assertStepsConsumed,
	continuationEntries,
	customMessageEntries,
	goalSnapshots,
	lastGoalSnapshot,
	liveUsage,
	readSessionEntries,
	runCount,
	script,
} from "./helpers/rpc-harness.mjs";
import { parseAdmissionSettings } from "../src/accounting.ts";
import { NESTED_OUTER_TOOL } from "./extensions/nested-usage.ts";
import { formatGoalStatusLine, formatGoalSummary, formatNoGoal, toPublicState } from "../src/goal.ts";

const OBJECTIVE = "Ship the release notes page";
const REQUEST = "Please create a Goal for the release";
/** Keep in sync with the customType the extension uses for the budget wrap-up. */
const WRAPUP_CUSTOM_TYPE = "goal-budget-wrapup";
/** Test-only extension whose outer tool performs nested model work. */
const NESTED_EXTENSION = join(import.meta.dirname, "extensions", "nested-usage.ts");

/** Tool results for one tool, in the order the calls finalized. */
function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

/** The structured `{ goal }` payload of a finalized tool call. */
function structuredGoal(result) {
	return result.structuredContent?.goal ?? result.details?.goal;
}

/** The text a finalized tool call returned to the model. */
function toolText(result) {
	return String(result.content?.[0]?.text ?? "");
}

/**
 * Stop an active Goal's continuation loop deliberately.
 *
 * A missing scripted step would also stop it, but that settles the test on a
 * provider error instead of on the Goal lifecycle, so the loop is always stopped
 * by an explicit abort whose outcome the caller asserts.
 */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/** Every goal-budget-wrapup custom-message entry, in append order. */
function wrapUpEntries(entries) {
	return customMessageEntries(entries, WRAPUP_CUSTOM_TYPE);
}

/**
 * A live session with a restored, still-active Goal.
 *
 * Process 1 creates the Goal and lets one continuation run, then aborts the held
 * response so the Goal stays active. Its session file is copied into a
 * test-owned directory, so the follow-up processes resume the same branch while
 * the first process's temporary directories are already gone.
 *
 * `command` is the `/goal` invocation used to create it, so a scenario can give
 * the restored Goal a token budget without duplicating this setup.
 */
async function activeGoalSession(settings, command = `/goal ${OBJECTIVE}`) {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-workdir-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const first = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "Kickoff answer." }, { text: "First continuation answer." }, { hang: true }], first);
	let sessionFile;
	try {
		await first.prompt(command);
		await abortActiveLoop(first, 3);
		sessionFile = await first.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	const session = await PiRpcSession.start({
		sessionFile: join(resumedDir, basename(sessionFile)),
		cwd: workDir,
		settings,
	});
	return { session, workDir, resumedDir, sessionFile: join(resumedDir, basename(sessionFile)) };
}

async function stopShared(context) {
	await context.session.stop();
	rmSync(context.resumedDir, { recursive: true, force: true });
	rmSync(context.workDir, { recursive: true, force: true });
}

/** A Goal record for the pure formatter tests. */
function record(overrides = {}) {
	return {
		id: "goal_abcd1234",
		objective: OBJECTIVE,
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		revision: 0,
		...overrides,
	};
}

function usage(overrides = {}) {
	return {
		totalTokens: 400,
		inputTokens: 300,
		outputTokens: 80,
		cacheWriteTokens: 20,
		cachedReadTokens: 0,
		reasoningTokens: 0,
		nestedTokens: 0,
		activeMs: 5000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Pure configuration and rendering rules
// ---------------------------------------------------------------------------

test("goal.enabled defaults to enabled and tolerates absence", () => {
	assert.deepEqual(parseAdmissionSettings(undefined), { enabled: true, problems: [] });
	assert.deepEqual(parseAdmissionSettings({}), { enabled: true, problems: [] });
	assert.deepEqual(parseAdmissionSettings({ goal: {} }), { enabled: true, problems: [] });
	assert.deepEqual(parseAdmissionSettings({ goal: { enabled: true } }), { enabled: true, problems: [] });
	assert.deepEqual(parseAdmissionSettings({ goal: { enabled: false } }), { enabled: false, problems: [] });
});

test("a malformed goal.enabled is reported and falls back to the enabled default", () => {
	for (const value of ["false", 0, 1, null, [], {}]) {
		const settings = parseAdmissionSettings({ goal: { enabled: value } });
		assert.equal(settings.enabled, true, `${JSON.stringify(value)} must not silently disable admission`);
		assert.equal(settings.problems.length, 1, `${JSON.stringify(value)} must be reported`);
		assert.match(settings.problems[0], /goal\.enabled must be a boolean/);
	}
	// A budget problem is not an admission problem: the two settings are read
	// independently, so a broken budget never disables the extension.
	assert.deepEqual(parseAdmissionSettings({ goal: { maxTokenBudget: -5, enabled: false } }), {
		enabled: false,
		problems: [],
	});
});

test("the status report surfaces the disabled condition without touching the status", () => {
	const enabled = formatGoalSummary(toPublicState(record({ usage: usage() })));
	assert.ok(!enabled.includes("goal.enabled"), "an enabled extension never mentions the setting");
	const disabled = formatGoalSummary(toPublicState(record({ usage: usage() })), { admissionEnabled: false });
	assert.match(disabled, /^Goal goal_abcd1234 — active/m, "the Lifecycle status is untouched");
	assert.match(disabled, /Admission disabled: goal\.enabled is false/);
	assert.match(disabled, /not a Lifecycle status and not a pause/);
	assert.match(disabled, /keeps accruing active time/);
	assert.match(disabled, /\/goal:pause/);
	assert.match(disabled, /\/goal:clear/);
	// Every enabled rendering is a strict subset of the disabled one.
	assert.ok(disabled.includes(enabled), "the disabled report adds to the ordinary report");
});

test("the compact status line marks admission off without losing the status or usage", () => {
	const state = toPublicState(record({ usage: usage() }));
	assert.equal(formatGoalStatusLine(state), "goal_abcd1234 · active · 400 tok · 5s");
	const disabled = formatGoalStatusLine(state, { admissionEnabled: false });
	assert.match(disabled, /\bactive\b/);
	assert.match(disabled, /400 tok/);
	assert.match(disabled, /admission off/);
	assert.ok(disabled.length <= 80, `the disabled line is not compact: ${disabled}`);
});

test("the disabled block is status-aware about the clock and about resume", () => {
	// Only an active Goal is still running its clock; every other status already
	// stopped it, so the block may not say it keeps accruing or that the refused
	// /goal:resume would restart work.
	const active = formatGoalSummary(toPublicState(record({ usage: usage() })), { admissionEnabled: false });
	assert.match(active, /keeps accruing active time/);
	for (const status of ["paused", "complete", "blocked", "usage_limited", "budget_limited"]) {
		const state = toPublicState(record({ status, usage: usage() }));
		assert.ok(
			!formatGoalSummary(state).includes("Admission disabled"),
			`${status}: the enabled report never mentions the setting`,
		);
		const disabled = formatGoalSummary(state, { admissionEnabled: false });
		assert.ok(
			!disabled.includes("keeps accruing active time"),
			`${status} must not claim a stopped clock is accruing: ${disabled}`,
		);
		assert.match(
			disabled,
			new RegExp(`this Goal is already ${status}, so its active time has already stopped`),
		);
		assert.match(disabled, /no \/goal:resume/, `${status} must say resume is not admitted`);
		if (status !== "complete") {
			// Its status hint names a resume, so the hint has to say it is refused too.
			assert.match(disabled, /is refused while pi-goal is disabled/, `${status}: ${disabled}`);
		}
	}
});

test("the no-Goal report explains the disabled extension instead of only naming the missing Goal", () => {
	assert.equal(formatNoGoal(), "No Goal is set in this session. Use /goal <objective> to create one.");
	const disabled = formatNoGoal(false);
	assert.match(disabled, /No Goal is set in this session/);
	assert.match(disabled, /pi-goal is disabled \(goal\.enabled is false\)/);
	assert.match(disabled, /\/goal <objective>/);
});

// ---------------------------------------------------------------------------
// Admission of new Goal work
// ---------------------------------------------------------------------------

test("the default setting admits creation and automatic continuation", async () => {
	const session = await PiRpcSession.start();
	// Kickoff, its continuation, and a held response so the loop is stopped
	// deliberately with the Goal still active.
	script([{ text: "Kickoff answer." }, { text: "First continuation answer." }, { hang: true }], session);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 3);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(continuationEntries(entries).length, 2, "the default admits automatic continuation");
		assert.equal(runCount(session), 3, "kickoff plus one run per continuation, the last one held open");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active");
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a disabled extension refuses /goal creation and admits nothing", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { enabled: false } } });
	script([{ text: "Ordinary work continues." }], session);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((r) => /disabled/.test(r.message));
		assert.match(refusal.message, /Goal not created: pi-goal is disabled \(goal\.enabled is false\)/);
		// The refusal names the controls that remain available while disabled.
		assert.match(refusal.message, /\/goal/);
		assert.match(refusal.message, /get_goal/);
		assert.match(refusal.message, /terminal updates/);

		assert.equal(runCount(session), 0, "no kickoff run was started");

		// The session itself stays an ordinary Pi session.
		const worked = await session.prompt("Please check the release notes");
		assert.equal(worked.data.disposition, "started");
		await session.waitForSettled(1);
		const afterWork = readSessionEntries(await session.sessionFile());
		assert.equal(goalSnapshots(afterWork).length, 0, "ordinary work still wrote no Goal");
		assert.equal(continuationEntries(afterWork).length, 0, "nothing continues");
		assertStepsConsumed(session, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a disabled extension refuses create_goal and leaves the creation authority intact", async () => {
	const session = await PiRpcSession.start({ settings: { goal: { enabled: false } } });
	// Two identical calls: if the first refusal consumed the one-shot creation
	// authority, the second would fail as an authority error instead.
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: REQUEST } }] },
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: REQUEST } }] },
			{ text: "No Goal was created." },
		],
		session,
	);
	try {
		await session.prompt(REQUEST);
		await session.waitForToolResult("create_goal", 2);
		for (const result of toolResults(session, "create_goal")) {
			assert.equal(result.isError, true, "creation is refused while disabled");
			assert.match(toolText(result.result), /Goal not created: pi-goal is disabled \(goal\.enabled is false\)/);
			assert.match(toolText(result.result), /get_goal/);
			assert.equal(structuredGoal(result.result), null, "the refusal reports no Goal");
		}
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(goalSnapshots(entries).length, 0, "nothing was stored");
		assert.equal(runCount(session), 1, "the model's own run is untouched");
		assertStepsConsumed(session, 3);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a disabled extension refuses a Replacement Goal without asking for confirmation", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	try {
		// A refusal must not open a confirmation dialog for a replacement it will
		// not perform: the current Goal is kept untouched.
		const mark = context.session.records.length;
		const response = await context.session.prompt(`/goal Replace the release notes page entirely`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await context.session.notifyAfter(mark, (r) => /Goal not created:/.test(r.message));
		assert.match(refusal.message, /Goal not created: pi-goal is disabled \(goal\.enabled is false\)/);
		assert.equal(
			context.session.records.filter(
				(r) => r.type === "extension_ui_request" && (r.method === "confirm" || r.method === "editor"),
			).length,
			0,
			"no confirmation dialog was opened",
		);

		const entries = readSessionEntries(context.sessionFile);
		assert.equal(goalSnapshots(entries).length, 1, "the existing Goal is the only snapshot");
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, OBJECTIVE, "the objective is unchanged");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active");
		assert.equal(lastGoalSnapshot(entries).data.goal.revision, 0, "the Goal was not replaced");
		assert.equal(runCount(context.session), 0, "no replacement kickoff was started");
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

// ---------------------------------------------------------------------------
// Lifecycle controls while disabled
// ---------------------------------------------------------------------------

test("a disabled extension refuses a work-admitting objective edit", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	try {
		const mark = context.session.records.length;
		const response = await context.session.prompt(`/goal:edit Ship the migration notes page instead`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await context.session.notifyAfter(mark, (r) => /Goal not edited:/.test(r.message));
		assert.match(refusal.message, /Goal not edited:/);
		assert.match(refusal.message, /work-admitting/);
		assert.match(refusal.message, /pi-goal is disabled \(goal\.enabled is false\)/);

		const entries = readSessionEntries(context.sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, OBJECTIVE, "the objective is unchanged");
		assert.equal(lastGoalSnapshot(entries).data.goal.revision, 0, "no edit revision was written");
		assert.equal(runCount(context.session), 0, "no edit work message was delivered");
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("a disabled extension still permits an objective edit that admits no work", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	script([{ text: "Nothing to do while paused." }], context.session);
	try {
		// Pausing is available while disabled, and it is what stops the clock.
		const paused = await context.session.prompt("/goal:pause");
		assert.equal(paused.data.disposition, "handled");
		await context.session.waitForNotify((r) => r.message.includes("paused"));

		// An edit of a non-active Goal admits no work, so it stays available.
		const editMark = context.session.records.length;
		const edited = await context.session.prompt("/goal:edit Ship the migration notes page instead");
		assert.equal(edited.data.disposition, "handled");
		const notice = await context.session.notifyAfter(editMark, (r) =>
			r.message.includes("objective updated"),
		);
		assert.match(notice.message, /revision 2/);
		assert.match(notice.message, /stays paused/);
		assert.match(notice.message, /pi-goal is disabled \(goal\.enabled is false\)/);
		assert.match(notice.message, /no work was started/);

		const entries = readSessionEntries(context.sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, "Ship the migration notes page instead");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "paused");
		assert.equal(lastGoalSnapshot(entries).data.goal.revision, 2);
		assert.equal(runCount(context.session), 0, "no work message was delivered for the edit");

		// Resume is refused while disabled: it would admit new Goal work.
		const resumeMark = context.session.records.length;
		const resumed = await context.session.prompt("/goal:resume");
		assert.equal(resumed.data.disposition, "handled");
		const refusal = await context.session.notifyAfter(resumeMark, (r) => /Goal not resumed:/.test(r.message));
		assert.match(refusal.message, /Goal not resumed: pi-goal is disabled \(goal\.enabled is false\)/);
		assert.equal(lastGoalSnapshot(readSessionEntries(context.sessionFile)).data.goal.status, "paused");
		assert.equal(runCount(context.session), 0, "the refused resume started no run");
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("a disabled extension keeps pause, clear, and inspection available", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ text: "Nothing left to do." },
		],
		context.session,
	);
	try {
		// Inspection: bare /goal reports the Goal and the disabled condition.
		const status = await context.session.prompt("/goal");
		assert.equal(status.data.disposition, "handled");
		const report = await context.session.waitForNotify((r) => r.message.includes(OBJECTIVE));
		assert.match(report.message, /^Goal goal_[0-9a-f]+ — active/m);
		assert.match(report.message, /Admission disabled: goal\.enabled is false/);
		assert.match(report.message, /not a Lifecycle status and not a pause/);
		assert.match(report.message, /keeps accruing active time/);

		// Inspection through the model tool says the same thing.
		const inspected = await context.session.prompt("Please inspect the current Goal");
		assert.equal(inspected.data.disposition, "started");
		const toolEnd = await context.session.waitForToolResult("get_goal", 1);
		assert.match(toolText(toolEnd.result), /Admission disabled: goal\.enabled is false/);
		await context.session.waitForSettled(1);

		// Clear is available while disabled: the user keeps full stopping control.
		const cleared = await context.session.prompt("/goal:clear");
		assert.equal(cleared.data.disposition, "handled");
		await context.session.waitForNotify((r) => r.message.includes("cleared"));
		const entries = readSessionEntries(context.sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone is durable");
		assertStepsConsumed(context.session, 2);
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

// ---------------------------------------------------------------------------
// The settlement seam: no new automatic work while disabled
// ---------------------------------------------------------------------------

/** The active elapsed time bare `/goal` reports, in whole seconds. */
async function reportActiveSeconds(session) {
	const mark = session.records.length;
	await session.prompt("/goal");
	const notify = await session.notifyAfter(mark, (r) => /Active time: /.test(r.message));
	const match = /Active time: (?:(\d+)m )?(\d+)s/.exec(notify.message);
	assert.ok(match, `no active time in:\n${notify.message}`);
	return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("an active-but-disabled Goal keeps its status and its clock and continues nothing", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	script([{ text: "Working while disabled." }, { hang: true }], context.session);
	try {
		// Restoration says the Goal is active *and* that admission is off, so an
		// active-but-disabled Goal is never mistaken for a continuing one.
		const restored = await context.session.waitForNotify((r) => r.message.includes("restored (active)"));
		assert.match(restored.message, /pi-goal is disabled \(goal\.enabled is false\)/);
		assert.match(restored.message, /keeps accruing active time/);

		const mark = context.session.records.length;
		await context.session.prompt("Please keep working on the objective");
		await context.session.waitForSettled(1);
		const suppressed = await context.session.notifyAfter(mark, (r) => /no continuation was/.test(r.message));
		assert.match(suppressed.message, /Goal goal_[0-9a-f]+ is active, but pi-goal is disabled/);
		assert.match(suppressed.message, /keeps accruing active time/);
		assert.match(suppressed.message, /\/goal:pause, not disabling the extension, stops that clock/);

		const entries = readSessionEntries(context.sessionFile);
		assert.equal(continuationEntries(entries).length, 2, "only the continuations written before the restart");
		assert.equal(runCount(context.session), 1, "the prompt run and nothing else");

		// Disabling the extension is not a pause: the Goal is still active, so its
		// Active elapsed time keeps accruing.
		const first = await reportActiveSeconds(context.session);
		await sleep(1600);
		const second = await reportActiveSeconds(context.session);
		assert.ok(second > first, `active time must keep accruing while disabled: ${first}s then ${second}s`);

		// The Lifecycle status itself never moved.
		assert.equal(lastGoalSnapshot(readSessionEntries(context.sessionFile)).data.goal.status, "active");
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("an in-flight run still reports its terminal update while disabled", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-workdir-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const gateDir = mkdtempSync(join(tmpdir(), "pi-goal-gate-"));
	const gate = join(gateDir, "release.json");
	const first = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "Kickoff answer." }, { text: "First continuation answer." }, { hang: true }], first);
	let sessionFile;
	try {
		await first.prompt(`/goal ${OBJECTIVE}`);
		await abortActiveLoop(first, 3);
		sessionFile = await first.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	// The provider request that carries the terminal update is held open, so the
	// extension is disabled while that request is genuinely in flight.
	const second = await PiRpcSession.start({ sessionFile, cwd: workDir, settings: { goal: { enabled: false } } });
	script(
		[
			{
				waitForFile: gate,
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 40, output: 10 },
			},
			{ text: "Reported completion.", usage: { input: 10, output: 5 } },
		],
		second,
	);
	try {
		await second.prompt("Please finish the objective");
		await second.waitFor("the in-flight run started", (records) =>
			records.some((r) => r.type === "turn_start") ? true : undefined,
		);
		// Nothing was aborted while the request was in flight.
		assert.equal(second.records.filter((r) => r.type === "agent_settled").length, 0, "the run is still in flight");
		writeFileSync(gate, "", "utf8");

		const completion = await second.waitForToolResult("update_goal", 1);
		assert.equal(completion.isError, false, "a terminal update from in-flight work still works while disabled");
		assert.equal(structuredGoal(completion.result).status, "complete");
		// The result carries the disabled condition, and it must not imply that
		// re-enabling makes `/goal:resume` work: a complete Goal is terminal for its
		// identity, so replacing it is a new Goal.
		assert.match(toolText(completion.result), /pi-goal is disabled \(goal\.enabled is false\)/);
		assert.match(toolText(completion.result), /a complete Goal is terminal either way/);
		assert.match(toolText(completion.result), /not a resume/);
		assert.ok(
			!/no \/goal:resume/.test(toolText(completion.result)),
			`the completion promises a resume it can never have: ${toolText(completion.result)}`,
		);
		await second.waitForSettled(1);

		const entries = readSessionEntries(sessionFile);
		assert.equal(continuationEntries(entries).length, 2, "nothing continued after the completion");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(runCount(second), 1, "the single run that reported completion");
		assertStepsConsumed(second, 2);
		assertCleanRun(second);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(gateDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("an in-flight provider usage-limit stop still lands while disabled", async () => {
	// Retries are off so the failure reaches the settlement boundary as it is: with
	// retries on, a retryable error would consume the next scripted step.
	const context = await activeGoalSession({ goal: { enabled: false }, retry: { enabled: false } });
	script([{ error: "insufficient_quota: current quota exhausted" }], context.session);
	try {
		const mark = context.session.records.length;
		await context.session.prompt("Please keep working on the objective");
		await context.session.waitForSettled(1);
		// The terminal stop is a lifecycle write, not admission: it still lands.
		const limited = await context.session.notifyAfter(mark, (r) => r.message.includes("is now usage_limited"));
		assert.match(limited.message, /insufficient_quota/);
		// The stop keeps its own text, but it names the admission condition instead of
		// promising a resume the disabled extension refuses.
		assert.match(limited.message, /\/goal:resume restarts it once the limit is resolved/);
		assert.match(limited.message, /so that resume is refused until the setting is re-enabled/);
		assert.match(limited.message, /never continues on its own/);

		const entries = readSessionEntries(context.sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "usage_limited", "the stop is durable");
		assert.equal(continuationEntries(entries).length, 2, "and nothing was admitted after it");
		assert.equal(runCount(context.session), 1, "the single in-flight run that reported the limit");
		assertStepsConsumed(context.session, 1, [
			{ stopReason: "error", errorMessage: "insufficient_quota: current quota exhausted" },
		]);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("an in-flight update_goal pause still lands while disabled", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	script(
		[
			{ toolCalls: [{ name: "update_goal", args: { action: "pause", userRequest: "Please pause the goal" } }] },
			{ text: "Paused as requested." },
		],
		context.session,
	);
	try {
		await context.session.prompt("Please pause the goal");
		const paused = await context.session.waitForToolResult("update_goal", 1);
		assert.equal(paused.isError, false, "a pause from in-flight work still works while disabled");
		assert.equal(structuredGoal(paused.result).status, "paused");
		// The result carries the disabled condition, so the model cannot read the
		// pause as a stop it may lift with a resume of its own.
		assert.match(toolText(paused.result), /pi-goal is disabled \(goal\.enabled is false\)/);
		assert.match(toolText(paused.result), /no new Goal work is admitted/);
		await context.session.waitForSettled(1);

		const entries = readSessionEntries(context.sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "paused", "the pause is durable");
		assert.equal(continuationEntries(entries).length, 2, "nothing continued after the pause");
		assert.equal(runCount(context.session), 1, "the single in-flight run that paused it");
		assertStepsConsumed(context.session, 2);
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("an in-flight blocked report still lands while disabled", async () => {
	const context = await activeGoalSession({ goal: { enabled: false } });
	const BLOCKER = "the release token has not been issued yet";
	script(
		[
			{ toolCalls: [{ name: "update_goal", args: { action: "blocked", blocker: BLOCKER } }] },
			{ text: "Reported the blocker." },
		],
		context.session,
	);
	try {
		// The blocker audit is a lifecycle write, not an admission decision, so the
		// report from this in-flight run is still recorded: it opens the durable audit
		// and publishes the identity the next report has to reuse.
		//
		// The threshold itself is not reachable here, and that is admission working as
		// designed: every user prompt resets the audit, so the three consecutive
		// reports have to come from Goal-owned turns, which a disabled extension never
		// starts. What is reachable while disabled is the write, and it must land.
		await context.session.prompt("Please report the blocker that is still preventing progress");
		const report = await context.session.waitForToolResult("update_goal", 1);
		const state = structuredGoal(report.result);
		assert.equal(report.isError, true, "a lone report is recorded, not acted on");
		assert.equal(state.status, "active", "the report does not stop the Goal by itself");
		assert.match(state.blockerId, /^blocker_[0-9a-f]{8}$/, "the durable audit was opened");
		assert.equal(state.blocker, BLOCKER);
		assert.equal(state.blockedTurns, 1);
		// The result carries the disabled condition, so "stays active" is not read as
		// "keeps continuing".
		assert.match(toolText(report.result), /pi-goal is disabled \(goal\.enabled is false\)/);
		assert.match(toolText(report.result), /no new Goal work is admitted/);
		await context.session.waitForSettled(1);

		const entries = readSessionEntries(context.sessionFile);
		const recorded = lastGoalSnapshot(entries).data.goal.blockedAudit;
		assert.equal(recorded.blockerId, state.blockerId, "the audit is durable");
		assert.equal(recorded.turns, 1);
		assert.equal(lastGoalSnapshot(entries).data.goal.revision, 1, "the reported audit step is its own revision");
		assert.equal(continuationEntries(entries).length, 2, "no turn was continued by admission");
		assert.equal(runCount(context.session), 1, "the single in-flight run that reported it");
		assertStepsConsumed(context.session, 2);
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("an in-flight budget crossing still stops the Goal while disabled", async () => {
	// The Goal is created with a budget, so the restored Goal can cross it in flight.
	const context = await activeGoalSession(
		{ goal: { enabled: false } },
		`/goal --budget 300 ${OBJECTIVE}`,
	);
	// A Goal-owned run can only be in flight while admission is off if it was admitted
	// before the setting was disabled: the disabled runtime starts none of its own.
	// Delivery is the seam that charges it (`applyDeliveredUserMessage` admits a work
	// message that names the current Goal), so the test delivers the exact continuation
	// header the extension writes for the restored Goal — the observable equivalent of
	// a continuation already queued when the setting changed.
	const restored = lastGoalSnapshot(readSessionEntries(context.sessionFile)).data.goal;
	const workMessage = `[pi-goal] Continue Goal ${restored.id} (active, revision ${restored.revision}).`;
	// The runs before the restart accounted well under 300 tokens; this single
	// in-flight run adds 350 and crosses the ceiling mid-run.
	script(
		[{ text: "In-flight answer.", usage: { input: 250, output: 100 } }, { text: "Never requested." }],
		context.session,
	);
	try {
		const mark = context.session.records.length;
		await context.session.prompt(workMessage);
		const limited = await context.session.notifyAfter(mark, (r) => r.message.includes("reached its token budget"));
		assert.match(limited.message, /is now budget_limited/);
		// The wrap-up is unattended Goal work, so it is deferred rather than admitted.
		assert.match(limited.message, /the one bounded wrap-up is deferred/);
		const deferred = await context.session.notifyAfter(mark, (r) => /wrap-up stays pending/.test(r.message));
		assert.match(deferred.message, /budget_limited with its one bounded wrap-up still owed/);
		await context.session.waitForSettled(1);

		const entries = readSessionEntries(context.sessionFile);
		const stopped = lastGoalSnapshot(entries).data.goal;
		assert.equal(stopped.status, "budget_limited", "the budget stop landed from in-flight work");
		assert.equal(stopped.wrapUpPending, true, "and the one bounded wrap-up still owes delivery");
		assert.equal(wrapUpEntries(entries).length, 0, "it was not delivered while disabled");
		assert.equal(continuationEntries(entries).length, 2, "nothing was admitted after the stop");
		assert.equal(runCount(context.session), 1, "the single in-flight Goal-owned run");
		assertStepsConsumed(context.session, 1);
		assertCleanRun(context.session);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopShared(context);
	}
});

test("work queued while disabled is delivered as ordinary work and admits nothing", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-workdir-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const gateDir = mkdtempSync(join(tmpdir(), "pi-goal-gate-"));
	const gate = join(gateDir, "release.json");
	const first = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "Kickoff answer." }, { text: "First continuation answer." }, { hang: true }], first);
	let sessionFile;
	try {
		await first.prompt(`/goal ${OBJECTIVE}`);
		await abortActiveLoop(first, 3);
		sessionFile = await first.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	const second = await PiRpcSession.start({ sessionFile, cwd: workDir, settings: { goal: { enabled: false } } });
	// Distinctive usage per run, so the assertion can tell what was and was not
	// admitted: 550 tokens for the in-flight run and 900 for the queued one.
	script(
		[
			{ waitForFile: gate, text: "In-flight answer.", usage: { input: 500, output: 50 } },
			{ text: "Queued answer.", usage: { input: 700, output: 200 } },
		],
		second,
	);
	try {
		// The restored baseline, read from the status line the extension publishes
		// at session start before any prompt can close the admission segment.
		const restored = await second.waitFor("the restored status line", (records) =>
			records.find(
				(r) => r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "goal",
			),
		);
		const baseline = Number(/(\d+) tok/.exec(restored.statusText)[1]);

		await second.prompt("Please review the objective");
		await second.waitFor("the in-flight run started", (records) =>
			records.some((r) => r.type === "turn_start") ? true : undefined,
		);
		// A queued follow-up is a user action, delivered after the in-flight work.
		await second.followUp("Also check the migration notes");
		writeFileSync(gate, "", "utf8");

		await second.waitForSettled(1);
		// Give the settlement a chance to ask for a continuation it must not
		// request, so the assertion below is not merely early.
		await sleep(300);

		const entries = readSessionEntries(sessionFile);
		assert.equal(continuationEntries(entries).length, 2, "no continuation was admitted for queued work");
		// Pi delivers a queued follow-up as another turn of the same run, so the
		// whole session is one run — and it is the only run.
		assert.equal(runCount(second), 1, "the in-flight run, with the queued turn inside it");
		// Neither run is Goal-owned: the prompt that started the first one already
		// closed the admission segment, and the queued follow-up is an ordinary user
		// action. So the 550 + 900 tokens both runs reported are not Goal usage.
		const charged = await liveUsage(second);
		assert.equal(charged, baseline, `nothing was admitted to the Goal (${charged} of ${baseline})`);
		assertCleanRun(second);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await second.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(gateDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("re-enabling restores admission at Pi's normal settlement seam", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-workdir-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	const first = await PiRpcSession.start({ cwd: workDir });
	script([{ text: "Kickoff answer." }, { text: "First continuation answer." }, { hang: true }], first);
	let sessionFile;
	try {
		await first.prompt(`/goal ${OBJECTIVE}`);
		await abortActiveLoop(first, 3);
		sessionFile = await first.sessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	// Disabled: the restored active Goal admits nothing.
	const disabled = await PiRpcSession.start({ sessionFile, cwd: workDir, settings: { goal: { enabled: false } } });
	script([{ text: "Working while disabled." }], disabled);
	try {
		await disabled.prompt("Please keep working on the objective");
		await disabled.waitForSettled(1);
		assert.equal(runCount(disabled), 1, "the prompt run and nothing else");
		assert.equal(continuationEntries(readSessionEntries(sessionFile)).length, 2, "no new continuation");
		assertCleanRun(disabled);
	} finally {
		await disabled.stop();
	}

	// Re-enabled: the same restored active Goal continues at the next settlement.
	const enabled = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Working again." }, { hang: true }], enabled);
	try {
		await enabled.prompt("Please keep working on the objective");
		await abortActiveLoop(enabled, 2);
		const entries = readSessionEntries(sessionFile);
		assert.equal(continuationEntries(entries).length, 3, "re-enabling admits the continuation again");
		assert.equal(runCount(enabled), 2, "the prompt run plus exactly one continuation run");
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active");
		assertOnlyFailures(enabled, [{ stopReason: "aborted" }]);
	} finally {
		await enabled.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a pending budget wrap-up is deferred while disabled and delivered after re-enabling", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-work-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
	const resumedDir = mkdtempSync(join(tmpdir(), "pi-goal-resumed-"));
	// Process 1 crosses the budget and then fails its provider request, which is
	// the one way a wrap-up stays owed: it is delivered only after a *completed*
	// run, and an errored run is a hard exit.
	const first = await PiRpcSession.start({
		cwd: workDir,
		sessionDir,
		extraExtensions: [NESTED_EXTENSION],
		settings: { retry: { enabled: false } },
	});
	script(
		[
			// 260 accounted tokens on the model call, then 50 nested tokens on the
			// tool result: 310 against a 300-token budget.
			{ toolCalls: [{ name: NESTED_OUTER_TOOL, args: {} }], usage: { input: 250, output: 10 } },
			{ error: "provider exploded" },
		],
		first,
	);
	let sessionFile;
	try {
		await first.prompt(`/goal --budget 300 ${OBJECTIVE}`);
		const exhausted = await first.waitForNotify((r) => r.message.includes("now budget_limited"));
		assert.match(exhausted.message, /Budget exhaustion is not completion/);
		await first.waitForSettled(1);

		sessionFile = first.findSessionFile();
		copyFileSync(sessionFile, join(resumedDir, basename(sessionFile)));
		const owed = lastGoalSnapshot(readSessionEntries(sessionFile));
		assert.equal(owed.data.goal.status, "budget_limited");
		assert.equal(owed.data.goal.wrapUpPending, true, "the wrap-up is still owed");
		assert.equal(wrapUpEntries(readSessionEntries(sessionFile)).length, 0);
		assertOnlyFailures(first, [{ stopReason: "error", errorMessage: "provider exploded" }]);
	} finally {
		await first.stop();
	}
	sessionFile = join(resumedDir, basename(sessionFile));

	// Disabled: the owed wrap-up is unattended Goal work, so it is deferred rather
	// than delivered — and it is not lost.
	const second = await PiRpcSession.start({ sessionFile, cwd: workDir, settings: { goal: { enabled: false } } });
	script([{ text: "Working while disabled." }, { text: "Never requested." }], second);
	try {
		const mark = second.records.length;
		await second.prompt("Please keep working on the objective");
		await second.waitForSettled(1);
		const deferred = await second.notifyAfter(mark, (r) => /wrap-up stays pending/.test(r.message));
		assert.match(deferred.message, /budget_limited with its one bounded wrap-up still owed/);
		assert.match(deferred.message, /delivered at the first settlement after the setting is re-enabled/);

		const entries = readSessionEntries(sessionFile);
		assert.equal(wrapUpEntries(entries).length, 0, "the wrap-up was not delivered while disabled");
		assert.equal(runCount(second), 1, "no wrap-up run was started");
		assertStepsConsumed(second, 1);
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, true, "it stays owed");
		assertCleanRun(second);
	} finally {
		await second.stop();
	}

	// Re-enabled: the still-pending wrap-up is delivered at the next settlement.
	const third = await PiRpcSession.start({ sessionFile, cwd: workDir });
	script([{ text: "Working again." }, { text: "Wrap-up summary." }], third);
	try {
		await third.prompt("Please keep working on the objective");
		await third.waitForSettled(1);
		const entries = readSessionEntries(sessionFile);
		assert.equal(wrapUpEntries(entries).length, 1, "the deferred wrap-up is delivered exactly once");
		assert.equal(runCount(third), 2, "the prompt run plus exactly one wrap-up run");
		assertStepsConsumed(third, 2);
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "budget_limited");
		assert.equal(lastGoalSnapshot(entries).data.goal.wrapUpPending, false);
		assertCleanRun(third);
	} finally {
		await third.stop();
		rmSync(resumedDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	}
});
