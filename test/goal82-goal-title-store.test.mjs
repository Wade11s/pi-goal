/**
 * Issue #82: the Goal title at the unit seam — validation, store durability and
 * backward compatibility, the command surface, the privacy projections, and the
 * session-naming preference.
 *
 * Everything here runs without a `pi` subprocess: the store is driven directly
 * through a fake Pi API that retains what it is handed, the command handlers run
 * against a minimal fake session/context, and the pure projections are called with
 * a committed record. That is the cheaper seam the ticket asks for, because these
 * are exactly the cases a real-Pi test cannot reach deterministically — a
 * hand-written legacy snapshot, a malformed title, and a settings reload that
 * disables admission for an already-active Goal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalExtension from "../src/index.ts";
import { GoalStore, validateGoalTitle } from "../src/store.ts";
import {
	CUSTOM_ENTRY_TYPE,
	formatGoalSummary,
	toPublicState,
} from "../src/goal.ts";
import { toGoalUpdatedEvent } from "../src/events.ts";
import { toGoalHistoryRecord } from "../src/history.ts";
import { toGoalMetrics } from "../src/metrics.ts";
import {
	MAX_SESSION_NAME_LENGTH,
	applySessionNameFromGoal,
	deriveSessionNameFromGoal,
} from "../src/session-naming.ts";

const OBJECTIVE = "Make the full test suite pass in this repository";
const EDITED_OBJECTIVE = "Ship the release notes page instead";
const TITLE = "Bluebird launch";

/** Minimal `ExtensionAPI` stand-in that retains what it is given, like Pi does. */
function fakePi() {
	const entries = [];
	return {
		entries,
		appendEntry(customType, data) {
			entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
		},
	};
}

/** Minimal `ExtensionContext` stand-in over a branch of retained entries. */
function fakeCtx(entries) {
	return { sessionManager: { getBranch: () => entries, getSessionFile: () => "/tmp/session.jsonl" } };
}

/** A hand-written version-1 snapshot, as a pre-#82 branch could contain it. */
function legacySnapshot(overrides = {}) {
	return {
		version: 1,
		repaired: true,
		goal: {
			id: "goal_1234abcd",
			objective: "A Goal written before titles existed",
			status: "paused",
			origin: "command",
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_100_000,
			revision: 3,
			...overrides,
		},
	};
}

function snapshotEntry(data) {
	return { type: "custom", id: "legacy-entry", customType: CUSTOM_ENTRY_TYPE, data };
}

// ---------------------------------------------------------------------------
// Title validation
// ---------------------------------------------------------------------------

test("a Goal title is one line of 1 to 80 characters after trimming", () => {
	assert.deepEqual(validateGoalTitle("Release prep"), { ok: true, title: "Release prep" });
	assert.deepEqual(validateGoalTitle("  Release prep  "), { ok: true, title: "Release prep" });
	assert.deepEqual(validateGoalTitle("x"), { ok: true, title: "x" });
	assert.deepEqual(validateGoalTitle("x".repeat(80)), { ok: true, title: "x".repeat(80) });

	const invalid = [
		["", /1 to 80 characters/],
		["   ", /1 to 80 characters/],
		["x".repeat(81), /1 to 80 characters/],
		["two\nlines", /one line/],
		["two\rlines", /one line/],
		["two\u2028lines", /one line/],
		["two\u0085lines", /one line/],
		// The one line rule is checked before trimming, so a terminator at either
		// edge is refused rather than silently stripped into an accepted label.
		["Release prep\n", /one line/],
		["\nRelease prep", /one line/],
		["Release prep\r", /one line/],
		["\r\nRelease prep\r\n", /one line/],
		["Release prep\u2028", /one line/],
		["\u2029Release prep", /one line/],
		["Release prep\u0085", /one line/],
	];
	for (const [raw, expected] of invalid) {
		const result = validateGoalTitle(raw);
		assert.equal(result.ok, false, `${JSON.stringify(raw)} must be refused`);
		assert.match(result.error, /^Goal not edited:/);
		assert.match(result.error, expected);
	}
});

