# Repair issue #39 traceability: Bind delivered Goal work messages to their admitted identity

Issue: #39 (blocks #28). Source decisions: #17 (identity-scoped Goal-owned work
attribution, whose **Token usage** rows 1, 2, and 5 own the invariant), #21
(regression and acceptance contract), and #24 (durable Goal ownership, whose
**Stale transitions and persistence isolation** and **Goal-owned token
accounting** rows own the superseded-tail and replay-convergence invariants).
Behavior reference: ADR-0001 (conservative stopping is extension-owned; this
repair does not reopen it).

Real-Pi acceptance for #28 found that a pi-goal work message queued for a Goal
that is then cleared or replaced is delivered after the new Goal commits.
`applyDeliveredUserMessage` recognized only the generic `[pi-goal]` prefix, so it
opened the *new* Goal's admission segment and the old run's subsequent provider
turns were charged to the new identity. A Goal created with `--budget 1` became
`budget_limited` from the old run's usage even though its own kickoff was never
started. This violates decision #17: Clear never reassigns work to a future
Goal, `/goal` starts attribution at its actual kickoff, and Goal-owned usage is
identity-scoped.

This document maps every behavioral row owned by this repair to the test that
covers it, and records the pre-repair failure evidence required by #21. Every
RPC scenario is a real `pi --mode rpc` subprocess with the scripted provider,
ends with `assertStepsConsumed` / `assertOnlyFailures`, rejects unexpected
extension errors and unconsumed scripted steps, and asserts the persisted
entries plus the exact run and continuation counts.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| A stale queued resume for a cleared Goal opens nothing | `/goal:pause` then `/goal:resume` while the kickoff is held at a provider gate; `/goal:clear` then `/goal --budget 1 <objective>`; the queued resume names the cleared identity, so the new Goal's own kickoff still runs exactly once and only its own work is charged | `test/goal39-work-message-identity.test.mjs` ("a stale queued resume for a cleared Goal cannot open the new Goal's admission") |
| A stale queued resume for a replaced Goal opens nothing | The replacement path (confirmation, superseded freeze, steered kickoff) behaves the same: the queued resume names the old identity, the old in-flight tail stays on its superseded record, and the replacement starts at zero | `test/goal39-work-message-identity.test.mjs` ("a stale queued resume for a replaced Goal stays on the old identity and never opens the replacement") |
| The new Goal starts at zero and is not stopped by the old identity's work | C's creation snapshot is `active:0`; after the stale message C's total is exactly its own kickoff (22) plus its own wrap-up (15), never B's 140; C's budget stop is derived from its own kickoff | `test/goal39-work-message-identity.test.mjs` (the cleared scenario's exact totals and wrap-up assertions) |
| The new Goal retains its own legitimate kickoff and Continuation | C's kickoff message is delivered exactly once, C earns exactly one Continuation (or its own wrap-up when over budget), and B earns no Continuation and no wrap-up | `test/goal39-work-message-identity.test.mjs` (cleared and replaced scenarios) |
| A generic `[pi-goal]` prefix alone authorizes nothing | A prefixed message that names no Goal closes the segment like an ordinary prompt, live and on replay | `test/goal39-work-message-identity-store.test.mjs` ("a prefixed message with no identity closes the segment like an ordinary prompt") |
| Every work message kind carries its admitted identity | The kickoff, edit, resume, Continuation, and Budget wrap-up headers all parse to the same Goal id; the objective data cannot smuggle a second identity into the header | `test/goal39-work-message-identity-store.test.mjs` ("every work message kind names its admitted Goal identity, and a generic prefix names none") |
| Replay draws the same line as live | A branch carrying a stale work message for a cleared or replaced identity reconstructs the new Goal at its own exact total, with the old identity's tail on its superseded record and the new Goal's own segment open | `test/goal39-work-message-identity-store.test.mjs` (the two stale-message replay tests and "a branch ending in a stale work message leaves the current Goal unowned") |
| Preserved: legitimate same-identity delivery | A resume for the Goal that is still current opens its own admission; the resumed turn is charged to the same identity | `test/goal39-work-message-identity.test.mjs` ("a legitimate same-identity resume still opens its own Goal's admission") |
| Preserved: the whole repaired contract | Held-response regressions, Replacement/Clear ownership and accounting, budget recovery, Blocker identity, creation authority, active-time stops, and stale lifecycle transitions | `test/goal4-regressions.test.mjs`; `test/goal9-ownership.test.mjs`; `test/goal10-budget-recovery.test.mjs`; `test/goal11-blocker-identity.test.mjs`; `test/goal12-creation-authority.test.mjs`; `test/goal34-active-time-stop.test.mjs`; `test/goal37-stale-execution.test.mjs` |
| Documentation | README's admission-segment paragraph and the GLOSSARY's **Admission segment** entry state that a work message names its admitted identity and a generic prefix alone never authorizes admission | `README.md`; `GLOSSARY.md` |

