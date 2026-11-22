import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseRexBlockEvent, watchRexEvents, type RexBlockEvent } from "../src/rex-events.ts";
import { tempEnv, writeExecutable } from "./helpers.ts";

const location = { endpoint: "unix:///tmp/rex.sock", hostId: "host-1" };
const programStatusLine = JSON.stringify({
	type: "session_event",
	payload: {
		session_id: "session:1",
		event: {
			type: "block_event",
			payload: {
				block_id: "block:1",
				creator_name: "com.superlogical.terminal",
				name: "program_status_changed",
				payload: {
					id: "",
					record: { state: "done", app: "pi", effective_app: "pi", msg: "event-probe" },
					reason: "report",
				},
			},
		},
	},
});

test("parseRexBlockEvent reads the real Rex session/block envelope", () => {
	assert.deepEqual(parseRexBlockEvent(programStatusLine), {
		sessionId: "session:1",
		blockId: "block:1",
		name: "program_status_changed",
		payload: {
			id: "",
			record: { state: "done", app: "pi", effective_app: "pi", msg: "event-probe" },
			reason: "report",
		},
	});
	assert.equal(parseRexBlockEvent("not json"), undefined);
	assert.equal(parseRexBlockEvent(JSON.stringify({ type: "server_event", payload: {} })), undefined);
});

test("watchRexEvents parses split NDJSON writes and closes the stream", async () => {
	const temp = tempEnv();
	const previousPath = process.env.PATH;
	try {
		const script = join(temp.dir, "fake-events.mjs");
		writeFileSync(
			script,
			`const line = ${JSON.stringify(programStatusLine)};\n` +
				`process.stdout.write(line.slice(0, 37));\n` +
				`setTimeout(() => process.stdout.write(line.slice(37) + "\\n"), 25);\n` +
				`setInterval(() => {}, 1000);\n`,
		);
		writeExecutable(
			join(temp.dir, "bin", "rex"),
			`#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`,
		);
		process.env.PATH = `${join(temp.dir, "bin")}:${previousPath ?? ""}`;
		const event = await new Promise<RexBlockEvent>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for a split Rex event")), 2000);
			const subscription = watchRexEvents(location, "session:1", {
				onEvent(value) {
					clearTimeout(timer);
					subscription.close();
					resolve(value);
				},
				onClose() {
					clearTimeout(timer);
					reject(new Error("Rex event stream closed before delivering its event"));
				},
			});
		});
		assert.equal(event.blockId, "block:1");
		assert.equal(event.name, "program_status_changed");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		temp.cleanup();
	}
});
