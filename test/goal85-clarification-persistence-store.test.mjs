/**
 * Issue #85, unit seam: the pure restart-reconstruction rules.
 *
 * The end-to-end restart, replacement, zero-side-effect cancel, and attachment
 * deferral scenarios run against a real `pi --mode rpc` subprocess in
 * `goal85-clarification-persistence.test.mjs`. This file pins the parts that a
 * live session cannot reach deterministically: which durable entry a branch
 * selects, the fail-closed treatment of an unreadable newest entry, the base-Goal
 * identity that keeps a stale draft from acting on a Goal chosen after the
 * interview, the exact held-flag spelling the user-facing surfaces print, the
 * replacement paragraph of the interview instruction, and — against a fake Pi —
 * the session-start wiring for a UI-less host, a malformed branch, and an
 * unreadable Goal branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";
import {
	CLARIFICATION_ENTRY_TYPE,
	confirmingClarificationEntry,
	endedClarificationEntry,
	formatClarificationInterviewMessage,
	formatOpenClarificationStatus,
	formatPendingClarificationMalformedNotice,
	formatPendingClarificationRestoredNotice,
	heldClarificationFlags,
	openClarificationEntry,
	readPendingClarification,
} from "../src/clarification.ts";

const IDEA = "Make onboarding feel less confusing";
const OTHER_IDEA = "Cut the release notes down to one page";
const PENDING = {
	idea: IDEA,
	budget: { kind: "default" },
	attachments: [],
	baseGoalId: null,
};
const DRAFT = {
	title: "Onboarding cleanup",
	objective: "Objective: A new user reaches a working sample project in two steps.",
};
const OVER_COMPLETE = { ...PENDING, baseGoalId: "goal_complete" };

/** A `goal-clarification` branch entry with the payload the test supplies. */
function rawEntry(data) {
	return { type: "custom", customType: CLARIFICATION_ENTRY_TYPE, data };
}

/** An open interview entry. */
function openEntry(pending = PENDING) {
	return rawEntry(openClarificationEntry(pending));
}

/** A saved-but-uncommitted confirmation entry. */
function confirmingEntry(pending = PENDING, draft = DRAFT) {
	return rawEntry(confirmingClarificationEntry(pending, draft));
}

/** The terminal end entry. */
function endedEntry() {
	return rawEntry(endedClarificationEntry());
}

/** A current Goal snapshot entry. */
function goalEntry(id) {
	return { type: "custom", customType: "goal-state", data: { version: 1, goal: { id } } };
}

/** A finalized historical snapshot of a replaced identity. */
function supersededGoalEntry(id) {
	return { type: "custom", customType: "goal-state", data: { version: 1, goal: { id }, superseded: true } };
}

/** A tombstone: a valid `goal-state` entry that clears the Goal. */
function tombstoneEntry() {
	return { type: "custom", customType: "goal-state", data: { version: 1, goal: null } };
}

test("the newest goal-clarification entry on the branch decides the pending state", () => {
	assert.deepEqual(readPendingClarification([]), { kind: "none" });
	// Unrelated entries are ignored entirely.
	assert.deepEqual(
		readPendingClarification([
			{ type: "custom", customType: "goal-state", data: { version: 1, goal: null } },
			{ type: "message", customType: CLARIFICATION_ENTRY_TYPE, data: openClarificationEntry(PENDING) },
		]),
		{ kind: "none" },
	);

	assert.deepEqual(readPendingClarification([openEntry()]), {
		kind: "pending",
		pending: PENDING,
		confirmed: null,
	});
	assert.deepEqual(readPendingClarification([openEntry(OVER_COMPLETE)]), {
		kind: "pending",
		pending: OVER_COMPLETE,
		confirmed: null,
	});
	// A saved confirmation is the same clarification plus the draft it kept.
	assert.deepEqual(readPendingClarification([confirmingEntry()]), {
		kind: "pending",
		pending: PENDING,
		confirmed: DRAFT,
	});
	// A later durable end wins over an earlier pending or confirming entry.
	assert.deepEqual(readPendingClarification([openEntry(), endedEntry()]), { kind: "none" });
	assert.deepEqual(readPendingClarification([confirmingEntry(), endedEntry()]), { kind: "none" });
	// A replacement is a second pending entry: newest wins without an intermediate end.
	const replacement = { idea: OTHER_IDEA, budget: { kind: "none" }, attachments: [], baseGoalId: null };
	assert.deepEqual(readPendingClarification([openEntry(), openEntry(replacement)]), {
		kind: "pending",
		pending: replacement,
		confirmed: null,
	});
	assert.deepEqual(readPendingClarification([openEntry(), openEntry(replacement), endedEntry()]), { kind: "none" });
});

