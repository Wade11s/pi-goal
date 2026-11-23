/**
 * Issue #82: the optional Goal title, through a real `pi --mode rpc` session.
 *
 * Every test loads pi-goal in a spawned Pi with the scripted provider and asserts
 * public behavior only: extension notifications, durable `goal-state` snapshots,
 * the `get_goal`/`update_goal` structured payloads, the durable `session_info`
 * name, and the `goal-history`, `goal-events-log`, and `goal-metrics-log` entries
 * written by the extension. The title is persisted Goal state, so the snapshot is
 * where its presence is proved; the derived surfaces (events, history, metrics)
 * are where its *absence* is proved, because the title follows the Objective's
 * privacy boundary.
 *
 * The seam that makes the privacy assertions direct rather than inferred is the
 * real peer extensions: `events-peer.ts` records every public `pi-goal:updated`
 * event as a durable entry, and `metrics-peer.ts` does the same for the
 * `pi-goal:metrics` projection. Both are read back from the session file, so a
 * title text that leaked into either would fail the test.
 *
 * The honesty rules are the suite's: every script is sized exactly (a held
 * continuation is consumed by an explicit abort, which is asserted), and every
 * test ends with `assertCleanRun()`, so a green result can only come from the
 * Goal lifecycle and never from a scripted-provider error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	goalSnapshots,
	readSessionEntries,
	runCount,
	script,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Ship the release notes page";
const EDITED_OBJECTIVE = "Ship the migration notes page instead";
const TITLE = "Bluebird launch";
const LONG_TITLE = "t".repeat(81);
const EVENTS_PEER = new URL("./extensions/events-peer.ts", import.meta.url).pathname;
const METRICS_PEER = new URL("./extensions/metrics-peer.ts", import.meta.url).pathname;
const EVENTS_LOG_TYPE = "goal-events-log";
const METRICS_LOG_TYPE = "goal-metrics-log";
const HISTORY_ENTRY_TYPE = "goal-history";
const NAMING_ON = { goal: { sessionNameFromObjective: true } };

/** Start a session whose peers record the public event and metrics surfaces. */
function startTitleSession(options = {}) {
	return PiRpcSession.start({
		...options,
		extraExtensions: [EVENTS_PEER, METRICS_PEER, ...(options.extraExtensions ?? [])],
	});
}

/** Every `goal-state` snapshot in append order. */
function snapshots(entries) {
	return goalSnapshots(entries);
}

/** The newest current snapshot's Goal record. */
function currentGoal(entries) {
	const all = snapshots(entries);
	return all[all.length - 1]?.data.goal;
}

