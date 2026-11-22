# Operational metrics and the exporter seam

Privacy-safe operational metrics projected from committed Goal transitions, the
local consumer seam that publishes them, and the rules an explicitly installed
hosted companion exporter must follow. pi-goal core performs no network
telemetry.

[← README](../README.md) · See also [events](events.md) ·
[accounting](accounting.md) · [budgets](budgets.md)

## Why metrics are derived, not gathered

Counting, dashboards, and hosted export all want the same small handful of
numbers: how many transitions of each kind happened, which Lifecycle statuses
were reached, what the work cost, how long it ran, and whether a budget was in
play. None of that requires the Objective, the Blocker text, or anything else the
user wrote.

So metrics are a **projection**, not a collector. `toGoalMetrics(event)` is a
pure function from one committed `pi-goal:updated` event to one
`GoalMetrics` record (`src/metrics.ts`). Consequences:

- a metric exists only for a transition that committed — a refused, failed, or
  retracted transition emits no event, therefore produces no metric;
  `test/goal55-metrics-store.test.mjs` drives genuine refusals (ineligible,
  stale) through the store and asserts the stream stays empty;
- a metric can never disagree with the durable snapshot it describes, because
  both come from the same committed record;
- metrics are never read from live store state, never polled, and never
  reconstructed from Goal internals, so a metric cannot describe optimistic UI
  state;
- the accounting churn the event stream already excludes — token deltas,
  active-time ticks, below-threshold audit steps — is absent from metrics for
  the same reason.

## The projection

One record per committed transition:

| Field | Meaning |
| --- | --- |
| `version` | `1`. Bumps only if the metric shape itself changes. |
| `extensionVersion` | The pi-goal release that produced the record (`src/version.ts`, pinned to `package.json` by test). |
| `kind` | The committed transition kind — the same vocabulary as [events](events.md#transition-kinds). |
| `status` | The Lifecycle status as committed. A clear reports the status the cleared Goal had. |
| `totalTokens` | Accounted Goal tokens: non-cached input + output + cache writes. |
| `activeSeconds` | Whole seconds the Goal was active in a live session at this commit. |
| `budget.state` | `unbounded`, `within-budget`, or `exhausted`. |
| `budget.limitTokens` | The cumulative Token ceiling, or `null` when unbounded. |
| `budget.remainingTokens` | Tokens of headroom, or `null` when unbounded; `0` once exhausted. |
| `timestamp` | ISO timestamp of the committed transition. |

Budget state is derived from the committed event — the event carries the
Token budget and the accounted total — so a metric reports the state at the
moment of the commit rather than a live value that may have moved since. An
overshoot is `exhausted` with zero remaining, never a negative remainder.

`activeSeconds` comes from the same committed usage summary `get_goal` reports;
it excludes paused time and process downtime, exactly like the Goal's Active
elapsed time.

## What is never projected

The projection is an explicit **allowlist**, not a redaction pass over a copy of
the event: every field is read by name and rebuilt into a fresh object. A future
event field — however sensitive — is invisible to metrics until someone
deliberately adds it to `src/metrics.ts` *and* updates the pinned key set in
`test/goal55-metrics-store.test.mjs`, which makes the privacy review part of the
gate rather than a convention.

Deliberately absent from the default metric:

- the Objective's text — and also its length and origin, which stay on the local
  event because an operational record does not need them;
- Blocker descriptions;
- attachment contents and manifest (display labels, hashes, media types);
- source file names, source paths, and source URLs;
- raw session identifiers, and also the Goal identity and revision, because a
  per-Goal correlation key is an identifier a hosted backend does not need for
  aggregate operational metrics;
- raw user prompts, model output, and tool arguments.

A consumer that wants any of that is not consuming metrics: it should subscribe
to the broader local [`pi-goal:updated`](events.md) stream and take on the trust
and privacy responsibility for what it then does.

## The local consumer seam

pi-goal publishes each projection on Pi's shared extension event bus, on its own
channel:

```ts
export default function myMetricsConsumer(pi: ExtensionAPI): void {
	pi.events.on("pi-goal:metrics", (metric) => {
		// metric.kind, metric.status, metric.totalTokens, metric.budget, ...
	});
}
```

This is the seam a local logger, an aggregate counter, or an explicitly
installed companion exporter consumes. It carries only the pre-redacted metric,
so a consumer is not handed the broader event payload in the first place.

The guarantee is the same one the event stream makes, with one addition:

- **order and durability**: a metric is published after the durable write it
  describes, in commit order, and only for committed transitions;
- **optional**: pi-goal publishes whether or not anyone listens; no listener,
  handshake, or registration is required, and late consumers simply miss earlier
  metrics (the durable `goal-state` entries remain the authoritative history);
- **best effort**: in core the sink is a local `pi.events.emit`, with no queue,
  retry, spool, or acknowledgement. Delivery can be missed when no consumer is
  loaded or the process exits; consumers that need completeness persist locally
  and treat gaps as possible;
- **synchronous, so keep it cheap**: the projection and the sink call run on the
  transition's own committed path. A consumer that does slow work inline (a
  network request, a large file write) delays the pi-goal call that emitted it;
  a hosted companion should enqueue locally and return, so its export latency is
  its own and never pi-goal's;
