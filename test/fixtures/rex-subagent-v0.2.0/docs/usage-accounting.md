# Usage accounting

Rex children are independent Pi processes. Their assistant and nested-tool usage
cannot be seen by the parent merely because the parent spawned them. The
accounting provider bridges that process boundary without teaching the parent,
pi-goal, or another consumer how to parse a child session.

## Normal tool flow

Use the parent tools for delegation:

| Tool | Purpose |
| --- | --- |
| `rex_spawn` | Launch a direct child and record its zero baseline |
| `rex_wait` | Reconcile lifecycle state, then observe every requested handle |
| `rex_observe` | Collect newly published usage without waiting |
| `rex_adopt` | Claim an unowned run, or establish a baseline for a same-parent CLI-created run |
| `rex_stop` | Stop, collect final usage, and optionally remove the run records |

The CLI remains useful for logs, follow-up messages, inspection, and explicit
management. A CLI-created run has no parent-branch baseline: call `rex_adopt`
before observing it. Do not use a CLI removal path and then expect parent-side
attribution; deletion can strand an unobserved snapshot.

A successful observation stores its cursors in the parent tool result's
`details`. Its combined new usage is stored in the standard Pi tool-result
`usage` field. Pi persists both. Consumers charge the tool result, not the
snapshot and not a second Rex-specific entry.

## Child snapshots

Each run directory contains `usage.json` with this accounting contract:

| Field | Meaning |
| --- | --- |
| `version` | Snapshot schema version, currently `1` |
| `source` | `pi-rex-subagent` |
| `runHandle` | Rex run identity |
| `parentSessionId` | Accounting owner, or `null` before an unowned run is claimed |
| `childSessionId` | Current child Pi session identity |
| `childSessionGeneration` | Opaque identity derived from the durable session header ID and creation timestamp |
| `sequence` | Integer starting at `1` and increasing on every publication in this generation |
| `usage` | Complete cumulative Pi `Usage` for the selected branch |
| `final` | Clean process-quit or stop-finalization marker |
| `updatedAt` | Diagnostic timestamp; never used to calculate a delta or decide staleness |

Generation survives reload and same-session process resume. It is not a PID or
extension-instance counter. A replaced, forked, reset, or different session is a
new generation.

The child recomputes from persisted entries on its selected branch at session
start, turn end, agent settlement, compaction, and session teardown. It also
publishes when stop is noticed and after the aborted turn settles. Snapshot
writes use a unique temporary file and atomic rename.

The aggregate includes:

- assistant-message usage, including persisted error/aborted messages;
- tool-result usage, including nested usage already aggregated by Pi;
- compaction and branch-summary usage.

Standalone usage entries, including cache warming, are excluded. Every numeric
field must be finite and non-negative. Cached reads/writes, optional reasoning
and cacheWrite1h, totalTokens, and all cost fields are preserved. Child active
time is never added to parent active time.

A snapshot is published before corresponding `idle` or `stopped` status. A
reload-related shutdown publishes a non-final snapshot because the same
generation continues. Only process quit or stop finalization marks a snapshot
final. If a process crashes, the last durable snapshot remains collectible, but
usage that never reached the Pi session or a snapshot cannot be recovered.

### Sequence and final-state rules

- Sequence gaps are valid because usage is cumulative.
- Rereading the same sequence with the same accounting payload is idempotent.
- The same sequence with different accounting content is a conflict.
- A lower sequence, changed child session ID or generation, negative component
  delta, or vanished optional numeric component is invalid, including when the
  sequence increases.
- A new sequence or changed payload after a final snapshot is invalid.
- Rereading an identical final snapshot returns zero new usage.

Failures are never clamped, silently reset, or converted into a new zero
baseline.

## Parent baselines and cursors

Accounting details have `version`, `kind`, `parentSessionId`, and `runs`.
`kind` is `spawn`, `adoption`, or `observation`. Each run cursor contains:

- `handle`;
- `childSessionId` (`null` only for a new spawn baseline or terminal-missing recovery);
- `generation` (`null` only for a new spawn baseline or terminal-missing recovery);
- `sequence`;
- `cumulative` Usage;
- `final`;
- optional `finalization: "unconfirmed"` when a provably terminal stop could
  collect only a non-final snapshot, or terminal wait/stop established the
  missing-snapshot recovery below;
- optional `snapshot: "missing"` on the replayable terminal owned-run
  recovery cursor described below;
- optional `unownedAdoption: true`, present while the cursor has observed only
  the adoption baseline and other legitimate pre-claim null-owner snapshots.

The cursor version remains `1`: the diagnostics and adoption marker are
optional, and older cursors without them remain valid. An older adoption cursor
does not authorize a null-owner snapshot. The adoption marker is retained by
unchanged observation results for restart and selected-branch replay. While it is present, a newer null-owner snapshot of the
same generation is a legitimate pre-claim publication — a busy unowned child
may publish one that was already in flight while adoption claimed the run —
and it is charged with its exact delta, keeping the marker. The marker is
omitted once an owned snapshot advances the cursor, and a null-owner snapshot
is always rejected after that owned cursor: an owned observation cursor cannot
accept an otherwise identical snapshot whose owner changes to `null`.