test("the title cap counts code points, so an emoji-heavy title is not refused", () => {
	const rockets = "🚀".repeat(80);
	assert.deepEqual(validateGoalTitle(rockets), { ok: true, title: rockets });
	assert.equal(validateGoalTitle(`${rockets}🚀`).ok, false, "81 code points is over the cap");
});

// ---------------------------------------------------------------------------
// Creation and the in-place edit
// ---------------------------------------------------------------------------

test("every existing creation path produces a title-less Goal", () => {
	const store = new GoalStore();
	for (const origin of ["command", "tool"]) {
		const goal = store.create(OBJECTIVE, origin);
		assert.equal(Object.hasOwn(goal, "title"), false, `${origin} creation has no title field`);
		assert.equal(toPublicState(goal).title, null, "the structured state reports null, not a guess");
	}
	const budgeted = store.create(OBJECTIVE, "command", { tokenBudget: 100 });
	assert.equal(budgeted.title, undefined, "a budget does not invent a title");
});

test("a title-only edit keeps identity, objective, and status, and advances the revision", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const created = store.create(OBJECTIVE, "command");
	store.stage(pi, created);
	store.commit(created);

	const result = store.editInPlace(pi, { title: TITLE });
	assert.equal(result.ok, true);
	const goal = store.get();
	assert.equal(goal.id, created.id);
	assert.equal(goal.objective, OBJECTIVE, "the objective is untouched");
	assert.equal(goal.createdAt, created.createdAt);
	assert.equal(goal.origin, "command");
	assert.equal(goal.status, "active");
	assert.equal(goal.title, TITLE, "the title is durable Goal state");
	assert.equal(goal.revision, 1, "the edit is the next revision");

	// The durable snapshot is where "persisted Goal state" is proved.
	const snapshot = pi.entries.at(-1).data.goal;
	assert.equal(snapshot.title, TITLE);

	const state = toPublicState(goal);
	assert.equal(state.title, TITLE);
	assert.match(formatGoalSummary(state), new RegExp(`^Title: ${TITLE}$`, "m"));
});

test("a combined edit changes the objective and title in one revision", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const created = store.create(OBJECTIVE, "command");
	store.stage(pi, created);
	store.commit(created);

	const result = store.editInPlace(pi, { objective: EDITED_OBJECTIVE, title: TITLE });
	assert.equal(result.ok, true);
	const goal = store.get();
	assert.equal(goal.objective, EDITED_OBJECTIVE);
	assert.equal(goal.title, TITLE);
	assert.equal(goal.revision, 1, "both changes are one committed revision");
	assert.equal(pi.entries.length, 2, "and one snapshot");
});

test("a complete Goal refuses an objective edit but admits a title-only relabel", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const created = store.create(OBJECTIVE, "command");
	store.stage(pi, created);
	store.commit(created);
	const completed = store.markComplete(pi, { id: created.id, revision: created.revision });
	assert.equal(completed.ok, true);
	const completeRevision = store.get().revision;
	const appends = pi.entries.length;

	const objectiveEdit = store.editInPlace(pi, { objective: EDITED_OBJECTIVE });
	assert.equal(objectiveEdit.ok, false);
	assert.equal(objectiveEdit.reason, "not-eligible");
	const combined = store.editInPlace(pi, { objective: EDITED_OBJECTIVE, title: TITLE });
	assert.equal(combined.ok, false, "a combined edit whose objective is refused is refused whole");
	assert.equal(pi.entries.length, appends, "a refused edit writes nothing");
	assert.equal(store.get().title, undefined, "and changes nothing");

	const relabel = store.editInPlace(pi, { title: TITLE });
	assert.equal(relabel.ok, true, "a label change reopens no work, so completion does not freeze it");
	assert.equal(store.get().status, "complete");
	assert.equal(store.get().objective, OBJECTIVE);
	assert.equal(store.get().title, TITLE);
	assert.equal(store.get().revision, completeRevision + 1);
});