test("a pending clarification round-trips through its durable entry with every held flag and base identity", () => {
	const pending = {
		idea: IDEA,
		budget: { kind: "value", value: 5000 },
		attachments: [
			{ kind: "text", path: "spec.md" },
			{ kind: "image", path: "shot.png" },
			{ kind: "remote-image", url: "https://example.test/png" },
		],
		baseGoalId: "goal_complete",
	};
	assert.deepEqual(openClarificationEntry(pending), { version: 2, state: "pending", pending });
	assert.deepEqual(readPendingClarification([openEntry(pending)]), {
		kind: "pending",
		pending,
		confirmed: null,
	});
	assert.deepEqual(confirmingClarificationEntry(pending, DRAFT), {
		version: 2,
		state: "confirming",
		pending,
		draft: DRAFT,
	});
	assert.deepEqual(endedClarificationEntry(), { version: 2, state: "ended", pending: null });
	assert.deepEqual(readPendingClarification([endedEntry()]), { kind: "none" });
});

test("the draft's base Goal identity decides whether a later Goal slot invalidates it", () => {
	// A fresh interview (base null) stays valid while no Goal appears.
	assert.equal(readPendingClarification([openEntry()]).kind, "pending");
	// A transition of the *same* Goal does not invalidate the draft: an edit, a
	// pause, or a resume of the complete Goal the user was clarifying over keeps the
	// identity.
	const overComplete = { ...PENDING, baseGoalId: "goal_a" };
	assert.equal(readPendingClarification([goalEntry("goal_a"), openEntry(overComplete), goalEntry("goal_a")]).kind, "pending");
	// A different Goal after the interview started is a different slot: the draft is
	// abandoned rather than allowed to replace or supersede it.
	assert.equal(
		readPendingClarification([openEntry(), goalEntry("goal_b")]).kind,
		"superseded",
		"a Goal created after the interview",
	);
	assert.equal(
		readPendingClarification([goalEntry("goal_a"), openEntry(overComplete), goalEntry("goal_b")]).kind,
		"superseded",
		"a Goal replacing the one the interview was started against",
	);
	// A tombstone is an identity too: clearing the base Goal (or clearing a Goal that
	// appeared during the interview) invalidates the draft.
	assert.equal(
		readPendingClarification([goalEntry("goal_a"), openEntry(overComplete), tombstoneEntry()]).kind,
		"superseded",
		"the base Goal was cleared",
	);
	assert.equal(
		readPendingClarification([openEntry(), goalEntry("goal_b"), tombstoneEntry()]).kind,
		"superseded",
		"a Goal appeared and was cleared after the interview",
	);
	// A finalized historical snapshot never becomes current, so it cannot invalidate.
	assert.equal(
		readPendingClarification([openEntry(overComplete), supersededGoalEntry("goal_b")]).kind,
		"pending",
		"a superseded freeze is history, not the current slot",
	);
	// A goal-state entry that cannot be read fails closed like a conflicting identity.
	assert.equal(
		readPendingClarification([openEntry(), { type: "custom", customType: "goal-state", data: { version: 99 } }]).kind,
		"superseded",
	);
	// Entries *before* the clarification are history the draft already described.
	assert.equal(readPendingClarification([goalEntry("goal_b"), openEntry()]).kind, "pending");
});

