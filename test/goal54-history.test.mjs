/**
 * Issue #54: the non-authoritative durable Goal audit history, end to end.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded and the scripted test provider, and asserts public behavior only: the
 * durable `goal-history` session entries and their interleaving with the
 * authoritative `goal-state` entries, the read-only `/goal:history` rendering, the
 * Goal state itself across restart and branch navigation, and the pi process's own
 * diagnostics. Nothing here reaches into the extension's internals, and no test
 * mutates a Goal from history — the timeline is a diagnostic surface, and the
 * assertions below are what prove it stayed one.
 *
 * The honesty rules are the suite's: scripts are sized exactly, and every test
 * pins the provider responses it asked for through `assertStepsConsumed()` —
 * with an exact expected-failure list whenever an abort is the subject — plus
 * `assertCleanRun()` where nothing failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	goalSnapshots,
	readSessionEntries,
	runCount,
	script,
} from "./helpers/rpc-harness.mjs";
import { advanceAuditGate, auditChainStepCount, scriptAuditChain } from "./helpers/blocked-audit.mjs";

const OBJECTIVE = "Ship the audit history end to end";
const EDITED = "Land the refined audit history objective instead";
const REPLACEMENT = "A second objective that replaces the first";

const TREE_NAV = new URL("./extensions/tree-nav.ts", import.meta.url).pathname;

/** Every `goal-history` entry in a session file, in append order. */
function historyEntries(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-history");
}

/** Every history record in a session file, in append order. */
function historyRecords(entries) {
	return historyEntries(entries).map((entry) => entry.data);
}

/** The transition kinds the history recorded, in order. */
function historyKinds(entries) {
	return historyRecords(entries).map((record) => record.kind);
}

/**
 * Fail unless each history record was appended immediately after the `goal-state`
 * entry it describes: the timeline is written from the committed-transition seam,
 * so a record can only ever follow its own snapshot (or, for a clear, its
 * tombstone). Bookkeeping snapshots — the budget wrap-up's disarm, a blocked-audit
 * reset — legitimately write a snapshot without a record, so the invariant is
 * "every record follows its snapshot", never "every snapshot has a record".
 */
function assertHistoryFollowsSnapshots(entries) {
	const history = historyEntries(entries);
	assert.ok(history.length > 0, "the timeline is not empty");
	for (const entry of history) {
		const previous = entries[entries.indexOf(entry) - 1];
		assert.equal(previous?.type, "custom", `a durable entry precedes ${entry.data.kind}`);
		assert.equal(previous?.customType, "goal-state", `and it is the snapshot ${entry.data.kind} describes`);
		if (entry.data.kind === "cleared") {
			assert.equal(previous.data.goal, null, "a clear follows its tombstone");
		} else {
			assert.equal(previous.data.goal?.id, entry.data.goalId, "and it names the same Goal");
			assert.equal(previous.data.goal?.revision, entry.data.revision, "at the same revision");
		}
	}
}

/**
 * Bare `/goal` status of the currently selected branch.
 *
 * The usage line is the stable marker: every status report carries it, so a
 * scenario never mistakes the restore notice for the report it asked for.
 */
async function goalStatus(session) {
	const mark = session.records.length;
	await session.prompt("/goal");
	const notify = await session.notifyAfter(mark, (record) => /Token usage: \d+ tokens/.test(record.message));
	return notify.message;
}

/**
 * Rewrite one `goal-history` entry's payload in place, exactly as a process killed
 * mid-write would leave it: a truncated record where a complete one was. The
 * entry's own id, parent, and timestamp survive, so the branch stays connected
 * and only the record's readability is lost.
 */
function truncateHistoryRecord(sessionFile, index) {
	const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.trim());
	const entries = lines.map((line) => JSON.parse(line));
	const history = entries.filter((entry) => entry.customType === "goal-history");
	assert.ok(history[index], `history record ${index} exists`);
	const target = history[index];
	target.data = { version: 1, kind: target.data.kind };
	const rewritten = entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(sessionFile, `${rewritten}\n`, "utf8");
}

/**
 * Overwrite specific fields of one `goal-history` entry's payload in place, exactly
 * as a hand-edited or future-version entry would: a record whose transition kind or
 * committed status this build does not recognize. The entry's own id, parent, and
 * timestamp survive, so the branch stays connected and only the record's legitimacy
 * is lost.
 */
