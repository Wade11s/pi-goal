/**
 * Issue #52: opt-in session naming from the Objective.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded and a scripted provider, and asserts public behavior only: the session
 * name Pi reports (`get_state`), the durable `session_info` entry in the session
 * file, extension notifications, and the Goal snapshots that prove a lifecycle
 * transition really happened.
 *
 * The naming is a convenience layered on top of a creation that already
 * succeeded, so the interesting cases are all about what it must *not* do: it
 * must not run by default, must not overwrite a name the user typed, must not
 * rename on an edit or a replacement, and must not leave a name behind when the
 * creation it belonged to was rolled back.
 *
 * Attachments do not exist on this branch yet (issue #49), so the Objective text
 * is the only source a name can come from. The rule is nevertheless pinned from
 * both sides: the pure derivation takes a single string and has no attachment
 * input at all, and the multi-line cases prove that only the Objective's first
 * line can ever reach a name. When #49 lands, the derivation must stay
 * attachment-agnostic rather than gaining a filter.
 *
 * The honesty rules are the rest of the suite's: every script is sized exactly,
 * and every test ends with `assertCleanRun()` (or `assertOnlyFailures()` when an
 * abort is the subject), so a green result can only come from the Goal lifecycle
 * and never from a scripted-provider error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assertStepsConsumed,
	goalSnapshots,
	lastGoalSnapshot,
	readSessionEntries,
	script,
	submitCommand,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";
import {
	MAX_SESSION_NAME_LENGTH,
	applySessionNameFromGoal,
	deriveSessionName,
	parseSessionNamingSettings,
} from "../src/session-naming.ts";

const OBJECTIVE = "Ship the release notes page";
const REQUEST = "Please create a Goal for the release";
const EDITED_OBJECTIVE = "Ship the migration notes page instead";
const REPLACEMENT_OBJECTIVE = "Rewrite the release notes page from scratch";
/** The opt-in, spelled the way a user configures it in Pi settings. */
const NAMING_ON = { goal: { sessionNameFromObjective: true } };

/** Every `session_info` entry in append order. */
function sessionInfoEntries(entries) {
	return entries.filter((e) => e.type === "session_info");
}

