/**
 * Headless and interactive objective-editing tests that drive the extension's
 * command handler directly with a fake Pi API and command context, plus the
 * Goal command family's registration surface.
 *
 * These cover the UI guard without spawning a full Pi subprocess: the editor
 * dialog is a terminal-only surface in print/JSON mode (`ctx.hasUI` false), so
 * bare `/goal:edit` must explain the typed form instead of blocking, while a
 * dialog-capable context gets the prefill-and-apply path.
 *
 * The same fake Pi API is the only deterministic place the registered command
 * surface can be observed: the six names of the Goal command family (and no
 * seventh `goal*` command), the `/` menu descriptions, and the argument
 * completions `/goal ` and `/goal:resume ` offer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";

const OBJECTIVE = "Make the full test suite pass in this repository";
const EDITED_OBJECTIVE = "Ship the release notes page instead";

/** The Goal command family, exactly as Pi lists it in the `/` menu. */
const GOAL_COMMANDS = ["goal", "goal:pause", "goal:resume", "goal:clear", "goal:history", "goal:edit"];

/** Minimal Pi API that writes durable snapshots to a real session file. */
function fakePi(sessionFile) {
	const handlers = new Map();
	const tools = [];
	const commands = new Map();
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
		getSettings() {
			return {};
		},
		appendEntry(customType, data) {
			if (customType === "goal-state") {
				appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
			}
		},
		sendUserMessage() {},
		// pi-goal's optional companion seam registers a bridge listener at load, so a
		// faithful fake Pi needs the shared event bus Pi always provides.
		events: {
			on() {
				return () => {};
			},
			emit() {},
		},
	};
	return { pi, handlers, tools, commands };
}

/** Command context with just enough surface for the Goal command handlers. */
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

/** Every raw `goal-state` line, as bytes, for a before/after "nothing happened" proof. */
function goalStateBytes(sessionFile) {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "" && line.includes('"goal-state"'))
		.join("\n");
}

