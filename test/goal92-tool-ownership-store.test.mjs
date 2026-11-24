/**
 * Issue #92, unit seam: the tool-ownership rule against a fake Pi API.
 *
 * `pi.getAllTools()` returns only the tools the session's `--tools` allowlist and
 * `--exclude-tools` denylist admit, so a registry that does not list a tool is
 * ambiguous by construction. Pi keeps the first **extension in load order** that
 * declares a name — not the first one to register it — so an extension loaded before
 * pi-goal can register on a later event and displace a registration pi-goal already
 * made. The live late-peer scenarios in `goal92-tool-ownership.test.mjs` reach that
 * seam through real Pi; the fake here makes the same shapes deterministic, including
 * the ones a live session cannot stage: a second runtime of this file, a registry
 * read that fails between the ownership check and the confirmation, and a
 * registration Pi refuses outright.
 *
 * The rule itself is object identity. Pi hands the very `parameters` object passed
 * to `registerTool` back out of `getAllTools()`, so a declaration is pi-goal's iff
 * that object is the one this runtime registered — there is no source path to
 * confuse, no witness to steal, and no cache a reentrant peer can poison. This fake
 * models that seam: each registry entry carries the same object `registerTool`
 * received.
 *
 * - a registry that omits `get_goal` but not `propose_goal` (the issue's repro);
 * - a registry that cannot be read at all, and one that fails on a chosen read;
 * - a verified takeover: pi-goal registered first, another extension's declaration
 *   in force afterwards, and a later session start in the same runtime;
 * - a registration the session's policy hides, and one the active loadout drops;
 * - the same matrix for the opt-in `update_plan`.
 *
 * The real-Pi coverage for the outcomes a live session *can* produce lives in
 * `goal92-tool-ownership.test.mjs`, the documented review-child profile in
 * `goal57-review-profile.test.mjs`, and the genuine-conflict cases in
 * `goal84-objective-clarification*.test.mjs` / `goal53-progress-plan.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";
import { CLARIFICATION_ENTRY_TYPE, openClarificationEntry } from "../src/clarification.ts";
import { PLAN_TOOL_NAME } from "../src/plan.ts";

const OBJECTIVE = "Make the full test suite pass in this repository";
/** A pending clarification a branch can hold, for the restore-offer assertions. */
const PENDING = {
	idea: "Make onboarding feel less confusing",
	budget: { kind: "default" },
	attachments: [],
	baseGoalId: null,
};
const CLARIFY_SETTINGS = { goal: { clarifyOnCreate: true } };
const PLAN_TOOL_ON = { goal: { planTool: true } };
/** The one sentence that must never describe a session's own tool policy. */
const FOREIGN_OWNER_NOTICE = "another extension already provides a tool with that name";

/**
 * A fake Pi that models the two seams the ownership rule reads.
 *
 * `getAllTools()` reports every tool the extension handed over, minus the names the
 * session's policy hides, plus any foreign declaration a scenario puts in force —
 * which is how a registry keyed by name expresses "this declaration, not that one".
 * Each entry carries the **same `parameters` object** `registerTool` received, which
 * is what Pi 1.6.0 really does and what makes object identity a usable rule.
 * `getActiveTools()` reports the model-visible names, which start as every
 * registered tool and can be narrowed by a scenario.
 */
