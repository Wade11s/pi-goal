/**
 * Issue #27 repair batch 4: the shared pause-instruction vocabulary.
 *
 * `corroboratePauseRequest` and the Goal-creation rules read the same shared
 * vocabulary (`REQUEST_LEAD`, the negation window, the cancellation clauses), so
 * a change there lands on both paths. This file pins the pause side of that
 * vocabulary: the typographic-apostrophe fold that keeps a later "Don’t." from
 * corroborating a pause, and the discourse-marker leads the batch-4
 * `REQUEST_LEAD` widening added.
 *
 * These are deliberately narrow and provider-free, like
 * `test/goal12-creation-authority-store.test.mjs`. The end-to-end pause
 * behavior (corroborated pause, refusals, `/goal pause` ownership) lives in
 * `test/goal4.test.mjs` and `test/goal4-regressions.test.mjs`.
 *
 * The module is imported straight from TypeScript; Node 22.6+ strips the
 * erasable syntax natively. On older Node the file skips (the RPC suite remains
 * the required gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let goalModule;
try {
	goalModule = await import("../src/goal.ts");
} catch {
	goalModule = undefined;
}
const it = goalModule ? test : test.skip;
const { corroboratePauseRequest } = goalModule ?? {};

/** Branch entries (oldest first) as `sessionManager.getBranch()` reports them. */
function branch(...messages) {
	return messages.map((text) => ({ type: "message", message: { role: "user", content: text } }));
}

/**
 * One row: the human user messages on the branch (oldest first), the model's
 * quote, and the expected outcome. `ok` rows must corroborate; the others must
 * fail with the named reason.
 */
const ROWS = [
	// --- accepted affirmative instructions -------------------------------
	[["please pause the goal"], "please pause the goal", "ok"],
	[["Actually pause the goal"], "Actually pause the goal", "ok"],
	[["Actually, pause the goal"], "pause the goal", "ok"],
	[["In fact pause the goal"], "pause the goal", "ok"],
	// --- straight-apostrophe negation and cancellation --------------------
	[["Do not pause the goal"], "Do not pause the goal", "not-an-instruction"],
	[["don't pause the goal"], "don't pause the goal", "not-an-instruction"],
	[["please pause the goal. Don't."], "please pause the goal", "not-an-instruction"],
	[["please pause the goal, don't"], "please pause the goal", "not-an-instruction"],
	[["please pause the goal", "keep working"], "please pause the goal", "not-an-instruction"],
	// --- typographic apostrophes ------------------------------------------
	// The same sentences pasted from a chat client or a word processor, where the
	// apostrophe is U+2019. They have to decide exactly like the rows above: a
	// later "Don’t." cancels the pause request it follows.
	[["Don’t pause the goal"], "Don’t pause the goal", "not-an-instruction"],
	[["please pause the goal. Don’t."], "please pause the goal", "not-an-instruction"],
	[["please pause the goal, don’t"], "please pause the goal", "not-an-instruction"],
	[["please pause the goal", "Don’t"], "please pause the goal", "not-an-instruction"],
];

for (const [messages, quote, expected] of ROWS) {
	it(`corroborates ${JSON.stringify(quote)} against ${JSON.stringify(messages)} as ${expected}`, () => {
		const result = corroboratePauseRequest(branch(...messages), quote);
		if (expected === "ok") {
			assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
			return;
		}
		assert.equal(result.ok, false, `expected ${expected}, got ${JSON.stringify(result)}`);
		assert.equal(result.reason, expected);
	});
}

it("a later typographic-apostrophe cancellation cannot corroborate a pause", () => {
	// A cancellation written with U+2019 used to slip past the negation
	// vocabulary, so "please pause the goal. Don’t." corroborated the pause it
	// explicitly cancels. The straight-apostrophe twin was already refused, and
	// the curly one has to fail closed the same way.
	for (const message of ["please pause the goal. Don’t.", "please pause the goal, don’t"]) {
		const result = corroboratePauseRequest(branch(message), "please pause the goal");
		assert.equal(result.ok, false, `${JSON.stringify(message)} must not corroborate: ${JSON.stringify(result)}`);
		assert.equal(result.reason, "not-an-instruction");
	}
});

it("a comma-less discourse-marker lead corroborates a pause", () => {
	// `REQUEST_LEAD` is shared with the Goal-creation rules, where "actually" and
	// "in fact" were added as correction markers. That widening also reaches the
	// pause path, where the comma-less form ("Actually pause the goal") was
	// previously refused. This is the intentional compatible acceptance: the
	// phrase is an ordinary affirmative pause instruction, and the pause stays
	// owned by the user through /goal pause.
	for (const message of ["Actually pause the goal", "Actually, pause the goal", "In fact pause the goal"]) {
		const result = corroboratePauseRequest(branch(message), "pause the goal");
		assert.equal(result.ok, true, `${JSON.stringify(message)} should corroborate: ${JSON.stringify(result)}`);
	}
});
