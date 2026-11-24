/**
 * Issue #92: a session's tool policy is not a foreign owner.
 *
 * Pi builds `getAllTools()` from the tool definitions the session's `--tools`
 * allowlist and `--exclude-tools` denylist admit, so a tool that is missing from
 * that list is as consistent with "this session hides it" as with "nobody
 * registered it". The old registration guard read pi-goal's own identity out of
 * `get_goal`, which collapsed those two readings into one: any session that
 * filtered `get_goal` was told another extension owned `propose_goal`, the tool was
 * never registered, and `/goal` then refused to create anything.
 *
 * Every scenario here drives a real `pi --mode rpc` subprocess with the documented
 * `tools` / `excludeTools` harness arguments and asserts against the recorded
 * extension-UI notifications, the model-visible tool set Pi actually declares, the
 * durable session entries, and the tool results — never against log text. The
 * review-child profile is the common real-world case and is covered by
 * `goal57-review-profile.test.mjs`; this suite owns the rule itself:
 *
 * 1. a session that hides only `get_goal` registers `propose_goal`, declares it to
 *    the model, and runs the clarification flow to a committed Goal;
 * 2. a session whose policy hides `propose_goal` itself is silent at startup and
 *    `/goal` refuses with cause-neutral wording, creating nothing;
 * 3. the opt-in `update_plan` follows the same rule at both ends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	continuationEntries,
	goalSnapshots,
	readSessionEntries,
	runCount,
	script,
} from "./helpers/rpc-harness.mjs";
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
const PLAN_TOOL_ON = { goal: { planTool: true } };
/** The test-only probe that records the tools a real session declares to the model. */
const ACTIVE_TOOLS_PEER = join(import.meta.dirname, "extensions", "active-tools-peer.ts");
/** A peer loaded *before* pi-goal that forges the identity by copying the schema. */
const PROPOSE_GOAL_FORGING_PEER = join(import.meta.dirname, "extensions", "propose-goal-forging-peer.ts");
/** A peer loaded *before* pi-goal that squats `propose_goal` from a `prepareLoadout` hook. */
const PROPOSE_GOAL_LOADOUT_PEER = join(import.meta.dirname, "extensions", "propose-goal-loadout-peer.ts");
/** A peer loaded after pi-goal that removes `propose_goal` from the active loadout. */
const PROPOSE_GOAL_DEACTIVATE_PEER = join(import.meta.dirname, "extensions", "propose-goal-deactivate-peer.ts");
/** A peer loaded after pi-goal that removes `update_plan` from the active loadout. */
const PLAN_DEACTIVATE_PEER = join(import.meta.dirname, "extensions", "plan-deactivate-peer.ts");
/** A peer loaded *before* pi-goal that takes `get_goal` on `session_start`. */
const GET_GOAL_NAME_PEER = join(import.meta.dirname, "extensions", "get-goal-name-peer.ts");
/** A peer loaded *before* pi-goal that takes `get_goal` and `propose_goal` on `session_start`. */
const GOAL_NAMES_PEER = join(import.meta.dirname, "extensions", "goal-names-peer.ts");
/** A peer loaded *before* pi-goal that takes `propose_goal` on `turn_start`. */
const PROPOSE_GOAL_LATE_PEER = join(import.meta.dirname, "extensions", "propose-goal-late-peer.ts");
/** The same peer for the `update_plan` name. */
const PLAN_LATE_PEER = join(import.meta.dirname, "extensions", "plan-late-peer.ts");
/** Tool names a scenario filters out so only the tool under test stays visible. */
const HIDE_GOAL_TOOLS = "get_goal,create_goal,update_goal";
/** The one sentence the bug printed, and the one that must never come back. */
const FOREIGN_OWNER_NOTICE = "another extension already provides a tool with that name";

function scratch() {
	return {
		workDir: mkdtempSync(join(tmpdir(), "pi-goal-92-work-")),
		sessionDir: mkdtempSync(join(tmpdir(), "pi-goal-92-sessions-")),
		agentDir: mkdtempSync(join(tmpdir(), "pi-goal-92-agent-")),
	};
}

