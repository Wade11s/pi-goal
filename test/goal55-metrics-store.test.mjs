/**
 * Issue #55: the privacy-safe metrics projection and its local consumer seam.
 *
 * These tests cover the narrow, deterministic seams a real-Pi RPC test cannot:
 * the pure projection's exact field set and budget arithmetic, its
 * deny-by-default treatment of fields it was never told to read, the
 * failure-isolation contract of the publisher, and the absence of any network
 * path in the default wiring. The end-to-end stream a real consumer receives —
 * committed-transition mirroring, sensitive-data absence across a whole
 * scenario, failure isolation against a real bus, and zero fetch attempts — is
 * covered in `test/goal55-metrics.test.mjs` against a real Pi subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GoalStore } from "../src/store.ts";
import { toGoalUpdatedEvent } from "../src/events.ts";
import { createGoalMetricsPublisher, toGoalMetrics } from "../src/metrics.ts";
import { PI_GOAL_VERSION } from "../src/version.ts";

/** A committed-looking Goal record; every sensitive canary lives in a field here. */
function record(overrides = {}) {
	return {
		id: "SESSION-CANARY-55",
		objective:
			"SECRET-OBJECTIVE-CANARY ship from /Users/me/private/secret-source.ts " +
			"using https://internal.example/secret",
		status: "active",
		origin: "command",
		createdAt: Date.parse("2026-02-01T00:00:00.000Z"),
		updatedAt: Date.parse("2026-02-01T00:05:30.250Z"),
		revision: 4,
		usage: {
			totalTokens: 40,
			inputTokens: 30,
			outputTokens: 8,
			cacheWriteTokens: 2,
			cachedReadTokens: 900,
			reasoningTokens: 3,
			nestedTokens: 0,
			activeMs: 65_400,
		},
		...overrides,
	};
}

/** The projection of one committed event for a record. */
function metricsFor(kind, overrides = {}) {
	return toGoalMetrics(toGoalUpdatedEvent(kind, record(overrides)));
}

/** Minimal `ExtensionAPI` stand-in that retains what it is given, like Pi does. */
function fakePi() {
	const entries = [];
	return {
		entries,
		failNext: 0,
		appendEntry(customType, data) {
			if (this.failNext > 0) {
				this.failNext -= 1;
				throw new Error("injected append failure");
			}
			entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
		},
	};
}

test("the projection is exactly the committed transition, totals, active time, budget, and extension version", () => {
	const metrics = metricsFor("paused");
	assert.deepEqual(Object.keys(metrics).sort(), [
		"activeSeconds",
		"budget",
		"extensionVersion",
		"kind",
		"status",
		"timestamp",
		"totalTokens",
		"version",
	]);
	assert.deepEqual(Object.keys(metrics.budget).sort(), ["limitTokens", "remainingTokens", "state"]);

	assert.equal(metrics.version, 1);
	assert.equal(metrics.extensionVersion, PI_GOAL_VERSION);
	assert.equal(metrics.kind, "paused");
	assert.equal(metrics.status, "active");
	assert.equal(metrics.totalTokens, 40, "the accounted total, not a component");
	assert.equal(metrics.activeSeconds, 65, "whole seconds, floored from the committed activeMs");
	assert.equal(metrics.budget.state, "unbounded");
	assert.equal(metrics.budget.limitTokens, null);
	assert.equal(metrics.budget.remainingTokens, null);
	assert.equal(metrics.timestamp, "2026-02-01T00:05:30.250Z", "the committed transition's own time");

	assert.equal(toGoalMetrics(toGoalUpdatedEvent("created", record()), "9.9.9").extensionVersion, "9.9.9");
});

test("budget state comes from the committed event, never from live store state", () => {
	const within = metricsFor("created", { tokenBudget: 100 });
	assert.deepEqual(within.budget, { state: "within-budget", limitTokens: 100, remainingTokens: 60 });

	const exact = metricsFor("budget-limited", {
		status: "budget_limited",
		tokenBudget: 100,
		usage: { ...record().usage, totalTokens: 100 },
	});
	assert.deepEqual(exact.budget, { state: "exhausted", limitTokens: 100, remainingTokens: 0 });
	assert.equal(exact.status, "budget_limited");

	const overshoot = metricsFor("budget-limited", {
		status: "budget_limited",
		tokenBudget: 100,
		usage: { ...record().usage, totalTokens: 140 },
	});
	assert.deepEqual(
		overshoot.budget,
		{ state: "exhausted", limitTokens: 100, remainingTokens: 0 },
		"an overshoot is exhausted with zero remaining, never a negative remainder",
	);
});

