# Subagent usage reporting

A plugin-neutral contract for attributing subagent model usage to a parent Pi
session and, when applicable, to its active Goal.

**Status: proposed.** The only currently implemented path is Pi's native
`toolResult.usage`. The provider registry and external-usage session entries below
are design work, not current pi-goal behavior.

[← Documentation index](README.md) · See also [Codex migration](codex-migration.md) ·
[Goal accounting](behavior/accounting.md)

## The abstraction boundary

pi-goal should not know about Rex, tmux, process titles, run directories, or any
other implementation detail of a subagent package. It should consume one contract:

```ts
import type { Usage } from "@earendil-works/pi-ai";

interface SubagentUsageSnapshot {
  schemaVersion: 1;
  /** Stable namespace of the subagent implementation, not the model provider. */
  source: string;
  /** Stable identity of one delegated run within that source. */
  runId: string;
  /** Pi session that admitted the delegation. */
  parentSessionId: string;
  /** Identity of the child-session generation backing this run. */
  childSessionKey: string;
  /** Monotonically increasing within (source, runId, childSessionKey). */
  sequence: number;
  /** Used to distinguish a new delegation from adoption of existing work. */
  startedAt: string;
  /** Cumulative child usage, never a delta. */
  usage: Usage;
}

interface SubagentUsageProvider {
  readonly source: string;
  /** Current cumulative snapshots for direct children of one Pi session. */
  snapshots(parentSessionId: string): Promise<readonly SubagentUsageSnapshot[]>;
}
```

The provider reports **cumulative snapshots**. The consumer owns baselines,
deltas, deduplication, Goal ownership, and persistence. This keeps accounting
policy out of every subagent plugin.

A plugin must not supply `goalId`: Goal admission and replacement are pi-goal's
domain. The parent session identity and run start/adoption evidence are the
provider's responsibility; mapping that work to a Goal is the consumer's.

## What Pi already standardizes

For a subagent invoked by a Pi custom tool, no new reporting interface is needed
at the accounting boundary. Pi's public `Usage` and `ToolResultMessage.usage` are
already the common representation:

```ts
return {
  content: [{ type: "text", text: "Subagent finished" }],
  details: { runId, snapshot },
  usage: newlyObservedDelta,
};
```

Pi persists that usage on the parent tool result. pi-goal already charges it once,
applies budget enforcement, and replays it after restart or tree navigation. A
subagent package that returns usage this way needs no pi-goal-specific adapter.

Two integration shapes are therefore valid:

| Shape | Where the common contract is converted | pi-goal change |
| --- | --- | --- |
| Synchronous spawn/wait/observe custom tool | The subagent package returns the new delta as `toolResult.usage`; the cumulative snapshot is retained in `details` | None |
| Asynchronous external process | A generic provider collector converts snapshots into durable external-usage records | One generic collector; no provider-specific branch |

If zero pi-goal changes are a hard requirement, the provider's final output must
use `ToolResultMessage.usage`. Pi's in-process `pi.events` bus alone does not make
a separate child process visible, and a custom event is not automatically included
in Pi session statistics.

## Neutral provider registry

For plugins that cannot return a tool result, define the provider contract in a
small neutral package rather than importing pi-rex-subagent into pi-goal. The
package can use `pi.events` for in-process registration and lazy discovery while
exposing typed registration/collection helpers to both sides.

The registry must handle extension load order: a consumer loaded before a provider
must discover it later, and a provider loaded first must not lose its registration.
Registration payloads should carry a schema version. Unknown versions fail closed.

For an external child, the provider implementation runs on the **parent side** and
obtains the child's cumulative usage through that plugin's ordinary transport:
a file, an RPC response, or a child-process supervisor. `pi.events` does not cross
the process boundary.

## Generic consumer behavior

Whether the delta arrives on a tool result or through the async collector, the
rules are the same.

### Deltas and cursors

1. Key cursors by `(source, runId, childSessionKey)`.
2. Establish a baseline explicitly when a run is first bound. A run created inside
   the current admission segment starts at zero; a pre-existing run adopted later
   starts at its current snapshot. Never retroactively charge pre-adoption work.
3. Serialize observation per run so concurrent readers cannot charge the same
   snapshot twice.
4. Subtract the previous cumulative `Usage` component by component. Reject a
   regressed sequence, negative delta, malformed number, or unexpected session
   generation; do not hide a reset by clamping it to zero.
