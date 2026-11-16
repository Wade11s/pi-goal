# Repair issue #28 traceability: integrated V1 acceptance

Issue: #28 (batch 5 of 5, verification-only). Source decisions: #17 (Goal-owned
work), #18 (creation authority), #19 (budget-limited resume), #20 (Blocker
identity), #21 (regression and acceptance contract), #22 (legacy snapshots), #23
(implementation sequence). Parent Spec: #1. Behavior reference: ADR-0001.

This document is the single integrated evidence matrix required by #21 and #28:
every reviewed V1 defect and behavioral decision maps to named test evidence and
the repair PR that supplied it, plus the clean-outcome audit, the automated
gates, the documentation audit, and the final real-Pi smoke record.

The integrated commit is `45f7efcb0559acd43055986bd9161aba3217935d`
(`repair/28-integrated-acceptance`, the merge of
`origin/integration/spec-1-v1-repair` at
`f2a4e6785e82e468124121c7b6b61da11a995cbd`, the merge of PR #40, which repaired
#39). The four cross-contract regressions from the initial acceptance attempt are
preserved on top of it. Every behavior repair batch is merged and reviewed:
batches 1–3 landed as one compatibility unit (PR #29/#31/#32), batch 4 as PR #33,
#34 as PR #35, #37 as PR #38, and #39 as PR #40.

## Integrated decision-to-evidence matrix

The per-batch matrices remain authoritative for the detailed rows and the
pre-repair failure captures:

- `docs/repair-batch-1-traceability.md` — PR #29 (#24), decisions #17/#21/#22/#23.
- `docs/repair-batch-2-traceability.md` — PR #31 (#25), decisions #17/#19/#21/#22/#23.
- `docs/repair-batch-3-traceability.md` — PR #32 (#26), decisions #20/#21/#22/#23.
- `docs/repair-batch-4-traceability.md` — PR #33 (#27), decisions #17/#18/#21/#23.
- `docs/repair-issue-34-traceability.md` — PR #35 (#34), decisions #21/#24.
- `docs/repair-issue-37-traceability.md` — PR #38 (#37), decisions #21/#24.
- `docs/repair-issue-39-traceability.md` — PR #40 (#39), decisions #17/#21/#24.

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
| #39 Stale work messages | A delivered Goal work message opens an admission only for the Goal identity it names; the generic `[pi-goal]` prefix alone never authorizes admission, so a message queued for a cleared or replaced Goal opens nothing and its run's later turns are charged to nobody | `test/goal39-work-message-identity.test.mjs` (three gated RPC scenarios: cleared identity, replaced identity, legitimate same-identity delivery); `test/goal39-work-message-identity-store.test.mjs` (six replay/marker tests); the rewritten `test/goal9-ownership.test.mjs` regression and the updated `test/goal9-store.test.mjs` / `test/store.test.mjs` replay rows | #40 |
| #28 cross-contract | Stale transition across a budget-raising resume | `test/goal13-integrated-acceptance.test.mjs` ("a held model transition is stale after a budget-raising resume") | #28 (this branch) |
| #28 cross-contract | Tool-created Goal replacement ownership and superseded attribution | `test/goal13-integrated-acceptance.test.mjs` ("a tool-created Goal replaced by /goal charges only its Goal-owned Continuation work…") | #28 (this branch) |
| #28 cross-contract | Tool-created Goal cumulative budget recovery | `test/goal13-integrated-acceptance.test.mjs` ("a tool-created Goal's budget exhaustion recovers through a cumulative raise") | #28 (this branch) |
| #28 cross-contract | Tool-created Goal Blocker identity issuance and advancement | `test/goal13-integrated-acceptance.test.mjs` ("a tool-created Goal's blocked audit issues and advances a Blocker identity") | #28 (this branch) |

The four #28 cross-contract tests were prepared during the initial acceptance
attempt and re-run against the repaired integrated commit; all four pass. They
are additive and follow the suite's honesty rules.

## Pre-repair failure evidence

Every new regression was demonstrated failing on the pre-repair `src/` before its
repair merged. The exact captured failures are quoted in the per-batch
traceability documents and in PRs #35, #38, and #40:

- Batch 1: `docs/repair-batch-1-traceability.md` ("Pre-repair failure evidence"
  and the four review follow-ups).
- Batch 2: `docs/repair-batch-2-traceability.md`.
- Batch 3: `docs/repair-batch-3-traceability.md`.
- Batch 4: `docs/repair-batch-4-traceability.md`.
- Issue #34: `docs/repair-issue-34-traceability.md` (5 store probes, 1 pass / 4
  fail, plus the real-Pi RPC regression).
- Issue #37: `docs/repair-issue-37-traceability.md` (10 tests, 3 pass / 7 fail).
- Issue #39: `docs/repair-issue-39-traceability.md` (the two stale-message
  regressions fail with `C's own kickoff was not suppressed` and `177 !== 37`;
  the rewritten `goal9-ownership` regression fails `37 !== 15`; the legitimate
  same-identity delivery passes).

