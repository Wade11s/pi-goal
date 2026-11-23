/**
 * Issue #85: Objective clarification survives the session lifecycle.
 *
 * Every scenario drives a real `pi --mode rpc` subprocess with the pi-goal
 * package and the scripted provider, and reuses the restart pattern the
 * attachment suites established: one shared session directory and working
 * directory, a first process that records the pending clarification, and a
 * second process started from the same session file — either after a graceful
 * `stop()` or after a SIGKILL — that must reconstruct the interview and still
 * commit through a real `propose_goal` save.
 *
 * The assertions read public behavior only: the RPC record stream, the branch's
 * session entries (`goal-clarification`, `goal-state`, messages,
 * `goal-events-log`), the artifact store beside the session file, and the
 * remote-image fixture's request log. Every script is sized through its last
 * natural turn and every test ends in `assertCleanRun` / `assertStepsConsumed`,
 * so a green result can never come from an exhausted script.
 *
 * The pure reconstruction rules (newest entry wins, no fallback from a malformed
 * one, held-flag spelling) are pinned in
 * `goal85-clarification-persistence-store.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	continuationEntries,
	currentGoalSnapshot,
	goalSnapshots,
	readSessionEntries,
	runCount,
	script,
} from "./helpers/rpc-harness.mjs";
import { attachmentStoreRoot, storedGoalIds } from "../src/attachments.ts";
import {
	FIXTURE_CA,
	REMOTE_IMAGE_DNS_STUB_JSON,
	RemoteImageFixture,
} from "./helpers/remote-image-fixture.mjs";
import { CLARIFICATION_ENTRY_TYPE, CLARIFICATION_EDITOR_TITLE } from "../src/clarification.ts";

const IDEA = "Make onboarding feel less confusing";
const REPLACEMENT_IDEA = "Cut the release notes down to one page";
const DRAFT_TITLE = "Onboarding cleanup";
const REPLACEMENT_TITLE = "Release notes trim";
const DRAFT_OBJECTIVE = [
	"Objective: A new user reaches a working sample project in two steps.",
	"",
	"Constraints: None",
	"",
	"Acceptance criteria:",
	"1. The onboarding page shows one next action, verified by opening it.",
	"2. A fresh account completes the sample project, verified by running the acceptance script.",
].join("\n");
const REPLACEMENT_OBJECTIVE = [
	"Objective: The release notes fit on one page and name every breaking change.",
	"",
	"Constraints: None",
	"",
	"Acceptance criteria:",
	"1. The release notes top out at one page, verified by rendering the page.",
	"2. Every breaking change is listed, verified against the changelog.",
].join("\n");
const CLARIFY_SETTINGS = { goal: { clarifyOnCreate: true } };
const EVENTS_PEER = new URL("./extensions/events-peer.ts", import.meta.url).pathname;
const TREE_NAV = new URL("./extensions/tree-nav.ts", import.meta.url).pathname;
const PROPOSE_GOAL_PEER = new URL("./extensions/propose-goal-name-peer.ts", import.meta.url).pathname;

/**
 * A session directory that survives across processes, so the session file and the
 * artifact store beside it are shared by a session and its restarts.
 */
function sharedDirs() {
	return {
		sessionDir: mkdtempSync(join(tmpdir(), "pi-goal-clarify85-sessions-")),
		workDir: mkdtempSync(join(tmpdir(), "pi-goal-clarify85-work-")),
	};
}

/** Start a real Pi session in the shared dirs (fresh session file unless resumed). */
function startSession(dirs, options = {}) {
	const { settings, extraExtensions, ...rest } = options;
	return PiRpcSession.start({
		sessionDir: dirs.sessionDir,
		cwd: dirs.workDir,
		...rest,
		settings: settings ?? CLARIFY_SETTINGS,
		extraExtensions: extraExtensions ?? [],
	});
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
	rmSync(dirs.sessionDir, { recursive: true, force: true });
}

/** Wait for one more `agent_settled` than the session has already seen. */
function waitForNextSettle(session) {
	const seen = session.records.filter((record) => record.type === "agent_settled").length;
	return session.waitForSettled(seen + 1);
}

