/**
 * Issue #53: the optional structured progress-plan tool.
 *
 * The plan tool is a convenience layered on Pi's registered-tool seam, so every
 * test here asserts public behavior only: the tool declarations Pi puts in the
 * model's context, real model-issued tool calls through a real `pi --mode rpc`
 * subprocess, the persisted tool-result `details` on the session branch, the
 * durable Goal snapshots, the Continuation wording, and the accounted usage.
 *
 * The properties that matter are all about what the tool must *not* become:
 *
 * - it is absent by default — not registered, not in the system prompt, and not
 *   named by any Continuation;
 * - it validates its steps before anything is persisted, so a refused plan
 *   leaves the durable record untouched;
 * - its durability is the ordinary tool result, which survives a restart and is
 *   visible to the model in its own context, with no second Goal record;
 * - it never touches the Lifecycle: a plan that marks every step completed
 *   leaves the Goal active, and only `update_goal` can complete it;
 * - it is accounted like any other tool call, with no plan-specific branch;
 * - it never replaces another extension's tool of the same name.
 *
 * Two rules keep the RPC scenarios deterministic, and both come from how fast the
 * scripted provider is: a scenario that needs to assert *mid-run* state ends its
 * script with a `hang` step and stops the loop with an explicit abort, so nothing
 * can run past the assertion; a scenario that asserts final state waits for the
 * settlement that ends it. Every script is sized exactly, and every test ends with
 * `assertCleanRun()` or `assertStepsConsumed()` naming the expected aborted
 * outcome, so a green result can only come from the Goal lifecycle and never from
 * a scripted-provider error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assertStepsConsumed,
	continuationEntries,
	goalSnapshots,
	lastGoalSnapshot,
	liveUsage,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";
import { formatContinuationMessage } from "../src/goal.ts";
import {
	MAX_PLAN_STEP_LENGTH,
	MAX_PLAN_STEPS,
	PLAN_TOOL_NAME,
	formatPlanMessage,
	formatPlanNoGoalMessage,
	parsePlanToolSettings,
	validatePlanArgument,
} from "../src/plan.ts";

const OBJECTIVE = "Ship the release notes page";
/** The opt-in, spelled the way a user configures it in Pi settings. */
const PLAN_TOOL_ON = { goal: { planTool: true } };
/** A test-only extension that already owns the `update_plan` name. */
const PLAN_NAME_PEER = join(import.meta.dirname, "extensions", "plan-name-peer.ts");

/** A well-formed three-step plan with exactly one step in progress. */
const PLAN = [
	{ step: "Write the failing test", status: "completed" },
	{ step: "Implement the plan tool", status: "in_progress" },
	{ step: "Document the tool", status: "pending" },
];
/** The same plan with every step completed — narration, never a completion. */
const ALL_COMPLETED = PLAN.map((step) => ({ ...step, status: "completed" }));
const REPLACEMENT_PLAN = [
	{ step: "Re-read the durable record", status: "completed" },
	{ step: "Write the follow-up tests", status: "in_progress" },
];
/** The accounted tokens of the plan turn: 20 input + 6 output + 3 cache writes. */
const PLAN_TURN_TOKENS = 20 + 6 + 3;
/** The accounted tokens of every other scripted step, and of the kickoff. */
const PLAIN_STEP_TOKENS = 10 + 5;
const KICKOFF_TOKENS = 10 + 4;

/** Tool results for one tool, in the order the calls finalized. */
function toolResults(session, toolName) {
	return session.records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
}

/** The text a finalized tool call returned to the model. */
function toolText(result) {
	return String(result.content?.[0]?.text ?? "");
}

/** Every persisted `update_plan` tool-result entry on the branch, in append order. */
function planEntries(entries) {
	return entries.filter(
		(entry) =>
			entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === PLAN_TOOL_NAME,
	);
}

/** The newest durable plan record on the branch, or undefined when none stands. */
function durablePlan(entries) {
	const records = planEntries(entries)
		.map((entry) => entry.message.details?.plan)
		.filter(Boolean);
	return records.length ? records[records.length - 1] : undefined;
}

/** The `tools` section of the system prompt Pi declares for the model. */
async function declaredTools(session) {
	const { messages } = await session.sendSimple("get_messages");
	const system = messages.find((message) => message.role === "system");
	return String(system?.sections?.tools ?? "");
}

/** The `rules` section of the system prompt, which carries the tool guidelines. */
async function declaredRules(session) {
	const { messages } = await session.sendSimple("get_messages");
	const system = messages.find((message) => message.role === "system");
	return String(system?.sections?.rules ?? "");
}

