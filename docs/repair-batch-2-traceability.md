# Repair batch 2 traceability: cumulative budget recovery and per-episode wrap-ups

Issue: #25. Source decisions: #17 (Goal-owned work), #19 (budget-limited resume),
#21 (regression contract), #22 (legacy snapshots), #23 (implementation sequence).
Behavior reference: ADR-0001.

This document maps every behavioral row owned by batch 2 to the test that covers
it, and records the pre-repair failure evidence required by #21. The automated
gate is `npm test`; every RPC scenario ends with `assertCleanRun` or an exact
`assertOnlyFailures`, asserts exact run/continuation/wrap-up counts, and asserts
the persisted entries. The narrow durability, validation, and injected-fault
seams are unit-tested against a fake Pi API.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| Command surface | Only `/goal resume --budget <new-total>` and `--budget=<new-total>` resume a `budget_limited` Goal | `test/goal10-budget-recovery.test.mjs` ("`/goal resume --budget <new-total>` resumes…"; "`/goal resume --budget=<new-total> is an absolute ceiling…") |
| Bare-resume guidance | Bare `/goal resume` on `budget_limited` is refused with guidance and changes nothing | `test/goal10-budget-recovery.test.mjs` ("a bare resume of a budget_limited Goal is guidance…") |
| Budget option rejected elsewhere | `--budget` is refused for `active`, `paused`, `blocked`, `usage_limited`, and `complete`; their existing lifecycle behavior is unchanged | `test/goal10-budget-recovery.test.mjs` ("…the budget option is refused in every other status"); `test/goal10-budget-recovery-store.test.mjs` ("the budget option is refused for every non-budget_limited status") |
| Edit is independent | `/goal edit` preserves `budget_limited`, starts no work, and does not cancel an owed wrap-up; the wrap-up uses the latest objective | `test/goal10-budget-recovery.test.mjs` ("an objective edit without a resume preserves budget_limited…"); `test/goal10-budget-recovery-store.test.mjs` ("an objective edit before a budget-raising resume has its own revision") |
| Model/ordinary-prompt authority | Ordinary prompts, `create_goal`, and `update_goal` cannot authorize a resume or a budget raise | `test/goal10-budget-recovery.test.mjs` ("ordinary prompts and model tools cannot authorize a resume or a budget raise") |
| Absolute cumulative ceiling | The new value is an absolute total, not an increment; all prior usage stays charged | `test/goal10-budget-recovery.test.mjs` ("`/goal resume --budget=<new-total> is an absolute ceiling…"); `test/accounting.test.mjs` ("a budget-raising resume is an absolute cumulative ceiling with positive headroom") |
| Positive headroom | A value at or below the current `usage.totalTokens` is refused; no resume into an immediate stop | `test/goal10-budget-recovery.test.mjs` ("a budget-raising resume validates positive headroom…"); `test/goal10-budget-recovery-store.test.mjs` ("…refuses a ceiling at or below the accounted usage"); `test/accounting.test.mjs` |
| Configured maximum | `goal.maxTokenBudget` is a hard cap; values above it are refused, never clamped | `test/goal10-budget-recovery.test.mjs` ("…never clamps or uses the default"); `test/goal10-budget-recovery-store.test.mjs` ("…never clamps the configured maximum"); `test/accounting.test.mjs` |
| No implicit default | `goal.defaultTokenBudget` is never resume authority | `test/goal10-budget-recovery.test.mjs` ("…never clamps or uses the default"); `test/accounting.test.mjs` ("…never treats the configured default as implicit authority") |
| Usage preservation | Overshoot and admitted wrap-ups stay charged against the new ceiling | `test/goal10-budget-recovery.test.mjs` ("…preserves identity and usage"); `test/goal10-budget-recovery-store.test.mjs` ("…preserves identity, history, and usage") |
| Atomic transition | Identity, creation time, origin, objective, and complete usage history preserved; revision advances exactly once | `test/goal10-budget-recovery.test.mjs` ("…preserves identity and usage"); `test/goal10-budget-recovery-store.test.mjs` ("…one atomic transition…") |
| Fresh active-time segment | The resumed Goal starts a distinct live segment from the frozen value | `test/goal10-budget-recovery-store.test.mjs` ("a budget-raising resume starts a distinct active-time segment") |
| Commit-before-work | The durable transition precedes the resumed work message and its response | `test/goal10-budget-recovery.test.mjs` ("…preserves identity and usage": snapshot index < resume message index < assistant response) |
| Validation failure is atomic | A refused raise writes nothing and leaves the old budget and wrap-up state | `test/goal10-budget-recovery.test.mjs` ("a budget-raising resume validates positive headroom…"; "malformed budget resume arguments…"); `test/goal10-budget-recovery-store.test.mjs` ("…refuses a ceiling at or below…"; "a bare resume…") |
| Persistence failure is atomic | An injected append failure returns `persistence` and leaves the Goal `budget_limited` with its old budget and owed wrap-up | `test/goal10-budget-recovery-store.test.mjs` ("a persistence failure at the resume commit leaves the Goal budget_limited and unchanged") |
| Pending wrap-up cancelled | A valid raise cancels an undelivered wrap-up; none is delivered | `test/goal10-budget-recovery.test.mjs` ("…cancels the pending wrap-up…"); `test/goal10-budget-recovery-store.test.mjs` ("…cancels the pending old-episode wrap-up") |
| In-flight wrap-up charged | The old wrap-up's admitted usage stays charged; the gate lifts only after the durable raise; no second old wrap-up | `test/goal10-budget-recovery.test.mjs` ("an in-flight old-episode wrap-up stays charged…") |
| Immediate re-exhaustion | Already-admitted in-flight usage can cross the new ceiling; the new episode still earns its own wrap-up | `test/goal10-budget-recovery.test.mjs` ("an in-flight old wrap-up can immediately exhaust the new ceiling…"); `test/goal10-budget-recovery-store.test.mjs` ("resumed work that immediately crosses the new ceiling exhausts it again") |
| Later exhaustion after resume | Resumed work that later exhausts the new ceiling earns exactly one fresh wrap-up and never auto-resumes | `test/goal10-budget-recovery.test.mjs` ("a completed old-episode wrap-up is not reused when the new ceiling is later exhausted") |
| One wrap-up per episode | Each exhaustion episode gets exactly one bounded text-only wrap-up | `test/goal10-budget-recovery.test.mjs` ("…exactly one fresh wrap-up"; "…exactly one wrap-up per exhaustion episode") |
| Migrated exhausted legacy recovery | A cut-over exhausted legacy Goal resumes with positive headroom | `test/goal10-budget-recovery.test.mjs` ("a migrated exhausted legacy Goal recovers with positive headroom…") |
| Configured maximum gates recovery | No positive-headroom resume is possible while the configured maximum equals the usage; raising it later unlocks recovery | `test/goal10-budget-recovery.test.mjs` ("…no resume is possible until the configured maximum rises") |

