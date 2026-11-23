/**
 * Issue #56: the in-process Goal command bridge — the seam the optional
 * Codex-shaped companion adapter is built on. Issue #79 moved it to version 2:
 * a request carries Pi's own dispatch shape (a Goal command family command name
 * plus its argument text) instead of a string the bridge had to parse.
 *
 * These tests drive the real extension with a fake Pi API, the same way
 * `goal8-headless.test.mjs` does, so the narrow cases a real-Pi RPC test cannot
 * reach deterministically are covered here: the outcome classifier's whole
 * truth table, strict request validation, the busy and no-session guards, a
 * name that is valid for the protocol but not registered at dispatch time, and —
 * the one that matters most — a creation that *committed in memory and then
 * failed its on-disk durability poll*. That creation is announced on the event
 * stream (the store's commit is the event bar) but retracted before any success
 * is reported, and the bridge must answer `refused`, never `committed`.
 *
 * Everything observable end to end — the companion's public protocol, replacement
 * confirmation, creation authority, disabled admission, invalid budgets, and
 * byte-identical Goal state after a refusal — is covered against a real
 * `pi --mode rpc` subprocess in `goal56-goal-rpc-companion.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import goalExtension from "../src/index.ts";
import {
	GOAL_COMMAND_BRIDGE,
	GOAL_COMMAND_BRIDGE_VERSION,
	GOAL_COMMAND_NAMES,
	classifyGoalBridgeOutcome,
	commandContextForBridge,
	committedKindsFor,
	parseGoalCommandBridgeRequest,
} from "../src/command-bridge.ts";
import companionManifest from "../companion/goal-rpc/package.json" with { type: "json" };
import {
	GOAL_COMMAND_BRIDGE as COMPANION_BRIDGE,
	GOAL_COMMAND_BRIDGE_VERSION as COMPANION_BRIDGE_VERSION,
	GOAL_RPC_METHODS,
	GOAL_RPC_RESPONSE_ENTRY,
} from "../companion/goal-rpc/index.ts";

const OBJECTIVE = "Ship the release notes page";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPANION_DIR = join(REPO_ROOT, "companion", "goal-rpc");
const PI_BINARY = process.env.PI_BINARY ?? "pi";

/** A bridge answer: the request's own reply callback, resolved once. */
function bridge(pi, name, args, { id = "bridge-1", version = GOAL_COMMAND_BRIDGE_VERSION, timeoutMs = 15_000 } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no bridge answer for /${name} ${JSON.stringify(args)}`)), timeoutMs);
		pi.events.emit(GOAL_COMMAND_BRIDGE, {
			version,
			id,
			name,
			args,
			reply: (result) => {
				clearTimeout(timer);
				resolve(result);
			},
		});
	});
}

/**
 * A fake Pi whose `appendEntry` writes the durable entries to a real session file
 * and whose `getCommands` lists what was registered, like Pi's own command
 * registry does.
 *
 * `append` selects what happens to a `goal-state` append: `write` (the real
 * behavior), `drop` (the append silently does nothing, so the store commits in
 * memory and the on-disk durability poll can only fail), or `throw` (the append
 * fails hard, which is the store's persistence-failure path).
 */
function fakePi(sessionFile, options = {}) {
	const handlers = new Map();
	const busHandlers = new Map();
	const tools = [];
	const commands = new Map();
	const append = options.append ?? "write";
	const settings = options.settings ?? {};
	writeFileSync(sessionFile, "");
	const pi = {
		on(event, handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerTool(definition) {
			tools.push(definition);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		getCommands() {
			return [...commands].map(([name, definition]) => ({
				name,
				description: definition.description,
				source: "extension",
				sourceInfo: { path: REPO_ROOT, source: "pi-goal", scope: "user", origin: "package" },
			}));
		},
		registerShortcut() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSettings() {
			return settings;
		},
		getAllTools() {
			return tools.map((tool) => ({ name: tool.name }));
		},
		getSessionName() {
			return undefined;
		},
		setSessionName() {},
		appendEntry(customType, data) {
			if (customType === "goal-state") {
				if (append === "throw") throw new Error("injected append failure");
				if (append === "drop") return;
			}
			appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
		},
		sendUserMessage() {},
		sendMessage() {},
		events: {
			on(channel, handler) {
				const registered = busHandlers.get(channel) ?? [];
				registered.push(handler);
				busHandlers.set(channel, registered);
				return () => {};
			},
			emit(channel, data) {
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
		},
	};
	return { pi, handlers, busHandlers, tools, commands };
}

/** A command context with just enough surface for the Goal command handlers. */
function fakeCtx({ sessionFile, confirm } = {}) {
	const notifications = [];
	const ctx = {
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {},
			setWidget() {},
			confirm: confirm ?? (async () => false),
			editor: async () => undefined,
		},
		mode: "rpc",
		hasUI: true,
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionFile: () => sessionFile,
			// Pi's branch is the session file's entries, and the history rendering
			// reads `goal-history` entries from it, so the fake mirrors the file.
			getBranch: () =>
				readFileSync(sessionFile, "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line)),
			getCwd: () => "/tmp",
		},
	};
	return { ctx, notifications };
}

/** Start the extension and fire `session_start`, which is what captures the bridge context. */
async function startBridgeHarness(dir, options = {}) {
	const sessionFile = join(dir, "session.jsonl");
	const harness = fakePi(sessionFile, options);
	goalExtension(harness.pi);
	const { ctx, notifications } = fakeCtx({ sessionFile, confirm: options.confirm });
	for (const handler of harness.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, ctx);
	}
	return { ...harness, sessionFile, ctx, notifications };
}

/** Every raw `goal-state` line in the session file, as bytes. */
function goalStateBytes(sessionFile) {
	const text = readFileSync(sessionFile, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "" && line.includes('"goal-state"'))
		.join("\n");
}

/** The newest parsed `goal-state` snapshot, or undefined. */
function lastSnapshot(sessionFile) {
	const entries = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "custom" && entry.customType === "goal-state");
	return entries.at(-1);
}

function withTempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-bridge-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("the outcome classifier never claims success it cannot prove", () => {
	const committed = classifyGoalBridgeOutcome({
		action: "create",
		transitions: [{ kind: "created", goal: { id: "g1", revision: 1 } }],
		diagnostics: [],
		committed: true,
	});
	assert.deepEqual(committed, { ok: true, disposition: "committed" });

	// A recorded transition that did not land (rolled back, replaced, or never made
	// it to disk) is a refusal, however happy the command's own announcements were.
	assert.deepEqual(
		classifyGoalBridgeOutcome({
			action: "create",
			transitions: [{ kind: "created", goal: { id: "g1", revision: 1 } }],
			diagnostics: [{ level: "info", text: "Goal g1 created and activated." }],
			committed: false,
		}),
		{ ok: false, disposition: "refused" },
	);

	// A read-only query reports; it has nothing to commit and needs no proof. The
	// history rendering is a read exactly like the status report.
	for (const action of ["status", "history"]) {
		assert.deepEqual(classifyGoalBridgeOutcome({ action, transitions: [], diagnostics: [], committed: false }), {
			ok: true,
			disposition: "reported",
		});
		// ... but a read that reported a problem did not answer, and saying
		// "reported" would be a success claim without a commit behind it.
		assert.deepEqual(
			classifyGoalBridgeOutcome({
				action,
				transitions: [],
				diagnostics: [{ level: "error", text: "pi-goal error: the session file could not be read" }],
				committed: false,
			}),
			{ ok: false, disposition: "refused" },
		);
	}

	assert.deepEqual(classifyGoalBridgeOutcome({ action: "invalid", transitions: [], diagnostics: [], committed: false }), {
		ok: false,
		disposition: "invalid",
	});

	// No transition: severity decides, and a warning/error is always a refusal.
	assert.deepEqual(
		classifyGoalBridgeOutcome({
			action: "create",
			transitions: [],
			diagnostics: [{ level: "warning", text: "Goal not created: pi-goal is disabled." }],
			committed: false,
		}),
		{ ok: false, disposition: "refused" },
	);
	// Only info: the operation did not commit, but nothing went wrong — the user
	// declined the replacement, or there was nothing to do.
	assert.deepEqual(
		classifyGoalBridgeOutcome({
			action: "create",
			transitions: [],
			diagnostics: [{ level: "info", text: "Replacement cancelled: the current active Goal was kept." }],
			committed: false,
		}),
		{ ok: false, disposition: "declined" },
	);
	// A silent mutation is still never a success.
	assert.deepEqual(classifyGoalBridgeOutcome({ action: "clear", transitions: [], diagnostics: [], committed: false }), {
		ok: false,
		disposition: "declined",
	});
});

test("each action accepts only the transitions that can answer it", () => {
	assert.deepEqual(committedKindsFor("status"), []);
	assert.deepEqual(committedKindsFor("history"), []);
	assert.deepEqual(committedKindsFor("invalid"), []);
	assert.deepEqual(committedKindsFor("create"), ["created", "replaced"]);
	assert.deepEqual(committedKindsFor("edit"), ["objective-edited"]);
	assert.deepEqual(committedKindsFor("pause"), ["paused"]);
	assert.deepEqual(committedKindsFor("resume"), ["resumed", "budget-recovered"]);
	assert.deepEqual(committedKindsFor("clear"), ["cleared"]);
	// A completion that lands while a confirmation dialog is open must never be
	// reported as the answer to the command that is waiting.
	assert.equal(committedKindsFor("create").includes("completed"), false);
});

test("the action is the command name, and only /goal looks at its argument", async (t) => {
	const dir = withTempDir(t);
	const { pi } = await startBridgeHarness(dir);

	// Observed through the public result's `action` field, one request per meaning,
	// so the derivation is pinned by what a bridge consumer receives.
	const cases = [
		{ name: "goal", args: "", action: "status" },
		{ name: "goal", args: "   ", action: "status" },
		{ name: "goal", args: OBJECTIVE, action: "create" },
		// The old space-separated spelling is still a create as far as the bridge is
		// concerned: the creation path refuses it, and that refusal is the create
		// action's answer (`refused`), never `invalid`.
		{ name: "goal", args: "pause", action: "create" },
		{ name: "goal", args: "--budget 5000 --file spec.md Ship it", action: "create" },
		{ name: "goal:pause", args: "", action: "pause" },
		{ name: "goal:pause", args: "foo", action: "pause" },
		{ name: "goal:resume", args: "--budget 150", action: "resume" },
		{ name: "goal:clear", args: "", action: "clear" },
		{ name: "goal:history", args: "", action: "history" },
		{ name: "goal:edit", args: "", action: "edit" },
		{ name: "goal:edit", args: "New objective", action: "edit" },
	];
	for (const [index, { name, args, action }] of cases.entries()) {
		const result = await bridge(pi, name, args, { id: `action-${index}` });
		assert.equal(result.action, action, `/${name} ${JSON.stringify(args)}`);
		assert.equal(result.name, name, "the result echoes the request's name");
		assert.equal(result.args, args, "the result echoes the request's args");
	}
	// A `name` that passes protocol validation but is not a registered command at
	// dispatch time answers `invalid` and runs nothing. `goal:status` is a
	// well-formed v2 name outside the family, so the parser drops it and the
	// caller's own timeout is the answer; the registered-family check is reached
	// only for names inside the family.
	assert.match(
		parseGoalCommandBridgeRequest({ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal:status", args: "", reply: () => {} }).message,
		/goal:pause/,
		"an outside-family name is dropped at validation, never dispatched",
	);
});

test("a malformed bridge request is dropped instead of half-executed", () => {
	const reply = () => {};
	const parse = (payload) => parseGoalCommandBridgeRequest(payload);

	const refused = [
		null,
		"not-an-object",
		42,
		// The version-1 shape (a `command` string) is a mismatch, dropped with the
		// upgrade diagnostic rather than guessed at or answered.
		{ version: 1, id: "x", command: "clear", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION + 1, id: "x", name: "goal", args: "", reply },
		{ id: "x", name: "goal", args: "", reply },
		// id
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "", name: "goal", args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: 7, name: "goal", args: "", reply },
		// name: missing, wrong type, or outside the Goal command family
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: 5, args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal:status", args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal:create", args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goals", args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "", args: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", command: "clear", reply },
		// args: missing or not a string
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", args: 5, reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", args: null, reply },
		// reply
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", args: "" },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", args: "", reply: "not a function" },
		// The length bound applies to the argument text.
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", args: "x".repeat(100_001), reply },
	];
	for (const payload of refused) {
		const parsed = parse(payload);
		assert.equal(parsed.ok, false, `${JSON.stringify(payload)} must be refused`);
		assert.ok(parsed.message.length > 0);
	}
	assert.match(parse({ version: 1, id: "x", command: "clear", reply }).message, /Upgrade the companion or pi-goal/);
	assert.match(parse({ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal:status", args: "", reply }).message, /goal:pause/);
	assert.match(parse({ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", name: "goal", args: 5, reply }).message, /string args/);

	// Every member of the family is accepted, and the accepted request is exactly
	// the validated fields — nothing else from the payload travels.
	for (const name of GOAL_COMMAND_NAMES) {
		const accepted = parse({
			version: GOAL_COMMAND_BRIDGE_VERSION,
			id: "req-1",
			name,
			args: "--budget 150",
			reply,
			extra: "ignored?",
		});
		assert.equal(accepted.ok, true, name);
		assert.equal(accepted.request.id, "req-1");
		assert.equal(accepted.request.name, name);
		assert.equal(accepted.request.args, "--budget 150");
		assert.equal("extra" in accepted.request, false);
	}
});

test("a version-mismatched request is dropped: the caller's timeout, not a refusal, answers it", async (t) => {
	const dir = withTempDir(t);
	const { pi } = await startBridgeHarness(dir);
	let replies = 0;
	pi.events.emit(GOAL_COMMAND_BRIDGE, {
		version: GOAL_COMMAND_BRIDGE_VERSION + 1,
		id: "future-1",
		name: "goal",
		args: "",
		reply: () => {
			replies += 1;
		},
	});
	assert.equal(replies, 0, "an unknown version is never answered, even with a well-formed reply");
	await assert.rejects(
		bridge(pi, "goal", "", { version: 1, id: "old-1", timeoutMs: 150 }),
		/no bridge answer/,
		"a version-1 request reaches the caller as its own timeout (unavailable), not as a refusal",
	);
});

test("a bridged status/create/clear round-trip runs the user command surface", async (t) => {
	const dir = withTempDir(t);
	const { pi, sessionFile } = await startBridgeHarness(dir);

	// Bare status is the same read the user gets from `/goal`.
	const status = await bridge(pi, "goal", "", { id: "get-1" });
	assert.equal(status.ok, true);
	assert.equal(status.disposition, "reported");
	assert.equal(status.action, "status");
	assert.equal(status.goal, null);
	assert.equal(status.admissionEnabled, true);
	assert.equal(status.transitions.length, 0);
	// The request's command name and argument are echoed, so the caller correlates
	// the answer with exactly what it sent.
	assert.equal(status.version, GOAL_COMMAND_BRIDGE_VERSION);
	assert.equal(status.id, "get-1");
	assert.equal(status.name, "goal");
	assert.equal(status.args, "");

	const created = await bridge(pi, "goal", `${OBJECTIVE}`, { id: "set-1" });
	assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
	assert.equal(created.disposition, "committed");
	assert.equal(created.action, "create");
	assert.equal(created.name, "goal");
	assert.equal(created.args, OBJECTIVE);
	assert.deepEqual(
		created.transitions.map((transition) => transition.kind),
		["created"],
	);
	assert.equal(created.goal.objective, OBJECTIVE);
	assert.equal(created.goal.status, "active");
	// A bridged command is the *user* path: the durable record says so, and no
	// creation-authority quotation was needed (or would have been accepted).
	assert.equal(created.goal.origin, "command");
	const snapshot = lastSnapshot(sessionFile);
	assert.equal(snapshot.data.goal.objective, OBJECTIVE);
	assert.equal(snapshot.data.goal.origin, "command");

	const stateAgain = await bridge(pi, "goal", "", { id: "get-2" });
	assert.equal(stateAgain.ok, true);
	assert.equal(stateAgain.goal.id, created.goal.id);

	const cleared = await bridge(pi, "goal:clear", "", { id: "clear-1" });
	assert.equal(cleared.ok, true, JSON.stringify(cleared.diagnostics));
	assert.equal(cleared.disposition, "committed");
	assert.equal(cleared.action, "clear");
	assert.equal(cleared.name, "goal:clear");
	assert.deepEqual(
		cleared.transitions.map((transition) => transition.kind),
		["cleared"],
	);
	assert.equal(cleared.goal, null);
	assert.equal(lastSnapshot(sessionFile).data.goal, null, "the tombstone is the newest durable entry");
});

test("the disposition truth table holds for every command in the family", async (t) => {
	const dir = withTempDir(t);
	const { pi, sessionFile } = await startBridgeHarness(dir);

	// A verb with no Goal to act on reports "no Goal" at info level: declined,
	// nothing to do, nothing committed.
	for (const name of ["goal:pause", "goal:resume", "goal:clear"]) {
		const result = await bridge(pi, name, "", { id: `bare-${name}` });
		assert.equal(result.ok, false, name);
		assert.equal(result.disposition, "declined", name);
		assert.equal(result.action, name.slice("goal:".length));
		assert.deepEqual(result.transitions, []);
		assert.equal(goalStateBytes(sessionFile), "", `${name} with no Goal writes nothing`);
	}
	// A stray argument on a no-argument verb is the verb's usage error: refused.
	const beforeUsage = goalStateBytes(sessionFile);
	const usage = await bridge(pi, "goal:pause", "foo", { id: "pause-foo" });
	assert.equal(usage.ok, false);
	assert.equal(usage.disposition, "refused");
	assert.equal(usage.action, "pause");
	assert.deepEqual(usage.transitions, []);
	assert.deepEqual(usage.diagnostics, [{ level: "error", text: "/goal:pause takes no argument." }]);
	assert.equal(goalStateBytes(sessionFile), beforeUsage, "the usage refusal wrote no Goal bytes");
	// The history rendering is a read: reported, with the timeline as diagnostics.
	const emptyHistory = await bridge(pi, "goal:history", "", { id: "history-0" });
	assert.equal(emptyHistory.ok, true);
	assert.equal(emptyHistory.disposition, "reported");
	assert.equal(emptyHistory.action, "history");

	// The old space-separated spelling reaches the creation path, which refuses it
	// with the verb command to type instead; it is the create action's refusal.
	const before = goalStateBytes(sessionFile);
	const reserved = await bridge(pi, "goal", "pause", { id: "old-pause" });
	assert.equal(reserved.ok, false);
	assert.equal(reserved.disposition, "refused", "a reserved word is refused by the creation path, never invalid");
	assert.equal(reserved.action, "create");
	assert.deepEqual(reserved.transitions, []);
	assert.ok(
		reserved.diagnostics.some(
			(diagnostic) => diagnostic.level === "error" && diagnostic.text === "Goal not created: `pause` is a Goal command; use /goal:pause.",
		),
		JSON.stringify(reserved.diagnostics),
	);
	assert.equal(goalStateBytes(sessionFile), before);

	// Create, then walk every verb: each commits exactly its own transition.
	assert.equal((await bridge(pi, "goal", OBJECTIVE, { id: "create" })).ok, true);
	const paused = await bridge(pi, "goal:pause", "", { id: "pause" });
	assert.equal(paused.ok, true, JSON.stringify(paused.diagnostics));
	assert.equal(paused.disposition, "committed");
	assert.equal(paused.action, "pause");
	assert.deepEqual(
		paused.transitions.map((transition) => transition.kind),
		["paused"],
	);
	assert.equal(paused.goal.status, "paused");

	const history = await bridge(pi, "goal:history", "", { id: "history" });
	assert.equal(history.ok, true);
	assert.equal(history.disposition, "reported");
	assert.equal(history.action, "history");
	assert.deepEqual(history.transitions, []);
	assert.ok(history.diagnostics.some((diagnostic) => diagnostic.text.includes("created")), JSON.stringify(history.diagnostics));

	const edited = await bridge(pi, "goal:edit", "A revised objective", { id: "edit" });
	assert.equal(edited.ok, true, JSON.stringify(edited.diagnostics));
	assert.equal(edited.disposition, "committed");
	assert.equal(edited.action, "edit");
	assert.deepEqual(
		edited.transitions.map((transition) => transition.kind),
		["objective-edited"],
	);
	assert.equal(edited.goal.objective, "A revised objective");

	const resumed = await bridge(pi, "goal:resume", "", { id: "resume" });
	assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
	assert.equal(resumed.disposition, "committed");
	assert.equal(resumed.action, "resume");
	assert.deepEqual(
		resumed.transitions.map((transition) => transition.kind),
		["resumed"],
	);
	assert.equal(resumed.goal.status, "active");

	// `/goal:edit` keeps its attachment-flag refusal over the bridge too.
	const beforeFlag = goalStateBytes(sessionFile);
	const flagRefusal = await bridge(pi, "goal:edit", "--file notes.md A revised objective", { id: "edit-flag" });
	assert.equal(flagRefusal.ok, false);
	assert.equal(flagRefusal.disposition, "refused");
	assert.equal(flagRefusal.action, "edit");
	assert.ok(flagRefusal.diagnostics.some((diagnostic) => /Replacement Goal/.test(diagnostic.text)));
	assert.equal(goalStateBytes(sessionFile), beforeFlag, "the attachment refusal wrote no Goal bytes");
});

test("a creation that fails its durability poll is answered as refused, never committed", async (t) => {
	const dir = withTempDir(t);
	// The snapshot append never reaches the session file: the store commits in
	// memory, announces the transition, and the command's on-disk durability poll
	// then fails and retracts the Goal.
	const { pi, sessionFile } = await startBridgeHarness(dir, { append: "drop" });

	const result = await bridge(pi, "goal", `${OBJECTIVE}`, { id: "set-durability" });
	assert.equal(result.ok, false, "a rolled-back creation must never report success");
	assert.equal(result.disposition, "refused");
	assert.deepEqual(
		result.transitions.map((transition) => transition.kind),
		["created"],
		"the store did announce the in-memory transition, and the bridge still refuses it",
	);
	assert.equal(result.goal, null, "the retracted Goal is not the current state");
	assert.ok(
		result.diagnostics.some(
			(diagnostic) => diagnostic.level === "error" && /did not reach the session file in time/.test(diagnostic.text),
		),
		`expected the durability diagnostic, got ${JSON.stringify(result.diagnostics)}`,
	);
	assert.equal(goalStateBytes(sessionFile), "", "nothing durable was written");
});

test("a replacement declined through the user dialog changes nothing", async (t) => {
	const dir = withTempDir(t);
	// The user's answer is captured so the test can decline it after the command is
	// already waiting, which is where a second request must be refused.
	let release;
	const answer = new Promise((resolve) => {
		release = resolve;
	});
	const { pi, sessionFile } = await startBridgeHarness(dir, { confirm: () => answer });

	const first = await bridge(pi, "goal", `${OBJECTIVE}`, { id: "set-first" });
	assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
	const before = goalStateBytes(sessionFile);

	const pending = bridge(pi, "goal", "A replacement objective", { id: "set-replace" });
	// Let the command reach the confirmation dialog before asserting the guard.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const busy = await bridge(pi, "goal:clear", "", { id: "clear-while-busy" });
	assert.equal(busy.ok, false);
	assert.equal(busy.disposition, "refused");
	assert.equal(busy.action, null, "the busy guard refuses before any action is derived");
	assert.equal(busy.name, "goal:clear");
	assert.ok(
		busy.diagnostics.some((diagnostic) => /another bridged Goal command is still running/.test(diagnostic.text)),
		JSON.stringify(busy.diagnostics),
	);

	release(false);
	const declined = await pending;
	assert.equal(declined.ok, false);
	assert.equal(declined.disposition, "declined");
	assert.deepEqual(declined.transitions, []);
	assert.equal(declined.goal.id, first.goal.id, "the current Goal is unchanged");
	assert.ok(
		declined.diagnostics.some((diagnostic) => /Replacement cancelled/.test(diagnostic.text)),
		JSON.stringify(declined.diagnostics),
	);
	assert.equal(goalStateBytes(sessionFile), before, "a declined replacement writes no Goal bytes");
});

test("a bridged command cannot take over the session", () => {
	// Pi hands a command handler session control and agent/process control. A
	// bridged command is one Goal command on behalf of an external client, so every
	// one of those entry points must throw instead of quietly aborting a run,
	// compacting the context, exiting Pi, or switching the user's session.
	const calls = [];
	const record = (name) => (...args) => {
		calls.push([name, ...args]);
	};
	const base = {
		ui: { notify() {} },
		mode: "rpc",
		hasUI: true,
		cwd: "/tmp",
		signal: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		abort: record("abort"),
		shutdown: record("shutdown"),
		compact: record("compact"),
		newSession: record("newSession"),
		fork: record("fork"),
		navigateTree: record("navigateTree"),
		switchSession: record("switchSession"),
		reload: record("reload"),
	};
	const view = commandContextForBridge(base);

	for (const name of [
		"abort",
		"shutdown",
		"compact",
		"newSession",
		"fork",
		"navigateTree",
		"switchSession",
		"reload",
	]) {
		assert.equal(typeof view[name], "function", `${name} is present so a future call fails loudly`);
		assert.throws(() => view[name]("x"), /may not call .*\(\)/, `${name} must throw`);
	}
	assert.deepEqual(calls, [], "the session was never touched through the bridge context");

	// The capabilities the command handler does need still work: reads pass through
	// and `waitForIdle` is synthesized from the same `isIdle` predicate.
	assert.equal(view.mode, "rpc");
	assert.equal(view.isIdle(), true);
	assert.equal(typeof view.waitForIdle, "function");
});

test("the bridge calls reply exactly once, even when the callback throws", async (t) => {
	const dir = withTempDir(t);
	const { pi } = await startBridgeHarness(dir);
	let calls = 0;
	const thrown = [];
	pi.events.emit(GOAL_COMMAND_BRIDGE, {
		version: GOAL_COMMAND_BRIDGE_VERSION,
		id: "reply-throws",
		name: "goal",
		args: `${OBJECTIVE}`,
		reply: () => {
			calls += 1;
			const error = new Error("host reply channel is broken");
			thrown.push(error);
			throw error;
		},
	});
	// The refusal mirror in the listener must not answer a request whose reply
	// callback was already entered: one answer, attempted once.
	const deadline = Date.now() + 5000;
	while (calls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls, 1, "a throwing reply callback must not be called a second time");
	assert.equal(thrown.length, 1);
});

test("the bridge answers a request that arrives before any session started", async (t) => {
	const dir = withTempDir(t);
	const sessionFile = join(dir, "session.jsonl");
	const { pi } = fakePi(sessionFile, {});
	// Deliberately no `session_start`: this is a host calling too early.
	goalExtension(pi);
	const result = await bridge(pi, "goal", `${OBJECTIVE}`, { id: "early" });
	assert.equal(result.ok, false);
	assert.equal(result.disposition, "refused");
	assert.equal(result.action, null);
	assert.equal(result.goal, null);
	assert.equal(result.name, "goal");
	assert.equal(result.args, OBJECTIVE);
	assert.ok(
		result.diagnostics.some((diagnostic) => /has not started a session yet/.test(diagnostic.text)),
		JSON.stringify(result.diagnostics),
	);
	assert.equal(goalStateBytes(sessionFile), "");
});

test("a family name that is not registered at dispatch time is answered invalid and runs nothing", async (t) => {
	const dir = withTempDir(t);
	const { pi, commands, sessionFile } = await startBridgeHarness(dir);
	assert.equal((await bridge(pi, "goal", OBJECTIVE, { id: "create" })).ok, true);
	const before = goalStateBytes(sessionFile);

	// Pi's registry no longer lists the clear command (the extension was unloaded
	// or its command was replaced). The name is valid for the protocol, so the
	// request is not dropped — it is answered, as `invalid`, and no handler runs.
	commands.delete("goal:clear");
	const result = await bridge(pi, "goal:clear", "", { id: "unregistered" });
	assert.equal(result.ok, false);
	assert.equal(result.disposition, "invalid");
	assert.equal(result.action, "invalid");
	assert.equal(result.name, "goal:clear");
	assert.deepEqual(result.transitions, []);
	assert.ok(
		result.diagnostics.some((diagnostic) => diagnostic.level === "error" && /not a registered command/.test(diagnostic.text)),
		JSON.stringify(result.diagnostics),
	);
	assert.equal(result.goal.status, "active", "the Goal is untouched");
	assert.equal(goalStateBytes(sessionFile), before, "no Goal bytes were written");

	// Registered again, the same request commits as usual: the guard is about the
	// registry, not about the name.
	commands.set("goal:clear", {});
	assert.equal((await bridge(pi, "goal:clear", "", { id: "registered-again" })).disposition, "committed");
});

test("the companion is independently installable and speaks the documented bridge", () => {
	// The protocol is a wire contract, declared on both sides; a drift here is a
	// silent incompatibility, so it is pinned rather than discovered in the field.
	assert.equal(COMPANION_BRIDGE, GOAL_COMMAND_BRIDGE);
	assert.equal(COMPANION_BRIDGE_VERSION, GOAL_COMMAND_BRIDGE_VERSION);
	assert.equal(GOAL_COMMAND_BRIDGE_VERSION, 2, "version 2 is the name-plus-args request shape");
	assert.deepEqual(GOAL_COMMAND_NAMES, ["goal", "goal:pause", "goal:resume", "goal:clear", "goal:history", "goal:edit"]);
	assert.deepEqual([...GOAL_RPC_METHODS], ["thread/goal/get", "thread/goal/set", "thread/goal/clear"]);

	// Optionality is structural: the companion package depends on nothing, and
	// nothing in pi-goal depends on it.
	const dependencies = { ...(companionManifest.dependencies ?? {}), ...(companionManifest.peerDependencies ?? {}) };
	assert.deepEqual(Object.keys(dependencies), ["@earendil-works/pi-coding-agent"], "no pi-goal runtime dependency");
	assert.deepEqual(companionManifest.pi.extensions, ["./index.ts"], "the companion installs its own extension only");

	// No store internals, no second lifecycle path, no parser mirror: the companion
	// is a pure translator, so it imports nothing from pi-goal, registers no model
	// tool, and no longer carries a copy of the command parser.
	const source = readFileSync(new URL("../companion/goal-rpc/index.ts", import.meta.url), "utf8");
	assert.equal(/from\s+"[^"]*\/src\//.test(source), false, "the companion must not import pi-goal internals");
	assert.equal(source.includes("registerTool("), false, "the companion registers no model-callable tool");
	assert.equal(source.includes("goal-state"), false, "the companion never names a durable Goal entry");
	// The parser mirror is gone by construction: the companion holds no Objective
	// collision vocabulary of its own (no reserved-word list, no option-token
	// scanner), so a `set` cannot re-implement the command surface it translates.
	assert.equal(source.includes("commandCollision"), false, "the parser mirror is gone");
	assert.equal(source.includes("RESERVED_GOAL_VERBS"), false, "no reserved-word list of its own");
	assert.equal(/"--(no-)?budget"\s*\|\|--(file|image|remote-image)/.test(source), false, "no option-token scanner of its own");
	assert.equal(source.includes("appendEntry(GOAL_RPC_RESPONSE_ENTRY"), true, "the only write is its own response entry");
	assert.equal(GOAL_RPC_RESPONSE_ENTRY, "goal-rpc-response");
});

test("the companion installs through Pi's documented package workflow on its own", () => {
	// The documented install path is a local package directory, so the isolated
	// install is real: Pi records the companion in the agent settings and lists it,
	// without pi-goal being installed at all.
	const agentDir = mkdtempSync(join(tmpdir(), "pi-goal-companion-install-"));
	try {
		const install = spawnSync(PI_BINARY, ["install", COMPANION_DIR], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
		});
		assert.equal(install.status, 0, `pi install failed:\n${install.stdout}\n${install.stderr}`);

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.ok(Array.isArray(settings.packages), "settings declare a packages array");
		assert.equal(settings.packages.length, 1, "only the companion was installed");
		const declared = settings.packages[0];
		assert.ok(typeof declared === "string" && declared.length > 0);
		assert.equal(realpathSync(resolve(agentDir, declared)), realpathSync(COMPANION_DIR));

		const list = spawnSync(PI_BINARY, ["list"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
		});
		assert.equal(list.status, 0, `pi list failed:\n${list.stdout}\n${list.stderr}`);
		assert.ok(list.stdout.includes("pi-goal-rpc-companion") || list.stdout.includes("goal-rpc"), list.stdout);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