/** Every durable entry on one custom channel. */
function customEntries(entries, customType) {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

/** Every `session_info` entry in append order. */
function sessionInfoEntries(entries) {
	return entries.filter((entry) => entry.type === "session_info");
}

/** The durable session name: the newest `session_info` entry's name, if any. */
function durableSessionName(entries) {
	const infos = sessionInfoEntries(entries);
	const name = infos.length ? infos.at(-1).name : undefined;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** Abort the hanging continuation so lifecycle commands can run from idle. */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((record) => record.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	await session.waitForSettled(1);
}

/**
 * Fail unless no derived privacy surface contains the title text.
 *
 * The durable snapshot must contain it (that is the feature), which is exactly why
 * this check is scoped to the three derived streams rather than to the whole
 * session file: an implementation that copied the label into an event, a history
 * record, or a metric would leak it here even though the snapshot legitimately
 * holds it.
 */
function assertTitleAbsentFromDerivedSurfaces(entries, title) {
	const surfaces = [
		...customEntries(entries, EVENTS_LOG_TYPE),
		...customEntries(entries, HISTORY_ENTRY_TYPE),
		...customEntries(entries, METRICS_LOG_TYPE),
	];
	assert.ok(surfaces.length > 0, "the scenario wrote derived records to inspect");
	for (const entry of surfaces) {
		const serialized = JSON.stringify(entry.data);
		assert.ok(
			!serialized.includes(title),
			`the title text must not reach a derived record: ${entry.customType}`,
		);
		// "Title text" is stronger than "no title field": a field named `title`
		// carrying anything (a length, an origin, an empty string) is still a title
		// surface, and only the snapshot owns one.
		assert.equal(/"title"\s*:/.test(serialized), false, `no title field in ${entry.customType}`);
	}
}

test("a title-only /goal:edit sets the title in place and shows it in status and structured payloads", async () => {
	const session = await startTitleSession();
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			// The automatic continuation hangs so the test can abort the loop and
			// run lifecycle commands from idle deterministically.
			{ hang: true },
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await abortActiveLoop(session, 2);

		const created = currentGoal(readSessionEntries(await session.sessionFile()));
		assert.equal(created.title, undefined, "a /goal creation is title-less");
		assert.equal(created.revision, 0);

		// --- The edit itself: same identity, next revision, title only. ---------
		const runsBeforeEdit = runCount(session);
		await session.prompt(`/goal:edit --title "${TITLE}"`);
		const editNotice = await session.waitForNotify((record) => record.message.includes("title set to"));
		assert.match(editNotice.message, new RegExp(`"${TITLE}"`));
		assert.match(editNotice.message, /no work was started or redirected/);
		assert.equal(runCount(session), runsBeforeEdit, "a title-only edit starts no run");

		const entriesAfterEdit = readSessionEntries(await session.sessionFile());
		const edited = currentGoal(entriesAfterEdit);
		assert.equal(edited.id, created.id, "the Goal keeps its identity");
		assert.equal(edited.objective, OBJECTIVE, "--title alone changes only the title");
		assert.equal(edited.title, TITLE, "the title is durable Goal state");
		assert.equal(edited.revision, 1, "the edit is the next revision");
		assert.equal(edited.status, "active", "a label edit does not move the Lifecycle status");

		// The human status report renders the title when present.
		await session.prompt("/goal");
		const summary = await session.waitForNotify((record) => record.message.includes(`Objective: ${OBJECTIVE}`));
		assert.match(summary.message, new RegExp(`^Title: ${TITLE}$`, "m"));
		assert.ok(
			summary.message.indexOf(`Title: ${TITLE}`) < summary.message.indexOf(`Objective: ${OBJECTIVE}`),
			"the title is shown above the objective",
		);

		// --- Structured payloads: get_goal and update_goal carry the title. ------
		await session.prompt("Check the goal, then finish it.");
		const getResult = (await session.waitForToolResult("get_goal", 1)).result;
		assert.equal(getResult.structuredContent.goal.title, TITLE, "get_goal's structured payload carries the title");
		assert.equal(getResult.structuredContent.goal.objective, OBJECTIVE);
		assert.match(String(getResult.content[0].text), new RegExp(`^Title: ${TITLE}$`, "m"));

		const completeResult = (await session.waitForToolResult("update_goal", 1)).result;
		assert.equal(completeResult.structuredContent.goal.status, "complete");
		assert.equal(completeResult.structuredContent.goal.title, TITLE, "update_goal's structured payload carries it");
		await session.waitForSettled(2);
		assert.equal(currentGoal(readSessionEntries(await session.sessionFile())).title, TITLE);

		// --- Privacy: the title text never reaches a derived surface. -----------
		assertTitleAbsentFromDerivedSurfaces(readSessionEntries(await session.sessionFile()), TITLE);
		assert.deepEqual(
			customEntries(readSessionEntries(await session.sessionFile()), HISTORY_ENTRY_TYPE).map(
				(entry) => entry.data.kind,
			),
			["created", "objective-edited", "completed"],
			"the title edit committed one derived transition, without its text",
		);

		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("--title combined with an Objective changes both in one revision and starts no work", async () => {
	const session = await startTitleSession();
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await abortActiveLoop(session, 2);

		// Paused, so the combined edit rewrites durable state without admitting work
		// and the scenario needs no further provider turns.
		await session.prompt("/goal:pause");
		await session.waitForNotify((record) => record.message.includes("paused"));
		const paused = currentGoal(readSessionEntries(await session.sessionFile()));
		const runsBeforeEdit = runCount(session);

		await session.prompt(`/goal:edit --title "${TITLE}" ${EDITED_OBJECTIVE}`);
		const notice = await session.waitForNotify((record) => record.message.includes("objective updated"));
		assert.match(notice.message, /Title set to/);
		assert.equal(runCount(session), runsBeforeEdit, "editing a paused Goal starts no run");

		const edited = currentGoal(readSessionEntries(await session.sessionFile()));
		assert.equal(edited.id, paused.id, "the Goal keeps its identity");
		assert.equal(edited.title, TITLE, "the title changed");
		assert.equal(edited.objective, EDITED_OBJECTIVE, "and the objective changed in the same revision");
		assert.equal(edited.revision, paused.revision + 1, "both changes are one revision");
		assert.equal(edited.status, "paused", "the Lifecycle status is unchanged");

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("invalid titles are refused with no Goal mutation", async () => {
	const session = await startTitleSession();
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await abortActiveLoop(session, 2);

		const bytesBefore = JSON.stringify(
			customEntries(readSessionEntries(await session.sessionFile()), "goal-state"),
		);
		const historyBefore = customEntries(
			readSessionEntries(await session.sessionFile()),
			HISTORY_ENTRY_TYPE,
		).length;

		const refusals = [
			["/goal:edit --title", /--title needs a title/],
			['/goal:edit --title ""', /title must be 1 to 80 characters/],
			[`/goal:edit --title "${LONG_TITLE}"`, /title must be 1 to 80 characters/],
			// U+2028 is a line terminator to text processors but not to Pi's command
			// transport, so the title reaches validation intact and proves the one-line
			// rule. Plain newlines are covered at the unit seam, where no transport can
			// split the command.
			['/goal:edit --title "two\u2028lines"', /must be one line/],
			[`/goal:edit --title "${TITLE}" --file notes.md`, /attachment manifest/],
		];
		for (const [command, expected] of refusals) {
			const mark = session.records.length;
			await session.prompt(command);
			const notice = await session.notifyAfter(
				mark,
				(record) => record.method === "notify" && record.notifyType === "error",
			);
			assert.match(notice.message, expected, command);
		}

		// The refusals wrote nothing: the same snapshots, revisions, and history.
		const entriesAfter = readSessionEntries(await session.sessionFile());
		assert.equal(
			JSON.stringify(customEntries(entriesAfter, "goal-state")),
			bytesBefore,
			"no refused edit wrote a Goal snapshot",
		);
		assert.equal(
			customEntries(entriesAfter, HISTORY_ENTRY_TYPE).length,
			historyBefore,
			"no refused edit appended a history record",
		);
		assert.equal(currentGoal(entriesAfter).title, undefined);
		assert.equal(runCount(session), 2, "no refused edit started a run");

		// A valid title still applies afterwards, so the refusal was about the value.
		await session.prompt(`/goal:edit --title "${TITLE}"`);
		await session.waitForNotify((record) => record.message.includes("title set to"));
		assert.equal(currentGoal(readSessionEntries(await session.sessionFile())).title, TITLE);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("session naming still names a fresh creation from the Objective, and a title edit never renames", async () => {
	const session = await startTitleSession({ settings: NAMING_ON });
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		assert.equal((await session.getState()).sessionName, OBJECTIVE, "the creation names the session");
		const nameBeforeEdit = (await session.getState()).sessionName;

		await abortActiveLoop(session, 2);
		await session.prompt(`/goal:edit --title "${TITLE}"`);
		await session.waitForNotify((record) => record.message.includes("title set to"));

		// The title is durable Goal state; the session name is host metadata written
		// only for a fresh creation, so an edit never rewrites it.
		assert.equal((await session.getState()).sessionName, nameBeforeEdit, "a title edit never renames the session");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(durableSessionName(entries), OBJECTIVE, "exactly the creation's name is durable");
		assert.equal(sessionInfoEntries(entries).length, 1, "the edit appended no session_info entry");
		assert.equal(currentGoal(entries).title, TITLE);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});