/** The tool-result messages the model can see, from Pi's own context projection. */
async function visibleToolResults(session) {
	const { messages } = await session.sendSimple("get_messages");
	return messages.filter((message) => message.role === "toolResult");
}

/**
 * Stop an active Goal's continuation loop deliberately.
 *
 * A missing scripted step would also stop it, but that settles on a provider
 * error instead of on the Goal lifecycle, so the loop is always stopped by an
 * explicit abort whose outcome the caller asserts.
 */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((record) => record.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/** A Goal record for the pure formatter tests. */
function record(overrides = {}) {
	return {
		id: "goal_abcd1234",
		objective: OBJECTIVE,
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		revision: 1,
		...overrides,
	};
}

/**
 * The settings a scenario runs with.
 *
 * The key's *presence* decides, not its value: `{ settings: undefined }` means
 * "write no settings file at all", which is the unconfigured default the disabled
 * cases need, while omitting the key opts in.
 */
function settingsFor(options) {
	return "settings" in options ? options.settings : PLAN_TOOL_ON;
}

/**
 * A Goal whose first automatic turn calls the plan tool and is then held open.
 *
 * The `hang` step is what makes the scenario assertable: the tool result, the
 * durable plan record, and the Goal snapshot are all read while the Goal is
 * provably still active and still the session's only Goal, and the abort stops
 * the loop instead of a missing scripted step settling it on a provider error.
 */
async function planTurnScenario(options = {}) {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({
		cwd: workDir,
		settings: settingsFor(options),
		extraExtensions: options.extraExtensions ?? [],
	});
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: PLAN_TOOL_NAME, args: options.args ?? { plan: options.plan ?? PLAN } }] },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitForToolResult(PLAN_TOOL_NAME, 1);
		await abortActiveLoop(session, 2);
		return { session, workDir, entries: readSessionEntries(await session.sessionFile()) };
	} catch (error) {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		throw error;
	}
}

/**
 * A Goal that takes one plan turn and is then completed by the model.
 *
 * Five provider responses in three runs — the kickoff, the Continuation that
 * calls the plan tool, and the Continuation that completes the Goal. Waiting for
 * the third settlement is what makes the final state readable, so the accounting
 * and Lifecycle assertions all describe a run that is provably over.
 */
async function completedPlanScenario(options = {}) {
	const plan = options.plan ?? PLAN;
	const planArgs = options.planArgs ?? { plan };
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({
		cwd: workDir,
		settings: settingsFor(options),
		extraExtensions: options.extraExtensions ?? [],
	});
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 10, output: 4 } },
			{
				toolCalls: [{ name: PLAN_TOOL_NAME, args: planArgs }],
				usage: { input: 20, output: 6, cacheRead: 40, cacheWrite: 3 },
			},
			{ text: "Kept working.", usage: { input: 10, output: 5 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }], usage: { input: 10, output: 5 } },
			{ text: "Done.", usage: { input: 10, output: 5 } },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await session.waitForToolResult(PLAN_TOOL_NAME, 1);
		await session.waitForToolResult("update_goal", 1);
		// One settlement per chain: Pi treats the kickoff and every Continuation it
		// started for it as one agent execution, so this is the boundary at which the
		// completed Goal's whole run is provably over.
		await session.waitForSettled(1);
		const complete = await waitForSnapshot(
			session,
			(snapshot) => snapshot.data.goal?.status === "complete",
			"the durable completion",
		);
		return { session, workDir, entries: readSessionEntries(await session.sessionFile()), complete };
	} catch (error) {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		throw error;
	}
}

