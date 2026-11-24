/**
 * Issue #84: the Objective clarification core flow (ADR-0003).
 *
 * Every scenario drives a real `pi --mode rpc` subprocess with the pi-goal
 * package and the scripted test provider. The interview is scripted, the model's
 * real `propose_goal` tool call opens the confirmation editor over the RPC
 * extension-UI subprotocol, and the test answers it exactly like an interactive
 * user would: save unchanged, save edited, cancel, or never answer at all
 * (`PI_GOAL_DIALOG_TIMEOUT_MS`). Assertions read public behavior only — the
 * command response, notifications, tool results, the branch's session entries
 * (`goal-state`, `goal-clarification`, messages), artifact files, and the
 * fixture's HTTP request log. Every script is sized through the last natural
 * turn and every test ends in `assertCleanRun` / `assertStepsConsumed`.
 *
 * The real-Pi harness sets `goal.clarifyOnCreate` to false so the existing suites
 * keep the direct-creation path. This suite opts back in explicitly; the
 * production default (`true`) and the malformed-value fallback are pinned by
 * `goal84-objective-clarification-store.test.mjs`, which also covers the
 * UI-less direct creation and the tool-gating refusal against a fake Pi.
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
	assertOnlyFailures,
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
const DRAFT_TITLE = "Onboarding cleanup";
const DRAFT_OBJECTIVE = [
	"Objective: A new user reaches a working sample project in two steps.",
	"",
	"Constraints: None",
	"",
	"Acceptance criteria:",
	"1. The onboarding page shows one next action, verified by opening it.",
	"2. A fresh account completes the sample project, verified by running the acceptance script.",
].join("\n");
const CLARIFY_SETTINGS = { goal: { clarifyOnCreate: true } };
const PROPOSE_GOAL_PEER = new URL("./extensions/propose-goal-name-peer.ts", import.meta.url).pathname;

function scratch() {
	return {
		workDir: mkdtempSync(join(tmpdir(), "pi-goal-clarify-work-")),
		sessionDir: mkdtempSync(join(tmpdir(), "pi-goal-clarify-sessions-")),
	};
}

/** Start a real Pi session with Objective clarification enabled. */
function startSession(dirs, options = {}) {
	const { settings, ...rest } = options;
	return PiRpcSession.start({
		cwd: dirs.workDir,
		sessionDir: dirs.sessionDir,
		...rest,
		settings: settings ?? CLARIFY_SETTINGS,
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

/** Stop an active continuation loop deliberately with an aborted run (Pi's hard exit). */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((record) => record.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
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

/** Every raw `goal-state` line of the session, as bytes, for a before/after "nothing happened" proof. */
async function goalBytes(session) {
	return readFileSync(await session.sessionFile(), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "" && line.includes('"goal-state"'))
		.join("\n");
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
 * document and produces the saved one; returning `undefined` cancels the dialog
 * the way a host that closes it does.
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

/** The user-role interview instruction the extension sent after `/goal`. */
function interviewInstruction(entries) {
	return entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map((entry) => branchText(entry.message))
		.find((text) => text.includes("Objective clarification: no new Goal is committed yet"));
}

test("the default path records the pending clarification, interviews the model, and commits nothing until the confirmation is saved", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs);
		const gate = join(dirs.workDir, "kickoff-gate");
		script(
			[
				{ text: "What should be different when this is done, and what are the hard constraints?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working on the confirmed onboarding goal.", waitForFile: gate },
			],
			session,
		);

		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		await waitForNextSettle(session);

		// Nothing was committed, but the pending clarification is durable and holds the
		// raw idea exactly as typed.
		const before = readSessionEntries(await session.sessionFile());
		assert.equal(goalSnapshots(before).length, 0, "no Goal bytes exist before the save");
		assert.deepEqual(await newestClarification(session), {
			idea: IDEA,
			budget: { kind: "default" },
			attachments: [],
			baseGoalId: null,
		});
		await session.waitForNotify((record) => record.message.includes("Objective clarification started"));

		// The model got the interview instruction, including the English
		// three-section drafting template and the tool to call.
		const instruction = interviewInstruction(before);
		assert.ok(instruction, "the interview instruction is a durable user message");
		assert.ok(instruction.includes(IDEA), "the raw idea reaches the model");
		assert.match(instruction, /Objective: one sentence/);
		assert.match(instruction, /Constraints: the hard limits/);
		assert.match(instruction, /Acceptance criteria: a numbered list/);
		assert.match(instruction, /propose_goal/);
		assert.match(instruction, /Do not call create_goal/);

		// The interview answer drives the model's real propose_goal call, which opens
		// the confirmation editor prefilled with the drafted document.
		const mark = session.records.length;
		await session.prompt("Objective: two steps to a sample project. Constraints: none. Acceptance criteria: two checks.");
		const request = await answerConfirmation(session, (prefill) => prefill);
		assert.equal(request.prefill, `Title: ${DRAFT_TITLE}\n\n${DRAFT_OBJECTIVE}`);
		await session.waitForToolResult("propose_goal", 1);
		await session.waitForNotify((record) => record.message.includes("created and activated"));

		// The save is the one creation transition: a fresh identity at revision 0,
		// with exactly the document the editor was saved with.
		const created = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(created.title, DRAFT_TITLE);
		assert.equal(created.objective, DRAFT_OBJECTIVE);
		assert.equal(created.origin, "command");
		assert.equal(created.status, "active");
		assert.equal(created.revision, 0, "the save is the single creation transition");
		assert.equal(await newestClarification(session), null, "the pending clarification is cleared durably");

		// Stop the active loop cleanly: hold the kickoff work response, pause the Goal,
		// then release it so the run settles with nothing left to continue.
		await session.prompt("/goal:pause");
		await session.waitForNotify((record) => record.message.includes("paused (revision"));
		writeFileSync(gate, "", "utf8");
		await waitForNextSettle(session);

		const entries = readSessionEntries(await session.sessionFile());
		const goal = currentGoalSnapshot(entries).data.goal;
		assert.equal(goal.id, created.id, "the pause keeps the same identity");
		assert.equal(goal.status, "paused");
		assert.equal(editorRequests(session, mark).length, 1, "exactly one confirmation was asked");
		assert.equal(continuationEntries(entries).length, 0, "a paused Goal is not continued");

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

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

test("saving an edited confirmation commits exactly the user-edited title and Objective, never the model's draft", async () => {
	const dirs = scratch();
	let session;
	const EDITED_TITLE = "Onboarding: two clicks";
	const EDITED_OBJECTIVE = [
		"Objective: A new user reaches a working sample project without reading the docs.",
		"",
		"Constraints: no new runtime dependencies",
		"",
		"Acceptance criteria:",
		"1. The onboarding page shows one next action, verified by opening it.",
		"2. A fresh account completes the sample project, verified by `npm run sample:e2e`.",
	].join("\n");
	const EVENTS_PEER = new URL("./extensions/events-peer.ts", import.meta.url).pathname;
	try {
		session = await startSession(dirs, { extraExtensions: [EVENTS_PEER] });
		const gate = join(dirs.workDir, "edited-kickoff-gate");
		script(
			[
				{ text: "What are the constraints?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working on the user's confirmed objective.", waitForFile: gate },
			],
			session,
		);

		await session.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(session);
		await session.prompt("No new dependencies, and a sample project is the finish line.");

		await answerConfirmation(session, (prefill) => {
			assert.equal(prefill, `Title: ${DRAFT_TITLE}\n\n${DRAFT_OBJECTIVE}`, "the editor is prefilled with the draft");
			return `Title: ${EDITED_TITLE}\n\n${EDITED_OBJECTIVE}`;
		});
		const { created, toolEnd } = await finishConfirmedCreation(session, gate);

		// The Goal is exactly the edited document: the model's draft is only a prefill.
		assert.equal(created.title, EDITED_TITLE);
		assert.equal(created.objective, EDITED_OBJECTIVE);
		assert.notEqual(created.objective, DRAFT_OBJECTIVE);
		assert.equal(created.origin, "command");
		assert.equal(created.revision, 0);

		// The model's tool result carries the confirmed contract, so it works from
		// the user-edited text rather than from its own draft.
		const state = toolEnd.result.structuredContent?.goal ?? toolEnd.result.details?.goal;
		assert.equal(state.title, EDITED_TITLE);
		assert.equal(state.objective, EDITED_OBJECTIVE);
		const toolText = toolEnd.result.content.map((block) => block.text).join("\n");
		assert.ok(
			toolText.includes("A new user reaches a working sample project without reading the docs."),
			"the tool result states the confirmed Objective",
		);
		assert.ok(
			!toolText.includes("A new user reaches a working sample project in two steps."),
			"the stale draft is not presented as the contract",
		);

		// Title privacy follows the Objective's boundary: the snapshot has the title,
		// the event log and the audit history never do.
		const entries = readSessionEntries(await session.sessionFile());
		const history = entries.filter((entry) => entry.customType === "goal-history").map((entry) => JSON.stringify(entry));
		assert.ok(history.length > 0, "the creation appended history records");
		for (const record of history) assert.ok(!record.includes(EDITED_TITLE), "no title text in goal-history");
		const eventsLog = entries.filter((entry) => entry.customType === "goal-events-log").map((entry) => JSON.stringify(entry));
		assert.ok(eventsLog.length > 0, "the creation announced events");
		for (const record of eventsLog) assert.ok(!record.includes(EDITED_TITLE), "no title text in Goal-updated events");

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(editorRequests(session).length, 1, "one confirmation, one save");
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("an invalid title structure is refused and the document reopens for correction", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs);
		const gate = join(dirs.workDir, "correction-gate");
		script(
			[
				{ text: "Tell me the acceptance criteria." },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working after the corrected save.", waitForFile: gate },
			],
			session,
		);

		await session.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(session);
		const mark = session.records.length;
		await session.prompt("The sample project is the acceptance check.");

		// First save: the title line was deleted. The refusal reopens the same
		// document instead of discarding the Objective the user wrote.
		const BODY_ONLY = DRAFT_OBJECTIVE;
		await answerConfirmation(session, () => BODY_ONLY);
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: the confirmation's first line must be"),
		);
		assert.equal(refusal.notifyType, "error");
		await answerConfirmation(session, (prefill) => {
			assert.equal(prefill, BODY_ONLY, "the refused document is reopened exactly as saved");
			return `Title: ${EDITED_TITLE_FOR_CORRECTION}\n\n${BODY_ONLY}`;
		});
		const { created } = await finishConfirmedCreation(session, gate);

		assert.equal(created.title, EDITED_TITLE_FOR_CORRECTION);
		assert.equal(created.objective, BODY_ONLY);
		assert.equal(editorRequests(session, mark).length, 2, "the document was reopened once for correction");
		const committed = goalSnapshots(readSessionEntries(await session.sessionFile()));
		assert.equal(new Set(committed.map((entry) => entry.data.goal.id)).size, 1, "exactly one Goal identity was committed");
		assert.equal(committed.filter((entry) => entry.data.goal.revision === 0).length, 1, "one creation transition");

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

const EDITED_TITLE_FOR_CORRECTION = "Corrected onboarding title";

test("cancelling the confirmation creates nothing: no Goal, no artifacts, no fetch, and the model is told", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = scratch();
	let session;
	try {
		const attachmentPath = join(dirs.workDir, "requirements.md");
		writeFileSync(attachmentPath, "The onboarding copy lives in docs/onboarding.md.\n", "utf8");
		const remoteUrl = `${fixture.url("/png")}?token=cancel-never-fetches`;
		session = await startSession(dirs, {
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
		// The flags are held verbatim while the interview runs; nothing was read,
		// written, or fetched.
		assert.deepEqual(await newestClarification(session), {
			idea: IDEA,
			budget: { kind: "value", value: 5000 },
			attachments: [
				{ kind: "text", path: attachmentPath },
				{ kind: "remote-image", url: remoteUrl },
			],
			baseGoalId: null,
		});
		assert.equal(fixture.requests.length, 0, "the remote image was not fetched before the save");
		const sessionFile = await session.sessionFile();
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [], "nothing was materialized before the save");
		const bytesBefore = await goalBytes(session);

		await session.prompt("No constraints. Let me think about it.");
		await answerConfirmation(session, () => undefined);
		const toolEnd = await session.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(session);

		// Zero side effects: no Goal bytes, no artifacts, no request, and the pending
		// entry is durably cleared.
		assert.equal(await goalBytes(session), bytesBefore);
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0);
		assert.equal(await newestClarification(session), null, "the cancellation cleared the pending clarification");
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), []);
		assert.equal(fixture.requests.length, 0, "a cancelled clarification never fetches");
		assert.equal(runCount(session), 2, "no Goal work ran after the cancel");

		// The model is told exactly what happened, so it stops instead of retrying.
		const text = toolEnd.result.content.map((block) => block.text).join("\n");
		assert.match(text, /^No Goal was created: the user cancelled the confirmation/);
		assert.match(text, /no Goal state was written/);
		assert.match(text, /no attachment was materialized/);
		assert.match(text, /no remote image was fetched/);
		assert.match(text, /do not call propose_goal again/);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
		await fixture.close();
	}
});

test("a confirmation nobody answers times out into the same zero-side-effect cancellation", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { env: { PI_GOAL_DIALOG_TIMEOUT_MS: "250" } });
		script(
			[
				{ text: "What does done look like?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "The confirmation timed out, so no Goal exists." },
			],
			session,
		);

		await session.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(session);
		await session.prompt("Done means the sample project runs.");

		// Deliberately never answer the editor request.
		const toolEnd = await session.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(session);

		const sessionFile = await session.sessionFile();
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0, "a timeout writes no Goal bytes");
		assert.equal(await newestClarification(session), null, "the timeout cleared the pending clarification");
		assert.equal(editorRequests(session).length, 1, "the editor was opened once");
		const text = toolEnd.result.content.map((block) => block.text).join("\n");
		assert.match(text, /^No Goal was created: the user cancelled the confirmation, or it timed out unanswered/);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("attachment and budget flags ride the pending entry and materialize only after the save", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs);
		const gate = join(dirs.workDir, "attachments-gate");
		const attachmentPath = join(dirs.workDir, "requirements.md");
		const attachmentBody = "The onboarding copy lives in docs/onboarding.md and must stay under 200 words.\n";
		writeFileSync(attachmentPath, attachmentBody, "utf8");
		script(
			[
				{ text: "What is the acceptance check?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working with the attached requirements.", waitForFile: gate },
			],
			session,
		);

		await session.prompt(`/goal --file ${attachmentPath} --budget 5000 ${IDEA}`);
		await waitForNextSettle(session);
		assert.deepEqual(await newestClarification(session), {
			idea: IDEA,
			budget: { kind: "value", value: 5000 },
			attachments: [{ kind: "text", path: attachmentPath }],
			baseGoalId: null,
		});
		const sessionFile = await session.sessionFile();
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [], "nothing is materialized before the save");

		await session.prompt("The acceptance check is the sample project.");
		await answerConfirmation(session, (prefill) => prefill);
		const { created } = await finishConfirmedCreation(session, gate);

		assert.equal(created.tokenBudget, 5000, "the held budget flag reached the committed Goal");
		assert.deepEqual(created.attachments, [
			{
				hash: createHash("sha256").update(attachmentBody).digest("hex"),
				mediaType: "text/plain",
				bytes: Buffer.byteLength(attachmentBody),
				label: "requirements.md",
			},
		]);
		// The artifact exists only after the save, and the kickoff delivered it.
		assert.deepEqual(storedGoalIds(attachmentStoreRoot(sessionFile)), [created.id]);
		const entries = readSessionEntries(sessionFile);
		const kickoff = entries
			.filter((entry) => entry.type === "message" && entry.message?.role === "user")
			.map((entry) => branchText(entry.message))
			.find((text) => text.includes(`Working toward Goal ${created.id}`));
		assert.ok(kickoff, "the kickoff work message was delivered after the save");
		assert.ok(kickoff.includes("requirements.md"), "the attachment label reaches the model");
		assert.ok(kickoff.includes("onboarding copy lives"), "the attachment content reaches the model");

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("--no-budget rides the pending entry and commits an unbounded Goal over a configured default", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { settings: { goal: { clarifyOnCreate: true, defaultTokenBudget: 9000 } } });
		const gate = join(dirs.workDir, "no-budget-gate");
		script(
			[
				{ text: "How will you verify it?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "Working unbounded.", waitForFile: gate },
			],
			session,
		);

		await session.prompt(`/goal --no-budget ${IDEA}`);
		await waitForNextSettle(session);
		assert.deepEqual((await newestClarification(session)).budget, { kind: "none" });
		await session.prompt("By running the sample project.");
		await answerConfirmation(session, (prefill) => prefill);
		const { created } = await finishConfirmedCreation(session, gate);
		assert.equal(created.tokenBudget, undefined, "--no-budget beats the configured default");

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("goal.clarifyOnCreate: false restores immediate, title-less creation with no interview or pending entry", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { settings: { goal: { clarifyOnCreate: false } } });
		script([{ text: "Kickoff on the raw idea." }, { hang: true }], session);

		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitFor("kickoff run started", (records) =>
			records.filter((record) => record.type === "agent_start").length >= 1 ? true : undefined,
		);

		const entries = readSessionEntries(await session.sessionFile());
		const goal = currentGoalSnapshot(entries).data.goal;
		assert.equal(goal.objective, IDEA, "the raw idea became the Objective verbatim");
		assert.equal(goal.title, undefined, "direct creation is title-less");
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(interviewInstruction(entries), undefined, "no interview instruction was sent");
		assert.equal(editorRequests(session).length, 0, "no confirmation was opened");

		await abortActiveLoop(session, 2);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a malformed goal.clarifyOnCreate is reported once and ignored, so the default clarification applies", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { settings: { goal: { clarifyOnCreate: "yes" } } });
		script([{ text: "What should be different?" }], session);

		const warning = await session.waitForNotify((record) => record.message.includes("goal.clarifyOnCreate must be a boolean"));
		assert.equal(warning.notifyType, "warning");
		const warnings = session.records.filter(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "notify" &&
				record.message.includes("goal.clarifyOnCreate must be a boolean"),
		);
		assert.equal(warnings.length, 1, "the configuration problem is reported once");

		await session.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(session);
		assert.equal((await newestClarification(session)).idea, IDEA, "the default (clarify) applies");
		assert.equal(goalSnapshots(readSessionEntries(await session.sessionFile())).length, 0);

		assertCleanRun(session);
		assertStepsConsumed(session, 1);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("goal.enabled: false refuses before any clarification starts", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { settings: { goal: { enabled: false, clarifyOnCreate: true } } });
		script([], session);

		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) => record.message.startsWith("Goal not created: pi-goal is disabled"));
		assert.equal(refusal.notifyType, "warning");

		// Nothing was written through to a session file (no message exists), which is
		// already the strongest form of "no Goal bytes"; the live branch confirms it.
		const { entries } = await session.getEntries();
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");
		assert.equal(editorRequests(session).length, 0);
		assert.equal(runCount(session), 0, "no interview was started");
		assert.equal(interviewInstruction(entries), undefined);

		assertCleanRun(session);
		assertStepsConsumed(session, 0);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("propose_goal is refused without a pending clarification, and is not registered when clarification is off", async () => {
	const dirs = scratch();
	let withoutPending;
	let withoutTool;
	try {
		withoutPending = await startSession(dirs);
		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "There was no clarification to confirm." },
			],
			withoutPending,
		);
		await withoutPending.prompt("Take a quick look at the repository for me.");
		const refused = await withoutPending.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(withoutPending);

		assert.equal(refused.result.isError, true, "the call is refused, not silently accepted");
		const refusedText = refused.result.content.map((block) => block.text).join("\n");
		assert.match(refusedText, /no Objective clarification is in progress/);
		assert.match(refusedText, /Ask the user to run \/goal <objective>/);
		assert.equal(editorRequests(withoutPending).length, 0, "no editor was opened");
		assert.equal(goalSnapshots(readSessionEntries(await withoutPending.sessionFile())).length, 0, "no Goal exists");
		assert.equal(clarificationEntries(readSessionEntries(await withoutPending.sessionFile())).length, 0);
		assertCleanRun(withoutPending);
		assertStepsConsumed(withoutPending, 2);

		// With the setting off the tool is not in the loadout at all, so Pi refuses
		// the call before any pi-goal code runs. This is the tool gating that keeps a
		// disabled flow out of the model's context.
		withoutTool = await startSession(dirs, { settings: { goal: { clarifyOnCreate: false } } });
		script(
			[
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "That tool is not available." },
			],
			withoutTool,
		);
		await withoutTool.prompt("Take a quick look at the repository for me.");
		const missing = await withoutTool.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(withoutTool);
		assert.equal(missing.isError, true, "Pi refuses the call before any pi-goal code runs");
		const missingText = missing.result.content.map((block) => block.text).join("\n");
		assert.match(missingText, /Tool propose_goal not found/);
		assert.equal(goalSnapshots(readSessionEntries(await withoutTool.sessionFile())).length, 0, "nothing was created");
		assertCleanRun(withoutTool);
		assertStepsConsumed(withoutTool, 2);
		assert.equal(withoutPending.extensionErrors().length + withoutTool.extensionErrors().length, 0);
	} finally {
		await cleanup(dirs, withoutPending, withoutTool);
	}
});

