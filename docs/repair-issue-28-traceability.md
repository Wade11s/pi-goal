# Repair issue #28 traceability: integrated V1 acceptance

Issue: #28 (batch 5 of 5, verification-only). Source decisions: #17 (Goal-owned
work), #18 (creation authority), #19 (budget-limited resume), #20 (Blocker
identity), #21 (regression and acceptance contract), #22 (legacy snapshots), #23
(implementation sequence). Parent Spec: #1. Behavior reference: ADR-0001.

This document is the single integrated evidence matrix required by #21 and #28:
every reviewed V1 defect and behavioral decision maps to named test evidence and
the repair PR that supplied it, plus the clean-outcome audit, the automated
gates, the documentation audit, and the final real-Pi smoke record.

The integrated commit is `85bb636219e9261bed8a1c93c0c67b57239dec33`
(`repair/28-integrated-acceptance`, the merge of
`origin/integration/spec-1-v1-repair` at
`35063e0da0aa384a86fd4c7d3694e53602593dd2`, the merge of PR #38). The four
cross-contract regressions from the initial acceptance attempt are preserved on
top of it.

## Integrated decision-to-evidence matrix

The per-batch matrices remain authoritative for the detailed rows and the
pre-repair failure captures:

- `docs/repair-batch-1-traceability.md` — PR #29 (#24), decisions #17/#21/#22/#23.
- `docs/repair-batch-2-traceability.md` — PR #31 (#25), decisions #17/#19/#21/#22/#23.
- `docs/repair-batch-3-traceability.md` — PR #32 (#26), decisions #20/#21/#22/#23.
- `docs/repair-batch-4-traceability.md` — PR #33 (#27), decisions #17/#18/#21/#23.
- `docs/repair-issue-34-traceability.md` — PR #35 (#34), decisions #21/#24.
- `docs/repair-issue-37-traceability.md` — PR #38 (#37), decisions #21/#24.

| Decision / defect | Contract | Named test evidence | Repair PR |
| --- | --- | --- | --- |
| #17 Goal-owned work | Only admitted Goal work is charged; ordinary prompts and creation controls are excluded in every status | `test/goal6.test.mjs` (create_goal non-retroactive, cached/reasoning/nested/compaction, restart/crash); `test/goal9-ownership.test.mjs` (ordinary prompts, replacement, Clear, admitted tails); `test/accounting.test.mjs` | #29 |
| #17 Attribution boundaries | `/goal` starts at its kickoff; `create_goal` starts at the first Continuation; replacement starts at zero | `test/goal6.test.mjs` ("create_goal leaves its creating run ordinary…"); `test/goal9-ownership.test.mjs` ("a Replacement Goal starts at zero…"); `test/goal12-creation-authority.test.mjs` | #29 |
| #17 Stale transitions | A model transition prepared against an old identity/revision is refused with no mutation | `test/goal4-regressions.test.mjs` (held complete/pause); `test/goal9-ownership.test.mjs` (held blocked); `test/goal9-store.test.mjs` (same-turn stale blocked); `test/goal37-stale-execution.test.mjs` (follow-up turns) | #29, #38 |
| #17 Snapshot/replay isolation | Later live mutation never alters an appended snapshot/checkpoint; replay converges | `test/goal9-store.test.mjs` (aliasing, rollback, replay); `test/store.test.mjs`; `test/goal7.test.mjs` (fork/tree) | #29 |
| #17 Active elapsed time | Only live active segments accrue; live and replay converge | `test/goal6.test.mjs`; `test/store.test.mjs`; `test/accounting.test.mjs`; `test/goal34-active-time-stop.test.mjs`; `test/goal34-active-time-stop-store.test.mjs` | #29, #35 |
| #18 Creation authority | `create_goal` requires a verbatim, affirmative, currently authoritative request; fail-closed otherwise | `test/goal12-creation-authority.test.mjs`; `test/goal12-creation-authority-store.test.mjs`; `test/goal12-pause-corroboration.test.mjs` | #33 |
| #18 Pause corroboration | Model pause requires an explicit user request, quoted and corroborated | `test/goal12-pause-corroboration.test.mjs`; `test/goal12-creation-authority.test.mjs` | #33 |
| #19 Budget recovery | Only `/goal resume --budget <new-total>` resumes a `budget_limited` Goal; absolute cumulative ceiling; positive headroom; configured maximum | `test/goal10-budget-recovery.test.mjs`; `test/goal10-budget-recovery-store.test.mjs`; `test/accounting.test.mjs` | #31 |
| #19 Per-episode wrap-ups | Exactly one bounded wrap-up per exhaustion episode; a raise cancels an undelivered one; an in-flight one stays charged | `test/goal10-budget-recovery.test.mjs`; `test/goal10-budget-recovery-store.test.mjs`; `test/goal9-legacy.test.mjs` (legacy pending wrap-up) | #31 |
| #20 Blocker identity | Opaque, extension-issued identity; reworded reuse advances; omission starts fresh; unknown ID refused without mutation | `test/goal11-blocker-identity.test.mjs`; `test/goal11-blocker-identity-store.test.mjs`; `test/goal5.test.mjs` | #32 |
| #20 Conservative stopping | Deterministic activity-free and execution-unavailable bounds; provider-failure classification | `test/goal5.test.mjs`; `test/goal5-provider-failures.test.mjs`; ADR-0001 | #32 (audit contract) |
| #22 Legacy snapshots | Every valid 0.1.0 snapshot loads; malformed newest fails closed; one-time reconstructed totals; durable branch-local cutover; no work from loading | `test/goal9-legacy.test.mjs`; `test/goal9-store.test.mjs`; `test/goal7-store.test.mjs` | #29 |
| #22 Legacy audit handoff | A valid open legacy audit is preserved and issued a fresh identity; no extra turns | `test/goal9-legacy.test.mjs`; `test/goal11-blocker-identity.test.mjs`; `test/goal11-blocker-identity-store.test.mjs` | #32 |
| #34 Blocked/usage-limited active time | The clock stops at the blocked threshold and on `usage_limited`, before the stop snapshot; no interval after | `test/goal34-active-time-stop.test.mjs`; `test/goal34-active-time-stop-store.test.mjs` | #35 |
| #37 Execution binding | A follow-up turn of a run admitted against a cleared/replaced identity cannot complete, report a blocker against, or pause the new Goal; legitimate same-execution transitions survive Pi retries, compaction, edits, and model-created Goals | `test/goal37-stale-execution.test.mjs` (ten RPC scenarios: seven rejections, three preservation guards) | #38 |
| #28 cross-contract | Stale transition across a budget-raising resume | `test/goal13-integrated-acceptance.test.mjs` ("a held model transition is stale after a budget-raising resume") | #28 (this branch) |
| #28 cross-contract | Tool-created Goal replacement ownership and superseded attribution | `test/goal13-integrated-acceptance.test.mjs` ("a tool-created Goal replaced by /goal charges only its Goal-owned Continuation work…") | #28 (this branch) |
| #28 cross-contract | Tool-created Goal cumulative budget recovery | `test/goal13-integrated-acceptance.test.mjs` ("a tool-created Goal's budget exhaustion recovers through a cumulative raise") | #28 (this branch) |
| #28 cross-contract | Tool-created Goal Blocker identity issuance and advancement | `test/goal13-integrated-acceptance.test.mjs` ("a tool-created Goal's blocked audit issues and advances a Blocker identity") | #28 (this branch) |

## Pre-repair failure evidence

Every new regression was demonstrated failing on the pre-repair `src/` before its
repair merged. The exact captured failures are quoted in the per-batch
traceability documents and in PR #35:

- Batch 1: `docs/repair-batch-1-traceability.md` ("Pre-repair failure evidence"
  and the four review follow-ups).
- Batch 2: `docs/repair-batch-2-traceability.md`.
- Batch 3: `docs/repair-batch-3-traceability.md`.
- Batch 4: `docs/repair-batch-4-traceability.md`.
- Issue #34: `docs/repair-issue-34-traceability.md` (5 store probes, 1 pass / 4
  fail, plus the real-Pi RPC regression).
