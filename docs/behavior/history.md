# Goal audit history

The branch-local, renderer-friendly timeline of committed Goal transitions — and
why it can never become a second source of truth.

[← README](../README.md) · Map: [docs/README.md](../README.md) ·
See also [events](events.md) · [persistence](persistence.md) ·
[lifecycle](lifecycle.md)

## What it is

Every meaningful durable Goal transition — the same set the local
`pi-goal:updated` event stream covers — is also appended to the session branch as
a `goal-history` custom entry. `/goal:history` renders those entries as a readable
timeline:

```
/goal:history
```

```
Goal history on this branch (6 records, non-authoritative — the durable Goal snapshots and tombstones remain the only lifecycle authority):
2026-01-01T00:00:00.000Z  created  goal_1a2b3c4d  revision 0  → active  0 tokens  active 0s
2026-01-01T00:05:00.000Z  paused  goal_1a2b3c4d  revision 1  active → paused  48210 tokens  active 5m 12s
    attachments: spec.md (text/plain, 12.1 KB) sha256:9f86d081884c
2026-01-01T00:06:00.000Z  objective-edited  goal_1a2b3c4d  revision 2  paused  48210 tokens  active 5m 12s
2026-01-01T00:07:00.000Z  resumed  goal_1a2b3c4d  revision 3  paused → active  48210 tokens  active 5m 12s
2026-01-01T00:09:00.000Z  completed  goal_1a2b3c4d  revision 4  active → complete  96500 tokens  active 7m 3s
2026-01-01T00:10:00.000Z  cleared  goal_1a2b3c4d  revision 4  complete  96500 tokens  active 7m 3s
```

Each line carries the committed identity, the revision the transition committed,
the previous and current Lifecycle statuses, the transition's own timestamp, the
committed usage summary, the Active elapsed time at that point, and — when the
Goal has an attachment manifest — the manifest's metadata including each content
hash. A Goal without attachments renders no `attachments:` line.

## What it is not

The timeline is **derived diagnostic data**. Goal snapshots and tombstones on the
`goal-state` channel remain the only lifecycle authority, and the history is
shaped so that it cannot become a second one:

| Rule | Why |
| --- | --- |
| Nothing reconstructs from history. | Reconstruction reads `goal-state` alone. A missing, truncated, or malformed `goal-history` entry cannot resurrect, clear, replace, or otherwise change the current Goal — the worst it can do is make the timeline harder to read. |
| No command mutates from history. | `/goal:history` only reads and renders. There is no command, tool, or option that applies, replays, or reverts a history record, so the timeline is not a mutation interface. |
| No record is written before its transition is durable. | The append happens in the store's committed-transition seam — the same seam that publishes the event — after the snapshot or tombstone has been written through. A refused or failed transition writes nothing; a retraction appends nothing further, while the `created` record its earlier commit wrote survives as the documented accepted corner below. |
| History is projected from the event payload. | Each record is derived from the `pi-goal:updated` payload of its transition rather than re-projected from the Goal record, so the timeline and the public event stream cannot disagree about what happened. |
| No attachment contents, ever. | The record carries the manifest's metadata (hash, media type, byte size, label), exactly as the event does. The bytes live once, in the extension-owned artifact store. |
| No Goal title text. | Like the Objective's text, the title follows the Objective's privacy boundary; the record is projected from an event that never carries the label. A title-only edit still appears as the in-place `objective-edited` record, without its text. |
| No objective text, either. | The timeline names identities, revisions, statuses, and numbers. The objective is durable Goal state on `goal-state` and in the delimited data blocks of Goal messages; it never reaches a diagnostic surface. |

## What is recorded, and what is not

Recorded, one entry per committed transition: `created`, `replaced`,
`objective-edited`, `paused`, `resumed`, `budget-recovered`, `cleared`, `blocked`,
`usage-limited`, `budget-limited`, and `completed` — the same coverage as the
event stream (see [events](events.md)).

Not recorded:

- **Accounting churn.** Token deltas, `goal-usage` checkpoints, and active-time
  ticks never produce a record. Only the durable budget *exhaustion* does.
- **Audit bookkeeping.** A below-threshold blocker report is a durable audit step
  (the Goal keeps working), an audit reset, the budget wrap-up's delivery and its
  disarm, and a superseded identity's freeze are bookkeeping rather than
  transitions — each writes a `goal-state` snapshot without a history record.
- **Retractions — an accepted corner.** A creation whose durability poll later
  fails is retracted with a tombstone, and a durability-rollback restore rewrites
  the previous record. Neither is a lifecycle transition, so the retraction path
  itself writes **no** history record — this is the "no records for rolled-back
  transitions" rule. The one record that survives is the `created` entry the
  transition's *commit* already wrote, because the commit announced the creation
  exactly as the `pi-goal:updated` stream does (the same accepted corner documented
  in [events](events.md)); the later retraction takes the Goal back on the
  authoritative `goal-state` channel and appends nothing further.
- **A creation refused by an unfinished Goal.** Nothing was committed, so nothing
  is recorded; the user is told to finish the Goal or run `/goal:clear` first.

## The documented crash gap

The append follows the lifecycle commit, so a process that dies *between* the two
leaves a transition with no history record. This is the one asymmetry the design
accepts, and it is bounded:

- the `goal-state` snapshot or tombstone is already durable, so reconstruction and
  every later transition are exactly what they would have been;
- the timeline simply has no record for that transition — no placeholder, no
  reconstruction pass that would have to invent the missing entry;
- the next transition appends normally, so the gap never propagates.

`/goal:history` makes no claim about a record that is not there: it renders the
records the branch holds, and it says so explicitly when an entry is present but
unreadable.

## Malformed and missing entries

A `goal-history` entry that is not a recognizable record — a truncated line, a
hand-edited file, a version this build does not understand — is **skipped and
counted** by the rendering, never trusted and never fatal:

```
1 history entry on this branch could not be read (malformed data or an unsupported version) and were skipped.
This affects only this timeline: the current Goal is reconstructed from its durable snapshots and tombstones,
which are unaffected.
```

The notice is a rendering diagnostic. It changes no Lifecycle status, no revision,
and no accounting, and the Goal keeps working exactly as it did.

## Branch locality

History entries live on the session branch, like `goal-state` entries. Navigating
the tree to an older entry shows the timeline that belongs to the selected branch
and never one from a branch the session left behind; a fork or clone carries the
records its branch copied, and nothing else. A restart reconstructs the same
timeline, because the records are durable session state rather than runtime state.
