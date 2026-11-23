/**
 * Issue #55: privacy-safe metrics and the local consumer/exporter seam.
 *
 * Every test drives a real `pi --mode rpc` subprocess with the pi-goal package
 * loaded, a scripted test model provider, and
 * `test/extensions/metrics-peer.ts` — a second extension that subscribes to the
 * public `pi-goal:metrics` channel on Pi's shared extension event bus and records
 * each pre-redacted projection as a durable `goal-metrics-log` session entry. The
 * entry also carries the process's fetch-attempt count at emission time, so the
 * default no-network claim is checked across the whole scenario, not assumed.
 *
 * Assertions therefore target public behavior only: the metrics a local consumer
 * or companion exporter receives, the durable `goal-state` entries those metrics
 * mirror, the command/tool surfaces, and Pi's own diagnostics. No hosted
 * credential, host, or network service is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	PiRpcSession,
	assertCleanRun,
	assertStepsConsumed,
	goalSnapshots,
	readSessionEntries,
	script,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE =
	"Ship the metrics seam from /Users/me/private/secret-source.ts " +
	"using https://internal.example/secret OBJECTIVE-CANARY-55";
const SESSION_CANARY = "SESSION-CANARY-55";
const METRICS_PEER = new URL("./extensions/metrics-peer.ts", import.meta.url).pathname;
const METRICS_LOG_TYPE = "goal-metrics-log";
const NET_PROBE_LOG_TYPE = "net-probe";
const PACKAGE_VERSION = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** Every recorded metric, in delivery (= commit) order, with its fetch snapshot. */
function metricsLog(entries) {
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === METRICS_LOG_TYPE)
		.map((entry) => entry.data);
}

/** Start a session whose metrics peer records the public metrics stream. */
function startMetricsSession(options = {}) {
	return PiRpcSession.start({
		...options,
		extraExtensions: [METRICS_PEER, ...(options.extraExtensions ?? [])],
	});
}

/** Abort the in-flight run so lifecycle commands can run from idle. */
async function abortActiveLoop(session, runs) {
	await session.waitFor(`${runs} agent runs started`, (records) =>
		records.filter((r) => r.type === "agent_start").length >= runs ? true : undefined,
	);
	await session.sendSimple("abort");
	return session.waitForSettled(1);
}