5. Preserve the full Pi `Usage` delta, including cached reads and cost. pi-goal's
   existing formula then excludes cached reads and avoids adding reasoning twice.
6. A zero-delta observation may advance the cursor but adds no usage.

Only tokens are aggregated. Child active time must not be added to the parent's
active time, because parallel children would multiply elapsed wall-clock time.

### Goal ownership

- Bind a run to the Goal identity whose admission segment admitted it. Replacement
  does not transfer that binding to the new identity.
- Observations during an ordinary user prompt are not Goal work. A pre-existing
  run first used by a later Goal needs an explicit adoption baseline.
- For strict lifecycle accounting, synchronize known runs before pause, complete,
  clear/replacement, and before admitting resumed work. A simpler observation-time
  V1 may attribute previously unobserved stopped-time work to the next observing
  segment, but must document that approximation.
- Nested delegation is reported through the immediate child's aggregate. The root
  must not also observe a grandchild directly, or the same model work is charged
  twice.

### Durability and branches

For the custom-tool shape, the parent tool result is the authoritative accounting
record. Its `details` must retain the cumulative cursor so a future observation
can reconstruct its baseline from the selected parent branch.

For the async-provider shape, pi-goal needs one generic durable entry type, for
example `goal-subagent-usage`:

```ts
interface SubagentUsageRecord {
  version: 1;
  /** Assigned by pi-goal at admission/collection, never supplied by a provider. */
  goalId: string;
  source: string;
  runId: string;
  childSessionKey: string;
  sequence: number;
  cumulative: Usage;
  delta: Usage;
}
```

The generic collector writes these entries in branch order and extends branch
replay to charge each once. `goalId` preserves the binding when a late observation
belongs to a superseded identity rather than the currently active Goal. Final
collection happens **before** a terminal Goal snapshot, so completion cannot
strand the last child delta behind the completion boundary. Checkpoints remain
after the entries they cover.

On session start and tree navigation, cursors are rebuilt from the selected branch
alone. The replay charges persisted deltas; cursor reconstruction itself charges
nothing. An abandoned branch therefore cannot suppress a charge on another branch,
while returning to the original branch cannot charge its records again.

## Applying the contract without coupling to Rex

There are three deployment choices:

| Choice | Rex-specific knowledge lives in | Trade-off |
| --- | --- | --- |
| pi-rex-subagent implements the neutral provider contract | pi-rex-subagent, with no pi-goal import or Goal logic | Cleanest long-term plugin behavior |
| A separate `pi-subagent-usage-rex` adapter implements the contract | The separate adapter only; pi-goal and the Rex core remain neutral | Existing Rex releases can be supported without changing that repository |
| Pi exposes a native child-session/usage registry | Pi core | Best ecosystem endpoint, but requires a Pi feature that does not currently exist |

An external Rex adapter can derive cumulative usage from the existing run records
and child Pi session JSONL files, including assistant, tool-result, compaction, and
branch-summary usage. That is one interchangeable provider, not a special case in
pi-goal.

Zero modifications everywhere is not reliable: without a provider or native Pi
registry, pi-goal has no portable way to discover which external sessions belong
to the current parent or when their usage changed. There are also operations an
outside observer cannot make transactional—for example, a CLI `stop --remove` can
delete an uncollected child session before the adapter reads it. Strict final
collection requires either a provider finalization hook or an adapter-owned stop
operation.

## Reusable conformance suite

The neutral package should ship provider-independent tests that every adapter runs
against its own transport:

1. First observation, repeated observation, and zero-delta observation.
2. Parallel runs and repeated run IDs in one collection.
3. Concurrent observations of one run.
4. Restart and selected-branch reconstruction without loss or double charging.
5. Nested tool and compaction usage, cached reads, and excluded cache warming.
6. Malformed, regressed, and changed-generation snapshots.
7. Adoption of pre-existing work without retroactive charges.
8. Goal replacement without ownership transfer.
9. Final collection before child-record deletion.
10. Nested delegation counted only through the immediate child.

## Recommended direction

Standardize the snapshot contract in a neutral package and use
`ToolResultMessage.usage` wherever a custom tool is available. Add one generic
async collector to pi-goal only for providers that genuinely need asynchronous
reporting. Keep Rex support behind that contract—either as a provider in the Rex
package or as a separate adapter—and keep all provider-specific code out of the
Goal ledger.
