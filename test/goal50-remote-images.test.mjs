/**
 * Issue #50: remote-image Objective materialization, end to end.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package,
 * the scripted provider, and a process-local HTTPS fixture. No test resolves or
 * connects to a public network destination.
 *
 * The fixture's exact loopback origin is opted into through the test-only
 * `PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS` seam, the spawned Pi trusts the committed
 * fixture CA through `NODE_EXTRA_CA_CERTS`, and `PI_GOAL_TEST_REMOTE_IMAGE_DNS`
 * supplies a deterministic resolver stub: no test depends on `/etc/hosts` or a
 * host resolver, and no test can reach a public destination. The production
 * policy is still exercised: every non-opted origin, DNS result, and redirect
 * target is refused before a connection, and the refusal tests assert the
 * fixture received no request at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	PiRpcSession,
	assertCleanRun,
	assertOnlyFailures,
	assertStepsConsumed,
	continuationEntries,
	goalSnapshots,
	lastGoalSnapshot,
	readSessionEntries,
	runCount,
	script,
	submitCommand,
} from "./helpers/rpc-harness.mjs";
import {
	FIXTURE_CA,
	PNG_B64,
	REMOTE_IMAGE_DNS_STUB_JSON,
	RemoteImageFixture,
} from "./helpers/remote-image-fixture.mjs";
import { attachmentStoreRoot, storedGoalIds } from "../src/attachments.ts";

const OBJECTIVE = "Ship the release from the explicitly attached remote image";
const EVENTS_PEER = new URL("./extensions/events-peer.ts", import.meta.url).pathname;
const EVENTS_LOG_TYPE = "goal-events-log";

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sharedDirs() {
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-goal-remote-sessions-"));
	const workDir = mkdtempSync(join(tmpdir(), "pi-goal-remote-work-"));
	return { sessionDir, workDir };
}

function cleanupDirs(dirs) {
	rmSync(dirs.sessionDir, { recursive: true, force: true });
	rmSync(dirs.workDir, { recursive: true, force: true });
}

/** Start a real Pi session with the fixture trust, origin opt-in, and DNS stub. */
function startSession(dirs, fixture, options = {}) {
	return PiRpcSession.start({
		sessionDir: dirs.sessionDir,
		cwd: dirs.workDir,
		...options,
		env: {
			NODE_EXTRA_CA_CERTS: FIXTURE_CA,
			PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS: fixture.origin,
			PI_GOAL_TEST_REMOTE_IMAGE_DNS: REMOTE_IMAGE_DNS_STUB_JSON,
			...options.env,
		},
		extraExtensions: [EVENTS_PEER, ...(options.extraExtensions ?? [])],
	});
}

