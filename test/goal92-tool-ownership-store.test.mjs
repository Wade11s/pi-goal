/**
 * Issue #92, unit seam: the tool-ownership rule against a fake Pi API.
 *
 * `pi.getAllTools()` returns only the tools the session's `--tools` allowlist and
 * `--exclude-tools` denylist admit, so a registry that does not list a tool is
 * ambiguous by construction. Pi keeps the first **extension in load order** that
 * declares a name — not the first one to register it — so an extension loaded
 * before pi-goal can register on a later event and displace a registration pi-goal
 * already made. The live late-peer scenarios in `goal92-tool-ownership.test.mjs`
 * reach that seam through real Pi; the fake here makes the same shapes
 * deterministic, including the one a live session cannot stage: two copies of one
 * extension file sharing a source path.
 *
 * - a registry that omits `get_goal` but not `propose_goal` (the issue's repro);
 * - a registry that cannot be read at all;
 * - a verified takeover: pi-goal registered first, another extension's declaration
 *   in force afterwards, and a later session start in the same runtime;
 * - the same matrix for the opt-in `update_plan`.
 *
 * The real-Pi coverage for the outcomes a live session *can* produce lives in
 * `goal92-tool-ownership.test.mjs`, the documented review-child profile in
 * `goal57-review-profile.test.mjs`, and the genuine-conflict cases in
 * `goal84-objective-clarification*.test.mjs` / `goal53-progress-plan.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * A fake Pi whose registry is a filtered view of what the extension registered.
 *
 * `getAllTools()` reports every tool the extension handed over, minus the names the
 * session's policy hides, plus any foreign declaration a scenario puts in force —
 * which is how a registry keyed by name expresses "this declaration, not that one".
 */
