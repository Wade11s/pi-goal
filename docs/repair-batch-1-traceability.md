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
| Stale `blocked` | Rejected after identity/revision change, no mutation/audit/continuation | `test/goal9-ownership.test.mjs` ("a held blocked report prepared against an edited Goal…"); `test/goal9-store.test.mjs` ("a same-turn blocked repeat after the Goal was edited…") |
| Persistence isolation | Later live mutation never alters an appended snapshot, checkpoint, or reconstructed record | `test/goal9-store.test.mjs` (aliasing tests); `test/store.test.mjs` |
| Non-retroactive `/goal` | The ordinary run the command waited for is never adopted | `test/goal9-ownership.test.mjs` ("/goal issued during an ordinary run…") |
| Non-retroactive `create_goal` | Creating run and same-batch tool results excluded; attribution starts at the first Continuation | `test/goal6.test.mjs` ("create_goal leaves its creating run ordinary…") |
| Ordinary prompts excluded in every status | Paused/blocked/usage-limited/budget-limited/complete ordinary runs add nothing | `test/goal9-ownership.test.mjs` ("an ordinary prompt while a Goal is paused…"); `test/goal6.test.mjs` (budget/complete accounting tests) |
| Replacement starts at zero | Old identity keeps its admitted work; new identity inherits nothing | `test/goal9-ownership.test.mjs` ("a Replacement Goal starts at zero…"; "a steered Replacement attributes the old identity's in-flight work to the old identity"); `test/goal9-store.test.mjs` ("the superseded snapshot carries the exact already-accounted totals") |
| Old in-flight tail | The old identity's in-flight assistant response and tool results stay attributed to it, live and on replay | `test/goal9-ownership.test.mjs` ("a steered Replacement attributes the old identity's in-flight work to the old identity"); `test/goal9-store.test.mjs` ("a replacement attributes the superseded identity's in-flight assistant and tool-result tail") |
| Tail survives every boundary | A second replacement and a durability-rollback restore freeze the open tail; Clear keeps an open tail open past the tombstone and freezes a closed tail, refusing on a failed write | `test/goal9-store.test.mjs` ("Clear keeps the superseded identity's already-accounted open tail through the tombstone"; "Clear keeps the superseded identity's admission open so a later response stays attributed"; "Clear refuses to commit when an already-accounted tail cannot be frozen"; "a second replacement freezes the first identity's open tail before the second preserve"; "a durability rollback restores the old identity together with its open tail") |
| Clear keeps the old admission open | Clear of the replacement does not erase the superseded identity's admitted or in-flight work; the tail freezes at the next boundary | `test/goal9-store.test.mjs` ("Clear keeps the superseded identity's admission open so a later response stays attributed"; "Clear keeps the superseded identity's already-accounted open tail through the tombstone") |
| Replay recovers past a tombstone | A superseded tail is recovered even when the newest non-superseded entry is a tombstone, and never resurrects the old Goal | `test/goal9-store.test.mjs` ("replay recovers a superseded tail when the newest non-superseded entry is a tombstone"; "a recovered superseded tail is frozen as history and never resurrects the old Goal") |
| Freeze is crash-safe | One append, marked `superseded`, so a crash right after it cannot resurrect the replaced Goal, and a failed write keeps the tail | `test/goal9-store.test.mjs` ("a crash right after the freeze append never resurrects the superseded Goal"; "a failed freeze write keeps the tail for the next boundary") |
| Hard-crash recovery | A branch whose freeze boundary never ran recovers the tail on the next load and freezes it there | `test/goal9-ownership.test.mjs` ("a hard crash between the old identity's tail and its freeze boundary recovers the tail on reload"); `test/goal9-store.test.mjs` ("a hard crash between the old tail and its freeze boundary recovers the tail on the next load") |
| Superseded never current | A superseded snapshot is loadable and replayable but never selects the current Goal, alone or after a tombstone | `test/goal9-store.test.mjs` ("a branch of only superseded snapshots, or a tombstone after one, leaves no current Goal"); `test/goal9-store.test.mjs` ("replay attributes the superseded tail to the old identity and keeps the replacement at zero") |
| Recovered tail is not re-written | A reload adopts a durable freeze instead of appending the same historical snapshot again, and does not steal the replacement's own open segment | `test/goal9-store.test.mjs` ("a reload does not rewrite a tail that is already durable"; "a recovered open tail does not steal the replacement's own open segment") |
| Old-budget exhaustion | Recorded on the old identity's superseded record only; no old continuation or wrap-up | `test/goal9-ownership.test.mjs` ("old-budget exhaustion is recorded on the superseded identity and admits no old continuation"); `test/goal9-store.test.mjs` ("old-budget exhaustion is recorded on the superseded record and never on the replacement") |
| Durable superseded totals | The superseded snapshot carries the exact already-accounted total; the finalized record carries the exact tail and survives reload | `test/goal4.test.mjs` ("replacing an unfinished objective requires confirmation"); `test/goal9-store.test.mjs` ("the superseded snapshot carries the exact already-accounted totals"); `test/goal9-ownership.test.mjs` (reload assertions in the two Replacement tests) |
| Clear boundary | Cleared identity publishes no further usage; a future Goal is not charged | `test/goal9-ownership.test.mjs` ("Clear publishes no further usage…") |
| Admitted in-flight work | Stays attributable through pause/completion/blocked/usage-limit stops | `test/goal9-ownership.test.mjs` ("already-admitted in-flight Goal work stays attributable through a pause"; "an ordinary prompt typed during an admitted Goal response…") |
| Cached/reasoning/nested/compaction | Exactly-once accounting preserved under the ownership boundary | `test/goal6.test.mjs` (cached-read, nested, compaction, retry tests) |
| Live/replay convergence | Restart, reload, crash windows, fork, tree navigation | `test/goal6.test.mjs` (restart/crash); `test/goal7.test.mjs` (fork/tree); `test/goal9-ownership.test.mjs` (reload of the Replacement and ordinary-prompt orderings); `test/goal9-store.test.mjs` ("replay attributes the superseded tail to the old identity…") |
| Budget-stop convergence | A branch that replays past the budget stops instead of admitting another Goal turn | `test/goal9-store.test.mjs` ("a reloaded Goal whose replayed usage reached its budget…"); `test/goal9-ownership.test.mjs` ("an ordinary prompt typed during an admitted Goal response…") |
| Active elapsed time | Only live active segments accrue; live and replay converge | `test/goal6.test.mjs` (active-time tests); `test/store.test.mjs`; `test/accounting.test.mjs` |
| Legacy loadable | Every structurally valid version-1 snapshot/checkpoint stays readable | `test/goal9-legacy.test.mjs` (all statuses) |
| Latest snapshot/tombstone wins | Newest entry controls; malformed latest fails closed with guidance | `test/goal9-legacy.test.mjs` ("a malformed or unrecognized newest legacy snapshot…"); `test/goal7-store.test.mjs` |
| No work from loading | Loading/migration sends no message and triggers no provider request | `test/goal9-legacy.test.mjs` (`runCount === 0` after load) |
| One-time baseline | Legacy totals reconstructed once under 0.1.0 rules and frozen | `test/goal9-legacy.test.mjs` ("a legacy active Goal is cut over once…"); `test/goal9-store.test.mjs` |
| Durable cutover before work | Repaired snapshot plus branch-local marker written before repaired work | `test/goal9-legacy.test.mjs`; `test/goal9-store.test.mjs` ("a failed cutover marker leaves memory holding the durable repaired snapshot") |
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
same suite passes and `npm run typecheck` passes; the current default-seam counts
are recorded in the PR description.

