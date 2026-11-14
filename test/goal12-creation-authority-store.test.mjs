/**
 * Issue #27 repair batch 4 narrow combinatorial tests: the conservative
 * Goal-creation quotation and clause-order rules that a real `pi --mode rpc`
 * subprocess cannot cover exhaustively.
 *
 * These are deliberately narrow and provider-free. The end-to-end authority
 * behavior (accepted sources, replacement, expiry, one-shot use, corrected
 * retries, fail-closed rejection, and unchanged direct `/goal` creation) lives
 * in `test/goal12-creation-authority.test.mjs`.
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
const { corroborateGoalCreationRequest } = goalModule ?? {};

/**
 * One row: the authoritative source, the model's quote, and the expected
 * outcome. `ok` rows must corroborate; the others must fail with the named
 * reason.
 */
const ROWS = [
	// --- accepted affirmative instructions -------------------------------
	["Please create a goal for the release", "Please create a goal", "ok"],
	["create a goal", "create a goal", "ok"],
	["Set a goal to ship the release", "Set a goal", "ok"],
	["start a goal for the migration", "start a goal", "ok"],
	["Let's create a goal for the launch", "create a goal", "ok"],
	["I want you to create a goal for the launch", "create a goal", "ok"],
	["I would like you to create a goal", "create a goal", "ok"],
	["Can you create a goal for the launch", "create a goal", "ok"],
	["The goal should be created for the launch", "The goal should be created", "ok"],
	["I want a goal created for the launch", "I want a goal created", "ok"],
	["We need a goal created before Friday", "We need a goal created", "ok"],
	["Actually, create a goal for the launch", "create a goal", "ok"],
	["create   a\ngoal for the launch", "create a goal", "ok"],
	["create a goal, then set a budget", "create a goal", "ok"],
	["Set the goal's budget to 5000", "Set the goal", "not-an-instruction"],
	["Set the goal's budget to 5000", "Set the goal's budget", "quote-not-request"],
	["Create a goal with no budget", "Create a goal", "ok"],
	["Create a goal without a budget", "Create a goal", "ok"],
	// A later explicit correction supersedes an earlier negation.
	["Do not create a goal. Create a goal for the launch.", "create a goal", "ok"],
	["Do not create a goal. Actually, create a goal for the launch.", "create a goal", "ok"],
	["Do not create a goal. Create a goal for the launch.", "Create a goal", "ok"],
	// --- quotation shape ------------------------------------------------
	["please create a goal for the release", "create", "quote-not-request"],
	["please create a goal for the release", "a goal", "quote-not-request"],
	["please create a goal for the release", "please create a goal for the release", "ok"],
	["Goal creation is useful", "Goal creation is useful", "quote-not-request"],
	["fix the bug in the goal module", "fix the bug in the goal module", "quote-not-request"],
	["keep working on the goal", "keep working on the goal", "quote-not-request"],
	["continue with the goal", "continue with the goal", "quote-not-request"],
	["Maybe create a goal", "Maybe create a goal", "quote-not-request"],
	["Should we create a goal?", "Should we create a goal", "not-an-instruction"],
	// --- case-sensitive, whitespace-folded matching ----------------------
	["Create a goal for the release", "create a goal", "not-found"],
	["create a goal for the release", "Create a goal", "not-found"],
	["please set a goal for the release", "create a goal", "not-found"],
	["please create a goal for the release", "please set a goal", "not-found"],
	// --- negation and cancelled requests --------------------------------
	["Do not create a goal", "create a goal", "not-an-instruction"],
	["Do not create a goal", "Do not create a goal", "quote-not-request"],
	["don't create a goal", "create a goal", "not-an-instruction"],
	["never create a goal", "create a goal", "not-an-instruction"],
	["no need to create a goal", "create a goal", "not-an-instruction"],
	["without creating a goal", "creating a goal", "quote-not-request"],
	["I did not say create a goal", "create a goal", "not-an-instruction"],
	["Create a goal, do not", "Create a goal", "not-an-instruction"],
	["Create a goal, do not", "do not", "quote-not-request"],
	["Create a goal. Don't.", "Create a goal", "not-an-instruction"],
	["Create a goal. Never mind.", "Create a goal", "not-an-instruction"],
	["Create a goal. Cancel that.", "Create a goal", "not-an-instruction"],
	["Create a goal. Wait, no.", "Create a goal", "not-an-instruction"],
	["Create a goal. I changed my mind.", "Create a goal", "not-an-instruction"],
	["Create a goal. I didn't mean it.", "Create a goal", "not-an-instruction"],
	["Create a goal. Don't do it.", "Create a goal", "not-an-instruction"],
	["Create a goal. I don't want that.", "Create a goal", "not-an-instruction"],
	["Create a goal, not now", "Create a goal", "not-an-instruction"],
	// --- typographic apostrophes -------------------------------------------
	// A cancellation pasted from a chat client or a word processor arrives with a
	// curly apostrophe. It has to cancel exactly like the straight-apostrophe
	// form, so the negation and cancellation vocabulary is matched against
	// apostrophe-folded text: a later "Don’t" can never authorize the Goal it
	// explicitly cancels.
	["Create a goal. Don’t.", "Create a goal", "not-an-instruction"],
	["Create a goal. Don’t do it.", "Create a goal", "not-an-instruction"],
	["Create a goal. I didn’t mean it.", "Create a goal", "not-an-instruction"],
	["Create a goal. I don’t want that.", "Create a goal", "not-an-instruction"],
	["Create a goal, don’t", "Create a goal", "not-an-instruction"],
	["Create a goal. Wait, don’t.", "Create a goal", "not-an-instruction"],
	["Don’t create a goal", "create a goal", "not-an-instruction"],
	["Create a goal for X. Don’t do it.", "Create a goal for X", "not-an-instruction"],
	// The fold is confined to the negation and cancellation vocabulary, so it
	// cannot widen what counts as an instruction: a curly-apostrophe lead is still
	// refused (its straight twin is accepted above), and the quotation match stays
	// byte-exact, so a curly source still refuses a straight-apostrophe quote.
	["Let’s create a goal for the launch", "create a goal", "not-an-instruction"],
	["Let’s create a goal for the launch", "Let's create a goal for the launch", "not-found"],
	// --- hypotheticals and questions ------------------------------------
	["If you create a goal, we can track it", "create a goal", "not-an-instruction"],
	["Create a goal if the user approves", "Create a goal", "not-an-instruction"],
	["When you create a goal, tell me", "create a goal", "not-an-instruction"],
	["Can you create a goal?", "Can you create a goal", "not-an-instruction"],
	["Can you create a goal?", "Can you create a goal?", "quote-not-request"],
	["How do I create a goal?", "create a goal", "not-an-instruction"],
	// --- clause order ---------------------------------------------------
	["Create a goal. Do not create a goal.", "Create a goal", "not-an-instruction"],
	["Create a goal. Actually, do not.", "Create a goal", "not-an-instruction"],
	["Do not create a goal. Create a goal.", "create a goal", "ok"],
	["Do not create a goal. Actually, create a goal.", "create a goal", "ok"],
	// --- empty and tiny quotes ------------------------------------------
	["create a goal", "", "quote-empty"],
	["create a goal", "  ", "quote-empty"],
	["create a goal", "ab", "quote-empty"],
];

for (const [source, quote, expected] of ROWS) {
	it(`corroborates ${JSON.stringify(quote)} against ${JSON.stringify(source)} as ${expected}`, () => {
		const result = corroborateGoalCreationRequest(source, quote);
		if (expected === "ok") {
			assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`);
			assert.equal(result.source, source.replace(/\s+/g, " ").trim());
			return;
		}
		assert.equal(result.ok, false, `expected ${expected}, got ${JSON.stringify(result)}`);
		assert.equal(result.reason, expected);
	});
}

it("a quote that only appears in a non-deciding clause is ambiguous and fails closed", () => {
	// The quote occurs, but the clause is a past-tense mention, not a request.
	const result = corroborateGoalCreationRequest("I created a goal yesterday", "created a goal");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "quote-not-request");
});

it("the objective is never required to repeat the quotation", () => {
	// The source carries the instruction; the objective is model-written. The
	// corroboration only reads the source, so an unrelated objective is fine.
	const result = corroborateGoalCreationRequest("please create a goal", "please create a goal");
	assert.equal(result.ok, true);
});
