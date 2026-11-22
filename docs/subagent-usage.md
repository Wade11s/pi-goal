# Subagent usage reporting

The provider-neutral V1 contract for attributing model usage from a delegated Pi
child to its parent session and, when the parent observation is Goal-owned, to
the existing Goal ledger.

**Status: accepted and implemented through Pi `toolResult.usage`.** There is no
asynchronous provider registry and no durable external-usage ledger.

[← Documentation index](README.md) · See also [Goal accounting](behavior/accounting.md) ·
[Testing](testing.md) · [Codex migration](codex-migration.md)

## Boundary

A subagent provider owns child execution, snapshots, observation, adoption,
concurrency, and final collection. pi-goal owns only its existing admission,
Goal identity, token formula, budget enforcement, and selected-branch replay.
Neither side supplies or consumes a provider-owned `goalId`.

The implemented path is a parent custom tool result:

```ts
return {
  content: [{ type: "text", text: "Observed direct children" }],
  details: {
    version: 1,
    kind: "observation",
    parentSessionId,
    runs: [{ runId, childSessionId, generation, sequence, cumulative, final }],
  },
  usage: newlyObservedDelta, // omitted when every component is zero
};
```

`usage` is standard complete Pi `Usage`, not a provider-specific subset. Pi
persists it on the parent tool result. pi-goal charges that entry once inside
the observing admission segment; no provider adapter or second Goal charge is
needed. `details` retains the cumulative cursor used by the provider's next
observation. Cursor field names may reflect provider vocabulary (Rex uses
`handle` for `runId` and `generation` for the child-session generation), but
their meaning is fixed by this contract.

## Version 1 cumulative snapshot

A provider publishes one cumulative snapshot per direct-child run:

```ts
interface SubagentUsageSnapshotV1 {
  version: 1;
  /** Stable subagent implementation namespace, not the model provider. */
  source: string;
  /** Stable delegated-run identity within source. */
  runId: string;
  /** Owning parent Pi session, or null before an unowned run is adopted. */
  parentSessionId: string | null;
  childSessionId: string;
  /** Opaque durable session generation; not a PID or extension-instance count. */
  childSessionGeneration: string;
  /** Integer >= 1, monotonically increasing within this run and generation. */
  sequence: number;
  /** Complete cumulative Pi Usage for the child's selected branch. */
  usage: Usage;
  /** Clean final publication marker. */
  final: boolean;
  /** Diagnostic only; never used for deltas or staleness. */
  updatedAt: string;
}
```

Complete `Usage` includes input, output, cached reads, cache writes,
`totalTokens`, every cost component and its provenance, plus optional
`cacheWrite1h` and reasoning when present. The cumulative aggregate includes
assistant messages, nested tool-result usage, compaction, and branch summaries.
Standalone usage entries such as cache warming are excluded. Cached reads stay
visible, and reasoning stays inside output; pi-goal's existing
`input + output + cacheWrite` formula makes the final accounting decision.

Only usage crosses the seam. Child Active elapsed time, wall-clock duration, and
process lifetime are not snapshot or tool-result accounting fields and are never
added to parent Active elapsed time.

## Observation and cursor rules

1. **Explicit baseline.** A newly spawned direct child records sequence zero,
   neutral zero Usage, no child generation, and `final: false`. Its first and all
   later observations charge work from that zero baseline, even if the first
   observation happens after several turns. Unknown history is never defaulted
   to zero.
2. **Component-wise delta.** Subtract the previous cumulative value from the
   current one for every numeric Usage and cost component. Preserve optional
   components and cost provenance. pi-goal, not the provider, excludes cached
   reads and avoids counting reasoning twice.
3. **Per-run serialization.** Serialize snapshot-to-delta observation for each
   run. Deduplicate repeated handles in one call. Overlapping calls cannot charge
   the same snapshot twice. A multi-run result contains one cursor per requested
   run and one combined delta.
4. **Repeated and zero-delta observations.** Rereading an identical sequence and
   payload is idempotent. A newer sequence with unchanged Usage is also valid.
   Both retain/advance the durable cursor but omit `toolResult.usage` when the
   combined numeric delta is zero.
