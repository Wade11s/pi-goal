/**
 * Issue #84, unit seam: the parts of Objective clarification that a real-Pi
 * session cannot reach deterministically.
 *
 * - the `goal.clarifyOnCreate` setting's default and its malformed-value handling;
 * - the confirmation document's format and parse rules (including the invalid
 *   title structure the editor reopens for);
 * - the UI-less (print/JSON) creation path: skip clarification, create directly,
 *   and say so;
 * - tool gating: `propose_goal` is registered only while the setting is on, and
 *   it refuses without a pending clarification — including after a reload turns
 *   the setting off while the registration stays in place.
 *
 * Everything observable end to end (the interview, the editor, save/cancel/
 * timeout, deferred materialization, restart-free pending state) is covered by
 * `goal84-objective-clarification.test.mjs` against a real `pi --mode rpc`
 * subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";
import { parseClarifyOnCreateSettings } from "../src/accounting.ts";
import {
	CLARIFICATION_ENTRY_TYPE,
	formatClarificationDocument,
	parseClarificationDocument,
} from "../src/clarification.ts";

const OBJECTIVE = "Make the full test suite pass in this repository";
const TITLE = "Suite green";
const DRAFT = "Objective: The suite passes.\n\nConstraints: None\n\nAcceptance criteria:\n1. `npm test` exits zero.";

test("goal.clarifyOnCreate defaults to true and a malformed value is reported once and ignored", () => {
	assert.deepEqual(parseClarifyOnCreateSettings(undefined), { enabled: true, problems: [] });
	assert.deepEqual(parseClarifyOnCreateSettings({ goal: {} }), { enabled: true, problems: [] });
	assert.deepEqual(parseClarifyOnCreateSettings({ goal: { clarifyOnCreate: true } }), { enabled: true, problems: [] });
	assert.deepEqual(parseClarifyOnCreateSettings({ goal: { clarifyOnCreate: false } }), {
		enabled: false,
		problems: [],
	});

	for (const malformed of ["yes", 0, 1, null]) {
		const parsed = parseClarifyOnCreateSettings({ goal: { clarifyOnCreate: malformed } });
		assert.equal(parsed.enabled, true, `${JSON.stringify(malformed)} falls back to the clarifying default`);
		assert.equal(parsed.problems.length, 1);
		assert.match(parsed.problems[0], /goal\.clarifyOnCreate must be a boolean/);
		assert.match(parsed.problems[0], /clarifying each \/goal creation as usual/);
	}
});

test("the confirmation document is one Title line, a blank line, and the Objective body", () => {
	const document = formatClarificationDocument(TITLE, DRAFT);
	assert.equal(document, `Title: ${TITLE}\n\n${DRAFT}`);
	assert.deepEqual(parseClarificationDocument(document), { ok: true, title: TITLE, objective: DRAFT });

	// Editing either part is preserved: the first line is the title, the rest is the
	// Objective (the blank separator is convenience, not syntax).
	assert.deepEqual(parseClarificationDocument(`Title:  Renamed goal  \n${DRAFT}`), {
		ok: true,
		title: "Renamed goal",
		objective: DRAFT,
	});
	// A CRLF host and a leading blank line are transport/writing artifacts, not
	// invalid structure.
	assert.deepEqual(parseClarificationDocument(`\r\nTitle: Renamed goal\r\n\r\n${DRAFT}\r\n`), {
		ok: true,
		title: "Renamed goal",
		objective: DRAFT,
	});
	// An empty title is structurally present; the title rule refuses it with the
	// creation wording, which is what reopens the document.
	assert.deepEqual(parseClarificationDocument("Title:\n\nbody text here"), {
		ok: true,
		title: "",
		objective: "body text here",
	});
	// A body with no title line is the invalid structure the editor reopens for.
	for (const invalid of ["", DRAFT, "Objective: x", "title: lowercase prefix"]) {
		const parsed = parseClarificationDocument(invalid);
		assert.equal(parsed.ok, false, JSON.stringify(invalid));
		assert.match(parsed.error, /^Goal not created: the confirmation's first line must be `Title: <title>`/);
	}
});

/**
 * A fake Pi plus a command/tool context that records durable entries of every
 * custom type, so the pending clarification and the Goal snapshot are both
 * observable. `getAllTools()` reports pi-goal's own tools with one shared source
 * path, which is how the registration checks identify this extension.
 */
