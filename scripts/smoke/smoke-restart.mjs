/**
 * Real-provider smoke: clarification survives a process kill and resumes
 * with its held flags (spec #81 / issue #85).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MODEL = process.env.SMOKE_MODEL ?? "magpie/qoder/hmodel";
const cwd = mkdtempSync(join(tmpdir(), "pi-goal-smoke-restart-work-"));
const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-smoke-restart-sessions-"));
console.log(`work dir: ${cwd}\nsession dir: ${sessionDir}`);

class Session {
	constructor(sessionFile) {
		this.records = [];
		this.waiters = [];
		this.answered = new Set();
		this.buffer = "";
		this.stderr = "";
		const args = ["--mode", "rpc", "-ne", "-e", REPO, "--model", MODEL];
		if (sessionFile) args.push("--session", sessionFile);
		else args.push("--session-dir", sessionDir);
		this.proc = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout.on("data", (c) => {
			this.buffer += c.toString("utf8");
			let i;
			while ((i = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
				if (line.trim()) this.onRecord(JSON.parse(line));
			}
		});
		this.proc.stderr.on("data", (c) => { this.stderr += c.toString("utf8"); });
		this.nextId = 0;
	}
	onRecord(r) {
		this.records.push(r);
		for (const w of [...this.waiters]) {
			const v = w.test(this.records);
			if (v !== undefined) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(v); }
		}
	}
	waitFor(desc, test, timeoutMs = 180_000) {
		const safe = (rs) => { try { return test(rs); } catch { return undefined; } };
		const imm = safe(this.records);
		if (imm !== undefined) return Promise.resolve(imm);
		return new Promise((resolve, reject) => {
			const w = { test: safe, resolve, timer: null };
			w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`TIMEOUT: ${desc}\nlast: ${this.records.slice(-10).map((r) => r.type + (r.method ? ":" + r.method : "")).join(", ")}\nstderr: ${this.stderr.slice(-500)}`)); }, timeoutMs);
			this.waiters.push(w);
		});
	}
	write(cmd) { this.proc.stdin.write(JSON.stringify(cmd) + "\n"); }
	async prompt(message) {
		const id = `req-${++this.nextId}`;
		const p = this.waitFor(`response ${id}`, (rs) => rs.find((r) => r.type === "response" && r.id === id));
		this.write({ id, type: "prompt", message });
		return p;
	}
	notify(matcher) { return (rs) => rs.find((r) => r.type === "extension_ui_request" && r.method === "notify" && matcher(r)); }
	pendingEditor(rs) { return rs.find((r) => r.type === "extension_ui_request" && r.method === "editor" && !this.answered.has(r.id)); }
	answerEditor(request, value) {
		this.answered.add(request.id);
		this.write({ type: "extension_ui_response", id: request.id, value });
	}
	async status() {
		const before = this.records.length;
		await this.prompt("/goal");
		await new Promise((r) => setTimeout(r, 1500));
		return this.records.slice(before).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message).join("\n");
	}
	kill() { this.proc.kill("SIGKILL"); }
}

const results = [];
const report = (name, ok) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

// Phase 1: start a clarification holding --budget, answer the interview, then kill.
let a = new Session();
await a.prompt("/goal --budget 5000 Write a haiku about persistent sessions in a file called haiku.txt");
await a.waitFor("clarification started", a.notify((r) => /Objective clarification started/i.test(r.message ?? "")));
await a.prompt("Goal: haiku about persistent sessions in haiku.txt. Constraints: only that file. Acceptance: file exists with 3 lines. Please propose the goal now.");
let editorA = null;
for (let round = 0; round < 3 && !editorA; round++) {
	try {
		editorA = await a.waitFor("editor before kill", a.pendingEditor.bind(a), 120_000);
	} catch {
		console.log(`round ${round + 1}: no editor yet, nudging`);
		await a.prompt("All details are settled. Please call propose_goal now.");
	}
}
if (!editorA) throw new Error("model never opened the editor before kill");
console.log("editor open; killing the process mid-clarification");
a.kill();
await new Promise((r) => setTimeout(r, 2000));

const sessionFiles = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
if (!sessionFiles.length) throw new Error("no session file found");
const sessionFile = join(sessionDir, sessionFiles[0]);
console.log("resuming:", sessionFile);

// Phase 2: resume, expect restore notice and held flags, then save.
let b = new Session(sessionFile);
await b.waitFor("clarification restored", b.notify((r) => /clarification restored/i.test(r.message ?? "")), 60_000);
report("1. restore notice after kill", true);
const st = await b.status();
console.log("STATUS AFTER RESTORE:\n" + st);
report("2. bare /goal names held --budget flag", /5000/.test(st) && /clarification/i.test(st));

await b.prompt("Please propose the goal now.");
let editor = null;
for (let round = 0; round < 3 && !editor; round++) {
	try {
		editor = await b.waitFor("editor after restore", b.pendingEditor.bind(b), 120_000);
	} catch {
		console.log(`round ${round + 1}: no editor yet after restore, nudging`);
		await b.prompt("All details are settled. Please call propose_goal now.");
	}
}
if (!editor) throw new Error("model never opened the editor after restore");
console.log("EDITOR PREFILL (first 300):\n" + (editor.prefill ?? "").slice(0, 300));
b.answerEditor(editor, editor.prefill);
await b.waitFor("goal created", b.notify((r) => /created and activated/i.test(r.message ?? "")), 60_000);
const st2 = await b.status();
console.log("STATUS AFTER SAVE:\n" + st2);
report("3. Goal commits after restart with held budget", /5000/.test(st2));

b.proc.kill("SIGTERM");
const failed = results.filter((ok) => !ok).length;
console.log(`\nSUMMARY: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
