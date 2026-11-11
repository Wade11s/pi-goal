/**
 * Headless and interactive objective-editing tests that drive the extension's
 * command handler directly with a fake Pi API and command context.
 *
 * These cover the UI guard without spawning a full Pi subprocess: the editor
 * dialog is a terminal-only surface in print/JSON mode (`ctx.hasUI` false), so
 * bare `/goal edit` must explain the typed form instead of blocking, while a
 * dialog-capable context gets the prefill-and-apply path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";

const OBJECTIVE = "Make the full test suite pass in this repository";
const EDITED_OBJECTIVE = "Ship the release notes page instead";

/** Minimal Pi API that writes durable snapshots to a real session file. */
function fakePi(sessionFile) {
	const handlers = new Map();
	const tools = [];
	let command;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerTool(definition) {
			tools.push(definition);
		},
		registerCommand(name, definition) {
			command = { name, ...definition };
		},
		getSettings() {
			return {};
		},
		appendEntry(customType, data) {
			if (customType === "goal-state") {
				appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
			}
		},
		sendUserMessage() {},
	};
	return { pi, handlers, tools, getCommand: () => command };
}

/** Command context with just enough surface for the /goal command handlers. */
function fakeCtx({ hasUI, sessionFile, editorResult, notifications }) {
	return {
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {},
			confirm: async () => false,
			editor: async () => editorResult,
		},
		mode: hasUI ? "tui" : "print",
		hasUI,
		cwd: "/tmp",
		isIdle: () => true,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionFile: () => sessionFile,
			getBranch: () => [],
		},
	};
}

function lastSnapshot(sessionFile) {
	const entries = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	const snapshots = entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-state");
	return snapshots[snapshots.length - 1];
}

test("bare /goal edit never opens a terminal-only dialog when no UI exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-headless-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, getCommand } = fakePi(sessionFile);
		goalExtension(pi);
		const command = getCommand();
		assert.ok(command, "the /goal command was registered");

		// Create a Goal through the command handler. The fake Pi API writes the
		// durable snapshot to the session file, exactly as Pi's appendEntry does.
		const created = [];
		const createCtx = fakeCtx({ hasUI: false, sessionFile, notifications: created });
		await command.handler(OBJECTIVE, createCtx);
		assert.ok(
			created.some((n) => n.message.includes("created and activated")),
			`creation failed: ${JSON.stringify(created)}`,
		);
		const snapshot = lastSnapshot(sessionFile);
		assert.equal(snapshot.data.goal.objective, OBJECTIVE);

		// Bare `/goal edit` in a mode without dialog-capable UI must not call the
		// editor; it tells the user to use the typed form instead.
		let editorCalled = false;
		const headless = [];
		const headlessCtx = fakeCtx({
			hasUI: false,
			sessionFile,
			editorResult: "should not be applied",
			notifications: headless,
		});
		headlessCtx.ui.editor = async () => {
			editorCalled = true;
			return "should not be applied";
		};
		await command.handler("edit", headlessCtx);
		assert.equal(editorCalled, false, "the terminal-only editor dialog was opened without a UI");
		assert.ok(
			headless.some((n) => n.message.includes("needs a UI") && n.message.includes("/goal edit <new objective>")),
			`headless guidance missing: ${JSON.stringify(headless)}`,
		);
		assert.equal(lastSnapshot(sessionFile).data.goal.objective, OBJECTIVE, "the objective is unchanged");

		// The typed form still works headless.
		const typed = [];
		await command.handler(`edit ${EDITED_OBJECTIVE}`, fakeCtx({ hasUI: false, sessionFile, notifications: typed }));
		assert.ok(
			typed.some((n) => n.message.includes("objective updated")),
			`typed edit failed: ${JSON.stringify(typed)}`,
		);
		assert.equal(lastSnapshot(sessionFile).data.goal.objective, EDITED_OBJECTIVE);
		assert.ok(
			typed.every((n) => n.type !== "error"),
			`unexpected error notification: ${JSON.stringify(typed)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bare /goal edit opens a prefilled editor and applies the edited objective", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-interactive-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, getCommand } = fakePi(sessionFile);
		goalExtension(pi);
		const command = getCommand();

		const created = [];
		await command.handler(OBJECTIVE, fakeCtx({ hasUI: true, sessionFile, notifications: created }));
		assert.ok(created.some((n) => n.message.includes("created and activated")));

		const edited = [];
		const editorCtx = fakeCtx({
			hasUI: true,
			sessionFile,
			editorResult: EDITED_OBJECTIVE,
			notifications: edited,
		});
		await command.handler("edit", editorCtx);
		assert.ok(
			edited.some((n) => n.message.includes("objective updated")),
			`edit failed: ${JSON.stringify(edited)}`,
		);
		const snapshot = lastSnapshot(sessionFile);
		assert.equal(snapshot.data.goal.objective, EDITED_OBJECTIVE);
		assert.equal(snapshot.data.goal.status, "active", "editing preserves the lifecycle status");

		// Cancelling the dialog leaves the objective unchanged.
		const cancelled = [];
		const cancelCtx = fakeCtx({ hasUI: true, sessionFile, editorResult: undefined, notifications: cancelled });
		await command.handler("edit", cancelCtx);
		assert.ok(
			cancelled.some((n) => n.message.includes("cancelled")),
			`cancellation was not reported: ${JSON.stringify(cancelled)}`,
		);
		assert.equal(lastSnapshot(sessionFile).data.goal.objective, EDITED_OBJECTIVE);
		assert.ok(
			cancelled.every((n) => n.type !== "error"),
			`unexpected error notification: ${JSON.stringify(cancelled)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bare /goal edit with no Goal does not open an editor dialog", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-no-goal-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, getCommand } = fakePi(sessionFile);
		goalExtension(pi);
		const command = getCommand();

		let editorCalled = false;
		const notifications = [];
		const ctx = fakeCtx({ hasUI: true, sessionFile, notifications });
		ctx.ui.editor = async () => {
			editorCalled = true;
			return "should not be applied";
		};
		await command.handler("edit", ctx);
		assert.equal(editorCalled, false);
		assert.ok(
			notifications.some((n) => n.message.includes("There is no Goal to edit")),
			`missing no-Goal guidance: ${JSON.stringify(notifications)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