/** The durable session name: the newest `session_info` entry's name, or undefined. */
function durableSessionName(entries) {
	const infos = sessionInfoEntries(entries);
	const name = infos.length ? infos.at(-1).name : undefined;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** The live session name Pi reports, which is what a session selector reads. */
async function liveSessionName(session) {
	return (await session.getState()).sessionName;
}

/** A fake of the two Pi seams, for the pure naming rules. */
function fakeSession(name = undefined) {
	const state = { name, calls: [] };
	return {
		state,
		getSessionName: () => state.name,
		setSessionName: (next) => {
			state.calls.push(next);
			state.name = next;
		},
	};
}

// ---------------------------------------------------------------------------
// Pure configuration and derivation rules
// ---------------------------------------------------------------------------

test("the setting defaults to off and tolerates absence", () => {
	const off = { nameFromObjective: false, problems: [] };
	assert.deepEqual(parseSessionNamingSettings(undefined), off);
	assert.deepEqual(parseSessionNamingSettings({}), off);
	assert.deepEqual(parseSessionNamingSettings({ goal: {} }), off);
	assert.deepEqual(parseSessionNamingSettings({ goal: { sessionNameFromObjective: false } }), off);
	assert.deepEqual(parseSessionNamingSettings({ goal: { sessionNameFromObjective: true } }), {
		nameFromObjective: true,
		problems: [],
	});
});

test("a malformed setting is reported and falls back to the off default", () => {
	for (const value of ["false", "true", 0, 1, null, [], {}]) {
		const settings = parseSessionNamingSettings({ goal: { sessionNameFromObjective: value } });
		assert.equal(settings.nameFromObjective, false, `${JSON.stringify(value)} must not silently opt in`);
		assert.equal(settings.problems.length, 1, `${JSON.stringify(value)} must be reported`);
		assert.match(settings.problems[0], /goal\.sessionNameFromObjective must be a boolean/);
	}
	// The settings are read independently, so a broken budget or admission value
	// neither opts the session in nor out.
	assert.deepEqual(
		parseSessionNamingSettings({ goal: { enabled: "yes", maxTokenBudget: -5, sessionNameFromObjective: true } }),
		{ nameFromObjective: true, problems: [] },
	);
});

test("the derived name takes the first line and collapses whitespace", () => {
	assert.equal(deriveSessionName("Ship the release notes page"), "Ship the release notes page");
	assert.equal(deriveSessionName("  Ship   the \t release   notes   page  "), "Ship the release notes page");
	// Only the first line contributes: a multi-line Objective is never run on.
	assert.equal(
		deriveSessionName("Ship the release notes page\nsecond line\nthird line"),
		"Ship the release notes page",
	);
	assert.equal(deriveSessionName("Ship\r\nthe release notes page"), "Ship");
	assert.equal(deriveSessionName("Ship\rthe release notes page"), "Ship");
});

test("the derived name is capped at 80 characters", () => {
	assert.equal(MAX_SESSION_NAME_LENGTH, 80);
	const long = `Ship ${"the release notes page ".repeat(20)}`;
	const name = deriveSessionName(long);
	assert.equal(name.length, 80, `expected exactly 80 characters, got ${name.length}`);
	assert.equal(name, long.slice(0, 80));
	// No ellipsis: a session name is a label, so a predictable width matters more
	// than signalling that text was dropped, and the Objective stays authoritative.
	assert.ok(!name.includes("..."));
	// Exactly at the cap is kept whole.
	const exact = "x".repeat(80);
	assert.equal(deriveSessionName(exact), exact);
	assert.equal(deriveSessionName(`${exact} tail`), exact);
	// A truncation that would end on whitespace is trimmed instead.
	assert.equal(deriveSessionName(`${"y".repeat(79)} tail`), "y".repeat(79));
});

test("the cap counts code points, so an emoji is never split in half", () => {
	// 79 ASCII characters place the truncation point exactly on a surrogate pair, so
	// a UTF-16 slice would keep the high surrogate and drop the low one: a lone
	// surrogate persisted verbatim into the session file.
	const name = deriveSessionName(`${'x'.repeat(79)}🚀 launch notes`);
	assert.equal(name, `${'x'.repeat(79)}🚀`, "the whole emoji is kept");
	assert.equal(Array.from(name).length, 80, `expected 80 code points, got ${Array.from(name).length}`);
	assert.equal(Array.from(name).at(-1), "🚀", "the name must not end in a lone surrogate");
	assert.ok(name.isWellFormed(), "a name stored in the session file must be well-formed UTF-16");

	// An emoji just past the cap is dropped whole rather than half-kept.
	const justOver = deriveSessionName(`${'x'.repeat(80)}🚀 launch notes`);
	assert.equal(justOver, "x".repeat(80));
	assert.ok(justOver.isWellFormed());
});

test("an astral-heavy objective keeps 80 code points, not 40", () => {
	// Each rocket is two UTF-16 code units, so a code-unit cap would stop at 40 real
	// characters and silently halve the width the limit promises.
	const rockets = "🚀".repeat(100);
	const name = deriveSessionName(`${rockets} launch notes`);
	assert.equal(name, "🚀".repeat(80));
	assert.equal(Array.from(name).length, 80, `expected 80 code points, got ${Array.from(name).length}`);
	assert.equal(name.length, 160, "80 astral code points are 160 UTF-16 code units");
	assert.ok(name.isWellFormed());
	// 80 ASCII characters are still 80 code points, so both rules agree there.
	assert.equal(deriveSessionName("x".repeat(200)), "x".repeat(80));
});

test("an Objective with no usable text yields no name", () => {
	assert.equal(deriveSessionName(""), "");
	assert.equal(deriveSessionName("   "), "");
	assert.equal(deriveSessionName("\n\nsecond line"), "");
});

test("an opted-out session is not even read", () => {
	const session = fakeSession("A name the user typed");
	assert.deepEqual(applySessionNameFromGoal(session, { objective: OBJECTIVE }, false), { kind: "off" });
	assert.deepEqual(session.state.calls, [], "no write was attempted");
	assert.equal(session.state.name, "A name the user typed");
});

test("an existing name is never overwritten, whoever wrote it", () => {
	for (const existing of ["My own title", "Ship the release notes page"]) {
		const session = fakeSession(existing);
		assert.deepEqual(applySessionNameFromGoal(session, { objective: "A completely different objective" }, true), {
			kind: "already-named",
			name: existing,
		});
		assert.deepEqual(session.state.calls, [], "no write was attempted");
	}
	// A whitespace-only name is not a name, so it does not block a real one.
	const blank = fakeSession("   ");
	assert.deepEqual(applySessionNameFromGoal(blank, { objective: OBJECTIVE }, true), { kind: "named", name: OBJECTIVE });
	assert.deepEqual(blank.state.calls, [OBJECTIVE]);
});

test("the write is reported as a failure instead of being mistaken for a naming", () => {
	const session = fakeSession();
	session.setSessionName = () => {
		throw new Error("disk full");
	};
	assert.deepEqual(applySessionNameFromGoal(session, { objective: OBJECTIVE }, true), {
		kind: "failed",
		reason: "disk full",
	});
	// A read failure is reported the same way rather than guessing at a name.
	const unreadable = fakeSession();
	unreadable.getSessionName = () => {
		throw new Error("session file unreadable");
	};
	assert.equal(applySessionNameFromGoal(unreadable, { objective: OBJECTIVE }, true).kind, "failed");
});

// ---------------------------------------------------------------------------
// The default: pi-goal never touches the session name
// ---------------------------------------------------------------------------

test("the default setting leaves an unnamed session unnamed", async () => {
	const session = await PiRpcSession.start();
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		const created = await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.match(created.message, /^Goal goal_[0-9a-f]+ created and activated/);

		// The Goal exists and works; the session name is still Pi's own business.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, OBJECTIVE);
		assert.equal(await liveSessionName(session), undefined, "the default never names the session");
		assert.equal(durableSessionName(entries), undefined, "and writes no session_info entry");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

// ---------------------------------------------------------------------------
// Opting in
// ---------------------------------------------------------------------------

test("the opt-in names an unnamed session from the Objective", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The name is live (a session selector reads it) and durable (a `session_info`
		// entry a restart replays), and it is the Objective verbatim.
		assert.equal(await liveSessionName(session), OBJECTIVE);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(durableSessionName(entries), OBJECTIVE);
		assert.equal(sessionInfoEntries(entries).length, 1, "exactly one name was written");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("create_goal names the session too, after its durable commit", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	script(
		[
			{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: REQUEST } }] },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(REQUEST);
		const result = await session.waitForToolResult("create_goal", 1);
		assert.equal(result.isError, false, JSON.stringify(result.result));
		assert.equal(result.result.structuredContent?.goal?.origin, "tool");

		assert.equal(await liveSessionName(session), OBJECTIVE);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(durableSessionName(entries), OBJECTIVE);
		assert.equal(goalSnapshots(entries).length, 1, "the creation is durable");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a name the user provided is never overwritten", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	const userNamed = "Release work, my own title";
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		// The user (or a host) names the session first, through Pi's own seam.
		await session.setSessionName(userNamed);
		assert.equal(await liveSessionName(session), userNamed);

		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		assert.equal(await liveSessionName(session), userNamed, "a user-provided name survives the creation");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(durableSessionName(entries), userNamed);
		assert.equal(sessionInfoEntries(entries).length, 1, "no second name was written");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

// ---------------------------------------------------------------------------
// Sanitization and length, through real Pi
// ---------------------------------------------------------------------------

test("the name is sanitized: first line only, whitespace collapsed", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	const objective = `Ship   the release notes\tpage\nsecond line that must never reach a name`;
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		const response = await session.prompt(`/goal ${objective}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		// The Objective is stored verbatim; the name is its first line, collapsed.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.objective, objective.trim());
		assert.equal(await liveSessionName(session), "Ship the release notes page");
		assert.equal(durableSessionName(entries), "Ship the release notes page");
		assert.ok(!(await liveSessionName(session)).includes("second line"), "no later line contributes");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("the name is capped at 80 characters in the session itself", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	const objective = `Ship the release notes page ${"and every remaining migration task ".repeat(8)}`;
	assert.ok(objective.length > 200, "the objective must be long enough to need the cap");
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		const response = await session.prompt(`/goal ${objective}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(
			lastGoalSnapshot(entries).data.goal.objective,
			objective.trim(),
			"the Objective is not truncated",
		);
		const name = await liveSessionName(session);
		assert.equal(name.length, 80, `expected exactly 80 characters, got ${name.length}`);
		assert.equal(name, objective.slice(0, 80));
		assert.equal(durableSessionName(entries), name);

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

// ---------------------------------------------------------------------------
// What never renames
// ---------------------------------------------------------------------------

test("an Objective edit never renames the session", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.equal(await liveSessionName(session), OBJECTIVE);

		// Hold the first Continuation open, so the edit has a live run to steer into
		// — the edit path that would be most tempted to re-announce the session.
		await session.waitFor("the continuation run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 2 ? true : undefined,
		);
		const mark = session.records.length;
		const edit = await session.prompt(`/goal:edit ${EDITED_OBJECTIVE}`);
		assert.equal(edit.data.disposition, "handled");
		const notice = await session.notifyAfter(mark, (r) => r.message.includes("objective updated"));
		assert.match(notice.message, /revision 1/);

		// The edit really happened: same identity, new objective, new revision.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries).data.goal;
		assert.equal(snapshot.objective, EDITED_OBJECTIVE);
		assert.equal(snapshot.revision, 1);
		assert.equal(await liveSessionName(session), OBJECTIVE, "an edit never renames the session");
		assert.equal(durableSessionName(entries), OBJECTIVE);

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a Replacement Goal never renames the session", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	// The first Goal completes in its own run, so the replacement supersedes a
	// *complete* Goal — the only replacement the single-Goal rule still allows.
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
			{ text: "Replacement kickoff." },
			{ hang: true },
		],
		session,
	);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		assert.equal(await liveSessionName(session), OBJECTIVE);
		await session.waitForSettled(1);
		assert.equal(
			lastGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal.status,
			"complete",
			"the first Goal finished before the replacement",
		);

		const mark = session.records.length;
		const replacePromise = session.prompt(`/goal ${REPLACEMENT_OBJECTIVE}`);
		assert.equal((await replacePromise).data.disposition, "handled");
		const replaced = await session.notifyAfter(mark, (r) => r.message.includes("created and activated, replacing"));
		assert.match(replaced.message, /created and activated, replacing goal_[0-9a-f]+/);
		assert.equal(
			session.records.filter((r) => r.type === "extension_ui_request" && r.method === "confirm").length,
			0,
			"a complete Goal never asks for a replacement confirmation",
		);

		// The replacement really happened: a new identity at revision 0.
		const entries = readSessionEntries(await session.sessionFile());
		const snapshot = lastGoalSnapshot(entries).data.goal;
		assert.equal(snapshot.objective, REPLACEMENT_OBJECTIVE);
		assert.equal(snapshot.revision, 0);
		assert.equal(await liveSessionName(session), OBJECTIVE, "a replacement never renames the session");
		assert.equal(durableSessionName(entries), OBJECTIVE);
		assert.equal(sessionInfoEntries(entries).length, 1, "and writes no second name");

		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

// ---------------------------------------------------------------------------
// A creation that does not stand names nothing
// ---------------------------------------------------------------------------

test("a rolled-back creation never names the session", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	script([{ text: "Ordinary work continues." }], session);
	let sessionFile;
	try {
		await session.prompt("Please check the release notes");
		await session.waitForSettled(1);
		sessionFile = await session.sessionFile();

		// Make the session file unwritable so the creation's durable write fails: the
		// command rolls the Goal back, which is the one way a real creation fails
		// after it has already been validated, staged, and confirmed.
		chmodSync(sessionFile, 0o400);
		let rolledBack;
		try {
			const response = await session.prompt(`/goal ${OBJECTIVE}`);
			assert.equal(response.data.disposition, "handled");
			rolledBack = await session.waitForNotify((r) => r.message.includes("Goal not created:"));
		} finally {
			chmodSync(sessionFile, 0o644);
		}
		assert.match(rolledBack.message, /writing the Goal to the session failed/);

		// The rollback is total: no Goal, and no name — a failed creation leaves no
		// metadata behind either.
		const entries = readSessionEntries(sessionFile);
		assert.equal(goalSnapshots(entries).length, 0, "no Goal snapshot was stored");
		assert.equal(await liveSessionName(session), undefined, "a rolled-back creation never names the session");
		assert.equal(durableSessionName(entries), undefined, "and writes no session_info entry");

		assertStepsConsumed(session, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		if (sessionFile) chmodSync(sessionFile, 0o644);
		await session.stop();
	}
});

/**
 * A creation whose Goal was committed and then removed before the command could
 * announce it.
 *
 * This is the one post-commit failure a writable session can reach: the /goal
 * command commits the snapshot, waits for the current run to finish, and a
 * `/goal:clear` that lands during that wait removes the Goal it created. The
 * command reports that instead of claiming success, so the naming — which belongs
 * to a creation that stands — must not happen either.
 */
test("a creation cleared while it waited never names the session", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON });
	script([{ hang: true }], session);
	try {
		// Hold an ordinary run open, so the fresh creation below has to wait for idle.
		await session.prompt("Please hold this run open");
		await session.waitFor("the held run started", (records) =>
			records.some((r) => r.type === "agent_start") ? true : undefined,
		);

		// The creation commits durably and then blocks on the wait.
		const createPromise = session.prompt(`/goal ${OBJECTIVE}`);
		await waitForSnapshot(session, (snapshot) => snapshot?.data?.goal?.objective === OBJECTIVE, "the creation commit");

		// Clear the Goal while the creation is still waiting, then release the run so
		// the wait ends and the command sees what happened.
		const clearPromise = submitCommand(session, "req-clear-while-waiting", "/goal:clear");
		await session.sendSimple("abort");
		await session.waitForSettled(1);
		assert.equal((await createPromise).data.disposition, "handled");
		assert.equal((await clearPromise).data.disposition, "handled");

		const cleared = await session.waitForNotify((r) =>
			r.message.includes("was not started: it was cleared while creation waited"),
		);
		assert.match(cleared.message, /Goal goal_[0-9a-f]+ was not started: it was cleared while creation waited/);

		// The Goal is gone and the session was never named.
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "the tombstone is the newest snapshot");
		assert.equal(await liveSessionName(session), undefined, "a creation that did not stand names nothing");
		assert.equal(durableSessionName(entries), undefined, "and writes no session_info entry");

		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a refused creation in an ephemeral session names nothing", async () => {
	const session = await PiRpcSession.start({ settings: NAMING_ON, noSession: true });
	script([{ text: "should never run" }], session);
	try {
		const response = await session.prompt(`/goal ${OBJECTIVE}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((r) => r.message.includes("Goal not created:"));
		assert.match(refusal.message, /not persistent/);

		// Nothing ran, so nothing was named: a refused creation is not a creation.
		assert.equal(session.records.filter((r) => r.type === "agent_start").length, 0, "no run was started");
		assert.equal(await liveSessionName(session), undefined, "a refused creation names nothing");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
