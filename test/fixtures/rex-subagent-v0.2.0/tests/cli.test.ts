import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { shellQuote } from "../src/shell.ts";
import { tempEnv, writeExecutable } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli.ts");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface Env {
	env: NodeJS.ProcessEnv;
	dir: string;
	statePath: string;
	piLog: string;
	cleanup: () => void;
}

function setup(): Env {
	const temp = tempEnv();
	const statePath = join(temp.dir, "rex-state.json");
	const piLog = join(temp.dir, "pi.log");
	writeExecutable(
		join(temp.dir, "bin", "rex"),
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(here, "fixtures", "fake-rex.mjs"))} "$@"\n`,
	);
	writeExecutable(
		join(temp.dir, "bin", "pi"),
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(here, "fixtures", "fake-pi-tui.mjs"))} "$@"\n`,
	);
	temp.env.FAKE_REX_STATE = statePath;
	return { ...temp, statePath, piLog };
}

function cli(env: NodeJS.ProcessEnv, args: string[], timeoutMs = 30_000): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cliPath, ...args], { env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

function spawnArgs(fixture: Env, name: string, prompt: string, extra: string[] = []): string[] {
	return [
		"spawn",
		"--name",
		name,
		"--cwd",
		fixture.dir,
		"--prompt",
		prompt,
		"--env",
		`FAKE_PI_LOG=${fixture.piLog}`,
		...extra,
		"--json",
	];
}

test("cli end to end: spawn, wait, logs, send, stop over a fake Rex server", async () => {
	const fixture = setup();
	try {
		const spawnedResult = await cli(fixture.env, spawnArgs(fixture, "alpha", "first task", ["--model", "xai/grok-4.7", "--thinking", "high"]));
		assert.equal(spawnedResult.code, 0, spawnedResult.stderr);
		const spawned = JSON.parse(spawnedResult.stdout);
		assert.match(spawned.handle, /^[0-9a-f]{6}$/);
		assert.match(spawned.sessionId, /^session:/);

		const wait = await cli(fixture.env, ["wait", spawned.handle, "--for", "20s", "--json"]);
		assert.equal(wait.code, 0, `${wait.stdout}\n${wait.stderr}`);
		const [waited] = JSON.parse(wait.stdout);
		assert.equal(waited.outcome, "idle");
		assert.equal(waited.turn, 1);
		assert.equal(waited.agentState, "idle");
		assert.equal(waited.processExitCode, null, "the process is alive while idle");

		const metadata = JSON.parse(readFileSync(join(fixture.dir, "agent", "rex-subagents", spawned.handle, "metadata.json"), "utf8"));
		assert.equal(metadata.launchArgs.filter((arg: string) => arg === "--use-theme").length, 1);
		assert.equal(metadata.launchArgs[metadata.launchArgs.indexOf("--use-theme") + 1], "dark");

		// The child runs as a TUI with the child extension, not in print or RPC mode.
		assert.match(readFileSync(fixture.piLog, "utf8"), /START\|alpha — grok-4\.7:high/);
		// The launcher must not touch Pi's OSC 7501 reporting.
		const childScript = readFileSync(join(fixture.dir, "agent", "rex-subagents", spawned.handle, "child.sh"), "utf8");
		assert.ok(!childScript.includes("PI_PROGRAM_STATUS"), "the protocol must stay on");
		assert.match(childScript, /export REX_SUBAGENT_REX='/);

		const logs = await cli(fixture.env, ["logs", spawned.handle]);
		assert.match(logs.stdout, /=== prompt 1 ===\nfirst task/);
		assert.match(logs.stdout, /=== answer 1 ===\nfake answer/);

		const status = await cli(fixture.env, ["status", spawned.handle, "--json"]);
		assert.equal(status.code, 0, status.stderr);
		const parsedStatus = JSON.parse(status.stdout);
		assert.equal(parsedStatus.state, "idle");
		assert.equal(parsedStatus.name, "alpha");

		const sent = await cli(fixture.env, ["send", spawned.handle, "second task", "--json"]);
		assert.equal(sent.code, 0, sent.stderr);
		assert.deepEqual(JSON.parse(sent.stdout), { message: 2, delivery: "auto", queuedBehindRunningTurn: false, unconfirmed: false });
		const inbox = join(fixture.dir, "agent", "rex-subagents", spawned.handle, "inbox", "0002.json");
		assert.deepEqual(JSON.parse(readFileSync(inbox, "utf8")), { message: "second task", delivery: "auto" });

		const steered = await cli(fixture.env, ["send", spawned.handle, "--steer", "change course", "--json"]);
		assert.deepEqual(JSON.parse(steered.stdout), { message: 3, delivery: "steer", queuedBehindRunningTurn: false, unconfirmed: false });

		const listed = await cli(fixture.env, ["list", "--all", "--json"]);
		assert.equal(JSON.parse(listed.stdout).length, 1);

		const stopped = await cli(fixture.env, ["stop", spawned.handle, "--remove", "--json"]);
		assert.equal(stopped.code, 0, stopped.stderr);
		assert.equal(JSON.parse(stopped.stdout)[0].removed, true);
		const after = await cli(fixture.env, ["list", "--all", "--json"]);
		assert.deepEqual(JSON.parse(after.stdout), []);
	} finally {
		fixture.cleanup();
	}
});

test("cli passes an explicit child theme through to Pi", async () => {
	const fixture = setup();
	try {
		const spawnedResult = await cli(fixture.env, spawnArgs(fixture, "alpha", "first task", ["--theme", "system"]));
		assert.equal(spawnedResult.code, 0, spawnedResult.stderr);
		const spawned = JSON.parse(spawnedResult.stdout);
		const metadata = JSON.parse(readFileSync(join(fixture.dir, "agent", "rex-subagents", spawned.handle, "metadata.json"), "utf8"));
		assert.equal(metadata.launchArgs.filter((arg: string) => arg === "--use-theme").length, 1);
		assert.equal(metadata.launchArgs[metadata.launchArgs.indexOf("--use-theme") + 1], "system");

		const stopped = await cli(fixture.env, ["stop", spawned.handle, "--remove", "--json"]);
		assert.equal(stopped.code, 0, stopped.stderr);
	} finally {
		fixture.cleanup();
	}
});

test("cli batches parallel agents into one Rex session with model titles", async () => {
	const fixture = setup();
	try {
		const first = await cli(fixture.env, spawnArgs(fixture, "alpha", "one", ["--model", "xai/grok-4.7"]));
		const second = await cli(fixture.env, spawnArgs(fixture, "beta", "two", ["--model", "kimi-coding/k3", "--thinking", "max"]));
		assert.equal(first.code, 0, first.stderr);
		assert.equal(second.code, 0, second.stderr);
		const a = JSON.parse(first.stdout);
		const b = JSON.parse(second.stdout);
		assert.equal(a.sessionId, b.sessionId, "same group must share one session");
		assert.notEqual(a.windowId, b.windowId);
		assert.equal(b.reusedBatch, true);

		const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
		assert.equal(state.sessions.length, 1);
		assert.equal(state.sessions[0].windows.length, 2);
		assert.deepEqual(
			state.sessions[0].windows.map((window: { label: string }) => window.label),
			["alpha — grok-4.7", "beta — k3:max"],
		);

		const wait = await cli(fixture.env, ["wait", a.handle, b.handle, "--for", "20s", "--json"]);
		assert.equal(wait.code, 0, wait.stdout);
		for (const result of JSON.parse(wait.stdout)) assert.equal(result.outcome, "idle");

		await cli(fixture.env, ["stop", a.handle, b.handle, "--remove", "--json"]);
	} finally {
		fixture.cleanup();
	}
});

test("cli wait --any returns only a settled run while its sibling stays busy", async () => {
	const fixture = setup();
	try {
		const first = JSON.parse((await cli(fixture.env, spawnArgs(fixture, "alpha", "one"))).stdout);
		const second = JSON.parse(
			(await cli(fixture.env, spawnArgs(fixture, "beta", "two", ["--env", "FAKE_PI_DELAY_MS=5000"]))).stdout,
		);
		writeFileSync(
			join(fixture.dir, "agent", "rex-subagents", first.handle, "status.json"),
			JSON.stringify({ state: "idle", turn: 1, lastExit: null }),
		);
		writeFileSync(
			join(fixture.dir, "agent", "rex-subagents", second.handle, "status.json"),
			JSON.stringify({ state: "busy", turn: 1, lastExit: null }),
		);
		const waited = await cli(fixture.env, ["wait", first.handle, second.handle, "--any", "--for", "2s", "--json"]);
		assert.equal(waited.code, 0, `${waited.stdout}\n${waited.stderr}`);
		const results = JSON.parse(waited.stdout);
		assert.deepEqual(results.map((entry: { handle: string }) => entry.handle), [first.handle]);
		assert.equal(results[0].outcome, "idle");
		await cli(fixture.env, ["stop", first.handle, second.handle, "--remove", "--json"]);
	} finally {
		fixture.cleanup();
	}
});

test("cli reports usage and server failures distinctly", async () => {
	const fixture = setup();
	try {
		const usage = await cli(fixture.env, ["nonsense"]);
		assert.equal(usage.code, 2);
		assert.match(usage.stderr, /unknown command/);

		const missingPrompt = await cli(fixture.env, ["spawn", "--name", "x"]);
		assert.equal(missingPrompt.code, 2);
		assert.match(missingPrompt.stderr, /at least one --prompt or --file/);

		const doctor = await cli(fixture.env, ["doctor", "--json"]);
		assert.equal(doctor.code, 0, doctor.stderr);

		const brokenEnv = { ...fixture.env, PATH: "/nonexistent" };
		const noRex = await cli(brokenEnv, ["doctor", "--json"]);
		assert.equal(noRex.code, 3);
		assert.match(noRex.stderr, /rex/i);
	} finally {
		fixture.cleanup();
	}
});

test("cli doctor reports the fake server", async () => {
	const fixture = setup();
	try {
		const report = await cli(fixture.env, ["doctor", "--json"]);
		assert.equal(report.code, 0, report.stderr);
		const parsed = JSON.parse(report.stdout);
		assert.equal(parsed.endpoint, "unix:///tmp/fake-rex.sock");
		assert.equal(parsed.hostId, "host-fake");
		assert.deepEqual(parsed.apps, ["Fake Rex"]);
		assert.equal(parsed.setup.status, "missing");
		assert.equal(existsSync(join(fixture.dir, "agent", "bin", "rex-subagent")), false, "doctor must not modify the installation");
	} finally {
		fixture.cleanup();
	}
});

test("cli version and help succeed", async () => {
	const fixture = setup();
	try {
		const version = await cli(fixture.env, ["version"]);
		assert.equal(version.code, 0);
		assert.match(version.stdout, /rex-subagent \d/);
		const help = await cli(fixture.env, ["help"]);
		assert.equal(help.code, 0);
		assert.match(help.stdout, /spawn\s+Launch one agent window/);
	} finally {
		fixture.cleanup();
	}
});

test("cli setup creates the managed link and is idempotent", async () => {
	const fixture = setup();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const first = await cli(env, ["setup", "--json"]);
		assert.equal(first.code, 0, first.stderr);
		const created = JSON.parse(first.stdout);
		assert.equal(created.status, "created");
		assert.equal(created.ok, true);
		assert.equal(created.pathConfigured, true);
		const link = join(fixture.dir, "agent", "bin", "rex-subagent");
		assert.equal(readlinkSync(link), join(here, "..", "src", "cli.ts"));

		const second = await cli(env, ["setup", "--json"]);
		assert.equal(second.code, 0, second.stderr);
		assert.equal(JSON.parse(second.stdout).status, "ready");
	} finally {
		fixture.cleanup();
	}
});

test("cli setup refuses to overwrite foreign files and symlinks", async () => {
	const fixture = setup();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const link = join(fixture.dir, "agent", "bin", "rex-subagent");
		writeExecutable(link, "#!/bin/sh\necho user-owned\n");
		const regular = await cli(env, ["setup", "--json"]);
		assert.equal(regular.code, 1);
		assert.equal(JSON.parse(regular.stdout).status, "conflict");
		assert.match(readFileSync(link, "utf8"), /user-owned/);

		const foreign = join(fixture.dir, "foreign");
		writeExecutable(foreign, "#!/bin/sh\n");
		unlinkSync(link);
		symlinkSync(foreign, link);
		const symlinked = await cli(env, ["setup", "--json"]);
		assert.equal(symlinked.code, 1);
		assert.equal(JSON.parse(symlinked.stdout).status, "conflict");
		assert.equal(readlinkSync(link), foreign);
	} finally {
		fixture.cleanup();
	}
});

