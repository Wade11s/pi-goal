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
 * Every scenario creates its Goal through the real `create_goal` tool and then
 * pauses it through the corroborated `update_goal` pause. That stops the
 * continuation loop deterministically *without* an abort, so each script runs to
 * a natural clean settle, every script is sized exactly, and every test ends with
 * `assertCleanRun()`. No held provider step is needed, which is what keeps the
 * "clean run" claim literal rather than an expected-abort exception.
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

/**
 * The human request that authorizes both creation and the model-requested pause.
 *
 * The pause instruction is its own clause on purpose: `corroboratePauseRequest`
 * reads the clause that contains the quote, so a "create a goal and pause it"
 * sentence would not qualify as an affirmative pause instruction. The quote the
 * model passes is `PAUSE_QUOTE`, a verbatim fragment of this message.
 */
const CREATE_REQUEST = "Please create a goal for the release notes page. Pause it.";
const CREATE_QUOTE = "Please create a goal for the release notes page.";
const PAUSE_QUOTE = "Pause it";

/** Provider steps for a title-less Goal that ends up paused (a clean settle, no abort). */
function createAndPauseSteps(extra = []) {
	return [
		{
			toolCalls: [
				{
					name: "create_goal",
					args: { objective: OBJECTIVE, user_request: CREATE_QUOTE },
				},
			],
		},
		{
			toolCalls: [
				{ name: "update_goal", args: { action: "pause", user_request: PAUSE_QUOTE } },
			],
		},
		{ text: "Created and paused." },
		...extra,
	];
}

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

/**
 * Create a title-less Goal through `create_goal`, then pause it through the
 * corroborated `update_goal` pause, and prove the run settled cleanly.
 *
 * The pause is the deterministic loop stop: it is durable before the run settles,
 * so the settlement asks for no continuation and the script needs no held step.
 * Returns the paused record (revision 1) for the scenario's own assertions.
 */
async function startPausedGoal(session) {
	await session.prompt(CREATE_REQUEST);
	const created = await session.waitForToolResult("create_goal", 1);
	assert.equal(created.isError, false, "the Goal was created");
	const pause = await session.waitForToolResult("update_goal", 1);
	assert.equal(pause.isError, false, "the corroborated pause was admitted");
	await session.waitForSettled(1);

	const goal = currentGoal(readSessionEntries(await session.sessionFile()));
	assert.ok(goal, "the paused Goal is durable");
	assert.equal(goal.status, "paused", "the loop stopped through a lifecycle transition, not an abort");
	assert.equal(goal.title, undefined, "a create_goal creation is title-less");
	return goal;
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
		createAndPauseSteps([
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		]),
		session,
	);
	try {
		const paused = await startPausedGoal(session);

		// --- The edit itself: same identity, next revision, title only. ---------
		const runsBeforeEdit = runCount(session);
		await session.prompt(`/goal:edit --title "${TITLE}"`);
		const editNotice = await session.waitForNotify((record) => record.message.includes("title set to"));
		assert.match(editNotice.message, new RegExp(`"${TITLE}"`));
		assert.match(editNotice.message, /no work was started or redirected/);
		assert.equal(runCount(session), runsBeforeEdit, "a title-only edit starts no run");

		const edited = currentGoal(readSessionEntries(await session.sessionFile()));
		assert.equal(edited.id, paused.id, "the Goal keeps its identity");
		assert.equal(edited.objective, OBJECTIVE, "--title alone changes only the title");
		assert.equal(edited.title, TITLE, "the title is durable Goal state");
		assert.equal(edited.revision, paused.revision + 1, "the edit is the next revision");
		assert.equal(edited.status, "paused", "a label edit does not move the Lifecycle status");

		// The human status report renders the title when present.
		await session.prompt("/goal");
		const summary = await session.waitForNotify((record) => record.message.includes(`Objective: ${OBJECTIVE}`));
		assert.match(summary.message, new RegExp(`^Title: ${TITLE}$`, "m"));
		assert.ok(
			summary.message.indexOf(`Title: ${TITLE}`) < summary.message.indexOf(`Objective: ${OBJECTIVE}`),
			"the title is shown above the objective",
		);

		// --- Structured payloads: get_goal and update_goal carry the title. ------
		// The resumed run binds to the edited revision, reads the Goal, and
		// completes it; completion is terminal, so the run settles without a
		// continuation request.
		await session.prompt("/goal:resume");
		await session.waitForNotify((record) => record.message.includes("resumed"));
		const getResult = (await session.waitForToolResult("get_goal", 1)).result;
		assert.equal(getResult.structuredContent.goal.title, TITLE, "get_goal's structured payload carries the title");
		assert.equal(getResult.structuredContent.goal.objective, OBJECTIVE);
		assert.match(String(getResult.content[0].text), new RegExp(`^Title: ${TITLE}$`, "m"));

		const completeResult = (await session.waitForToolResult("update_goal", 2)).result;
		assert.equal(completeResult.structuredContent.goal.status, "complete");
		assert.equal(completeResult.structuredContent.goal.title, TITLE, "update_goal's structured payload carries it");
		await session.waitForSettled(2);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(currentGoal(entries).title, TITLE);

		// --- Privacy: the title text never reaches a derived surface. -----------
		assertTitleAbsentFromDerivedSurfaces(entries, TITLE);
		assert.deepEqual(
			customEntries(entries, HISTORY_ENTRY_TYPE).map((entry) => entry.data.kind),
			["created", "paused", "objective-edited", "resumed", "completed"],
			"the title edit committed one derived transition, without its text",
		);

		assertStepsConsumed(session, 6);
		assertCleanRun(session);
	} finally {
		await session.stop();
	}
});