test("an unreadable newest clarification entry fails closed instead of falling back to an older one", () => {
	const malformed = [
		undefined,
		null,
		"pending",
		{},
		{ version: 1, pending: PENDING },
		{ version: 2, pending: PENDING },
		{ version: 2, state: "pending" },
		{ version: 2, state: "pending", pending: "pending" },
		{ version: 2, state: "ended", pending: PENDING },
		{ version: 2, state: "unknown", pending: PENDING },
		{ version: 2, state: "pending", pending: { ...PENDING, idea: "" } },
		{ version: 2, state: "pending", pending: { idea: IDEA, budget: { kind: "default" }, attachments: [] } },
		{ version: 2, state: "pending", pending: { ...PENDING, budget: { kind: "value" } } },
		{ version: 2, state: "pending", pending: { ...PENDING, budget: { kind: "value", value: 0 } } },
		{ version: 2, state: "pending", pending: { ...PENDING, budget: { kind: "value", value: 1.5 } } },
		{ version: 2, state: "pending", pending: { ...PENDING, budget: { kind: "value", value: "5000" } } },
		{ version: 2, state: "pending", pending: { ...PENDING, budget: { kind: "unlimited" } } },
		{ version: 2, state: "pending", pending: { ...PENDING, baseGoalId: 7 } },
		{ version: 2, state: "pending", pending: { ...PENDING, attachments: "spec.md" } },
		{ version: 2, state: "pending", pending: { ...PENDING, attachments: [{ kind: "text" }] } },
		{ version: 2, state: "pending", pending: { ...PENDING, attachments: [{ kind: "text", path: "" }] } },
		{ version: 2, state: "pending", pending: { ...PENDING, attachments: [{ kind: "remote-image" }] } },
		{ version: 2, state: "pending", pending: { ...PENDING, attachments: [{ kind: "pdf", path: "x.pdf" }] } },
	];
	for (const data of malformed) {
		// The older entry is readable and would authorize a pending clarification; the
		// malformed newest entry must still win as "nothing to offer", never as a
		// fallback that resurrects what the session may already have ended.
		assert.deepEqual(
			readPendingClarification([openEntry(), rawEntry(data)]),
			{ kind: "malformed" },
			JSON.stringify(data),
		);
	}
});

test("unknown extra entry fields are ignored, so an additive version-2 field stays readable", () => {
	const data = {
		version: 2,
		state: "pending",
		pending: { ...PENDING, future: true },
		future: "ignored",
	};
	assert.deepEqual(readPendingClarification([rawEntry(data)]), {
		kind: "pending",
		pending: PENDING,
		confirmed: null,
	});
	// A malformed stored draft is dropped, not fatal: the interview underneath it is
	// still confirmable, and the draft is only prefill text.
	for (const draft of [undefined, "text", { title: "x" }, { title: 7, objective: "y" }]) {
		assert.deepEqual(readPendingClarification([rawEntry({ ...confirmingClarificationEntry(PENDING, DRAFT), draft })]), {
			kind: "pending",
			pending: PENDING,
			confirmed: null,
		});
	}
});

test("held flags are spelled the way the user typed them and repeated kinds are collapsed", () => {
	assert.deepEqual(heldClarificationFlags(PENDING), []);
	assert.deepEqual(heldClarificationFlags({ ...PENDING, budget: { kind: "none" } }), ["--no-budget"]);
	assert.deepEqual(heldClarificationFlags({ ...PENDING, budget: { kind: "value", value: 5000 } }), ["--budget 5000"]);
	assert.deepEqual(
		heldClarificationFlags({
			idea: IDEA,
			budget: { kind: "value", value: 5000 },
			attachments: [
				{ kind: "text", path: "a.md" },
				{ kind: "image", path: "b.png" },
				{ kind: "text", path: "c.md" },
				{ kind: "remote-image", url: "https://example.test/png" },
			],
			baseGoalId: null,
		}),
		["--budget 5000", "--file x2", "--image", "--remote-image"],
	);
});