function fixture(settings = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-clarify-unit-"));
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
	const state = { settings, notifications: [], messages: [], editors: [] };
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
			return [...tools.map((tool) => ({ name: tool.name, sourceInfo: { path: OWN_SOURCE } }))];
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
		mode: "print",
		hasUI: false,
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

async function startSession(fx) {
	const start = fx.handlers.get("session_start");
	assert.ok(start, "pi-goal registered a session_start handler");
	await start({ type: "session_start" }, fx.ctx);
}

function customEntries(fx, customType) {
	return fx.entries().filter((entry) => entry.type === "custom" && entry.customType === customType);
}

test("a UI-less host skips clarification, creates directly, and says so", async () => {
	const fx = fixture({ goal: { clarifyOnCreate: true } });
	try {
		goalExtension(fx.pi);
		await startSession(fx);

		await fx.commands.get("goal").handler(OBJECTIVE, fx.ctx);

		const created = fx.state.notifications.find((notice) => notice.message.includes("created and activated"));
		assert.ok(created, JSON.stringify(fx.state.notifications));
		const skipped = fx.state.notifications.find((notice) =>
			notice.message.includes("Objective clarification was skipped: this Pi mode has no dialog-capable UI"),
		);
		assert.ok(skipped, `the skip notice is printed: ${JSON.stringify(fx.state.notifications)}`);
		assert.equal(skipped.type, "info");
		assert.equal(customEntries(fx, CLARIFICATION_ENTRY_TYPE).length, 0, "no pending clarification was recorded");
		assert.equal(fx.state.editors.length, 0, "no editor was opened");
		assert.equal(fx.state.messages.length, 1, "the raw idea became the kickoff, not an interview");
		const goal = customEntries(fx, "goal-state").at(-1).data.goal;
		assert.equal(goal.objective, OBJECTIVE);
		assert.equal(goal.title, undefined, "the UI-less direct creation is title-less");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("a UI-capable /goal records the pending clarification durably and sends the interview instead of committing", async () => {
	const fx = fixture({ goal: { clarifyOnCreate: true } });
	try {
		goalExtension(fx.pi);
		await startSession(fx);
		const ctx = { ...fx.ctx, hasUI: true, mode: "tui" };

		await fx.commands.get("goal").handler(`--budget 5000 ${OBJECTIVE}`, ctx);

		assert.equal(customEntries(fx, "goal-state").length, 0, "no Goal was committed");
		const pending = customEntries(fx, CLARIFICATION_ENTRY_TYPE).at(-1).data.pending;
		assert.deepEqual(pending, { idea: OBJECTIVE, budget: { kind: "value", value: 5000 }, attachments: [] });
		assert.ok(
			fx.state.notifications.some((notice) => notice.message.includes("Objective clarification started")),
			JSON.stringify(fx.state.notifications),
		);
		assert.equal(fx.state.editors.length, 0, "the editor is opened by propose_goal, not by the command");
		const interview = fx.state.messages.at(-1);
		assert.ok(interview.includes("[pi-goal] Objective clarification"), String(interview));
		assert.ok(interview.includes(OBJECTIVE), "the raw idea reaches the interview instruction");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("propose_goal is registered only while clarification is on, and refuses without a pending clarification", async () => {
	const enabled = fixture({ goal: { clarifyOnCreate: true } });
	try {
		goalExtension(enabled.pi);
		await startSession(enabled);
		const propose = enabled.tools.find((tool) => tool.name === "propose_goal");
		assert.ok(propose, `clarification enabled registers the confirmation tool: ${enabled.tools.map((tool) => tool.name)}`);
		assert.match(propose.description, /confirmation editor/);
		assert.match(propose.description, /saving that editor is what creates the Goal/);
		assert.ok(
			propose.promptGuidelines.some((line) => line.includes("`Objective:`") && line.includes("`Acceptance criteria:`")),
			"the three-section template is model-facing guidance",
		);

		// No /goal ran, so there is no pending clarification: the call is refused
		// with no Goal and no editor.
		const refused = await propose.execute("call-1", { title: TITLE, objective: DRAFT }, undefined, undefined, {
			...enabled.ctx,
			hasUI: true,
		});
		assert.equal(refused.isError, true);
		const text = refused.content.map((block) => block.text).join("\n");
		assert.match(text, /no Objective clarification is in progress/);
		assert.equal(refused.structuredContent.goal, null);
		assert.equal(enabled.state.editors.length, 0);
		assert.equal(customEntries(enabled, "goal-state").length, 0);

		// A reload with the setting off leaves the registration in place (Pi cannot
		// unregister), so the tool must refuse rather than open an editor for a flow
		// the user switched off.
		enabled.state.settings = { goal: { clarifyOnCreate: false } };
		await startSession(enabled);
		const off = await propose.execute("call-2", { title: TITLE, objective: DRAFT }, undefined, undefined, {
			...enabled.ctx,
			hasUI: true,
		});
		assert.equal(off.isError, true);
		assert.match(off.content[0].text, /Objective clarification is off for this session/);
		assert.equal(enabled.state.editors.length, 0);
	} finally {
		rmSync(enabled.dir, { recursive: true, force: true });
	}

	const disabled = fixture({ goal: { clarifyOnCreate: false } });
	try {
		goalExtension(disabled.pi);
		await startSession(disabled);
		assert.equal(
			disabled.tools.some((tool) => tool.name === "propose_goal"),
			false,
			"the off setting registers no confirmation tool",
		);
	} finally {
		rmSync(disabled.dir, { recursive: true, force: true });
	}
});