## Review follow-up: live/replay ownership divergences

PR review (subagent 9253ee) found that the two in-flight orderings above passed
live while a reload, fork, or tree navigation reconstructed a different total, so
`npm test` stayed green without the convergence contract being met. Four further
findings were a fault window in the cutover, a same-turn stale `blocked` repeat, a
test-helper race, and a stale comment. Each has a regression that fails on the
pre-fix `src/`:

```text
a steered Replacement keeps the old identity's in-flight work out of the new Goal
  AssertionError: the reload converges on the live total
    actual: 197, expected: 37      (live was 87: the old identity's nested tool
                                    result had been charged to the replacement)

an ordinary prompt typed during an admitted Goal response stays attributed and converges
  AssertionError: the live path must stop at the crossing; notifications were [...]
    actual: 0, expected: 1
    (live accounted 45 of the 100-token budget and stayed active: the 80-token
     in-flight response was dropped and the script then ran out of steps. A reload
     reconstructed 125 and was still active with the budget exhausted, so the
     continuation seam was free to admit a Goal turn the live session had already
     paid for and failed to stop.)

replay does not carry an old identity's open segment across a replacement snapshot
  AssertionError: only the replacement's own steered work is charged
    actual: 179, expected: 22

a reloaded Goal whose replayed usage reached its budget stops instead of admitting more work
  AssertionError: the replayed crossing stops the Goal
    + actual - expected
    + 'active'
    - 'budget_limited'

a failed cutover marker leaves memory holding the durable repaired snapshot
  AssertionError: Expected values to be strictly equal: false !== true

a same-turn blocked repeat after the Goal was edited is refused as stale
  AssertionError: the repeat is not reported as recorded
    true !== false
```