A spawn baseline is sequence `0`, neutral zero Usage, no generation, and
`final: false`. It charges all subsequent child work, even when the first wait
happens after several child turns. Adoption instead records the current valid
snapshot as its baseline and charges none of the pre-adoption work. Re-adoption
on a branch that already has a baseline is rejected.

If launch succeeds but recording that spawn baseline fails, `rex_spawn` returns
an error with the new handle, persists `usageBaselineError` in the run record,
and attempts a non-removing lifecycle stop. A successful rollback retains the
stopped record and snapshots for diagnosis but emits no Usage and cannot be
adopted as a substitute baseline. If rollback cannot be confirmed, the error
explicitly says that the child may still be running and requires external
management. The failed accounting result never replays as a zero baseline.

An owned run that is provably terminal before ever publishing `usage.json`
(for example, a direct-spawn startup crash or a pre-upgrade child with no
parent-branch baseline) can finish with a special observation cursor: sequence
`0`, null child identity, neutral zero cumulative Usage, `final: false`,
`finalization: "unconfirmed"`, and `snapshot: "missing"`. This is bookkeeping
for zero **recoverable observed Usage**, not a claim that the child historically
did no work. The result omits `usage`, includes a clear text diagnostic, and can
be replayed or read again idempotently after restart. Only a terminal wait/stop
can establish this state; a missing snapshot for a live or unproven run remains
an error. Adoption never creates this cursor and still rejects a missing
baseline as unknown history. Once terminal-missing recovery is recorded, a
later-appearing snapshot is rejected rather than charging unknown history.

On parent session start and session-tree navigation, the provider folds only
successful Rex accounting tool results on the selected parent branch. It ignores
abandoned branches, failed accounting transactions, and payloads belonging to a
different parent identity. A branch that inherits a spawn but not an earlier
observation therefore resumes from the original zero baseline. Reconstruction
itself charges nothing.

A malformed payload degrades per run instead of per session: the cursors it
carries stay unloaded — never zero-defaulted and never authorized to observe —
so only the runs it covers fail closed, while sibling runs and unrelated
spawn/adopt/wait/stop calls keep working. The failure diagnostic names the
offending entry id and tool, and because folding follows branch order a later
valid result for the same run re-establishes its cursor. A run whose latest
result is corrupt therefore stays fail closed, and re-adoption is refused for
it, until the corrupt entry is resolved on the selected branch. If a malformed
payload has no enumerable run handle, the whole selected branch fails closed
instead of falling back to an older cursor and potentially double-charging.

## Delta and transaction rules

- Repeated handles in one call are deduplicated.
- Lifecycle waiting happens before the accounting critical section.
- Wait observes every requested handle, including timeout, blocked, error,
  stopped, gone, failed, and exited outcomes.
- A parent-local transaction queue serializes observation. Multi-run validation
  finishes before any in-memory cursor is committed.
- If any requested run fails validation, the call returns an error with no
  accounting `usage`, and none of that call's cursors advance. A later valid
  retry can charge every delta once.
- A successful call returns one combined Usage delta and every requested run's
  resulting cursor, including unchanged and zero-delta cursors.
- When the combined numeric delta is zero, `usage` is omitted but cursors still
  advance. The terminal missing-snapshot recovery cursor likewise emits no
  `usage`; malformed files are never treated as missing or replaced by zero.

Numeric addition and subtraction cover every Usage and cost component. A delta
from a neutral all-zero baseline inherits the current cost provenance. Otherwise
it is provider-reported only when both cumulative endpoints are provider-reported.
A non-neutral cumulative `cost.totalFromProvider` transition from `false` to
`true` is rejected before any cursor commits. A `true` to `false` transition is
valid, and the resulting estimated/mixed stream cannot later be upgraded.
Combining several deltas preserves provider-reported provenance only when every
nonzero contributor has it. Estimated or mixed provenance is never upgraded.

## Ownership, adoption, and nesting

A run has at most one accounting owner in V1:

- A tool-spawned run is owned by the current parent session immediately.
- A same-parent CLI-created run still needs an explicit adoption baseline,
  except for the explicit terminal-missing cleanup recovery below.
- An unowned run can be claimed by one parent. Its last unowned snapshot can be
  used only as the adoption baseline; subsequent snapshots normally carry the
  new owner. One that was already in flight during the claim may still report a
  null owner and is accepted as a pre-claim publication with its exact delta,
  until an owned snapshot advances the cursor.
- A run owned by another parent is rejected. Cross-parent transfer is out of
  scope for V1.