function fixture(settings = {}, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-92-unit-"));
	const sessionFile = join(dir, "session.jsonl");
	const seeded = (options.entries ?? []).map((entry) => `${JSON.stringify(entry)}\n`).join("");
	writeFileSync(sessionFile, seeded);
	const state = {
		settings,
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
		 * A `propose_goal` declaration carrying *this extension's own* source path,
		 * as a second copy of the same extension file would produce.
		 */
		ownShadowProposeGoal: options.ownShadowProposeGoal ?? false,
	};
	const handlers = new Map();
	const commands = new Map();
	const tools = [];
	const OWN_SOURCE = join(dir, "pi-goal", "src", "index.ts");
	const PEER_SOURCE = join(dir, "peer-extension.ts");
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
			tools.push(definition);
		},
		registerCommand(name, definition) {
			commands.set(name, { name, ...definition });
		},
		getCommands() {
			return [...commands.values()];
		},
		getAllTools() {
			if (state.registryUnreadable) throw new Error("injected registry read failure");
			const own = tools
				.filter((tool) => !state.hiddenTools.includes(tool.name))
				.map((tool) => ({ name: tool.name, sourceInfo: { path: OWN_SOURCE } }));
			// A foreign declaration is the one in force, so it replaces this
			// extension's entry for that name rather than sitting beside it.
			const foreign = [];
			if (state.foreignProposeGoal) {
				foreign.push({ name: "propose_goal", sourceInfo: { path: PEER_SOURCE } });
			}
			if (state.foreignPlan) {
				foreign.push({ name: PLAN_TOOL_NAME, sourceInfo: { path: PEER_SOURCE } });
			}
			if (state.ownShadowProposeGoal) {
				foreign.push({ name: "propose_goal", sourceInfo: { path: OWN_SOURCE } });
			}
			const foreignNames = new Set(foreign.map((tool) => tool.name));
			return [...own.filter((tool) => !foreignNames.has(tool.name)), ...foreign];
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
	return { dir, sessionFile, state, pi, ctx, handlers, commands, tools, entries };
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
	// High 2 of the review: the load-time trio is filtered out, so a foreign
	// `update_plan` is the only other tool in the registry. Accepting it as a
	// witness would let a peer extension define pi-goal's identity, which then
	// reports pi-goal's own `propose_goal` as a takeover and the peer's tool as
	// owned. Only the three load-time tools may witness identity, so the plan
	// tool's foreign owner is simply declined and the confirmation tool is still
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

test("a name this runtime registered but cannot attribute declines instead of claiming it", async () => {
	// The fail-closed half of the witness rule. The first session hid every pi-goal
	// tool, so identity was never established; the second session admits
	// `propose_goal`, which is in force and was registered by this runtime, but with
	// no witness and no bootstrap there is nothing to attribute it to. Declining is
	// the safe direction, and the warning says what could not be determined rather
	// than claiming a competing owner.
	const fx = fixture(CLARIFY_SETTINGS, { hiddenTools: ["get_goal", "create_goal", "update_goal", "propose_goal"] });
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the first session registered the tool");
		assert.deepEqual(fx.state.notifications, [], "a policy-hidden registration is silent");

		// A reload with a wider tool policy: the name is now visible and in force.
		fx.state.hiddenTools = ["get_goal", "create_goal", "update_goal"];
		await startSession(fx);

		assert.equal(
			fx.tools.filter((tool) => tool.name === "propose_goal").length,
			1,
			"the declaration was not re-registered over the one already in force",
		);
		const warning = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal did not register propose_goal"),
		);
		assert.ok(warning, JSON.stringify(fx.state.notifications));
		assert.equal(warning.type, "warning");
		assert.match(warning.message, /could not tell which declarations in it are its own/);
		assert.ok(!warning.message.includes(FOREIGN_OWNER_NOTICE), warning.message);
		assert.ok(!warning.message.includes("took its place"), warning.message);

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.equal(refusal.type, "error");
		assert.match(refusal.message, /No Goal was created and no clarification was started/);
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no interview was recorded");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("identity comes only from a registration this runtime made, so the only-visible-tool session still works", async () => {
	// Bootstrap-only identity, at its most exposed: the whole load-time trio is
	// filtered out, so the only pi-goal tool in the registry is `propose_goal`
	// itself. Nothing else can witness identity, and the registration this runtime
	// just made is enough.
	const fx = fixture(CLARIFY_SETTINGS, { hiddenTools: ["get_goal", "create_goal", "update_goal"] });
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(fx.tools.some((tool) => tool.name === "propose_goal"), "the confirmation tool is registered");
		assertNoFalseOwnerNotice(fx, "propose_goal");
		assert.deepEqual(fx.state.notifications, [], "a successful registration is silent");

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);
		assert.equal(
			customEntries(fx, CLARIFICATION_ENTRY_TYPE).at(-1).data.pending.idea,
			OBJECTIVE,
			"the clarification was recorded, so pi-goal owns the tool it just registered",
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a declaration from this extension's own file is not this runtime's to rely on", async () => {
	// Medium 1 of the review: matching pi-goal's source path is not enough. Two
	// copies of one extension file share a path, so the other copy's `propose_goal`
	// would be accepted as this runtime's own — and the restored clarification it
	// offers could never be confirmed, because the model's call would run the other
	// copy's tool. This runtime registered only `update_plan`, so it owns that and
	// nothing else.
	const fx = fixture(
		{ goal: { planTool: true } },
		{ ownShadowProposeGoal: true, entries: [{ type: "custom", customType: CLARIFICATION_ENTRY_TYPE, data: openClarificationEntry(PENDING) }] },
	);
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		assert.ok(
			fx.tools.some((tool) => tool.name === PLAN_TOOL_NAME),
			"this runtime registered the plan tool, which establishes its identity",
		);
		assertNoFalseOwnerNotice(fx, PLAN_TOOL_NAME);
		// The shadow `propose_goal` is declined accurately: this runtime never
		// registered that name, so from its side the name is simply taken.
		const declined = fx.state.notifications.find((notice) =>
			notice.message.includes("pi-goal did not register propose_goal"),
		);
		assert.ok(declined, JSON.stringify(fx.state.notifications));
		assert.match(declined.message, /another extension already provides a tool with that name/);

		// The other copy's `propose_goal` carries this extension's own path, and the
		// durable interview on the branch must still not be offered.
		assert.equal(
			fx.state.notifications.some((notice) => notice.message.includes("Objective clarification restored")),
			false,
			"an interview this runtime cannot confirm is not offered",
		);
		await fx.commands.get("goal").handler("", fx.ctx);
		const status = fx.state.notifications.find((notice) => notice.message.includes("No Goal is set"));
		assert.ok(status, JSON.stringify(fx.state.notifications));
		assert.ok(!status.message.includes("An Objective clarification is open"), status.message);
		assert.equal(fx.state.editors.length, 0, "no confirmation editor was opened");
		// The durable entry is left for a session that does own the name.
		assert.equal(
			customEntries(fx, CLARIFICATION_ENTRY_TYPE).at(-1).data.pending.idea,
			PENDING.idea,
			"the durable interview is untouched",
		);
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
	// same name is in force afterwards. This Pi version keeps the first registration,
	// so a live peer extension cannot produce this state — but a runtime that has
	// already registered the name must never forget it, or a later session start
	// would read the foreign declaration as an ordinary conflict and lose the fact
	// that pi-goal's own registration was displaced.
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

test("a policy-hidden update_plan registers silently and no Continuation names it", async () => {
	// Nothing went wrong, so nothing is said: the registration landed and the
	// session's own policy keeps the tool out of the model's reach.
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