function corruptHistoryField(sessionFile, index, patch) {
	const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.trim());
	const entries = lines.map((line) => JSON.parse(line));
	const history = entries.filter((entry) => entry.customType === "goal-history");
	assert.ok(history[index], `history record ${index} exists`);
	Object.assign(history[index].data, patch);
	const rewritten = entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(sessionFile, `${rewritten}\n`, "utf8");
}

/**
 * Remove one session entry line, re-parenting its child so the branch stays
 * connected. This is the file a crash between a lifecycle commit and its history
 * append leaves behind: the snapshot is there, the record that would have
 * followed it is not, and nothing else moved.
 */
function dropEntry(sessionFile, predicate) {
	const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.trim());
	const entries = lines.map((line) => JSON.parse(line));
	const index = entries.findIndex(predicate);
	assert.notEqual(index, -1, "the entry to drop is on the branch");
	const [dropped] = entries.splice(index, 1);
	for (const entry of entries) {
		if (entry.parentId === dropped.id) entry.parentId = dropped.parentId ?? null;
	}
	const rewritten = entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(sessionFile, `${rewritten}\n`, "utf8");
	return dropped;
}

/** Render the branch's history through the read-only command and return the text. */
async function renderHistory(session) {
	const mark = session.records.length;
	await session.prompt("/goal:history");
	const notify = await session.notifyAfter(
		mark,
		(record) => record.message.includes("Goal history") || record.message.includes("No Goal history"),
	);
	return notify.message;
}

/** Abort the in-flight run so lifecycle commands can run from idle. */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/** A session directory that survives across processes, for restart scenarios. */
function sharedDirs() {
	return {
		sessionDir: mkdtempSync(join(tmpdir(), "pi-goal-history-sessions-")),
		workDir: mkdtempSync(join(tmpdir(), "pi-goal-history-work-")),
	};
}

function cleanupDirs(dirs) {
	rmSync(dirs.sessionDir, { recursive: true, force: true });
	rmSync(dirs.workDir, { recursive: true, force: true });
}

