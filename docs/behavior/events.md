# Goal-updated events

The local event contract for other Pi extensions: what pi-goal announces on the
shared extension event bus, when, and what deliberately stays off the stream.

[← README](../README.md) · Map: [docs/README.md](../README.md) · See also
[metrics](metrics.md) · [history](history.md) ·
Attachments: [behavior/attachments.md](attachments.md)

## Why a local event stream

A Goal is durable session state that other local extensions may want to react to
— a status widget, a notification bridge, an audit timeline. The one thing such
a consumer must not do is poll pi-goal's internals or trust optimistic UI state:
the only moment worth reacting to is the moment a transition is **committed**.
pi-goal therefore publishes one event per meaningful durable transition on Pi's
shared extension event bus, the same public surface every extension shares:

```ts
export default function myExtension(pi: ExtensionAPI): void {
	pi.events.on("pi-goal:updated", (event) => {
		// event.kind, event.goal.id, event.goal.status, ...
	});
}
```

No registration, handshake, or ordering promise beyond the bus itself is
required: pi-goal emits whether or not anyone listens, and a listener that
arrives late simply misses earlier events (the durable `goal-state` entries on
the session branch remain the authoritative history).

## The payload

One JSON object per event, versioned as a whole:

| Field | Meaning |
| --- | --- |
| `version` | `1`. Bumps only if the payload shape itself changes. |
| `kind` | The transition kind (table below). |
| `goal.id` | The committed Goal identity the transition belongs to. |
| `goal.revision` | The revision this transition committed. A clear keeps the cleared Goal's last revision. |
| `goal.status` | The Lifecycle status as committed. A clear reports the status the Goal had when cleared. |
| `goal.objective` | Metadata only: `{ length, origin }`. The verbatim objective stays in the durable snapshot and the delimited data block; the event is machine-consumed by any loaded extension, which makes it the same surface as a log line. The Goal **title** is not carried at all (no field, no text): it follows the Objective's privacy boundary, so even a title-only edit sends only an in-place edit transition. |
| `goal.tokenBudget` | The cumulative token ceiling, or `null` when unbounded. |
| `goal.attachments` | The immutable attachment manifest's metadata — one `{ hash, mediaType, bytes, label }` entry per attachment, in manifest order, `[]` for a Goal without attachments. Never contents, local source paths, or remote source URLs: attachment text and image bytes stay in the artifact store and the delimited data blocks, for the same privacy reason `goal.objective` is metadata only. |
| `goal.usage` | The committed usage summary — the same projection `get_goal` reports: `totalTokens` (input + output + cache writes), the components, cached reads excluded as reuse, nested work counted once, and `activeSeconds`. |
| `timestamp` | ISO timestamp of the committed transition — the snapshot's own `updatedAt` (the clear time for a tombstone, which carries no record). |

Every field describes the *committed* record, so an event and the durable
snapshot it follows can never disagree.

## Transition kinds

| Kind | Produced by |
| --- | --- |
| `created` | `/goal <objective>` or an authorized `create_goal` committing a Goal into a free slot. |
| `replaced` | `/goal <objective>` taking the session's Goal slot from an existing **complete** Goal — the only Goal a creation may supersede; an unfinished one refuses the creation before any dialog or clarification. The event names the **replacement** identity; the replaced identity keeps its own durable superseded record and is never re-announced. |
| `objective-edited` | `/goal:edit` committing an in-place Goal edit for the same identity: a new objective, a new title, or both. The payload carries neither text; a title-only edit is this kind because it is still an in-place content edit of the same Goal. |
| `paused` | `/goal:pause`, or `update_goal action:"pause"` after pause corroboration. |
| `resumed` | `/goal:resume` restarting a paused, blocked, or usage-limited Goal. |
| `budget-recovered` | `/goal:resume --budget <new-total>` — the one resume that changes the cumulative ceiling. |
| `cleared` | `/goal:clear` committing the tombstone. Identifies the cleared Goal (identity, last revision, the status it had, and the usage it had at the clear); no new current Goal is invented. |
| `blocked` | The blocked audit reaching its threshold, or an extension-enforced conservative stop (activity-free / execution-unavailable bounds). |
| `usage-limited` | A terminal provider failure classified as a usage limit. |
| `budget-limited` | Accounted usage reaching the token budget — announced at the boundary that makes the stop durable (see below). |
| `completed` | `update_goal action:"complete"` after the completion audit. |