function fixture(settings = {}, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-92-unit-"));
	const sessionFile = join(dir, "session.jsonl");
	const seeded = (options.entries ?? []).map((entry) => `${JSON.stringify(entry)}\n`).join("");
	writeFileSync(sessionFile, seeded);
	const state = {
		settings,
		/** How many registry reads this runtime has served. */
		reads: 0,
		notifications: [],
		messages: [],
		editors: [],
		/** Tool names this session's policy hides from the registry. */
		hiddenTools: options.hiddenTools ?? [],
		/** Whether the registry read itself fails. */
		registryUnreadable: options.registryUnreadable ?? false,
		/** A foreign `propose_goal` declaration in force. */
		foreignProposeGoal: options.foreignProposeGoal ?? false,
		/** A foreign `update_plan` declaration in force. */
		foreignPlan: options.foreignPlan ?? false,
		/**
		 * A `propose_goal` declaration from a *second runtime* of this same file: its
		 * own schema object, registered before this runtime's.
		 */
		secondRuntimeProposeGoal: options.secondRuntimeProposeGoal ?? false,
			/** A peer that copied pi-goal's schema object but not its module path. */
		forgingProposeGoal: options.forgingProposeGoal ?? false,
		/** The `parameters` object the extension handed over for `propose_goal`. */
		capturedProposeGoalParameters: undefined,
		/** Tool names removed from the model-visible loadout, as `setActiveTools` would. */
		inactiveTools: options.inactiveTools ?? [],
		/** Whether the active-loadout read itself fails. */
		activeToolsUnreadable: options.activeToolsUnreadable ?? false,
		/** Tool names whose registration Pi refuses. */
		registrationThrowsFor: options.registrationThrowsFor ?? [],
		/**
		 * 1-based indices of registry reads that throw, for the transient shape a live
		 * session cannot stage: a failure between the ownership check and the
		 * confirmation, or between one registration and the next.
		 */
		failingReads: options.failingReads ?? [],
	};
	const handlers = new Map();
	const commands = new Map();
	const tools = [];
	/**
	 * This extension's own module path, canonicalized exactly as `src/index.ts`
	 * derives it, so the fake models what Pi assigns to pi-goal's own tools.
	 */
	const OWN_SOURCE = realpathSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
	/** A peer extension's module path. */
	const PEER_SOURCE = join(dir, "peer-extension.ts");
	/**
	 * The schema object this extension hands to Pi. A second runtime of the same file
	 * holds the same object, and a forging peer copies the reference — which is why
	 * the module path is the other half of identity.
	 */
	const OWN_SOURCE_PARAMETERS = { type: "object", properties: { title: { type: "string" } } };
	/** A peer extension's schema object: no runtime of pi-goal can present it. */
	const PEER_PARAMETERS = { type: "object", properties: { peer: { type: "string" } } };
	const entries = () =>
		readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerTool(definition) {
			// A registration-failure seam, for the outcome a live session cannot stage.
			// Thrown *before* the definition is stored, because that is what Pi does:
			// a refused registration never reaches the registry. Scoped by name,
			// because the extension's load-time tools register through the same call
			// and must not take the session down with it.
			if (state.registrationThrowsFor.includes(definition.name)) {
				throw new Error(`injected registerTool failure for ${definition.name}`);
			}
			// Remember what the extension actually handed over, so a forging peer can
			// copy the very object rather than a look-alike.
			if (definition.name === "propose_goal") state.capturedProposeGoalParameters = definition.parameters;
			tools.push(definition);
		},
		registerCommand(name, definition) {
			commands.set(name, { name, ...definition });
		},
		getCommands() {
			return [...commands.values()];
		},
		getAllTools() {
			state.reads += 1;
			if (state.registryUnreadable || state.failingReads.includes(state.reads)) {
				throw new Error(`injected registry read failure on read ${state.reads}`);
			}
			// The same `parameters` object the extension handed over, exactly as Pi
			// returns it: the guard recognises its own declaration by reference.
			const own = tools
				.filter((tool) => !state.hiddenTools.includes(tool.name))
				.map((tool) => ({ name: tool.name, parameters: tool.parameters, sourceInfo: { path: OWN_SOURCE } }));
			// A foreign declaration is the one in force, so it replaces this
			// extension's entry for that name rather than sitting beside it.
			const foreign = [];
			if (state.foreignProposeGoal) {
				foreign.push({ name: "propose_goal", parameters: PEER_PARAMETERS, sourceInfo: { path: PEER_SOURCE } });
			}
			if (state.foreignPlan) {
				foreign.push({ name: PLAN_TOOL_NAME, parameters: PEER_PARAMETERS, sourceInfo: { path: PEER_SOURCE } });
			}
			if (state.secondRuntimeProposeGoal) {
				// A second runtime of this same file: the same schema object and the same
				// path, so only the guard's per-runtime record says it is not ours.
				foreign.push({ name: "propose_goal", parameters: OWN_SOURCE_PARAMETERS, sourceInfo: { path: OWN_SOURCE } });
			}
			if (state.forgingProposeGoal) {
				// A peer that copied the schema object pi-goal actually registered — the
				// same reference, which is what `getAllTools()` publishes — and cannot
				// copy the module path.
				foreign.push({
					name: "propose_goal",
					parameters: state.capturedProposeGoalParameters,
					sourceInfo: { path: PEER_SOURCE },
				});
			}
			const foreignNames = new Set(foreign.map((tool) => tool.name));
			return [...own.filter((tool) => !foreignNames.has(tool.name)), ...foreign];
		},
		getActiveTools() {
			if (state.activeToolsUnreadable) throw new Error("injected active loadout read failure");
			// Pi filters both lists by the session's tool policy, so a hidden name is
			// neither in the registry nor in the loadout.
			return tools
				.map((tool) => tool.name)
				.filter((name) => !state.inactiveTools.includes(name) && !state.hiddenTools.includes(name));
		},
		getSettings() {
			return state.settings;
		},
		appendEntry(customType, data) {
			appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
		},
		sendUserMessage(content) {
			state.messages.push(content);
		},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
		events: {
			on() {
				return () => {};
			},
			emit() {},
		},
	};
	const ctx = {
		ui: {
			notify(message, type) {
				state.notifications.push({ message, type });
			},
			setStatus() {},
			confirm: async () => false,
			editor: async (title, prefill) => {
				state.editors.push({ title, prefill });
				return undefined;
			},
		},
		mode: "tui",
		hasUI: true,
		cwd: dir,
		isIdle: () => true,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionFile: () => sessionFile,
			getBranch: () => entries(),
			getCwd: () => dir,
		},
	};
	/**
	 * A second runtime of this same extension, over the one shared registry.
	 *
	 * Two `goalExtension` calls in one process is what a second Pi runtime in the same
	 * process looks like: a fresh handler map and a fresh guard, the same tools array
	 * and the same session branch. It is the only way to stage the shape where a
	 * declaration carries this extension's own schema object *and* its own module path
	 * and is still not this runtime's.
	 */
	function secondRuntime(settings) {
		state.settings = settings;
		const secondHandlers = new Map();
		const secondCommands = new Map();
		const secondPi = {
			...pi,
			on(event, handler) {
				secondHandlers.set(event, handler);
			},
			registerCommand(name, definition) {
				secondCommands.set(name, { name, ...definition });
			},
			getCommands() {
				return [...secondCommands.values()];
			},
		};
		return {
			pi: secondPi,
			ctx,
			state,
			tools,
			entries,
			handlers: secondHandlers,
			commands: secondCommands,
			start: async () => {
				const start = secondHandlers.get("session_start");
				assert.ok(start, "the second runtime registered a session_start handler");
				await start({ type: "session_start" }, ctx);
			},
		};
	}

	return { dir, sessionFile, state, pi, ctx, handlers, commands, tools, entries, secondRuntime };
}