/** The message text of a branch message entry (string or content-block array). */
function branchText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Every `goal-clarification` entry on the branch, in append order. */
function clarificationEntries(entries) {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === CLARIFICATION_ENTRY_TYPE);
}

/** The newest pending-clarification payload on the branch (including a cleared one). */
async function newestClarification(session) {
	return clarificationEntries(readSessionEntries(await session.sessionFile())).at(-1)?.data.pending;
}

/** Every `goal-events-log` entry the events peer recorded, in delivery order. */
function eventLog(entries) {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-events-log");
}

/** Every raw `goal-state` line of the session, as bytes, for a "nothing happened" proof. */
async function goalBytes(session) {
	return readFileSync(await session.sessionFile(), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "" && line.includes('"goal-state"'))
		.join("\n");
}

/** Every user-role interview instruction on the branch, in append order. */
function interviewInstructions(entries) {
	return entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map((entry) => branchText(entry.message))
		.filter((text) => text.includes("Objective clarification: no new Goal is committed yet"));
}

/** Poll the session file until `predicate` holds over its entries. */
async function waitForBranch(session, predicate, description, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entries = readSessionEntries(await session.sessionFile());
		const value = predicate(entries);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Editor requests the host received, in order. */
function editorRequests(session, mark = 0) {
	return session.records.filter(
		(record, index) => index >= mark && record.type === "extension_ui_request" && record.method === "editor",
	);
}

/**
 * Wait for the clarification confirmation editor and answer it.
 *
 * `transform` receives the prefill, which is how a test both asserts the drafted
 * document and produces the saved one; returning `undefined` cancels the dialog.
 */
async function answerConfirmation(session, transform = (prefill) => prefill) {
	const request = await session.waitFor("the confirmation editor", (records) =>
		records.find(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "editor" &&
				record.title === CLARIFICATION_EDITOR_TITLE &&
				!session.answeredUiRequests.has(record.id),
		),
	);
	session.answeredUiRequests.add(request.id);
	const value = transform(request.prefill);
	session.writeCommand(
		value === undefined
			? { type: "extension_ui_response", id: request.id, cancelled: true }
			: { type: "extension_ui_response", id: request.id, value },
	);
	return request;
}

/**
 * Hold the kickoff work response, pause the Goal, then release it: the confirmed
 * creation settles cleanly instead of running an unbounded continuation loop.
 */
async function finishConfirmedCreation(session, gate) {
	const toolEnd = await session.waitForToolResult("propose_goal", 1);
	await session.waitForNotify((record) => record.message.includes("created and activated"));
	const created = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
	await session.prompt("/goal:pause");
	await session.waitForNotify((record) => record.message.includes("paused (revision"));
	writeFileSync(gate, "", "utf8");
	await waitForNextSettle(session);
	return { created, toolEnd };
}

test("a graceful restart reconstructs the pending clarification and propose_goal commits with the original idea and flags", async () => {
	const dirs = sharedDirs();
	let first;
	let second;
	const attachmentPath = join(dirs.workDir, "requirements.md");
	const attachmentBody = "The onboarding copy lives in docs/onboarding.md and must stay under 200 words.\n";
	const gate = join(dirs.workDir, "graceful-restart-gate");
	try {
		writeFileSync(attachmentPath, attachmentBody, "utf8");
		first = await startSession(dirs);
		script([{ text: "What should be different when this is done?" }], first);

		await first.prompt(`/goal --file ${attachmentPath} --budget 5000 ${IDEA}`);
		await waitForNextSettle(first);
		const sessionFile = await first.sessionFile();
		assert.deepEqual(await newestClarification(first), {
			idea: IDEA,
			budget: { kind: "value", value: 5000 },
			attachments: [{ kind: "text", path: attachmentPath }],
		});
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0, "nothing was committed before the restart");
		assertCleanRun(first);
		assertStepsConsumed(first, 1);
		await first.stop();
		first = undefined;

		// Graceful restart on the same session file: the branch's pending entry is
		// reconstructed before anything else runs.
		second = await startSession(dirs, { sessionFile });
		const restored = await second.waitForNotify((record) =>
			record.message.includes("Objective clarification restored"),
		);
		assert.equal(restored.notifyType, "info");
		assert.match(restored.message, /no new Goal is committed yet/);
		assert.match(restored.message, /--budget 5000/);
		assert.match(restored.message, /--file/);
		assert.match(restored.message, /Its held flags \(--budget 5000, --file\) are unchanged/);
		assert.match(restored.message, /nothing has been read, materialized, or fetched/);
		assert.deepEqual(
			await newestClarification(second),
			{ idea: IDEA, budget: { kind: "value", value: 5000 }, attachments: [{ kind: "text", path: attachmentPath }] },
			"the original idea and flags are the reconstructed state",
		);
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [], "reconstruction materializes nothing");
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0, "reconstruction commits no Goal");
		assert.equal(runCount(second), 0, "reconstruction starts no run");

		// The bare status report names the open clarification and the flags it holds.
		await second.prompt("/goal");
		const status = await second.notifyAfter(0, (record) => record.message.includes("An Objective clarification is open"));
		assert.match(status.message, /--budget 5000/);
		assert.match(status.message, /--file/);

		// A real propose_goal call after the restart opens the editor and commits.
		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working on the confirmed onboarding goal.", waitForFile: gate },
			],
			second,
		);
		await second.prompt("The finish line is a working sample project, and there are no constraints.");
		await answerConfirmation(second, (prefill) => {
			assert.equal(prefill, `Title: ${DRAFT_TITLE}\n\n${DRAFT_OBJECTIVE}`);
			return prefill;
		});
		const { created } = await finishConfirmedCreation(second, gate);

		assert.equal(created.title, DRAFT_TITLE);
		assert.equal(created.objective, DRAFT_OBJECTIVE);
		assert.equal(created.tokenBudget, 5000, "the held budget flag survived the restart");
		assert.deepEqual(
			created.attachments,
			[
				{
					hash: createHash("sha256").update(attachmentBody).digest("hex"),
					mediaType: "text/plain",
					bytes: Buffer.byteLength(attachmentBody),
					label: "requirements.md",
				},
			],
			"the held attachment flag survived the restart and materialized at the save",
		);
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [created.id]);
		assert.deepEqual(
			clarificationEntries(readSessionEntries(sessionFile)).map((entry) => entry.data.pending),
			[
				{ idea: IDEA, budget: { kind: "value", value: 5000 }, attachments: [{ kind: "text", path: attachmentPath }] },
				null,
			],
			"the post-restart save records the one durable end",
		);
		assert.equal(
			goalSnapshots(readSessionEntries(sessionFile)).filter((entry) => entry.data.goal.revision === 0).length,
			1,
			"one creation transition",
		);
		assert.equal(continuationEntries(readSessionEntries(sessionFile)).length, 0, "a paused Goal is not continued");

		assertCleanRun(second);
		assertStepsConsumed(second, 2);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("an unclean kill mid-clarification reconstructs the same pending clarification on restart", async () => {
	const dirs = sharedDirs();
	let first;
	let second;
	const gate = join(dirs.workDir, "unclean-restart-gate");
	try {
		first = await startSession(dirs);
		script([{ text: "How will you verify it?" }], first);
		await first.prompt(`/goal --budget 7000 ${IDEA}`);
		await waitForNextSettle(first);
		const sessionFile = await first.sessionFile();
		assert.equal((await newestClarification(first)).budget.kind, "value");

		// SIGKILL: no shutdown hook, no flush, no chance to clear anything.
		first.killNow();
		await first.waitForExit();
		await first.stop();
		first = undefined;

		second = await startSession(dirs, { sessionFile });
		await second.waitForNotify((record) => record.message.includes("Objective clarification restored"));
		assert.deepEqual(await newestClarification(second), {
			idea: IDEA,
			budget: { kind: "value", value: 7000 },
			attachments: [],
		});
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0, "the kill created no Goal");

		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working after the unclean restart.", waitForFile: gate },
			],
			second,
		);
		await second.prompt("By running the sample project end to end.");
		await answerConfirmation(second);
		const { created } = await finishConfirmedCreation(second, gate);
		assert.equal(created.objective, DRAFT_OBJECTIVE);
		assert.equal(created.tokenBudget, 7000, "the held budget flag survived the kill");
		assert.equal(created.origin, "command");
		assert.equal(created.revision, 0);
		assert.equal(await newestClarification(second), null);

		assertCleanRun(second);
		assertStepsConsumed(second, 2);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("a new /goal replaces the pending clarification, and the replaced editor's save commits nothing", async () => {
	const dirs = sharedDirs();
	let session;
	const gate = join(dirs.workDir, "replacement-gate");
	const abandonedAttachment = join(dirs.workDir, "abandoned-notes.md");
	writeFileSync(abandonedAttachment, "Notes for the abandoned idea.\n", "utf8");
	try {
		session = await startSession(dirs);
		script(
			[
				{ text: "What should be different when onboarding is done?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ toolCalls: [{ name: "propose_goal", args: { title: REPLACEMENT_TITLE, objective: REPLACEMENT_OBJECTIVE } }] },
				{ text: "Working on the replacement goal.", waitForFile: gate },
			],
			session,
		);

		// The first idea records a pending clarification with its own flags.
		await session.prompt(`/goal --file ${abandonedAttachment} --budget 5000 ${IDEA}`);
		await waitForNextSettle(session);
		await session.prompt("Done means a new user reaches a sample project.");
		// The model's propose_goal opens the editor and the test holds it open.
		const firstEditor = await session.waitFor("the first confirmation editor", (records) =>
			records.find(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "editor" &&
					record.title === CLARIFICATION_EDITOR_TITLE &&
					!session.answeredUiRequests.has(record.id),
			),
		);

		// A second /goal arrives while that editor is still open: the newest pending
		// entry wins, with the new idea and the new flags.
		const replaceMark = session.records.length;
		await session.prompt(`/goal --budget 7000 ${REPLACEMENT_IDEA}`);
		const restarted = await session.waitForNotify((record) =>
			record.message.includes("Objective clarification restarted"),
		);
		assert.match(restarted.message, /no Goal was created for the previous idea/);
		assert.deepEqual(await newestClarification(session), {
			idea: REPLACEMENT_IDEA,
			budget: { kind: "value", value: 7000 },
			attachments: [],
		});

		// The old interview instruction is abandoned as a conversation too. The steer
		// is delivered after the in-flight turn's tool call, so this is asserted once
		// the replaced editor has been answered below.
		session.answeredUiRequests.add(firstEditor.id);
		session.writeCommand({ type: "extension_ui_response", id: firstEditor.id, value: firstEditor.prefill });
		const stale = await session.waitForToolResult("propose_goal", 1);
		assert.equal(stale.result.isError, true, "the stale save is a refusal, not an accepted creation");
		const staleText = stale.result.content.map((block) => block.text).join("\n");
		assert.match(staleText, /no longer the current clarification/);
		assert.match(staleText, /Nothing was created/);
		const instructions = await waitForBranch(
			session,
			(entries) => {
				const found = interviewInstructions(entries);
				return found.length === 2 ? found : undefined;
			},
			"the replacement interview instruction",
		);
		assert.ok(instructions[0].includes(IDEA));
		assert.ok(!instructions[0].includes("replaced an earlier clarification"));
		assert.ok(instructions[1].includes(REPLACEMENT_IDEA));
		assert.match(instructions[1], /replaced an earlier clarification/);
		assert.match(instructions[1], /no Goal was created for it/);
		assert.equal(goalSnapshots(readSessionEntries(await session.sessionFile())).length, 0, "no Goal for the old idea");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(await session.sessionFile())), [], "no artifact for the old idea");
		assert.deepEqual(
			(await newestClarification(session)).idea,
			REPLACEMENT_IDEA,
			"the stale save did not end the newer clarification",
		);

		// The model proposes the replacement's draft, and that save commits the new
		// idea with the replacement flags — nothing from the abandoned idea survives.
		const commitMark = session.records.length;
		await answerConfirmation(session, (prefill) => {
			assert.equal(prefill, `Title: ${REPLACEMENT_TITLE}\n\n${REPLACEMENT_OBJECTIVE}`);
			return prefill;
		});
		await session.waitForToolResult("propose_goal", 2);
		await session.notifyAfter(commitMark, (record) => record.message.includes("created and activated"));
		const created = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		await session.prompt("/goal:pause");
		await session.waitForNotify((record) => record.message.includes("paused (revision"));
		writeFileSync(gate, "", "utf8");
		await waitForNextSettle(session);

		assert.equal(created.title, REPLACEMENT_TITLE);
		assert.equal(created.objective, REPLACEMENT_OBJECTIVE);
		assert.equal(created.tokenBudget, 7000, "the replacement flags won");
		assert.equal(created.attachments, undefined, "the abandoned --file flag did not ride the replacement");
		const entries = readSessionEntries(await session.sessionFile());
		const createdSnapshots = goalSnapshots(entries);
		assert.equal(
			new Set(createdSnapshots.map((entry) => entry.data.goal.id)).size,
			1,
			"exactly one Goal identity was ever committed",
		);
		assert.equal(
			createdSnapshots.filter((entry) => entry.data.goal.revision === 0).length,
			1,
			"one creation transition",
		);
		assert.deepEqual(
			clarificationEntries(entries).map((entry) => entry.data.pending),
			[
				{ idea: IDEA, budget: { kind: "value", value: 5000 }, attachments: [{ kind: "text", path: abandonedAttachment }] },
				{ idea: REPLACEMENT_IDEA, budget: { kind: "value", value: 7000 }, attachments: [] },
				null,
			],
			"the replacement is a second pending entry and the save records its end",
		);
		assert.equal(
			editorRequests(session, replaceMark).length,
			1,
			"only the replacement's confirmation was answered after the replacement",
		);

		assertCleanRun(session);
		assertStepsConsumed(session, 4);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("cancelling a clarification with attachment flags emits no Goal-updated event and leaves no artifact or fetch", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	let session;
	let restarted;
	try {
		const attachmentPath = join(dirs.workDir, "requirements.md");
		writeFileSync(attachmentPath, "The onboarding copy lives in docs/onboarding.md.\n", "utf8");
		const remoteUrl = `${fixture.url("/png")}?token=clarify85cancel`;
		session = await startSession(dirs, {
			extraExtensions: [EVENTS_PEER],
			env: {
				NODE_EXTRA_CA_CERTS: FIXTURE_CA,
				PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS: fixture.origin,
				PI_GOAL_TEST_REMOTE_IMAGE_DNS: REMOTE_IMAGE_DNS_STUB_JSON,
			},
		});
		script(
			[
				{ text: "Any constraints on the onboarding rewrite?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Understood: no Goal was created." },
			],
			session,
		);

		await session.prompt(`/goal --file ${attachmentPath} --remote-image ${remoteUrl} --budget 5000 ${IDEA}`);
		await waitForNextSettle(session);
		const sessionFile = await session.sessionFile();
		assert.equal(fixture.requests.length, 0, "nothing is fetched before the save");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [], "nothing is materialized before the save");
		const bytesBefore = await goalBytes(session);

		await session.prompt("No constraints. Let me think about it.");
		await answerConfirmation(session, () => undefined);
		const toolEnd = await session.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(session);

		// Zero side effects, proven on every surface: no Goal bytes, no artifacts, no
		// fetch, no Goal-updated event.
		assert.equal(await goalBytes(session), bytesBefore);
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0);
		assert.equal(await newestClarification(session), null, "the cancellation cleared the pending clarification");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), []);
		assert.equal(fixture.requests.length, 0, "a cancelled clarification never fetches");
		assert.deepEqual(eventLog(readSessionEntries(sessionFile)), [], "a cancelled clarification emits no Goal-updated event");
		assert.match(toolEnd.result.content.map((block) => block.text).join("\n"), /^No Goal was created/);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));

		// The durable end is what a restart reconstructs: the interview is gone, so a
		// stale propose_goal from the conversation cannot create anything either.
		const sessionFileAfterCancel = await session.sessionFile();
		await session.stop();
		session = undefined;
		restarted = await startSession(dirs, {
			sessionFile: sessionFileAfterCancel,
			extraExtensions: [EVENTS_PEER],
			env: {
				NODE_EXTRA_CA_CERTS: FIXTURE_CA,
				PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS: fixture.origin,
				PI_GOAL_TEST_REMOTE_IMAGE_DNS: REMOTE_IMAGE_DNS_STUB_JSON,
			},
		});
		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "There was no clarification to confirm." },
			],
			restarted,
		);
		assert.equal(runCount(restarted), 0);
		assert.equal(
			restarted.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("Objective clarification restored"),
			),
			false,
			"the durable end is not reconstructed as an open interview",
		);
		await restarted.prompt("Do the abandoned idea anyway");
		const refused = await restarted.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(restarted);
		assert.equal(refused.result.isError, true);
		assert.match(refused.result.content.map((block) => block.text).join("\n"), /no Objective clarification is in progress/);
		assert.equal(editorRequests(restarted).length, 0, "no editor was opened after the cancelled interview");
		assert.equal(goalSnapshots(readSessionEntries(sessionFileAfterCancel)).length, 0);
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFileAfterCancel)), []);
		assert.equal(fixture.requests.length, 0, "the cancelled clarification still fetched nothing");
		assert.deepEqual(eventLog(readSessionEntries(sessionFileAfterCancel)), [], "still no Goal-updated event");

		assertCleanRun(restarted);
		assertStepsConsumed(restarted, 2);
		assert.equal(restarted.extensionErrors().length, 0, JSON.stringify(restarted.extensionErrors()));
	} finally {
		await cleanup(dirs, session, restarted);
		await fixture.close();
	}
});