## Pre-repair failure evidence

The new and rewritten regressions were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `5a55892`) with the new tests in
place. Every narrow store test fails, and the RPC scenarios time out because the
pre-repair command surface has no budget-raising resume. Representative failures:

```text
✖ a budget-raising resume is one atomic transition that preserves identity, history, and usage
  AssertionError: Expected values to be strictly equal

✖ a budget-raising resume refuses a ceiling at or below the accounted usage
  AssertionError: The input did not match the regular expression /strictly greater than/.

✖ a budget-raising resume refuses invalid totals and never clamps the configured maximum
  AssertionError: The input did not match the regular expression /exceeds the configured maximum of 500/.

✖ a bare resume of a budget_limited Goal is refused with guidance
  AssertionError: The input did not match the regular expression /--budget <new-total>/.

✖ a persistence failure at the resume commit leaves the Goal budget_limited and unchanged
  AssertionError: Expected values to be strictly equal

✖ /goal resume --budget <new-total> resumes a budget_limited Goal, cancels the pending wrap-up, and preserves identity and usage
  Error: Timed out waiting for: response for prompt req-5
  (the pre-repair command surface treats `--budget` on resume as an objective,
   so the budget_limited Goal is never resumed)

✖ /goal resume --budget=<new-total> is an absolute ceiling: resumed work that immediately crosses it earns exactly one fresh wrap-up
  Error: Timed out waiting for: response for prompt req-9

✖ a budget-raising resume validates positive headroom and the configured maximum, and never clamps or uses the default
  Error: Timed out waiting for: response for prompt req-13

✖ malformed budget resume arguments are refused with guidance and change nothing
  Error: Timed out waiting for: response for prompt req-18
```

The accounting unit tests fail at import against the pre-repair module:

```text
SyntaxError: The requested module '../src/accounting.ts' does not provide an export named 'resolveResumeTokenBudget'
```

The complete captured run is quoted in the PR description. After the repair, the
same suite passes and `npm run typecheck` passes; the current default-seam counts
are recorded in the PR description.

## Compatibility landing constraint

Batches 1–3 form one mandatory compatibility unit (see #23). This branch is not
independently releasable: cutover without batch 2 leaves migrated
`budget_limited` Goals without the repaired recovery contract, and cutover
without batch 3 cannot advance a preserved legacy audit by identity.
