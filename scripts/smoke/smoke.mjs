/**
 * Real-provider smoke driver for pi-goal 0.3.0 (spec #81).
 * Drives a real `pi --mode rpc` session with the repo loaded as an extension,
 * answering the confirmation editor over the extension-UI subprotocol.
 * The model is real: waits are generous and the interview loop is adaptive.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MODEL = process.env.SMOKE_MODEL ?? "magpie/qoder/hmodel";
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);

const cwd = mkdtempSync(join(tmpdir(), "pi-goal-smoke-work-"));
const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-smoke-sessions-"));
console.log(`work dir: ${cwd}\nsession dir: ${sessionDir}\nmodel: ${MODEL}`);
const results = [];
function report(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const records = [];
const waiters = [];
let proc, buffer = "", stderr = "";
const answered = new Set();

function onRecord(r) {
	if (r.type === "message_end" && r.message?.role === "assistant" && r.message?.stopReason === "error") {
		console.log("PROVIDER ERROR:", (r.message.errorMessage ?? "").slice(0, 200));
	}
	records.push(r);
	for (const w of [...waiters]) {
		const value = w.test(records);
		if (value !== undefined) {
			clearTimeout(w.timer);
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(value);
		}
	}
}
function waitFor(description, test, timeoutMs = TIMEOUT) {
	const safe = (rs) => { try { return test(rs); } catch { return undefined; } };
	const immediate = safe(records);
	if (immediate !== undefined) return Promise.resolve(immediate);
	return new Promise((resolve, reject) => {
		const waiter = { test: safe, resolve: null, timer: null };
		waiter.resolve = resolve;
		waiter.timer = setTimeout(() => {
			waiters.splice(waiters.indexOf(waiter), 1);
			reject(new Error(`TIMEOUT: ${description}\nlast records: ${records.slice(-12).map((r) => r.type + (r.method ? ":" + r.method : "")).join(", ")}\nstderr: ${stderr.slice(-600)}`));
		}, timeoutMs);
		waiters.push(waiter);
	});
}
function write(cmd) { proc.stdin.write(JSON.stringify(cmd) + "\n"); }
let nextId = 0;
async function prompt(message) {
	const id = `req-${++nextId}`;
	const p = waitFor(`response ${id}`, (rs) => rs.find((r) => r.type === "response" && r.id === id));
	write({ id, type: "prompt", message });
	return p;
}
const notify = (matcher) => (rs) => rs.find((r) => r.type === "extension_ui_request" && r.method === "notify" && matcher(r));
const settled = (n) => (rs) => rs.filter((r) => r.type === "agent_settled").length >= n ? true : undefined;
const pendingEditor = (rs) => rs.find((r) => r.type === "extension_ui_request" && r.method === "editor" && !answered.has(r.id));
function answerEditor(request, value) {
	answered.add(request.id);
	if (value === null) write({ type: "extension_ui_response", id: request.id, cancelled: true });
	else write({ type: "extension_ui_response", id: request.id, value });
}
function assistantTexts() {
	return records.filter((r) => r.type === "message" && r.message?.role === "assistant")
		.map((r) => (r.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n")).filter(Boolean);
}
const lastAssistant = () => assistantTexts().slice(-1)[0] ?? "(none)";
async function command(text) {
	const resp = await prompt(text);
	return resp;
}
async function goalStatus() {
	const before = records.length;
	await command("/goal");
	await new Promise((r) => setTimeout(r, 1500));
	return records.slice(before).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message).join("\n---\n");
}

proc = spawn("pi", ["--mode", "rpc", "-ne", "-e", REPO, "--model", MODEL, "--session-dir", sessionDir], {
	cwd, stdio: ["pipe", "pipe", "pipe"],
});
proc.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let i;
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
		if (line.trim()) onRecord(JSON.parse(line));
	}
});
proc.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
	// --- 1. clarified creation -------------------------------------------
	await command("/goal Write a haiku about persistent sessions in a file called haiku.txt");
	await waitFor("clarification started", notify((r) => /Objective clarification started/i.test(r.message ?? "")));
	report("1a. /goal starts clarification (no Goal committed)", true);

	let editor = null;
	let settles = 0;
	for (let round = 0; round < 4 && !editor; round++) {
		await prompt("Goal: write a haiku about persistent sessions into haiku.txt in the current directory. Constraints: create only haiku.txt, do not touch any other file. Acceptance criteria: 1) haiku.txt exists with a three-line haiku about persistent sessions; 2) no other file is modified. Please propose the goal now.");
		try {
			editor = await waitFor("confirmation editor", pendingEditor, 90_000);
		} catch {
			settles++;
			console.log(`round ${round + 1}: no editor yet; model said: ${lastAssistant().slice(0, 300)}`);
		}
	}
	if (!editor) throw new Error("model never opened the confirmation editor");
	console.log("EDITOR PREFILL:\n" + (editor.prefill ?? "(no prefill)"));
	const doc = editor.prefill.replace(/^Title:.*$/m, "Title: Smoke haiku");
	answerEditor(editor, doc);
	await waitFor("goal created", notify((r) => /created and activated/i.test(r.message ?? "")));
	report("1b. propose_goal + edited save commits the Goal", true);

	// --- 2. status shows the confirmed title ------------------------------
	const status1 = await goalStatus();
	console.log("STATUS:\n" + status1);
	report("2. bare /goal shows confirmed title", /Smoke haiku/.test(status1));

	// --- 3. unfinished Goal refuses a new /goal ---------------------------
	const before3 = records.length;
	await command("/goal Write a sonnet instead");
	const refusal = await waitFor("unfinished refusal", notify((r) => /goal:clear/i.test(r.message ?? "") && /unfinished/i.test(r.message ?? "")), 30_000)
		.catch(() => null);
	if (refusal) {
		report("3. unfinished Goal refuses new /goal naming /goal:clear", true);
	} else {
		const s = await goalStatus();
		report("3. unfinished Goal refuses new /goal", false, `status now: ${s.slice(0, 200)}`);
	}

	// --- 4. title edit -----------------------------------------------------
	await command('/goal:edit --title "Release prep"');
	await waitFor("title set", notify((r) => /title set to/i.test(r.message ?? "")), 30_000);
	const status4 = await goalStatus();
	report("4. /goal:edit --title updates the title", /Release prep/.test(status4));

	// --- 5. pause / resume -------------------------------------------------
	await command("/goal:pause");
	await waitFor("paused", notify((r) => /paused/i.test(r.message ?? "")), 30_000);
	const status5a = await goalStatus();
	report("5a. pause", /paused/i.test(status5a));
	await command("/goal:resume");
	await waitFor("resumed", notify((r) => /resumed/i.test(r.message ?? "")), 30_000);
	const status5b = await goalStatus();
	report("5b. resume", /active/i.test(status5b));

	// --- 6. clear ----------------------------------------------------------
	await command("/goal:clear");
	await waitFor("cleared", notify((r) => /cleared/i.test(r.message ?? "")), 30_000);
	const status6 = await goalStatus();
	report("6. clear removes the Goal", /No Goal is set/i.test(status6));

	// --- 7. cancelling a clarification creates nothing ---------------------
	await command("/goal Add a second haiku");
	await waitFor("clarification 2 started", notify((r) => /Objective clarification started/i.test(r.message ?? "")), 60_000);
	const editor2 = await waitFor("second editor", pendingEditor, 180_000).catch(() => null);
	if (!editor2) {
		// model may ask a question first; nudge once
		await prompt("Any haiku is fine. Please propose the goal now.");
		const e2 = await waitFor("second editor (retry)", pendingEditor, 90_000);
		answerEditor(e2, null);
	} else {
		answerEditor(editor2, null);
	}
	await waitFor("no goal created notice", notify((r) => /no Goal was created/i.test(r.message ?? "")), 30_000).catch(() => null);
	const status7 = await goalStatus();
	report("7. cancelling the confirmation creates no Goal", /No Goal is set/i.test(status7));

	console.log("\nALL DONE");
} catch (error) {
	console.error("SMOKE ABORTED:", error.message);
	report("aborted", false, error.message.slice(0, 400));
} finally {
	proc.kill("SIGTERM");
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nSUMMARY: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
