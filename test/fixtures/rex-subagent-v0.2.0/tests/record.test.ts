import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	accountingOwnerPath,
	claimRecordOwner,
	inboxIndexes,
	listRecords,
	parseRecord,
	parseStatus,
	queueMessage,
	readInboxMessage,
	readRecord,
	readStatus,
	removeRun,
	runDirFor,
	runsRoot,
	updateRecord,
	writeRecord,
	withInboxLock,
	InboxLockStolen,
	observeRun,
	type RunRecord,
} from "../src/record.ts";
import { tempEnv } from "./helpers.ts";

const exec = promisify(execFile);

const baseRecord: RunRecord = {
	version: 1,
	handle: "a1b2c3",
	name: "alpha",
	group: "subagents",
	cwd: "/tmp/project",
	prompt: "hello",
	launchArgs: [],
	rex: {
		endpoint: "unix:///tmp/rex.sock",
		hostId: "host-1",
		sessionId: "session:1",
		windowId: "window:1",
		blockId: "block:1",
	},
	state: "running",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

test("parseRecord rejects unusable records", () => {
	assert.equal(parseRecord(undefined), undefined);
	assert.equal(parseRecord({ version: 1 }), undefined);
	assert.equal(parseRecord({ ...baseRecord, version: 2 }), undefined);
	assert.equal(parseRecord({ ...baseRecord, state: "weird" }), undefined);
	assert.equal(parseRecord({ ...baseRecord, rex: { ...baseRecord.rex, endpoint: "" } }), undefined);
	// A running record must carry Rex resources.
	assert.equal(parseRecord({ ...baseRecord, rex: { ...baseRecord.rex, sessionId: "" } }), undefined);
	// Staged and failed records may not have them yet.
	const empty = { ...baseRecord.rex, sessionId: "", windowId: "", blockId: "" };
	assert.ok(parseRecord({ ...baseRecord, state: "failed", rex: empty }));
	assert.ok(parseRecord({ ...baseRecord, state: "starting", rex: empty }));
});

test("parseRecord keeps optional model fields", () => {
	const parsed = parseRecord({ ...baseRecord, provider: "xai", model: "grok", thinking: "high" });
	assert.equal(parsed?.provider, "xai");
	assert.equal(parsed?.model, "grok");
	assert.equal(parsed?.thinking, "high");
});

test("parseStatus validates shape", () => {
	assert.deepEqual(parseStatus({ state: "idle", turn: 2, lastExit: 0, updatedAt: "x" }), {
		state: "idle",
		turn: 2,
		lastExit: 0,
		updatedAt: "x",
	});
	// New children no longer write lastExit; old files that do must still parse.
	assert.deepEqual(parseStatus({ state: "busy", turn: 1, updatedAt: "x" }), {
		state: "busy",
		turn: 1,
		updatedAt: "x",
	});
	assert.equal(parseStatus({ state: "idle", turn: -1, lastExit: 0 }), undefined);
	assert.equal(parseStatus({ state: "nope", turn: 1, lastExit: 0 }), undefined);
	assert.equal(parseStatus({ state: "idle", turn: 1, lastExit: "0" }), undefined);
	assert.equal(parseStatus(undefined), undefined);
});

test("parseRecord keeps stopError for retried stops", () => {
	const parsed = parseRecord({ ...baseRecord, stopError: "rex kill failed: connection refused" });
	assert.equal(parsed?.stopError, "rex kill failed: connection refused");
	assert.equal(parseRecord({ ...baseRecord, stopError: "" })?.stopError, undefined);
});

test("writeRecord, updateRecord and listRecords round-trip", () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord, temp.env);
		assert.equal(readRecord(baseRecord.handle, temp.env)?.name, "alpha");
		updateRecord(baseRecord.handle, { state: "stopped" }, temp.env);
		assert.equal(readRecord(baseRecord.handle, temp.env)?.state, "stopped");
		writeRecord({ ...baseRecord, handle: "zzz999", name: "beta" }, temp.env);
		assert.deepEqual(
			listRecords(temp.env).map((entry) => entry.record.handle),
			["a1b2c3", "zzz999"],
		);
		removeRun(baseRecord.handle, temp.env);
		assert.equal(readRecord(baseRecord.handle, temp.env), undefined);
	} finally {
		temp.cleanup();
	}
});