Adoption creates a durable per-run `.accounting-owner.json` exactly once. It
first writes and closes a complete, uniquely named temporary file, then
publishes it with an atomic hard link. The link's no-overwrite `EEXIST`
semantics make the first complete claim win across independent parent Pi
processes; later adopters re-read the claim instead of overwriting it. A
competing parent receives an error and no baseline, so it cannot charge the
winner's post-adoption delta. Temporary files are removed after success and
handled failures. All run readers, including the child snapshot provider and
navigation guard, resolve this claim together with the run record. Conflicting
record and claim identities are rejected as corruption.

There is no stale lock to steal or delete. A crash before the link leaves the
run unowned and permits another parent to claim it; an orphaned temporary file
is not a claim and is ignored by readers. A crash after the link preserves a
complete owner claim. There is no create→write window in which the visible
claim can be empty or partial. Filesystems without hard-link support reject the
claim with a run-level accounting error; there is deliberately no direct-write
fallback that could expose partial content. An interrupted adoption whose
baseline tool result was never persisted can be retried by the same owner; the
retry establishes a new current baseline and does not retroactively charge the
uncommitted attempt. A malformed claim left by an older version or external
modification still fails closed rather than being overwritten automatically.

Nested usage crosses one process boundary at a time. A child's aggregate already
contains its tool-result usage for a grandchild. The root observes only its
direct child and cannot adopt or observe the grandchild independently.

## Stop and removal

For a live run, accounting-aware stop records that finalization is required and
then:

1. Writes the normal local stop sentinel and aborts the current turn.
2. Gives the child an opportunity to publish an early non-final snapshot.
3. Waits for the aborted turn and its tool results to settle.
4. Publishes the final snapshot before stopped status and graceful Pi shutdown.
5. Reconciles the normal Rex close/probe confirmation.
6. Observes the final snapshot.
7. Removes records only after both stop confirmation and final observation
   succeed.

If finalization or final observation fails, the tool reports both the stop
outcome and accounting error, and records and snapshots remain for a retry. The
durable finalization-required marker is persisted only when the run was
reliably live immediately before the stop. When the pre-stop state cannot be
determined — a failed describe or an `unknown` display state — the attempt
fails closed without newly persisting the marker, so it cannot poison later
collection once `exited` or `gone` is proven.

A genuinely live stop always requests finalization before close, even if the
child subsequently dies. On a later attempt whose pre-stop process state is
provably terminal, no final can still arrive: the last valid durable non-final
snapshot may instead be collected with `final: false` and
`finalization: "unconfirmed"`. Successful final or unconfirmed collection
clears `usageFinalizationRequired`, and accounting-aware removal may then
proceed. A malformed or conflicting snapshot still fails closed, leaves the
marker intact, and is never discarded. The unconfirmed diagnostic is retained
by identical later observations and durable branch replay; it never relabels
the snapshot as final.

The terminal owned-run `snapshot: "missing"` recovery described above also
applies to stop/removal and terminal waits. It permits zero-observed-Usage
bookkeeping and removal without inventing historical usage or accepting a
missing snapshot for a live run.
The parent's default final-snapshot wait is 15 s, deliberately longer than the
child's default 10 s stop grace, so a healthy slow settlement is not preempted.
The child side keeps the pre-accounting intentional-stop exit semantics: when
its aborted turn never settles or its final snapshot cannot be published, it
still ends with `status: stopped` and a success exit, so the run is not
reclassified as an incidental `exited` failure. That status is not an
accounting-completion signal. A later terminal retry may finish with
`finalization: "unconfirmed"` or `snapshot: "missing"` and remove the records;
unsettled usage that never reached a durable snapshot can remain unrecoverable,
and the tool result preserves that diagnostic.

If final accounting succeeds but the subsequent removal fails, the tool still
returns the successful Usage delta and cursors together with the removal error.
It must not turn a completed accounting transaction into an error result that
branch replay would ignore.

Existing CLI stop and prune semantics are unchanged. They are not an
accounting-aware removal workflow.

## Managed child navigation

A managed child with an accounting owner stays on one session and selected
branch in V1. Session replacement, resume into another session, fork, and
session-tree navigation are refused with an explanatory notification while the
run has an owner; ownership is checked at navigation time, so adopting a CLI
child makes its later navigation refuse. Reload, same-session process resume,
normal turns, and compaction remain available. A truly unowned CLI child keeps
normal Pi navigation; navigation it performed before adoption is simply part
of the session state the adoption baseline captured. If ownership cannot be read
or the record and claim conflict, navigation and snapshot publication fail
closed instead of being treated as unowned. An externally caused generation
change or cumulative regression after adoption fails closed; V1 does not
transparently migrate it to a new baseline.

## Goal boundary and observation time

Rex has no Goal identity, Goal admission, Token budget, or pi-goal dependency.
The parent tool result is charged only under the consumer's existing rules.

V1 uses **observation-time ownership**. Work performed while a Goal is stopped
but first observed after resume can belong to the observing admission segment.
This is deliberately not invoice-exact lifecycle attribution. Strict pause and
resume reconciliation is outside this provider's V1 boundary.