/** Stop a scenario's session and remove its working directory. */
async function stopScenario(scenario) {
	await scenario.session.stop();
	rmSync(scenario.workDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Pure configuration, validation, and wording rules
// ---------------------------------------------------------------------------

test("goal.planTool defaults to off and tolerates absence", () => {
	const off = { enabled: false, problems: [] };
	assert.deepEqual(parsePlanToolSettings(undefined), off);
	assert.deepEqual(parsePlanToolSettings({}), off);
	assert.deepEqual(parsePlanToolSettings({ goal: {} }), off);
	assert.deepEqual(parsePlanToolSettings({ goal: { planTool: false } }), off);
	assert.deepEqual(parsePlanToolSettings(PLAN_TOOL_ON), { enabled: true, problems: [] });
});

test("a malformed setting is reported once and falls back to the off default", () => {
	for (const value of ["false", "true", 0, 1, null, [], {}]) {
		const settings = parsePlanToolSettings({ goal: { planTool: value } });
		assert.equal(settings.enabled, false, `${JSON.stringify(value)} must not silently register the tool`);
		assert.equal(settings.problems.length, 1, `${JSON.stringify(value)} must be reported`);
		assert.match(settings.problems[0], /goal\.planTool must be a boolean/);
		assert.match(settings.problems[0], /leaving the progress-plan tool unregistered/);
	}
	// The settings are read independently, so a broken budget or admission value
	// neither registers the tool nor suppresses it.
	assert.deepEqual(parsePlanToolSettings({ goal: { enabled: "yes", maxTokenBudget: -5, planTool: true } }), {
		enabled: true,
		problems: [],
	});
});

test("an ordered plan is accepted as given and counted per status", () => {
	const validation = validatePlanArgument(PLAN);
	assert.equal(validation.ok, true);
	if (!validation.ok) return;
	// Order is the model's, never sorted or regrouped: a plan is read top to bottom.
	assert.deepEqual(
		validation.plan.steps.map((step) => step.step),
		["Write the failing test", "Implement the plan tool", "Document the tool"],
	);
	assert.deepEqual(validation.plan.counts, { total: 3, completed: 1, inProgress: 1, pending: 1 });
	// Step text is trimmed, so a padded step persists as its content.
	assert.deepEqual(validatePlanArgument([{ step: "  padded  ", status: "pending" }]), {
		ok: true,
		plan: {
			steps: [{ step: "padded", status: "pending" }],
			counts: { total: 1, completed: 0, inProgress: 0, pending: 1 },
		},
	});
});

test("at most one step may be in progress", () => {
	const validation = validatePlanArgument([
		{ step: "first", status: "in_progress" },
		{ step: "second", status: "in_progress" },
	]);
	assert.equal(validation.ok, false);
	if (validation.ok) return;
	assert.match(validation.error, /2 steps are in_progress, and at most one may be/);
	assert.match(validation.error, /Mark the others pending or completed/);
	// One in-progress step is fine, and so is none at all.
	assert.equal(validatePlanArgument([{ step: "only", status: "in_progress" }]).ok, true);
	assert.equal(validatePlanArgument([{ step: "none yet", status: "pending" }]).ok, true);
});

test("every other step rule is refused before anything is persisted", () => {
	const cases = [
		["a missing plan", undefined, /plan must be an array of steps/],
		["a non-array plan", "do everything", /plan must be an array of steps/],
		["an empty plan", [], /pass at least one step/],
		[
			"too many steps",
			Array.from({ length: MAX_PLAN_STEPS + 1 }, (_unused, index) => ({ step: `s${index}`, status: "pending" })),
			new RegExp(`at most ${MAX_PLAN_STEPS} steps are accepted, got ${MAX_PLAN_STEPS + 1}`),
		],
		["a non-object step", ["just text"], /step 1 must be an object with a step and a status/],
		["an empty step", [{ step: "   ", status: "pending" }], /step 1 has no text/],
		["a missing step text", [{ status: "pending" }], /step 1 has no text/],
		[
			"an over-long step",
			[{ step: "x".repeat(MAX_PLAN_STEP_LENGTH + 1), status: "pending" }],
			new RegExp(`longer than ${MAX_PLAN_STEP_LENGTH} characters`),
		],
		[
			"an unknown status",
			[{ step: "a", status: "done" }],
			/step 1 has status "done"; a step is pending, in_progress, completed/,
		],
		["a missing status", [{ step: "a" }], /step 1 has status undefined/],
	];
	for (const [name, plan, pattern] of cases) {
		const validation = validatePlanArgument(plan);
		assert.equal(validation.ok, false, `${name} must be refused`);
		if (validation.ok) continue;
		assert.match(validation.error, pattern, `${name}: ${validation.error}`);
		assert.match(validation.error, /^Plan not recorded:/, `${name} names the outcome`);
	}
	// Exactly at each bound is accepted.
	assert.equal(
		validatePlanArgument(
			Array.from({ length: MAX_PLAN_STEPS }, (_unused, index) => ({ step: `s${index}`, status: "pending" })),
		).ok,
		true,
	);
	assert.equal(validatePlanArgument([{ step: "x".repeat(MAX_PLAN_STEP_LENGTH), status: "pending" }]).ok, true);
});

test("a successful plan result restates the plan and denies being Goal state", () => {
	const validation = validatePlanArgument(PLAN);
	assert.equal(validation.ok, true);
	if (!validation.ok) return;
	const text = formatPlanMessage(validation.plan);
	assert.match(text, /^Plan updated \(3 steps: 1 completed, 1 in progress, 1 pending\)\./);
	assert.match(text, /- \[completed\] Write the failing test/);
	assert.match(text, /- \[in_progress\] Implement the plan tool/);
	assert.match(text, /- \[pending\] Document the tool/);
	// The sentence a model that has just marked everything done must read.
	assert.match(text, /progress narration, not Goal state/);
	assert.match(text, /does not change the Goal's Lifecycle status/);
	assert.match(text, /marking every step completed does not complete the Goal/);
	assert.match(text, /Only update_goal with action complete does that/);
	// One step reads as singular.
	assert.match(
		formatPlanMessage({
			steps: [{ step: "only", status: "pending" }],
			counts: { total: 1, completed: 0, inProgress: 0, pending: 1 },
		}),
		/1 step:/,
	);
});

test("the Continuation names the plan tool only when it is registered and enabled", () => {
	const withoutPlan = formatContinuationMessage(record());
	assert.ok(!withoutPlan.includes(PLAN_TOOL_NAME), "the default Continuation must not name the tool");
	assert.ok(!withoutPlan.includes("Progress plan"), "the default Continuation has no plan section");
	// An explicit false is the same as an absent option.
	assert.ok(!formatContinuationMessage(record(), { planTool: false }).includes(PLAN_TOOL_NAME));

	const withPlan = formatContinuationMessage(record(), { planTool: true });
	assert.match(withPlan, /^Progress plan \(optional, update_plan\):$/m);
	assert.match(withPlan, /each step pending, in_progress, or completed, with at most one in_progress/);
	assert.match(withPlan, /updating it never changes this Goal's Lifecycle status/);
	assert.match(withPlan, /marking every step completed never completes the Goal/);
	// The plan section is added to the ordinary message, never substituted for it.
	for (const section of ["Evidence audit before continuing", "Completion contract:", "Blocked audit"]) {
		assert.ok(withPlan.includes(section), `the plan section must not displace ${section}`);
		assert.ok(withoutPlan.includes(section), `${section} is part of the ordinary message`);
	}
	// It sits after the completion contract, so a plan can never precede the audit.
	assert.ok(withPlan.indexOf("Progress plan") > withPlan.indexOf("Completion contract:"));
});

// ---------------------------------------------------------------------------
// Registration through a real Pi session
// ---------------------------------------------------------------------------

test("the default setting registers no plan tool and names none", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({ cwd: workDir });
	script([{ toolCalls: [{ name: PLAN_TOOL_NAME, args: { plan: PLAN } }] }, { text: "No plan for me." }], session);
	try {
		await session.prompt("hello there");
		const end = await session.waitForToolResult(PLAN_TOOL_NAME, 1);
		await session.waitForSettled(1);

		// Not declared to the model: neither in the tools section nor in the rules.
		assert.ok(!(await declaredTools(session)).includes(PLAN_TOOL_NAME));
		assert.ok(!(await declaredRules(session)).includes(PLAN_TOOL_NAME));
		// And not callable: Pi refuses the call before any extension runs.
		assert.equal(end.isError, true);
		assert.match(toolText(end.result), new RegExp(`Tool ${PLAN_TOOL_NAME} not found`));
		assert.deepEqual(end.result.details, {}, "an unregistered tool leaves no record behind");

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(planEntries(entries).length, 1, "only the refused call itself");
		assert.equal(durablePlan(entries), undefined, "no plan record was persisted");
		assert.equal(goalSnapshots(entries).length, 0, "nothing Goal-related happened at all");
		assertStepsConsumed(session, 2);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("a malformed setting is reported once, registers nothing, and names nothing", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({ cwd: workDir, settings: { goal: { planTool: "yes" } } });
	script([{ toolCalls: [{ name: PLAN_TOOL_NAME, args: { plan: PLAN } }] }, { text: "No plan for me." }], session);
	try {
		await session.prompt("hello there");
		const end = await session.waitForToolResult(PLAN_TOOL_NAME, 1);
		await session.waitForSettled(1);

		const problem = await session.waitForNotify((record) => record.message.includes("goal.planTool must be a boolean"));
		assert.equal(problem.notifyType, "warning");
		assert.match(problem.message, /leaving the progress-plan tool unregistered/);
		assert.equal(
			session.records.filter(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					record.message.includes("goal.planTool"),
			).length,
			1,
			"the mistake is reported exactly once",
		);
		assert.equal(end.isError, true);
		assert.match(toolText(end.result), new RegExp(`Tool ${PLAN_TOOL_NAME} not found`));
		assert.ok(!(await declaredTools(session)).includes(PLAN_TOOL_NAME));
		assert.equal(durablePlan(readSessionEntries(await session.sessionFile())), undefined);
		assertStepsConsumed(session, 2);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
	}
});

test("the opt-in registers the tool, declares it to the model, and records the plan", async () => {
	const scenario = await planTurnScenario();
	try {
		const end = toolResults(scenario.session, PLAN_TOOL_NAME)[0];
		assert.equal(end.isError, false, "the plan call succeeds");

		// Declared through Pi's own registered-tool seam: the tools section and the
		// guideline bullets are the model-facing surface of the registration.
		const tools = await declaredTools(scenario.session);
		assert.ok(tools.includes(`- ${PLAN_TOOL_NAME}:`), `not declared: ${tools}`);
		assert.ok(tools.includes("ordered progress steps"));
		const rules = await declaredRules(scenario.session);
		assert.ok(rules.includes("Call update_plan when the current Goal has several ordered steps"));
		assert.ok(rules.includes("A plan update is progress narration, not Goal state"));

		// The result carries the plan in its details, and restates it in text.
		assert.deepEqual(end.result.details, {
			plan: { steps: PLAN, counts: { total: 3, completed: 1, inProgress: 1, pending: 1 } },
		});
		assert.deepEqual(end.result.structuredContent, end.result.details);
		assert.match(toolText(end.result), /Plan updated \(3 steps: 1 completed, 1 in progress, 1 pending\)\./);

		// Durable on the session branch as an ordinary tool result.
		assert.equal(planEntries(scenario.entries).length, 1);
		assert.deepEqual(durablePlan(scenario.entries), end.result.details.plan);

		// The Goal itself is untouched: one snapshot, still active, and the
		// continuation loop is still running when the abort stops it.
		assert.equal(goalSnapshots(scenario.entries).length, 1, "a plan call writes no Goal snapshot");
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.status, "active");
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.revision, 0);
		assert.equal(continuationEntries(scenario.entries).length, 1, "the plan turn is a normal Goal turn");
		assert.equal(runCount(scenario.session), 2, "the kickoff and the plan turn");
		assertStepsConsumed(scenario.session, 3, [{ stopReason: "aborted" }]);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});

test("a plan call without a Goal is refused and records nothing", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({ cwd: workDir, settings: PLAN_TOOL_ON });
	script([{ toolCalls: [{ name: PLAN_TOOL_NAME, args: { plan: PLAN } }] }, { text: "Understood." }], session);
	try {
		await session.prompt("hello there");
		const end = await session.waitForToolResult(PLAN_TOOL_NAME, 1);
		await session.waitForSettled(1);

		assert.equal(end.isError, true, "a plan with no Goal to describe is refused");
		assert.match(toolText(end.result), /^Plan not recorded: no Goal is set for this session/);
		assert.match(toolText(end.result), /use get_goal to inspect it, or \/goal <objective> to set one/);
		assert.equal(toolText(end.result), formatPlanNoGoalMessage());
		assert.deepEqual(end.result.details, {}, "a refused plan persists no record");
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(planEntries(entries).length, 1);
		assert.equal(durablePlan(entries), undefined);
		assert.equal(goalSnapshots(entries).length, 0);
		assertStepsConsumed(session, 2);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Step validation through real model tool calls
// ---------------------------------------------------------------------------

test("a plan with two in-progress steps is refused and leaves the Goal alone", async () => {
	const scenario = await planTurnScenario({
		args: {
			plan: [
				{ step: "Implement the tool", status: "in_progress" },
				{ step: "Document the tool", status: "in_progress" },
			],
		},
	});
	try {
		const end = toolResults(scenario.session, PLAN_TOOL_NAME)[0];
		assert.equal(end.isError, true);
		assert.match(toolText(end.result), /2 steps are in_progress, and at most one may be/);
		assert.match(toolText(end.result), /Mark the others pending or completed/);
		assert.deepEqual(end.result.details, {}, "the refused plan persists no record");
		assert.equal(durablePlan(scenario.entries), undefined, "no plan record stands on the branch");

		// The Goal is untouched by the refusal: still active, same revision, and the
		// continuation loop is still running when the abort stops it.
		assert.equal(goalSnapshots(scenario.entries).length, 1);
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.status, "active");
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.revision, 0);
		assert.equal(continuationEntries(scenario.entries).length, 1);
		assertStepsConsumed(scenario.session, 3, [{ stopReason: "aborted" }]);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});

test("Pi's schema refuses a drifted plan before the extension runs", async () => {
	// The argument schema is the model-facing declaration, so a drifted call is
	// refused there — with the three accepted statuses named — and never reaches
	// the extension's own validation.
	const scenario = await planTurnScenario({ args: { plan: [{ step: "a", status: "done" }] } });
	try {
		const end = toolResults(scenario.session, PLAN_TOOL_NAME)[0];
		assert.equal(end.isError, true);
		assert.match(toolText(end.result), /Validation failed for tool "update_plan"/);
		assert.match(toolText(end.result), /expected one of \["pending","in_progress","completed"\]/);
		assert.deepEqual(end.result.details, {});
		assert.equal(durablePlan(scenario.entries), undefined);
		assert.equal(goalSnapshots(scenario.entries).length, 1);
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.status, "active");
		assertStepsConsumed(scenario.session, 3, [{ stopReason: "aborted" }]);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});

test("the plan list is also accepted under the steps spelling a model drifts into", async () => {
	const scenario = await completedPlanScenario({ planArgs: { steps: PLAN } });
	try {
		const end = toolResults(scenario.session, PLAN_TOOL_NAME)[0];
		assert.equal(end.isError, false, "the alias is accepted rather than wasting a Goal turn");
		assert.deepEqual(durablePlan(scenario.entries), {
			steps: PLAN,
			counts: { total: 3, completed: 1, inProgress: 1, pending: 1 },
		});
		assert.equal(scenario.complete.data.goal.status, "complete");
		assertStepsConsumed(scenario.session, 5);
		assertCleanRun(scenario.session);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});

// ---------------------------------------------------------------------------
// Durability, restart visibility, and accounting
// ---------------------------------------------------------------------------

test("the plan is durable on the branch and visible to the model after a restart", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const sessionsDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-sessions-"));
	const first = await PiRpcSession.start({ cwd: workDir, settings: PLAN_TOOL_ON });
	script(
		[
			{ text: "Kickoff answer." },
			{ toolCalls: [{ name: PLAN_TOOL_NAME, args: { plan: PLAN } }] },
			{ hang: true },
		],
		first,
	);
	let second;
	try {
		await first.prompt(`/goal ${OBJECTIVE}`);
		await first.waitForNotify((record) => record.message.includes("created and activated"));
		await first.waitForToolResult(PLAN_TOOL_NAME, 1);
		await abortActiveLoop(first, 2);
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);

		// Copy the branch into a test-owned directory and reopen it, which is what a
		// restart looks like to the extension.
		const source = await first.sessionFile();
		const copy = join(sessionsDir, basename(source));
		copyFileSync(source, copy);
		second = await PiRpcSession.start({ sessionFile: copy, cwd: workDir, settings: PLAN_TOOL_ON });
		await second.waitForNotify((record) => record.message.includes("restored (active)"));

		// The registration is re-made for the restored session, and the plan the
		// first process recorded is still on the branch and in the model's context.
		assert.ok((await declaredTools(second)).includes(`- ${PLAN_TOOL_NAME}:`));
		const visible = await visibleToolResults(second);
		const planResult = visible.find((message) => message.toolName === PLAN_TOOL_NAME);
		assert.ok(planResult, "the plan tool result is part of the model's context after the restart");
		assert.deepEqual(planResult.details.plan, {
			steps: PLAN,
			counts: { total: 3, completed: 1, inProgress: 1, pending: 1 },
		});
		assert.deepEqual(durablePlan(readSessionEntries(copy)), planResult.details.plan);

		// A later plan replaces the record: the newest one stands, and the earlier
		// one stays on the branch as history rather than being rewritten.
		script(
			[
				{ toolCalls: [{ name: PLAN_TOOL_NAME, args: { plan: REPLACEMENT_PLAN } }] },
				{ text: "Plan updated." },
				{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
				{ text: "Done." },
			],
			second,
		);
		await second.prompt("update the plan, then wrap up");
		await second.waitForToolResult(PLAN_TOOL_NAME, 1);
		await second.waitForToolResult("update_goal", 1);
		await second.waitForSettled(1);

		const entries = readSessionEntries(copy);
		assert.equal(planEntries(entries).length, 2, "both records stay on the branch");
		assert.deepEqual(durablePlan(entries), {
			steps: REPLACEMENT_PLAN,
			counts: { total: 2, completed: 1, inProgress: 1, pending: 0 },
		});
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete");
		assert.equal(runCount(second), 2, "the user prompt and the completing continuation");
		assertStepsConsumed(second, 4);
		assertCleanRun(second);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await first.stop();
		await second?.stop();
		rmSync(workDir, { recursive: true, force: true });
		rmSync(sessionsDir, { recursive: true, force: true });
	}
});

test("a plan call is accounted like any other tool call", async () => {
	const scenario = await completedPlanScenario();
	try {
		const usage = scenario.complete.data.goal.usage;
		// The turn that called the plan tool is charged exactly like any other Goal
		// turn: 20 input + 6 output + 3 cache writes. Its 40 cached reads stay
		// visible but outside the total, and the plan tool itself performs no model
		// work, so it contributes no nested usage of its own.
		const accounted = KICKOFF_TOKENS + PLAN_TURN_TOKENS + PLAIN_STEP_TOKENS + PLAIN_STEP_TOKENS;
		assert.equal(usage.totalTokens, accounted);
		assert.equal(usage.inputTokens, 10 + 20 + 10 + 10);
		assert.equal(usage.outputTokens, 4 + 6 + 5 + 5);
		assert.equal(usage.cacheWriteTokens, 3, "cache writes are real consumption");
		assert.equal(usage.cachedReadTokens, 40, "cached reads are reported");
		assert.equal(usage.nestedTokens, 0, "the plan tool reports no usage of its own");
		// The final response after the completion is not Goal work, so it is not
		// charged: the completing turn is the last one the Goal pays for.
		assert.equal(accounted, 14 + 29 + 15 + 15);
		// The live view agrees with the durable one.
		assert.equal(await liveUsage(scenario.session), accounted);
		assertStepsConsumed(scenario.session, 5);
		assertCleanRun(scenario.session);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});

test("a plan-only automatic turn is activity, so it never stops the Goal", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({ cwd: workDir, settings: PLAN_TOOL_ON });
	const planCall = (plan) => ({ toolCalls: [{ name: PLAN_TOOL_NAME, args: { plan } }] });
	script(
		[
			{ text: "Kickoff answer." },
			planCall(PLAN),
			{ text: "First step done." },
			planCall(REPLACEMENT_PLAN),
			{ text: "Second step done." },
			planCall([{ step: "Third step", status: "in_progress" }]),
			{ text: "Third step underway." },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		// Three consecutive automatic Goal turns whose only tool call is a plan
		// update. An activity-free turn would stop the Goal as blocked on the third;
		// a plan call is a tool call, so it counts as activity and the loop runs on.
		await session.waitForToolResult(PLAN_TOOL_NAME, 3);
		await abortActiveLoop(session, 5);

		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(lastGoalSnapshot(entries).data.goal.status, "active", "three plan-only turns never stop the Goal");
		assert.equal(lastGoalSnapshot(entries).data.goal.blocker, undefined, "no Conservative stop was recorded");
		assert.equal(
			session.records.filter(
				(record) =>
					record.type === "extension_ui_request" && record.method === "notify" && record.message.includes("blocked"),
			).length,
			0,
			"no blocked stop was announced",
		);
		assert.equal(continuationEntries(entries).length, 4, "every plan turn was followed by another");
		assert.equal(planEntries(entries).length, 3, "each plan update is its own durable record");
		assertStepsConsumed(session, 8, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Conditional Continuation wording
// ---------------------------------------------------------------------------

/**
 * The first Continuation of a Goal whose loop is then stopped by an abort.
 *
 * One shared setup, because the assertion under test is the Continuation's
 * wording and not the run that produced it.
 */
async function firstContinuation(settings, extraExtensions = []) {
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-plan-work-"));
	const session = await PiRpcSession.start({ cwd: workDir, settings, extraExtensions });
	script([{ text: "Kickoff answer." }, { hang: true }], session);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((record) => record.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const continuations = continuationEntries(readSessionEntries(await session.sessionFile()));
		assert.equal(continuations.length, 1, "exactly one Continuation before the abort");
		return { session, workDir, continuation: String(continuations[0].content) };
	} catch (error) {
		await session.stop();
		rmSync(workDir, { recursive: true, force: true });
		throw error;
	}
}

/** Stop a `firstContinuation` context. */
async function stopContinuationContext(context) {
	await context.session.stop();
	rmSync(context.workDir, { recursive: true, force: true });
}

test("an enabled Continuation teaches the plan tool", async () => {
	const context = await firstContinuation(PLAN_TOOL_ON);
	try {
		assert.match(context.continuation, /Progress plan \(optional, update_plan\):/);
		assert.match(context.continuation, /at most one in_progress/);
		assert.match(context.continuation, /marking every step completed never completes the Goal/);
		assertStepsConsumed(context.session, 2, [{ stopReason: "aborted" }]);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopContinuationContext(context);
	}
});

test("a disabled session's Continuation never names the plan tool", async () => {
	const context = await firstContinuation(undefined);
	try {
		assert.ok(!context.continuation.includes(PLAN_TOOL_NAME), "the default Continuation names no plan tool");
		assert.ok(!context.continuation.includes("Progress plan"));
		// The rest of the contract is untouched by the tool's absence.
		assert.ok(context.continuation.includes("Evidence audit before continuing"));
		assert.ok(context.continuation.includes("Completion contract:"));
		assert.ok(context.continuation.includes("Blocked audit"));
		assertStepsConsumed(context.session, 2, [{ stopReason: "aborted" }]);
		assert.equal(context.session.extensionErrors().length, 0, JSON.stringify(context.session.extensionErrors()));
	} finally {
		await stopContinuationContext(context);
	}
});

test("a peer extension that owns the tool name is never replaced", async () => {
	const scenario = await planTurnScenario({ extraExtensions: [PLAN_NAME_PEER] });
	try {
		// pi-goal declines to register, says why, and never names the tool.
		const declined = await scenario.session.waitForNotify((record) =>
			record.message.includes(`pi-goal did not register ${PLAN_TOOL_NAME}`),
		);
		assert.equal(declined.notifyType, "warning");
		assert.match(declined.message, /another extension already provides a tool with that name/);
		assert.match(declined.message, /pi-goal will not replace it/);
		assert.match(declined.message, /No Continuation will mention the plan tool/);

		// The peer's own tool is the one that runs, with the peer's own result.
		const end = toolResults(scenario.session, PLAN_TOOL_NAME)[0];
		assert.equal(end.isError, false);
		assert.match(toolText(end.result), /the peer extension's update_plan ran/);
		assert.deepEqual(end.result.details, { peer: true }, "pi-goal's plan record was never written");
		assert.equal(durablePlan(scenario.entries), undefined);

		// The Continuation says nothing about a tool pi-goal does not provide, and
		// the Goal lifecycle is entirely unaffected by the collision.
		const continuations = continuationEntries(scenario.entries);
		assert.equal(continuations.length, 1);
		for (const continuation of continuations) {
			assert.ok(!String(continuation.content).includes(PLAN_TOOL_NAME), "no Continuation names the peer's tool");
		}
		assert.equal(goalSnapshots(scenario.entries).length, 1);
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.status, "active");
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.revision, 0);
		assertStepsConsumed(scenario.session, 3, [{ stopReason: "aborted" }]);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});

// ---------------------------------------------------------------------------
// The Completion audit
// ---------------------------------------------------------------------------

test("a plan that marks every step completed still cannot complete the Goal", async () => {
	const scenario = await completedPlanScenario({ plan: ALL_COMPLETED });
	try {
		const planEnd = toolResults(scenario.session, PLAN_TOOL_NAME)[0];
		assert.equal(planEnd.isError, false, "the plan itself is recorded");
		assert.match(toolText(planEnd.result), /Plan updated \(3 steps: 3 completed, 0 in progress, 0 pending\)\./);
		assert.match(toolText(planEnd.result), /marking every step completed does not complete the Goal/);

		// The plan wrote no Lifecycle transition: the only snapshots are the
		// creation and the model's own completion.
		const snapshots = goalSnapshots(scenario.entries);
		assert.equal(snapshots.length, 2, "creation and completion, and nothing in between");
		assert.equal(snapshots[0].data.goal.revision, 0);
		assert.equal(snapshots[1].data.goal.revision, 1);
		assert.equal(snapshots[1].data.goal.status, "complete");

		// The Goal kept working after the "finished" plan: the loop only ended when
		// the model called update_goal, which is the one completion path there is.
		assert.equal(continuationEntries(scenario.entries).length, 2, "the plan turn was followed by another turn");
		const completion = toolResults(scenario.session, "update_goal")[0];
		assert.equal(completion.isError, false);
		assert.equal(completion.result.structuredContent.goal.status, "complete");
		assert.equal(completion.result.structuredContent.goal.revision, 1);
		assert.equal(lastGoalSnapshot(scenario.entries).data.goal.status, "complete");
		assertStepsConsumed(scenario.session, 5);
		assertCleanRun(scenario.session);
		assert.equal(scenario.session.extensionErrors().length, 0, JSON.stringify(scenario.session.extensionErrors()));
	} finally {
		await stopScenario(scenario);
	}
});
