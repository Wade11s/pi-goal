/**
 * Issue #48: committed local Goal-updated events.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and `test/extensions/events-peer.ts` —
 * a second extension that subscribes to the public `pi-goal:updated` channel on
 * Pi's shared extension event bus and records what it receives as durable
 * `goal-events-log` session entries. Assertions therefore target public behavior
 * only: the event stream a local integrator consumes, the durable `goal-state`
 * entries it interleaves with, the command and tool surfaces, and the pi
 * process's own diagnostics.
 *
 * The honesty rules are the suite's: scripts are sized exactly, every test ends
 * with `assertCleanRun()` (or an exact `assertOnlyFailures()` when a provider
 * failure is the subject), and `assertStepsConsumed()` pins the provider
 * responses the scenario asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	continuationEntries,
	customMessageEntries,
	goalSnapshots,
	readSessionEntries,
	runCount,
	script,
	submitCommand,
} from "./helpers/rpc-harness.mjs";
import { advanceAuditGate, scriptAuditChain } from "./helpers/blocked-audit.mjs";

const OBJECTIVE = "Ship the events contract end to end";
const EVENTS_PEER = new URL("./extensions/events-peer.ts", import.meta.url).pathname;
const EVENTS_LOG_TYPE = "goal-events-log";

/** Every recorded Goal-updated event, in delivery (= commit) order. */
function eventLog(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === EVENTS_LOG_TYPE);
}

/** The event payloads in order, unwrapped from their log entries. */
function eventKinds(entries) {
	return eventLog(entries).map((e) => e.data.kind);
}

/** Start a session whose events peer records the public Goal-updated stream. */
function startEventsSession(options = {}) {
	return PiRpcSession.start({ ...options, extraExtensions: [EVENTS_PEER, ...(options.extraExtensions ?? [])] });
}

/**
 * Fail unless one event mirrors the durable snapshot of the transition it
 * describes: same identity, revision, status, budget, accounted total, and the
 * snapshot's own timestamp — the payload contract of a committed transition.
 */
function assertEventMatchesSnapshot(eventEntry, snapshot, kind) {
	const event = eventEntry.data;
	const goal = snapshot.data.goal;
	assert.equal(event.kind, kind, `event kind for revision ${goal.revision}`);
	assert.equal(event.goal.id, goal.id);
	assert.equal(event.goal.revision, goal.revision);
	assert.equal(event.goal.status, goal.status);
	assert.equal(event.goal.tokenBudget, goal.tokenBudget ?? null);
	assert.equal(event.goal.usage.totalTokens, goal.usage.totalTokens);
	assert.equal(event.timestamp, new Date(goal.updatedAt).toISOString());
}

/** The durable snapshot entry at a given revision for one Goal identity. */
function snapshotAtRevision(entries, id, revision) {
	const snapshot = goalSnapshots(entries).find(
		(s) => s.data.goal?.id === id && s.data.goal?.revision === revision,
	);
	assert.ok(snapshot, `no durable snapshot for ${id} at revision ${revision}`);
	return snapshot;
}

/** Abort the in-flight run so lifecycle commands can run from idle. */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