- **failure-isolated**: a consumer that throws, or whose returned promise
  rejects, cannot roll back the committed transition, cannot stop later metrics,
  and is never reported as a pi-goal durability failure. The rejection is
  handled at the publisher, so it cannot even surface as an unhandled rejection.
  The failure appears only as the host's own diagnostic for the metrics channel.

The publisher (`createGoalMetricsPublisher`) deliberately returns nothing on
`publish`: there is no success flag a caller could mistake for — or turn into —
a durability result.

## No network by default

pi-goal core has no telemetry client:

- the default metrics sink is the local extension bus; there is no HTTP, socket,
  DNS, or other transport in the projection or the wiring;
- `package.json` declares no runtime `dependencies` and no optional
  dependencies — a hosted exporter is not installed with pi-goal;
- no pi-goal setting accepts an endpoint, token, or "analytics" switch, so core
  cannot be configured into sending anything.

The deterministic suite proves this rather than asserting it: the unit tests
stub the global `fetch` and publish a hundred projections without a single call,
scan the projection and wiring for network transports, and pin the package's
dependency-free shape; the real-Pi test wraps the host's `fetch`, runs a full
creation → completion → clear scenario, and asserts zero attempts both at every
metric emission and at the end of the process
(`test/goal55-metrics-store.test.mjs`, `test/goal55-metrics.test.mjs`).

## The on-demand hosted companion

A real exporter belongs in a **separately installed companion package**, never
in pi-goal core and never as a mandatory runtime dependency of it. The companion
subscribes to `pi-goal:metrics` and owns every policy that makes export
acceptable:

- **Consent.** Installation alone must not export. The companion must require an
  explicit, separate enablement (its own setting or explicit command), state the
  destination and what is sent, and stay off until the user turns it on. A
  pi-goal setting must never silently enable a companion's network path.
- **Redaction.** The companion receives only the allowlisted metric above; it
  must not re-identify it by adding the Goal identity, session identifier, host
  name, user identity, workspace path, or correlation metadata pi-goal
  deliberately omitted. If it enriches a record, that enrichment is its own
  documented policy and privacy surface, not pi-goal's.
- **Retry.** The companion owns its queue, batching, backoff, and dead-letter
  behavior, and must document its delivery guarantee honestly. Core gives it
  best-effort local delivery only; the companion cannot claim completeness it
  did not persist and verify itself, and a failed export must never be
  back-pressured into pi-goal's lifecycle path.
- **Credential ownership.** The companion reads its credential from its own
  configuration (its own config file, environment variable, or OS keychain) and
  never from pi-goal. pi-goal has no field for a hosted credential and never
  writes one to a snapshot, a session entry, an event, a metric, or a log line.
  Credential rotation, storage, and revocation are the companion's
  responsibility, documented by the companion.

The companion's own delivery contract — where the data goes, under whose
account, its retention, and its retry/failure semantics — is documented with the
companion. pi-goal documents only the seam and the privacy floor the seam
guarantees.

A companion that needs Codex-shaped Goal get/set/clear RPC methods is a
different, equally optional companion: it maps those operations onto pi-goal's
existing public command semantics (preserving replacement confirmation, Goal
creation authority, and durable-before-announced behavior) and is not part of
core either.

## Failure isolation, restated

Every observer surface in pi-goal is downstream of the durable write. Metrics
follow the same rule as [events](events.md#listener-failures): the transition is
already committed when the metric is projected, so a consumer or exporter
failure has nothing to roll back. It cannot produce a false durability result
because the emit path is best effort and the publisher reports no outcome —
a failed export is the companion's diagnostic, never a pi-goal state change.

## Compatibility

The metric is versioned as a whole (`version: 1`). Consumers should ignore
unknown kinds and unknown fields rather than rejecting a record, so later
pi-goal releases can add transitions or fields without breaking them. A consumer
that cannot tolerate a new field should pin the pi-goal release it was tested
against instead of validating a closed schema in production.