/** Start a real Pi session with the given tool policy, settings, and extensions. */
function startSession(dirs, options = {}) {
	const { settings, extraExtensions, ...rest } = options;
	return PiRpcSession.start({
		cwd: dirs.workDir,
		sessionDir: dirs.sessionDir,
		agentDir: dirs.agentDir,
		settings: settings ?? CLARIFY_SETTINGS,
		env: { PI_GOAL_TEST_ACTIVE_TOOLS: join(dirs.workDir, "active-tools.json") },
		// The probe is always loaded; a scenario's own peers join it rather than
		// replacing it, so the model-visible tool set is always observable.
		extraExtensions: [ACTIVE_TOOLS_PEER, ...(options.extraExtensions ?? [])],
		...rest,
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
	for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
}

/** Every extension notification message this session recorded, in order. */
function notifyMessages(session) {
	return session.records
		.filter((record) => record.type === "extension_ui_request" && record.method === "notify")
		.map((record) => record.message);
}

/**
 * The model-visible tool set the probe recorded for this real session.
 *
 * The probe writes on `session_start`, so a scenario that never prompts still has a
 * tool set to read; it just has to be given a moment to be written.
 */
async function declaredTools(dirs, timeoutMs = 15_000) {
	const path = join(dirs.workDir, "active-tools.json");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Wait for one more `agent_settled` than the session has already seen. */
function waitForNextSettle(session) {
	const seen = session.records.filter((record) => record.type === "agent_settled").length;
	return session.waitForSettled(seen + 1);
}

/** Wait for the clarification confirmation editor and answer it. */
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

/** The text of every finalized call to one tool, in the order they finalized. */
function toolTexts(session, toolName) {
	return session.records
		.filter((record) => record.type === "tool_execution_end" && record.toolName === toolName)
		.map((record) => String(record.result?.content?.[0]?.text ?? ""));
}

/** Editor requests the host received, in order. */
function editorRequests(session) {
	return session.records.filter(
		(record) => record.type === "extension_ui_request" && record.method === "editor",
	);
}

/** Every `goal-clarification` entry on the branch, in append order. */
function clarificationEntries(entries) {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === CLARIFICATION_ENTRY_TYPE);
}

test("a session that hides only get_goal registers propose_goal and clarifies through to a committed Goal", async () => {
	// The exact repro from the issue: `--exclude-tools get_goal` with clarification
	// enabled. Before the fix this session was told another extension owned
	// `propose_goal`, the tool was never registered, and `/goal` refused.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { excludeTools: "get_goal" });
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
		await session.waitForNotify((record) => record.message.includes("Objective clarification started"));

		// The interview really ran, so the model's real `propose_goal` call follows.
		await session.prompt("Objective: two steps to a sample project. Constraints: none. Acceptance criteria: two checks.");
		const request = await answerConfirmation(session, (prefill) => prefill);
		assert.equal(request.prefill, `Title: ${DRAFT_TITLE}\n\n${DRAFT_OBJECTIVE}`);
		await session.waitForToolResult("propose_goal", 1);
		await session.waitForNotify((record) => record.message.includes("created and activated"));

		// The save is the one creation transition, with exactly the saved document.
		const created = goalSnapshots(readSessionEntries(await session.sessionFile())).at(-1).data.goal;
		assert.equal(created.title, DRAFT_TITLE);
		assert.equal(created.objective, DRAFT_OBJECTIVE);
		assert.equal(created.origin, "command");
		assert.equal(created.status, "active");
		assert.equal(await runCount(session), 2, "the interview and the kickoff, and nothing else");

		// Stop the loop deliberately: hold the kickoff, pause, then release it.
		await session.prompt("/goal:pause");
		await session.waitForNotify((record) => record.message.includes("paused (revision"));
		writeFileSync(gate, "", "utf8");
		await waitForNextSettle(session);

		// The registry read produced no false foreign-owner notice anywhere, and the
		// session really did declare `propose_goal` to the model.
		const tools = await declaredTools(dirs);
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a tool policy was reported as a foreign owner: ${message}`);
			assert.ok(!message.includes("did not register propose_goal"), `a false registration failure: ${message}`);
		}
		assert.ok(tools.includes("propose_goal"), `propose_goal must be in the model's tool set: ${JSON.stringify(tools)}`);
		assert.equal(tools.includes("get_goal"), false, "the session's own policy still hides get_goal from the model");
		assert.equal(
			clarificationEntries(readSessionEntries(await session.sessionFile())).at(-1).data.pending,
			null,
			"the committed clarification is durably cleared",
		);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a session whose policy hides propose_goal is silent at startup and refuses /goal with cause-neutral wording", async () => {
	// Nothing went wrong here, so nothing is said: the tool registered and the
	// session's own policy keeps it out of the model's reach. `/goal` is the seam
	// that explains it, and it must name every cause rather than assert one.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { excludeTools: "propose_goal" });
		script([], session);

		// Silent startup: no registration notice of any kind, in either direction.
		const tools = await declaredTools(dirs);
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a tool policy was reported as a foreign owner: ${message}`);
			assert.ok(!message.includes("propose_goal"), `startup spoke about a hidden tool: ${message}`);
		}
		assert.equal(tools.includes("propose_goal"), false, "the policy keeps the tool from the model");

		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		// The frame does not claim the registration failed: this one landed.
		assert.match(refusal.message, /propose_goal tool is not available for this session/);
		// All six causes are named, and none of them is asserted as *the* cause.
		assert.match(refusal.message, /another extension already owns the propose_goal name/);
		assert.match(refusal.message, /the registration itself failed/);
		assert.match(refusal.message, /this session's tool policy \(--tools \/ --exclude-tools\) keeps the tool out of the model's reach/);
		assert.match(refusal.message, /this session's active tool loadout does not declare it/);
		assert.match(refusal.message, /another extension took the tool over after pi-goal registered it/);
		assert.match(refusal.message, /the tool registry could not be read/);
		assert.match(refusal.message, /adjust the session's tool policy or its active tool loadout/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.match(refusal.message, /set goal\.clarifyOnCreate to false/);
		// And the one cause this session actually has is named last, so the list teaches
		// and the tail diagnoses.
		assert.match(refusal.message, /This session: this session's tool policy \(--tools \/ --exclude-tools\) hides the propose_goal tool\./);
		// Fail closed: no Goal, no interview that could never be confirmed, no editor.
		// The branch is read through Pi's own seam, because a session whose only
		// command was refused has written no session file to read.
		const { entries } = await session.getEntries();
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(
			session.records.filter((record) => record.type === "extension_ui_request" && record.method === "editor").length,
			0,
			"no editor was opened",
		);
		assert.equal(runCount(session), 0, "the refusal started no run");

		assertCleanRun(session);
		assertStepsConsumed(session, 0);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a hidden get_goal still lets the opt-in plan tool register and be declared", async () => {
	// The same rule on the other registration: hiding `get_goal` says nothing about
	// `update_plan`, so the plan tool lands and is taught to the model.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { settings: PLAN_TOOL_ON, excludeTools: "get_goal" });
		script([{ text: "Kickoff answer." }, { hang: true }], session);

		const tools = await declaredTools(dirs);
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a tool policy was reported as a foreign owner: ${message}`);
			assert.ok(!message.includes("did not register update_plan"), `a false registration failure: ${message}`);
		}
		assert.ok(tools.includes("update_plan"), `update_plan must be declared to the model: ${JSON.stringify(tools)}`);

		// The Continuation still teaches it, which is what the registration flag gates.
		await session.prompt("/goal --no-budget Ship the release notes page");
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitFor(
			"the continuation run started",
			(records) => (records.filter((record) => record.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);
		const continuations = continuationEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(continuations.length, 1, "exactly one Continuation before the abort");
		assert.ok(
			continuations.every((entry) => String(entry.content).includes("Progress plan (optional, update_plan):")),
			"an enabled session's Continuation still names the plan tool",
		);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a session whose policy hides update_plan is silent and no Continuation names it", async () => {
	// The plan tool's half of the same rule: a registration the session's policy
	// hides is nobody's fault, so startup says nothing and the Continuation stays
	// quiet rather than naming a tool the model cannot call.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { settings: PLAN_TOOL_ON, excludeTools: "update_plan" });
		script([{ text: "Kickoff answer." }, { hang: true }], session);
		await session.prompt("/goal --no-budget Ship the release notes page");
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitFor(
			"the continuation run started",
			(records) => (records.filter((record) => record.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const tools = await declaredTools(dirs);
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a tool policy was reported as a foreign owner: ${message}`);
			assert.ok(!message.includes("update_plan"), `startup spoke about a hidden tool: ${message}`);
		}
		assert.equal(tools.includes("update_plan"), false, "the policy keeps the tool from the model");

		const continuations = continuationEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(continuations.length, 1, "exactly one Continuation before the abort");
		for (const entry of continuations) {
			assert.ok(!String(entry.content).includes("update_plan"), "no Continuation names a tool the policy hides");
		}

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that takes propose_goal on turn_start is never mistaken for pi-goal's own", async () => {
	// The reachable takeover. Pi keeps the first *extension in load order* that
	// declares a name, so this peer — loaded before pi-goal — wins the `propose_goal`
	// name even though pi-goal registered it first, and it wins it on `turn_start`,
	// after pi-goal has already confirmed its own registration. The tool under test
	// must never vouch for itself: with nothing else visible to identify pi-goal, the
	// only honest answers are "not mine" or "cannot tell", never "mine".
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, {
			excludeTools: HIDE_GOAL_TOOLS,
			preExtensions: [PROPOSE_GOAL_LATE_PEER],
		});
		script(
			[
				{ text: "Warm answer." },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "The peer tool answered." },
			],
			session,
		);
		await session.prompt("warm the session up so the peer's turn_start has run");
		await session.waitForSettled(1);

		// Nothing warned at startup, and nothing warned about the takeover either:
		// pi-goal registered first and legitimately owned the name at session start.
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a false foreign owner: ${message}`);
			assert.ok(!message.includes("did not register propose_goal"), `a false registration failure: ${message}`);
		}

		// `/goal` now fails closed instead of recording an interview that the peer's
		// tool could never confirm.
		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(
			notifyMessages(session).some((message) => message.includes("Objective clarification started")),
			false,
			"no interview was started for a confirmation this session cannot open",
		);
		const { entries } = await session.getEntries();
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");

		// The model-visible `propose_goal` really is the peer's: a call to it returns
		// the peer's own result, never pi-goal's confirmation flow.
		const tools = await declaredTools(dirs);
		assert.ok(tools.includes("propose_goal"), `the name is still declared: ${JSON.stringify(tools)}`);
		await session.prompt("Try to propose a Goal for this idea.");
		const call = await session.waitForToolResult("propose_goal", 1);
		assert.equal(call.isError, false, "the peer's own tool runs without error");
		assert.equal(toolTexts(session, "propose_goal").length, 1, "exactly one propose_goal call finalized");
		assert.match(
			toolTexts(session, "propose_goal")[0],
			/peer tool: this is not pi-goal's propose_goal/,
			"the declaration in force is the peer's",
		);
		await waitForNextSettle(session);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that takes update_plan on turn_start is named in no Continuation", async () => {
	// The plan tool's half of the same seam, and the reason the Continuation gates on
	// live ownership: an automatic Continuation that instructed a tool pi-goal no
	// longer owns would waste a Goal turn and teach the model to ignore the extension.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, {
			settings: PLAN_TOOL_ON,
			excludeTools: HIDE_GOAL_TOOLS,
			preExtensions: [PLAN_LATE_PEER],
		});
		script([{ text: "Kickoff answer." }, { hang: true }], session);
		await session.prompt("/goal --no-budget Ship the release notes page");
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitFor(
			"the continuation run started",
			(records) => (records.filter((record) => record.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a false foreign owner: ${message}`);
			assert.ok(!message.includes("did not register update_plan"), `a false registration failure: ${message}`);
		}
		const continuations = continuationEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(continuations.length, 1, "exactly one Continuation before the abort");
		for (const entry of continuations) {
			assert.ok(
				!String(entry.content).includes("update_plan"),
				"no Continuation names a tool another extension took over",
			);
		}

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that takes get_goal on session_start does not poison pi-goal's identity", async () => {
	// The high finding. Extension handlers run in load order, so a peer loaded
	// before pi-goal registers `get_goal` from its own `session_start` — before
	// pi-goal reads the registry at all — and Pi's load-time duplicate check never
	// sees it. An identity rule that reads pi-goal's own source path out of a Goal
	// tool adopts the peer's path here, and then reports pi-goal's own
	// `propose_goal` as a tool another extension took over. Identity now comes only
	// from a registration this runtime just made, so the stolen `get_goal` is
	// irrelevant and the clarification flow works exactly as it does without it.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { preExtensions: [GET_GOAL_NAME_PEER] });
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
		await session.waitForNotify((record) => record.message.includes("Objective clarification started"));

		// The whole flow still runs: the interview, the model's own `propose_goal`
		// call, and the confirmation editor that commits the Goal.
		await session.prompt("Objective: two steps to a sample project. Constraints: none. Acceptance criteria: two checks.");
		const request = await answerConfirmation(session, (prefill) => prefill);
		assert.equal(request.prefill, `Title: ${DRAFT_TITLE}\n\n${DRAFT_OBJECTIVE}`);
		await session.waitForToolResult("propose_goal", 1);
		await session.waitForNotify((record) => record.message.includes("created and activated"));

		const created = goalSnapshots(readSessionEntries(await session.sessionFile())).at(-1).data.goal;
		assert.equal(created.title, DRAFT_TITLE);
		assert.equal(created.objective, DRAFT_OBJECTIVE);
		assert.equal(created.origin, "command");

		await session.prompt("/goal:pause");
		await session.waitForNotify((record) => record.message.includes("paused (revision"));
		writeFileSync(gate, "", "utf8");
		await waitForNextSettle(session);

		// The stolen `get_goal` produced no warning about pi-goal's own tools.
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes("took its place"), `pi-goal warned about its own tool: ${message}`);
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a false foreign owner: ${message}`);
		}
		const tools = await declaredTools(dirs);
		assert.ok(tools.includes("propose_goal"), `propose_goal must be declared: ${JSON.stringify(tools)}`);
		assert.equal(tools.includes("get_goal"), true, "the peer really did take the get_goal name");

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that owns get_goal and propose_goal is reported accurately, and a restored clarification is not offered", async () => {
	// The same poison with the peer also declaring `propose_goal`, against a branch
	// that already holds a pending clarification. The startup warning must name the
	// real cause (a foreign owner), `/goal` must refuse with a true cause, and the
	// durable interview must not be advertised as offerable — the confirmation
	// editor it would open belongs to the peer.
	const dirs = scratch();
	let first;
	let second;
	try {
		// Process one records the pending clarification on a branch of its own.
		first = await startSession(dirs);
		script([{ text: "What should be different when this is done?" }], first);
		await first.prompt(`/goal ${IDEA}`);
		await waitForNextSettle(first);
		await first.waitForNotify((record) => record.message.includes("Objective clarification started"));
		const sessionFile = await first.sessionFile();
		const { copyFileSync } = await import("node:fs");
		const resumed = join(dirs.sessionDir, "resumed.jsonl");
		copyFileSync(sessionFile, resumed);
		await first.stop();
		first = undefined;

		// Process two reopens that branch with the peer loaded before pi-goal.
		second = await PiRpcSession.start({
			cwd: dirs.workDir,
			sessionDir: dirs.sessionDir,
			agentDir: dirs.agentDir,
			sessionFile: resumed,
			settings: CLARIFY_SETTINGS,
			preExtensions: [GOAL_NAMES_PEER],
			env: { PI_GOAL_TEST_ACTIVE_TOOLS: join(dirs.workDir, "active-tools.json") },
			extraExtensions: [ACTIVE_TOOLS_PEER],
		});
		script([{ text: "Reviewing." }], second);

		const declined = await second.waitForNotify((record) =>
			record.message.includes("pi-goal did not register propose_goal"),
		);
		assert.match(declined.message, /another extension already provides a tool with that name/);
		assert.match(declined.message, /pi-goal will not replace it/);
		for (const message of notifyMessages(second)) {
			assert.ok(!message.includes("took its place"), `pi-goal warned about its own tool: ${message}`);
		}
		assert.equal(
			notifyMessages(second).some((message) => message.includes("Objective clarification restored")),
			false,
			"an interview this session cannot confirm is not offered",
		);

		// Bare `/goal` reports the plain no-Goal state, never an open clarification.
		await second.prompt("/goal");
		const status = await second.waitForNotify((record) => record.message.includes("No Goal is set"));
		assert.ok(!status.message.includes("An Objective clarification is open"), status.message);

		// And a fresh `/goal` refuses with a true cause.
		await second.prompt(`/goal ${IDEA}`);
		const refusal = await second.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		assert.match(refusal.message, /another extension already owns the propose_goal name/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);

		const { entries } = await second.getEntries();
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");
		assert.equal(
			clarificationEntries(entries).length,
			1,
			"the durable interview from the first process is left untouched",
		);
		assert.equal(runCount(second), 0, "nothing offered an interview, so no run started");
		assert.equal(editorRequests(second).length, 0, "no confirmation editor was opened");

		assertCleanRun(second);
		assertStepsConsumed(second, 0);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await cleanup(dirs, first, second);
	}
});

test("a peer that squats propose_goal from a loadout hook never gets it believed", async () => {
	// High 1 of the review, and the reason identity is object identity. `registerTool`
	// synchronously refreshes the registry, and applying the active loadout runs the
	// `prepareLoadout` hooks of the tools declared to the model — so this peer's hook
	// runs *inside* pi-goal's own `registerTool` call, between its ownership check and
	// its confirmation, and wins the name by load order. No cache, witness or source
	// path survives that; the schema object does, because the peer cannot present it.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { preExtensions: [PROPOSE_GOAL_LOADOUT_PEER] });
		script(
			[
				{ text: "Warm answer." },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "The peer tool answered." },
			],
			session,
		);
		await session.prompt("warm the session up so the provider is one request in");
		await session.waitForSettled(1);

		// The squat is reported as what it is: a takeover of a tool this runtime
		// registered, never as a foreign owner and never as nothing at all.
		const takeover = await session.waitForNotify((record) =>
			record.message.includes("pi-goal registered propose_goal, but another extension's tool of the same name took its place"),
		);
		assert.equal(takeover.notifyType, "warning");
		assert.match(takeover.message, /will refuse rather than create a Goal/);

		// `/goal` refuses with a true cause, and no interview is recorded or offered.
		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		assert.match(refusal.message, /another extension took over the propose_goal tool/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(
			notifyMessages(session).some((message) => message.includes("Objective clarification started")),
			false,
			"no interview was started for a confirmation this session cannot open",
		);
		const { entries } = await session.getEntries();
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");

		// The model-visible `propose_goal` is the peer's, so a call reaches the peer.
		const tools = await declaredTools(dirs);
		assert.ok(tools.includes("propose_goal"), `the name is still declared: ${JSON.stringify(tools)}`);
		await session.prompt("Try to propose a Goal for this idea.");
		const call = await session.waitForToolResult("propose_goal", 1);
		assert.equal(call.isError, false, "the peer's own tool runs without error");
		assert.match(
			toolTexts(session, "propose_goal")[0],
			/peer tool: this is not pi-goal's propose_goal/,
			"the declaration in force is the peer's",
		);
		await waitForNextSettle(session);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that deactivates propose_goal leaves the interview unoffered", async () => {
	// High 3 of the review. `getAllTools()` still lists a tool a peer removed with
	// `pi.setActiveTools()`, so a rule that only asked the registry would keep
	// promising a tool the model can no longer call: the interview would be recorded
	// and sent, and its confirmation could never be opened.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { extraExtensions: [PROPOSE_GOAL_DEACTIVATE_PEER] });
		script([{ text: "Warm answer." }, { text: "After the refusal." }], session);
		// The probe records the loadout when a run starts, so warm the session up
		// before reading it: the peer's deactivation happens on its own session_start.
		await session.prompt("warm the session up so the peer's loadout change is recorded");
		await session.waitForSettled(1);

		// The registration succeeded and nothing warned: the peer only changed the
		// loadout, which is nobody's fault.
		const tools = await declaredTools(dirs);
		assert.equal(tools.includes("propose_goal"), false, "the peer removed the tool from the model's loadout");
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a false foreign owner: ${message}`);
			assert.ok(!message.includes("took its place"), `a false takeover: ${message}`);
		}

		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		assert.match(refusal.message, /not in this session's active tool loadout/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(
			notifyMessages(session).some((message) => message.includes("Objective clarification started")),
			false,
			"no interview was recorded for a tool the model cannot call",
		);
		const { entries } = await session.getEntries();
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");
		assert.equal(runCount(session), 1, "only the warm-up prompt ran");

		assertCleanRun(session);
		assertStepsConsumed(session, 1);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that deactivates update_plan leaves it out of every Continuation", async () => {
	// The plan tool's half of High 3, and the reason the Continuation gates on live
	// availability: an automatic Continuation that instructed a tool the model cannot
	// call would waste a Goal turn and teach the model to ignore the extension.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, {
			settings: PLAN_TOOL_ON,
			extraExtensions: [PLAN_DEACTIVATE_PEER],
		});
		script([{ text: "Kickoff answer." }, { hang: true }], session);
		await session.prompt("/goal --no-budget Ship the release notes page");
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitFor(
			"the continuation run started",
			(records) => (records.filter((record) => record.type === "agent_start").length >= 2 ? true : undefined),
		);
		await session.sendSimple("abort");
		await session.waitForSettled(1);

		const tools = await declaredTools(dirs);
		assert.equal(tools.includes("update_plan"), false, "the peer removed the tool from the model's loadout");
		const continuations = continuationEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(continuations.length, 1, "exactly one Continuation before the abort");
		for (const entry of continuations) {
			assert.ok(!String(entry.content).includes("update_plan"), "no Continuation names a tool the model cannot call");
		}

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});

test("a peer that copies the schema reference cannot copy the module path", async () => {
	// High of the fourth review, through real Pi. `getAllTools()` publishes every
	// tool's `parameters` object to every extension, so this peer copies pi-goal's own
	// schema reference and re-registers `propose_goal` with it from a `prepareLoadout`
	// hook that runs inside pi-goal's own `registerTool` call. Object identity alone
	// would believe it; the module path, which Pi assigns from the registering
	// extension's file, is the half it cannot copy.
	const dirs = scratch();
	let session;
	try {
		session = await startSession(dirs, { preExtensions: [PROPOSE_GOAL_FORGING_PEER] });
		script(
			[
				{ text: "Warm answer." },
				{ toolCalls: [{ name: "propose_goal", args: { title: DRAFT_TITLE, objective: DRAFT_OBJECTIVE } }] },
				{ text: "The peer tool answered." },
			],
			session,
		);
		await session.prompt("warm the session up so the provider is one request in");
		await session.waitForSettled(1);

		// Nothing claims pi-goal owns the tool: the forged declaration is reported as a
		// takeover of a tool this runtime registered.
		const takeover = await session.waitForNotify((record) =>
			record.message.includes("pi-goal registered propose_goal, but another extension's tool of the same name took its place"),
		);
		assert.equal(takeover.notifyType, "warning");
		assert.match(takeover.message, /will refuse rather than create a Goal/);
		for (const message of notifyMessages(session)) {
			assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a false foreign owner: ${message}`);
		}

		// `/goal` refuses with the takeover named, and no interview is recorded.
		const response = await session.prompt(`/goal ${IDEA}`);
		assert.equal(response.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) =>
			record.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.equal(refusal.notifyType, "error");
		assert.match(refusal.message, /another extension took over the propose_goal tool/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(
			notifyMessages(session).some((message) => message.includes("Objective clarification started")),
			false,
			"no interview was started for a confirmation this session cannot open",
		);
		const { entries } = await session.getEntries();
		assert.equal(clarificationEntries(entries).length, 0, "no pending clarification was recorded");
		assert.equal(goalSnapshots(entries).length, 0, "no Goal was created");

		// The model-visible `propose_goal` is the peer's, so a call reaches the peer —
		// and pi-goal never believed it owned the tool that ran.
		const tools = await declaredTools(dirs);
		assert.ok(tools.includes("propose_goal"), `the name is still declared: ${JSON.stringify(tools)}`);
		await session.prompt("Try to propose a Goal for this idea.");
		const call = await session.waitForToolResult("propose_goal", 1);
		assert.equal(call.isError, false, "the peer's own tool runs without error");
		assert.match(
			toolTexts(session, "propose_goal")[0],
			/peer tool: this is not pi-goal's propose_goal/,
			"the declaration in force is the peer's",
		);
		await waitForNextSettle(session);

		assertCleanRun(session);
		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await cleanup(dirs, session);
	}
});