test("listRecords skips a malformed directory instead of failing", () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord, temp.env);
		const broken = join(runsRoot(temp.env), "broken");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "metadata.json"), "{not json");
		assert.deepEqual(
			listRecords(temp.env).map((entry) => entry.record.handle),
			["a1b2c3"],
		);
	} finally {
		temp.cleanup();
	}
});

test("an ownership claim serialization failure publishes no partial file or temporary debris", () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord, temp.env);
		const path = accountingOwnerPath(baseRecord.handle, temp.env);
		const invalidOwner = {
			toJSON() {
				throw new Error("injected claim serialization failure");
			},
		} as unknown as string;
		assert.throws(
			() => claimRecordOwner(baseRecord.handle, invalidOwner, temp.env),
			/injected claim serialization failure/,
		);
		assert.equal(existsSync(path), false, "a failed claim must not leave an empty or partial owner file");
		assert.deepEqual(
			readdirSync(runDirFor(baseRecord.handle, temp.env)).filter((name) => name.includes(".accounting-owner.json.tmp-")),
			[],
		);
	} finally {
		temp.cleanup();
	}
});

test("concurrent ownership claims publish one complete winner without overwriting it", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord, temp.env);
		const recordModule = pathToFileURL(join(import.meta.dirname, "..", "src", "record.ts")).href;
		const script = [
			`import { claimRecordOwner } from ${JSON.stringify(recordModule)};`,
			"const won = claimRecordOwner(process.env.CLAIM_HANDLE, process.env.CLAIM_OWNER, process.env);",
			"process.stdout.write(JSON.stringify({ owner: process.env.CLAIM_OWNER, won }));",
		].join("\n");
		const claim = (owner: string) =>
			exec(process.execPath, ["--input-type=module", "-e", script], {
				cwd: process.cwd(),
				env: { ...temp.env, CLAIM_HANDLE: baseRecord.handle, CLAIM_OWNER: owner },
				timeout: 30_000,
			});
		const results = await Promise.all(Array.from({ length: 8 }, (_, index) => claim(`parent-${index}`)));
		const outcomes = results.map((entry) => JSON.parse(entry.stdout) as { owner: string; won: boolean });
		const winners = outcomes.filter((entry) => entry.won);
		assert.equal(winners.length, 1, JSON.stringify(outcomes));
		assert.equal(
			readRecord(baseRecord.handle, temp.env)?.parentSessionId,
			winners[0]?.owner,
		);
		assert.deepEqual(JSON.parse(readFileSync(accountingOwnerPath(baseRecord.handle, temp.env), "utf8")), {
			version: 1,
			parentSessionId: winners[0]?.owner,
		});
		assert.equal(claimRecordOwner(baseRecord.handle, "later-parent", temp.env), false);
		assert.equal(readRecord(baseRecord.handle, temp.env)?.parentSessionId, winners[0]?.owner);
		assert.deepEqual(
			readdirSync(runDirFor(baseRecord.handle, temp.env)).filter((name) => name.includes(".accounting-owner.json.tmp-")),
			[],
		);
	} finally {
		temp.cleanup();
	}
});

