import assert from "node:assert/strict";
import test from "node:test";
import {
	RexError,
	addWindow,
	createSession,
	defaultRunner,
	discoverRex,
	inspectBlock,
	listApps,
	listSessions,
	listWindows,
	probeBlock,
	rexArgs,
	selectSession,
	validateRex,
} from "../src/rex.ts";
import { fakeRunner, json, rexCommand, result } from "./helpers.ts";

const location = { endpoint: "unix:///tmp/rex.sock", hostId: "host-1" };

function whoami(overrides: Record<string, unknown> = {}) {
	return json({ endpoint: "unix:///tmp/rex.sock", host_id: "host-1", account: "me", rex_version: "1.2.3", ...overrides });
}

test("rexArgs pins the server and forbids autostart", () => {
	assert.deepEqual(rexArgs(location, ["ls", "--json"]), [
		"-S",
		"unix:///tmp/rex.sock",
		"--autostart=false",
		"--timeout",
		"5s",
		"ls",
		"--json",
	]);
});

test("discoverRex reads the local endpoint", async () => {
	const runner = fakeRunner(() => whoami());
	const found = await discoverRex(runner, {});
	assert.equal(found.endpoint, "unix:///tmp/rex.sock");
	assert.equal(found.hostId, "host-1");
	assert.equal(found.version, "1.2.3");
	assert.deepEqual(runner.calls[0].args, ["whoami", "--json"]);
});

test("discoverRex refuses a non-local endpoint", async () => {
	const runner = fakeRunner(() => whoami({ endpoint: "tcp://10.0.0.5:7777" }));
	await assert.rejects(() => discoverRex(runner, {}), (error: unknown) => {
		assert.ok(error instanceof RexError);
		assert.equal(error.kind, "invalid");
		assert.match(error.message, /non-local/);
		return true;
	});
});

test("discoverRex reports a missing server as unavailable", async () => {
	const runner = fakeRunner(() => result({ code: 1, stderr: "connection refused" }));
	await assert.rejects(() => discoverRex(runner, {}), (error: unknown) => {
		assert.ok(error instanceof RexError);
		assert.equal(error.kind, "unavailable");
		return true;
	});
});

test("validateRex rejects a replaced server", async () => {
	const runner = fakeRunner(() => whoami({ host_id: "host-2" }));
	await assert.rejects(() => validateRex(location, runner), (error: unknown) => {
		assert.ok(error instanceof RexError);
		assert.equal(error.kind, "stale");
		return true;
	});
});

test("createSession starts the supervisor without a shell", async () => {
	const runner = fakeRunner(() =>
		json({ session_id: "session:1", initial_windows: [{ window_id: "window:1", block_ids: ["block:1"] }] }),
	);
	const launched = await createSession(
		location,
		{ label: "rex-subagents", windowLabel: "alpha", cwd: "/tmp/project", argv: ["/bin/sh", "/tmp/supervisor.sh"] },
		runner,
	);
	assert.deepEqual(launched, { sessionId: "session:1", windowId: "window:1", blockId: "block:1" });
	const command = rexCommand(runner.calls[0].args);
	assert.deepEqual(command, [
		"new",
		"rex-subagents",
		"--window",
		"alpha",
		"-c",
		"/tmp/project",
		"--shell=none",
		"--keep-open",
		"--json",
		"--",
		"/bin/sh",
		"/tmp/supervisor.sh",
	]);
});

test("addWindow keeps focus and targets the batch session", async () => {
	const runner = fakeRunner(() => json({ window_id: "window:2", block_ids: ["block:2"] }));
	await addWindow(location, "session:1", { windowLabel: "beta", cwd: "/tmp/project", argv: ["/bin/sh", "/tmp/s.sh"] }, runner);
	const command = rexCommand(runner.calls[0].args);
	assert.deepEqual(command.slice(0, 5), ["window", "new", "-s", "session:1", "beta"]);
	assert.ok(command.includes("--focus=false"));
});

test("createSession rejects a reply without resources", async () => {
	const runner = fakeRunner(() => json({ session_id: "session:1", initial_windows: [] }));
	await assert.rejects(() => createSession(location, { label: "l", windowLabel: "w", cwd: "/tmp", argv: ["x"] }, runner));
});