test("attachment and budget flags survive a mid-clarification restart, and fetching still waits for the save", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	let first;
	let second;
	const gate = join(dirs.workDir, "flags-restart-gate");
	try {
		const attachmentPath = join(dirs.workDir, "requirements.md");
		const attachmentBody = "The onboarding copy lives in docs/onboarding.md.\n";
		writeFileSync(attachmentPath, attachmentBody, "utf8");
		const remoteUrl = `${fixture.url("/png")}?token=clarify85flags`;
		const env = {
			NODE_EXTRA_CA_CERTS: FIXTURE_CA,
			PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS: fixture.origin,
			PI_GOAL_TEST_REMOTE_IMAGE_DNS: REMOTE_IMAGE_DNS_STUB_JSON,
		};

		first = await startSession(dirs, { env });
		script([{ text: "Which document should the onboarding copy follow?" }], first);
		await first.prompt(`/goal --file ${attachmentPath} --remote-image ${remoteUrl} --budget 5000 ${IDEA}`);
		await waitForNextSettle(first);
		const sessionFile = await first.sessionFile();
		assert.equal(fixture.requests.length, 0, "the interview fetches nothing");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [], "the interview materializes nothing");
		assertCleanRun(first);
		assertStepsConsumed(first, 1);
		await first.stop();
		first = undefined;

		// Mid-clarification restart: both attachment flags are still held verbatim,
		// and nothing has been read or fetched.
		second = await startSession(dirs, { sessionFile, env });
		await second.waitForNotify((record) => record.message.includes("Objective clarification restored"));
		assert.deepEqual(await newestClarification(second), {
			idea: IDEA,
			budget: { kind: "value", value: 5000 },
			attachments: [
				{ kind: "text", path: attachmentPath },
				{ kind: "remote-image", url: remoteUrl },
			],
		});
		assert.equal(fixture.requests.length, 0, "the restart fetches nothing");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [], "the restart materializes nothing");

		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working with the attached requirements.", waitForFile: gate },
			],
			second,
		);
		await second.prompt("It should follow docs/onboarding.md, under 200 words.");
		await answerConfirmation(second);
		const { created } = await finishConfirmedCreation(second, gate);

		// Materialization and the fetch happen exactly once, at the confirming save.
		assert.equal(fixture.requests.length, 1, "the confirming save fetched the remote image once");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [created.id]);
		assert.deepEqual(
			created.attachments.map((attachment) => [attachment.label, attachment.mediaType]),
			[
				["requirements.md", "text/plain"],
				["png", "image/png"],
			],
		);
		const expectedTextHash = createHash("sha256").update(attachmentBody).digest("hex");
		assert.equal(created.attachments[0].hash, expectedTextHash);
		assert.equal(created.tokenBudget, 5000);
		assert.equal(await newestClarification(second), null);

		assertCleanRun(second);
		assertStepsConsumed(second, 2);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
		await fixture.close();
	}
});

