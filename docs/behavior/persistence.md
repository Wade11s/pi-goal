# Persistence model and legacy cutover

Where Goal state lives in the session, how reconstruction works across restart,
reload, and tree navigation, and how a 0.1.0 snapshot is migrated exactly once.

[← README](../README.md) · See also [accounting](accounting.md) ·
[lifecycle](lifecycle.md) · [attachments](attachments.md) ·
[history](history.md) · [events](events.md)

## Persistence model

- Goal snapshots are stored as **custom session entries** (`goal-state`), which
  live outside the model context. The last snapshot on the active session branch
  wins, so restart, resume (`--continue` / `--session`), and extension reload
  (`/reload`, or any runtime replacement) reconstruct the state without the user
  restating the objective. Reconstruction also runs after `session_tree`
  navigation and on forked sessions: the *selected* branch alone decides the
  state, so snapshots on an abandoned branch cannot leak into the newly selected
  one, a cleared Goal stays cleared on the branch that cleared it. The newest
  *current* `goal-state` entry controls the branch: if it is malformed or has an
  unrecognized version, reconstruction **fails closed** with no current Goal and
  an actionable notification rather than falling back to an older snapshot, which
  could resurrect a cleared, replaced, or stopped Goal. A later valid snapshot or
  tombstone still wins. An entry marked `superseded` is a finalized historical
  record of a replaced identity: it is valid and replayable, but it never wins,
  so freezing the old identity's tail can never make it the current Goal. A
  branch change is announced only when the reconstructed state observably
  changed.
- A snapshot carries the optional `blockedAudit`
  (`{ blockerId?, blocker, turns }`): the Blocker identity the extension issued for
  the chain, the blocker that stopped the Goal or that is accumulating toward the
  blocked threshold, and how many consecutive Goal turns reported it. It is durable
  for the same reason the audit has to survive compaction, and a malformed one —
  including a `blockerId` that is not a usable opaque token — is dropped during
  reconstruction rather than trusted. A pre-repair 0.1.0 audit carries no
  `blockerId`; it is preserved verbatim for the one-time cutover handoff and can
  never be advanced by identity before it.