Both divergences had the same root cause on both sides. Live, the admission segment
was opened when a work message was *queued* and closed when a prompt was *typed*,
while the replay read the markers off the delivered entries. The segment is now
opened and closed at `message_end` for the delivered user message, which is the same
event Pi appends it in and therefore the same entry `ownershipMarker` reads back.
The replay tracks the segment by Goal identity, so a snapshot that introduces a new
identity (or a tombstone) closes the previous identity's segment, while a snapshot
for the same identity leaves it open, which is what keeps the pause case at 154.

The budget-stop convergence is the other half of the ordinary-prompt fix: a branch
that replays past an active Goal's budget now reaches the same `budget_limited`
stop the live path made, instead of leaving the continuation seam free to admit a
Goal turn the live session had already paid for. A pre-repair branch is exempt,
because `applyLegacyCutover` owns that stop and its configured-maximum notice.

`test/goal4-regressions.test.mjs`'s `waitForStoredGoal` also polled a session file
Pi may not have created yet, so the first `readFileSync` threw `ENOENT` and the
five-second retry never ran. It now treats `ENOENT` as "not written yet", matching
the copy in `test/goal9-ownership.test.mjs`.

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
- `test/goal9-ownership.test.mjs`: "a steered Replacement keeps the old identity's
  in-flight work out of the new Goal" asserted that the old response and its tool
  result belonged to nobody. It became "a steered Replacement attributes the old
  identity's in-flight work to the old identity", which asserts the exact tail on
  the old identity's durable record and its survival across a reload.
- `test/goal4.test.mjs`: "replacing an unfinished objective requires confirmation"
  had its continuation assertions dropped and a vacuous `>= 0` superseded-total
  check added. The continuation count/objective assertions are restored and the
  superseded snapshot is pinned to the exact already-accounted total.
- `test/goal4-regressions.test.mjs`: "a held completion cannot complete a Goal the
  user replaced while it was in flight" asserted the five-snapshot ordering that
  included the replacement's re-affirming append. The re-affirmation is gone, so
  the ordering is now four snapshots ending in the historical freeze, and the
  assertion reads the newest *current* snapshot for the replacement's identity.

## Review follow-up: the superseded identity's in-flight tail

The re-review by subagent b95f29 found that the already-accounted half of the
old-identity finding was fixed, but the still-in-flight half was still charged to
nobody: `commit()` closed the old admission, so the old response was refused and
its tool result followed the closed segment, while replay skipped both because a
new-identity snapshot nulls the segment owner. The code, a test, and the glossary
all blessed the drop.

The old admission now stays open past `commit()` until the next delivered user
message. The old response is bound to the old identity by the turn seam; tool
results and compaction that land before the next delivery follow the open segment;
and the tail is frozen onto a durable superseded `goal-state` snapshot, after which
the replacement is re-affirmed as the newest snapshot. The old active-time clock
stops at replacement, the old budget stop is recorded on the old record only, and
no continuation or wrap-up is ever issued for the superseded identity. Clear is
unchanged. The regressions above fail on the pre-fix `src/`:

```text
a replacement attributes the superseded identity's in-flight assistant and tool-result tail
  AssertionError: Expected values to be strictly equal: undefined !== 110

old-budget exhaustion is recorded on the superseded record and never on the replacement
  TypeError: store.closeSupersededSegment is not a function

a steered Replacement attributes the old identity's in-flight work to the old identity
  AssertionError: the exact assistant plus tool-result tail
    actual: 0, expected: 160
```