`test/goal9-ownership.test.mjs` ("creating a Goal after a Clear closes the old
admission so live and replay agree") was rewritten for the corrected contract: it
now also queues the replacement's own kickoff for an identity that is then
cleared, so the new Goal's total is its own aborted kickoff (15), not the old
identity's steered response (22) plus its own (15). The previous expectation
encoded the superseded behavior this repair removes.

## Pre-repair failure evidence

The new tests were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `35063e0`, the merged #38 tip) with the
new tests in place. Result: the two stale-message regressions fail and the
preservation test passes — the intended split.

```text
✖ a stale queued resume for a cleared Goal cannot open the new Goal's admission
  AssertionError: C's own kickoff was not suppressed
    1 !== 0

✖ a stale queued resume for a replaced Goal stays on the old identity and never opens the replacement
  AssertionError: only the replacement's own kickoff and aborted Continuation are charged
    177 !== 37

✔ a legitimate same-identity resume still opens its own Goal's admission
```

The rewritten existing regression fails the same way:

```text
✖ creating a Goal after a Clear closes the old admission so live and replay agree
  AssertionError: only the aborted C kickoff is charged; A's late response and the cleared B identity's steered kickoff are charged to nobody
    37 !== 15
```

The pre-repair live state for the cleared scenario is exactly the one recorded on
issue #28:

```text
SNAPSHOTS: [
  'goal_cce0ae9c:active:rev0:tok0',
  'goal_cce0ae9c:paused:rev1:tok0',
  'goal_cce0ae9c:active:rev2:tok0',
  'tombstone:-:rev-:tok-',
  'goal_fb78ea15:active:rev0:tok0',
  'goal_fb78ea15:budget_limited:rev1:tok140'
]
GOAL goal_34c6f028 reached its token budget of 1 tokens (140 accounted) and is now budget_limited.
```

C's ledger absorbed 140 tokens from B's resumed run even though C never started
and B had been cleared. After the repair the same scenario leaves C with exactly
its own 22-token kickoff (plus its own 15-token wrap-up), B at zero, and C's own
kickoff delivered once.

## What the repair changes

- `goalWorkGoalId(text)` reads the Goal identity from the first line of a work
  message. Every pi-goal work message already names its Goal there (kickoff,
  edit, resume, Continuation, Budget wrap-up); the objective is delimited data
  below the header, so it cannot smuggle a second identity. A message that
  carries the prefix but names no Goal is not admitted work.
- `ownershipMarker` carries that identity on the `goal-work` marker, for both
  user messages and the two Goal custom-message channels. The branch replay and
  the live delivery seam therefore read the same fact.
- `applyDeliveredUserMessage` opens the current Goal's admission only when the
  delivered message names that exact identity. A stale message for a cleared or
  replaced Goal opens nothing; the generic prefix alone authorizes nothing.
- `GoalStore.replayBranch` applies the same rule: a delivered user message is a
  freeze boundary for the superseded identity's open tail, and it opens a segment
  only for the identity it names when that identity is the current snapshot's. A
  stale message opens nothing, so the old run's later turns are charged to
  nobody rather than to the new Goal.
- `GoalStore.applyBranchOwnership` binds the reconstructed live segment only when
  the last work message names the *current* identity, so a branch ending in a
  stale message leaves the current Goal's turns unbound.

Nothing else changes: no lifecycle status, threshold, token rule, revision rule,
completion-evidence rule, creation-authority rule, or command/tool surface is
touched. The superseded-tail freeze boundaries, Clear's tombstone semantics, and
the already-admitted in-flight tail are preserved; the full `npm test` suite
passes.

## Known boundary

A work message that names the *current* Goal still opens its admission, exactly
as before. The trust boundary is unchanged: a human-typed prompt never starts
with `[pi-goal]`, and a message that does is extension-authored. The repair
closes the identity-confusion hole (a message queued for one Goal adopted by a
different Goal created after it), not the older prefix-forgery boundary, which
is out of scope for this focused repair.