5. **Fail closed.** Reject malformed or non-finite numbers, negative components,
   a lower sequence, a changed payload at the same sequence, changed child
   session or generation, negative delta, vanished optional component, invalid
   cost-provenance transition, wrong run or parent identity, and changes after a
   final snapshot. Do not clamp, reset, skip, or convert corruption into a zero
   baseline. A failed call emits no Usage and commits none of its cursors, so a
   later valid observation can collect the exact outstanding delta.
6. **Selected-branch reconstruction.** On parent restart and tree navigation,
   fold only successful accounting tool results on the selected parent branch,
   in branch order. Ignore failed results, abandoned alternatives, and payloads
   owned by another parent. Malformed cursor payloads remain unusable rather
   than falling back to an older cursor that could double-charge. Reconstruction
   itself emits no tool result, Usage, or Goal charge.
7. **Final collection.** Stop/finalize the child, collect its last durable
   snapshot, and only then remove run records. A clean final cursor has
   `final: true`. If a provider supports terminal-but-unconfirmed or
   missing-snapshot recovery, it must preserve that diagnostic and report only
   recoverable observed Usage; zero is not a claim that no work occurred.

Sequence gaps are valid because Usage is cumulative. Timestamps and arrival
order are not accounting cursors.

## Ownership

- **Adoption.** Adopting an existing run records its current valid snapshot as a
  free baseline. Pre-adoption work is excluded; only later deltas are returned.
  Re-adoption on a branch that already has a baseline is rejected. A run has at
  most one parent accounting owner in V1, and unrelated-parent observations fail.
- **Replacement Goal.** A provider does not transfer or rebind runs. The parent
  tool result is charged under pi-goal's existing admission rules, so historical
  and late observations already admitted for a superseded Goal stay with that
  identity. A Replacement Goal starts with zero Goal-owned usage.
- **Nested delegation.** Usage crosses one process boundary at a time. The root
  observes only its immediate child, whose aggregate already includes the
  grandchild's tool-result usage. The root must not observe or adopt that
  grandchild independently.
- **Ordinary prompts.** An observation outside a Goal admission segment remains
  Pi session usage but is not Goal-owned work.

## Observation-time V1

The persisted parent tool result is the accounting record, and the observing
admission segment owns its delta. Work performed while a Goal was paused but
first observed after resume can therefore belong to the resumed segment. This
is deterministic and replay-safe, but not invoice-exact lifecycle attribution.
Strict reconciliation at every pause, resume, completion, clear, or replacement
boundary is outside V1.

A child crash can leave work that reached neither its Pi session nor a durable
snapshot. That work is unrecoverable; providers must not invent a charge.
pi-goal's completion report retains the existing accounting-approximation
notice.

## Conformance

`test/helpers/subagent-usage-conformance.mjs` runs the same six public-seam cases
against a provider adapter:

1. spawn baseline, first/repeated/zero-delta observations, and complete Usage;
2. parallel runs, repeated handles, and overlapping observations;
3. malformed, regressed, negative-delta, changed-generation, unrelated-parent,
   and same-sequence-conflict rejection followed by exact recovery;
4. adoption baseline and post-adoption delta;
5. restart and selected-branch reconstruction with no reconstruction charge;
6. final collection before removal.

`test/goal45-subagent-usage-conformance.test.mjs` executes all six against the
deterministic fake provider and released Rex v0.2.0. The fake is file-backed for
fixture administration, but every behavior under test is returned by its real
Pi custom tools. Rex uses the isolated released-provider environment from
`test/helpers/rex-acceptance.mjs`; neither provider is imported by `src/`.

The released-provider acceptance in #43/#44 additionally covers Goal accounting
and budgets, ordinary-prompt exclusion, observation-time ownership, Replacement
Goal ownership, real nested delegation, and clean/unconfirmed/missing final
recovery. The vendored provider's own suite covers aggregation of assistant,
nested tool, compaction, branch-summary, cached-read/write, reasoning, and
cache-warming entries. No production accounting change was needed.

## When an asynchronous collector would be justified

Do not add a registry or external-usage ledger speculatively. Reconsider only
when a real provider cannot deliver observations through a parent custom tool
result and demonstrates that durable usage is otherwise lost or duplicated.
That provider must supply concrete lifecycle and recovery requirements, not
merely a preference for push delivery.

Any future collector must remain generic and branch-local, preserve explicit
run/Goal ownership, use this same snapshot and conformance contract, reconstruct
without charging, and avoid changing the existing tool-result path. Its durable
records would need a separate migration and durability design; they are not part
of V1.
