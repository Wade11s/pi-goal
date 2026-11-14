# Repair issue #37 traceability: Reject stale lifecycle transitions from pre-replacement runs

Issue: #37 (blocks #28). Source decisions: #24 (durable Goal ownership and legacy
cutover, whose **Stale transitions and persistence isolation** row owns the
invariant), #21 (regression and acceptance contract), and the parent Spec #1.
Behavior reference: ADR-0001 (conservative stopping is extension-owned; this
repair does not reopen it).

Real-Pi acceptance for #28 found that a model `update_goal { action: "complete" }`
made in a **follow-up** provider turn of an old Goal's in-flight run completed a
newly created Goal the old run never saw. `turnGoal` was snapshotted at *every*
`turn_start`, so the follow-up turn — which starts only after the replacement —
re-bound to the new identity and the completion was accepted. The new Goal became
`complete` with no work done, its accounted usage stayed at zero, and its kickoff
was suppressed. The existing held-response regressions only covered a turn that
had started *before* the replacement.

This document maps every behavioral row owned by this repair to the test that
covers it, and records the pre-repair failure evidence required by #21. Every
scenario is a real `pi --mode rpc` subprocess with the scripted provider, ends
with `assertStepsConsumed` / `assertCleanRun` (or an exact `assertOnlyFailures`),
rejects unexpected extension errors and unconsumed scripted steps, and asserts the
persisted entries plus the exact run and continuation counts.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| A follow-up turn cannot complete a Goal created after Clear | `/goal clear` plus `/goal <objective>` while the old run is held at a provider gate; the old run's follow-up `complete` is refused, the new Goal keeps `active` at revision 0 with no `complete` snapshot, and its kickoff and one Continuation still run | `test/goal37-stale-execution.test.mjs` ("an old run's follow-up turn cannot complete a Goal created after Clear") |
| A follow-up turn cannot complete a Replacement Goal | The replacement path (confirmation, superseded freeze, steered kickoff) behaves the same: the stale `complete` is refused, the replacement is unmutated, and the old identity's in-flight tail stays on its superseded record | `test/goal37-stale-execution.test.mjs` ("an old run's follow-up turn cannot complete a Goal that replaced it while it was in flight") |
| A follow-up turn cannot report a blocker against the new Goal | The stale `blocked` report records no audit, issues no Blocker identity, and bumps no revision; the new Goal's live status, revision, and usage are unchanged | `test/goal37-stale-execution.test.mjs` ("an old run's follow-up turn cannot report a blocker against a Goal created after Clear") |
| A follow-up turn cannot pause the new Goal | The stale model `pause` — with a corroborated user request on the branch, so only the binding can refuse it — leaves the new Goal `active` at revision 0 | `test/goal37-stale-execution.test.mjs` ("an old run's follow-up turn cannot pause a Goal created after Clear") |
| Rejection admits no stale work and no stale kickoff | No `get_goal` read precedes the refusal, the new Goal's kickoff message is delivered exactly once, exactly one `goal-continuation` entry exists, and the exact run count (old run, new kickoff, one continuation) holds | `test/goal37-stale-execution.test.mjs` (all four rejection tests) |
| Exact new-Goal status / revision / usage | Bare `/goal`'s status report is parsed for the live view: `active`, revision 0, and the exact accounted total (only the new Goal's own kickoff and continuation turns; the replacement case also pins the superseded record's 15 tokens) | `test/goal37-stale-execution.test.mjs` (all four rejection tests) |
| Clean outcomes | Every scenario asserts the exact number of provider responses and the exact failed outcomes (only the deliberately aborted hang, or the deliberate provider error) | `test/goal37-stale-execution.test.mjs` (all seven tests) |
| Preserved: a legitimate transition across a Pi retry | A provider error Pi retries into a second run is the same execution, so the model's completion in the retried run is accepted | `test/goal37-stale-execution.test.mjs` ("a model completion stays legitimate across a Pi provider retry inside one execution") |
| Preserved: a revision change inside one execution | An objective edit issued while the run is held is steered into the running work, so the retried run's completion of the revised Goal is accepted (`complete:2`, not the pre-edit record) | `test/goal37-stale-execution.test.mjs` ("a model completion stays legitimate in a Pi retry after the user revised the Goal") |
| Preserved: a run whose own `create_goal` built the Goal | The creating run stays ordinary, starts no Continuation, and may still complete the Goal its tool result showed it | `test/goal37-stale-execution.test.mjs` ("a run whose own create_goal built the Goal may still complete it") |
| Preserved: the whole repaired contract | Held-response regressions, Replacement/Clear ownership and accounting, budget recovery (including an in-flight wrap-up plus a steered budget-raising resume), Blocker identity, creation authority, and the compact status line | `test/goal4-regressions.test.mjs`; `test/goal8.test.mjs`; `test/goal9-ownership.test.mjs`; `test/goal10-budget-recovery.test.mjs`; `test/goal11-blocker-identity.test.mjs`; `test/goal12-creation-authority.test.mjs` |
| Documentation | README's `update_goal` section states the execution binding rule and its revision-change boundary | `README.md` ("Model tool: `update_goal`") |