- Issue #37: `docs/repair-issue-37-traceability.md` (10 tests, 3 pass / 7 fail).

The four #28 cross-contract tests were prepared during the initial acceptance
attempt and re-run against the repaired integrated commit; all four pass. They
are additive and follow the suite's honesty rules.

## Clean-outcome audit

The default seam is `npm test` → `node --test --test-concurrency=4 test/`.
Every RPC scenario ends with `assertCleanRun` or an exact `assertOnlyFailures`,
asserts exact continuation/run counts, and asserts persisted entries. The four
#28 cross-contract tests follow the same rules:

| Test | End-of-run assertion | Script consumed |
| --- | --- | --- |
| stale transition after budget-raising resume | `assertStepsConsumed(session, 7, [error, aborted])` + `assertOnlyFailures` | exact |
| tool-created Goal replaced by `/goal` | `assertStepsConsumed(session, 5, [aborted])` + `assertOnlyFailures` | exact |
| tool-created Goal budget recovery | `assertStepsConsumed(session, 7, [aborted])` + `assertOnlyFailures` | exact |
| tool-created Goal Blocker identity | `assertStepsConsumed(session, 9)` + `assertCleanRun` | exact |

The ten issue-#37 RPC scenarios follow the same rules: each asserts the exact
number of provider responses, the exact failed outcomes, the persisted
snapshots, and the exact run/continuation counts. No scenario can pass through
script exhaustion, timeout, accidental abort, or an unplanned settle. The full
suite reports zero unconsumed scripted steps.