test("--title combined with an Objective changes both in one revision and starts no work", async () => {
	const session = await startTitleSession();
	script(createAndPauseSteps(), session);
	try {
		const paused = await startPausedGoal(session);
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

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
	} finally {
		await session.stop();
	}
});

test("invalid titles are refused with no Goal mutation", async () => {
	const session = await startTitleSession();
	script(createAndPauseSteps(), session);
	try {
		await startPausedGoal(session);

		const entriesBefore = readSessionEntries(await session.sessionFile());
		const bytesBefore = JSON.stringify(customEntries(entriesBefore, "goal-state"));
		const historyBefore = customEntries(entriesBefore, HISTORY_ENTRY_TYPE).length;
		const runsBefore = runCount(session);

		const refusals = [
			["/goal:edit --title", /--title needs a title/],
			['/goal:edit --title ""', /title must be 1 to 80 characters/],
			[`/goal:edit --title "${LONG_TITLE}"`, /title must be 1 to 80 characters/],
			// U+2028 and U+0085 are line terminators to text processors but not to
			// Pi's command transport, so the title reaches validation intact and
			// proves the one-line rule — including at the leading and trailing edges,
			// which must be refused rather than trimmed away.
			['/goal:edit --title "two\u2028lines"', /must be one line/],
			['/goal:edit --title "Release prep\u2028"', /must be one line/],
			['/goal:edit --title "\u0085Release prep"', /must be one line/],
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
		assert.equal(runCount(session), runsBefore, "no refused edit started a run");

		// A valid title still applies afterwards, so the refusal was about the value.
		await session.prompt(`/goal:edit --title "${TITLE}"`);
		await session.waitForNotify((record) => record.message.includes("title set to"));
		assert.equal(currentGoal(readSessionEntries(await session.sessionFile())).title, TITLE);

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
	} finally {
		await session.stop();
	}
});

test("session naming still names a fresh creation from the Objective, and a title edit never renames", async () => {
	const session = await startTitleSession({ settings: NAMING_ON });
	script(createAndPauseSteps(), session);
	try {
		await startPausedGoal(session);
		assert.equal((await session.getState()).sessionName, OBJECTIVE, "the fresh creation names the session");
		const nameBeforeEdit = (await session.getState()).sessionName;

		await session.prompt(`/goal:edit --title "${TITLE}"`);
		await session.waitForNotify((record) => record.message.includes("title set to"));

		// The title is durable Goal state; the session name is host metadata written
		// only for a fresh creation, so an edit never rewrites it.
		assert.equal((await session.getState()).sessionName, nameBeforeEdit, "a title edit never renames the session");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(durableSessionName(entries), OBJECTIVE, "exactly the creation's name is durable");
		assert.equal(sessionInfoEntries(entries).length, 1, "the edit appended no session_info entry");
		assert.equal(currentGoal(entries).title, TITLE);

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
	} finally {
		await session.stop();
	}
});
