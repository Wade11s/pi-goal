/**
 * Issue #5 acceptance tests: how a terminal provider failure is classified.
 *
 * Split into its own file so the table of provider failures runs in parallel with
 * the rest of the Issue #5 tests: every row spawns a real `pi --mode rpc` session,
 * because the classification happens at the settlement boundary inside a real Pi.
 *
 * Retries are disabled in every row. With Pi's retries on, a retryable error
 * consumes the next scripted step, succeeds, and the run completes — which hides
 * the classification under test. That is also why an earlier round of these tests
 * passed for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
	PiRpcSession,
	assertOnlyFailures,
	assistantOutcomes,
	lastGoalSnapshot,
	readSessionEntries,
} from "./helpers/rpc-harness.mjs";

const OBJECTIVE = "Make the full test suite pass in this repository";

function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/** Wait until the current run has provably started but has not yet answered. */
function waitForRunStarted(session) {
	return session.waitFor("run started", (records) => (records.some((r) => r.type === "turn_start") ? true : undefined));
}

/** Create the Goal and confirm the kickoff run was started. */
async function startGoal(session, objective = OBJECTIVE) {
	await session.prompt(`/goal ${objective}`);
	await session.waitForNotify((r) => r.message.includes("created and activated"));
	await waitForRunStarted(session);
}

/**
 * Assert the scripted provider was asked for exactly `steps` responses, and that
 * the only failures are the ones the test deliberately provoked.
 */
function assertStepsConsumed(session, steps, expectedFailures = []) {
	const outcomes = assistantOutcomes(session);
	assert.equal(
		outcomes.length,
		steps,
		`expected exactly ${steps} provider responses, got ${outcomes.length}`,
	);
	assertOnlyFailures(session, expectedFailures);
}

test("provider failures are classified from what the evidence actually says", async () => {
	// One terminal provider error per case, retries disabled so the failure reaches
	// the boundary exactly as the reviewer's probes did. `usage_limited` is terminal
	// for continuation, so every row is a decision the extension has to get right.
	const cases = [
		// Exhaustion: the plan or budget is used up, so the Goal must stop.
		["429 insufficient_quota: you exceeded your current quota for this organization", "usage_limited"],
		["You exceeded your current quota for this organization", "usage_limited"],
		["Monthly usage limit reached", "usage_limited"],
		["Your credit balance is too low to access the Anthropic API", "usage_limited"],
		["billing hard limit has been reached", "usage_limited"],
		["You have reached your usage limit for this billing period", "usage_limited"],
		// A throttle and an exhausted quota in one failure: the quota decides.
		["429 rate limit reached; insufficient_quota: current quota exhausted", "usage_limited"],
		// Negation and sentence boundaries must not be read past.
		["This is not a rate limit. Your quota is exceeded.", "usage_limited"],
		// Internal and per-request budgets are not the account's plan.
		["Retry budget exhausted after 3 attempts", "active"],
		["token budget exceeded for this request", "active"],
		// A lookup or a throttle is not an exhausted plan.
		["The quota service reached a timeout while checking your account", "active"],
		["You have not exceeded your quota", "active"],
		["Your quota is not exceeded", "active"],
		["Your usage limit has not been reached", "active"],
		["429 rate limit exceeded, please slow down", "active"],
		// An unqualified or per-request budget is not the account's plan.
		["The request is out of budget for this call", "active"],
		// Negation can sit on either side of the verb, and can lead with "no".
		["Your quota has not been exceeded", "active"],
		["Your plan limit has not been reached", "active"],
		["No quota exceeded", "active"],
		// A lookup or a throttle in the same sentence is not plan exhaustion, and
		// qualifying the noun does not change that: what decides is the verb's
		// object, not how the subject was named.
		["The quota service reached a rate limit while checking your account", "active"],
		["The account quota service reached a timeout while checking your account", "active"],
		["The billing limit check reached a timeout while checking your account", "active"],
		["The spending limit lookup reached a timeout while checking your account", "active"],
		["The monthly budget service reached a timeout while checking your account", "active"],
		// ...while a genuine exhaustion keeps its clause: the remark after it is not
		// what the verb reached.
		["You have reached your usage limit; please check your plan", "usage_limited"],
		["You have reached your usage limit. Please check your account settings.", "usage_limited"],
		["Monthly usage limit reached. Contact the billing service for details.", "usage_limited"],
		["Your account quota was exceeded after the service check", "usage_limited"],
		// A transient throttle that the provider describes with quota vocabulary: a
		// per-minute quota metric resets within a minute, so it is a throttle, and a
		// negated quota statement is a provider saying the plan is fine.
		["Rate limit exceeded; quota is not exhausted.", "active"],
		["Rate limit exceeded but the quota is not exhausted.", "active"],
		["429 rate limit exceeded for quota metric requests per minute", "active"],
		["Quota exceeded for quota metric Generate Content API requests per minute", "active"],
		["Quota exceeded for quota metric 'Generate Content API requests per minute'", "active"],
		["429 Too Many Requests: Rate limit exceeded for quota metric openai-tokens per minute", "active"],
		// Explicit account or plan depletion overrides throttle wording in the same
		// failure, because it says the plan itself is used up.
		["429 rate limit exceeded for quota metric requests per minute; insufficient_quota", "usage_limited"],
		["Rate limit reached. insufficient_quota: your current quota is exhausted", "usage_limited"],
		["your plan quota has been exhausted", "usage_limited"],
		["spending budget exhausted", "usage_limited"],
		// A rejected earlier lookup or throttle does not hide a later statement of
		// exhaustion: every match of every pattern is scanned, not just the first.
		["The quota service reached a timeout while checking your account. Your quota is exceeded.", "usage_limited"],
		["Quota is not exceeded for this request. The account quota has been exhausted.", "usage_limited"],
	];
	// Rows run in small batches rather than one at a time: each spawns a real Pi
	// subprocess, and forty sequential spawns dominate the suite's wall time. Each
	// row owns its own session and temporary directories, so the rows are
	// independent, and a failing row still names its own evidence in the message.
	const BATCH_SIZE = 4;
	for (let start = 0; start < cases.length; start += BATCH_SIZE) {
		await Promise.all(
			cases.slice(start, start + BATCH_SIZE).map(([message, expectedStatus]) => classifyOne(message, expectedStatus)),
		);
	}
});

/** Drive one provider failure through a real session and assert the Goal's status. */
async function classifyOne(message, expectedStatus) {
	// Retries are disabled so the failure reaches the boundary as the reviewer's
	// probes did. With Pi's retries on, a retryable error would consume the next
	// scripted step, succeed, and the run would complete — hiding the very
	// classification under test.
	const session = await PiRpcSession.start({ settings: { retry: { enabled: false } } });
	script([{ text: "Kickoff answer." }, { error: message }, { text: "Unrequested." }], session);
	try {
		await startGoal(session);
		await session.waitForSettled(1);
		const entries = readSessionEntries(await session.sessionFile());
		assert.equal(
			lastGoalSnapshot(entries).data.goal.status,
			expectedStatus,
			`"${message}" must leave the Goal ${expectedStatus}`,
		);
		assertStepsConsumed(session, 2, [{ stopReason: "error", errorMessage: message }]);
		assert.equal(session.extensionErrors().length, 0);
	} finally {
		await session.stop();
	}
}
