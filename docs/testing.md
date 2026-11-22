# Testing and verification

The automated gate, the rules that keep the RPC suite from passing for the wrong
reason, and the manual real-Pi smoke procedure.

[← README](../README.md) · Manual procedure: [smoke-test.md](smoke-test.md)

## How the tests stay honest

A scripted-provider step that runs out throws, and that failure would also stop
an active Goal — so a test that settles on a missing step proves the error path,
not the Goal lifecycle. Three rules keep the suite from passing for the wrong
reason:

- every script is sized through the last natural post-tool turn, and every test
  ends with `assertCleanRun()` (or `assertOnlyFailures()` when a failure is the
  subject), which fails on any assistant outcome that is `error` or `aborted`;
- every anti-loop test asserts the number of provider responses it asked for
  (`assertStepsConsumed`) together with the exact continuation and run counts, so
  a stop is proved to be the Goal lifecycle and not an exhausted script. Two tests
  deliberately let the script run out, because a terminal provider error is what
  settles a session whose Goal is still active; both assert that exact failure;
- the test-only boundary peer bounds its own continuation requests, so a
  composition test is bounded by the fixture rather than by a provider error.

This is verified, not assumed: instrumenting the scripted provider to log every
missing step and running the whole suite reports **zero** missing steps, so no
test settles on a provider error.

## Development

```sh
npm install        # development dependencies (TypeScript, Node types, Pi packages for typecheck)
npm run typecheck  # tsc --noEmit
npm test           # real-Pi RPC tests (requires `pi` 1.5.1+ on PATH)
```

The automated tests spawn a real `pi --mode rpc` subprocess per test with
temporary working, session, and agent directories (`PI_CODING_AGENT_DIR` /
`--session-dir`; the temp directories are removed when each test finishes), a
scripted test model provider (`test/extensions/scripted-provider.ts`, driven by
`PI_GOAL_TEST_SCRIPT`, including hanging and delayed responses for
interrupted-run and queueing tests), an optional second extension
(`test/extensions/boundary-peer.ts`) for boundary-composition tests, and no
network or model credentials. The provider declares text and image input; when
`PI_GOAL_TEST_CAPTURE_DIR` is set it also captures each request's complete model
message list, allowing tests to assert the actual text/image content arrays the
provider received rather than only durable session entries. Tests assert public
behavior end to end: RPC events, extension notifications, tool results, model
context, persisted session entries, artifact files, and survival across hard
kills and restarts. Set `PI_BINARY` to run against a specific Pi binary; a
missing binary fails fast instead of hanging.

Accounting rules that are impractical to cover exhaustively through the RPC seam
(the token formula, deduplication, the active-time boundaries, budget validation)
are unit-tested directly in `test/accounting.test.mjs` against the accounting
module with an injected clock, including the cumulative budget-raise validation.
The durability boundaries — snapshot aliasing, replay baselines, terminal-status
replay, tombstones — are unit-tested in `test/store.test.mjs` against a fake Pi
API that reproduces Pi's object-retention semantics, which is the only way to
exercise the same-process reconstruction ordering an RPC test cannot reach. The
budget-recovery durability and injected-fault seams are unit-tested in
`test/goal10-budget-recovery-store.test.mjs`. The Blocker-identity lifecycle, the
reset combinatorics, an injected persistence failure, and the legacy open-audit
handoff against the immutable 0.1.0 fixtures are unit-tested in
`test/goal11-blocker-identity-store.test.mjs`. The RPC tests cover everything
observable, including real nested usage (`test/extensions/nested-usage.ts`), real
budget exhaustion with an attempted tool call during the wrap-up, cumulative
budget-raising recovery and per-episode wrap-ups
(`test/goal10-budget-recovery.test.mjs`), the whole Blocker-identity contract
through real Pi turns (`test/goal11-blocker-identity.test.mjs`), and recovery
after both a graceful and an unclean restart.

A blocked-audit chain is scripted through `test/helpers/blocked-audit.mjs`: the
scripted provider re-reads its script on every request and a `waitForFile` step
holds its response until the test releases it, so the identity the extension
issues can be read out of a structured tool result and passed back by the later
turns — exactly what a real model does after calling `get_goal`, and race-free
because no request after the gate is made until the gate file exists.