test("the projection is an allowlist: sensitive record fields and future event fields are dropped", () => {
	const event = toGoalUpdatedEvent("blocked", record({ status: "blocked" }));
	const hostile = {
		...event,
		sessionId: "SESSION-CANARY-55",
		prompt: "RAW-PROMPT-CANARY",
		objectiveText: "OBJECTIVE-TEXT-CANARY",
		blocker: { description: "BLOCKER-CANARY" },
		attachment: {
			fileName: "file-canary.ts",
			url: "https://canary.example/artifact",
			content: "ATTACHMENT-CANARY",
		},
		goal: {
			...event.goal,
			id: "SESSION-CANARY-55",
			objective: {
				...event.goal.objective,
				text: "OBJECTIVE-TEXT-CANARY",
				url: "https://canary.example/objective",
			},
			blockedAudit: { blocker: "BLOCKER-CANARY" },
			usage: { ...event.goal.usage, sourceFile: "file-canary.ts" },
		},
	};

	const metrics = toGoalMetrics(hostile);
	const serialized = JSON.stringify(metrics);
	for (const canary of [
		"SECRET-OBJECTIVE-CANARY",
		"OBJECTIVE-TEXT-CANARY",
		"RAW-PROMPT-CANARY",
		"SESSION-CANARY-55",
		"BLOCKER-CANARY",
		"ATTACHMENT-CANARY",
		"file-canary.ts",
		"/Users/me/private",
		"internal.example",
		"canary.example",
	]) {
		assert.equal(serialized.includes(canary), false, `metric leaked ${canary}: ${serialized}`);
	}
	assert.deepEqual(Object.keys(metrics).sort(), [
		"activeSeconds",
		"budget",
		"extensionVersion",
		"kind",
		"status",
		"timestamp",
		"totalTokens",
		"version",
	]);
	assert.equal("goal" in metrics, false, "no Goal identity or revision");
	assert.equal("objective" in metrics, false, "not even objective metadata");
});

test("a refused or failed transition produces no metric because it produces no committed event", () => {
	const pi = fakePi();
	const metrics = [];
	const publisher = createGoalMetricsPublisher({ sink: (metric) => metrics.push(metric) });
	const store = new GoalStore({
		onDurableTransition: (kind, goal, committedAt) => {
			publisher.publish(toGoalUpdatedEvent(kind, goal, committedAt));
		},
	});

	const goal = store.create("Project only committed work");
	store.stage(pi, goal);
	store.commit(goal);
	assert.deepEqual(metrics.map((m) => m.kind), ["created"]);

	// A failed durable write is not a transition: no event, therefore no metric.
	pi.failNext = 1;
	assert.equal(store.markPaused(pi).ok, false);
	assert.deepEqual(metrics.map((m) => m.kind), ["created"]);

	// A genuine refusal is not a transition either.
	assert.equal(store.markPaused(pi).ok, true);
	assert.deepEqual(metrics.map((m) => m.kind), ["created", "paused"]);
	assert.equal(store.markResumed(pi).ok, true);
	assert.deepEqual(metrics.map((m) => m.kind), ["created", "paused", "resumed"]);
	assert.equal(metrics[2].status, "active");
});

test("a throwing or rejecting consumer is isolated: no throw, no rollback, later metrics still flow", async () => {
	const delivered = [];
	const errors = [];
	const publisher = createGoalMetricsPublisher({
		sink: (metric) => {
			if (metric.kind === "paused") throw new Error("consumer exploded");
			if (metric.kind === "completed") return Promise.reject(new Error("async consumer exploded"));
			delivered.push(metric.kind);
		},
		onError: (error) => errors.push(String(error)),
	});

	const event = (kind) => toGoalUpdatedEvent(kind, record({ status: "active" }));
	assert.doesNotThrow(() => publisher.publish(event("created")));
	assert.doesNotThrow(() => publisher.publish(event("paused")));
	assert.doesNotThrow(() => publisher.publish(event("completed")));
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(delivered, ["created"], "only the successful delivery reached the consumer");
	assert.equal(errors.length, 2);
	assert.match(errors[0], /consumer exploded/);
	assert.match(errors[1], /async consumer exploded/);

	// An advisory diagnostics hook that throws is swallowed too, and the
	// publisher still returns nothing that could be mistaken for durability.
	const broken = createGoalMetricsPublisher({
		sink: () => {
			throw new Error("again");
		},
		onError: () => {
			throw new Error("diagnostics exploded");
		},
	});
	assert.equal(broken.publish(event("created")), undefined);
});

test("the default seam performs no network I/O and core carries no hosted exporter", () => {
	const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(PI_GOAL_VERSION, packageJson.version, "the reported extension version matches the package");
	assert.equal(packageJson.dependencies, undefined, "pi-goal has no runtime dependencies");
	assert.equal(packageJson.optionalDependencies, undefined);

	// Static guard: neither the projection nor the default wiring names a network
	// transport, and a hosted exporter has no way to be reached from core.
	for (const file of ["../src/metrics.ts", "../src/version.ts", "../src/index.ts"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		for (const forbidden of [
			"node:http",
			"node:https",
			"node:net",
			"node:tls",
			"node:dgram",
			"XMLHttpRequest",
			"WebSocket",
			/\bfetch\s*\(/,
		]) {
			assert.equal(
				typeof forbidden === "string" ? source.includes(forbidden) : forbidden.test(source),
				false,
				`${file} references ${String(forbidden)}`,
			);
		}
	}

	// Runtime guard: even a hostile global fetch is never reached by publishing.
	const host = globalThis;
	const originalFetch = host.fetch;
	const attempts = [];
	host.fetch = (...args) => {
		attempts.push(args[0]);
		throw new Error("network attempted");
	};
	try {
		const published = [];
		const publisher = createGoalMetricsPublisher({ sink: (metric) => published.push(metric) });
		for (let index = 0; index < 100; index += 1) {
			publisher.publish(toGoalUpdatedEvent("created", record({ tokenBudget: 100 })));
		}
		assert.equal(published.length, 100);
	} finally {
		host.fetch = originalFetch;
	}
	assert.deepEqual(attempts, []);
});