/** Load the extension and run one `session_start`, which is one runtime's session. */
async function startSession(fx) {
	const start = fx.handlers.get("session_start");
	assert.ok(start, "pi-goal registered a session_start handler");
	await start({ type: "session_start" }, fx.ctx);
}

function customEntries(fx, customType) {
	return fx.entries().filter((entry) => entry.type === "custom" && entry.customType === customType);
}

function noticeMessages(fx) {
	return fx.state.notifications.map((notice) => notice.message);
}

/**
 * Every notification that mentions `toolName`, asserted to be free of a false
 * foreign-owner claim.
 *
 * Scoped to the tool's own notices, because a scenario may legitimately carry an
 * accurate warning about a *different* tool: an extension that really does own
 * `update_plan` must still be reported, and that report must not be mistaken for a
 * claim about `propose_goal`.
 */
function assertNoFalseOwnerNotice(fx, toolName) {
	for (const message of noticeMessages(fx).filter((notice) => notice.includes(toolName))) {
		assert.ok(!message.includes(FOREIGN_OWNER_NOTICE), `a tool policy was reported as a foreign owner: ${message}`);
		assert.ok(!message.includes(`did not register ${toolName}`), `a false registration failure: ${message}`);
		assert.ok(!message.includes("took its place"), `a false takeover: ${message}`);
	}
}