test("cli setup repairs a link from an older package checkout", async () => {
	const fixture = setup();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const oldPackage = join(fixture.dir, "old-package");
		const oldCli = join(oldPackage, "src", "cli.ts");
		writeExecutable(oldCli, "#!/usr/bin/env node\n");
		writeFileSync(join(oldPackage, "package.json"), JSON.stringify({ name: "pi-rex-subagent", bin: { "rex-subagent": "./src/cli.ts" } }));
		const link = join(fixture.dir, "agent", "bin", "rex-subagent");
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(oldCli, link);

		const result = await cli(env, ["setup", "--json"]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).status, "repaired");
		assert.equal(readlinkSync(link), join(here, "..", "src", "cli.ts"));
	} finally {
		fixture.cleanup();
	}
});

test("cli setup reports a missing PATH entry after creating the link", async () => {
	const fixture = setup();
	try {
		const result = await cli(fixture.env, ["setup", "--json"]);
		assert.equal(result.code, 1, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "created");
		assert.equal(report.ok, false);
		assert.equal(report.pathConfigured, false);
		assert.equal(readlinkSync(report.linkPath), join(here, "..", "src", "cli.ts"));
	} finally {
		fixture.cleanup();
	}
});

test("cli stop leaves an unconfirmed stop visible and retryable", async () => {
	const fixture = setup();
	try {
		const spawned = JSON.parse((await cli(fixture.env, spawnArgs(fixture, "alpha", "x"))).stdout);
		// Reachable server, but every management command fails.
		const failing = { ...fixture.env, FAKE_REX_FAIL: "1" };
		const stopped = await cli(failing, ["stop", spawned.handle, "--remove", "--json"]);
		assert.equal(stopped.code, 1, stopped.stdout);
		const [result] = JSON.parse(stopped.stdout);
		assert.equal(result.stopped, false);
		assert.equal(result.removed, false, "--remove must not delete the record on an unconfirmed stop");
		assert.match(result.detail ?? "", /server is down/);
		const dir = join(fixture.dir, "agent", "rex-subagents", spawned.handle);
		assert.equal(existsSync(dir), true);
		const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
		assert.equal(metadata.state, "running", "the record stays retryable");
		assert.match(metadata.stopError ?? "", /server is down/);
		// A later send still works and the stop can be retried once Rex recovers.
		const resent = await cli(fixture.env, ["send", spawned.handle, "still there?", "--json"]);
		assert.equal(resent.code, 0, resent.stderr);
		const retried = await cli(fixture.env, ["stop", spawned.handle, "--remove", "--json"]);
		assert.equal(retried.code, 0, retried.stdout);
		assert.equal(existsSync(dir), false);
	} finally {
		fixture.cleanup();
	}
});

