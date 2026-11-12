# Repair batch 1 traceability: durable Goal ownership and legacy cutover

Issue: #24. Source decisions: #17 (Goal-owned work), #21 (regression contract),
#22 (legacy snapshots), #23 (implementation sequence). Behavior reference:
ADR-0001.

This document maps every defect and behavioral row owned by batch 1 to the test
that covers it, and records the pre-repair failure evidence required by #21. The
automated gate is `npm test`; every RPC scenario ends with `assertCleanRun` or an
exact `assertOnlyFailures`, asserts exact run/continuation counts, and asserts the
persisted entries.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| Stale `complete` | Rejected after identity/revision change, no mutation | `test/goal4-regressions.test.mjs` ("a held completion cannot complete…") |
| Stale model `pause` | Rejected after identity/revision change, no mutation | `test/goal4-regressions.test.mjs` ("a held model pause cannot pause…") |
| Stale `blocked` | Rejected after identity/revision change, no mutation/audit/continuation | `test/goal9-ownership.test.mjs` ("a held blocked report prepared against an edited Goal…") |
| Persistence isolation | Later live mutation never alters an appended snapshot, checkpoint, or reconstructed record | `test/goal9-store.test.mjs` (aliasing tests); `test/store.test.mjs` |
| Non-retroactive `/goal` | The ordinary run the command waited for is never adopted | `test/goal9-ownership.test.mjs` ("/goal issued during an ordinary run…") |
| Non-retroactive `create_goal` | Creating run and same-batch tool results excluded; attribution starts at the first Continuation | `test/goal6.test.mjs` ("create_goal leaves its creating run ordinary…") |
| Ordinary prompts excluded in every status | Paused/blocked/usage-limited/budget-limited/complete ordinary runs add nothing | `test/goal9-ownership.test.mjs` ("an ordinary prompt while a Goal is paused…"); `test/goal6.test.mjs` (budget/complete accounting tests) |
| Replacement starts at zero | Old identity keeps its admitted work; new identity inherits nothing | `test/goal9-ownership.test.mjs` ("a Replacement Goal starts at zero…") |
| Clear boundary | Cleared identity publishes no further usage; a future Goal is not charged | `test/goal9-ownership.test.mjs` ("Clear publishes no further usage…") |
| Admitted in-flight work | Stays attributable through pause/completion/blocked/usage-limit stops | `test/goal9-ownership.test.mjs` ("already-admitted in-flight Goal work stays attributable through a pause"); `test/goal6.test.mjs` (completion/budget tests) |
| Cached/reasoning/nested/compaction | Exactly-once accounting preserved under the ownership boundary | `test/goal6.test.mjs` (cached-read, nested, compaction, retry tests) |
| Live/replay convergence | Restart, reload, crash windows, fork, tree navigation | `test/goal6.test.mjs` (restart/crash); `test/goal7.test.mjs` (fork/tree); `test/goal9-store.test.mjs` (replay mode) |
| Active elapsed time | Only live active segments accrue; live and replay converge | `test/goal6.test.mjs` (active-time tests); `test/store.test.mjs`; `test/accounting.test.mjs` |
| Legacy loadable | Every structurally valid version-1 snapshot/checkpoint stays readable | `test/goal9-legacy.test.mjs` (all statuses) |
| Latest snapshot/tombstone wins | Newest entry controls; malformed latest fails closed with guidance | `test/goal9-legacy.test.mjs` ("a malformed or unrecognized newest legacy snapshot…"); `test/goal7-store.test.mjs` |
| No work from loading | Loading/migration sends no message and triggers no provider request | `test/goal9-legacy.test.mjs` (`runCount === 0` after load) |
| One-time baseline | Legacy totals reconstructed once under 0.1.0 rules and frozen | `test/goal9-legacy.test.mjs` ("a legacy active Goal is cut over once…"); `test/goal9-store.test.mjs` |
| Durable cutover before work | Repaired snapshot plus branch-local marker written before repaired work | `test/goal9-legacy.test.mjs`; `test/goal9-store.test.mjs` |
| Branch-local cutover | Pre-cutover fork migrates; post-cutover fork inherits | `test/goal9-store.test.mjs` ("a pre-cutover fork performs its own migration…") |
| Optional-field defaults | Absent origin/usage/activeMs/wrapUpPending/audit keep 0.1.0 meanings | `test/goal9-legacy.test.mjs` ("0.1.0 optional-field defaults…"); `test/goal9-store.test.mjs` |
| Configured maximum | Hard bound with explicit notice; default never applied retroactively | `test/goal9-legacy.test.mjs` ("the configured maximum clamps…"); `test/goal9-store.test.mjs` |
| Exhausted legacy budget | Active Goal at its effective budget becomes `budget_limited` and earns one wrap-up | `test/goal9-legacy.test.mjs` ("an active legacy Goal already at its budget…") |
| Pending wrap-up at most once | `wrapUpPending: true` delivered once; false/absent creates no duplicate | `test/goal9-legacy.test.mjs` ("a pending legacy wrap-up is delivered at most once") |
| Legacy open audit handoff | Description and count preserved; no text-similarity equivalence | `test/goal9-legacy.test.mjs` ("a legacy open audit is preserved…") |
| Tool-created legacy Goal | Valid historical Goal; migration grants no fresh creation authority | `test/goal9-legacy.test.mjs` ("an existing tool-created legacy Goal…") |

