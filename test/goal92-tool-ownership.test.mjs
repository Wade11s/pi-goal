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
	const { settings, ...rest } = options;
	return PiRpcSession.start({
		cwd: dirs.workDir,
		sessionDir: dirs.sessionDir,
		agentDir: dirs.agentDir,
		settings: settings ?? CLARIFY_SETTINGS,
		env: { PI_GOAL_TEST_ACTIVE_TOOLS: join(dirs.workDir, "active-tools.json") },
		extraExtensions: [ACTIVE_TOOLS_PEER],
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
		// All three causes are named, and none of them is asserted as *the* cause.
		assert.match(refusal.message, /another extension already owns the propose_goal name/);
		assert.match(refusal.message, /the registration itself failed/);
		assert.match(refusal.message, /this session's tool policy \(--tools \/ --exclude-tools\) keeps the tool out of the model's reach/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.match(refusal.message, /set goal\.clarifyOnCreate to false/);
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