- The kickoff is delivered as a **user message** carrying the user's own
  objective (attributed as user-provided Goal data). As the session's first
  conversation entry it also makes Pi create and flush the session file, which
  Pi otherwise defers until a user/assistant message exists. Continuation uses
  the separate `goal-continuation` **custom-message** channel, because
  `agent_before_settle` drafts are custom messages: they participate in model
  context. Note that Pi flattens a custom message into a plain user-role LLM
  message and drops `customType` at the provider boundary, so the channel name
  alone cannot mark a message as extension-authored — which is why each message
  on the channel states its own authority and frames the objective as delimited
  data (see [The objective's trust boundary](../tools.md#the-objectives-trust-boundary)).
- Creation is durability-first: the snapshot is written and made visible, the
  kickoff triggers the file flush, and only after that snapshot is the **last**
  `goal-state` entry on disk is success announced. Visibility comes first so a
  `/goal:clear`, `edit`, `pause`, or `resume` issued while creation waits for
  idle acts on the same record the creation captured; every wait revalidates
  the exact id and revision, and a changed record suppresses the queued stale
  kickoff. A tombstone written during the wait therefore counts as *not* durable
  and cannot be overridden by a pre-tombstone entry exhibiting the same id. The
  continuation seam also declines to adopt the run that creation is waiting for
  for as long as that staged Goal identity is the pending creation, including
  after an edit bumps its revision, so the wait ends at idle instead of
  consuming the creation's own kickoff.
  If writing fails (unwritable session file or storage) for a brand-new Goal,
  creation reports a clear persistence error and retracts any in-memory state
  with a durable tombstone snapshot. A failed **replacement** write leaves the
  existing Goal untouched in memory and on disk (no tombstone, no resurrection
  on restart), and `/goal <objective>` can simply be retried.
- A Goal with Objective attachments also persists their immutable manifest
  (`hash`, `mediaType`, `bytes`, `label`) in every snapshot. The bytes live in a
  content-addressed, Goal-keyed `pi-goal-store` beside the session file and are
  materialized before the snapshot commits. Source paths and remote source URLs
  are not persisted: the manifest is the complete durable identity of the
  material. Restore and branch navigation verify
  those hashes: missing or corrupt artifacts surface an explicit error and
  suppress automatic Continuation without silently dropping the manifest or
  changing Lifecycle status. Clear and replacement retain committed artifacts
  for historical branches; V1 performs no destructive automatic garbage
  collection. See [Objective attachments](attachments.md).
- Every committed transition also appends a **`goal-history`** custom entry beside
  its snapshot: the committed identity, revision, transition, previous and current
  Lifecycle statuses, timestamp, usage summary, Active elapsed time, and the
  attachment manifest's metadata (hashes included, contents never). The timeline is
  derived diagnostic data — it is written from the same committed-transition seam as
  the local event stream and is projected from that stream's payload, so the two
  cannot disagree — and it is never read by reconstruction: a missing, truncated, or
  malformed entry cannot resurrect, clear, replace, or otherwise change the current
  Goal. `/goal:history` renders it, read-only. See [Goal audit history](history.md).
- Usage accounting is durable too. Token totals are always recoverable from the
  session branch, and the accounted active time is checkpointed into separate
  `goal-usage` custom entries — kept apart from `goal-state` so the lifecycle log
  stays one entry per transition. On reconstruction the branch is replayed from
  after the newest checkpoint or snapshot, which is why a restart recovers usage
  accrued since the last write and can never charge it twice.
- Interrupting the kickoff (Ctrl+C, killing the process, a hung model) does not
  lose the Goal: the snapshot and kickoff are already on disk and are restored
  by the next session.
- Concurrent `/goal` commands (for example two issued while Pi is busy with a
  run) are serialized: the Goal slot is decided exclusively, and a second
  command that would replace an unfinished Goal has to be confirmed before
  anything is discarded — a silent replacement cannot happen.
- Lifecycle transitions (pause, resume, clear, edit) append their snapshot
  through the same write-through path, so a transition is on disk before its
  notification is emitted, and a failed write leaves the previous state in
  force with a retryable error instead of a phantom transition.
- Ephemeral sessions (started with `--no-session`) cannot persist a Goal:
  creating one returns a clear error instead of claiming durable storage.
- Sessions without a Goal behave exactly as before; installing the extension
  only adds the command, the three tools, and the state they manage.

## Legacy 0.1.0 cutover

A `goal-state` snapshot written by pi-goal 0.1.0 is still loadable. It is never
reinterpreted as evidence it cannot contain, and loading or migration sends no
message and triggers no provider request.

- The newest valid snapshot or tombstone determines the branch state. A malformed
  or unrecognized newest `goal-state` fails closed with no current Goal and
  actionable guidance; the extension never falls back to an older entry.
- Once, under the 0.1.0 status-only accounting rules, the legacy token totals and
  active milliseconds are reconstructed and frozen as the Goal's **legacy
  reconstructed totals**. They are a historical baseline, not exact Goal-owned
  attribution rebuilt under the repaired rules; `/goal` reports them as they are.
- Before any repaired Goal work is admitted, the repaired snapshot and a
  branch-local `goal-cutover` marker are written durably. A fork copied before the
  cutover performs its own migration when selected; a fork copied after it
  inherits the baseline. The legacy prefix is never replayed or merged again.
- Absent optional fields keep their 0.1.0 meanings: origin `command`, zero usage
  and active time, `wrapUpPending` false, and no open audit. An active Goal keeps
  its normal continuation eligibility; every non-active status stays stopped,
  `complete` stays terminal, and a tombstone leaves no current Goal.
- The configured `goal.maxTokenBudget` is a hard safety bound during migration: an
  unbounded Goal or one above the maximum is migrated to the maximum with an
  explicit notice, while `goal.defaultTokenBudget` is never applied
  retroactively. An active Goal whose reconstructed usage already reached its
  effective budget becomes `budget_limited` and earns one bounded wrap-up; a
  pending legacy wrap-up is delivered at most once.
- A valid legacy open audit is preserved for the Blocker-identity handoff, and an
  **active** legacy Goal with a structurally valid count of one or two is issued a
  fresh opaque Blocker identity in the same durable cutover transition. The
  description and the count are carried over unchanged, the identity is not
  derived from the blocker text, and no extra unattended turns are granted: the
  next report of that condition must reuse the identity to advance, and omitting
  it starts a fresh chain at one. A stopped Goal's audit describes its stop, is
  never advanced again, and gets no identity. An existing `origin: "tool"` Goal
  remains a valid historical Goal, but migration grants no fresh Goal-creation
  authority.