test("cancelling a clarification over a complete Goal leaves that Goal byte-identical", async () => {
	const dirs = scratch();
	let session;
	const COMPLETE_OBJECTIVE = "Finish the release notes page";
	const REQUEST = "Please create a goal for the release notes page";
	try {
		session = await startSession(dirs);
		script(
			[
				{
					toolCalls: [
						{ name: "create_goal", args: { objective: COMPLETE_OBJECTIVE, userRequest: REQUEST } },
					],
				},
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
				{ text: "What should the new goal achieve?" },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "No new Goal was created; the completed one is unchanged." },
			],
			session,
		);

		// A complete Goal through the model tool: create, then complete.
		await session.prompt(REQUEST);
		await session.waitForToolResult("update_goal", 1);
		await waitForNextSettle(session);
		const complete = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(complete.status, "complete");
		const bytesBefore = await goalBytes(session);

		// `/goal` over a complete Goal may clarify; the cancellation must change
		// nothing at all.
		await session.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(session);
		assert.equal((await newestClarification(session)).idea, IDEA, "the clarification started over the complete Goal");
		await session.prompt("It should be clearer, nothing else.");
		await answerConfirmation(session, () => undefined);
		await session.waitForToolResult("propose_goal", 1);
		await waitForNextSettle(session);

		assert.equal(await goalBytes(session), bytesBefore, "the current Goal's bytes are untouched");
		const current = currentGoalSnapshot(readSessionEntries(await session.sessionFile())).data.goal;
		assert.equal(current.id, complete.id);
		assert.equal(current.status, "complete");
		assert.equal(current.revision, complete.revision);
		assert.equal(await newestClarification(session), null, "the pending clarification is cleared");

		assertCleanRun(session);
		assertStepsConsumed(session, 6);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("the production default clarifies when goal.clarifyOnCreate is absent from settings", async () => {
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { omitClarifyOnCreate: true });
		// The harness normally injects `false`; this scenario omits the key entirely so
		// the extension's own default (true) is what the session runs with.
		const written = JSON.parse(readFileSync(join(session.agentDir, "settings.json"), "utf8"));
		assert.ok(written.goal, "the settings file still has a goal block");
		assert.equal("clarifyOnCreate" in written.goal, false, "the key is absent, not explicitly false");

		script([{ text: "What should be different when this is done?" }], session);
		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		await waitForNextSettle(session);

		assert.deepEqual(await newestClarification(session), {
			idea: IDEA,
			budget: { kind: "default" },
			attachments: [],
			baseGoalId: null,
		});
		assert.equal(goalSnapshots(readSessionEntries(await session.sessionFile())).length, 0, "no Goal was committed");
		assert.equal(
			session.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("goal.clarifyOnCreate must be a boolean"),
			),
			false,
			"an absent setting is not a configuration problem",
		);
		await session.waitForNotify((record) => record.message.includes("Objective clarification started"));

		assertCleanRun(session);
		assertStepsConsumed(session, 1);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a host that cannot register propose_goal fails closed instead of committing without confirmation", async () => {
	const dirs = scratch();
	let session;
	try {
		// The peer owns the `propose_goal` name before pi-goal's session_start, so
		// pi-goal must not shadow it. With clarification enabled and a UI available,
		// the mandatory confirmation editor is unavailable and the creation must be
		// refused — never downgraded to a direct, title-less commit.
		session = await startSession(dirs, { extraExtensions: [PROPOSE_GOAL_PEER] });
		script([], session);

		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		assert.match(refusal.message, /propose_goal tool is not available for this session/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.match(refusal.message, /set goal\.clarifyOnCreate to false/);

		// The startup warning explains the same condition before the command runs.
		assert.ok(
			session.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("pi-goal did not register propose_goal") &&
					record.message.includes("will refuse rather than create a Goal"),
			),
			"the registration failure is reported at session start",
		);

		const { entries } = await session.getEntries();
		assert.equal(clarificationEntries(entries).length, 0, "no pending interview was recorded");
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");
		assert.equal(editorRequests(session).length, 0, "no editor could be opened");
		assert.equal(runCount(session), 0, "no interview was started");

		assertCleanRun(session);
		assertStepsConsumed(session, 0);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});