test("cli send refuses a dead run instead of queueing into the void", async () => {
	const fixture = setup();
	try {
		const spawned = JSON.parse((await cli(fixture.env, spawnArgs(fixture, "alpha", "x"))).stdout);
		// Stop cleanly first, then try to send.
		await cli(fixture.env, ["stop", spawned.handle, "--json"]);
		const sent = await cli(fixture.env, ["send", spawned.handle, "hello?", "--json"]);
		assert.equal(sent.code, 1);
		assert.match(sent.stderr, /is stopped/);
	} finally {
		fixture.cleanup();
	}
});

test("cli wait treats a zero exit before the first turn as failure", async () => {
	const fixture = setup();
	try {
		// The child Pi exits 0 immediately without writing status: without the
		// turn>0 guard this used to count as a clean finish.
		const spawned = JSON.parse(
			(await cli(fixture.env, spawnArgs(fixture, "quitter", "x", ["--env", "FAKE_PI_MODE=exit0"]))).stdout,
		);
		const wait = await cli(fixture.env, ["wait", spawned.handle, "--for", "20s", "--json"]);
		assert.equal(wait.code, 1, `${wait.stdout}\n${wait.stderr}`);
		const [result] = JSON.parse(wait.stdout);
		assert.equal(result.outcome, "exited");
		assert.equal(result.processExitCode, 0);
		assert.equal(result.turn, 0);
		assert.equal(result.agentState, undefined);
		const status = await cli(fixture.env, ["status", spawned.handle, "--json"]);
		assert.equal(JSON.parse(status.stdout).state, "exited");
	} finally {
		fixture.cleanup();
	}
});