test("a restart that cannot offer the confirmation fails closed instead of resurrecting or bypassing it", async () => {
	const dirs = sharedDirs();
	let first;
	let withoutTool;
	let withoutRegistration;
	let afterDirect;
	const gate = join(dirs.workDir, "fail-closed-gate");
	try {
		first = await startSession(dirs);
		script([{ text: "What should be different?" }], first);
		await first.prompt(`/goal --budget 5000 ${IDEA}`);
		await waitForNextSettle(first);
		const sessionFile = await first.sessionFile();
		assertCleanRun(first);
		assertStepsConsumed(first, 1);
		await first.stop();
		first = undefined;

		// The branch holds a pending entry, but clarification is on with the
		// propose_goal name owned by another extension: the interview cannot be
		// confirmed, so it is not offered (fail-closed registration from #84, extended
		// to reconstruction).
		withoutRegistration = await startSession(dirs, {
			sessionFile,
			extraExtensions: [PROPOSE_GOAL_PEER],
		});
		script([], withoutRegistration);
		await withoutRegistration.prompt("/goal");
		const peerStatus = await withoutRegistration.waitForNotify((record) =>
			record.message.includes("No Goal is set in this session"),
		);
		assert.ok(!peerStatus.message.includes("An Objective clarification is open"));
		assert.ok(
			withoutRegistration.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("pi-goal did not register propose_goal"),
			),
			"the registration failure is still reported",
		);
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0, "nothing was created");
		assert.equal(editorRequests(withoutRegistration).length, 0);
		assertCleanRun(withoutRegistration);
		assertStepsConsumed(withoutRegistration, 0);
		await withoutRegistration.stop();
		withoutRegistration = undefined;

		// goal.clarifyOnCreate: false on the restart. The pending entry is still on the
		// branch, but this session has no confirmation authority: no interview is
		// offered, the tool is absent, and stopping the model from calling it is Pi's
		// own refusal.
		withoutTool = await startSession(dirs, { sessionFile, settings: { goal: { clarifyOnCreate: false } } });
		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "That tool is not available." },
				{ text: "Kicking off the replacement goal.", waitForFile: gate },
			],
			withoutTool,
		);
		assert.equal(runCount(withoutTool), 0);
		await withoutTool.prompt("/goal");
		const noGoalStatus = await withoutTool.waitForNotify((record) =>
			record.message.includes("No Goal is set in this session"),
		);
		assert.ok(
			!noGoalStatus.message.includes("An Objective clarification is open"),
			"a clarification this session cannot confirm is not offered",
		);
		assert.equal(
			withoutTool.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("Objective clarification restored"),
			),
			false,
			"no restore notice for an interview this session cannot confirm",
		);
		await withoutTool.prompt("Take a quick look at the repository for me.");
		const missing = await withoutTool.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(withoutTool);
		assert.equal(missing.isError, true, "Pi refuses the call before any pi-goal code runs");
		assert.match(missing.result.content.map((block) => block.text).join("\n"), /Tool propose_goal not found/);
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0, "nothing was created");
		assert.equal(editorRequests(withoutTool).length, 0);

		// A direct `/goal` on this restart supersedes the earlier clarification: the new
		// Goal exists and the leftover pending entry is recorded as ended, so a later
		// restart cannot offer the abandoned interview again.
		await withoutTool.prompt(`/goal ${REPLACEMENT_IDEA}`);
		await withoutTool.waitForNotify((record) => record.message.includes("created and activated"));
		const direct = currentGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
		assert.equal(direct.objective, REPLACEMENT_IDEA, "the direct creation used the new idea");
		await waitForBranch(
			withoutTool,
			(entries) => clarificationEntries(entries).at(-1)?.data.pending === null,
			"the superseded pending entry's durable end",
		);
		await withoutTool.prompt("/goal:pause");
		await withoutTool.waitForNotify((record) => record.message.includes("paused (revision"));
		writeFileSync(gate, "", "utf8");
		await waitForNextSettle(withoutTool);
		assertCleanRun(withoutTool);
		assertStepsConsumed(withoutTool, 3);
		await withoutTool.stop();
		withoutTool = undefined;

		// The next restart has the flow on again, and the superseded pending entry is
		// gone: the interview is not resurrected.
		afterDirect = await startSession(dirs, { sessionFile });
		script([], afterDirect);
		await afterDirect.waitForNotify((record) => record.message.includes("restored (paused)"));
		assert.equal(await newestClarification(afterDirect), null);
		assert.equal(
			afterDirect.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("Objective clarification restored"),
			),
			false,
			"the superseded interview is not offered after the direct creation",
		);
		assertCleanRun(afterDirect);
		assertStepsConsumed(afterDirect, 0);
	} finally {
		await cleanup(dirs, first, withoutTool, withoutRegistration, afterDirect);
	}
});