test("queueMessage numbers messages without clobbering", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		assert.equal(await queueMessage(dir, "first"), 1);
		assert.equal(await queueMessage(dir, "second"), 2);
		assert.deepEqual(inboxIndexes(dir), [1, 2]);
		assert.deepEqual(readInboxMessage(dir, 1), { message: "first", delivery: "auto" });
		assert.deepEqual(readInboxMessage(dir, 2), { message: "second", delivery: "auto" });
		assert.equal(await queueMessage(dir, "third", "steer"), 3);
		assert.deepEqual(inboxIndexes(dir), [1, 2, 3]);
		assert.deepEqual(readInboxMessage(dir, 3), { message: "third", delivery: "steer" });
		assert.equal(readInboxMessage(dir, 99), undefined);
	} finally {
		temp.cleanup();
	}
});

test("queueMessage keeps numbering monotonic after messages are consumed", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		await queueMessage(dir, "one");
		await queueMessage(dir, "two");
		// The child consumes both; the persisted sequence must keep counting up.
		rmSync(join(dir, "inbox", "0001.json"));
		rmSync(join(dir, "inbox", "0002.json"));
		assert.equal(await queueMessage(dir, "three"), 3);
	} finally {
		temp.cleanup();
	}
});

test("queueMessage assigns distinct indexes to concurrent senders in-process", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		const indexes = await Promise.all(Array.from({ length: 10 }, (_, i) => queueMessage(dir, `msg ${i}`)));
		assert.deepEqual([...indexes].sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i + 1));
		assert.deepEqual(inboxIndexes(dir), Array.from({ length: 10 }, (_, i) => i + 1));
	} finally {
		temp.cleanup();
	}
});

test("queueMessage survives a crashed lock holder by stealing it", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(join(dir, "inbox"), { recursive: true });
		const lock = join(dir, "inbox", ".lock");
		writeFileSync(lock, "99999\n");
		// Make the lock look abandoned.
		utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
		assert.equal(await queueMessage(dir, "after crash"), 1);
		assert.equal(readInboxMessage(dir, 1)?.message, "after crash");
	} finally {
		temp.cleanup();
	}
});

test("queueMessage refuses to wait forever behind a busy lock", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(join(dir, "inbox"), { recursive: true });
		writeFileSync(join(dir, "inbox", ".lock"), "99999\n"); // fresh, so not stealable
		await assert.rejects(() => queueMessage(dir, "nope", "auto", { lockWaitMs: 150 }), /inbox lock busy/);
		// Once the holder is gone, the message goes through.
		rmSync(join(dir, "inbox", ".lock"));
		assert.equal(await queueMessage(dir, "yes"), 1);
	} finally {
		temp.cleanup();
	}
});

test("queueMessage never loses a message across concurrent processes", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(join(dir, "inbox"), { recursive: true });
		const recordModule = pathToFileURL(join(import.meta.dirname, "..", "src", "record.ts")).href;
		const script = [
			`import { queueMessage } from ${JSON.stringify(recordModule)};`,
			"const dir = process.env.QUEUE_DIR;",
			"await Promise.all(Array.from({ length: 5 }, (_, i) => queueMessage(dir, `${process.pid}-${i}`)));",
		].join("\n");
		const run = () =>
			exec(
				process.execPath,
				["--input-type=module", "-e", script],
				{
					cwd: process.cwd(),
					env: { ...process.env, QUEUE_DIR: dir },
					timeout: 30_000,
				},
			);
		await Promise.all([run(), run(), run()]);
		const indexes = inboxIndexes(dir);
		assert.equal(indexes.length, 15, `expected 15 messages, got ${indexes.join(",")}`);
		// Every file holds a distinct message: nothing was overwritten.
		const messages = indexes.map((index) => readInboxMessage(dir, index)?.message);
		assert.equal(new Set(messages).size, 15);
	} finally {
		temp.cleanup();
	}
});

test("a lock holder never releases a successor's lock", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(join(dir, "inbox"), { recursive: true });
		const lockPath = join(dir, "inbox", ".lock");
		// The critical section simulates being stolen mid-flight: someone else
		// replaced the lock content. Our release must NOT delete that file.
		const value = await withInboxLock(
			() => {
				writeFileSync(lockPath, "successor-token\n");
				return 42;
			},
			dir,
			1000,
		);
		assert.equal(value, 42);
		assert.equal(readFileSync(lockPath, "utf8"), "successor-token\n", "the successor's lock must survive");
	} finally {
		temp.cleanup();
	}
});