test("creation accepts an already-validated title, so the clarified path will persist one", () => {
	const store = new GoalStore();
	const goal = store.create(OBJECTIVE, "command", { title: TITLE });
	assert.equal(goal.title, TITLE);
	assert.equal(toPublicState(goal).title, TITLE);
});

// ---------------------------------------------------------------------------
// Backward compatibility and malformed snapshots
// ---------------------------------------------------------------------------

test("a title-less snapshot reconstructs unchanged", () => {
	const store = new GoalStore();
	store.reconstruct(fakeCtx([snapshotEntry(legacySnapshot())]));
	const goal = store.get();
	assert.ok(goal, "the legacy Goal is reconstructed");
	assert.equal(goal.id, "goal_1234abcd");
	assert.equal(goal.objective, "A Goal written before titles existed");
	assert.equal(goal.status, "paused");
	assert.equal(Object.hasOwn(goal, "title"), false, "no title was invented");
	assert.equal(toPublicState(goal).title, null);
});

test("a persisted title reconstructs verbatim on a new branch read", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const created = store.create(OBJECTIVE, "command");
	store.stage(pi, created);
	store.commit(created);
	assert.equal(store.editInPlace(pi, { title: TITLE }).ok, true);

	const reopened = new GoalStore();
	reopened.reconstruct(fakeCtx(pi.entries));
	assert.equal(reopened.get().title, TITLE);
	assert.equal(reopened.get().revision, 1);
});

test("a malformed title is dropped at reconstruction without losing the Goal", () => {
	for (const title of [
		"two\nlines",
		"x".repeat(81),
		`  ${"y".repeat(90)}  `,
		// A leading or trailing terminator is invalid too: reconstruction must not
		// normalize what the live validation refuses.
		"Release prep\n",
		"\u2028Release prep",
	]) {
		const store = new GoalStore();
		store.reconstruct(fakeCtx([snapshotEntry(legacySnapshot({ title }))]));
		const goal = store.get();
		assert.ok(goal, `${JSON.stringify(title)} must not fail the snapshot closed`);
		assert.equal(goal.id, "goal_1234abcd");
		assert.equal(Object.hasOwn(goal, "title"), false, "the unusable label is dropped");
	}
});

test("a non-string title is structurally invalid, so the newest snapshot fails closed", () => {
	const store = new GoalStore();
	assert.equal(store.reconstruct(fakeCtx([snapshotEntry(legacySnapshot({ title: 42 }))])), null);
	assert.equal(store.get(), null);
});

// ---------------------------------------------------------------------------
// Privacy: events, history, and metrics never carry the title text
// ---------------------------------------------------------------------------

test("a title edit announces a metadata-only transition", () => {
	const events = [];
	const store = new GoalStore({
		onDurableTransition: (kind, goal, committedAt) => events.push({ kind, goal, committedAt }),
	});
	const pi = fakePi();
	const created = store.create(OBJECTIVE, "command");
	store.stage(pi, created);
	store.commit(created);
	assert.equal(store.editInPlace(pi, { title: TITLE }).ok, true);

	assert.deepEqual(events.map((event) => event.kind), ["created", "objective-edited"]);
	const titleEvent = toGoalUpdatedEvent(events[1].kind, events[1].goal);
	const serialized = JSON.stringify(titleEvent);
	assert.equal(serialized.includes(TITLE), false, "the event never repeats the label");
	assert.equal(Object.hasOwn(titleEvent.goal, "title"), false, "and has no title field to leak it from");
});

test("the history and metrics projections have no title text or field", () => {
	const store = new GoalStore();
	const goal = { ...store.create(OBJECTIVE, "command"), title: TITLE, revision: 1 };
	const event = toGoalUpdatedEvent("objective-edited", goal);

	const history = toGoalHistoryRecord(event, "active");
	const historyJson = JSON.stringify(history);
	assert.equal(historyJson.includes(TITLE), false);
	assert.equal(Object.hasOwn(history, "title"), false);

	const metrics = toGoalMetrics(event);
	const metricsJson = JSON.stringify(metrics);
	assert.equal(metricsJson.includes(TITLE), false);
	assert.equal(Object.hasOwn(metrics, "title"), false);
});

