/**
 * Issue #85, unit seam: the pure restart-reconstruction rules.
 *
 * The end-to-end restart, replacement, zero-side-effect cancel, and attachment
 * deferral scenarios run against a real `pi --mode rpc` subprocess in
 * `goal85-clarification-persistence.test.mjs`. This file pins the parts that a
 * live session cannot reach deterministically: which durable entry a branch
 * selects, the fail-closed treatment of an unreadable newest entry, the exact
 * held-flag spelling the user-facing surfaces print, the replacement paragraph
 * of the interview instruction, and — against a fake Pi — the session-start wiring
 * for a UI-less host and a malformed branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";
import {
	CLARIFICATION_ENTRY_TYPE,
	formatClarificationInterviewMessage,
	formatOpenClarificationStatus,
	formatPendingClarificationMalformedNotice,
	formatPendingClarificationRestoredNotice,
	heldClarificationFlags,
	pendingClarificationEntry,
	readPendingClarification,
} from "../src/clarification.ts";

const IDEA = "Make onboarding feel less confusing";
const OTHER_IDEA = "Cut the release notes down to one page";
const PENDING = {
	idea: IDEA,
	budget: { kind: "default" },
	attachments: [],
};

/** One branch entry of the channel under test. */
function entry(pending) {
	return { type: "custom", customType: CLARIFICATION_ENTRY_TYPE, data: { version: 1, pending } };
}

/** One branch entry with a payload the test supplies verbatim. */
function rawEntry(data) {
	return { type: "custom", customType: CLARIFICATION_ENTRY_TYPE, data };
}

test("the newest goal-clarification entry on the branch decides the pending state", () => {
	assert.deepEqual(readPendingClarification([]), { kind: "none" });
	// Unrelated entries are ignored entirely.
	assert.deepEqual(
		readPendingClarification([
			{ type: "custom", customType: "goal-state", data: { version: 1, goal: null } },
			{ type: "message", customType: CLARIFICATION_ENTRY_TYPE, data: { version: 1, pending: PENDING } },
		]),
		{ kind: "none" },
	);

	assert.deepEqual(readPendingClarification([entry(PENDING)]), {
		kind: "pending",
		pending: PENDING,
	});
	// A later durable end wins over an earlier pending entry.
	assert.deepEqual(readPendingClarification([entry(PENDING), entry(null)]), { kind: "none" });
	// A replacement is a second pending entry: the newest wins without needing an
	// intermediate end, which is exactly what a new /goal writes.
	const replacement = { idea: OTHER_IDEA, budget: { kind: "none" }, attachments: [] };
	assert.deepEqual(readPendingClarification([entry(PENDING), entry(replacement)]), {
		kind: "pending",
		pending: replacement,
	});
	// The same order as a real branch: start, replace, then end.
	assert.deepEqual(readPendingClarification([entry(PENDING), entry(replacement), entry(null)]), { kind: "none" });
});

test("a pending clarification round-trips through its durable entry with every held flag", () => {
	const pending = {
		idea: IDEA,
		budget: { kind: "value", value: 5000 },
		attachments: [
			{ kind: "text", path: "spec.md" },
			{ kind: "image", path: "shot.png" },
			{ kind: "remote-image", url: "https://example.test/png" },
		],
	};
	assert.deepEqual(pendingClarificationEntry(pending), { version: 1, pending });
	assert.deepEqual(readPendingClarification([entry(pending)]), { kind: "pending", pending });
	assert.deepEqual(pendingClarificationEntry(null), { version: 1, pending: null });
	assert.deepEqual(readPendingClarification([entry(null)]), { kind: "none" });
});