async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((record) => record.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

/** Abort after `runs` new agent runs started after `mark` (clone-safe). */
async function abortNewRuns(session, mark, runs) {
	await session.waitFor(`${runs} new agent runs started after mark`, (records) =>
		records.slice(mark).filter((record) => record.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

function eventLog(entries) {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === EVENTS_LOG_TYPE);
}

function kickoffEntry(entries) {
	const entry = [...entries]
		.reverse()
		.find((candidate) => candidate.type === "message" && candidate.message?.role === "user" && Array.isArray(candidate.message?.content));
	assert.ok(entry, "the kickoff is a content-array user message");
	return entry.message;
}

function imageBlocks(message) {
	return message.content.filter((block) => block.type === "image");
}

/** Create and pause a Goal, so its own lifecycle needs no in-flight continuation loop. */
async function createPausedGoal(session) {
	await session.prompt(`/goal ${OBJECTIVE}`);
	await session.waitForNotify((record) => record.message.includes("created and activated"));
	await abortActiveLoop(session, 2);
	await session.prompt("/goal:pause");
	await session.waitForNotify((record) => record.message.includes("paused"));
}

/**
 * Create a Goal and let it complete.
 *
 * One session works one Goal at a time (ADR-0003), so a complete Goal is the only
 * state a `/goal <objective>` creation can supersede. The caller scripts the
 * kickoff, the completing turn, and its wrap-up response.
 */
async function createCompleteGoal(session) {
	await session.prompt(`/goal ${OBJECTIVE}`);
	await session.waitForNotify((record) => record.message.includes("created and activated"));
	await session.waitForSettled(1);
	const entries = readSessionEntries(await session.sessionFile());
	assert.equal(lastGoalSnapshot(entries).data.goal.status, "complete", "the first Goal finished");
}

function toolResults(session, toolName) {
	return session.records.filter((record) => record.type === "tool_execution_end" && record.toolName === toolName);
}

function structuredGoal(result) {
	return result.structuredContent?.goal ?? result.details?.goal;
}

test("a remote image is fetched once, materialized as the immutable artifact, and reused across Continuations and a restart", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const secretValue = "do-not-persist-this-value";
	const remoteUrl = `${fixture.url("/png")}?token=${secretValue}`;
	const first = await startSession(dirs, fixture);
	script(
		[
			{ text: "Kickoff with the remote image.", usage: { input: 40, output: 10 } },
			{ text: "Continuing with the same remote artifact.", usage: { input: 20, output: 5 } },
			{ hang: true },
		],
		first,
	);
	let sessionFile;
	try {
		const firstMark = first.records.length;
		await first.prompt(`/goal --remote-image ${remoteUrl} ${OBJECTIVE}`);
		await abortNewRuns(first, firstMark, 3);
		sessionFile = await first.sessionFile();
		const entries = readSessionEntries(sessionFile);
		const creation = goalSnapshots(entries)[0];
		const manifest = creation.data.goal.attachments;

		// Hash, media type, byte size, and a display label derived from the URL
		// basename. The URL and its query are nowhere in the durable manifest.
		assert.deepEqual(manifest, [
			{
				hash: sha256(Buffer.from(PNG_B64, "base64")),
				mediaType: "image/png",
				bytes: Buffer.from(PNG_B64, "base64").length,
				label: "png",
			},
		]);
		assert.deepEqual(Object.keys(manifest[0]).sort(), ["bytes", "hash", "label", "mediaType"]);
		assert.ok(!JSON.stringify(creation).includes(secretValue), "the URL query is not persisted");
		assert.ok(!JSON.stringify(creation).includes(fixture.origin), "the source origin is not persisted");
		const durableText = readFileSync(sessionFile, "utf8");
		assert.ok(!durableText.includes(secretValue), "no durable session entry leaks the URL query");
		assert.ok(!durableText.includes(fixture.origin), "no durable session entry leaks the source origin");

		// The immutable artifact is the fetched content, in the same Goal-keyed store.
		const root = attachmentStoreRoot(sessionFile);
		const goalDir = join(root, creation.data.goal.id);
		assert.deepEqual(readdirSync(goalDir), [`${manifest[0].hash}.png`]);
		assert.deepEqual(readFileSync(join(goalDir, `${manifest[0].hash}.png`)), Buffer.from(PNG_B64, "base64"));

		// The kickoff and Continuation send the image content and name the same hash.
		const kickoff = kickoffEntry(entries);
		assert.deepEqual(
			imageBlocks(kickoff).map((block) => [block.mimeType, block.data]),
			[["image/png", PNG_B64]],
		);
		assert.ok(kickoff.content.find((block) => block.type === "text").text.includes(`sha256 ${manifest[0].hash}`));
		const continuation = continuationEntries(entries).at(-1);
		const continuationText = continuation.content.find((block) => block.type === "text").text;
		assert.ok(continuationText.includes(`sha256 ${manifest[0].hash}`));
		assert.deepEqual(
			imageBlocks(continuation).map((block) => block.data),
			[PNG_B64],
		);

		// Fetch-once: one and only one request, with no credentials, cookies, or referrer.
		assert.equal(fixture.count("/png"), 1, "the remote image was fetched exactly once");
		const request = fixture.requests.find((entry) => entry.url.startsWith("/png"));
		assert.ok(request, "the fixture saw the successful request");
		assert.equal(request.headers.authorization, undefined);
		assert.equal(request.headers.cookie, undefined);
		assert.equal(request.headers.referer, undefined);
		assert.equal(request.headers.accept, "image/png,image/jpeg,image/gif,image/webp");

		// Events carry the manifest metadata only.
		const created = eventLog(entries).find((entry) => entry.data.kind === "created").data;
		assert.deepEqual(created.goal.attachments, manifest);
		assert.ok(!JSON.stringify(created).includes(secretValue));
		assert.ok(!JSON.stringify(created).includes(PNG_B64));

		assertStepsConsumed(first, 3, [{ stopReason: "aborted" }]);
		assertOnlyFailures(first, [{ stopReason: "aborted" }]);
		assert.equal(first.extensionErrors().length, 0, JSON.stringify(first.extensionErrors()));
	} finally {
		await first.stop();
	}

	const second = await startSession(dirs, fixture, { sessionFile });
	script(
		[
			{ text: "Ordinary answer after restart.", usage: { input: 20, output: 5 } },
			{ text: "Continued after restart.", usage: { input: 20, output: 5 } },
			{ hang: true },
		],
		second,
	);
	try {
		await second.waitForNotify((record) => record.message.includes("restored (active)"));
		const restartMark = second.records.length;
		await second.prompt("an ordinary prompt after the restart");
		await abortNewRuns(second, restartMark, 3);
		const manifest = goalSnapshots(readSessionEntries(sessionFile))[0].data.goal.attachments;
		const continuation = continuationEntries(readSessionEntries(sessionFile)).at(-1);
		const text = continuation.content.find((block) => block.type === "text").text;
		assert.ok(text.includes(`sha256 ${manifest[0].hash}`), "the restart keeps the same remote-image hash");
		assert.deepEqual(imageBlocks(continuation).map((block) => block.data), [PNG_B64]);
		assert.equal(fixture.count("/png"), 1, "the restart never refetches the source URL");

		// A clone is a selected branch copy in the same session directory: its own
		// snapshot references the same manifest and still never refetches.
		const clone = await second.sendSimple("clone");
		assert.deepEqual(clone, { cancelled: false });
		const clonedFile = (await second.getState()).sessionFile;
		assert.notEqual(clonedFile, sessionFile);
		script(
			[
				{ text: "Clone answer.", usage: { input: 20, output: 5 } },
				{ text: "Clone continuation.", usage: { input: 20, output: 5 } },
				{ hang: true },
			],
			second,
		);
		const cloneMark = second.records.length;
		await second.prompt("continue in the clone");
		await abortNewRuns(second, cloneMark, 3);
		const clonedContinuation = continuationEntries(readSessionEntries(clonedFile)).at(-1);
		const clonedText = clonedContinuation.content.find((block) => block.type === "text").text;
		assert.ok(clonedText.includes(`sha256 ${manifest[0].hash}`), "the copied branch keeps the same hash");
		assert.deepEqual(imageBlocks(clonedContinuation).map((block) => block.data), [PNG_B64]);
		assert.equal(fixture.count("/png"), 1, "clone and continuation still never refetch");

		assertStepsConsumed(second, 6, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
		assertOnlyFailures(second, [{ stopReason: "aborted" }, { stopReason: "aborted" }]);
		assert.equal(second.extensionErrors().length, 0, JSON.stringify(second.extensionErrors()));
	} finally {
		await second.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("only HTTPS, public destinations, and revalidated redirects are fetched", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture);
	script([{ text: "Ordinary answer.", usage: { input: 10, output: 2 } }], session);
	try {
		const refusals = [
			// The local --image flag never fetches a URL.
			{
				args: `--image ${fixture.url("/png")}`,
				match: /accepts a local file path, not a URL/,
			},
			{
				args: "--remote-image http://127.0.0.1:1/image.png",
				match: /must use HTTPS/,
			},
			{
				args: "--remote-image https://user:not-a-real-secret@127.0.0.1:1/image.png",
				match: /must not include credentials/,
			},
			{
				args: "--remote-image https://127.0.0.1:9/image.png",
				match: /loopback, link-local, or private-network/,
			},
			{
				args: "--remote-image https://10.1.2.3/image.png",
				match: /loopback, link-local, or private-network/,
			},
			{
				args: "--remote-image https://192.168.1.5/image.png",
				match: /loopback, link-local, or private-network/,
			},
			{
				args: "--remote-image https://169.254.169.254/latest/meta-data/",
				match: /loopback, link-local, or private-network/,
			},
			{
				args: "--remote-image https://[::1]:9/image.png",
				match: /loopback, link-local, or private-network/,
			},
			{
				// The deterministic resolver stub maps this reserved name to loopback;
				// the refusal never depends on the host's `/etc/hosts` or resolver.
				args: `--remote-image https://loopback.remote-image.test:${new URL(fixture.origin).port}/png`,
				match: /loopback, link-local, or private-network/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-loop")}`,
				match: /redirected more than 3 times/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-missing")}`,
				match: /without a Location header/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-http")}`,
				match: /must use HTTPS/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-credentials")}`,
				match: /must not include credentials/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-private")}`,
				match: /loopback, link-local, or private-network/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-linklocal")}`,
				match: /loopback, link-local, or private-network/,
			},
			{
				args: `--remote-image ${fixture.url("/redirect-loopback-name")}`,
				match: /loopback, link-local, or private-network/,
			},
			{
				args: `--remote-image ${fixture.url("/status/500")}`,
				match: /returned HTTP 500/,
			},
		];
		for (const refusal of refusals) {
			const mark = session.records.length;
			const response = await session.prompt(`/goal ${refusal.args} ${OBJECTIVE}`);
			assert.equal(response.data.disposition, "handled");
			const notice = await session.notifyAfter(mark, (record) => record.message.includes("Goal not created:"));
			assert.match(notice.message, refusal.match);
		}

		// No refused request ever reached a forbidden destination: the fixture only
		// saw the initial allowed-origin request of each redirect scenario.
		assert.equal(fixture.count("/png"), 0);
		assert.equal(fixture.countExact("/redirect-loop"), 4, "at most three redirects are followed");
		assert.equal(fixture.count("/redirect-http"), 1);
		assert.equal(fixture.count("/redirect-credentials"), 1);
		assert.equal(fixture.count("/redirect-private"), 1);
		assert.equal(fixture.count("/redirect-linklocal"), 1);
		assert.equal(fixture.count("/redirect-loopback-name"), 1);
		assert.equal(fixture.count("/redirect-missing"), 1);
		assert.equal(fixture.count("/status/500"), 1);

		const sessionFile = await session.sessionFile();
		assert.ok(!existsSync(sessionFile), "the refusals wrote no session entry at all");
		assert.ok(!existsSync(attachmentStoreRoot(sessionFile)), "no refusal materialized anything");
		assert.equal(runCount(session), 0, "no refusal started a Goal run");
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));

		// A real three-redirect chain succeeds, proving the allowed boundary.
		script([{ text: "Kickoff after redirects.", usage: { input: 20, output: 5 } }, { hang: true }], session);
		await session.prompt(`/goal --remote-image ${fixture.url("/redirect-chain/3")} ${OBJECTIVE}`);
		await abortActiveLoop(session, 2);
		const entries = readSessionEntries(sessionFile);
		assert.equal(goalSnapshots(entries).length, 1, "the only committed Goal is the successful chain");
		assert.deepEqual(eventLog(entries).map((entry) => entry.data.kind), ["created"]);
		const manifest = goalSnapshots(entries)[0].data.goal.attachments;
		assert.equal(manifest[0].hash, sha256(Buffer.from(PNG_B64, "base64")));
		assert.equal(manifest[0].mediaType, "image/png");
		assert.equal(fixture.count("/redirect-chain/0"), 1, "the final redirect target was fetched exactly once");
		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
	} finally {
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("the bytes, not the URL, decide the media type; SVG, unknown, empty, and oversized content are refused", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture);
	script([{ text: "Kickoff.", usage: { input: 20, output: 5 } }, { hang: true }], session);
	try {
		for (const [path, match] of [
			["/svg", /not a recognized image/],
			["/unknown", /not a recognized image/],
			["/empty", /is empty/],
			["/size/10485761", /above the .* fetch limit/],
			["/chunked/10485761", /larger than the .* fetch limit/],
		]) {
			const mark = session.records.length;
			const response = await session.prompt(`/goal --remote-image ${fixture.url(path)} ${OBJECTIVE}`);
			assert.equal(response.data.disposition, "handled");
			const notice = await session.notifyAfter(mark, (record) => record.message.includes("Goal not created:"));
			assert.match(notice.message, match);
		}
		const sessionFile = await session.sessionFile();
		assert.ok(!existsSync(sessionFile), "the refusals wrote no session entry at all");
		assert.ok(!existsSync(attachmentStoreRoot(sessionFile)), "no refused content materialized");
		assert.equal(runCount(session), 0);
		assertCleanRun(session);

		// A .jpg URL serving PNG bytes is accepted as PNG: the bytes decide.
		await session.prompt(`/goal --remote-image ${fixture.url("/mismatch.jpg")} ${OBJECTIVE}`);
		await abortActiveLoop(session, 2);
		const entries = readSessionEntries(sessionFile);
		assert.equal(goalSnapshots(entries).length, 1, "the only committed Goal is the byte-validated image");
		assert.deepEqual(eventLog(entries).map((entry) => entry.data.kind), ["created"]);
		const manifest = goalSnapshots(entries)[0].data.goal.attachments;
		assert.equal(manifest[0].mediaType, "image/png");
		assert.equal(manifest[0].label, "mismatch.jpg");
		assert.match(readdirSync(join(attachmentStoreRoot(sessionFile), goalSnapshots(entries)[0].data.goal.id))[0], /\.png$/);
		const kickoff = kickoffEntry(entries);
		assert.deepEqual(imageBlocks(kickoff).map((block) => block.mimeType), ["image/png"]);
		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("fetch timeout covers both a stalled response and a stalled body, and writes nothing", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture, {
		env: { PI_GOAL_TEST_REMOTE_IMAGE_TIMEOUT_MS: "400" },
	});
	script([{ text: "Ordinary answer.", usage: { input: 10, output: 2 } }], session);
	try {
		for (const path of ["/slow", "/partial"]) {
			const mark = session.records.length;
			const started = Date.now();
			const response = await session.prompt(`/goal --remote-image ${fixture.url(path)} ${OBJECTIVE}`);
			assert.equal(response.data.disposition, "handled");
			const notice = await session.notifyAfter(mark, (record) => record.message.includes("Goal not created:"));
			assert.match(notice.message, /timed out/);
			assert.ok(Date.now() - started < 5_000, "the configured deadline bounds the command");
		}
		// Create the session file with one ordinary run, then prove no timeout left
		// a Goal or artifact behind.
		await session.prompt("an ordinary prompt");
		await session.waitForSettled(1);
		const sessionFile = await session.sessionFile();
		assert.equal(goalSnapshots(readSessionEntries(sessionFile)).length, 0);
		assert.ok(!existsSync(attachmentStoreRoot(sessionFile)), "a timed-out fetch materialized nothing");
		assert.equal(runCount(session), 1, "only the ordinary prompt ran");
		assertStepsConsumed(session, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("a failed remote replacement leaves the previous Goal untouched and retracts never-committed bytes", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const spec = join(dirs.workDir, "spec.md");
	writeFileSync(spec, "local supporting material", "utf8");
	const session = await startSession(dirs, fixture);
	// The first Goal completes, so each failed creation below is a real attempt at
	// superseding it rather than the unfinished-Goal refusal.
	script(
		[
			{ text: "Kickoff.", usage: { input: 30, output: 8 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	let sessionFile;
	try {
		await session.prompt(`/goal --file ${spec} ${OBJECTIVE}`);
		await session.waitForSettled(1);
		sessionFile = await session.sessionFile();
		const root = attachmentStoreRoot(sessionFile);
		const before = readSessionEntries(sessionFile);
		const first = goalSnapshots(before)[0].data.goal;
		const baseline = goalSnapshots(before).at(-1).data.goal;
		const snapshotCount = goalSnapshots(before).length;
		assert.equal(baseline.status, "complete", "the first Goal finished before the failed attempts");

		// A failed fetch refuses the replacement before anything is written.
		let mark = session.records.length;
		let failedPromise = session.prompt(`/goal --remote-image ${fixture.url("/status/500")} Third objective`);
		await failedPromise;
		let notice = await session.notifyAfter(mark, (record) => record.message.includes("Goal not created:"));
		assert.match(notice.message, /returned HTTP 500/);

		// A successful fetch whose bytes fail image validation also writes nothing.
		mark = session.records.length;
		failedPromise = session.prompt(`/goal --remote-image ${fixture.url("/svg")} Fourth objective`);
		await failedPromise;
		notice = await session.notifyAfter(mark, (record) => record.message.includes("Goal not created:"));
		assert.match(notice.message, /not a recognized image/);

		// A successful fetch and materialization whose snapshot write then fails
		// retracts only the never-committed identity and keeps the previous Goal.
		chmodSync(sessionFile, 0o444);
		try {
			mark = session.records.length;
			failedPromise = session.prompt(`/goal --remote-image ${fixture.url("/png")} Fifth objective`);
			await failedPromise;
			notice = await session.notifyAfter(mark, (record) =>
				record.message.includes("writing the replacement to the session failed"),
			);
			assert.match(notice.message, /The current Goal is unchanged/);
		} finally {
			chmodSync(sessionFile, 0o644);
		}

		// A successful fetch whose artifact-store write fails is also refused
		// without touching the previous Goal or leaving a partial directory.
		const rootMode = 0o755;
		chmodSync(root, 0o555);
		try {
			mark = session.records.length;
			failedPromise = session.prompt(`/goal --remote-image ${fixture.url("/png")} Sixth objective`);
			await failedPromise;
			notice = await session.notifyAfter(mark, (record) => record.message.includes("Goal not created:"));
			assert.match(notice.message, /attachment store could not be written/);
		} finally {
			chmodSync(root, rootMode);
		}

		const after = readSessionEntries(sessionFile);
		assert.equal(goalSnapshots(after).length, snapshotCount, "no failed replacement appended a snapshot");
		const latest = goalSnapshots(after).at(-1).data.goal;
		assert.equal(latest.id, first.id);
		assert.equal(latest.revision, baseline.revision);
		assert.deepEqual(latest.attachments, baseline.attachments);
		assert.deepEqual(storedGoalIds(root), [first.id], "the uncommitted remote artifact was retracted");
		assert.equal(runCount(session), 2, "no failed replacement started a kickoff");
		assert.deepEqual(
			eventLog(after).map((entry) => entry.data.kind),
			["created", "completed"],
			"no success event for a failure",
		);
		assert.equal(fixture.count("/png"), 2, "the snapshot and store failures each followed one successful fetch");

		assertStepsConsumed(session, 3);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		if (sessionFile) chmodSync(sessionFile, 0o644);
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("a clear during a stalled remote-image fetch wins over the in-flight creation", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture);
	// Kickoff, the completing turn, and its wrap-up: the creation below supersedes a
	// complete Goal, the only creation the single-Goal rule allows (ADR-0003).
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 20, output: 5 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await createCompleteGoal(session);
		const sessionFile = await session.sessionFile();
		const mark = session.records.length;
		const replacePromise = submitCommand(
			session,
			"create-while-fetching",
			`/goal --remote-image ${fixture.url("/hold")} A replacement objective`,
		);
		await fixture.waitForRequest("/hold");

		// The fetch is stalled here. Clear runs in a second prompt while the first
		// command still awaits the body, so the tombstone is durable before the
		// creation revalidates its captured record.
		const cleared = await session.prompt("/goal:clear");
		assert.equal(cleared.data.disposition, "handled");
		await session.waitForNotify((record) => record.message.includes("cleared"));

		fixture.releaseHeld();
		await replacePromise;

		const cancelled = await session.notifyAfter(mark, (record) =>
			record.message.includes("Goal not created: the Goal changed while the remote image was being fetched"),
		);
		assert.equal(cancelled.notifyType, "warning");
		assert.match(cancelled.message, /no Goal is set anymore/);
		assert.match(cancelled.message, /Nothing was replaced/);
		assert.match(cancelled.message, /fetched artifact was retracted/);

		const entries = readSessionEntries(sessionFile);
		assert.equal(lastGoalSnapshot(entries).data.goal, null, "the clear tombstone remains last");
		assert.ok(
			goalSnapshots(entries).every((snapshot) => snapshot.data.goal?.objective !== "A replacement objective"),
			"the stale command did not resurrect a Goal after the clear",
		);
		assert.deepEqual(
			eventLog(entries).map((entry) => entry.data.kind),
			["created", "completed", "cleared"],
			"the cancelled command emitted no success event",
		);
		assert.deepEqual(
			storedGoalIds(attachmentStoreRoot(sessionFile)),
			[],
			"the never-committed fetch was retracted",
		);
		assert.equal(fixture.countExact("/hold"), 1, "the fetch was not repeated");

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		fixture.releaseHeld();
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("a title edit during a stalled remote-image fetch cancels the stale creation and retracts its artifact", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture);
	// The first Goal completes, so the creation below may supersede it; a title is a
	// label, so `/goal:edit --title` is admitted for that complete Goal and advances
	// its revision — a real change to the record the stalled creation captured.
	script(
		[
			{ text: "Kickoff answer.", usage: { input: 20, output: 5 } },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "Done." },
		],
		session,
	);
	try {
		await createCompleteGoal(session);
		const sessionFile = await session.sessionFile();
		const root = attachmentStoreRoot(sessionFile);
		const completed = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
		assert.equal(completed.status, "complete");
		assert.equal(completed.revision, 1);

		const mark = session.records.length;
		const createPromise = submitCommand(
			session,
			"create-while-title-editing",
			`/goal --remote-image ${fixture.url("/hold")} A replacement objective`,
		);
		await fixture.waitForRequest("/hold");

		// The title edit lands while the fetch is stalled: the captured record changes
		// under the command, so it must not commit the creation against the old one.
		const edited = await session.prompt('/goal:edit --title "Renamed while fetching"');
		assert.equal(edited.data.disposition, "handled");
		const editNotice = await session.notifyAfter(mark, (record) => record.message.includes("title set to"));
		assert.match(editNotice.message, /revision 2/);
		const editedGoal = lastGoalSnapshot(readSessionEntries(sessionFile)).data.goal;
		assert.equal(editedGoal.id, completed.id, "the title edit kept the Goal identity");
		assert.equal(editedGoal.title, "Renamed while fetching");
		assert.equal(editedGoal.status, "complete");
		assert.equal(editedGoal.revision, 2);
		assert.equal(
			session.records.filter((record) => record.type === "extension_ui_request" && record.method === "confirm").length,
			0,
			"superseding a complete Goal asks for no confirmation",
		);

		fixture.releaseHeld();
		await createPromise;

		const cancelled = await session.notifyAfter(mark, (record) =>
			record.message.includes("Goal not created: the Goal changed while the remote image was being fetched"),
		);
		assert.equal(cancelled.notifyType, "warning");
		assert.match(cancelled.message, /now complete, revision 2/);
		assert.match(cancelled.message, /Nothing was replaced/);
		assert.match(cancelled.message, /fetched artifact was retracted/);

		const entries = readSessionEntries(sessionFile);
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.id, completed.id, "the edited Goal is still the current record");
		assert.equal(goal.title, "Renamed while fetching", "the edit is preserved, not rolled back");
		assert.equal(goal.status, "complete");
		assert.equal(goal.revision, 2);
		assert.ok(
			goalSnapshots(entries).every((snapshot) => snapshot.data.goal?.objective !== "A replacement objective"),
			"the stale creation committed no new identity",
		);
		assert.deepEqual(
			eventLog(entries).map((entry) => entry.data.kind),
			["created", "completed", "objective-edited"],
			"the cancelled creation emitted no success event",
		);
		assert.deepEqual(
			storedGoalIds(root),
			[],
			"the never-committed fetch was retracted despite the successful edit",
		);
		assert.equal(fixture.countExact("/hold"), 1, "the fetch was not repeated");

		assertStepsConsumed(session, 3);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		fixture.releaseHeld();
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("a create_goal tool call during a stalled remote-image fetch wins over the stale command", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture);
	const REQUEST = "please create a goal for the release";
	const TOOL_OBJECTIVE = "Ship the tool-created objective";
	script(
		[
			{
				toolCalls: [{ name: "create_goal", args: { objective: TOOL_OBJECTIVE, userRequest: REQUEST } }],
				usage: { input: 30, output: 8 },
			},
			{ text: "Created from the model.", usage: { input: 10, output: 2 } },
			{ hang: true },
		],
		session,
	);
	try {
		const mark = session.records.length;
		const stalledPromise = submitCommand(
			session,
			"create-while-fetching",
			`/goal --remote-image ${fixture.url("/hold")} ${OBJECTIVE}`,
		);
		await fixture.waitForRequest("/hold");

		// A model tool call mutates the single Goal slot without taking the
		// create lock; the stalled command must see it and cancel.
		await session.prompt(REQUEST);
		await session.waitForToolResult("create_goal", 1);
		const created = toolResults(session, "create_goal")[0];
		assert.equal(created.isError, false, JSON.stringify(created));
		const toolGoal = structuredGoal(created.result);
		assert.equal(toolGoal.origin, "tool");
		assert.equal(toolGoal.objective, TOOL_OBJECTIVE);

		fixture.releaseHeld();
		await stalledPromise;

		const cancelled = await session.notifyAfter(mark, (record) =>
			record.message.includes("Goal not created: the Goal changed while the remote image was being fetched"),
		);
		assert.equal(cancelled.notifyType, "warning");
		assert.match(cancelled.message, /now active, revision 0/);
		assert.match(cancelled.message, /Nothing was replaced/);

		const sessionFile = await session.sessionFile();
		const entries = readSessionEntries(sessionFile);
		const goal = lastGoalSnapshot(entries).data.goal;
		assert.equal(goal.id, toolGoal.id, "the tool-created Goal is the only current Goal");
		assert.equal(goal.objective, TOOL_OBJECTIVE);
		assert.equal(goalSnapshots(entries).length, 1, "only the tool-created snapshot is durable");
		assert.ok(
			goalSnapshots(entries).every((snapshot) => snapshot.data.goal?.objective !== OBJECTIVE),
			"the stale command created nothing",
		);
		assert.deepEqual(
			eventLog(entries).map((entry) => [entry.data.kind, entry.data.goal?.id]),
			[["created", toolGoal.id]],
			"the cancelled command emitted no success event",
		);
		assert.deepEqual(
			storedGoalIds(attachmentStoreRoot(sessionFile)),
			[],
			"the never-committed fetch was retracted",
		);
		assert.equal(fixture.countExact("/hold"), 1, "the fetch was not repeated");

		await abortNewRuns(session, mark, 2);
		assertStepsConsumed(session, 3, [{ stopReason: "aborted" }]);
		assertOnlyFailures(session, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		fixture.releaseHeld();
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});

test("disabled admission refuses a remote-image creation before any fetch or materialization", async () => {
	const fixture = await RemoteImageFixture.start();
	const dirs = sharedDirs();
	const session = await startSession(dirs, fixture, { settings: { goal: { enabled: false } } });
	script([{ text: "Ordinary work.", usage: { input: 10, output: 2 } }], session);
	try {
		const refused = await session.prompt(`/goal --remote-image ${fixture.url("/png")} ${OBJECTIVE}`);
		assert.equal(refused.data.disposition, "handled");
		const refusal = await session.waitForNotify((record) => /disabled/.test(record.message));
		assert.match(refusal.message, /Goal not created: pi-goal is disabled \(goal\.enabled is false\)/);

		// Ordinary work still runs; the fixture proves no fetch was attempted.
		await session.prompt("an ordinary prompt");
		await session.waitForSettled(1);
		const sessionFile = await session.sessionFile();
		const entries = readSessionEntries(sessionFile);
		assert.equal(goalSnapshots(entries).length, 0);
		assert.ok(!existsSync(attachmentStoreRoot(sessionFile)), "disabled admission materialized nothing");
		assert.equal(runCount(session), 1, "the ordinary prompt is the only run");
		assert.equal(fixture.requests.length, 0, "disabled admission performed no network request");
		assert.deepEqual(eventLog(entries).map((entry) => entry.data.kind), []);

		assertStepsConsumed(session, 1);
		assertCleanRun(session);
		assert.equal(session.extensionErrors().length, 0, JSON.stringify(session.extensionErrors()));
	} finally {
		await session.stop();
		await fixture.close();
		cleanupDirs(dirs);
	}
});