test("a critical section that lost its lock restarts instead of publishing", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(join(dir, "inbox"), { recursive: true });
		let attempts = 0;
		const lockPath = join(dir, "inbox", ".lock");
		const index = await withInboxLock(
			(owns) => {
				attempts += 1;
				if (attempts === 1) {
					// Simulate a stale steal during the first attempt: a successor
					// took over and will release shortly after we yield.
					writeFileSync(lockPath, "successor-token\n");
					setTimeout(() => {
						try {
							rmSync(lockPath);
						} catch {
							// already gone
						}
					}, 30);
					assert.equal(owns(), false);
					throw new InboxLockStolen();
				}
				assert.equal(owns(), true);
				return 7;
			},
			dir,
			2000,
		);
		assert.equal(index, 7);
		assert.equal(attempts, 2, "the allocation must restart exactly once");
		assert.equal(existsSync(join(dir, "inbox", ".lock")), false, "the retry releases its own lock");
	} finally {
		temp.cleanup();
	}
});

test("a slow stale holder cannot break a successor's allocation", async () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(join(dir, "inbox"), { recursive: true });
		const recordModule = pathToFileURL(join(import.meta.dirname, "..", "src", "record.ts")).href;
		// Process A holds the lock and backdates it, so it looks crashed while
		// actually still working (the pathological slow-holder case).
		const holder = [
			`import { withInboxLock } from ${JSON.stringify(recordModule)};`,
			`import { utimesSync } from "node:fs";`,
			"const dir = process.env.QUEUE_DIR;",
			"await withInboxLock((_owns) => {",
			"  const lock = dir + '/inbox/.lock';",
			"  utimesSync(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));",
			"  const end = Date.now() + 250;",
			"  while (Date.now() < end) {}", // busy-wait: holder stays alive and stale
			"  return 0;",
			"}, dir, 5000);",
		].join("\n");
		const slow = exec(process.execPath, ["--input-type=module", "-e", holder], {
			cwd: process.cwd(),
			env: { ...process.env, QUEUE_DIR: dir },
			timeout: 15_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 60)); // let A acquire and go stale
		// B steals the stale lock and allocates while A is still busy-waiting.
		assert.equal(await queueMessage(dir, "from B"), 1);
		assert.deepEqual(readInboxMessage(dir, 1), { message: "from B", delivery: "auto" });
		await slow; // A finishes last: it must not disturb B's published message or lock
		assert.deepEqual(readInboxMessage(dir, 1), { message: "from B", delivery: "auto" });
		assert.equal(existsSync(join(dir, "inbox", ".lock")), false, "no lock file may leak");
		// The inbox still works normally afterwards.
		assert.equal(await queueMessage(dir, "from C"), 2);
	} finally {
		temp.cleanup();
	}
});

test("readStatus ignores a partially written file", () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "status.json"), '{"state":"busy","turn":1');
		assert.equal(readStatus(dir), undefined);
		writeFileSync(join(dir, "status.json"), '{"state":"busy","turn":1,"lastExit":null}');
		assert.equal(readStatus(dir)?.state, "busy");
	} finally {
		temp.cleanup();
	}
});

