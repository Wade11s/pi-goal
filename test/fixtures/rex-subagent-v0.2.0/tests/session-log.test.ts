import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { newestSessionFile, readSessionMessages, transcriptFromSession } from "../src/session-log.ts";
import { tempEnv } from "./helpers.ts";

function entry(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function sessionFile(dir: string, name: string, lines: string[]): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, lines.join(""));
	return path;
}

test("readSessionMessages keeps user and assistant text only", () => {
	const temp = tempEnv();
	try {
		const path = sessionFile(temp.dir, "s.jsonl", [
			entry({ type: "session", version: 3, id: "x" }),
			entry({ type: "message", id: "u1", message: { role: "user", content: "do the thing" } }),
			entry({
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "thinking", text: "hm" }] },
			}),
			entry({ type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "output" }] } }),
			"not json\n",
			entry({ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }),
		]);
		assert.deepEqual(readSessionMessages(path), [
			{ role: "user", text: "do the thing" },
			{ role: "assistant", text: "done" },
		]);
	} finally {
		temp.cleanup();
	}
});

test("newestSessionFile picks the most recently modified session", () => {
	const temp = tempEnv();
	try {
		const older = sessionFile(temp.dir, "2026-01-01_aaa.jsonl", [entry({ type: "session" })]);
		const newer = sessionFile(temp.dir, "2026-01-02_bbb.jsonl", [entry({ type: "session" })]);
		utimesSync(older, new Date(2020, 1, 1), new Date(2020, 1, 1));
		utimesSync(newer, new Date(2021, 1, 1), new Date(2021, 1, 1));
		writeFileSync(join(temp.dir, "notes.txt"), "ignored");
		assert.equal(newestSessionFile(temp.dir), newer);
		assert.equal(newestSessionFile(join(temp.dir, "missing")), undefined);
	} finally {
		temp.cleanup();
	}
});

test("transcriptFromSession numbers prompts and answers", () => {
	const temp = tempEnv();
	try {
		sessionFile(temp.dir, "2026-01-01_aaa.jsonl", [
			entry({ type: "message", id: "u1", message: { role: "user", content: "first task" } }),
			entry({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
			entry({ type: "message", id: "u2", message: { role: "user", content: "second task" } }),
			entry({ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }),
		]);
		const expected = [
			"=== prompt 1 ===\nfirst task",
			"=== answer 1 ===\nfirst answer",
			"=== prompt 2 ===\nsecond task",
			"=== answer 2 ===\nsecond answer",
		].join("\n\n");
		assert.equal(transcriptFromSession(temp.dir), `${expected}\n`);
	} finally {
		temp.cleanup();
	}
});

test("transcriptFromSession returns empty text without a session", () => {
	const temp = tempEnv();
	try {
		assert.equal(transcriptFromSession(join(temp.dir, "none")), "");
		assert.equal(transcriptFromSession(temp.dir), "");
	} finally {
		temp.cleanup();
	}
});

test("readSessionMessages tailBytes reads only the end of a long session", () => {
	const temp = tempEnv();
	try {
		const lines: string[] = [];
		for (let i = 1; i <= 50; i += 1) {
			lines.push(
				entry({ type: "message", id: `u${i}`, message: { role: "user", content: `task ${i}` } }),
				entry({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } }),
			);
		}
		const path = sessionFile(temp.dir, "long.jsonl", lines);
		const whole = readSessionMessages(path);
		assert.equal(whole.length, 100);
		// The last two lines are one user/assistant pair.
		const tail = readSessionMessages(path, { tailBytes: 200 });
		assert.ok(tail.length >= 2, `expected at least the last pair, got ${tail.length}`);
		assert.deepEqual(tail.slice(-2), whole.slice(-2));
		// A tail larger than the file reads everything.
		assert.deepEqual(readSessionMessages(path, { tailBytes: 10_000_000 }), whole);
	} finally {
		temp.cleanup();
	}
});

test("transcriptFromSession with tailLines renders only recent turns", () => {
	const temp = tempEnv();
	try {
		const lines: string[] = [];
		for (let i = 1; i <= 20; i += 1) {
			lines.push(
				entry({ type: "message", id: `u${i}`, message: { role: "user", content: `task ${i}` } }),
				entry({ type: "message", id: `a${i}`, message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } }),
			);
		}
		sessionFile(temp.dir, "long.jsonl", lines);
		const full = transcriptFromSession(temp.dir);
		const tail = transcriptFromSession(temp.dir, { tailLines: 4 });
		assert.equal(tail, full.split("\n").slice(-4).join("\n"));
		assert.match(tail, /answer 20/);
		assert.ok(!tail.includes("answer 18"), "lines before the tail are not rendered");
	} finally {
		temp.cleanup();
	}
});