// ---------------------------------------------------------------------------
// Session naming prefers the title
// ---------------------------------------------------------------------------

test("a Goal's title wins over the Objective's first line, and a missing title falls back", () => {
	assert.equal(
		deriveSessionNameFromGoal({ title: TITLE, objective: "Ship the release notes page\nsecond line" }),
		TITLE,
	);
	assert.equal(
		deriveSessionNameFromGoal({ objective: "Ship the release notes page\nsecond line" }),
		"Ship the release notes page",
		"a title-less Goal keeps the #52 rule",
	);
	assert.equal(deriveSessionNameFromGoal({ title: "   ", objective: "Ship it" }), "Ship it");
	// Hand-edited or future-version text cannot write a wider name than the cap.
	const longTitle = "x".repeat(MAX_SESSION_NAME_LENGTH + 10);
	assert.equal(deriveSessionNameFromGoal({ title: longTitle, objective: "fallback" }), "x".repeat(80));
	const rockets = "🚀".repeat(MAX_SESSION_NAME_LENGTH + 5);
	assert.equal(
		Array.from(deriveSessionNameFromGoal({ title: rockets, objective: "fallback" })).length,
		MAX_SESSION_NAME_LENGTH,
		"the cap counts code points, so an emoji is never split",
	);
});

test("the never-overwrite and write-failure rules are unchanged when a title exists", () => {
	const source = { title: TITLE, objective: OBJECTIVE };

	const named = (name) => ({
		name,
		calls: [],
		getSessionName() {
			return this.name;
		},
		setSessionName(next) {
			this.calls.push(next);
			this.name = next;
		},
	});
	const existing = named("A name the user chose");
	assert.deepEqual(applySessionNameFromGoal(existing, source, true), {
		kind: "already-named",
		name: "A name the user chose",
	});
	assert.deepEqual(existing.calls, [], "an existing name is never overwritten, title or not");

	const blank = named(undefined);
	assert.deepEqual(applySessionNameFromGoal(blank, source, true), { kind: "named", name: TITLE });
	assert.deepEqual(blank.calls, [TITLE]);

	const off = named(undefined);
	assert.deepEqual(applySessionNameFromGoal(off, source, false), { kind: "off" });
	assert.deepEqual(off.calls, [], "an opted-out session is not even read");

	const failing = {
		getSessionName: () => undefined,
		setSessionName: () => {
			throw new Error("disk full");
		},
	};
	assert.deepEqual(applySessionNameFromGoal(failing, source, true), {
		kind: "failed",
		reason: "disk full",
	});
});

// ---------------------------------------------------------------------------
// Command surface: /goal:edit --title through a fake Pi API
// ---------------------------------------------------------------------------

/** Read the fake session file's entries, tolerating a file that does not exist yet. */
function readEntries(sessionFile) {
	if (!existsSync(sessionFile)) return [];
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

/** Every raw `goal-state` line, as bytes, for a "nothing happened" proof. */
function goalStateBytes(sessionFile) {
	return readEntries(sessionFile)
		.filter((entry) => entry.customType === "goal-state")
		.map((entry) => JSON.stringify(entry))
		.join("\n");
}

/** The newest durable Goal record. */
function lastGoal(sessionFile) {
	const snapshots = readEntries(sessionFile).filter((entry) => entry.customType === "goal-state");
	return snapshots[snapshots.length - 1]?.data.goal;
}

/**
 * A fake Pi API plus the command handler and a branch-reading context.
 *
 * The command surfaces are the only deterministic place a settings reload can be
 * exercised: `getSettings()` is mutable and `getBranch()` re-reads the session
 * file, so re-running `session_start` is a real reload over the written branch.
 */
function commandFixture(settings = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-title-command-"));
	const sessionFile = join(dir, "session.jsonl");
	const state = {
		settings,
		notifications: [],
		messages: [],
		sessionName: undefined,
	};
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerTool() {},
		registerCommand(name, definition) {
			commands.set(name, { name, ...definition });
		},
		getSettings() {
			return state.settings;
		},
		appendEntry(customType, data) {
			appendFileSync(
				sessionFile,
				`${JSON.stringify({ type: "custom", id: `entry-${Date.now()}-${Math.random()}`, customType, data })}\n`,
			);
		},
		sendUserMessage(content) {
			state.messages.push(content);
		},
		getSessionName() {
			return state.sessionName;
		},
		setSessionName(name) {
			state.sessionName = name;
		},
		getCommands() {
			return [...commands.values()];
		},
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
		mode: "print",
		hasUI: false,
		cwd: dir,
		isIdle: () => true,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionFile: () => sessionFile,
			getBranch: () => readEntries(sessionFile),
		},
	};
	return { dir, sessionFile, state, pi, ctx, handlers, commands };
}