test("every user transition appends one history record, and a restart renders the same timeline", async () => {
	const dirs = sharedDirs();
	const gate = join(dirs.workDir, "provider-gate");
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ hang: true },
			{ text: "Resumed work.", usage: { input: 20, output: 5 }, waitForFile: gate },
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 20, output: 5 },
			},
			{ text: "Wrapping up.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const id = goalSnapshots(readSessionEntries(await session.sessionFile()))[0].data.goal.id;

		// Pause from idle, then refuse a second pause: one durable transition, one
		// history record, and nothing for the refusal.
		await session.prompt("/goal:pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		await session.prompt("/goal:pause");
		await session.waitForNotify((r) => r.message.includes("already paused"));
		assert.deepEqual(historyKinds(readSessionEntries(await session.sessionFile())), ["created", "paused"]);

		// Editing a paused Goal changes durable state only, and is still a transition.
		await session.prompt(`/goal:edit ${EDITED}`);
		await session.waitForNotify((r) => r.message.includes("objective updated"));

		// Resume restarts work; the resumed run is held at the gate, so a second
		// resume is the refusal path and must write nothing.
		await session.prompt("/goal:resume");
		await session.waitForNotify((r) => r.message.includes("resumed"));
		await session.waitFor("resumed run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 3 ? true : undefined,
		);
		await session.prompt("/goal:resume");
		await session.waitForNotify((r) => r.message.includes("already active"));
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(2);

		// Clear from complete, then refuse a second clear.
		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("No Goal is set"));

		const entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), [
			"created",
			"paused",
			"objective-edited",
			"resumed",
			"completed",
			"cleared",
		]);
		assertHistoryFollowsSnapshots(entries);

		const records = historyRecords(entries);
		assert.deepEqual(
			records.map((record) => [record.kind, record.revision, record.from, record.to]),
			[
				["created", 0, null, "active"],
				["paused", 1, "active", "paused"],
				["objective-edited", 2, "paused", "paused"],
				["resumed", 3, "paused", "active"],
				["completed", 4, "active", "complete"],
				["cleared", 4, "complete", "complete"],
			],
			"the previous and current Lifecycle status of every transition",
		);
		for (const record of records) {
			assert.equal(record.goalId, id, "one identity across the whole lifecycle");
			assert.ok(!Number.isNaN(Date.parse(record.timestamp)), "each record carries its commit time");
			assert.equal(typeof record.usage.totalTokens, "number");
			assert.equal(typeof record.usage.activeSeconds, "number");
		}
		// The objective text is durable Goal state and stays out of the timeline.
		assert.equal(JSON.stringify(records).includes(OBJECTIVE), false);
		assert.equal(JSON.stringify(records).includes(EDITED), false);

		// The rendering is readable and names its own non-authority.
		const rendered = await renderHistory(session);
		assert.match(rendered, /^Goal history on this branch \(6 records, non-authoritative/);
		assert.match(rendered, /created\s+goal_[0-9a-f]{8}\s+revision 0\s+→ active/);
		assert.match(rendered, /cleared\s+goal_[0-9a-f]{8}\s+revision 4\s+complete/);
		assert.match(rendered, new RegExp(`${id}`));

		// A restart reconstructs the same branch and renders the same timeline: the
		// history is durable session state, not runtime state.
		const sessionFile = await session.sessionFile();
		const restarted = await PiRpcSession.start({ sessionFile });
		try {
			const afterRestart = await renderHistory(restarted);
			assert.equal(afterRestart, rendered, "the timeline survives a restart unchanged");

			// The cleared branch has no current Goal, and a fresh creation appends to
			// the same branch's timeline rather than starting a new one.
			script(
				[
					{
						toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
						usage: { input: 20, output: 5 },
					},
					{ text: "Done.", usage: { input: 5, output: 2 } },
				],
				restarted,
			);
			await restarted.prompt(`/goal ${REPLACEMENT}`);
			await restarted.waitForSettled(1);
			const grown = readSessionEntries(sessionFile);
			assert.deepEqual(historyKinds(grown).slice(0, 6), historyKinds(entries));
			assert.deepEqual(historyKinds(grown).slice(6), ["created", "completed"]);
			assert.equal(historyRecords(grown)[6].goalId, goalSnapshots(grown).at(-1).data.goal.id);
			assert.match(await renderHistory(restarted), /8 records/);
			assertCleanRun(restarted);
			assertStepsConsumed(restarted, 2);
			assert.equal(restarted.extensionErrors().length, 0, JSON.stringify(restarted.extensionErrors()));
		} finally {
			await restarted.stop();
		}

		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("the budget stop, its recovery, and the completion each append exactly one record", async () => {
	const dirs = sharedDirs();
	const gate = join(dirs.workDir, "provider-gate");
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 60, output: 20, cacheWrite: 5 } },
			{ text: "More work.", usage: { input: 20, output: 10 } },
			{ text: "Wrap-up: progress, remaining work, blockers, next action.", usage: { input: 10, output: 5 } },
			{ text: "Resumed with headroom.", usage: { input: 30, output: 10 }, waitForFile: gate },
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 20, output: 5 },
			},
			{ text: "Done.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForSettled(1);
		let entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), ["created", "budget-limited"]);
		const id = goalSnapshots(entries)[0].data.goal.id;

		// The stop is recorded at the boundary that makes it durable, with the totals
		// re-read at that flush — not at the in-memory instant the budget crossed.
		const budgetLimited = historyRecords(entries)[1];
		assert.equal(budgetLimited.from, "active");
		assert.equal(budgetLimited.to, "budget_limited");
		assert.equal(budgetLimited.revision, 1);
		assert.equal(budgetLimited.usage.totalTokens, 115);
		assertHistoryFollowsSnapshots(entries);

		// The wrap-up and its disarm are bookkeeping: the timeline does not grow.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(historyKinds(readSessionEntries(await session.sessionFile())), [
			"created",
			"budget-limited",
		]);

		await session.prompt("/goal:resume --budget 500");
		await session.waitFor("the resumed run started", (records) =>
			records.filter((r) => r.type === "agent_start").length >= 4 ? true : undefined,
		);
		// Accrue well over one accounting-checkpoint interval while the Goal is
		// active, so the resumed turn's boundary writes a `goal-usage` checkpoint:
		// positive evidence that accounting keeps writing while the timeline stays
		// one record per transition.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		writeFileSync(gate, "", "utf8");
		await session.waitForSettled(2);

		entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), ["created", "budget-limited", "budget-recovered", "completed"]);
		assert.deepEqual(
			historyRecords(entries).map((record) => [record.kind, record.from, record.to, record.revision]),
			[
				["created", null, "active", 0],
				["budget-limited", "active", "budget_limited", 1],
				["budget-recovered", "budget_limited", "active", 3],
				["completed", "active", "complete", 4],
			],
		);
		for (const record of historyRecords(entries)) assert.equal(record.goalId, id);
		assert.equal(
			entries.filter((e) => e.type === "custom" && e.customType === "goal-usage").length >= 1,
			true,
			"accounting kept writing its own checkpoints",
		);
		assert.equal(historyEntries(entries).length, 4, "and none of them reached the timeline");

		assertStepsConsumed(session, 6);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("the blocked threshold and a provider usage limit append their stops; audit steps do not", async () => {
	const session = await PiRpcSession.start({});
	const BLOCKER = "the upstream release API token has not been issued yet";
	// The chain is scripted before the Goal starts (the kickoff is the provider's
	// first request) and gated per Goal turn, so each below-threshold report is
	// observed on disk before the next turn runs.
	const reports = [
		{ blocker: BLOCKER },
		{ blocker: BLOCKER, id: "issued" },
		{ blocker: BLOCKER, id: "issued" },
	];
	const chain = scriptAuditChain(
		session,
		reports,
		[
			{ text: "Resuming after the blocker cleared.", usage: { input: 30, output: 8 } },
			{ error: "Monthly usage limit reached for this service", usage: { input: 20, output: 10 } },
		],
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);

		// The first two reports are durable audit steps: each wrote a snapshot, and
		// neither wrote a history record.
		await advanceAuditGate(session, chain, 0);
		await session.waitForToolResult("update_goal", 2);
		const midChain = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(midChain), ["created"], "no record for below-threshold reports");
		assert.ok(goalSnapshots(midChain).length >= 3, "the audit steps are still durable snapshots");
		const id = goalSnapshots(midChain)[0].data.goal.id;

		// The third consecutive report reaches the threshold, and the threshold is
		// the transition.
		writeFileSync(chain.gates[1], "", "utf8");
		await session.waitForToolResult("update_goal", 3);
		await session.waitForSettled(1);
		let entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), ["created", "blocked"]);
		assert.equal(historyRecords(entries)[1].from, "active");
		assert.equal(historyRecords(entries)[1].to, "blocked");
		assert.equal(historyRecords(entries)[1].goalId, id);
		assert.equal(historyRecords(entries)[1].revision, 3);
		assertHistoryFollowsSnapshots(entries);

		// The user's resume is the decision the stop asked for, and the provider's
		// usage limit is its own durable stop.
		await session.prompt("/goal:resume");
		await session.waitForSettled(2);
		entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), ["created", "blocked", "resumed", "usage-limited"]);
		assert.deepEqual(
			historyRecords(entries).map((record) => [record.kind, record.from, record.to, record.revision]),
			[
				["created", null, "active", 0],
				["blocked", "active", "blocked", 3],
				["resumed", "blocked", "active", 4],
				["usage-limited", "active", "usage_limited", 5],
			],
		);
		assertHistoryFollowsSnapshots(entries);

		assertStepsConsumed(session, auditChainStepCount(reports) + 2, [{ stopReason: "error" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a declined replacement and every refusal append no history", async () => {
	const session = await PiRpcSession.start({});
	script(
		[
			{ text: "A kickoff.", usage: { input: 30, output: 10 } },
			{ hang: true },
			{ text: "B kickoff.", usage: { input: 30, output: 10 } },
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 20, output: 5 },
			},
			{ text: "Done.", usage: { input: 5, output: 2 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const first = goalSnapshots(readSessionEntries(await session.sessionFile()))[0].data.goal.id;

		// Declining the replacement confirmation is not a transition: nothing was
		// committed, so nothing may reach the timeline.
		const decline = session.prompt(`/goal ${REPLACEMENT}`);
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), false);
		await decline;
		await session.waitForNotify((r) => r.message.includes("Replacement cancelled"));
		assert.deepEqual(historyKinds(readSessionEntries(await session.sessionFile())), ["created"]);

		// Confirming commits the new identity; the superseded freeze of the old one is
		// bookkeeping and writes no record of its own.
		const replace = session.prompt(`/goal ${REPLACEMENT}`);
		await session.respondToConfirm((r) => r.title.includes("Replace the current Goal"), true);
		await replace;
		await session.waitForSettled(2);
		let entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), ["created", "replaced", "completed"]);
		const replaced = historyRecords(entries)[1];
		assert.notEqual(replaced.goalId, first, "the record names the replacement identity");
		assert.equal(replaced.from, "active", "the status the replaced identity had");
		assert.equal(replaced.to, "active");
		assert.equal(replaced.revision, 0);
		assert.equal(
			historyEntries(entries).filter((entry) => entry.data.goalId === first).length,
			1,
			"the replaced identity is never re-recorded",
		);

		// Clearing names the Goal that was cleared, and no other.
		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		entries = readSessionEntries(await session.sessionFile());
		assert.deepEqual(historyKinds(entries), ["created", "replaced", "completed", "cleared"]);
		assert.equal(historyRecords(entries)[3].goalId, replaced.goalId);
		assert.equal(historyRecords(entries)[3].revision, 1);

		assertStepsConsumed(session, 5, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("a rolled-back creation appends nothing for the retraction itself", async () => {
	const dirs = sharedDirs();
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script([{ text: "Ordinary work continues." }, { hang: true }], session);
	try {
		await session.prompt("Please check the release notes");
		await session.waitForSettled(1);
		const sessionFile = await session.sessionFile();

		// Make the session file unreadable but still writable, so the snapshot append
		// succeeds and the creation's on-disk durability poll cannot: the command
		// retracts the Goal it had already committed. This is the one way a real
		// creation fails after it has been validated, staged, and committed.
		chmodSync(sessionFile, 0o200);
		try {
			const response = await session.prompt(`/goal ${OBJECTIVE}`);
			assert.equal(response.data.disposition, "handled");
			const failure = await session.waitForNotify((r) => r.message.includes("Goal not created:"));
			assert.match(failure.message, /did not reach the session file in time/);
		} finally {
			chmodSync(sessionFile, 0o644);
		}

		const entries = readSessionEntries(sessionFile);
		const snapshots = goalSnapshots(entries);
		assert.equal(snapshots.length, 2, "the staged snapshot plus the retraction's tombstone");
		assert.equal(snapshots[0].data.goal.revision, 0);
		assert.equal(snapshots[1].data.goal, null, "the tombstone is the durable retraction");
		// The commit announced the creation and wrote its record; the retraction is
		// bookkeeping, exactly as on the event stream, so it appends nothing further.
		assert.deepEqual(historyKinds(entries), ["created"]);
		assert.equal(historyRecords(entries)[0].goalId, snapshots[0].data.goal.id);

		// And the session is genuinely back to no Goal.
		const mark = session.records.length;
		await session.prompt("/goal");
		const status = await session.notifyAfter(mark, (r) => r.message.includes("No Goal is set"));
		assert.ok(status, "the rolled-back creation left no Goal behind");
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("attachment manifest metadata is recorded by hash and never as contents", async () => {
	const dirs = sharedDirs();
	const spec = join(dirs.workDir, "spec.md");
	const SPEC_TEXT = "# Release specification\n\nShip the audit history with its evidence.\n";
	writeFileSync(spec, SPEC_TEXT, "utf8");
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script([{ text: "On it.", usage: { input: 40, output: 10 } }, { hang: true }], session);
	try {
		await session.prompt(`/goal --file spec.md ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);

		const entries = readSessionEntries(await session.sessionFile());
		const manifest = goalSnapshots(entries)[0].data.goal.attachments;
		assert.equal(manifest.length, 1, "the manifest is durable Goal state");
		const created = historyRecords(entries)[0];
		assert.deepEqual(
			created.attachments.map((attachment) => [attachment.hash, attachment.mediaType, attachment.bytes, attachment.label]),
			[[manifest[0].hash, "text/plain", Buffer.byteLength(SPEC_TEXT, "utf8"), "spec.md"]],
			"the record carries the manifest's metadata, hashes included",
		);
		assert.equal(manifest[0].hash, createHash("sha256").update(SPEC_TEXT, "utf8").digest("hex"));
		assert.equal(JSON.stringify(historyRecords(entries)).includes(SPEC_TEXT.trim()), false, "never contents");

		// Every later transition keeps the same manifest hashes, because the manifest
		// is immutable for the identity.
		await session.prompt("/goal:pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		const paused = historyRecords(readSessionEntries(await session.sessionFile()))[1];
		assert.deepEqual(paused.attachments, created.attachments);

		const rendered = await renderHistory(session);
		assert.match(rendered, /attachments: spec\.md \(text\/plain, [\d.]+ (B|KB)\) sha256:[0-9a-f]{12}/);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("malformed history is skipped, surfaced as a notice, and cannot change the Goal", async () => {
	const dirs = sharedDirs();
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script([{ text: "On it.", usage: { input: 40, output: 10 } }, { hang: true }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		await session.prompt("/goal:pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		const sessionFile = await session.sessionFile();
		const before = readSessionEntries(sessionFile);
		assert.deepEqual(historyKinds(before), ["created", "paused"]);
		const goalId = goalSnapshots(before)[0].data.goal.id;

		// Truncate one record exactly as a process killed mid-write would leave it,
		// then reload the session from that file.
		truncateHistoryRecord(sessionFile, 1);
		assert.equal(historyRecords(readSessionEntries(sessionFile)).length, 2, "both entries are still there");

		const reloaded = await PiRpcSession.start({ sessionFile });
		try {
			// Reconstruction is untouched: the authoritative Goal is exactly what it was.
			const status = await goalStatus(reloaded);
			assert.match(status, new RegExp(goalId));
			assert.match(status, /Revision: 1/);
			assert.match(status, /— paused/);
			const restored = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal;
			assert.equal(restored.status, "paused");
			assert.equal(restored.revision, 1);
			assert.equal(restored.objective, OBJECTIVE);

			// The rendering skips the unreadable entry and says so instead of quietly
			// showing a shorter timeline.
			const rendered = await renderHistory(reloaded);
			assert.match(rendered, /1 history entry on this branch could not be read/);
			assert.match(rendered, /were skipped/);
			assert.match(rendered, /current Goal is reconstructed from its durable snapshots/);

			// Later transitions keep working: the edit commits and appends normally.
			script([{ text: "Edited." }], reloaded);
			await reloaded.prompt(`/goal:edit ${EDITED}`);
			await reloaded.waitForNotify((r) => r.message.includes("objective updated"));
			const after = readSessionEntries(sessionFile);
			assert.deepEqual(historyKinds(after), ["created", "paused", "objective-edited"]);
			assert.equal(historyRecords(after)[2].from, "paused");
			assert.equal(historyRecords(after)[2].to, "paused");
			assert.equal(historyRecords(after)[2].revision, 2);
			assert.equal(
				after.filter((e) => e.type === "custom" && e.customType === "goal-history" && e.data.revision === undefined)
					.length,
				1,
				"the truncated entry is still there, still ignored",
			);
			assertCleanRun(reloaded);
			assert.equal(reloaded.extensionErrors().length, 0, JSON.stringify(reloaded.extensionErrors()));
		} finally {
			await reloaded.stop();
		}

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("an unknown transition kind or status is malformed, never a real timeline entry", async () => {
	const dirs = sharedDirs();
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script([{ text: "On it.", usage: { input: 40, output: 10 } }, { hang: true }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		await session.prompt("/goal:pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		await session.prompt(`/goal:edit ${EDITED}`);
		await session.waitForNotify((r) => r.message.includes("objective updated"));
		const sessionFile = await session.sessionFile();
		const before = readSessionEntries(sessionFile);
		assert.deepEqual(historyKinds(before), ["created", "paused", "objective-edited"]);
		const goalId = goalSnapshots(before)[0].data.goal.id;

		// Corrupt one record's transition kind and another's committed status, exactly
		// as a hand-edited or future-version entry would: neither names a transition
		// this build knows, so neither may render as a real timeline entry.
		corruptHistoryField(sessionFile, 0, { kind: "not-a-transition" });
		corruptHistoryField(sessionFile, 2, { to: "not-a-status" });
		assert.equal(historyRecords(readSessionEntries(sessionFile)).length, 3, "all three entries are still there");

		const reloaded = await PiRpcSession.start({ sessionFile });
		try {
			// Reconstruction is untouched by the corrupt timeline.
			const restored = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal;
			assert.equal(restored.status, "paused");
			assert.equal(restored.revision, 2);
			assert.equal(restored.objective, EDITED);

			// The rendering skips both unknown entries, counts them, and still renders the
			// one good record — never the invented kind or the invented status.
			const rendered = await renderHistory(reloaded);
			assert.match(rendered, /1 record/);
			assert.match(rendered, new RegExp(`paused\\s+${goalId}\\s+revision 1`));
			assert.match(rendered, /2 history entries on this branch could not be read/);
			assert.match(rendered, /were skipped/);
			assert.equal(rendered.includes("not-a-transition"), false, "an unknown kind is never a timeline entry");
			assert.equal(rendered.includes("not-a-status"), false, "and neither is an unknown status");
			assertCleanRun(reloaded);
			assert.equal(reloaded.extensionErrors().length, 0, JSON.stringify(reloaded.extensionErrors()));
		} finally {
			await reloaded.stop();
		}

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("a crash gap between the commit and the append leaves only a diagnostic gap", async () => {
	const dirs = sharedDirs();
	const session = await PiRpcSession.start({ sessionDir: dirs.sessionDir, cwd: dirs.workDir });
	script([{ text: "On it.", usage: { input: 40, output: 10 } }, { hang: true }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		await session.prompt("/goal:pause");
		await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		const sessionFile = await session.sessionFile();
		assert.deepEqual(historyKinds(readSessionEntries(sessionFile)), ["created", "paused"]);

		// Drop the record the crash would have lost: the `goal-state` snapshot for the
		// pause stays, its history record does not.
		dropEntry(
			sessionFile,
			(entry) => entry.customType === "goal-history" && entry.data.kind === "paused",
		);
		assert.deepEqual(historyKinds(readSessionEntries(sessionFile)), ["created"]);

		const reloaded = await PiRpcSession.start({ sessionFile });
		try {
			// The authoritative Goal is exactly what it was: the gap is diagnostic.
			const restored = goalSnapshots(readSessionEntries(sessionFile)).at(-1).data.goal;
			assert.equal(restored.status, "paused");
			assert.equal(restored.revision, 1);
			const status = await goalStatus(reloaded);
			assert.match(status, /Revision: 1/);
			assert.match(status, /— paused/);

			// The timeline shows the transition it has and omits the one it lost,
			// without claiming anything about the missing record.
			const rendered = await renderHistory(reloaded);
			assert.match(rendered, /1 record/);
			assert.match(rendered, /created\s+goal_[0-9a-f]{8}\s+revision 0/);
			assert.equal(rendered.includes("revision 1"), false, "no record for the gapped transition");
			assert.equal(rendered.includes("could not be read"), false, "and nothing claims it was malformed");

			// Later transitions remain correct and keep appending.
			script([{ text: "Edited." }], reloaded);
			await reloaded.prompt(`/goal:edit ${EDITED}`);
			await reloaded.waitForNotify((r) => r.message.includes("objective updated"));
			const after = readSessionEntries(sessionFile);
			assert.deepEqual(historyKinds(after), ["created", "objective-edited"]);
			assert.equal(historyRecords(after)[1].revision, 2, "the next record follows the durable revision");
			assert.equal(goalSnapshots(after).at(-1).data.goal.revision, 2);
			assertCleanRun(reloaded);
			assert.equal(reloaded.extensionErrors().length, 0, JSON.stringify(reloaded.extensionErrors()));
		} finally {
			await reloaded.stop();
		}

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		cleanupDirs(dirs);
	}
});

test("history is branch-local: each selected branch renders only its own timeline", async () => {
	const session = await PiRpcSession.start({ extraExtensions: [TREE_NAV] });
	script(
		[
			{ text: "warm" },
			{ text: "kickoff one" },
			{ text: "continuing one" },
			{ hang: true },
			{ text: "kickoff two" },
			{ text: "continuing two" },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt("warm up");
		await session.waitForSettled(1);
		await session.prompt("/goal First objective ALPHA");
		await abortActiveLoop(session, 4);

		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		await session.prompt("/goal Second objective BETA");
		await abortActiveLoop(session, 7);

		const { entries } = await session.getEntries();
		const [firstCreate, tombstone, secondCreate] = goalSnapshots(entries);
		assert.ok(firstCreate && tombstone && secondCreate, "create, tombstone, create");

		// The whole branch's timeline, before navigating away from it.
		assert.deepEqual(historyKinds(entries), ["created", "cleared", "created"]);
		assert.equal(historyRecords(entries)[0].goalId, firstCreate.data.goal.id);
		assert.equal(historyRecords(entries)[2].goalId, secondCreate.data.goal.id);

		// Navigate to the first Goal's own history entry: the branch that holds its
		// creation record and nothing that came after it.
		const firstRecord = historyEntries(entries)[0];
		const markOne = session.records.length;
		await session.prompt(`/nav ${firstRecord.id}`);
		await session.notifyAfter(markOne, (r) => r.message.includes(`navigated to ${firstRecord.id}`));
		let rendered = await renderHistory(session);
		assert.match(rendered, /1 record/);
		assert.match(rendered, new RegExp(`created\\s+${firstCreate.data.goal.id}`));
		assert.equal(rendered.includes("cleared"), false, "the tombstone is not on this branch");

		// The tombstone's branch holds the creation and the clear.
		const clearRecord = historyEntries(entries)[1];
		const markTomb = session.records.length;
		await session.prompt(`/nav ${clearRecord.id}`);
		await session.notifyAfter(markTomb, (r) => r.message.includes(`navigated to ${clearRecord.id}`));
		rendered = await renderHistory(session);
		assert.match(rendered, /2 records/);
		assert.match(rendered, new RegExp(`cleared\\s+${firstCreate.data.goal.id}`));
		assert.equal(rendered.includes(secondCreate.data.goal.id), false, "the second Goal is not on this branch");

		// The second Goal's branch holds everything up to its own creation.
		const secondRecord = historyEntries(entries)[2];
		const markTwo = session.records.length;
		await session.prompt(`/nav ${secondRecord.id}`);
		await session.notifyAfter(markTwo, (r) => r.message.includes(`navigated to ${secondRecord.id}`));
		rendered = await renderHistory(session);
		assert.match(rendered, /3 records/);
		assert.match(rendered, new RegExp(`created\\s+${secondCreate.data.goal.id}`));

		// Navigating changed nothing on disk: the branch's own entries are all still
		// there, and no history record was appended by rendering any of them.
		assert.deepEqual(historyKinds(readSessionEntries(await session.sessionFile())), [
			"created",
			"cleared",
			"created",
		]);
		assertStepsConsumed(session, 7, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});

test("/goal:history is read-only and cannot be mistaken for a lifecycle command", async () => {
	const session = await PiRpcSession.start({});
	// One script for the whole scenario: the provider's step counter is
	// process-global, so a mid-scenario rewrite would have to pad the steps the
	// scenario already consumed.
	script(
		[
			{ text: "On it.", usage: { input: 40, output: 10 } },
			{ hang: true },
			{ text: "History work." },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const before = readSessionEntries(await session.sessionFile());
		const runsBefore = runCount(session);

		// Rendering the timeline repeatedly writes nothing at all.
		await renderHistory(session);
		await renderHistory(session);
		const after = readSessionEntries(await session.sessionFile());
		assert.deepEqual(after, before, "the rendering appends no session entry");
		assert.equal(runCount(session), runsBefore, "and starts no run");
		assert.equal(historyEntries(after).length, 1, "the timeline did not grow");

		// History is now its own `/goal:history` command, so text after `/goal`
		// that merely begins with the word is still an Objective. Clearing first
		// keeps this a fresh creation rather than a confirmed replacement.
		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		await session.prompt("/goal history of the release pipeline");
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 4);
		const entries = readSessionEntries(await session.sessionFile());
		const created = goalSnapshots(entries).at(-1).data.goal;
		assert.equal(created.objective, "history of the release pipeline");
		assert.deepEqual(historyKinds(entries), ["created", "cleared", "created"]);
		assert.equal(historyRecords(entries)[2].from, null, "a fresh creation has no previous status");
		assert.equal(historyRecords(entries)[2].to, "active");

		assertStepsConsumed(session, 4, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
	}
});