## Pre-repair failure evidence

The new and rewritten regressions were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `a87358d`) with the new tests and
fixtures in place. Representative failures:

```text
✖ /goal issued during an ordinary run never adopts that run's work
  AssertionError: only the aborted kickoff request is charged; the ordinary run is never adopted
    actual: 125, expected: 15

✖ an ordinary prompt while a Goal is paused is not charged
  AssertionError: the ordinary prompt while paused is excluded
    actual: 180, expected: 125

✖ a Replacement Goal starts at zero and never inherits the old identity's usage
  AssertionError: the replacement starts at zero and inherits nothing
    actual: 147, expected: 37

✖ a held blocked report prepared against an edited Goal is refused without mutation
  AssertionError: The input did not match /prepared against a Goal state that has since changed/.
  Input: "Blocker recorded (1 of 3 consecutive Goal turns). …"

✖ create_goal leaves its creating run ordinary and starts attribution at the first Continuation
  AssertionError: 90 !== 33

✖ usage accounting survives a restart and is never charged twice
  AssertionError: actual: 217, expected: 195

✖ budget exhaustion stops continuation after exactly one bounded wrap-up and is never completion
  AssertionError: actual: 145, expected: 130

✖ a legacy active Goal is cut over once, keeps its reconstructed baseline, and continues under repaired attribution
  AssertionError: the legacy snapshot plus the repaired one
    actual: 1, expected: 2

✖ non-active legacy statuses stay stopped, complete stays terminal, and a tombstone leaves no Goal
  AssertionError: legacy-paused.jsonl: cut over once
    actual: 1, expected: 2

✖ a malformed or unrecognized newest legacy snapshot fails closed with guidance and starts no work
  Error: Timed out waiting for: matching extension notify
  (the pre-repair reader silently skipped the corrupt newest entry and fell back)

✖ an active legacy Goal already at its budget becomes budget_limited before work and earns one wrap-up
  Error: Timed out waiting for: matching extension notify
```

The complete captured run is quoted in the PR description. After the repair, the
same suite passes (`npm test`: 214 tests, 0 failures) and `npm run typecheck`
passes.

## Rewritten superseded tests

The following existing tests encoded the pre-repair status-only rule and were
rewritten to the repaired contract rather than deleted:

- `test/goal6.test.mjs`: "a Goal created while a usage-bearing tool is in flight
  charges that tool exactly once" became "create_goal leaves its creating run
  ordinary and starts attribution at the first Continuation".
- `test/goal6.test.mjs`: ordinary follow-up runs in the restart, budget-exhaustion,
  edit, and restored-budget-limited tests no longer add their tokens to the Goal.
- `test/goal7-store.test.mjs`: "reconstruction skips corrupt snapshots instead of
  trusting them" became "reconstruction fails closed on a malformed or
  unrecognized newest snapshot".
- `test/store.test.mjs`: accounting tests now open a Goal-owned segment before
  charging, and replay branches carry the work message that opens the segment.

## Compatibility landing constraint

Batches 1–3 form one mandatory compatibility unit (see #23). This branch is not
independently releasable: cutover without batch 2 leaves migrated
`budget_limited` Goals without the repaired recovery contract, and cutover without
batch 3 cannot advance a preserved legacy audit by identity.