No test encoding superseded behavior was weakened or deleted for a pass: the one
existing regression that encoded the superseded work-message rule
(`test/goal9-ownership.test.mjs`, "creating a Goal after a Clear closes the old
admission so live and replay agree") was rewritten for the corrected contract,
as recorded in `docs/repair-issue-39-traceability.md`.

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

The ten issue-#37 RPC scenarios and the three issue-#39 RPC scenarios follow the
same rules: each asserts the exact number of provider responses, the exact failed
outcomes, the persisted snapshots, and the exact run/continuation counts, and
each rejects unexpected extension errors and unconsumed scripted steps:

| Test | End-of-run assertion | Script consumed |
| --- | --- | --- |
| `goal39` stale queued resume for a cleared Goal | `assertStepsConsumed(session, 4, [{ stopReason: "aborted" }])` | exact |
| `goal39` stale queued resume for a replaced Goal | `assertStepsConsumed(session, 4, [{ stopReason: "aborted" }])` | exact |
| `goal39` legitimate same-identity resume | `assertStepsConsumed(session, 3, [{ stopReason: "aborted" }])` | exact |

No scenario can pass through script exhaustion, timeout, accidental abort, or an
unplanned settle. The full suite reports zero unconsumed scripted steps.

Each of the four #28 cross-contract tests also asserts its exact run and
Continuation counts, in table order: **6 runs / 2 continuations**, **3 / 2**,
**6 / 3**, and **5 / 4**.

## Automated gates (integrated commit `45f7efc`)

| Gate | Result |
| --- | --- |
| `npm test` | **463 tests, 463 pass, 0 fail, 0 skipped** (46.9 s) |
| `npm test` (repeat) | **463 tests, 463 pass, 0 fail, 0 skipped** (60.5 s) |
| `npm run typecheck` | **exit 0** (`tsc --noEmit`, no output) |
| `node --test test/goal34-active-time-stop.test.mjs test/goal34-active-time-stop-store.test.mjs test/goal37-stale-execution.test.mjs test/goal39-work-message-identity.test.mjs test/goal39-work-message-identity-store.test.mjs test/goal13-integrated-acceptance.test.mjs` | **30 pass, 0 fail** |

The #39 repair added 9 tests to the merged #38 total (454 + 9 = 463).

One earlier default run on this host hit an assertion flake in the unrelated
`test/goal5.test.mjs` blocked-audit chain (`actual: 2, expected: 3` on
`toolResults(session, "update_goal").length`) while the machine was under
external load (load average ≈ 6.3 on 8 cores). The file passes in isolation
(41/41) and the two default runs recorded above are consecutive and clean. This
is the same contention class the batch-4 traceability documents — an audit chain
that settles before its final report is recorded, so the snapshot of collected
tool results is one short — and it is a harness race, not product behavior: the
persisted branch for that session shows the third report and the blocked stop.
No test was skipped, retried, or given a longer timeout to obtain the clean runs.

## Automated gates (PR review follow-up)

The four low findings from the PR #36 review change only
`test/goal13-integrated-acceptance.test.mjs` (the dead imports became exact run
and Continuation-count assertions, the replacement total is now read after the
kickoff's accounting boundary, and one comment was corrected) and this document.
Both gates and the focused file were re-run with these fixes in place:

| Gate | Result |
| --- | --- |
| `npm test` | **463 tests, 463 pass, 0 fail, 0 skipped** (47.6 s; 52.9 s on a repeat of the committed head) |
| `npm run typecheck` | **exit 0** (`tsc --noEmit`, no output) |
| `node --test test/goal13-integrated-acceptance.test.mjs` (3 repeats) | **4 pass, 0 fail** each |

## Automated gates (integration review follow-up)

The final two-axis review of this integration raised three medium and eight low
findings, all in the standards axis (duplication in `src/store.ts`, the
resume-notice conditional, hand-editing formatting artifacts, duplicated budget
validation, dead test constants, and a re-declared `USAGE_ENTRY_TYPE`), plus the
one low scope note resolved above. Every finding is fixed on this branch:

| Finding | Fix |
| --- | --- |
| Superseded-ledger charge/dirty/refresh repeated four times | one `chargeSupersededTail` helper in `src/store.ts` |
| stop-clock → stopped snapshot → persist → restart-on-failure → mark-durable repeated four times | one `stopAndPersist` helper, with `commitStopSnapshot` as the counterpart to `commitSnapshot` |
| `waitForSnapshot`/`liveUsage` and the scenario scaffolding copied per file | moved into `test/helpers/rpc-harness.mjs`, with one `assertStepsConsumed` body |
| Nested resume-notice ternary | a `resumeRestartNotice` switch |
| Brace and string-continuation mis-indentation | corrected in `src/index.ts` and `src/store.ts` |
| Duplicated whole-budget validation and a fabricated `BudgetSettings` | one `validateWholeBudget`, and `resolveResumeTokenBudget` now takes the maximum alone |
| Dead test constants/helpers | removed, except the `goalStates` helper in `test/goal13-integrated-acceptance.test.mjs`, which is an accepted advisory and was left in place |
| Re-declared `USAGE_ENTRY_TYPE` and a vacuous checkpoint loop | imported from `src/goal.ts`, and the checkpoint assertion now asserts a count plus the pre-stop checkpoints |

The nested-usage report that `test/goal9-ownership.test.mjs` asserts is now read
from the branch entry the finalized tool call produced, so the accounted
contribution is pinned to the report rather than to a bare literal.

| Gate | Result |
| --- | --- |
| `npm test` | **463 tests, 463 pass, 0 fail, 0 skipped** |
| `npm run typecheck` | **exit 0** (`tsc --noEmit`, no output) |
| Budget-message equivalence against the pre-fix `src/accounting.ts` | **352 cases, 0 differences** |

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
  no-binding refusal); the #39 admission-segment rule ("Every work message names
  the Goal identity it was admitted for… a work message queued for a Goal that
  has since been cleared or replaced therefore opens nothing"); current
  command/tool surfaces, limitations, and verification commands.
- `docs/smoke-test.md` — procedure and checklist synchronized; includes the
  blocked/`usage_limited` active-time verification step (section 19) and the new
  section 20 for the two hostile orderings across a Goal boundary (a stale queued
  work message, and a stale execution's lifecycle call).
- `GLOSSARY.md` — the Active elapsed time and Blocker identity definitions match
  the repaired behavior; the invariant already read "excluding every non-active
  status". The **Admission segment** entry now states that every work message
  names the Goal identity it was admitted for and that a generic `[pi-goal]`
  prefix alone never authorizes admission, and the **Replacement Goal** entry
  still describes the superseded-tail freeze boundaries.
- `docs/adr/0001-conservative-stopping.md` — the deterministic stopping rules and
  the four repair-batch amendments match the implementation.

No inaccuracy was found. The documentation changes have two layers:

- The final evidence commit `8057d6c` adds smoke-test section 20 (the two hostile
  orderings across a Goal boundary), the two matching checklist items in
  `docs/smoke-test.md` and `README.md` (a stale queued work message opens
  nothing; a stale execution cannot drive the replacing Goal's lifecycle), and
  rewrites this integrated traceability document.
- The acceptance branch as a whole, on top of the integration merge `f2a4e67`,
  also adds smoke-test section 19 (blocked and `usage_limited` active time) and
  the third matching checklist item in both `docs/smoke-test.md` and `README.md`
  (the non-active Active-time freeze).

Every other documentation change the branch carries arrived through the merged
repair PRs (#29–#40): the per-batch and per-issue traceability documents and the
#37/#39 README, `GLOSSARY.md`, and smoke-test updates. The branch-own diff
(`f2a4e67..HEAD`) touches no `src/` file and no behavior.

## Final real-Pi interactive smoke

Run against the integrated commit `45f7efc` with a real configured Pi
installation and a real provider, through the documented project install.

| Field | Value |
| --- | --- |
| Date | 2026-11-14T23:31:44Z → 2026-11-14T23:37:27Z (2026-11-15 07:31 → 07:37 +08:00) |
| Pi version | **1.5.2** (`pi --version`) |
| Node | v26.13.1 |
| Environment | macOS (Darwin arm64), `pi --mode rpc`, extension loaded from the project install |
| Provider | `magpie/deepai/deepseek-v4.1-flash` (configured, ready; local Magpie endpoint) |
| Package install | `pi install --local <worktree>` in a clean project; `pi list` shows it under **Project packages** |
| Commit | `45f7efcb0559acd43055986bd9161aba3217935d` |

Checklist results (real provider, one persisted session per phase):
**29 checks, 29 pass, 0 fail.**

| # | Checklist item | Result |
| --- | --- | --- |
| C01 | Bare `/goal` with no Goal | PASS — "No Goal is set in this session." |
| C02 | Direct `/goal <objective>` creation and initial work | PASS — "created and activated. Initial work started." |
| C03 | Compact status indicator shows `active` | PASS — `goal_<id> · active · 0 tok · 0s` |
| C04 | Automatic continuation at settlement | PASS — 2 `goal-continuation` entries |
| C05 | Evidence-based completion with verified artifacts | PASS — `complete`, revision 1, 20,731 accounted tokens, all three files written |
| C06 | Accurate `/goal` report | PASS — objective, revision 1, usage, Active time |
| C07 | `/goal clear` and durable tombstone | PASS — tombstone snapshot; bare `/goal` reports none |
| C08 | Bare `/goal` after clear | PASS |
| C09 | Bare `/goal edit` prefilled editor | PASS — prefill equals the current objective; revision 0 → 1; usage preserved |
| C10 | `/goal pause` stops continuation | PASS — continuations 2→2 and runs 4→4 over 8 s idle; status `paused` |
| C11 | `/goal resume` restarts work | PASS — "resumed (revision 3)… Work steered into the running work" |
| C11b | Replacement confirmation answered No | PASS — "Replacement cancelled"; the Goal identity, objective, and revision unchanged |
| C12 | Budget exhaustion and one wrap-up | PASS — `budget_limited`, 784 accounted tokens, exactly 1 `goal-budget-wrapup` |
| C13 | Bare `/goal resume` of `budget_limited` refused | PASS — guidance names `/goal resume --budget <new-total>` |
| C14 | No-headroom raise refused | PASS — positive-headroom reason; still `budget_limited` |
| C15 | Cumulative `--budget=100000` recovery preserves usage | PASS — ceiling 1 → 100000, usage 784 → 784, status `active` |
| C16 | Restart persistence | PASS — "restored (active)", budget and usage intact, **0 runs on load** |
| C17 | Clear + tombstone survive a reload | PASS — no `restored` notification after the reload; bare `/goal` reports none |
| C21 | Clean process outcomes | PASS — 0 extension errors, 2 dialogs both expected and answered (one replacement confirmation answered No, one answered Yes), 1 editor |

### #34 — non-active Active-time freeze (explicit confirmation)

| Check | Result |
| --- | --- |
| D34a Real-provider Blocker identity chain reaches `blocked` | PASS — `Blocked audit: 3 of 3 consecutive Goal turns reported this blocker`; snapshot `blocked` |
| D34b `blocked` Active time frozen across idle time | PASS — **35 s → 35 s** across 10 s idle |
| D34c `blocked` Active time frozen across restart, no run on load | PASS — **35 s → 35 s** after a process restart; "restored (blocked)"; **0 runs on load** |

`usage_limited` needs a real provider usage-limit error, so it stays covered by
the deterministic `test/goal34-active-time-stop.test.mjs` /
`-store.test.mjs` regressions (both pass on this commit).

### #37 — stale execution lifecycle refusal (explicit confirmation)

A Goal whose single run keeps taking turns was replaced by `/goal <objective>`
(confirmation answered **Yes**) while that run was in flight, so the new Goal
committed before the old execution's later turns. The old execution then called
`update_goal { action: "complete" }` twice; **both were refused**:

```text
Goal not updated: this call was prepared against a Goal state that has since
changed (expected goal_2867ec94 revision 0, current goal_a42e1842 revision 0).
The user may have edited, replaced, paused, or resumed the Goal while your
response was in flight. …
Goal not updated: this call was prepared against a Goal state that has since
changed (expected goal_2867ec94 revision 0, current goal_a42e1842 revision 1). …
```

Persisted branch:

```text
SNAPSHOTS: [
  'goal_2867ec94:active:rev0:tok0',
  'goal_2867ec94:active:rev0:tok4171',
  'goal_a42e1842:active:rev0:tok0',
  'goal_2867ec94:active:rev0:tok5454:superseded',
  'goal_a42e1842:paused:rev1:tok921'
]
```

| Check | Result |
| --- | --- |
| D37a The old execution's `complete` did not complete the new Goal | PASS — the new Goal's first snapshot is `active` at revision 0; it ends the window `paused` at revision 1 from the smoke's own freeze, never `complete` |
| D37b The stale execution's lifecycle call was refused | PASS — 2 `update_goal` calls, **2 refused**, 0 applied |
| D37c The replaced identity kept its own durable superseded record | PASS — 1 `superseded` snapshot carrying the old identity's accounted tail |

### #39 — stale queued work messages never open or charge a new Goal (explicit confirmation)

A Goal was created whose run stays busy for many turns; it was paused and then
resumed while that run was in flight, so the resume work message was queued as a
steer; it was then cleared and a `--budget 1` Goal was created while the queued
message was still undelivered. The stale message landed after the new Goal
committed:

```text
SNAPSHOTS: [
  'goal_6903ba4b:active:rev0:tok0',
  'goal_6903ba4b:paused:rev1:tok13499',
  'goal_6903ba4b:active:rev2:tok13499',
  'tombstone',
  'goal_67dfb762:active:rev0:tok0',
  'goal_67dfb762:budget_limited:rev1:tok6483',
  'goal_67dfb762:budget_limited:rev2:tok6483'
]
PI-GOAL WORK MESSAGES: goal_6903ba4b kickoff, goal_6903ba4b resume (delivered
after the new Goal committed), goal_67dfb762 kickoff, goal_67dfb762 wrap-up
```

| Check | Result |
| --- | --- |
| D39a Hostile ordering exercised | PASS — the stale `goal_6903ba4b` resume message was delivered after `goal_67dfb762` committed |
| D39b The new Goal's own kickoff was delivered exactly once | PASS — 1 kickoff, no "was not started" creation warning |
| D39c The cleared identity earned no continuation after the clear | PASS — 0 continuations for `goal_6903ba4b` after the tombstone |
| D39d The new Goal was not charged the old identity's work | PASS — `goal_67dfb762` reached `budget_limited` with 6,483 tokens from its own kickoff and its own single wrap-up, and its own kickoff ran; the cleared identity's 13,499-token tail stayed on the superseded side |

The deterministic RPC suite remains the automated gate; this smoke does not
replace it.

## Scope note resolved: the shared pause/creation predicates

The Spec-axis review of this integration raised one low finding: the branch widens
two predicates that the *pre-existing* pause-corroboration rules also use —
`foldApostrophes` applied in `contradictsPause`, and `REQUEST_LEAD` gaining the
`actually|in fact` discourse markers — while no repair ticket in the graph lists a
pause-rule change. The finding is an advisory about scope, not about behavior: it
records that a change landed beyond the asked repair surface without its own
focused issue. It is resolved here rather than by reverting, because the change is
not an independent edit to the pause rules.

1. **One predicate, not two rule sets.** `foldApostrophes` and `REQUEST_LEAD` are
   shared by the pause-corroboration rules and the Goal-creation authority rules
   (see the batch-4 traceability, "Shared predicates: pause corroboration and
   creation authority"). Batch 4's job was to make the *creation* path refuse a
   curly-apostrophe cancellation and accept a discourse-marker correction; the
   minimal correct way to do that is to widen the shared predicate.
2. **The direction is conservative.** The fold can only add refusals. The
   discourse-marker widening only strips a lead-in and still requires an
   imperative or passive pause shape containing the quoted words, so mentions,
   questions, hypotheticals, deferrals, and keep-working instructions are still
   refused. Occurrence of the words alone never grants pause authority, and
   `/goal pause` remains available to the user.
3. **It is tested on the pause path, and those tests are kept.** Both pause-path
   rows are asserted in `test/goal12-pause-corroboration.test.mjs` and are listed
   in the batch-4 matrix. No pause test was removed, skipped, or weakened, and no
   fail-open pause behavior was introduced: a pause still requires a corroborated
   quotation from the newest human-authored user message, and a negation, a
   keep-working instruction, a deferral, or a mere mention still refuses it.

Accepted as part of the integrated V1 acceptance: the shared-predicate integration
is intentional, its acceptance rationale is the three points above, and it needs
no separate focused repair issue because it is a consequence of sharing one
conservative English reading between two contracts rather than an independent
change to either. This closes the scope note; the behavior is unchanged by this
record.

## Defect status

### Fixed: stale follow-up transitions (#37, PR #38)

The initial acceptance attempt found that a model `update_goal` complete in a
follow-up provider turn of an old Goal's in-flight run completed a newly created
Goal. PR #38 fixed it (`turnGoal` is now the execution's binding, re-admitted
only to the identity it holds; `blocked` is bound like `complete`/`pause`). The
ten `test/goal37-stale-execution.test.mjs` scenarios pass on `45f7efc`, and the
real-provider smoke above reproduces the refusal directly.

### Fixed: a stale queued work message adopted a newly created Goal (#39, PR #40)

The rerun of the final smoke found that a pi-goal work message queued for a Goal
that is then cleared or replaced was delivered after the new Goal committed, and
because it carried only the generic `[pi-goal]` prefix, `applyDeliveredUserMessage`
opened the new Goal's admission segment and charged the old run's turns to the new
identity. PR #40 fixed it: every delivered Goal work message now names the Goal
identity it was admitted for, and both the live delivery seam and the branch
replay open an admission segment only when that identity is the current Goal. The
three `test/goal39-work-message-identity.test.mjs` scenarios and the six
`test/goal39-work-message-identity-store.test.mjs` replay/marker tests pass on
`45f7efc`, and the real-provider smoke above reproduces the corrected behavior
directly.

No behavior defect is open. All four behavior repair batches are merged and
reviewed, the integrated matrix is complete, both automated gates pass on the
integrated commit, the documentation audit found no inaccuracy, and the final
real-Pi smoke evidence is recorded and passing. #1 and #28 remain open until the
orchestrator verifies the above and closes the Spec.