/** Run the extension's session-start handler (startup or a reload). */
async function startSession(fixture) {
	const start = fixture.handlers.get("session_start");
	assert.ok(start, "pi-goal registered a session_start handler");
	await start({ type: "session_start" }, fixture.ctx);
}

/** Run one Goal command family command by name. */
async function runCommand(fixture, name, args = "") {
	await fixture.commands.get(name).handler(args, fixture.ctx);
}

test("/goal:edit --title sets the title with no work message and no new run", async () => {
	const fixture = commandFixture();
	try {
		goalExtension(fixture.pi);
		await startSession(fixture);
		await runCommand(fixture, "goal", OBJECTIVE);

		const created = lastGoal(fixture.sessionFile);
		assert.equal(created.title, undefined);
		const messagesBefore = fixture.state.messages.length;

		await runCommand(fixture, "goal:edit", `--title "${TITLE}"`);

		const edited = lastGoal(fixture.sessionFile);
		assert.equal(edited.id, created.id, "same Goal identity");
		assert.equal(edited.objective, OBJECTIVE, "--title alone changes only the title");
		assert.equal(edited.title, TITLE);
		assert.equal(edited.revision, 1);
		assert.equal(fixture.state.messages.length, messagesBefore, "a title edit sends no work message");
		const notice = fixture.state.notifications.at(-1);
		assert.equal(notice.type, "info");
		assert.match(notice.message, /title set to/);
		assert.match(notice.message, /no work was started or redirected/);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("/goal:edit --title with an objective changes both in one revision", async () => {
	const fixture = commandFixture();
	try {
		goalExtension(fixture.pi);
		await startSession(fixture);
		await runCommand(fixture, "goal", OBJECTIVE);
		await runCommand(fixture, "goal:pause");
		const paused = lastGoal(fixture.sessionFile);

		await runCommand(fixture, "goal:edit", `--title "${TITLE}" ${EDITED_OBJECTIVE}`);
		const edited = lastGoal(fixture.sessionFile);
		assert.equal(edited.id, paused.id);
		assert.equal(edited.title, TITLE);
		assert.equal(edited.objective, EDITED_OBJECTIVE);
		assert.equal(edited.revision, paused.revision + 1, "both changes are one revision");
		assert.equal(edited.status, "paused");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("invalid /goal:edit titles are refused before any Goal mutation", async () => {
	const fixture = commandFixture();
	try {
		goalExtension(fixture.pi);
		await startSession(fixture);
		await runCommand(fixture, "goal", OBJECTIVE);
		const bytesBefore = goalStateBytes(fixture.sessionFile);

		const refusals = [
			["--title", /--title needs a title/],
			['--title ""', /1 to 80 characters/],
			[`--title "${"x".repeat(81)}"`, /1 to 80 characters/],
			['--title "two\nlines"', /one line/],
			// Trailing and leading terminators are refused before trimming, so they
			// cannot silently become an accepted one-line label.
			['--title "Release prep\n"', /one line/],
			['--title "\u2028Release prep"', /one line/],
			['--title "unterminated', /opening quote is not closed/],
			[`--title "${TITLE}" --title "again"`, /only once/],
			[`--title "${TITLE}" --file notes.md`, /attachment manifest/],
		];
		for (const [args, expected] of refusals) {
			const count = fixture.state.notifications.length;
			await runCommand(fixture, "goal:edit", args);
			assert.equal(fixture.state.notifications.length, count + 1, args);
			const notice = fixture.state.notifications.at(-1);
			assert.equal(notice.type, "error", args);
			assert.match(notice.message, expected, args);
		}
		assert.equal(goalStateBytes(fixture.sessionFile), bytesBefore, "no refused title wrote a Goal snapshot");
		assert.equal(lastGoal(fixture.sessionFile).title, undefined);
		assert.equal(fixture.state.messages.length, 1, "only the creation's kickoff was sent");

		// The same Goal accepts a valid title afterwards, so the refusal was the value.
		await runCommand(fixture, "goal:edit", `--title "${TITLE}"`);
		assert.equal(lastGoal(fixture.sessionFile).title, TITLE);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a title-only edit is admitted while goal.enabled is false; an objective edit is refused", async () => {
	const fixture = commandFixture();
	try {
		goalExtension(fixture.pi);
		await startSession(fixture);
		await runCommand(fixture, "goal", OBJECTIVE);
		const active = lastGoal(fixture.sessionFile);

		// A settings reload is the documented seam for a changed goal.enabled.
		fixture.state.settings = { goal: { enabled: false } };
		await startSession(fixture);
		assert.equal(lastGoal(fixture.sessionFile).status, active.status);

		const messagesBefore = fixture.state.messages.length;
		await runCommand(fixture, "goal:edit", `--title "${TITLE}"`);
		const relabeled = lastGoal(fixture.sessionFile);
		assert.equal(relabeled.title, TITLE, "a label change is not work-admitting");
		assert.equal(relabeled.status, "active", "and it does not move the Lifecycle status");
		assert.equal(relabeled.revision, active.revision + 1);
		assert.equal(fixture.state.messages.length, messagesBefore, "and it admits no work");

		const bytesBefore = goalStateBytes(fixture.sessionFile);
		await runCommand(fixture, "goal:edit", EDITED_OBJECTIVE);
		const refusal = fixture.state.notifications.at(-1);
		assert.equal(refusal.type, "warning");
		assert.match(refusal.message, /goal\.enabled is false/);
		assert.equal(goalStateBytes(fixture.sessionFile), bytesBefore, "the refused objective edit wrote nothing");
		assert.equal(lastGoal(fixture.sessionFile).objective, OBJECTIVE);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("/goal:edit completes its --title option, prefix-filtered", () => {
	const fixture = commandFixture();
	try {
		goalExtension(fixture.pi);
		const edit = fixture.commands.get("goal:edit");
		assert.equal(typeof edit.getArgumentCompletions, "function");
		const values = (items) => (items ?? []).map((item) => item.value);
		assert.deepEqual(values(edit.getArgumentCompletions("")), ["--title"]);
		assert.deepEqual(values(edit.getArgumentCompletions("--t")), ["--title"]);
		assert.deepEqual(values(edit.getArgumentCompletions("--title")), ["--title"]);
		assert.deepEqual(values(edit.getArgumentCompletions("--x")), []);
		assert.deepEqual(values(edit.getArgumentCompletions("an objective")), []);
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});

test("a title edit never renames the session", async () => {
	const fixture = commandFixture({ goal: { sessionNameFromObjective: true } });
	try {
		goalExtension(fixture.pi);
		await startSession(fixture);
		await runCommand(fixture, "goal", OBJECTIVE);
		assert.equal(fixture.state.sessionName, OBJECTIVE, "the creation names the session");

		await runCommand(fixture, "goal:edit", `--title "${TITLE}"`);
		assert.equal(fixture.state.sessionName, OBJECTIVE, "the edit never rewrites the host-owned name");
	} finally {
		rmSync(fixture.dir, { recursive: true, force: true });
	}
});