test("an unreadable newest entry fails closed instead of falling back to an older pending entry", () => {
	const malformed = [
		undefined,
		null,
		"pending",
		{},
		{ version: 2, pending: PENDING },
		{ version: "1", pending: PENDING },
		{ version: 1 },
		{ version: 1, pending: "pending" },
		{ version: 1, pending: { ...PENDING, idea: "" } },
		{ version: 1, pending: { ...PENDING, idea: 7 } },
		{ version: 1, pending: { idea: IDEA, budget: { kind: "default" } } },
		{ version: 1, pending: { ...PENDING, budget: { kind: "value" } } },
		{ version: 1, pending: { ...PENDING, budget: { kind: "value", value: 0 } } },
		{ version: 1, pending: { ...PENDING, budget: { kind: "value", value: 1.5 } } },
		{ version: 1, pending: { ...PENDING, budget: { kind: "value", value: "5000" } } },
		{ version: 1, pending: { ...PENDING, budget: { kind: "unlimited" } } },
		{ version: 1, pending: { ...PENDING, attachments: "spec.md" } },
		{ version: 1, pending: { ...PENDING, attachments: [{ kind: "text" }] } },
		{ version: 1, pending: { ...PENDING, attachments: [{ kind: "text", path: "" }] } },
		{ version: 1, pending: { ...PENDING, attachments: [{ kind: "remote-image" }] } },
		{ version: 1, pending: { ...PENDING, attachments: [{ kind: "pdf", path: "x.pdf" }] } },
	];
	for (const data of malformed) {
		// The older entry is readable and would authorize a pending clarification; the
		// malformed newest entry must still win as "nothing to offer", never as a
		// fallback that resurrects what the session may already have ended.
		assert.deepEqual(
			readPendingClarification([entry(PENDING), rawEntry(data)]),
			{ kind: "malformed" },
			JSON.stringify(data),
		);
	}
});

test("unknown extra entry fields are ignored, so an additive version-1 field stays readable", () => {
	const data = { version: 1, pending: { ...PENDING, future: true }, future: "ignored" };
	assert.deepEqual(readPendingClarification([rawEntry(data)]), { kind: "pending", pending: PENDING });
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
		}),
		["--budget 5000", "--file x2", "--image", "--remote-image"],
	);
});

test("the restore, malformed, and open-clarification notices state the real state", () => {
	const plain = formatPendingClarificationRestoredNotice(PENDING);
	assert.match(plain, /^Objective clarification restored: no new Goal is committed yet\./);
	assert.match(plain, /save the confirmation editor to create the Goal/);
	assert.match(plain, /run \/goal <new idea> to start over/);
	assert.ok(!plain.includes("held unread"), "no held-flag sentence without flags");

	const held = formatPendingClarificationRestoredNotice({
		idea: IDEA,
		budget: { kind: "value", value: 5000 },
		attachments: [{ kind: "text", path: "spec.md" }],
	});
	assert.match(held, /Its held flags \(--budget 5000, --file\) are unchanged/);
	assert.match(held, /nothing has been read, materialized, or fetched/);
	const heldPlural = formatPendingClarificationRestoredNotice({
		idea: IDEA,
		budget: { kind: "none" },
		attachments: [
			{ kind: "remote-image", url: "https://example.test/png" },
			{ kind: "image", path: "shot.png" },
		],
	});
	assert.match(heldPlural, /Its held flags \(--no-budget, --remote-image, --image\) are unchanged/);

	const malformed = formatPendingClarificationMalformedNotice();
	assert.match(malformed, /could not read the newest pending Objective clarification/);
	assert.match(malformed, /propose_goal will refuse/);
	assert.match(malformed, /Run \/goal <objective> to start over/);

	const open = formatOpenClarificationStatus({
		idea: IDEA,
		budget: { kind: "value", value: 5000 },
		attachments: [{ kind: "text", path: "spec.md" }],
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
 * harness always has a dialog-capable UI) and a malformed newest entry (only a
 * hand-edited or corrupt file produces one).
 */
function restartFixture(branch, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-clarify85-unit-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, branch.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	const state = { settings: options.settings ?? { goal: { clarifyOnCreate: true } }, notifications: [] };
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
			return tools.map((tool) => ({ name: tool.name, sourceInfo: { path: OWN_SOURCE } }));
		},
		getSettings() {
			return state.settings;
		},
		appendEntry(customType, data) {
			appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
		},
		sendUserMessage() {},
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
			editor: async () => undefined,
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
	const branch = [entry({ ...PENDING, budget: { kind: "value", value: 5000 } })];

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

test("a malformed newest entry is surfaced and offers nothing, without falling back", async () => {
	// An older readable pending entry followed by an unreadable newest one: the
	// older entry must not be offered, and the session says why.
	const branch = [entry(PENDING), rawEntry({ version: 2, pending: { ...PENDING, idea: OTHER_IDEA } })];
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
