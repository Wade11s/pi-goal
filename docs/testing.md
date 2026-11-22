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
network or model credentials. They assert public behavior end to end: RPC
events, extension notifications, tool results, model context, persisted session
entries, and survival across hard kills and restarts. Set `PI_BINARY` to run
against a specific Pi binary; a missing binary fails fast instead of hanging.

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
the zero-usage snapshot a running child has already published. The live
scenarios need a `rex` CLI; without one they skip with a message, because what
they certify is the real released provider, not a green tick. pi-goal core
stays Rex-free, which the suite's static isolation test pins.

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
