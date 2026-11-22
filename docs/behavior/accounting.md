# Usage accounting

How Goal-owned token usage and active elapsed time are counted, when they become
durable, and why replay and the live path converge.

[← README](../README.md) · See also [budgets](budgets.md) ·
[persistence](persistence.md)

Token usage and active elapsed time are durable Goal state, recovered from the
session after a restart, a resume, a reload, or tree navigation.

**Tokens.** Pi reports a `Usage` record on every assistant message, and optionally
on tool-result messages for model work a tool performed. The accounted total is

```
input + output + cacheWrite
```

because that is what Pi's documented usage semantics mean:

- `input` excludes cached reads *and* cache writes — every Pi provider adapter
  subtracts both (`input = prompt_tokens - cached - cache_write`), so adding
  `cacheRead` on top would double-count reuse;
- `cacheRead` is prompt reuse, not new work, so it is excluded from the total and
  reported separately for transparency;
- `cacheWrite` is freshly processed prompt tokens that Pi itself counts in session
  totals, so it is real consumption (`cacheWrite1h` is a subset of it and is never
  added again);
- `reasoning` is already a subset of `output` in every Pi provider adapter, so it
  is reported and never added a second time.

Each report is charged exactly once: an assistant response, a tool result (by tool
call id), and a summarization entry (compaction, branch summary) each have a
stable identity, and nested tool usage — which Pi merges into the calling tool
result's own `usage` and never persists separately — is therefore counted once,
not twice. Reconstruction replays the session branch under the same rule, so a
reload, a restart, or a tree navigation converges on the same totals instead of
re-charging them.

A report is Goal work only inside an open **admission segment**. A segment opens
when Pi delivers a Goal work message — the `/goal` kickoff, an objective edit, a
resume, an automatic Continuation, or the one Budget wrap-up — and closes when Pi
delivers a genuine user prompt or a new Goal identity. Every work message names the
Goal identity it was admitted for, and the delivery seam opens the segment only when
that identity is the current Goal. A work message queued for a Goal that has since
been cleared or replaced therefore opens nothing: the generic `[pi-goal]` prefix
alone never authorizes admission. `/goal <objective>` therefore
starts attribution at its actual kickoff: the ordinary run the command waited for
is never adopted. `create_goal` leaves its creating run ordinary, and attribution
starts at the first subsequent Continuation; pre-creation responses, creation
controls, and unrelated same-batch tool results are excluded. Ordinary prompts
are excluded in every lifecycle status.

External child usage follows **observation-time ownership** in V1. A provider
returns only the newly observed delta on the parent tool result, and that delta
belongs to the admission segment that observes it. Consequently, child work
performed while a Goal is paused but first observed after `/goal resume` can
belong to the resumed segment; it is not retroactively attributed to the paused
segment. The same boundary rule applies to durable replay: the persisted parent
tool result, not the child's private snapshot, is the accounting record. Strict
reconciliation at every pause/resume boundary is deliberately not claimed.

Delivery is the seam at both ends because it is the entry the branch replay reads
back. A steer queued during an in-flight response reaches the branch only *after*
that response and its tool results, so a segment opened at queue time would charge
the previous identity's work to the new Goal; and a prompt typed while a response
streams is delivered only after that response, so a segment closed when the prompt
was typed would drop work the Goal had already admitted. Either way live accounting
and replay would disagree — and a budget only the live path failed to stop would be
crossed on reload, where the reconstruction re-derives the stop from the branch.
Work already admitted stays attributable through pause, completion, a blocked or
usage-limit stop, and other lifecycle boundaries, while no new substantive work is
admitted after the stop. Completion stays terminal on both paths, which is what
keeps the completing batch aligned with a replay that skips everything after a
completion snapshot.

Durable writes happen only at boundaries where every entry they cover is already
on the branch. The ordering matters: Pi dispatches `message_end` to extensions
*before* it appends the message that triggered it, so a checkpoint or a lifecycle
transition written from inside that handler would sit on the branch *ahead* of the
entry it already accounts for, and a reconstruction would replay that entry and
charge it a second time. Usage is therefore charged at `message_end` — enforcement
and status have to be immediate — and persisted at `turn_end`, `agent_before_settle`,
`agent_settled`, and shutdown.

The invariant has two halves, and both have to hold: a durable write must not sit
ahead of an entry it covers, and it must cover *every* entry already on the
branch. Every durable snapshot — a lifecycle transition as much as an accounting
checkpoint — therefore carries the live accounting view at the moment it is
written rather than the totals some earlier decision froze, so usage that lands
in between — a concurrent nested tool result that was already in flight when the
budget was crossed — is inside the snapshot instead of falling into the gap in
front of it, where the replay can reach in neither direction.

A checkpoint is a shortcut over that replay, never a second source of truth: the
branch is the authority. Reconstruction adopts a checkpoint only when adopting it
loses nothing, comparing its totals against the entries between the snapshot and
it. A checkpoint that reports *fewer* tokens than those entries account for means
the live path declined a report the replay charges, and adopting it would seal the
omission permanently — the entry sits before the checkpoint, so no later replay can
reach it. Such a checkpoint is discarded, the replay carries on, and only its
active time is kept, because that is the one thing the branch cannot reconstruct.

What is *not* counted: Pi's `usage` session entries (cache-warming refreshes),
which are reported outside the transcript and outside Goal work; and any response
produced after a Goal is complete, because completion is terminal. What *is*
counted: the turn that completes a Goal or exhausts its budget, the one bounded
wrap-up, and every later run of a `budget_limited` Goal. The branch replay after a
restart draws exactly the same line, so an unclean exit cannot reclassify
post-completion work as Goal usage.

The formula is the extension's accounting rule applied to what Pi reports, never
an invoice: provider billing is not reconciled, cached reads are excluded, and a
migrated 0.1.0 Goal carries legacy reconstructed totals rather than exact
Goal-owned attribution. Observation-time ownership is an attribution
approximation, not strict lifecycle attribution. A child crash can also leave
work that never reached either its Pi session or a durable provider snapshot;
that unrecorded work is unrecoverable, and terminal missing-snapshot recovery
reports zero *observed* usage rather than claiming the child did no work. A
budgeted Goal's completion says so explicitly next to the numbers it reports (see
[completion usage report](budgets.md#completion-usage-report)).

**Active time.** A monotonic clock (`performance.now()`, sampled exactly once per
operation and clamped to the highest value seen) runs while a Goal is active in a
live session. Every non-active status stops it — `paused`, `blocked`,
`usage_limited`, `budget_limited`, and `complete` — as does process downtime, so
the interval after a stop (including the trailing response of the run that caused
it) is never billed. Folding a segment into the record at a lifecycle
boundary neither loses nor double-counts time, and the accounted value is
checkpointed durably at most once per accounted second of Goal activity, at every
settlement, and at shutdown. Because the source is monotonic, a clock adjustment
cannot make accounted time jump or shrink.

Disabling the extension (`goal.enabled: false`) does **not** stop this clock: an
active-but-disabled Goal keeps its `active` status, so idle-active time keeps
accruing until the user pauses it. Pausing the Goal, not disabling the extension,
is what stops Active elapsed time. For the same reason, no new Goal-owned usage
is admitted while the extension is disabled: every run starts from a user prompt,
and a user prompt closes the admission segment.

Checkpoints are event-driven, not periodic: an *idle* active Goal accrues active
time that only becomes durable at its next settlement or shutdown, so an unclean
exit can lose more than one second of active time. Tokens are never lost that way —
they are always recoverable from the branch, and a checkpoint that disagrees with
the branch is discarded rather than adopted (see above).