test("the Goal command family is six registered commands and nothing else", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-commands-"));
	try {
		const { pi, commands } = fakePi(join(dir, "session.jsonl"));
		goalExtension(pi);
		assert.deepEqual(
			[...commands.keys()].sort(),
			[...GOAL_COMMANDS].sort(),
			"exactly goal and its five verbs are registered",
		);
		// No `/goal:status` and no `/goal:create`: bare `/goal` already is the status
		// report and `/goal <objective>` already is the creation.
		const goalPrefixed = [...commands.keys()].filter((name) => name.startsWith("goal"));
		assert.deepEqual(goalPrefixed.sort(), [...GOAL_COMMANDS].sort(), "no seventh goal* command");

		// Each verb is its own `/` menu line with a one-line description of its own;
		// `/goal` describes creation and inspection only.
		for (const name of GOAL_COMMANDS) {
			const command = commands.get(name);
			assert.equal(typeof command.handler, "function", `/${name} has a handler`);
			assert.ok(command.description && command.description.length > 0, `/${name} has a description`);
		}
		assert.match(commands.get("goal").description, /\/goal <objective>/);
		assert.doesNotMatch(commands.get("goal").description, /goal:(pause|resume|clear|history|edit)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every registered command reports its own throw as a notification instead of escaping into Pi", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-command-errors-"));
	try {
		const { pi, commands, handlers } = fakePi(join(dir, "session.jsonl"));
		goalExtension(pi);
		const notifications = [];
		const sessionFile = join(dir, "session.jsonl");
		const ctx = fakeCtx({ hasUI: false, sessionFile, notifications });
		const start = handlers.get("session_start");
		assert.ok(start, "pi-goal registered a session_start handler");
		await start({ type: "session_start" }, ctx);
		// An active Goal, so each verb reaches its real work rather than a no-Goal
		// early return. The injected fault is a notification channel that throws:
		// exactly the failure the command runner's net exists to absorb.
		await commands.get("goal").handler(OBJECTIVE, ctx);
		const before = notifications.length;
		ctx.ui.notify = () => {
			throw new Error("the notification channel failed");
		};
		const errors = [];
		for (const name of GOAL_COMMANDS) {
			await commands.get(name).handler("", {
				...ctx,
				ui: {
					...ctx.ui,
					notify: (message, type) => {
						if (type === "error" && message.startsWith("pi-goal error:")) {
							errors.push({ name, message });
							return;
						}
						throw new Error("the notification channel failed");
					},
				},
			});
		}
		assert.deepEqual(
			errors.map((e) => e.name),
			GOAL_COMMANDS,
			`each registered command reported its own throw: ${JSON.stringify({ before, errors })}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/goal completes its creation flags, /goal:resume completes --budget, and /goal:edit completes --title", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-completions-"));
	try {
		const { pi, commands } = fakePi(join(dir, "session.jsonl"));
		goalExtension(pi);
		const values = (items) => (items ?? []).map((item) => item.value);

		const create = commands.get("goal").getArgumentCompletions;
		assert.equal(typeof create, "function");
		assert.deepEqual(values(create("")), ["--budget", "--no-budget", "--file", "--image", "--remote-image"]);
		assert.deepEqual(values(create("--")), ["--budget", "--no-budget", "--file", "--image", "--remote-image"]);
		assert.deepEqual(values(create("--f")), ["--file"]);
		assert.deepEqual(values(create("--i")), ["--image"]);
		assert.deepEqual(values(create("--no")), ["--no-budget"]);
		assert.deepEqual(values(create("--remote-image")), ["--remote-image"]);
		// Nothing matches: Pi's default behavior applies.
		assert.deepEqual(values(create("--zzz")), []);
		assert.deepEqual(values(create("objective text")), []);

		const resume = commands.get("goal:resume").getArgumentCompletions;
		assert.equal(typeof resume, "function");
		assert.deepEqual(values(resume("")), ["--budget"]);
		assert.deepEqual(values(resume("--b")), ["--budget"]);
		assert.deepEqual(values(resume("--budget")), ["--budget"]);
		assert.deepEqual(values(resume("--x")), []);

		const edit = commands.get("goal:edit").getArgumentCompletions;
		assert.equal(typeof edit, "function");
		assert.deepEqual(values(edit("")), ["--title"]);
		assert.deepEqual(values(edit("--t")), ["--title"]);
		assert.deepEqual(values(edit("--title")), ["--title"]);
		assert.deepEqual(values(edit("--x")), []);
		assert.deepEqual(values(edit("objective text")), []);

		// No other command in the family completes.
		for (const name of ["goal:pause", "goal:clear", "goal:history"]) {
			assert.equal(commands.get(name).getArgumentCompletions, undefined, `/${name} offers no completion`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bare /goal:edit never opens a terminal-only dialog when no UI exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-headless-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, commands } = fakePi(sessionFile);
		goalExtension(pi);
		const goal = commands.get("goal");
		assert.ok(goal, "the /goal command was registered");

		// Create a Goal through the command handler. The fake Pi API writes the
		// durable snapshot to the session file, exactly as Pi's appendEntry does.
		const created = [];
		const createCtx = fakeCtx({ hasUI: false, sessionFile, notifications: created });
		await goal.handler(OBJECTIVE, createCtx);
		assert.ok(
			created.some((n) => n.message.includes("created and activated")),
			`creation failed: ${JSON.stringify(created)}`,
		);
		const snapshot = lastSnapshot(sessionFile);
		assert.equal(snapshot.data.goal.objective, OBJECTIVE);

		// Bare `/goal:edit` in a mode without dialog-capable UI must not call the
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
		await commands.get("goal:edit").handler("", headlessCtx);
		assert.equal(editorCalled, false, "the terminal-only editor dialog was opened without a UI");
		assert.ok(
			headless.some((n) => n.message.includes("needs a UI") && n.message.includes("/goal:edit <new objective>")),
			`headless guidance missing: ${JSON.stringify(headless)}`,
		);
		assert.equal(lastSnapshot(sessionFile).data.goal.objective, OBJECTIVE, "the objective is unchanged");

		// The typed form still works headless.
		const typed = [];
		await commands.get("goal:edit").handler(EDITED_OBJECTIVE, fakeCtx({ hasUI: false, sessionFile, notifications: typed }));
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

test("bare /goal:edit opens a prefilled editor and applies the edited objective", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-interactive-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, commands } = fakePi(sessionFile);
		goalExtension(pi);

		const created = [];
		await commands.get("goal").handler(OBJECTIVE, fakeCtx({ hasUI: true, sessionFile, notifications: created }));
		assert.ok(created.some((n) => n.message.includes("created and activated")));

		const prefilled = [];
		let prefill;
		const editorCtx = fakeCtx({
			hasUI: true,
			sessionFile,
			editorResult: EDITED_OBJECTIVE,
			notifications: prefilled,
		});
		editorCtx.ui.editor = async (_title, value) => {
			prefill = value;
			return EDITED_OBJECTIVE;
		};
		await commands.get("goal:edit").handler("", editorCtx);
		assert.equal(prefill, OBJECTIVE, "the dialog opens prefilled with the current Objective");
		assert.ok(
			prefilled.some((n) => n.message.includes("objective updated")),
			`edit failed: ${JSON.stringify(prefilled)}`,
		);
		const snapshot = lastSnapshot(sessionFile);
		assert.equal(snapshot.data.goal.objective, EDITED_OBJECTIVE);
		assert.equal(snapshot.data.goal.status, "active", "editing preserves the lifecycle status");

		// Cancelling the dialog leaves the objective unchanged.
		const cancelled = [];
		const cancelCtx = fakeCtx({ hasUI: true, sessionFile, editorResult: undefined, notifications: cancelled });
		await commands.get("goal:edit").handler("", cancelCtx);
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

test("bare /goal:edit with no Goal does not open an editor dialog", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-no-goal-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, commands } = fakePi(sessionFile);
		goalExtension(pi);

		let editorCalled = false;
		const notifications = [];
		const ctx = fakeCtx({ hasUI: true, sessionFile, notifications });
		ctx.ui.editor = async () => {
			editorCalled = true;
			return "should not be applied";
		};
		await commands.get("goal:edit").handler("", ctx);
		assert.equal(editorCalled, false);
		assert.ok(
			notifications.some((n) => n.message.includes("There is no Goal to edit")),
			`missing no-Goal guidance: ${JSON.stringify(notifications)}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/goal:edit keeps refusing attachment flags with the Replacement Goal guidance", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-edit-flags-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, commands } = fakePi(sessionFile);
		goalExtension(pi);
		const created = [];
		await commands.get("goal").handler(OBJECTIVE, fakeCtx({ hasUI: true, sessionFile, notifications: created }));
		const before = goalStateBytes(sessionFile);

		for (const args of [
			"--file notes.md Ship the release notes",
			"--image shot.png Ship the release notes",
			"--remote-image https://example.com/shot.png Ship the release notes",
		]) {
			const refused = [];
			await commands.get("goal:edit").handler(args, fakeCtx({ hasUI: true, sessionFile, notifications: refused }));
			assert.ok(
				refused.some(
					(n) =>
						n.type === "error" &&
						n.message.includes("Goal not edited") &&
						n.message.includes("Replacement Goal"),
				),
				`${args} must be refused with the Replacement Goal guidance: ${JSON.stringify(refused)}`,
			);
			assert.equal(goalStateBytes(sessionFile), before, `${args} writes no Goal bytes`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stray argument on a verb is a usage error that touches no Goal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-verb-args-"));
	const sessionFile = join(dir, "session.jsonl");
	try {
		const { pi, commands } = fakePi(sessionFile);
		goalExtension(pi);
		const created = [];
		await commands.get("goal").handler(OBJECTIVE, fakeCtx({ hasUI: true, sessionFile, notifications: created }));
		const before = goalStateBytes(sessionFile);
		assert.equal(lastSnapshot(sessionFile).data.goal.status, "active");

		// pause, clear, and history take no argument at all.
		for (const [name, args] of [
			["goal:pause", "foo"],
			["goal:clear", "the lint errors"],
			["goal:history", "of the release"],
		]) {
			const notifications = [];
			await commands.get(name).handler(args, fakeCtx({ hasUI: true, sessionFile, notifications }));
			assert.deepEqual(
				notifications.filter((n) => n.type === "error").map((n) => n.message),
				[`/${name} takes no argument.`],
				`${name} ${args}: ${JSON.stringify(notifications)}`,
			);
			assert.equal(goalStateBytes(sessionFile), before, `${name} ${args} writes no Goal bytes`);
		}

		// Whitespace alone is the bare verb, and it commits as usual: pause the Goal
		// here so the resume cases below have a stopped Goal to leave untouched.
		const paused = [];
		await commands.get("goal:pause").handler("  ", fakeCtx({ hasUI: true, sessionFile, notifications: paused }));
		assert.ok(paused.some((n) => n.message.includes("paused (revision")), JSON.stringify(paused));
		assert.equal(lastSnapshot(sessionFile).data.goal.status, "paused");
		const pausedBytes = goalStateBytes(sessionFile);
		assert.notEqual(pausedBytes, before, "the bare pause committed");

		// resume accepts only --budget, in both spellings; anything else is the same
		// kind of usage error.
		for (const args of ["foo", "--budg 150", "150"]) {
			const notifications = [];
			await commands.get("goal:resume").handler(args, fakeCtx({ hasUI: true, sessionFile, notifications }));
			assert.equal(notifications.length, 1, JSON.stringify(notifications));
			assert.equal(notifications[0].type, "error", `${args}: ${JSON.stringify(notifications)}`);
			assert.match(notifications[0].message, /\/goal:resume takes no argument except --budget <new-total>/);
			assert.equal(goalStateBytes(sessionFile), pausedBytes, `${args} writes no Goal bytes`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