The Goal-updated event stream (issue #48) is tested through
`test/extensions/events-peer.ts`: a second extension subscribes to the public
`pi-goal:updated` channel on Pi's shared extension event bus and records every
event it receives as a durable `goal-events-log` session entry, so
`test/goal48-events.test.mjs` can assert payload, ordering against the
interleaved `goal-state` entries, transition coverage, refusal/rollback silence,
and listener-failure isolation from the session file and the RPC record stream
alone. The narrow injected-fault seams — a failing append at the durable commit,
the in-memory budget stop versus its durable flush, audit bookkeeping — are
unit-tested in `test/goal48-events-store.test.mjs` against a fake Pi API.

Operational metrics (issue #55) are tested at both seams. The pure projection,
its pinned key set, the budget arithmetic (unbounded, within, exact exhaustion,
overshoot), the allowlist treatment of hostile extra event fields, the
publisher's sync-throw and rejected-promise isolation, and the default no-network
shape (a stubbed `fetch`, a scan of the projection and wiring, and the
package's dependency-free manifest) are unit-tested in
`test/goal55-metrics-store.test.mjs`. The end-to-end seam is
`test/extensions/metrics-peer.ts`: a second extension subscribes to the public
`pi-goal:metrics` channel, records each projection as a `goal-metrics-log`
entry paired with the process's fetch-attempt count, and can arm an injected
consumer failure. `test/goal55-metrics.test.mjs` then proves that metrics mirror
the committed `goal-state` snapshots, that no Objective, identity, path, or URL
reaches them, that a throwing consumer cannot roll back a transition or turn
its failure into a pi-goal durability problem, and that a full
creation → completion → clear scenario makes zero fetch attempts. No hosted
credential, host, or network service is involved.

Objective attachments (issue #49) are covered by
`test/goal49-attachments.test.mjs` through real Pi RPC sessions. Local fixtures
exercise encoded hostile text and real PNG/JPEG/GIF/WebP image blocks in the
provider's captured model context, stable hashes across Continuations, restart
and clone reconstruction, Objective-edit retention, Replacement Goal isolation,
clear/replacement artifact retention, validation and snapshot rollback,
disabled admission before materialization, missing/corrupt restore suppression,
and metadata-only Goal-updated events. Remote URLs are refused without network
access; SVG and unknown types are rejected. The suite inspects the durable
manifest and the sibling `pi-goal-store` directly, and every admitted run is
sized and deliberately settled or aborted.

`test/goal49-attachments-store.test.mjs` pins the cheaper fault matrix: magic
byte sniffing, strict UTF-8, the 8-attachment / 1 MiB-text / 10 MiB-image /
25 MiB-total limits, content-addressed read-only materialization and idempotence,
uncommitted cleanup, missing/corrupt verification, malformed-manifest
fail-closed reconstruction, Objective-edit retention, and metadata-only events.

Opt-in session naming (issue #52) is tested through the same RPC seam in
`test/goal52-session-naming.test.mjs`: the live name comes from Pi's own
`get_state` and the durable one from the `session_info` entries in the session
file, while a name that must *not* be written is produced through Pi's
`set_session_name` command — the user-provided name seam, so the test's own name
is provably not the extension's. The pure rules (the setting's default and its
malformed-value handling, the first-line/whitespace/80-character derivation, and
the never-overwrite and write-failure outcomes) are unit-tested against
`src/session-naming.ts` with a fake of the two Pi seams; the RPC tests then prove
those rules through a real session, including the two failure paths a name must
not survive — a durable write that fails and rolls the creation back, and a
creation cleared while it waited for the current run.

The opt-in paused-Goal resume prompt (issue #51) is tested through the same RPC
surface in `test/goal51-resume-prompt.test.mjs`: a builder session reaches a
durable Lifecycle status, is stopped, and is reopened from a copy of its session
file with `goal.resumePrompt` in its settings; the test then answers the dialog
over the `confirm` extension-UI subprotocol with accept, decline, dismissal, or
nothing at all, and asserts the durable snapshot, run/continuation counts, and
notifications. `PI_GOAL_DIALOG_TIMEOUT_MS` shortens the dialog safety bound for
the timeout case (see [Dialog timeouts](#dialog-timeouts)); the UI-less behavior
of print and JSON modes is covered against the handler directly, with a fake Pi
API, because those modes have no dialog to observe through the RPC harness.

### Dialog timeouts

Every interactive dialog pi-goal opens (a replacement confirmation, the
interactive objective editor, the resume prompt) carries a `timeout` and a safe
default answer, so an unattended host cannot make a command wait forever.
`PI_GOAL_DIALOG_TIMEOUT_MS` overrides that bound with a positive integer number
of milliseconds; it exists so the timeout branches are testable through the
real-Pi harness without waiting the production interval out. An unset or invalid
value leaves the production defaults untouched, so it changes nothing for users.

### Rex provider acceptance

`test/goal43-rex-acceptance.test.mjs` accepts the *released* pi-rex-subagent
provider against the same RPC surface. The vendored release tree
(`test/fixtures/rex-subagent-v0.2.0`, with its provenance record: tag, release
commit, and tarball checksum) is loaded as a real extension next to pi-goal, so
child work crosses exactly the seam the provider contract fixes: the persisted
parent tool-result `usage` plus the accounting `details` cursors, produced by a
real child Pi whose session events publish the usage snapshots.

`test/helpers/rex-acceptance.mjs` builds the isolated environment per test: a
foreground Rex server on a private Unix socket (`REX_SERVER`, so the user's own
Rex app is never touched), a deterministic OpenAI-compatible child provider
resolved through `models.json` in the shared agent directory (no credentials, no
network), and that agent directory, which also isolates the provider's run
records. A hold gate can keep a child provably mid-turn so a test can observe
the zero-usage snapshot a running child has already published. The helper also
drives the released CLI for adoption and second-turn fixtures, supports nested
children on the same private server, and can crash one child to exercise
durable-recovery diagnostics. Every client it spawns is retained for the
environment's lifetime, so teardown kills and reaps them — SIGTERM, then a
bounded SIGKILL escalation — before the temp tree goes, and a call a throwing or
timed-out test abandoned never outlives the socket it was using.

`test/goal44-rex-recovery.test.mjs` extends that acceptance through restart and
selected-parent-branch reconstruction, parallel and overlapping observations,
Replacement Goal ownership, adoption and nested delegation, and final
stop/removal. The final-collection scenario checks all three persisted cursor
outcomes: `final: true`, a durable non-final remainder marked
`finalization: "unconfirmed"`, and terminal `snapshot: "missing"` recovery with
zero observed usage. The restart scenario also pins observation-time V1: work
performed while paused is charged only by the post-resume observation. These
tests assert public tool results and Goal records; direct run-directory access
is limited to fixture administration and crash setup.

Because the nested scenario's immediate child and its real grandchild share one
provider, its responder identifies a request by the conversation that produced
it — the last tool result, or the prompt when there is none — and holds the
immediate child's `rex_wait` turn until the grandchild's request has been
observed. Neither turn is scripted by global arrival index, so the aggregate
holds whichever child reaches the provider first.

The live scenarios need a `rex` CLI; without one they skip with a message,
because what they certify is the real released provider, not a green tick.
pi-goal core stays Rex-free, which the suite's static isolation test pins.

### Neutral subagent-usage conformance

`test/helpers/subagent-usage-conformance.mjs` defines the issue #45 V1 cases once
and executes them through a provider's real public custom-tool results. The
adapter supplies fixture administration only; assertions see Pi's persisted
`usage` delta and `details` cursors, never private provider accounting methods.
`test/goal45-subagent-usage-conformance.test.mjs` runs seven cases each against:

- `test/extensions/usage-conformance-fake.ts`, a deterministic file-backed fake
  with no model or network dependency;
- released Rex v0.2.0, through the same isolated environment used by #43/#44.

The cases cover explicit baselines, complete Usage, first/repeated/zero-delta and
concurrent observations, malformed/regressed/negative-component/negative-delta/
changed-child-session/changed-generation/ownership/wrong-identity rejection,
rejected-call cursor atomicity (a failed multi-run observation commits none of
its cursors, so the exact outstanding delta is still collectable), adoption,
restart and selected-branch reconstruction without a charge, and final collection
before removal. Private fake run metadata deliberately includes child active time
to prove it never crosses the public result: every observation assertion rejects
active/elapsed field names and the planted values anywhere in the serialized
result, `content` included. The Rex scenarios also skip loudly when no `rex` CLI
is available; the fake cases always run.

## Interactive smoke test

Deterministic RPC tests are the automated gate. The manual real-Pi procedure —
installation, creation, automatic continuation, interactive editing, pause,
resume, status, restart persistence, clear, and the clear tombstone — is in
[smoke-test.md](smoke-test.md).

## Verification

```sh
npm run typecheck  # tsc --noEmit
npm test           # deterministic real-Pi RPC suite (requires pi 1.5.1+ on PATH)
```

`npm test` runs the complete RPC suite plus unit tests for accounting, the
store's durability boundaries, the compact status line, the interactive/headless
editing guard, and the `pi install` package workflow. It needs no model
credentials or network service.

To verify the package installation and the interactive surface by hand, follow
[smoke-test.md](smoke-test.md). The smoke test covers:

- [ ] `pi install ./` and `pi list`
- [ ] `/goal <objective>` creation and immediate work
- [ ] `/goal --file <path> --image <path> <objective>` sends encoded untrusted
      text and Pi image blocks, restarts with the same hashes, retains artifacts
      after replacement/clear, and suppresses Continuation on integrity failure
- [ ] automatic continuation at settlement
- [ ] bare `/goal edit` interactive editing
- [ ] `/goal pause`, `/goal resume`, and `/goal clear`
- [ ] `/goal resume --budget <new-total>` after budget exhaustion, including the
      `--budget=` spelling and the positive-headroom/maximum refusals
- [ ] the compact status indicator for `active`, `paused`, `blocked`,
      `usage_limited`, `budget_limited`, and `complete`
- [ ] restart persistence and the clear tombstone
- [ ] a `blocked` Goal's active time is frozen across idle time and a restart,
      and the `usage_limited` freeze is covered by the deterministic regressions
- [ ] a work message queued for a cleared or replaced Goal is delivered after the
      new Goal commits but opens nothing: the new Goal's own kickoff runs exactly
      once and only its own work is charged
- [ ] a run admitted against a replaced identity cannot complete, report a
      blocker against, or pause the Goal that replaced it, and the replaced
      identity keeps its own durable superseded record
- [ ] with `goal.sessionNameFromObjective: true`, a creation names an unnamed
      session from the Objective's first line; with the setting absent or false,
      no session is named; a user-provided name, an Objective edit, a Replacement
      Goal, and a failed or rolled-back creation never change it
