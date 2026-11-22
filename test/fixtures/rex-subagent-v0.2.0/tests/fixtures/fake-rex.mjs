#!/usr/bin/env node
// Minimal Rex server stand-in: enough of the CLI surface for CLI end-to-end tests.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const statePath = process.env.FAKE_REX_STATE;
if (!statePath) {
	process.stderr.write("FAKE_REX_STATE is not set\n");
	process.exit(1);
}

const state = existsSync(statePath)
	? JSON.parse(readFileSync(statePath, "utf8"))
	: {
			sessions: [],
			clients: [{ client_id: "client:app", info: { kind: "app", label: "Fake Rex" } }],
			blocks: {},
			pid: {},
		};

function save() {
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const argv = process.argv.slice(2);
let index = 0;
while (index < argv.length) {
	const arg = argv[index];
	if (arg === "-S" || arg === "--timeout" || arg === "-C") {
		index += 2;
		continue;
	}
	if (arg === "--autostart=false" || arg === "--autostart") {
		index += 1;
		continue;
	}
	break;
}
const rest = argv.slice(index);
const id = (prefix) => `${prefix}:${Math.random().toString(16).slice(2, 10)}`;

function spawnAgent(command, cwd, blockId) {
	const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore" });
	child.unref();
	state.pid[blockId] = child.pid;
	save();
}

// Tests must not leak the detached supervisor when a run is stopped.
function killBlock(blockId) {
	const pid = state.pid[blockId];
	if (!pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
	delete state.pid[blockId];
}

function sessionOf(sessionId) {
	const session = state.sessions.find((entry) => entry.session_id === sessionId);
	if (!session) fail(`session target "${sessionId}" not found`);
	return session;
}

const [command, sub, ...tail] = rest;

// A test can force every management command (but not whoami) to fail, to
// exercise unconfirmed stops against a server that is technically reachable.
if (process.env.FAKE_REX_FAIL === "1" && command !== "whoami") {
	fail("server is down");
}

if (command === "whoami") {
	emit({ endpoint: "unix:///tmp/fake-rex.sock", host_id: "host-fake", account: "tester", rex_version: "fake-1", pid: process.pid });
} else if (command === "ls") {
	emit({ sessions: state.sessions.map(({ session_id, label }) => ({ session_id, label })) });
} else if (command === "new") {
	const label = sub;
	const windowIndex = tail.indexOf("--window");
	const windowLabel = windowIndex >= 0 ? tail[windowIndex + 1] : "shell";
	const cwdIndex = tail.indexOf("-c");
	const cwd = cwdIndex >= 0 ? tail[cwdIndex + 1] : process.cwd();
	const separator = tail.indexOf("--");
	const argvRest = separator >= 0 ? tail.slice(separator + 1) : [];
	const session = { session_id: id("session"), label, windows: [] };
	const window = { window_id: id("window"), label: windowLabel, block_ids: [id("block")] };
	session.windows.push(window);
	state.sessions.push(session);
	save();
	if (argvRest.length > 0) spawnAgent(argvRest, cwd, window.block_ids[0]);
	emit({ session_id: session.session_id, initial_windows: [{ window_id: window.window_id, block_ids: window.block_ids }] });
} else if (command === "window" && sub === "new") {
	const sessionIndex = tail.indexOf("-s");
	const session = sessionOf(tail[sessionIndex + 1]);
	const label = tail[sessionIndex + 2];
	const cwdIndex = tail.indexOf("-c");
	const cwd = cwdIndex >= 0 ? tail[cwdIndex + 1] : process.cwd();
	const separator = tail.indexOf("--");
	const argvRest = separator >= 0 ? tail.slice(separator + 1) : [];
	const window = { window_id: id("window"), label, block_ids: [id("block")] };
	session.windows.push(window);
	save();
	if (argvRest.length > 0) spawnAgent(argvRest, cwd, window.block_ids[0]);
	emit({ window_id: window.window_id, block_ids: window.block_ids });
} else if (command === "window" && sub === "close") {
	const sessionIndex = tail.indexOf("-s");
	const session = sessionOf(tail[sessionIndex + 1]);
	const windowId = tail[tail.length - 1];
	const closing = session.windows.find((window) => window.window_id === windowId);
	const before = session.windows.length;
	session.windows = session.windows.filter((window) => window.window_id !== windowId);
	if (session.windows.length === before) fail(`window target "${windowId}" not found`);
	for (const blockId of closing.block_ids) killBlock(blockId);
	save();
} else if (command === "session" && sub === "inspect") {
	const session = sessionOf(sub === "inspect" ? tail[0] : "");
	emit({
		session_id: session.session_id,
		label: session.label,
		windows: session.windows.map((window) => ({
			window_id: window.window_id,
			label: window.label,
			layers: [{ blocks: [{ block_id: window.block_ids[0] }] }],
		})),
	});
} else if (command === "block" && sub === "call") {
	const sessionIndex = tail.indexOf("-s");
	const session = sessionOf(tail[sessionIndex + 1]);
	const blockIndex = tail.indexOf("-b");
	const blockId = tail[blockIndex + 1];
	const owned = session.windows.some((window) => window.block_ids.includes(blockId));
	if (!owned) fail(`block target "${blockId}" not found`);
	const pid = state.pid[blockId];
	if (pid && alive(pid)) emit({ last_exit: null, child: { pid } });
	else emit({ last_exit: { exit_code: 0 } });
} else if (command === "kill") {
	const session = sessionOf(sub);
	for (const window of session.windows) for (const blockId of window.block_ids) killBlock(blockId);
	state.sessions = state.sessions.filter((entry) => entry.session_id !== session.session_id);
	save();
} else if (command === "client") {
	emit({ clients: state.clients });
} else if (command === "do") {
	emit(null);
} else {
	fail(`Unexpected Rex command: ${rest.join(" ")}`);
}
