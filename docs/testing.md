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
and metadata-only Goal-updated events. A URL passed to `--image` is refused
without network access, while `--remote-image` is covered separately below; SVG
and unknown types are rejected. The suite inspects the durable manifest and the
sibling `pi-goal-store` directly, and every admitted run is sized and
deliberately settled or aborted.

`test/goal49-attachments-store.test.mjs` pins the cheaper fault matrix: magic
byte sniffing, strict UTF-8, the 8-attachment / 1 MiB-text / 10 MiB-image /
25 MiB-total limits, content-addressed read-only materialization and idempotence,
uncommitted cleanup, missing/corrupt verification, malformed-manifest
fail-closed reconstruction, Objective-edit retention, and metadata-only events.

Remote-image fetching (issue #50) is tested at the same two seams. The local TLS
fixture (`test/helpers/remote-image-fixture.mjs`, certificate and key under
`test/fixtures/tls/`) serves every redirect, timeout, MIME, size, and hostile
target case; it binds an ephemeral loopback port and no test resolves or
connects to a public destination. The spawned Pi trusts the fixture CA through
`NODE_EXTRA_CA_CERTS`, and the extension's test-only
`PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS` seam opts in exactly that HTTPS origin, which
production correctly refuses as loopback. `PI_GOAL_TEST_REMOTE_IMAGE_TIMEOUT_MS`
shortens the 15-second production deadline for the timeout cases, and
`PI_GOAL_TEST_REMOTE_IMAGE_DNS` supplies a JSON host-name-to-addresses map that
replaces the host resolver entirely: a name the stub does not list does not
resolve, so no test depends on `/etc/hosts`, a local resolver, or the public
internet, and mixed public/private answers can be pinned deterministically. Both
variables are read only when the real-Pi harness sets `PI_GOAL_TEST_SCRIPT`,
and neither changes production defaults. `test/goal50-remote-images.test.mjs`
proves fetch-once and hash stability across Continuations, restart, and a cloned
selected branch; it also covers redirect revalidation, credentials, HTTP,
loopback/private/link-local/DNS refusals, actual-byte MIME validation, the
per-image and total bounds, disabled admission before any request, and rollback
with no success event. It also holds a fetch open to prove that a `/goal:clear`,
an edit, or a `create_goal` tool call during the network wait wins over the
stale command, which cancels with a warning, retracts its uncommitted artifacts,
and emits no success event. `test/goal50-remote-images-store.test.mjs` pins URL
shape and label derivation, the IPv4/IPv6 destination policy (including mapped,
IPv4-translatable, well-known and local-use NAT64, 6to4, Teredo, reserved, and
public controls), literal/DNS/redirect forms of a private IPv4 embedded in a
translation prefix, bounded declared and streamed bodies, stalled responses, and
mixing a fetched image with local sources in one manifest. The source URL never
appears in the durable manifest, events, or metrics; tests assert that directly.

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

The optional Goal title (issue #82) is covered at both seams.
`test/goal82-goal-title.test.mjs` drives a real `pi --mode rpc` session with
`events-peer.ts` and `metrics-peer.ts` loaded alongside pi-goal: it proves that
`/goal:edit --title` commits the same identity at the next revision, that `/goal`
and the `get_goal`/`update_goal` structured payloads carry the title, that an
objective and a title can change in one revision, that invalid titles leave the
snapshot bytes unchanged, and — with the peer logs read back from the session
file — that the title text appears in none of the `goal-history`,
`goal-events-log`, or `goal-metrics-log` entries. `test/goal82-goal-title-store.test.mjs`
pins the cheaper matrix against a fake Pi API: the one-line 1–80 code-point
validation, a title-less creation on every path, in-place and combined edits, the
complete-Goal asymmetry (objective frozen, title relabel admitted), legacy
snapshots without a title reconstructing unchanged (and a malformed title dropped
without losing the Goal), the metadata-only event/history/metrics projections, the
naming preference for a title over the Objective's first line with the
never-overwrite and write-failure rules unchanged, and the command surface
(`--title` alone, combined, refused, and completing `--title`).

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

The opt-in progress-plan tool (issue #53) is tested through the same RPC surface
in `test/goal53-progress-plan.test.mjs`, and it drives real model tool calls
rather than calling the extension's own helpers. The registration cases read the
tool declarations Pi puts in the model's context — the `tools` section and the
guideline bullets of the system prompt — so "not registered while disabled" is
observed as the absence of a declaration plus Pi's own refusal of the call, not as
an internal flag. Step validation is driven with arguments that fail the
argument schema (a drifted `status`) and arguments that pass it but break a
semantic rule (two `in_progress` steps), which is what separates Pi's refusal from
the extension's. Durability and restart visibility are asserted from the
persisted tool-result `details` on the session branch and from the model context
after reopening a copied session file; accounting is asserted against the durable
and live usage totals, including the excluded cached reads; and the Completion
audit is asserted by proving that a plan marking every step `completed` writes no
snapshot, advances no revision, and leaves the loop running until the model's own
`update_goal` call. Two scenarios are gated rather than raced: the ones that
assert mid-run state end their script with a `hang` step and stop the loop with an
explicit abort, because the scripted provider is fast enough to finish a scenario
while the test is still reading the session file. The name-collision case loads
`test/extensions/plan-name-peer.ts`, which owns the `update_plan` name first, and
asserts that pi-goal registers nothing, that the peer's tool is the one that runs,
and that no Continuation names it.
The non-authoritative Goal audit history (issue #54) is tested through the same
RPC surface in `test/goal54-history.test.mjs`. The durable `goal-history` entries
are read straight out of the session file and asserted against the interleaved
`goal-state` entries — every record directly follows the snapshot or tombstone it
describes, with the committed identity, revision, previous/current statuses,
timestamp, usage summary, Active elapsed time, and manifest hashes — across the
whole user-command lifecycle, a restart that renders the same timeline and then
grows it, the budget stop and its recovery, the blocked threshold, a provider
usage limit, a declined replacement, attachment metadata (hashes, never contents),
and real `ctx.navigateTree()` branch navigation through `test/extensions/tree-nav.ts`,
where each selected branch renders only its own records. Two scenarios rewrite the
session file between sessions to reach seams a live process cannot: a truncated
record (skipped, counted, and surfaced as a notice while the Goal reconstructs
unchanged) and a dropped record (the crash gap between the commit and the append,
which leaves reconstruction and the next transition correct). The read-only
property is asserted directly — rendering appends no entry and starts no run — and
`test/goal54-history-store.test.mjs` pins the cheaper fault matrix against a fake
Pi API: the projection contract, silence for every refused/failed/rolled-back
path, an injected history-append failure that leaves the committed transition
standing, branch-local reads, and the structural validation that rejects a
truncated record.

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

### Review-child launch profile

`test/goal57-review-profile.test.mjs` keeps the orchestration docs honest about
the read-only review-child profile in `docs/agents/subagents.md`. It parses the
documented `rex_spawn` arguments and the equivalent CLI form, then starts a real
`pi --mode rpc` session with exactly those `--tools` / `--exclude-tools` values
and reads Pi's model-visible active tool set through
`test/extensions/active-tools-peer.ts`. The same suite proves the parent session
still declares the Goal tools and keeps its durable Goal bytes unchanged, and
drives `get_goal`, `create_goal`, and `update_goal` in the review child to the
`Tool <name> not found` refusal without any Goal snapshot. The byte comparison
comes after the child's re-run has settled and consumed its second scripted
step, because a prompt response only acknowledges acceptance; the test also pins
the interim `agent_settled` count and the run count, so a skipped re-run fails
instead of silently passing the comparison. When `rex` is
available, a live scenario dispatches through the released provider's
`rex_spawn` and inspects the run record's `launchArgs`, so the documented
profile is proven to reach the child Pi as real launch arguments.

### Goal RPC companion and the command bridge

`test/goal8-headless.test.mjs` drives the command handlers with a fake Pi API and
is the only deterministic place the registered command surface can be observed
(issue #79): the six names of the Goal command family — `goal`, `goal:pause`,
`goal:resume`, `goal:clear`, `goal:history`, `goal:edit` — and no seventh `goal*`
command; the `/` menu descriptions; the argument completions `/goal ` (the five
creation flags, prefix-filtered, nothing when no flag matches) and `/goal:resume `
(`--budget`); a stray argument on a verb as a usage error that writes no Goal
bytes; and the headless (`hasUI: false`) `/goal:edit` guard.

`test/goal56-command-bridge.test.mjs` covers the bridge with a fake Pi API, which
is the only way to reach a few narrow cases deterministically: the whole outcome
classifier truth table; strict version-2 request validation (a `name` outside the
family, a non-string `args`, and a version-1 request dropped with the upgrade
diagnostic rather than answered); the action derived from the command name for all six commands, with
`/goal` refusing the old `pause` argument as a `create` that was `refused`, never
`invalid`; a family name that is not a registered command at dispatch time,
answered `invalid` with no Goal mutation; and a creation that commits in memory,
announces its transition on the event stream, and then fails its on-disk
durability poll. That last one is the point of the seam: the bridge must answer
`refused` for the retracted creation even though the event stream already
announced it, and the test asserts the answer and the empty `goal-state` bytes.
The same file pins the busy guard (a second bridged command while a confirmation
dialog is open), the declined-replacement no-op, the no-session guard, the
session-control guard (a bridged context throws for `abort`, `shutdown`,
`compact`, `newSession`, `fork`, `navigateTree`, `switchSession`, and `reload`,
and the test asserts the underlying session was never touched), the once-only
reply contract (a reply callback that throws is not called a second time), and
the companion's structural optionality: protocol constants agree with core, the
package declares no pi-goal dependency, imports nothing from `src/`, registers no
model tool, never names a durable Goal entry, and no longer carries a parser
mirror.

`test/goal56-goal-rpc-companion.test.mjs` drives the companion's public protocol
against a real `pi --mode rpc` subprocess: one `/goal-rpc <json>` extension
command in, one `goal-rpc-response` entry (published as `entry_appended`) out. It
covers get/set/clear round-trips (including `origin: "command"`, so a bridged
`set` is provably the user path and not `create_goal`), replacement confirmation
declined and accepted with the superseded history record, the stale-run binding
refusal that survives a replacement, disabled admission, invalid budgets (both
pi-goal's whole-number rule and the companion's own envelope checks), declared
model authority, and a companion-only session with no pi-goal installed, which
answers `unavailable` instead of crashing. It also pins that a reserved-word
Objective is **pi-goal's** refusal, not the companion's — `clear`, `pause`,
`history`, `resume`, `edit`, and `resume --budget …` each come back `refused`
with pi-goal's own diagnostic verbatim and the Goal bytes unchanged — while an
Objective that begins with `edit` (`edit the release notes`) and one that merely
begins with another verb word are created, and a leading option token is
answered by pi-goal's creation path verbatim; and the strict request envelope
(`version: 1` required, unknown top-level fields refused). Every refusal asserts
the structured error code **and** that the raw `goal-state` bytes are unchanged,
so "nothing happened" is proved rather than assumed.

## Interactive smoke test

Deterministic RPC tests are the automated gate. The manual real-Pi procedure —
installation, the six Goal command family commands in the `/` menu, creation,
automatic continuation, interactive editing, pause, resume, status, the
refusals of the old space-separated spellings, the two argument completions,
restart persistence, clear, and the clear tombstone — is in
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
- [ ] `/goal --remote-image <https URL> <objective>` fetches once over HTTPS,
      keeps the same hash across restart and cloned branches, refuses
      non-public destinations and unsafe redirects, and never fetches again
- [ ] automatic continuation at settlement
- [ ] the `/` menu lists `/goal`, `/goal:pause`, `/goal:resume`, `/goal:clear`,
      `/goal:history`, and `/goal:edit` and nothing else matching `goal*`
- [ ] `/goal ` completes `--budget`, `--no-budget`, `--file`, `--image`, and
      `--remote-image`; `/goal:resume ` completes `--budget`
- [ ] bare `/goal:edit` interactive editing
- [ ] `/goal:edit --title <text>` sets a title that `/goal` and `get_goal` report,
      alone or together with a new objective; an invalid title, a missing value,
      and a title edit that tries to change attachments are refused and change
      nothing; a title-only edit starts no work and never renames the session
- [ ] `/goal:pause`, `/goal:resume`, and `/goal:clear`
- [ ] the old space-separated spellings (`/goal` followed by a space and a bare
      verb word, or `resume --budget N`) are refused with the command to type
      and change nothing
- [ ] `/goal:resume --budget <new-total>` after budget exhaustion, including the
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
