/**
 * Issue #56: the in-process Goal command bridge — the seam the optional
 * Codex-shaped companion adapter is built on.
 *
 * These tests drive the real extension with a fake Pi API, the same way
 * `goal8-headless.test.mjs` does, so the narrow cases a real-Pi RPC test cannot
 * reach deterministically are covered here: the outcome classifier's whole
 * truth table, request validation, the busy and no-session guards, and — the
 * one that matters most — a creation that *committed in memory and then failed
 * its on-disk durability poll*. That creation is announced on the event stream
 * (the store's commit is the event bar) but retracted before any success is
 * reported, and the bridge must answer `refused`, never `committed`.
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
	classifyGoalBridgeOutcome,
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
function bridge(pi, command, { id = "bridge-1", version = GOAL_COMMAND_BRIDGE_VERSION, timeoutMs = 15_000 } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no bridge answer for ${JSON.stringify(command)}`)), timeoutMs);
		pi.events.emit(GOAL_COMMAND_BRIDGE, {
			version,
			id,
			command,
			reply: (result) => {
				clearTimeout(timer);
				resolve(result);
			},
		});
	});
}

/**
 * A fake Pi whose `appendEntry` writes the durable entries to a real session file.
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

/** A command context with just enough surface for the `/goal` handlers. */
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
			getBranch: () => [],
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

	// A read-only status query reports; it has nothing to commit and needs no proof.
	assert.deepEqual(classifyGoalBridgeOutcome({ action: "status", transitions: [], diagnostics: [], committed: false }), {
		ok: true,
		disposition: "reported",
	});
	// ... but a status read that reported a problem did not answer, and saying
	// "reported" would be a success claim without a commit behind it.
	assert.deepEqual(
		classifyGoalBridgeOutcome({
			action: "status",
			transitions: [],
			diagnostics: [{ level: "error", text: "pi-goal error: the session file could not be read" }],
			committed: false,
		}),
		{ ok: false, disposition: "refused" },
	);

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

test("a malformed bridge request is dropped instead of half-executed", () => {
	const reply = () => {};
	const ok = (payload) => parseGoalCommandBridgeRequest(payload);

	for (const payload of [
		null,
		"not-an-object",
		42,
		{ version: 2, id: "x", command: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "", command: "", reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", command: 5, reply },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", command: "" },
		{ version: GOAL_COMMAND_BRIDGE_VERSION, id: "x", command: "x".repeat(100_001), reply },
	]) {
		const parsed = ok(payload);
		assert.equal(parsed.ok, false, `${JSON.stringify(payload)} must be refused`);
		assert.ok(parsed.message.length > 0);
	}

	const accepted = ok({
		version: GOAL_COMMAND_BRIDGE_VERSION,
		id: "req-1",
		command: "clear",
		reply,
	});
	assert.equal(accepted.ok, true);
	assert.equal(accepted.request.id, "req-1");
	assert.equal(accepted.request.command, "clear");
});

test("a bridged status/create/clear round-trip runs the user command surface", async (t) => {
	const dir = withTempDir(t);
	const { pi, sessionFile } = await startBridgeHarness(dir);

	// Bare status is the same read the user gets from `/goal`.
	const status = await bridge(pi, "", { id: "get-1" });
	assert.equal(status.ok, true);
	assert.equal(status.disposition, "reported");
	assert.equal(status.action, "status");
	assert.equal(status.goal, null);
	assert.equal(status.admissionEnabled, true);
	assert.equal(status.transitions.length, 0);

	const created = await bridge(pi, `${OBJECTIVE}`, { id: "set-1" });
	assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
	assert.equal(created.disposition, "committed");
	assert.equal(created.action, "create");
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

	const stateAgain = await bridge(pi, "", { id: "get-2" });
	assert.equal(stateAgain.ok, true);
	assert.equal(stateAgain.goal.id, created.goal.id);

	const cleared = await bridge(pi, "clear", { id: "clear-1" });
	assert.equal(cleared.ok, true, JSON.stringify(cleared.diagnostics));
	assert.equal(cleared.disposition, "committed");
	assert.deepEqual(
		cleared.transitions.map((transition) => transition.kind),
		["cleared"],
	);
	assert.equal(cleared.goal, null);
	assert.equal(lastSnapshot(sessionFile).data.goal, null, "the tombstone is the newest durable entry");
});

test("a creation that fails its durability poll is answered as refused, never committed", async (t) => {
	const dir = withTempDir(t);
	// The snapshot append never reaches the session file: the store commits in
	// memory, announces the transition, and the command's on-disk durability poll
	// then fails and retracts the Goal.
	const { pi, sessionFile } = await startBridgeHarness(dir, { append: "drop" });

	const result = await bridge(pi, `${OBJECTIVE}`, { id: "set-durability" });
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

	const first = await bridge(pi, `${OBJECTIVE}`, { id: "set-first" });
	assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
	const before = goalStateBytes(sessionFile);

	const pending = bridge(pi, "A replacement objective", { id: "set-replace" });
	// Let the command reach the confirmation dialog before asserting the guard.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const busy = await bridge(pi, "clear", { id: "clear-while-busy" });
	assert.equal(busy.ok, false);
	assert.equal(busy.disposition, "refused");
	assert.ok(
		busy.diagnostics.some((diagnostic) => /another bridged \/goal command is still running/.test(diagnostic.text)),
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

test("the bridge answers a request that arrives before any session started", async (t) => {
	const dir = withTempDir(t);
	const sessionFile = join(dir, "session.jsonl");
	const { pi } = fakePi(sessionFile, {});
	// Deliberately no `session_start`: this is a host calling too early.
	goalExtension(pi);
	const result = await bridge(pi, `${OBJECTIVE}`, { id: "early" });
	assert.equal(result.ok, false);
	assert.equal(result.disposition, "refused");
	assert.equal(result.goal, null);
	assert.ok(
		result.diagnostics.some((diagnostic) => /has not started a session yet/.test(diagnostic.text)),
		JSON.stringify(result.diagnostics),
	);
	assert.equal(goalStateBytes(sessionFile), "");
});

test("the companion is independently installable and speaks the documented bridge", () => {
	// The protocol is a wire contract, declared on both sides; a drift here is a
	// silent incompatibility, so it is pinned rather than discovered in the field.
	assert.equal(COMPANION_BRIDGE, GOAL_COMMAND_BRIDGE);
	assert.equal(COMPANION_BRIDGE_VERSION, GOAL_COMMAND_BRIDGE_VERSION);
	assert.deepEqual([...GOAL_RPC_METHODS], ["thread/goal/get", "thread/goal/set", "thread/goal/clear"]);

	// Optionality is structural: the companion package depends on nothing, and
	// nothing in pi-goal depends on it.
	const dependencies = { ...(companionManifest.dependencies ?? {}), ...(companionManifest.peerDependencies ?? {}) };
	assert.deepEqual(Object.keys(dependencies), ["@earendil-works/pi-coding-agent"], "no pi-goal runtime dependency");
	assert.deepEqual(companionManifest.pi.extensions, ["./index.ts"], "the companion installs its own extension only");

	// No store internals, no second lifecycle path: the companion is a pure
	// translator, so it imports nothing from pi-goal and registers no model tool.
	const source = readFileSync(new URL("../companion/goal-rpc/index.ts", import.meta.url), "utf8");
	assert.equal(/from\s+"[^"]*\/src\//.test(source), false, "the companion must not import pi-goal internals");
	assert.equal(source.includes("registerTool("), false, "the companion registers no model-callable tool");
	assert.equal(source.includes("goal-state"), false, "the companion never names a durable Goal entry");
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