test("the restore, malformed, and open-clarification notices state the real state", () => {
	const plain = formatPendingClarificationRestoredNotice(PENDING);
	assert.match(plain, /^Objective clarification restored: no new Goal is committed yet\./);
	assert.match(plain, /save the confirmation editor to create the Goal/);
	assert.match(plain, /run \/goal <new idea> to start over/);
	assert.ok(!plain.includes("held flags"), "no held-flag sentence without flags");
	assert.ok(!plain.includes("saved confirmation draft"), "no draft sentence without one");

	const held = formatPendingClarificationRestoredNotice({
		idea: IDEA,
		budget: { kind: "value", value: 5000 },
		attachments: [{ kind: "text", path: "spec.md" }],
		baseGoalId: null,
	});
	assert.match(held, /Its held flags \(--budget 5000, --file\) are unchanged/);
	assert.match(held, /nothing has been read, materialized, or fetched/);

	const withDraft = formatPendingClarificationRestoredNotice(PENDING, { confirmed: true });
	assert.match(withDraft, /A saved confirmation draft is kept from an interrupted or failed creation/);
	assert.match(withDraft, /the editor reopens with it/);

	const malformed = formatPendingClarificationMalformedNotice();
	assert.match(malformed, /could not read the newest pending Objective clarification/);
	assert.match(malformed, /propose_goal will refuse/);
	assert.match(malformed, /Run \/goal <objective> to start over/);

	const open = formatOpenClarificationStatus({
		idea: IDEA,
		budget: { kind: "value", value: 5000 },
		attachments: [{ kind: "text", path: "spec.md" }],
		baseGoalId: null,
	});
	assert.match(open, /An Objective clarification is open: no new Goal is committed yet\./);
	assert.match(open, /It is holding --budget 5000, --file/);
	assert.match(open, /nothing is read, materialized, or fetched until the confirmation is saved/);
	// The user's own objective text is not repeated in reconstruction notices.
	assert.ok(!open.includes(IDEA));
	assert.ok(!plain.includes(IDEA));
});

test("the replacement interview instruction marks the earlier clarification abandoned", () => {
	const first = formatClarificationInterviewMessage(IDEA);
	assert.ok(first.includes(IDEA), "the raw idea is framed as delimited data");
	assert.ok(!first.includes("replaced an earlier clarification"), "a first interview names no replacement");
	assert.match(first, /propose_goal/);
	assert.match(first, /Objective: one sentence/);

	const replaced = formatClarificationInterviewMessage(OTHER_IDEA, { replaced: true });
	assert.ok(replaced.includes(OTHER_IDEA));
	assert.match(replaced, /replaced an earlier clarification with this new \/goal/);
	assert.match(replaced, /no Goal was created for it/);
	assert.match(replaced, /Interview only about the new idea below/);
	// The abandoned raw idea is not repeated: the shared conversation already has it.
	assert.ok(!replaced.includes(IDEA));
	assert.ok(replaced.startsWith("[pi-goal] Objective clarification: no new Goal is committed yet."));
});

/**
 * A fake Pi whose branch is a seeded session file, for the session-start wiring
 * a real RPC session cannot reach deterministically: a UI-less host (the RPC
 * harness always has a dialog-capable UI), a malformed newest entry, and an
 * unreadable Goal branch.
 */
function restartFixture(branch, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-clarify85-unit-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, branch.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	const state = {
		settings: options.settings ?? { goal: { clarifyOnCreate: true } },
		notifications: [],
		messages: [],
		editors: [],
		editorResponses: [],
		/** Simulates another extension taking `propose_goal` after session_start. */
		foreignProposeGoal: options.foreignProposeGoal ?? false,
	};
	const handlers = new Map();
	const commands = new Map();
	const tools = [];
	const OWN_SOURCE = join(dir, "pi-goal", "src", "index.ts");
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
			const own = tools.map((tool) => ({ name: tool.name, sourceInfo: { path: OWN_SOURCE } }));
			if (!state.foreignProposeGoal) return own;
			return [
				...own.filter((tool) => tool.name !== "propose_goal"),
				{ name: "propose_goal", sourceInfo: { path: join(dir, "peer-extension.ts") } },
			];
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
				const next = state.editorResponses.shift();
				return typeof next === "function" ? await next() : next;
			},
		},
		mode: options.hasUI === false ? "print" : "tui",
		hasUI: options.hasUI !== false,
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