test("a registry without get_goal and without propose_goal still registers propose_goal, silently", async () => {
	// The issue's repro, at the seam that isolates it: `get_goal` is filtered out of
	// the registry and `propose_goal` is free, so the guard must register the tool
	// and say nothing. The old rule read pi-goal's own identity out of `get_goal`,
	// so this exact registry refused to register.
	const fx = fixture(CLARIFY_SETTINGS, { hiddenTools: ["get_goal"] });
	try {
		goalExtension(fx.pi);
		await startSession(fx);

		const propose = fx.tools.find((tool) => tool.name === "propose_goal");
		assert.ok(propose, `the confirmation tool is registered: ${fx.tools.map((tool) => tool.name)}`);
		assertNoFalseOwnerNotice(fx, "propose_goal");
		assert.deepEqual(fx.state.notifications, [], "a successful registration is silent");

		// And the flow works: `/goal` records the interview instead of refusing.
		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		assert.equal(
			customEntries(fx, CLARIFICATION_ENTRY_TYPE).at(-1).data.pending.idea,
			OBJECTIVE,
			"the clarification was recorded",
		);
		assert.equal(fx.state.messages.length, 1, "the interview was delivered");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a visible foreign update_plan never becomes pi-goal's identity", async () => {
	// High 2 of the earlier review: the load-time trio is filtered out, so a foreign
	// `update_plan` is the only other tool in the registry. An identity rule that
	// inferred pi-goal's own source from any visible pi-goal tool would adopt the
	// peer's declaration and then report pi-goal's own `propose_goal` as a takeover.
	// Object identity cannot: the peer's `update_plan` presents the peer's schema
	// object, so its owner is simply declined and the confirmation tool is still
	// pi-goal's own.
	const fx = fixture({ goal: { planTool: true, clarifyOnCreate: true } }, {
		hiddenTools: ["get_goal", "create_goal", "update_goal"],
		foreignPlan: true,
	});
	try {
		goalExtension(fx.pi);
		await startSession(fx);

		const declined = fx.state.notifications.find((notice) =>
			notice.message.includes(`pi-goal did not register ${PLAN_TOOL_NAME}`),
		);
		assert.ok(declined, JSON.stringify(fx.state.notifications));
		assert.match(declined.message, new RegExp(FOREIGN_OWNER_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(
			fx.tools.some((tool) => tool.name === PLAN_TOOL_NAME),
			false,
			"the foreign plan tool was not shadowed",
		);

		// The foreign `update_plan` did not become pi-goal's identity: the
		// confirmation tool registered, is pi-goal's own, and nothing warned about it.
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the confirmation tool is registered");
		assertNoFalseOwnerNotice(fx, "propose_goal");
		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		assert.equal(
			customEntries(fx, CLARIFICATION_ENTRY_TYPE).at(-1).data.pending.idea,
			OBJECTIVE,
			"the clarification was recorded, so pi-goal still owns propose_goal",
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a registration that lands while the confirmation read fails is not offered later", async () => {
	// High 2 of the review. `registerTool` succeeded and the declaration is in force,
	// but the read that would have confirmed it threw, so the registration flag stays
	// false. A later successful registration of another tool must not make the
	// confirmation tool look available again: every offer seam asks one predicate that
	// requires registration *and* availability.
	const fx = fixture(
		{ goal: { clarifyOnCreate: true, planTool: true } },
		{ failingReads: [2], entries: [{ type: "custom", customType: CLARIFICATION_ENTRY_TYPE, data: openClarificationEntry(PENDING) }] },
	);
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		// The tool really was handed to Pi, and the plan tool registered afterwards.
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the confirmation tool was registered");
		assert.ok(fx.tools.some((tool) => tool.name === PLAN_TOOL_NAME), "the plan tool registered afterwards");
		// The failed confirmation is reported, cause-neutrally.
		const unconfirmed = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal registered propose_goal, but the session's tool registry could not be read"),
		);
		assert.ok(unconfirmed, JSON.stringify(fx.state.notifications));
		assert.match(unconfirmed.message, /the session's tool registry could not be read/);
		assert.match(unconfirmed.message, /fix the host or extension whose getAllTools\(\) throws/);
		assert.ok(!unconfirmed.message.includes(FOREIGN_OWNER_NOTICE), unconfirmed.message);
		assert.ok(!unconfirmed.message.includes("took its place"), unconfirmed.message);

		// And the durable interview on the branch is not offered.
		assert.equal(
			fx.state.notifications.some((notice) => notice.message.includes("Objective clarification restored")),
			false,
			"an interview this session cannot confirm is not offered",
		);
		await fx.commands.get("goal").handler("", fx.ctx);
		const status = fx.state.notifications.find((notice) => notice.message.includes("No Goal is set"));
		assert.ok(status, JSON.stringify(fx.state.notifications));
		assert.ok(!status.message.includes("An Objective clarification is open"), status.message);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a declaration from a second runtime of this file is not this runtime's", async () => {
	// Medium 1 of an earlier review, now staged for real. Two runtimes of one file
	// share the schema object *and* the module path, so identity is settled only by
	// the per-runtime record: the second runtime never registered `propose_goal`, so
	// the first runtime's declaration is foreign to it even though every observable
	// about the declaration says "this extension".
	const fx = fixture(CLARIFY_SETTINGS, {
		entries: [{ type: "custom", customType: CLARIFICATION_ENTRY_TYPE, data: openClarificationEntry(PENDING) }],
	});
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		const registered = fx.tools.filter((tool) => tool.name === "propose_goal");
		assert.equal(registered.length, 1, "the first runtime registered the confirmation tool");
		// The first runtime owns the tool, so it *does* offer the durable interview:
		// that is the control that makes the second runtime's silence meaningful.
		const restoredFor = () =>
			fx.state.notifications.filter((notice) => notice.message.includes("Objective clarification restored")).length;
		assert.equal(restoredFor(), 1, "the owning runtime offers the interview");

		// A second runtime of the same extension, over the same registry and branch.
		const second = fx.secondRuntime({ goal: { clarifyOnCreate: true, planTool: true } });
		goalExtension(second.pi);
		await second.start();

		// It declines the first runtime's `propose_goal` as foreign, and registers the
		// plan tool — which is what establishes *its* identity, from its own schema
		// object and its own module path.
		const declined = fx.state.notifications.filter((notice) =>
			notice.message.includes("pi-goal did not register propose_goal"),
		);
		assert.equal(declined.length, 1, "exactly one runtime declined the confirmation tool");
		assert.match(declined[0].message, /another extension already provides a tool with that name/);
		assert.ok(
			second.tools.some((tool) => tool.name === PLAN_TOOL_NAME),
			"the second runtime registered the plan tool",
		);
		assert.equal(
			fx.tools.filter((tool) => tool.name === PLAN_TOOL_NAME).length,
			1,
			"the first runtime did not register a plan tool",
		);

		// And the second runtime, which never registered the name, offers nothing more.
		assert.equal(restoredFor(), 1, "the second runtime does not offer the interview again");
		assert.equal(fx.state.editors.length, 0, "no confirmation editor was opened");
		assert.equal(
			customEntries(fx, CLARIFICATION_ENTRY_TYPE).at(-1).data.pending.idea,
			PENDING.idea,
			"the durable interview is untouched",
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a peer that copies the schema object cannot copy the module path", async () => {
	// High of the fourth review. `getAllTools()` publishes every tool's `parameters`
	// object to every extension, so a peer can copy the reference into its own
	// `registerTool` call and satisfy the schema half of identity on its own. The
	// module path is the half it cannot copy, because Pi assigns `sourceInfo` from the
	// registering extension's own file.
	//
	// The forge is staged the way a live one happens: pi-goal registers its own
	// declaration first, and the peer's copy takes the name over afterwards — from a
	// `prepareLoadout` hook in the real session, from a later session start here.
	const fx = fixture(CLARIFY_SETTINGS);
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the tool was registered");
		assert.deepEqual(fx.state.notifications, [], "the first session start is silent");

		// The peer now holds the name, with this extension's own schema object.
		fx.state.forgingProposeGoal = true;
		await startSession(fx);

		// The schema matches and the path does not, so this is a takeover of a tool
		// this runtime registered — never `owned`, which is what the schema alone said.
		const warning = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal registered propose_goal, but another extension's tool of the same name took its place"),
		);
		assert.ok(warning, JSON.stringify(fx.state.notifications));
		assert.equal(warning.type, "warning");
		assert.match(warning.message, /will refuse rather than create a Goal/);
		assert.equal(
			fx.tools.filter((tool) => tool.name === "propose_goal").length,
			1,
			"the forged declaration was not registered over",
		);

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.match(refusal.message, /another extension took over the propose_goal tool/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
		assert.equal(fx.state.messages.length, 0, "no interview was delivered");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a registration Pi refuses is reported as its own failure and establishes nothing", async () => {
	// The registration-failure outcome, which no live session can stage: the
	// declaration never reaches Pi, so nothing is registered, nothing is promised, and
	// the warning names the failure rather than a competing owner.
	const fx = fixture(CLARIFY_SETTINGS, { registrationThrowsFor: ["propose_goal"] });
	try {
		goalExtension(fx.pi);
		await startSession(fx);

		const failed = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal could not register the propose_goal tool"),
		);
		assert.ok(failed, JSON.stringify(fx.state.notifications));
		assert.equal(failed.type, "warning");
		assert.match(failed.message, /injected registerTool failure for propose_goal/);
		assert.match(failed.message, /Fix the registration failure/);
		assert.ok(!failed.message.includes(FOREIGN_OWNER_NOTICE), failed.message);

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.equal(refusal.type, "error");
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
		assert.equal(fx.state.messages.length, 0, "no interview was delivered");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a registered tool the active loadout does not declare is not available", async () => {
	// High 3 of the review, at the store seam. `getAllTools()` keeps every tool a peer
	// removed with `setActiveTools`, so ownership alone would keep promising a tool the
	// model cannot call: the interview would be recorded and sent, and the model's
	// confirmation could never be opened.
	const fx = fixture(CLARIFY_SETTINGS, { inactiveTools: ["propose_goal"] });
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the tool was registered");
		assert.deepEqual(fx.state.notifications, [], "a deactivated tool is nobody's fault at startup");

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.equal(refusal.type, "error");
		assert.match(refusal.message, /not in this session's active tool loadout/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
		assert.equal(fx.state.messages.length, 0, "no interview was delivered");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("an unreadable active loadout leaves the tool unavailable", async () => {
	// The same fail-closed direction when the second seam, not the first, breaks.
	const fx = fixture(CLARIFY_SETTINGS, { activeToolsUnreadable: true });
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the tool was registered");
		assert.deepEqual(fx.state.notifications, [], "a broken loadout read is nobody's fault at startup");

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.match(refusal.message, /could not read the session's tool state/);
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a registry that cannot be read declines with a cause-neutral warning, never a foreign owner", async () => {
	const fx = fixture(CLARIFY_SETTINGS, { registryUnreadable: true });
	try {
		goalExtension(fx.pi);
		await startSession(fx);

		assert.equal(
			fx.tools.some((tool) => tool.name === "propose_goal"),
			false,
			"an unreadable registry declines to register",
		);
		const warning = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal did not register propose_goal"),
		);
		assert.ok(warning, JSON.stringify(fx.state.notifications));
		assert.equal(warning.type, "warning");
		// Distinct and cause-neutral: it says what could not be found out, and it
		// never claims another extension owns the name.
		assert.match(warning.message, /could not read this session's tool registry/);
		assert.match(warning.message, /injected registry read failure/);
		assert.ok(!warning.message.includes(FOREIGN_OWNER_NOTICE), warning.message);
		assert.match(warning.message, /will refuse rather than create a Goal/);

		// Fail closed: `/goal` refuses, and nothing is recorded.
		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.equal(refusal.type, "error");
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, "goal-state").length, 0, "no Goal was created");
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
		assert.equal(fx.state.messages.length, 0, "no interview was delivered");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a verified takeover keeps refusing on later session starts", async () => {
	// pi-goal registers `propose_goal` first; another extension's declaration of the
	// same name is in force afterwards. A *synchronous* takeover cannot be staged
	// through a live peer, because Pi keeps the first extension in load order that
	// declares a name — but a runtime that has already registered the name must never
	// forget it, or a later session start would read the foreign declaration as an
	// ordinary conflict and lose the fact that pi-goal's own registration was
	// displaced. The live late-peer scenarios cover the reachable shape.
	const fx = fixture(CLARIFY_SETTINGS);
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(
			fx.tools.some((tool) => tool.name === "propose_goal"),
			"the first session start registered pi-goal's own tool",
		);
		assertNoFalseOwnerNotice(fx, "propose_goal");

		// Another extension takes the name over, then the runtime starts a session
		// again: a reload, a fork, or a branch navigation. The captured handler is
		// invoked directly rather than reloading the extension, because it is the same
		// runtime that must still remember what it registered.
		fx.state.foreignProposeGoal = true;
		await startSession(fx);

		assert.equal(
			fx.tools.filter((tool) => tool.name === "propose_goal").length,
			1,
			"the foreign declaration was not shadowed by a second registration",
		);
		const warning = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal registered propose_goal, but another extension's tool of the same name took its place"),
		);
		assert.ok(warning, JSON.stringify(fx.state.notifications));
		assert.equal(warning.type, "warning");
		assert.match(warning.message, /will refuse rather than create a Goal/);
		assert.match(warning.message, /set goal\.clarifyOnCreate to false/);

		// And it keeps refusing: no Goal, no interview, no editor.
		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.equal(refusal.type, "error");
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, "goal-state").length, 0, "no Goal was created");
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
		assert.equal(fx.state.editors.length, 0, "no editor was opened");
		assert.equal(fx.state.messages.length, 0, "no interview was delivered");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a hidden get_goal still registers update_plan, and a real conflict still declines", async () => {
	// The plan tool's half of the same rule, at both ends.
	const hidden = fixture(PLAN_TOOL_ON, { hiddenTools: ["get_goal"] });
	try {
		goalExtension(hidden.pi);
		await startSession(hidden);
		assert.ok(
			hidden.tools.some((tool) => tool.name === PLAN_TOOL_NAME),
			`the plan tool is registered: ${hidden.tools.map((tool) => tool.name)}`,
		);
		assertNoFalseOwnerNotice(hidden, PLAN_TOOL_NAME);
		assert.deepEqual(hidden.state.notifications, [], "a successful registration is silent");
	} finally {
		rmSync(hidden.dir, { recursive: true, force: true });
	}

	// A genuine owner of the name still wins, with the same warning as before.
	const foreign = fixture(PLAN_TOOL_ON, { foreignPlan: true });
	try {
		goalExtension(foreign.pi);
		await startSession(foreign);
		assert.equal(
			foreign.tools.some((tool) => tool.name === PLAN_TOOL_NAME),
			false,
			"the foreign tool was not shadowed",
		);
		const declined = foreign.state.notifications.find((notice) =>
			notice.message.includes(`pi-goal did not register ${PLAN_TOOL_NAME}`),
		);
		assert.ok(declined, JSON.stringify(foreign.state.notifications));
		assert.equal(declined.type, "warning");
		assert.match(declined.message, new RegExp(FOREIGN_OWNER_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(declined.message, /pi-goal will not replace it/);
		assert.match(declined.message, /No Continuation will mention the plan tool/);
	} finally {
		rmSync(foreign.dir, { recursive: true, force: true });
	}
});

test("a policy-hidden update_plan registers silently", async () => {
	// Nothing went wrong, so nothing is said: the registration landed and the
	// session's own policy keeps the tool out of the model's reach. What this seam
	// pins is that the registration itself succeeded silently. The model-visibility
	// half — that no Continuation names a tool the policy hides — is a live question,
	// owned by the real-Pi scenarios in `goal92-tool-ownership.test.mjs`.
	const fx = fixture(PLAN_TOOL_ON, { hiddenTools: [PLAN_TOOL_NAME] });
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(
			fx.tools.some((tool) => tool.name === PLAN_TOOL_NAME),
			"the tool really was handed to Pi",
		);
		assertNoFalseOwnerNotice(fx, PLAN_TOOL_NAME);
		assert.deepEqual(fx.state.notifications, [], "a hidden registration is silent at startup");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
