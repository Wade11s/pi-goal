# Repair batch 3 traceability: opaque Blocker identity and the legacy-audit handoff

Issue: #26. Source decisions: #20 (blocker equivalence), #21 (regression contract),
#22 (legacy snapshots), #23 (implementation sequence). Behavior reference: ADR-0001.

This document maps every behavioral row owned by batch 3 to the test that covers
it, and records the pre-repair failure evidence required by #21. The automated
gate is `npm test`; every RPC scenario ends with `assertCleanRun` or an exact
`assertOnlyFailures`, asserts `assertStepsConsumed` (no exhausted script), and
asserts exact run/continuation counts and persisted entries. The narrow store,
fault, and combinatorial seams are unit-tested against a fake Pi API.

Batches 1–3 form one mandatory compatibility landing unit (see #23). This branch
is not independently releasable: cutover without batch 3 cannot advance a
preserved legacy audit by identity, and the blocked audit cannot recognize a
reworded report at all.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| ID issuance | The first valid `update_goal(blocked)` report in a chain omits `blocker_id`; pi-goal issues and persists an opaque ID with the latest description and count | `test/goal11-blocker-identity.test.mjs` ("the first report issues an opaque identity…"); `test/goal11-blocker-identity-store.test.mjs` ("the first report of a condition issues…") |
| Opaque, not derived | The ID is never computed from the blocker text, so the same words never produce the same ID | `test/goal11-blocker-identity-store.test.mjs` ("a Blocker identity is never derived from the blocker text"); `test/goal11-blocker-identity.test.mjs` ("a legacy open audit is handed a fresh identity…": `notEqual(issued, LEGACY_BLOCKER)`) |
| Reworded reuse advances | Reusing the current ID advances the audit even when the description and proposed next step change | `test/goal11-blocker-identity.test.mjs` ("a reworded report reusing the identity advances…"); `test/goal5.test.mjs` ("a reworded report reusing the current identity advances…"); `test/goal11-blocker-identity-store.test.mjs` ("reusing the current identity advances…") |
| Omission starts fresh | Omitting the ID reports a genuinely different condition: a fresh chain at one, and the old chain cannot resume | `test/goal11-blocker-identity.test.mjs` ("a reworded report reusing the identity advances…"); `test/goal5.test.mjs` (same test); `test/goal11-blocker-identity-store.test.mjs` ("omitting the identity starts a fresh chain…") |
| Unknown/non-current ID refused | An unrecognized or non-current ID is rejected without Goal mutation: no snapshot, no revision, no reset, no replacement | `test/goal11-blocker-identity.test.mjs` ("an unknown identity is refused without Goal mutation…"; "a stale identity from an ended chain is refused…"); `test/goal11-blocker-identity-store.test.mjs` ("an unrecognized or non-current identity is rejected…"; "a superseded chain's identity is refused…") |
| Rejection guidance | The refusal names the offending ID, the open identity (or that none is open), and tells the model to read `get_goal` and retry | `test/goal11-blocker-identity.test.mjs` ("an unknown identity is refused…"); `test/goal11-blocker-identity-store.test.mjs` (same row's store test) |
| Rejection does not own the turn | A rejected call does not own the turn, so a corrected call in the same turn records the turn's first valid report | `test/goal11-blocker-identity.test.mjs` ("an unknown identity is refused without Goal mutation and does not own the turn"); `test/goal5.test.mjs` ("a rejected report does not own its turn…"); `test/goal11-blocker-identity-store.test.mjs` ("a rejected identity does not own the turn…") |
| Per-turn idempotence | The first valid report owns its turn; later reports in that turn are idempotent and cannot advance, reset, or replace the audit, even with different text or an ID | `test/goal11-blocker-identity.test.mjs` ("only the third consecutive Goal turn transitions…"); `test/goal5.test.mjs` ("two blocker reports inside one Goal turn count as one audit step": the same-turn repeat carries different wording and a foreign identity; "a rejected report does not own its turn…"); `test/goal11-blocker-identity-store.test.mjs` ("a same-turn repeat is idempotent…") |
| Exact third-turn transition | Only the third consecutive Goal turn transitions; several calls in one turn cannot satisfy the threshold | `test/goal11-blocker-identity.test.mjs` ("only the third consecutive Goal turn transitions…"; "the first report issues an opaque identity…"); `test/goal5.test.mjs` ("update_goal(blocked) needs the same blocker for three consecutive Goal turns"); `test/goal11-blocker-identity-store.test.mjs` ("only the third consecutive Goal turn transitions…") |
| Reset: no-report turn | A Goal turn that makes progress, verifies a wait, or reports no blocker breaks the chain durably | `test/goal5.test.mjs` ("a Goal turn without a blocker report breaks the blocked audit"; "a durable audit reset survives a restart…"); `test/goal11-blocker-identity-store.test.mjs` ("every reset drops the identity durably…") |
| Reset: user action | A prompt the user types and an abort reset the audit durably | `test/goal5.test.mjs` ("a queued user prompt restarts the blocked audit at one"; "an abort resets the anti-loop counters…"); `test/goal11-blocker-identity.test.mjs` ("the legacy handoff grants no extra unattended turns…") |
| Reset: resume | `/goal resume` clears the audit that described the stop and starts a fresh one | `test/goal5.test.mjs` ("/goal resume restarts a blocked Goal with a fresh audit"; "/goal resume restarts a blocked Goal with a budget…"); `test/goal11-blocker-identity-store.test.mjs` ("every reset drops the identity durably…") |
| Reset: Replacement Goal | A Replacement Goal is a new identity and inherits no chain | `test/goal11-blocker-identity.test.mjs` ("a Replacement Goal starts a fresh audit and inherits no chain") |
| Durable partial chain | A partial audit survives a hard kill and a restart, with its identity | `test/goal5.test.mjs` ("a partial blocked audit survives a restart"); `test/goal11-blocker-identity-store.test.mjs` ("a legacy audit keeps its identity across a reload…") |
| Compaction | A Goal turn Pi compacts and retries is one Goal turn, so the chain is neither advanced nor broken by it | `test/goal11-blocker-identity.test.mjs` ("a compacted Goal turn keeps the audit chain…") |
| Replay / tree navigation | The audit and its identity reconstruct from the selected branch alone, and `/goal resume` clears them | `test/goal7.test.mjs` ("a blocked Goal reconstructed from a branch keeps its audit, and /goal resume clears it") |
| Structured tool responses | `update_goal` and `get_goal` publish the open audit's ID, latest description, and count | `test/goal11-blocker-identity.test.mjs` ("the first report issues an opaque identity…"; "the Continuation restates the open audit…"); `test/goal11-blocker-identity-store.test.mjs` ("the first report of a condition issues…") |
| Continuation restatement | Every Continuation restates the open audit's identity, latest description, and count | `test/goal11-blocker-identity.test.mjs` ("the Continuation restates the open audit…") |
| Human status synchronization | Human-facing status shows the description and the count and never the opaque ID | `test/goal11-blocker-identity.test.mjs` ("the human status shows the description and the count but never the opaque identity") |
| No text-similarity fallback | No continuation, guideline, or message keeps text-similarity equivalence; the store has no blocker-text comparison at all | `test/goal11-blocker-identity.test.mjs` ("the Continuation restates…": `doesNotMatch(/equivalent blockers\|normaliz\|similar/i)`); `test/goal5.test.mjs` ("the continuation contract distinguishes progress, verified waits, and no progress") |
| Persistence fault | An injected append failure leaves the Goal untouched and the turn unowned, so a retry records the first valid report | `test/goal11-blocker-identity-store.test.mjs` ("a persistence failure leaves the Goal untouched and the turn unowned") |
| Malformed audit | A `blockedAudit` whose `blockerId` is not a usable opaque token is dropped during reconstruction | `test/goal11-blocker-identity-store.test.mjs` ("a malformed Blocker identity is dropped during reconstruction…") |
| Legacy preservation | A 0.1.0 audit without an identity survives reconstruction for the handoff, and the 0.1.0 snapshot is not rewritten | `test/goal9-legacy.test.mjs` ("a legacy open audit is preserved for the Blocker-identity handoff without text equivalence"); `test/goal11-blocker-identity-store.test.mjs` ("a legacy audit without an identity survives reconstruction…") |
| Legacy fresh ID | An active legacy Goal with a structurally valid count of one or two is issued and persisted a fresh opaque ID at cutover | `test/goal9-legacy.test.mjs` (same test); `test/goal11-blocker-identity.test.mjs` ("a legacy open audit is handed a fresh identity that survives a reload"); `test/goal11-blocker-identity-store.test.mjs` ("the cutover preserves the legacy description and count…"; "the immutable legacy fixture is handed a fresh identity…") |
| Legacy same-condition advancement | The next report of that condition reuses the ID and satisfies the preserved chain in exactly one durable transition | `test/goal11-blocker-identity-store.test.mjs` ("a legacy audit keeps its identity across a reload…"; "the immutable legacy fixture is handed a fresh identity that advances the preserved chain") |
| Legacy omission reset | Omitting the ID at handoff starts a fresh chain at one and the spent ID is then refused | `test/goal11-blocker-identity-store.test.mjs` ("a legacy handoff identity grants no extra unattended turns when it is omitted"; "the immutable legacy fixture's identity grants nothing…"); `test/goal11-blocker-identity.test.mjs` ("the legacy handoff grants no extra unattended turns…") |
| Legacy no extra turns | The handoff changes no threshold and admits no work; the cutover itself starts no run | `test/goal9-legacy.test.mjs` ("a legacy open audit is preserved…": `assertStepsConsumed(session, 0)`); `test/goal11-blocker-identity.test.mjs` ("a legacy open audit is handed a fresh identity…": `runCount === 0`) |
| Legacy stopped Goal | A stopped Goal's audit describes the stop, is never advanced again, and gets no identity | `test/goal11-blocker-identity.test.mjs` ("a stopped legacy Goal keeps its audit as history and is never advanced"); `test/goal11-blocker-identity-store.test.mjs` ("a non-active legacy audit is preserved as history and gets no identity") |
| Batch 1/2 behavior preserved | Durable ownership, cutover, and cumulative budget recovery are unchanged | `test/goal9-*.test.mjs`, `test/goal10-*.test.mjs`, `test/accounting.test.mjs` — all still green, with only their blocked-audit scenarios re-driven by identity |

### Why the legacy same-condition row is store-only

Real RPC cannot drive a representative legacy same-condition Goal turn. After
loading a 0.1.0 session, the first run can only be started by a typed prompt (a
user action that durably resets the audit before any report) or `/goal resume`
(which drops the audit); the one promptless seam, `/goal edit` on an idle active
Goal, classifies its run as `user`-kind rather than as a representative Goal
turn. The store seam therefore carries this row under #21's "impractical through
RPC" allowance. Identity survival across reconstruction is separately covered
through RPC by the legacy reload test.

## Pre-repair failure evidence

The new and rewritten regressions were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `36790ca`) with the new tests in place.
Reproduce it by exporting the current tree (`git archive HEAD`), overwriting
`src/` with `git archive 36790ca src`, symlinking `node_modules`, then running
`node --test` on the two new test files plus the five rewritten existing
regression files (`test/goal5.test.mjs`, `test/goal7.test.mjs`,
`test/goal8.test.mjs`, `test/goal9-legacy.test.mjs`,
`test/goal10-budget-recovery.test.mjs`). Measured that way: **16 of the 20** new
narrow store tests and **9 of the 12** new RPC scenarios fail; across the five
rewritten existing regression files (`goal5`, `goal7`, `goal8`, `goal9-legacy`,
`goal10-budget-recovery`) **11 of the 76** scenarios fail. They fail because the
pre-repair command surface has no `blocker_id` and the pre-repair store compares
blocker text after normalizing case, whitespace, and trailing punctuation. The
four passing store tests and three passing RPC scenarios assert behavior the
pre-repair code already had: per-turn repeat idempotence, persistence-failure
rollback, legacy-audit loading and stopped-Goal history, the plain third-turn
threshold, and the identity-free human status. Representative failures:

```text
✖ the first report issues an opaque identity that every later turn passes back
  AssertionError: The "string" argument must be of type string. Received type undefined (undefined)

✖ a reworded report reusing the identity advances, an omitted one starts a fresh chain
  AssertionError: The input did not match the regular expression /Blocker recorded \(2 of 3 consecutive Goal turns\)/.

✖ an unknown identity is refused without Goal mutation and does not own the turn
  AssertionError: The input did not match the regular expression /is not the Blocker identity of the audit currently open/.

✖ a stale identity from an ended chain is refused, and a corrected call starts a fresh one
  AssertionError: The input did not match the regular expression /is not the Blocker identity of the audit currently open/.

✖ the Continuation restates the open audit, and get_goal publishes its identity
  AssertionError: the two drafted after the first report restate the open audit

✖ a legacy open audit is handed a fresh identity that survives a reload
  AssertionError: a fresh opaque identity was issued and persisted

✖ update_goal(blocked) needs the same blocker for three consecutive Goal turns
  AssertionError: The "string" argument must be of type string. Received type undefined (undefined)

✖ a legacy open audit is preserved for the Blocker-identity handoff without text equivalence
  AssertionError: the cutover issues a fresh opaque Blocker identity
```

The narrow store failures are the same shape at the store seam, for example:

```text
✖ the first report of a condition issues an opaque Blocker identity and persists it
  AssertionError: Expected values to be strictly deep-equal:
  + actual - expected
    [
      'blocker',
  -   'blockerId',
      'turns'
    ]

✖ an unrecognized or non-current identity is rejected without Goal mutation
  AssertionError: Expected values to be strictly equal: true !== false

✖ the cutover preserves the legacy description and count and issues a fresh identity
  AssertionError: a fresh identity is issued
```

The complete captured run is quoted in the PR description. After the repair, the
same suite passes and `npm run typecheck` passes; the current counts are recorded
in the PR description.

## Compatibility landing constraint

Batches 1–3 form one mandatory compatibility landing unit (see #23). This branch
is not independently releasable: cutover without batch 3 cannot advance a
preserved legacy audit by identity, and the blocked audit cannot recognize a
reworded report at all.