test("the metrics stream mirrors committed transitions and carries no sensitive field", async () => {
	const session = await startMetricsSession();
	script(
		[
			{
				toolCalls: [{ name: "update_goal", args: { action: "complete" } }],
				usage: { input: 60, output: 20, cacheWrite: 5 },
			},
			{ text: "Done." },
		],
		session,
	);
	try {
		await session.prompt(`/goal --budget 100 ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await session.waitForSettled(1);
		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));

		const entries = readSessionEntries(await session.sessionFile());
		const log = metricsLog(entries);
		assert.deepEqual(
			log.map((entry) => entry.metrics.kind),
			["created", "completed", "cleared"],
			"one metric per committed transition, in commit order",
		);

		// The metrics mirror the durable snapshots they were projected from: identity
		// is not projected, but status, totals, active time, budget, and time are.
		const snapshots = goalSnapshots(entries);
		const created = snapshots[0].data.goal;
		const completed = snapshots[1].data.goal;
		assert.equal(created.status, "active");
		assert.equal(created.usage.totalTokens, 0);
		assert.equal(completed.status, "complete");
		assert.equal(completed.usage.totalTokens, 85);

		const [createdMetric, completedMetric, clearedMetric] = log.map((entry) => entry.metrics);
		assert.equal(createdMetric.version, 1);
		assert.equal(createdMetric.extensionVersion, PACKAGE_VERSION);
		assert.equal(createdMetric.status, "active");
		assert.equal(createdMetric.totalTokens, 0);
		assert.equal(createdMetric.activeSeconds, 0);
		assert.deepEqual(createdMetric.budget, {
			state: "within-budget",
			limitTokens: 100,
			remainingTokens: 100,
		});
		assert.equal(createdMetric.timestamp, new Date(created.updatedAt).toISOString());

		assert.equal(completedMetric.status, "complete");
		assert.equal(completedMetric.totalTokens, 85);
		assert.equal(completedMetric.activeSeconds, Math.floor(completed.usage.activeMs / 1000));
		assert.deepEqual(completedMetric.budget, {
			state: "within-budget",
			limitTokens: 100,
			remainingTokens: 15,
		});
		assert.equal(completedMetric.timestamp, new Date(completed.updatedAt).toISOString());

		// A clear reports the cleared Goal's last committed status and usage, and no
		// invented current Goal.
		assert.equal(clearedMetric.status, "complete");
		assert.equal(clearedMetric.totalTokens, 85);
		assert.equal(clearedMetric.budget.limitTokens, 100);
		assert.ok(!Number.isNaN(Date.parse(clearedMetric.timestamp)));

		// Deny-by-default: nothing sensitive from the objective, the identity, or the
		// host's session can appear in the projection.
		const serialized = JSON.stringify(log.map((entry) => entry.metrics));
		for (const canary of [
			"OBJECTIVE-CANARY-55",
			"secret-source.ts",
			"/Users/me/private",
			"internal.example",
			created.id,
		]) {
			assert.equal(serialized.includes(canary), false, `metric leaked ${canary}: ${serialized}`);
		}
		for (const metric of log.map((entry) => entry.metrics)) {
			assert.deepEqual(Object.keys(metric).sort(), [
				"activeSeconds",
				"budget",
				"extensionVersion",
				"kind",
				"status",
				"timestamp",
				"totalTokens",
				"version",
			]);
		}

		// Zero default network activity: no fetch happened before any metric, and
		// none happened by the end of the whole scenario.
		assert.deepEqual(
			log.map((entry) => entry.fetchCalls),
			[0, 0, 0],
		);
		await session.prompt("/netcheck");
		await session.waitForNotify((r) => r.message.includes("fetch attempts: 0"));
		const probe = readSessionEntries(await session.sessionFile()).filter(
			(entry) => entry.type === "custom" && entry.customType === NET_PROBE_LOG_TYPE,
		);
		assert.deepEqual(probe.map((entry) => entry.data.calls), [[]]);

		assertStepsConsumed(session, 2);
		assertCleanRun(session);
	} finally {
		await session.stop();
	}
});

test("a failing metrics consumer cannot roll back a transition or create a false durability result", async () => {
	const session = await startMetricsSession();
	script(
		[
			{ text: "On it.", usage: { input: 30, output: 10 } },
			{ hang: true },
		],
		session,
	);
	try {
		await session.prompt(`/goal ${OBJECTIVE}`);
		await session.waitForNotify((r) => r.message.includes("created and activated"));
		await abortActiveLoop(session, 2);
		const id = goalSnapshots(readSessionEntries(await session.sessionFile()))[0].data.goal.id;

		// Arm the consumer's injected failure for the paused transition, then pause.
		await session.prompt("/metricsfail paused");
		await session.waitForNotify((r) => r.message.includes("metricsfail armed"));
		await session.prompt("/goal:pause");

		// The transition committed and was reported as a success: the durable
		// snapshot exists, the pause was announced, and no extension error turned
		// the consumer's failure into a false durability problem.
		await session.waitForNotify((r) => r.message.includes("paused (revision 1)"));
		const entries = readSessionEntries(await session.sessionFile());
		const pausedSnapshot = goalSnapshots(entries).find(
			(entry) => entry.data.goal?.id === id && entry.data.goal?.revision === 1,
		);
		assert.ok(pausedSnapshot, "the pause is durable");
		assert.equal(pausedSnapshot.data.goal.status, "paused");

		// The metric was delivered before the consumer threw, so the stream still
		// carries the committed transition; the failure surfaced only as the host's
		// own diagnostic for the metrics seam.
		assert.deepEqual(
			metricsLog(entries).map((entry) => entry.metrics.kind),
			["created", "paused"],
		);
		const foreign = session.extensionErrors().filter((r) => r.event !== "events:pi-goal:metrics");
		assert.equal(foreign.length, 0, `no pi-goal-side failure: ${JSON.stringify(foreign)}`);
		const consumerDiagnostics = session.extensionErrors().filter(
			(r) => r.event === "events:pi-goal:metrics",
		);
		const stderrDiagnostic = /Event handler error \(pi-goal:metrics\)/.test(session.stderr.join(""));
		assert.ok(
			consumerDiagnostics.length === 1 || stderrDiagnostic,
			"the consumer failure surfaced as the host's own diagnostic (extension error record or bus log)",
		);

		// Disarmed, the very next transition publishes normally again — including a
		// metric for the transition that follows the failure.
		await session.prompt("/metricsfail");
		await session.waitForNotify((r) => r.message.includes("metricsfail disarmed"));
		await session.prompt("/goal:clear");
		await session.waitForNotify((r) => r.message.includes("cleared"));
		assert.deepEqual(
			metricsLog(readSessionEntries(await session.sessionFile())).map((entry) => entry.metrics.kind),
			["created", "paused", "cleared"],
		);

		assertStepsConsumed(session, 2, [{ stopReason: "aborted" }]);
		assert.equal(session.extensionErrors().filter((r) => r.event !== "events:pi-goal:metrics").length, 0);
	} finally {
		await session.stop();
	}
});