## Automated gates (integrated commit `85bb636`)

| Gate | Result |
| --- | --- |
| `npm test` | **454 tests, 454 pass, 0 fail, 0 skipped** (49.3 s) |
| `npm run typecheck` | **exit 0** (`tsc --noEmit`, no output) |
| `node --test test/goal34-active-time-stop.test.mjs test/goal34-active-time-stop-store.test.mjs test/goal37-stale-execution.test.mjs test/goal13-integrated-acceptance.test.mjs` | **21 pass, 0 fail** |

One earlier default run under host load hit an assertion flake (`actual: 3,
expected: 5`); five subsequent consecutive default runs passed 444/444. The
batch-4 traceability records the same resource-contention flake class and the
`--test-concurrency=4` bound that addresses it. The merged integrated commit
adds the ten #37 tests to that total (444 + 10 = 454).

## Documentation audit

Verified against the integrated commit:

- `README.md` — Goal-owned accounting and Active elapsed time (the active-time
  paragraph names every non-active status: `paused`, `blocked`, `usage_limited`,
  `budget_limited`, `complete`); explicit creation authority and fail-closed
  rejection; cumulative budget recovery and per-episode wrap-ups; Blocker
  identity and deterministic conservative stopping; legacy reconstructed totals,
  durable branch-local cutover, migration notices, and lifecycle preservation;
  the #37 execution-binding rule for model-side transitions (including the two
  distinct reasons a same-identity revision change is accepted and the
  no-binding refusal); current command/tool surfaces, limitations, and
  verification commands.
- `docs/smoke-test.md` — procedure and checklist synchronized; includes the
  blocked/`usage_limited` active-time verification step.
- `GLOSSARY.md` — the Active elapsed time and Blocker identity definitions match
  the repaired behavior; the invariant already read "excluding every non-active
  status".
- `docs/adr/0001-conservative-stopping.md` — the deterministic stopping rules and
  the four repair-batch amendments match the implementation.

No inaccuracy was found. The only documentation changes in this branch are the
smoke-test/README active-time checklist item and this integrated traceability
document.

## Final real-Pi interactive smoke

Run against the integrated commit `85bb636` with a real configured Pi
installation and a real provider.

| Field | Value |
| --- | --- |
| Date | 2026-11-14T21:17:34Z (2026-11-15 05:17 +08:00) |
| Pi version | **1.5.2** (`pi --version`) |
| Node | v26.13.1 |
| Environment | macOS (Darwin arm64), `pi --mode rpc`, extension loaded from the acceptance worktree |
| Provider | `magpie/deepai/deepseek-v4.1-flash` (configured, ready; local Magpie endpoint) |
| Package install | `pi install --local <worktree>` in a clean project; `pi list` shows it under Project packages |
| Commit | `85bb636219e9261bed8a1c93c0c67b57239dec33` |

Checklist results (real provider, one persisted session):

| # | Checklist item | Result |
| --- | --- | --- |
| 1 | Install and version visibility | PASS — Pi 1.5.2, project package listed |
| 2 | Bare `/goal` with no Goal | PASS — "No Goal is set…" |
| 3 | `/goal <objective>` creation and initial work | PASS — "created and activated", work ran |
| 4 | Automatic continuation at settlement | PASS — 2 `goal-continuation` entries |
| 5 | Status indicator | PASS — `active · <tokens> tok · <active time>` |
| 6 | Evidence-based completion | PASS — all three files verified, `complete` revision 1, 28,545 accounted tokens |
| 7 | Accurate `/goal` report | PASS — objective, revision, usage, active time |
| 8 | `/goal clear` and durable tombstone | PASS — tombstone snapshot; bare `/goal` reports none |
| 9 | Bare `/goal edit` editor | PASS — prefilled dialog answered; revision 0 → 1; usage preserved |
| 10 | `/goal pause` | PASS — paused; continuation and run counts unchanged over 8 s idle |
| 11 | `/goal resume` | PASS — resumed (revision 3); work restarted |
| 12–20 | Budget exhaustion, refusals, cumulative raise, restart persistence, clear/tombstone reload, blocked active-time freeze | NOT COMPLETED — the budget phase exposed a new behavior defect (below), so the run stopped per #28's verification-only rule |

Supplementary real-provider checks run against the same commit while isolating
the two focused repairs:

- **Blocked active time frozen.** A real-provider Goal reached `blocked` through
  the three-turn Blocker-identity chain (`Blocked audit: 3 of 3`). Its reported
  Active time stayed at **88 s** across 8 s of idle time and across a process
  restart, with 0 runs on load. `usage_limited` needs a real provider usage-limit
  error and is covered by the deterministic `test/goal34-active-time-stop.test.mjs`
  / `-store.test.mjs` regressions (both pass).
- **Old run's follow-up cannot complete/block/pause a newly created Goal.**
  Confirmed by the existing deterministic regressions
  `test/goal37-stale-execution.test.mjs`: "an old run's follow-up turn cannot
  complete a Goal created after Clear", "…cannot report a blocker against a Goal
  created after Clear", and "…cannot pause a Goal created after Clear" (all pass),
  plus the retry-window and preservation guards.

The deterministic RPC suite remains the automated gate; this smoke does not
replace it.

## Defect status

### Former defect (fixed): stale follow-up transitions

The initial acceptance attempt found that a model `update_goal` complete in a
follow-up provider turn of an old Goal's in-flight run completed a newly created
Goal. That was filed as #37 and fixed by PR #38 (`turnGoal` is now the
execution's binding, re-admitted only to the identity it holds; `blocked` is
bound like `complete`/`pause`). The ten `test/goal37-stale-execution.test.mjs`
scenarios pass on `85bb636`. It no longer blocks acceptance.

### Newly found defect (not fixed here): a stale queued work message adopts a newly created Goal

While rerunning the final smoke, the budget phase exposed a second hostile-order
defect in the same family. It is recorded here per #28's verification-only rule
and is **not repaired in this branch**.

**Symptom.** A pi-goal work message that was queued for a Goal which is then
cleared or replaced is delivered after the new Goal is committed. Because it
carries the `[pi-goal]` prefix, `applyDeliveredUserMessage` treats it as the new
Goal's own admission segment, and the old run's subsequent provider turns are
charged to the new identity. A Goal created with `--budget 1` becomes
`budget_limited` from the old run's usage even though its own kickoff was never
started.

**Deterministic reproduction** (real `pi --mode rpc`, scripted provider, from the
repo harness):

1. `/goal Objective B`; hold the kickoff response at a provider gate.
2. `/goal pause`, then `/goal resume` while the run is busy — the resume work
   message is queued as a steer.
3. `/goal clear`, then `/goal --budget 1 New objective C` — C commits
   `active:0` and waits for the in-flight run.
4. Release the gate. The queued Goal-B resume message is delivered after C
   exists; the old run's next response carries scripted usage `input 100 /
   output 40`.

Observed result:

```text
SNAPSHOTS: [
  'goal_96ed0497:active:rev0:tok0',
  'goal_96ed0497:paused:rev1:tok0',
  'goal_96ed0497:active:rev2:tok0',
  'tombstone',
  'goal_c5457d17:active:rev0:tok0',
  'goal_c5457d17:budget_limited:rev1:tok140'
]
PI-GOAL WORK MESSAGES: B kickoff, B resume   (no C kickoff, 0 continuations)
CREATION WARNING: Goal goal_c5457d17 was not started: it changed while creation
waited for the current run to finish (now budget_limited, revision 1). Initial
work was not started; the current state stands.
```

C's ledger absorbed 140 tokens from B's resumed run even though C never started
and B had been cleared. The same interleaving occurred in the real-provider smoke
with a real model (C reached `budget_limited` with 505 accounted tokens and the
same "was not started" warning).

**Why it violates the decided contract.** Decision #17 says Clear "never
reassigns that work to a future Goal", that `/goal` "starts attribution at its
actual kickoff", and that "an ordinary run that the command waited for is never
adopted." `applyDeliveredUserMessage`'s own comment states that opening the
segment at delivery is what "stops a work message queued for a Goal that has
since been replaced, cleared, or completed from opening anything"; the
implementation checks only the `[pi-goal]` prefix and the Goal current at
delivery, not the identity named in the message.

**Impact.** A user who resumes a Goal while a run is in flight and then clears or
replaces that Goal before the queued resume/edit/kickoff lands can have the new
Goal charged the old run's usage. With a small budget the new Goal is instantly
`budget_limited` with no work done; with any budget the new identity inherits
usage it never owned.

**Relationship to #37.** #37's known boundary covers a run admitted against *no*
Goal adopting a Goal created mid-run. This defect is different: the execution was
admitted against the cleared identity, and the reassignment happens through a
queued pi-goal work message rather than a model lifecycle transition.

Acceptance is **not declared** while this defect is open. The integrated matrix,
clean-outcome audit, automated gates, and documentation audit above are
complete; the final real-Pi checklist stopped at the budget phase because of this
defect. It needs a focused repair issue; #1 and #28 stay open.