No narrow store/unit test was added: the binding rule is observable end to end at
every seam that matters (kickoff, Continuation, provider retry, held response,
Clear, Replacement, edit, model-side creation) through real RPC, and the rule
itself lives in the `turn_start` / `agent_start` / `agent_settled` handlers of
`src/index.ts` rather than in a unit-testable module.

## Pre-repair failure evidence

The new tests were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `77a8ada`, the merged #35 tip) with
the new tests in place. Result: **7 tests, 3 pass, 4 fail** — the four rejection
regressions fail and the three preservation tests pass, which is the intended
split.

```text
✖ an old run's follow-up turn cannot complete a Goal created after Clear
  AssertionError: the stale completion is refused
    false !== true

✖ an old run's follow-up turn cannot complete a Goal that replaced it while it was in flight
  AssertionError: the stale completion is refused
    false !== true

✖ an old run's follow-up turn cannot report a blocker against a Goal created after Clear
  'Blocker recorded (1 of 3 consecutive Goal turns). Blocker identity blocker_e0ce8abd: …'

✖ an old run's follow-up turn cannot pause a Goal created after Clear

✔ a model completion stays legitimate across a Pi provider retry inside one execution
✔ a model completion stays legitimate in a Pi retry after the user revised the Goal
✔ a run whose own create_goal built the Goal may still complete it
```

The blocked case is the clearest statement of the defect: pre-repair, the old
run's follow-up turn recorded a blocker against the Goal it never saw and issued
it a Blocker identity, mutating the new Goal's audit and revision.

After the repair all seven tests pass, `npm test` passes (447/447), and
`npm run typecheck` passes; the exact gate output is recorded in the PR
description.

## What the repair changes

`turnGoal` is no longer a per-turn snapshot. It is the Goal identity and revision
the **execution** was admitted against, and it is re-admitted only to the identity
it already holds:

- `turn_start` re-admits the current Goal when the execution has no binding yet
  (which is what lets a run whose own `create_goal` built a Goal act on it, since
  the tool result is what showed it that Goal) or when the current Goal has the
  **same identity** (a revision change — an edit, a pause and resume, a budget
  raise — is steered into the running work, so the model has seen it). A
  **different identity** is never adopted, so a follow-up turn of a run whose Goal
  was cleared or replaced keeps the identity it started with and is refused.
- `agent_start` clears the binding when the run opens a new execution, and keeps
  it when the run is Pi's retry of the one before it — a failed provider request
  or a response compaction recovered — which is the same execution.
- `agent_settled` clears the binding, because settlement ends the execution: the
  Goal a user created in the meantime then kicks off and continues normally.

`session_tree` still deliberately leaves the binding untouched, so a turn that
raced a navigation is refused rather than handed a fresh binding.

Nothing else changes: no lifecycle status, threshold, token rule, revision rule,
replay rule, completion-evidence rule, or creation-authority rule is touched, and
no command handler, store method, or message shape moved.

## Known boundary

A run admitted against **no** Goal at all (an ordinary prompt run) can still be
admitted to a Goal the user creates with `/goal <objective>` while that run is in
flight, because the `/goal` command waits for idle before delivering its kickoff
and the binding is empty. That is pre-repair behavior, is outside this issue's
"pre-replacement run" scope, and is not covered by any existing test; closing it
would require distinguishing a Goal the model created from one a user command
created mid-run, which this focused repair deliberately does not attempt.
