# Repair issue #28 traceability: integrated V1 acceptance

Issue: #28 (batch 5 of 5, verification-only). Source decisions: #17 (Goal-owned
work), #18 (creation authority), #19 (budget-limited resume), #20 (Blocker
identity), #21 (regression and acceptance contract), #22 (legacy snapshots), #23
(implementation sequence). Parent Spec: #1. Behavior reference: ADR-0001.

This document is the single integrated evidence matrix required by #21 and #28:
every reviewed V1 defect and behavioral decision maps to named test evidence and
the repair PR that supplied it, plus the clean-outcome audit, the automated
gates, the documentation audit, and the final real-Pi smoke record.

The integrated commit is `77a8adaeed1bf6907372640a14a26fc8c62f8d26`
(`origin/integration/spec-1-v1-repair`, merge of PR #35). The acceptance branch
is `repair/28-integrated-acceptance`.

## Integrated decision-to-evidence matrix

The per-batch matrices remain authoritative for the detailed rows and the
pre-repair failure captures:

- `docs/repair-batch-1-traceability.md` — PR #29 (#24), decisions #17/#21/#22/#23.
- `docs/repair-batch-2-traceability.md` — PR #31 (#25), decisions #17/#19/#21/#22/#23.
- `docs/repair-batch-3-traceability.md` — PR #32 (#26), decisions #20/#21/#22/#23.
- `docs/repair-batch-4-traceability.md` — PR #33 (#27), decisions #17/#18/#21/#23.
- `docs/repair-issue-34-traceability.md` — PR #35 (#34), decisions #21/#24.

| Decision / defect | Contract | Named test evidence | Repair PR |
| --- | --- | --- | --- |
| #17 Goal-owned work | Only admitted Goal work is charged; ordinary prompts and creation controls are excluded in every status | `test/goal6.test.mjs` (create_goal non-retroactive, cached/reasoning/nested/compaction, restart/crash); `test/goal9-ownership.test.mjs` (ordinary prompts, replacement, Clear, admitted tails); `test/accounting.test.mjs` | #29 |
| #17 Attribution boundaries | `/goal` starts at its kickoff; `create_goal` starts at the first Continuation; replacement starts at zero | `test/goal6.test.mjs` ("create_goal leaves its creating run ordinary…"); `test/goal9-ownership.test.mjs` ("a Replacement Goal starts at zero…"); `test/goal12-creation-authority.test.mjs` | #29 |
| #17 Stale transitions | A model transition prepared against an old identity/revision is refused with no mutation | `test/goal4-regressions.test.mjs` (held complete/pause); `test/goal9-ownership.test.mjs` (held blocked); `test/goal9-store.test.mjs` (same-turn stale blocked) | #29 |
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

No scenario can pass through script exhaustion, timeout, accidental abort, or an
unplanned settle. The full suite reports zero unconsumed scripted steps.

## Automated gates (integrated commit `77a8ada`)

| Gate | Result |
| --- | --- |
| `npm test` | **444 tests, 444 pass, 0 fail, 0 skipped** (41.6 s) |
| `npm run typecheck` | **exit 0** (`tsc --noEmit`, no output) |
| `node --test test/goal34-active-time-stop-store.test.mjs` | 6 pass, 0 fail |
| `node --test test/goal34-active-time-stop.test.mjs` | 1 pass, 0 fail |

## Documentation audit

Verified against the integrated commit:

- `README.md` — Goal-owned accounting and Active elapsed time (the active-time
  paragraph names every non-active status: `paused`, `blocked`, `usage_limited`,
  `budget_limited`, `complete`); explicit creation authority and fail-closed
  rejection; cumulative budget recovery and per-episode wrap-ups; Blocker
  identity and deterministic conservative stopping; legacy reconstructed totals,
  durable branch-local cutover, migration notices, and lifecycle preservation;
  current command/tool surfaces, limitations, and verification commands.
- `docs/smoke-test.md` — procedure and checklist synchronized; gained an
  explicit blocked/`usage_limited` active-time verification step.
- `GLOSSARY.md` — the Active elapsed time and Blocker identity definitions match
  the repaired behavior; the invariant already read "excluding every non-active
  status".
- `docs/adr/0001-conservative-stopping.md` — the deterministic stopping rules and
  the four repair-batch amendments match the implementation.

No inaccuracy was found. The only documentation change in this branch is the
smoke-test/README active-time checklist item.

## Final real-Pi interactive smoke

Run against the repaired integrated commit `77a8ada` with a real configured Pi
installation and a real provider.

| Field | Value |
| --- | --- |
| Date | 2026-11-14T18:31:06Z (2026-11-15 02:31 +08:00) |
| Pi version | **1.5.2** (`pi --version`) |
| Node | v26.13.1 |
| Environment | macOS (Darwin arm64), `pi --mode rpc`, extension loaded from the acceptance worktree |
| Provider | `magpie/deepai/deepseek-v4.1-flash` (configured, ready; local Magpie endpoint) |
| Package install | `pi install --local <worktree>` in a clean project; `pi list` shows it under Project packages |
| Commit | `77a8adaeed1bf6907372640a14a26fc8c62f8d26` |

Checklist results (real provider, one persisted session):

| # | Checklist item | Result |
| --- | --- | --- |
| 1 | Install and version visibility | PASS — Pi 1.5.2, project package listed |
| 2 | Bare `/goal` with no Goal | PASS — "No Goal is set…" |
| 3 | `/goal <objective>` creation and initial work | PASS — "created and activated", work ran |
| 4 | Automatic continuation at settlement | PASS — 2 `goal-continuation` entries |
| 5 | Status indicator | PASS — `active · <tokens> tok · <active time>` |
| 6 | `/goal pause` | PASS — paused, no further continuation (2 → 2) |
| 7 | Paused `/goal` report | PASS — `paused` |
| 8 | Bare `/goal edit` interactive editor | PASS — objective updated, revision 1 → 2, usage preserved |
| 9 | `/goal resume` | PASS — resumed (revision 3), work restarted |
| 10 | Active `/goal` report | PASS — objective, revision, usage, active time |
| 11 | `/goal clear` | PASS — cleared; bare `/goal` reports none |
| 12 | `/goal --budget 1` exhaustion | PASS — `budget_limited` at 1 token, one wrap-up follows |
| 13 | Budget-limited status | PASS — `budget_limited`, remaining 0 |
| 14 | Bare `/goal resume` refusal | PASS — guidance to `--budget <new-total>` |
| 15 | No-headroom raise refusal | PASS — "strictly greater… positive headroom" |
| 16 | `--budget=100000` cumulative recovery | PASS — resumed, ceiling 100000, prior usage preserved |
| 17 | Restart persistence | PASS — same status/revision/tokens, 0 runs on load |
| 18 | No post-exit work | PASS — session file unchanged after exit; no `pi --mode rpc` processes remain |
| 19 | Blocked active time frozen (real provider) | PASS — blocked at 23 s; 23 s after 6 s idle; restart 23 s; 0 runs |
| 20 | `usage_limited` active time frozen | PASS — `test/goal34-active-time-stop-store.test.mjs` (6/6) and the real-Pi blocked/restart regression (1/1) |

The deterministic RPC suite remains the automated gate; this smoke does not
replace it.

## Newly found behavior defect (not fixed here)

While driving the real-Pi smoke, a stale-transition defect appeared that the
deterministic suite does not cover. Per #28's verification-only rule it is
recorded here, not repaired in this branch.

**Symptom.** A model `update_goal { action: "complete" }` call made in a
*follow-up provider turn* of an old Goal's in-flight run completes a Replacement
Goal that the old run never saw. The creation command waits for the old run to
finish before delivering the new Goal's kickoff, so the new Goal is marked
`complete` without its work and with zero accounted usage.

**Deterministic reproduction** (real `pi --mode rpc`, scripted provider): the
old Goal's first turn runs a shell command and is held at a provider gate;
`/goal clear` then `/goal <new objective>` are issued while that run is in flight;
the gate is released; the old run's next turn starts (after the replacement) and
calls `update_goal { action: "complete" }` without any `get_goal` call. The call
succeeds and the new Goal's snapshot becomes `complete`. The session branch shows
the old kickoff, the tombstone, the new snapshot, the old run's tool result, and
the new Goal's completion — with no new-Goal kickoff and no `get_goal` read:

```text
STATE goal_00b2d4ee active rev 0   (old Goal)
user  [pi-goal] Working toward Goal goal_00b2d4ee
STATE null                         (clear tombstone)
STATE goal_9acb1f73 active rev 0   (new Goal)
assistant / toolResult (bash true) (old run's held turn)
STATE goal_9acb1f73 complete rev 1 (completed by the old run's follow-up turn)
```

**Why it is a defect.** The `turnGoal` binding is snapshotted at every
`turn_start` (`src/index.ts`), and `update_goal` refuses a call whose bound
identity/revision differs from the current Goal. A follow-up turn starts after
the replacement, so it re-binds to the new Goal and the completion is accepted,
even though the model is still working the replaced objective and never received
the replacement kickoff. Issue #24's contract requires stale model-requested
`complete` to be rejected after an identity change; the existing regression
(`test/goal4-regressions.test.mjs`) only covers a *held* response whose turn
started before the replacement.

**Impact.** A user who clears a Goal and creates a new one while the old run is
in flight can have the new Goal falsely completed by the old run, with no work
done and the new Goal's kickoff suppressed.

**Evidence.** Real-provider session: the old run's assistant thinking still
described the old objective while its `update_goal` completed the new identity
(`goal_47cffc79`, 0 tokens). Deterministic reproduction above. The smoke's budget
phase originally hit this race; the smoke was adjusted to let the old run settle
before creating the next Goal, and the checklist above is otherwise unaffected.

Acceptance is **not declared** while this defect is open. The four cross-contract
tests, the integrated matrix, the gates, and the smoke evidence above are
complete; the defect needs a focused repair issue.
