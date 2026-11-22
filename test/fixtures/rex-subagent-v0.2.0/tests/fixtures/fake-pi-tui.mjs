#!/usr/bin/env node
// Stand-in for the child Pi TUI: it publishes the same status file the child
// extension writes and leaves a session JSONL file behind for `logs`.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runDir = process.env.REX_SUBAGENT_RUN_DIR;
if (!runDir) {
	process.stderr.write("REX_SUBAGENT_RUN_DIR is not set\n");
	process.exit(2);
}

// Test knob: a Pi that dies with code 0 before writing any status file,
// modelling a user closing the TUI (or Pi crashing) before the first turn.
if (process.env.FAKE_PI_MODE === "exit0") process.exit(0);

function writeStatus(payload) {
	const path = join(runDir, "status.json");
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify({ ...payload, updatedAt: new Date().toISOString(), transport: "tui" })}\n`);
	renameSync(temporary, path);
}

const logPath = process.env.FAKE_PI_LOG;
if (logPath) appendFileSync(logPath, `START|${process.env.REX_SUBAGENT_TITLE ?? ""}\n`);

writeStatus({ state: "busy", turn: 0, lastExit: null });

const completionDelayMs = Number(process.env.FAKE_PI_DELAY_MS ?? "300");
setTimeout(() => {
	// A test may already have deleted the run; never recreate it.
	if (!existsSync(runDir)) process.exit(0);
	const inbox = join(runDir, "inbox");
	let prompt = "prompt";
	if (existsSync(inbox)) {
		const files = readdirSync(inbox)
			.filter((name) => name.endsWith(".json"))
			.sort();
		const first = files[0];
		if (first) {
			try {
				prompt = JSON.parse(readFileSync(join(inbox, first), "utf8")).message;
			} catch {
				// Fall back to the placeholder prompt.
			}
			unlinkSync(join(inbox, first));
		}
	}
	const sessions = join(runDir, "sessions");
	mkdirSync(sessions, { recursive: true });
	const now = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: "fake-session", timestamp: now, cwd: process.cwd() },
		{ type: "message", id: "u1", parentId: null, timestamp: now, message: { role: "user", content: prompt } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: now,
			message: { role: "assistant", content: [{ type: "text", text: "fake answer" }] },
		},
	];
	writeFileSync(join(sessions, "2026-01-01T00-00-00-000Z_fake.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	writeStatus({ state: "idle", turn: 1, lastExit: 0 });
}, completionDelayMs);

// A TUI stays alive until its terminal closes. Tests may also delete the run
// directory, which must not leave this process behind.
setInterval(() => {
	if (!existsSync(runDir)) process.exit(0);
}, 500);
// A test that never stops its run must not leak this process forever.
setTimeout(() => process.exit(0), 120_000);