test("a /goal creation emits exactly one Goal-updated event after the durable snapshot", async () => {
	const session = await startEventsSession();
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 30, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 5 } },
			{ text: "Done.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());

		const events = eventLog(entries);
		assert.deepEqual(
			eventKinds(entries),
			["created", "completed"],
			"one event for the creation and one for the completion that ends the scenario",
		);
		const event = events[0].data;
		assert.equal(event.kind, "created");
		const creation = goalSnapshots(entries)[0];

		assert.equal(event.version, 1);
		assert.equal(event.kind, "created");
		assert.equal(event.goal.id, creation.data.goal.id, "the committed Goal identity");
		assert.equal(event.goal.revision, 0);
		assert.equal(event.goal.status, "active");
		assert.equal(event.goal.objective.length, OBJECTIVE.length, "objective metadata, not objective text");
		assert.equal("text" in event.goal.objective, false, "the event carries no objective text");
		assert.equal(event.goal.objective.origin, "command");
		assert.equal(event.goal.tokenBudget, null);
		assert.deepEqual(event.goal.usage, {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cachedReadTokens: 0,
			reasoningTokens: 0,
			nestedTokens: 0,
			activeSeconds: 0,
		});
		assert.equal(
			event.timestamp,
			new Date(creation.data.goal.updatedAt).toISOString(),
			"the timestamp is the committed transition's own time",
		);
		assert.ok(
			entries.indexOf(events[0]) > entries.indexOf(creation),
			"the creation event is recorded only after the durable snapshot it describes",
		);

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("create_goal and update_goal complete announce their committed transitions", async () => {
	const session = await startEventsSession();
	const REQUEST = "Please create a Goal for the release";
	script(
		[
			{
				toolCalls: [
					{ name: "create_goal", args: { objective: OBJECTIVE, userRequest: REQUEST } },
				],
				usage: { input: 120, output: 20 },
			},
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 5 } },
			{ text: "Done.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(REQUEST);
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		const events = eventLog(entries);
		assert.deepEqual(eventKinds(entries), ["created", "completed"]);

		// The tool-created Goal's event carries the tool origin and the same
		// objective metadata a command-created one would.
		const created = events[0].data;
		assert.equal(created.goal.objective.origin, "tool");
		assert.equal(created.goal.objective.length, OBJECTIVE.length);
		assert.equal(
			entries.indexOf(events[0]),
			entries.indexOf(snapshotAtRevision(entries, created.goal.id, 0)) + 1,
			"a tool creation is announced immediately after its durable snapshot",
		);
		assertEventMatchesSnapshot(events[1], snapshotAtRevision(entries, created.goal.id, 1), "completed");

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("below-threshold blocker reports emit nothing; the threshold stop, resume, and completion each emit once", async () => {
	const session = await startEventsSession();
	const BLOCKER = "the upstream release API token has not been issued yet";
	try {
		const chain = scriptAuditChain(
			session,
			[
				{ blocker: BLOCKER },
				{ blocker: BLOCKER, id: "issued" },
				{ blocker: BLOCKER, id: "issued" },
			],
			[
				{ text: "Resuming after the blocker cleared.", usage: { input: 30, output: 8 } },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 5 } },
				{ text: "Done.", usage: { input: 5, output: 2 } },
			],
		);
		await session.prompt(`/goal ${OBJECTIVE}`);

		// The first two reports are durable audit steps, not lifecycle transitions:
		// each has been recorded on its own snapshot by the time its Goal turn ends.
		await advanceAuditGate(session, chain, 0);
		await session.waitForToolResult("update_goal", 2);
		const midChain = readSessionEntries(await session.sessionFile());
		assert.deepEqual(eventKinds(midChain), ["created"], "no event for below-threshold reports");
		assert.equal(
			goalSnapshots(midChain).length,
			3,
			"creation plus two durable audit steps — snapshots without events",
		);

		// The identity is unchanged across the chain, so the script rewritten at the
		// first gate still carries it for the third report; releasing the second gate
		// lets the threshold turn run.
		writeFileSync(chain.gates[1], "", "utf8");
		await session.waitForToolResult("update_goal", 3);
		await session.waitForSettled(1);
		let entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(eventKinds(entries), ["created", "blocked"], "the threshold stop is the only new event");
		const id = goalSnapshots(entries)[0].data.goal.id;
		assertEventMatchesSnapshot(eventLog(entries)[1], snapshotAtRevision(entries, id, 3), "blocked");

		// A user resume of a blocked Goal is its own committed transition.
		await session.prompt("/goal resume");
		await session.waitForSettled(2);
		entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(eventKinds(entries), ["created", "blocked", "resumed", "completed"]);
		assertEventMatchesSnapshot(eventLog(entries)[2], snapshotAtRevision(entries, id, 4), "resumed");
		assertEventMatchesSnapshot(eventLog(entries)[3], snapshotAtRevision(entries, id, 5), "completed");

		assertStepsConsumed(session, 10);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("budget exhaustion emits once at its durable boundary; wrap-up and accounting write no events; recovery emits", async () => {
	const session = await startEventsSession();
	const gate = join(session.cwd, "budget-gate");
	// The kickoff accounts 85 of a 100-token budget; the continuation crosses it
	// mid-run, so the stop becomes durable at the turn's end and the wrap-up is
	// the one bounded run that follows. The resumed phase holds its answer long
	// enough to accrue an accounting checkpoint — positive evidence that
	// accounting keeps writing while the event stream stays quiet.
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "More work.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up: progress, remaining work, blockers, next action.", usage: { input: 10, output: 5 } },
			{ text: "Resumed with headroom.", usage: { input: 30, output: 10 }, waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 5 } },
			{ text: "Done.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForSettled(1);
		let entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(
			eventKinds(entries),
			["created", "budget-limited"],
			"the durable budget stop is announced exactly once, at the boundary that persists it",
		);
		const id = goalSnapshots(entries)[0].data.goal.id;
		assertEventMatchesSnapshot(eventLog(entries)[1], snapshotAtRevision(entries, id, 1), "budget-limited");
		assert.equal(eventLog(entries)[1].data.goal.usage.totalTokens, 115, "the accounted total at the flush");
		assert.equal(
			customMessageEntries(entries, "goal-budget-wrapup").length,
			1,
			"the one bounded wrap-up was delivered",
		);

		// The wrap-up's own snapshot (the disarmed wrap-up flag) wrote no event.
		assert.equal(
			eventKinds(readSessionEntries(await session.sessionFile())).length,
			2,
			"wrap-up delivery and consumption emit nothing",
		);

		await session.prompt("/goal resume --budget 500");
		await session.waitFor("the resumed run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 4 ? true : undefined,
		);
		// Accrue well over one accounting-checkpoint interval while the Goal is
		// active, so the resumed turn's boundary writes a `goal-usage` checkpoint.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(2);

		entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(eventKinds(entries), [
			"created",
			"budget-limited",
			"budget-recovered",
			"completed",
		], "no event for the wrap-up snapshot, the checkpoints, or the token deltas");
		assertEventMatchesSnapshot(eventLog(entries)[2], snapshotAtRevision(entries, id, 3), "budget-recovered");
		assert.equal(eventLog(entries)[2].data.goal.tokenBudget, 500, "the raised cumulative ceiling");
		assertEventMatchesSnapshot(eventLog(entries)[3], snapshotAtRevision(entries, id, 4), "completed");

		// No token-delta or active-time-tick flood: accounting wrote durable
		// checkpoints while only lifecycle transitions produced events.
		const checkpoints = entries.filter((e) => e.type === "custom" && e.customType === "goal-usage");
		assert.ok(checkpoints.length >= 1, "accounting kept writing durable checkpoints");
		assert.equal(eventLog(entries).length, 4, "and none of them emitted an event");

		assertStepsConsumed(session, 6);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a provider usage limit emits usage-limited for its durable stop", async () => {
	const session = await startEventsSession();
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ error: "Monthly usage limit reached for this service", usage: { input: 20, output: 10 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		const events = eventLog(entries);
		assert.deepEqual(eventKinds(entries), ["created", "usage-limited"]);
		const id = events[0].data.goal.id;
		assertEventMatchesSnapshot(events[1], snapshotAtRevision(entries, id, 1), "usage-limited");
		assert.equal(
			entries.indexOf(events[1]),
			entries.indexOf(snapshotAtRevision(entries, id, 1)) + 1,
			"the usage-limit event directly follows its durable snapshot",
		);

		assertStepsConsumed(session, 2, [{ stopReason: "error" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a Replacement Goal emits for the new identity; a declined replacement emits nothing; clear names the cleared Goal", async () => {
	const session = await startEventsSession();
	const FIRST = "First objective in this session";
	const SECOND = "Second objective replacing the first";
	script(
		[
			{ text: "A kickoff.", usage: { input: 30, output: 10 } },
			{ hang: true },
			{ text: "B kickoff.", usage: { input: 30, output: 10 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 20, output: 5 } },
			{ text: "Done.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${FIRST}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const entriesAfterFirst = readSessionEntries(await session.sessionFile());
		const first = goalSnapshots(entriesAfterFirst)[0].data.goal.id;
		assert.deepEqual(eventKinds(entriesAfterFirst), ["created"]);

		// Declining the replacement confirmation keeps the current Goal: no
		// durable transition happened, so nothing may be announced.
		const declinePromise = submitCommand(session, "decline-1", `/goal ${SECOND}`);
		await session.respondToConfirm(() => true, false);
		await declinePromise;
		await session.waitForNotify((r) => r.message.includes("Replacement cancelled"));
		assert.deepEqual(eventKinds(readSessionEntries(await session.sessionFile())), ["created"]);

		// Confirming the replacement commits the new identity, and the event names
		// the replacement — the Goal that now owns the session's single slot.
		const replacePromise = submitCommand(session, "replace-1", `/goal ${SECOND}`);
		await session.respondToConfirm(() => true, true);
		await replacePromise;
		await session.waitForSettled(2);
		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(eventKinds(entries), ["created", "replaced", "completed"], "no event for the superseded freeze");
		const replaced = eventLog(entries)[1].data;
		assert.notEqual(replaced.goal.id, first, "the replacement event carries the new identity");
		assert.equal(replaced.goal.revision, 0);
		assert.equal(replaced.goal.objective.length, SECOND.length);
		assert.equal(
			entries.indexOf(eventLog(entries)[1]),
			entries.indexOf(snapshotAtRevision(entries, replaced.goal.id, 0)) + 1,
			"the replacement event directly follows the new identity's durable snapshot",
		);
		// The replaced identity is never re-announced: its preserved snapshot is
		// branch history, and the only event that ever named it is its own creation.
		assert.ok(
			goalSnapshots(entries).some((s) => s.data.goal?.id === first),
			"the replaced identity's totals were preserved on the branch",
		);
		assert.equal(
			eventLog(entries).filter((e) => e.data.goal.id === first).length,
			1,
			"only the original creation ever named the replaced identity",
		);

		// Clearing names the Goal that was cleared — the replacement — and no other.
		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		const finalEntries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(eventKinds(finalEntries), ["created", "replaced", "completed", "cleared"]);
		const cleared = eventLog(finalEntries)[3].data;
		assert.equal(cleared.goal.id, replaced.goal.id, "the clear event identifies the cleared Goal");
		assert.equal(cleared.goal.status, "complete", "the status it had when cleared");
		assert.equal(cleared.goal.revision, 1, "its last committed revision");

		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a throwing listener cannot roll back a committed transition and surfaces diagnostics, not a durability failure", async () => {
	const session = await startEventsSession();
	const EDITED = "Objective edited right after a listener failed";
	script(
		[
			{ text: "On it.", usage: { input: 30, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const id = goalSnapshots(readSessionEntries(await session.sessionFile()))[0].data.goal.id;

		// Arm the peer's injected failure for the paused transition, then pause.
		await session.prompt("/eventsfail paused");
		await session.waitForNotify((r) => r.message.includes("eventsfail armed"));
		await session.prompt("/goal pause");

		// The transition committed and was reported as a success: the durable
		// snapshot exists, the command announced the pause, and no extension error
		// turned the listener's failure into a false durability problem.
		const pausedNotify = await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		assert.ok(pausedNotify, "the pause was announced as the durable transition it was");
		const entries = readSessionEntries(await session.sessionFile());
		const pausedSnapshot = snapshotAtRevision(entries, id, 1);
		assert.equal(pausedSnapshot.data.goal.status, "paused", "the pause is durable");

		// The event was delivered before the listener threw — the stream carried it —
		// and the failure surfaced as the host's own diagnostic for the events seam,
		// never as a durability problem of pi-goal's: the only error on the stream is
		// the listener's, and the pause was announced as the success it was.
		assert.deepEqual(eventKinds(entries), ["created", "paused"]);
		const foreign = session.extensionErrors().filter((r) => r.event !== "events:pi-goal:updated");
		assert.equal(foreign.length, 0, `no pi-goal-side failure: ${JSON.stringify(foreign)}`);
		const listenerDiagnostics = session.extensionErrors().filter((r) => r.event === "events:pi-goal:updated");
		const stderrDiagnostic = /Event handler error \(pi-goal:updated\)/.test(session.stderr.join(""));
		assert.ok(
			listenerDiagnostics.length === 1 || stderrDiagnostic,
			"the listener failure surfaced as the host's own diagnostic (extension error record or bus log)",
		);

		// Disarmed, the very next transition announces normally again.
		await session.prompt("/eventsfail");
		await session.waitForNotify((r) => r.message.includes("eventsfail disarmed"));
		await session.prompt(`/goal edit ${EDITED}`);
		await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.deepEqual(eventKinds(readSessionEntries(await session.sessionFile())), [
			"created",
			"paused",
			"objective-edited",
		]);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
	}
});

test("user lifecycle commands emit paused, objective-edited, resumed, and cleared events; refusals emit nothing", async () => {
	const session = await startEventsSession();
	const gate = join(session.cwd, "provider-gate");
	const EDITED = "Land the refined objective end to end";
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ hang: true },
			{ text: "Resumed work.", waitForFile: gate },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Wrapping up." },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const id = goalSnapshots(readSessionEntries(await session.sessionFile()))[0].data.goal.id;

		// Pause from idle: one durable transition, one event.
		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("paused"));
		assert.deepEqual(eventKinds(readSessionEntries(await session.sessionFile())), ["created", "paused"]);

		// Pausing again is an idempotent refusal: no new durable write, no event.
		await session.prompt("/goal pause");
		await session.waitForNotify((r) => r.message.includes("already paused"));
		assert.deepEqual(eventKinds(readSessionEntries(await session.sessionFile())), ["created", "paused"]);

		// Editing a paused Goal changes the objective without starting work.
		const runsAtPause = runCount(session);
		await session.prompt(`/goal edit ${EDITED}`);
		await session.waitForNotify((r) => r.message.includes("objective updated"));
		assert.equal(runCount(session), runsAtPause, "editing a paused Goal starts no run");

		// Resume restarts work; the resumed run is held at the gate, so a resume
		// attempt while provably active is the refusal path.
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("resumed"));
		await session.waitFor("resumed run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 3 ? true : undefined,
		);
		await session.prompt("/goal resume");
		await session.waitForNotify((r) => r.message.includes("already active"));

		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(2);

		// Clear from complete: the tombstone is the last durable transition.
		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		// Clearing with no Goal is a refusal, not a transition.
		await session.prompt("/goal clear");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));

		const entries = readSessionEntries(await session.sessionFile());
		const events = eventLog(entries);
		assert.deepEqual(eventKinds(entries), [
			"created",
			"paused",
			"objective-edited",
			"resumed",
			"completed",
			"cleared",
		], "exactly one event per committed transition, and none for the refusals");

		// Every event mirrors the durable snapshot of its own transition.
		assertEventMatchesSnapshot(events[0], snapshotAtRevision(entries, id, 0), "created");
		assertEventMatchesSnapshot(events[1], snapshotAtRevision(entries, id, 1), "paused");
		assertEventMatchesSnapshot(events[2], snapshotAtRevision(entries, id, 2), "objective-edited");
		assertEventMatchesSnapshot(events[3], snapshotAtRevision(entries, id, 3), "resumed");

		// The edited objective's metadata changed with the edit, in place.
		assert.equal(events[2].data.goal.objective.length, EDITED.length);
		assert.equal(events[0].data.goal.objective.length, OBJECTIVE.length);

		// The clear event identifies the cleared Goal — its identity, its last
		// revision, and the status it had — without inventing a new current Goal.
		const cleared = events[5].data;
		const lastRecord = snapshotAtRevision(entries, id, 4).data.goal;
		assert.equal(cleared.goal.id, id);
		assert.equal(cleared.goal.revision, lastRecord.revision);
		assert.equal(cleared.goal.status, lastRecord.status);
		assert.ok(!Number.isNaN(Date.parse(cleared.timestamp)), "the clear carries its own commit time");
		const tombstone = [...entries]
			.reverse()
			.find((e) => e.type === "custom" && e.customType === "goal-state" && e.data.goal === null);
		assert.ok(tombstone, "the clear wrote a durable tombstone");
		assert.ok(
			entries.indexOf(events[5]) > entries.indexOf(tombstone),
			"the clear event follows the durable tombstone",
		);

		// The non-creation transitions are recorded immediately after the durable
		// snapshot they describe — durable-before-announced, event included.
		for (const [eventEntry, revision] of [
			[events[1], 1],
			[events[2], 2],
			[events[3], 3],
		]) {
			assert.equal(
				entries.indexOf(eventEntry),
				entries.indexOf(snapshotAtRevision(entries, id, revision)) + 1,
				`the revision-${revision} event directly follows its snapshot`,
			);
		}

		assert.equal(continuationEntries(entries).length, 2, "kickoff continuation plus the post-resume continuation");
		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
