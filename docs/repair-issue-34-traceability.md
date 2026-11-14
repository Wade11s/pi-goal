# Repair issue #34 traceability: Active elapsed time stops at every non-active status

Issue: #34 (blocks #28). Source decisions: #24 (durable Goal ownership and legacy
cutover, whose **Active elapsed time** row owns the invariant), #21 (regression
contract), and the parent Spec #1. Behavior reference: ADR-0001.

Real-Pi acceptance for #28 found Active elapsed time still accruing after a Goal
entered `blocked` or `usage_limited`: about +72 seconds of blocked time after a
blocked Goal edit, a separate blocked Goal that kept accruing after a restart, and
store probes that reproduced both. The two transitions that missed the stop were
the blocked threshold in `markBlockedReport` and `usage_limited` in `stopGoal`;
completion, pause, and budget exhaustion already stopped the clock.

This document maps every behavioral row owned by this repair to the test that
covers it, and records the pre-repair failure evidence required by #21. The
automated gate is `npm test`; the RPC scenario ends with `assertCleanRun`, asserts
exact run/continuation counts, and asserts the persisted entries.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| Blocked threshold stops the clock | `markBlockedReport` at `BLOCKED_AUDIT_THRESHOLD` stops the clock and the stop snapshot carries the folded value | `test/goal34-active-time-stop-store.test.mjs` ("a Goal blocked at the audit threshold…"); `test/goal34-active-time-stop.test.mjs` |
| `usage_limited` stops the clock | `stopGoal` for a provider usage limit stops the clock before the snapshot is committed | `test/goal34-active-time-stop-store.test.mjs` ("a usage_limited stop freezes active time…") |
| Conservative stop stops the clock | `stopGoal` for an extension-owned `blocked` stop behaves identically | `test/goal34-active-time-stop-store.test.mjs` ("a conservative stop blocks the same way…") |
| No interval after the stop | Later snapshots, checkpoints, and a reconstruction all read the frozen value | `test/goal34-active-time-stop-store.test.mjs` (all three rows above, plus "a reconstruction of a stopped branch…"); `test/goal34-active-time-stop.test.mjs` (post-block idle, an ordinary run, and the checkpoint assertions) |
| Live and replay converge after a restart | A restart resumes from the frozen value and adds neither the stopped interval nor process downtime | `test/goal34-active-time-stop.test.mjs` ("a blocked Goal stops its active-time clock, and a restart never resumes it") |
| Pre-threshold reports keep the clock running | A recorded report below the threshold leaves the Goal active and accruing | `test/goal34-active-time-stop-store.test.mjs` ("a Goal blocked at the audit threshold…") |
| A failed stop keeps the clock running | A persistence failure at either transition leaves the Goal active with its clock running | `test/goal34-active-time-stop-store.test.mjs` ("a failed stop leaves the Goal active and its clock running") |
| A failed stop leaves the folded interval recoverable | The durable watermark advances only *after* the stop snapshot is written, so a crash window cannot lose the folded interval: it stays unpersisted, the next checkpoint carries it, and a reconstruction recovers it | `test/goal34-active-time-stop-store.test.mjs` ("a failed stop leaves the Goal active…" for both transitions, and "a failed stop write leaves the folded interval check-pointable instead of losing it") |
| Preserved behavior | Token totals, revision/identity, continuation stopping, pause/complete/budget-limited stops, replay and cutover | `test/goal6.test.mjs` (active-time, restart, and checkpoint tests); `test/goal9-store.test.mjs`; `test/goal10-budget-recovery-store.test.mjs`; `test/goal11-blocker-identity.test.mjs`; `test/goal34-active-time-stop.test.mjs` (105 accounted tokens, revision 3, three continuations) |
| Documentation | README's active-time wording names every non-active status | `README.md` ("Active time" in **Usage accounting**) |

## Pre-repair failure evidence

The new tests were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `7374717`, the merged batch-4 tip) with
the new tests in place. The narrow store probes: **5 tests, 1 pass, 4 fail.**

```text
✖ a Goal blocked at the audit threshold stops its active-time clock at the transition
  AssertionError: the stop snapshot carries the folded active time
    actual: 40.711917, expected: 80.93841699999999

✖ a usage_limited stop freezes active time in the snapshot and in later checkpoints
  AssertionError: the stop snapshot carries the folded value
    actual: 0.026250000000004547, expected: 40.960791

✖ a reconstruction of a stopped branch reads the frozen active time and adds no interval
  AssertionError: the reloaded clock is frozen at the stopped value
    actual: 0, expected: 0.2258329999999944

✖ a conservative stop blocks the same way as the audit threshold
  AssertionError: a conservatively stopped Goal accrues no further active time
    actual: 122.81979199999995, expected: 41.56870799999996

✔ a failed stop leaves the Goal active and its clock running
```

The real-Pi RPC regression reproduces the acceptance finding in miniature: the
Goal is provably active and idle for two held turns, then blocked, then held idle
for two further seconds.

```text
✖ a blocked Goal stops its active-time clock, and a restart never resumes it
  AssertionError: a blocked Goal accrues no further active time
    actual: 5, expected: 3
```

After the repair both files pass, `npm test` passes, and `npm run typecheck`
passes; the exact gate output is recorded in the PR description.

## What the repair changes

`markBlockedReport` and `stopGoal` now stop the active-time clock at the
transition, exactly as `markComplete`, `markPaused`, and `markBudgetLimited`
already did, and the snapshot they commit carries the folded value rather than the
record's last-refreshed view.

The folded interval is marked durable only **after** that snapshot is written, in
the same order as `markComplete` and `markPaused`: the write is what makes it
durable. Marking it first would advance the watermark past what the branch
records, so an unclean exit between a failed write and the next boundary would
silently lose the interval instead of leaving it for a checkpoint. A write failure
now restarts the clock with the folded interval still unpersisted, so the next
boundary checkpoints it and a reconstruction recovers it. Nothing else changes:
no lifecycle status, threshold, token rule, revision rule, or replay rule is
touched.