async function startRestartSession(fx) {
	goalExtension(fx.pi);
	const start = fx.handlers.get("session_start");
	assert.ok(start, "pi-goal registered a session_start handler");
	await start({ type: "session_start" }, fx.ctx);
}

test("session_start offers a reconstructed clarification only to a host that can confirm it", async () => {
	const branch = [openEntry({ ...PENDING, budget: { kind: "value", value: 5000 } })];

	const ui = restartFixture(branch);
	try {
		await startRestartSession(ui);
		assert.ok(
			ui.state.notifications.some((notice) => notice.message.startsWith("Objective clarification restored")),
			JSON.stringify(ui.state.notifications),
		);
		await ui.commands.get("goal").handler("", ui.ctx);
		assert.ok(
			ui.state.notifications.some((notice) => notice.message.includes("An Objective clarification is open")),
			"bare /goal names the open clarification",
		);
	} finally {
		rmSync(ui.dir, { recursive: true, force: true });
	}

	// A UI-less host has no confirmation editor, so the interview is a dead end:
	// nothing is offered, and bare /goal stays the plain no-Goal report. The durable
	// entry is untouched (`/goal` retires it only once a direct creation actually
	// commits).
	const print = restartFixture(branch, { hasUI: false });
	try {
		await startRestartSession(print);
		assert.equal(
			print.state.notifications.some((notice) => notice.message.includes("Objective clarification restored")),
			false,
			JSON.stringify(print.state.notifications),
		);
		await print.commands.get("goal").handler("", print.ctx);
		const status = print.state.notifications.find((notice) => notice.message.includes("No Goal is set"));
		assert.ok(status, JSON.stringify(print.state.notifications));
		assert.ok(!status.message.includes("An Objective clarification is open"));
		assert.deepEqual(
			print
				.entries()
				.filter((item) => item.customType === CLARIFICATION_ENTRY_TYPE)
				.map((item) => item.data.pending),
			[branch[0].data.pending],
			"reconstruction is read-only: the durable entry is not rewritten",
		);
	} finally {
		rmSync(print.dir, { recursive: true, force: true });
	}
});