## Ordering and durability

Emission is durable-before-announced, like every observer surface in pi-goal:

- an event is emitted only **after** the corresponding `goal-state` snapshot or
  tombstone append succeeded (Pi's `appendEntry` writes through synchronously
  and throws on failure);
- a transition that is refused, fails its write, or is retracted emits nothing;
- within one Pi process the bus delivers in commit order, and each event reports
  the record exactly as committed.

Creation and replacement are announced by the commit itself rather than by the
`/goal` command's separate on-disk durability poll. That poll exists for the
*user-facing* announcement, because a fresh session's file is only created when
the kickoff message flushes — but the kickoff run can complete or stop the Goal
before the file appears, so waiting for the poll would announce a creation
*after* the transitions of the run it started, inverting the stream's order. The
commit's append is the durable bar every other transition already uses. The
corollary is an accepted corner: a creation whose durability poll later fails is
retracted with a tombstone, and the retraction itself announces nothing — it is
not a lifecycle decision — so the next committed transition of the session's
Goal slot is the next thing a listener hears.

Two budget specifics follow from where the store commits:

- `budget-limited` is decided in memory the instant accounted usage crosses the
  ceiling (enforcement must be immediate), but the snapshot is written at the
  next post-persistence boundary (`turn_end`, settlement, or shutdown), and the
  event fires **there**, exactly once, with the totals re-read at the flush.
- `budget-recovered` is the budget-raising resume; an ordinary `resumed` event
  never reports a changed ceiling.

## What deliberately stays off the stream

The stream describes lifecycle state, not accounting churn:

- token deltas, `goal-usage` checkpoints, and active-time ticks never emit —
  only the durable budget **exhaustion** does;
- below-threshold blocker reports are durable audit steps (the Goal keeps
  working, its status does not change), so they emit nothing; only the threshold
  transition is a `blocked` event;
- blocked-audit resets, the wrap-up's delivery and its disarming, superseded
  freezes of a replaced identity's tail, the one-time legacy cutover, and the
  creation/replacement retractions (`rollback`/`restore`) are bookkeeping or
  history, not lifecycle transitions;
- attachment text and image bytes never emit. `goal.attachments` is the
  immutable metadata manifest only; contents stay in the artifact store and the
  untrusted Goal work messages (see [attachments](attachments.md));
- the opt-in session name (`goal.sessionNameFromObjective`) never emits. It is
  Pi's own session metadata rather than Goal state — see
  [lifecycle](lifecycle.md#naming-the-session-from-the-goal-title-or-objective) — so a listener
  that wants to react to a name reads it from Pi, not from a Goal event.

## The durable history beside the stream

The same committed transitions are also appended to the session branch as
`goal-history` entries and rendered by the read-only `/goal:history` command (see
[history](history.md)). That timeline is *derived from this payload* — each record
is projected from the event of its own transition — so a consumer of the stream and
a reader of the timeline can never be told two different stories about one
transition. The history adds the previous Lifecycle status, which the event does
not carry, and it stays as non-authoritative as the stream is: nothing
reconstructs from it, and no command mutates from it.

## Listener failures

The event surface can never damage the transition underneath. pi-goal emits
after the durable write, and the extension bus isolates every handler: a
listener that throws is caught by the bus/runtime and surfaces as the host's own
diagnostic for the events seam (an `extension_error` record in RPC mode), never
as a pi-goal durability failure — the committed transition and its success
report stand. pi-goal's own emit path is best effort for the same reason: a
failing emit call is swallowed rather than misreported as a failed write.

## Compatibility

The payload is versioned as a whole (`version: 1`). Consumers should ignore
unknown kinds and unknown fields rather than rejecting the event, so later
pi-goal releases can add transitions or fields without breaking listeners.