test("probeBlock distinguishes running, exited and missing", async () => {
	const running = fakeRunner(() => json({ last_exit: null, child: { pid: 42 } }));
	assert.deepEqual(await probeBlock(location, "session:1", "block:1", running), { state: "running" });

	const exited = fakeRunner(() => json({ last_exit: { exit_code: 7 }, home: "/Users/x" }));
	assert.deepEqual(await probeBlock(location, "session:1", "block:1", exited), { state: "exited", exitCode: 7 });

	const missing = fakeRunner(() => result({ code: 1, stderr: 'block target "block:1" not found' }));
	assert.equal((await probeBlock(location, "session:1", "block:1", missing)).state, "missing");

	const broken = fakeRunner(() => result({ code: 1, stderr: "Rex server is not running" }));
	assert.equal((await probeBlock(location, "session:1", "block:1", broken)).state, "unknown");
});

test("inspectBlock resolves the parent window", async () => {
	const runner = fakeRunner(() => json({ block: { window_id: "window:9" } }));
	assert.equal(await inspectBlock(location, "session:1", "block:1", runner), "window:9");
	assert.deepEqual(rexCommand(runner.calls[0].args), ["block", "inspect", "-s", "session:1", "block:1", "--json"]);

	const empty = fakeRunner(() => json({ block: {} }));
	assert.equal(await inspectBlock(location, "session:1", "block:1", empty), undefined);
});

test("listWindows reads block ids out of layers", async () => {
	const runner = fakeRunner(() =>
		json({
			windows: [
				{ window_id: "window:1", label: "a", layers: [{ blocks: [{ block_id: "block:1" }, { block_id: "block:2" }] }] },
				{ window_id: "window:2", label: "b" },
			],
		}),
	);
	assert.deepEqual(await listWindows(location, "session:1", runner), [
		{ windowId: "window:1", label: "a", blockIds: ["block:1", "block:2"] },
		{ windowId: "window:2", label: "b", blockIds: [] },
	]);
});

test("listSessions and listApps tolerate extra fields", async () => {
	const sessions = fakeRunner(() => json({ sessions: [{ session_id: "session:1", label: "one" }, { nope: true }] }));
	assert.deepEqual(await listSessions(location, sessions), [{ sessionId: "session:1", label: "one" }]);

	const apps = fakeRunner(() =>
		json({
			clients: [
				{ client_id: "client:1", info: { kind: "app", label: "MacBook" } },
				{ client_id: "client:2", principal: { kind: "peer" } },
			],
		}),
	);
	assert.deepEqual(await listApps(location, apps), [{ clientId: "client:1", label: "MacBook" }]);
});

test("selectSession passes full ids and never guesses a client", async () => {
	const runner = fakeRunner(() => result({ code: 0 }));
	await selectSession(location, "session:1", "window:1", runner, "client:9");
	const withClient = rexCommand(runner.calls[0].args);
	assert.deepEqual(withClient, ["-C", "client:9", "do", "session.select", "session_id=session:1", "window_id=window:1"]);

	await selectSession(location, "session:1", undefined, runner);
	const withoutClient = rexCommand(runner.calls[1].args);
	assert.deepEqual(withoutClient, ["do", "session.select", "session_id=session:1"]);
});

test("selectSession reports refusal", async () => {
	const runner = fakeRunner(() => result({ code: 1, stderr: "Rex.app is not accepting actions" }));
	await assert.rejects(() => selectSession(location, "session:1", undefined, runner), /not accepting actions/);
});

test("defaultRunner caps captured output instead of exhausting memory", { timeout: 30_000 }, async () => {
	// Emit far more than the cap; the runner must not accumulate it all.
	const flood = "process.stdout.write('x'.repeat(1024 * 1024));".repeat(6);
	const run = await defaultRunner.run(process.execPath, ["-e", flood], { timeoutMs: 20_000 });
	assert.equal(run.code, 0);
	assert.ok(run.stdout.length <= 2_000_000 + 40, `stdout was ${run.stdout.length} bytes`);
	assert.match(run.stdout, /\[output truncated\]$/);
});

test("defaultRunner keeps small outputs verbatim", async () => {
	const run = await defaultRunner.run(process.execPath, ["-e", "process.stdout.write('tiny')"], { timeoutMs: 10_000 });
	assert.equal(run.code, 0);
	assert.equal(run.stdout, "tiny");
});