test("a malformed newest clarification entry is surfaced and offers nothing, without falling back", async () => {
	// An older readable pending entry followed by an unreadable newest one: the
	// older entry must not be offered, and the session says why.
	const branch = [openEntry(), rawEntry({ version: 2, state: "pending", pending: { ...PENDING, idea: OTHER_IDEA, baseGoalId: 7 } })];
	const fx = restartFixture(branch);
	try {
		await startRestartSession(fx);
		const warning = fx.state.notifications.find((notice) =>
			notice.message.includes("could not read the newest pending Objective clarification"),
		);
		assert.ok(warning, JSON.stringify(fx.state.notifications));
		assert.equal(warning.type, "warning");
		await fx.commands.get("goal").handler("", fx.ctx);
		const status = fx.state.notifications.find((notice) => notice.message.includes("No Goal is set"));
		assert.ok(status);
		assert.ok(!status.message.includes("An Objective clarification is open"), "no fallback to the older entry");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("an unreadable newest Goal snapshot blocks both restoration and confirmation", async () => {
	// A valid interview, but the branch's newest Goal snapshot cannot be read. The
	// store fails closed; the clarification must not write a confirmation over a
	// slot nobody can see, which would orphan whatever Goal the branch really held.
	const fx = restartFixture([
		{ type: "custom", customType: "goal-state", data: { version: 99, goal: { id: "goal_orphaned" } } },
		openEntry(),
	]);
	try {
		await startRestartSession(fx);
		assert.ok(
			fx.state.notifications.some((notice) => notice.message.includes("could not read the newest Goal snapshot")),
			"the store's actionable notice is surfaced",
		);
		assert.equal(
			fx.state.notifications.some((notice) => notice.message.includes("Objective clarification restored")),
			false,
			JSON.stringify(fx.state.notifications),
		);

		await fx.commands.get("goal").handler("", fx.ctx);
		const status = fx.state.notifications.find((notice) => notice.message.includes("No Goal is set"));
		assert.ok(status);
		assert.ok(!status.message.includes("An Objective clarification is open"));

		// Confirming is refused with the repair path, and writes no Goal bytes.
		const propose = fx.tools.find((tool) => tool.name === "propose_goal");
		assert.ok(propose);
		const refused = await propose.execute("call-1", DRAFT, undefined, undefined, fx.ctx);
		assert.equal(refused.isError, true);
		const text = refused.content.map((block) => block.text).join("\n");
		assert.match(text, /newest Goal snapshot is unreadable/);
		assert.match(text, /restart Pi and run \/goal again/);
		assert.equal(
			fx.entries().filter((entry) => entry.customType === "goal-state").length,
			1,
			"no new snapshot was written over the unreadable one",
		);
		assert.equal(fx.state.editors.length, 0);

		// Starting a new clarification is refused too, so no dead-end interview is
		// recorded.
		await fx.commands.get("goal").handler(OTHER_IDEA, fx.ctx);
		assert.ok(
			fx.state.notifications.some(
				(notice) => notice.type === "error" && notice.message.includes("newest Goal snapshot is unreadable"),
			),
			JSON.stringify(fx.state.notifications),
		);
		assert.equal(
			fx.entries().filter((entry) => entry.customType === CLARIFICATION_ENTRY_TYPE).length,
			1,
			"no new clarification entry was recorded",
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a late propose_goal owner blocks recording a clarification", async () => {
	const fx = restartFixture([]);
	try {
		await startRestartSession(fx);
		// The extension registered pi-goal's tool first; another extension takes the
		// name afterwards. The session-start flag is now stale, and `/goal` must re-read
		// the registry under the creation lock instead of trusting it.
		fx.state.foreignProposeGoal = true;
		await fx.commands.get("goal").handler(OTHER_IDEA, fx.ctx);

		const refusal = fx.state.notifications.find((notice) =>
			notice.message.startsWith("Goal not created: Objective clarification is enabled"),
		);
		assert.ok(refusal, JSON.stringify(fx.state.notifications));
		assert.equal(refusal.type, "error");
		assert.match(refusal.message, /propose_goal tool is not available for this session/);
		assert.equal(
			fx.entries().filter((entry) => entry.customType === CLARIFICATION_ENTRY_TYPE).length,
			0,
			"no interview that could never be confirmed was recorded",
		);
		assert.equal(fx.state.messages.length, 0, "no interview run was started");
		assert.equal(fx.state.editors.length, 0);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a late propose_goal owner withdraws an already-offered clarification", async () => {
	const fx = restartFixture([openEntry()]);
	try {
		await startRestartSession(fx);
		assert.ok(
			fx.state.notifications.some((notice) => notice.message.startsWith("Objective clarification restored")),
			JSON.stringify(fx.state.notifications),
		);

		// The takeover happens after the interview was offered. The next turn must not
		// keep advertising a confirmation this session cannot complete, and the
		// confirmation itself must refuse rather than open an editor.
		fx.state.foreignProposeGoal = true;
		await fx.handlers.get("turn_start")({ type: "turn_start" }, fx.ctx);
		const paused = fx.state.notifications.find((notice) =>
			notice.message.includes("another extension took over the propose_goal tool"),
		);
		assert.ok(paused, JSON.stringify(fx.state.notifications));
		assert.equal(paused.type, "warning");

		await fx.commands.get("goal").handler("", fx.ctx);
		const status = fx.state.notifications.find((notice) => notice.message.includes("No Goal is set"));
		assert.ok(status);
		assert.ok(!status.message.includes("An Objective clarification is open"));

		const propose = fx.tools.find((tool) => tool.name === "propose_goal");
		const refused = await propose.execute("call-1", DRAFT, undefined, undefined, fx.ctx);
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /Objective clarification is off for this session/);
		assert.equal(fx.state.editors.length, 0, "no editor was opened");

		// The durable entry is kept for a later session that owns the name again.
		assert.deepEqual(
			fx
				.entries()
				.filter((entry) => entry.customType === CLARIFICATION_ENTRY_TYPE)
				.map((entry) => entry.data.pending),
			[PENDING],
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