test("observeRun prefers a dead process over stale status claims", () => {
	const busy = { state: "busy" as const, turn: 1, updatedAt: "" };
	const idle = { state: "idle" as const, turn: 1, updatedAt: "" };
	assert.deepEqual(observeRun(baseRecord, busy, { state: "running" }), {
		state: "busy",
		processState: "running",
		processExitCode: null,
	});
	assert.deepEqual(observeRun(baseRecord, idle, { state: "running" }), {
		state: "idle",
		processState: "running",
		processExitCode: null,
	});
	// A dead process is terminal even when a stale status file still claims idle.
	assert.deepEqual(observeRun(baseRecord, idle, { state: "exited", exitCode: 7 }), {
		state: "exited",
		processState: "exited",
		processExitCode: 7,
	});
	// Missing status + dead process used to masquerade as idle; now it is exited.
	assert.equal(observeRun(baseRecord, undefined, { state: "exited", exitCode: 7 }).state, "exited");
	assert.equal(observeRun(baseRecord, undefined, { state: "exited", exitCode: 7 }).processExitCode, 7);
	assert.equal(observeRun(baseRecord, busy, { state: "exited" }).processExitCode, null);
	assert.deepEqual(observeRun(baseRecord, undefined, { state: "missing" }), {
		state: "gone",
		processState: "gone",
		processExitCode: null,
	});
	assert.equal(observeRun({ ...baseRecord, state: "failed" }, undefined, { state: "missing" }).state, "failed");
	assert.equal(observeRun({ ...baseRecord, state: "starting" }, undefined, { state: "unknown" }).state, "starting");
	assert.equal(observeRun(baseRecord, undefined, { state: "unknown" }).state, "unknown");
	assert.equal(observeRun(baseRecord, busy, { state: "unknown" }).state, "busy");
	// A confirmed stop stays stopped even though its window no longer exists.
	assert.equal(observeRun({ ...baseRecord, state: "stopped" }, undefined, { state: "missing" }).state, "stopped");
	// A child that only saw the sentinel is NOT stopped while its process lives;
	// and once the process ends, it counts as a completed stop with the real code.
	assert.equal(observeRun(baseRecord, { state: "stopped" as const, turn: 1, updatedAt: "" }, { state: "running" }).state, "stopping");
	// Even when Rex cannot be probed at all, the child's acknowledged stop must
	// surface as stopping — the inbox is already being wound down.
	assert.deepEqual(observeRun(baseRecord, { state: "stopped" as const, turn: 1, updatedAt: "" }, { state: "unknown" }), {
		state: "stopping",
		processState: "unknown",
		processExitCode: null,
	});
	assert.deepEqual(observeRun(baseRecord, { state: "stopped" as const, turn: 1, updatedAt: "" }, { state: "exited", exitCode: 0 }), {
		state: "stopped",
		processState: "exited",
		processExitCode: 0,
	});
});

test("observeRun without a probe trusts local state only", () => {
	// No probe: a running record without any status is still booting, not idle.
	assert.deepEqual(observeRun(baseRecord, undefined, undefined), {
		state: "starting",
		processState: "unknown",
		processExitCode: null,
	});
	assert.equal(observeRun({ ...baseRecord, state: "stopped" }, undefined, undefined).state, "stopped");
	assert.equal(observeRun({ ...baseRecord, state: "exited" }, undefined, undefined).state, "exited");
	assert.equal(observeRun(baseRecord, { state: "busy" as const, turn: 1, updatedAt: "" }, undefined).state, "busy");
});

test("claimRecordOwner claims once and never overwrites an existing claim", () => {
	const temp = tempEnv();
	try {
		writeRecord({ ...baseRecord, parentSessionId: undefined }, temp.env);
		claimRecordOwner(baseRecord.handle, "parent-1", temp.env);
		assert.equal(readRecord(baseRecord.handle, temp.env)?.parentSessionId, "parent-1");
		// A second claim for another parent is a no-op: the first durable claim
		// wins, so the caller's re-read is what detects the lost race.
		claimRecordOwner(baseRecord.handle, "parent-2", temp.env);
		assert.equal(readRecord(baseRecord.handle, temp.env)?.parentSessionId, "parent-1");
		assert.deepEqual(JSON.parse(readFileSync(join(runDirFor(baseRecord.handle, temp.env), ".accounting-owner.json"), "utf8")), {
			version: 1,
			parentSessionId: "parent-1",
		});
	} finally {
		temp.cleanup();
	}
});