## Review follow-up: the superseded tail across the remaining boundaries

The re-review by subagent c5bfeb at `40b4985` found that the open superseded tail
was dropped on every path except message delivery and shutdown, that the
two-append freeze could resurrect the replaced Goal, and that a hard crash inside
the window left the tail unattributed on replay.

- **Every boundary freezes, except an open tail at Clear.**
  `preserveSupersededForReplacement` and `restore` call `closeSupersededSegment`
  first, so a second replacement and a durability-rollback restore cannot discard
  work the old identity had already admitted. `commitTombstone` freezes a *closed*
  tail and refuses the tombstone if that write fails; an *open* tail stays open
  past the tombstone so the old identity's in-flight work is still attributed to
  it, and freezes at the next boundary. `restore` folds the frozen record into
  the record it writes, because those entries sit *before* the restored snapshot
  and no later replay can recover them.
- **The freeze is one append and it is marked `superseded`.** The second,
  re-affirming append is gone: reconstruction selects the newest *non-superseded*
  snapshot, so the replacement stays current even if the process dies immediately
  after the freeze. `isDurable` skips superseded entries for the same reason, so
  the freeze cannot defeat the replacement's durability check. A failed freeze
  write is reported rather than thrown, and leaves the tail for the next boundary.
- **A hard crash inside the window is recovered.** `replayBranch` rebuilds the
  superseded identity's tail from the branch when a replacement snapshot arrives
  while its segment is open, so a reload converges on the live view and the first
  durable boundary of the new runtime freezes it. A tail whose freeze is already
  on the branch is adopted rather than re-derived, so a reload appends nothing.
- **The recovered tail does not steal the replacement's own segment.** A branch
  whose newest work message belongs to the replacement keeps that segment; only a
  branch with no open segment for the current identity claims the old one.

The new regressions fail on the pre-fix `src/` (`40b4985`):

```text
Clear freezes the superseded identity's open tail before the tombstone
  AssertionError: the freeze precedes the tombstone and is historical
    actual: undefined, expected: true

a second replacement freezes the first identity's open tail before the second preserve
  AssertionError: Expected values to be strictly equal:
    + 'goal_bbbbbbbb' - 'goal_aaaaaaaa'

a durability rollback restores the old identity together with its open tail
  AssertionError: Expected values to be strictly equal:
    + 'goal_bbbbbbbb' - 'goal_aaaaaaaa'

a failed freeze write keeps the tail for the next boundary
  AssertionError: the failure is reported, not thrown
    actual: undefined, expected: null

a crash right after the freeze append never resurrects the superseded Goal
  AssertionError: the freeze is the newest goal-state entry
    + 'goal_bbbbbbbb' - 'goal_aaaaaaaa'

a hard crash between the old tail and its freeze boundary recovers the tail on the next load
  AssertionError: Expected values to be strictly equal:
    actual: undefined, expected: 160

a branch of only superseded snapshots, or a tombstone after one, leaves no current Goal
  AssertionError: history alone is not a current Goal
    actual: { id: 'goal_aaaaaaaa', ... }, expected: null

replay attributes the superseded tail to the old identity and keeps the replacement at zero
  AssertionError: the replacement is the current Goal
    + 'goal_aaaaaaaa' - 'goal_bbbbbbbb'

a steered Replacement attributes the old identity's in-flight work to the old identity
  AssertionError: the newest goal-state entry is the historical freeze
    + 'goal_7c7b021e' - 'goal_a31eecb8'

a hard crash between the old identity's tail and its freeze boundary recovers the tail on reload
  AssertionError: exactly one historical snapshot is recovered from the branch
    actual: 0, expected: 1
```

Two of the new regressions guard the repair itself rather than the pre-fix
behaviour, because they fail on an intermediate state of this branch: a reload
must not rewrite a tail that is already durable, and a recovered open tail must
not steal the replacement's own open segment.

## Compatibility landing constraint

Batches 1–3 form one mandatory compatibility unit (see #23). This branch is not
independently releasable: cutover without batch 2 leaves migrated
`budget_limited` Goals without the repaired recovery contract, and cutover without
batch 3 cannot advance a preserved legacy audit by identity.