test("branch navigation reconstructs the pending clarification from the selected branch only", async () => {
	const dirs = sharedDirs();
	let session;
	const gate = join(dirs.workDir, "branch-pending-gate");
	try {
		session = await startSession(dirs, { extraExtensions: [TREE_NAV] });
		script(
			[
				{ text: "An ordinary answer before the clarification." },
				{ text: "What should be different when this is done?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working on the branch's confirmed goal.", waitForFile: gate },
			],
			session,
		);

		await session.prompt("an ordinary prompt before the Goal");
		await waitForNextSettle(session);
		const beforeEntry = readSessionEntries(await session.sessionFile()).filter((entry) => entry.type === "message").at(-1);
		assert.ok(beforeEntry?.id, "the ordinary prompt is on the branch");

		await session.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(session);
		const withPending = readSessionEntries(await session.sessionFile());
		assert.equal((await newestClarification(session)).idea, IDEA);
		const pendingEntry = clarificationEntries(withPending).at(-1);

		// Navigate to the branch that ends before the clarification: its pending entry
		// is not on this branch, so it must not be offered.
		let mark = session.records.length;
		await session.prompt(`/nav ${beforeEntry.id}`);
		await session.notifyAfter(mark, (record) => record.message.includes(`navigated to ${beforeEntry.id}`));
		mark = session.records.length;
		await session.prompt("/goal");
		const branchStatus = await session.notifyAfter(mark, (record) => record.message.includes("No Goal is set in this session"));
		assert.ok(
			!branchStatus.message.includes("An Objective clarification is open"),
			"the abandoned branch's pending entry does not leak into the selected branch",
		);

		// Navigate back: the pending entry is on this branch again.
		mark = session.records.length;
		await session.prompt(`/nav ${pendingEntry.id}`);
		await session.notifyAfter(mark, (record) => record.message.includes(`navigated to ${pendingEntry.id}`));
		const restored = await session.notifyAfter(mark, (record) =>
			record.message.includes("Objective clarification restored"),
		);
		assert.equal(restored.notifyType, "info");
		mark = session.records.length;
		await session.prompt("/goal");
		const pendingStatus = await session.notifyAfter(mark, (record) =>
			record.message.includes("An Objective clarification is open"),
		);
		assert.match(pendingStatus.message, /An Objective clarification is open/);
		assert.match(pendingStatus.message, /no new Goal is committed yet/);

		// The restored interview still commits through a real save.
		await session.prompt("Done means a working sample project.");
		await answerConfirmation(session);
		const { created } = await finishConfirmedCreation(session, gate);
		assert.equal(created.title, DRAFT_TITLE);
		assert.equal(created.objective, DRAFT_OBJECTIVE);
		assert.equal(await newestClarification(session), null);

		assertCleanRun(session);
		assertStepsConsumed(session, 4);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});
