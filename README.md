# pi-goal

Codex-style persistent Goals for [Pi](https://github.com/earendil-works/pi).

A Goal is a durable, user-controlled objective for a session. While a Goal is
**active**, work continues automatically at Pi's safe settlement boundary until
the model verifies completion, a genuine blocker persists, a provider usage limit
or terminal failure stops the run, a conservative anti-loop bound is reached, the
run is aborted, the lifecycle changes, or the Goal's token budget runs out.

The extension adds one command and three model tools. It uses only public
extension APIs and does not patch Pi core.

| Surface | Purpose |
| --- | --- |
| `/goal <objective>` | Create a Goal and start work immediately |
| `/goal` | Report objective, status, identity, usage, and remaining capacity |
| `/goal history` | Read-only timeline of the branch's committed Goal transitions |
| `/goal edit [objective]` | Change the objective in place, keeping identity and history |
| `/goal pause` · `/goal resume` · `/goal clear` | Stop admission, restart work, or remove the Goal |
| `/goal --budget <n>` · `/goal --no-budget` | Bound unattended usage at creation |
| `/goal --file <path>` · `/goal --image <path>` · `/goal --remote-image <url>` | Attach explicit local text files, local images, or fetch a remote image once (repeatable leading options) |
| `/goal resume --budget <new-total>` | Raise a `budget_limited` Goal's cumulative ceiling |
| `get_goal` | Structured Goal state for the model |
| `create_goal` | Model-created Goal, only on an explicit user request |
| `update_goal` | Complete, report a blocker, or pause on an explicit request |

Requires **Pi 1.5.1 or newer**.

## Supported Pi versions

pi-goal targets Pi **1.5.1 and newer**. It is developed against the public
extension APIs available in 1.5.1; `package.json` pins
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.5.1 for
typechecking, and the automated suite runs against the installed `pi` CLI
(1.5.1 or newer; verified on 1.5.2). Pi loads the TypeScript entry point through
its `jiti` loader, so no build step is required.

## Install

pi-goal installs as a Pi package from its GitHub repository:

```sh
pi install git:github.com/Wade11s/pi-goal
```

Pi records the package in personal settings (`~/.pi/agent/settings.json`); the
extension loads on the next start. Confirm the installation:

```sh
pi list                  # pi-goal appears under User packages
```

Pin a tag, branch, or commit by appending it to the source:

```sh
pi install git:github.com/Wade11s/pi-goal@v0.1.1   # or a branch / commit
```

A git ref is pinned: `pi update --extensions` reconciles the checkout but never
moves a configured ref. Without one, Pi follows the repository's default branch.

Add the declaration to the project rather than your personal settings with
`--local` (`.pi/settings.json`, read only after project trust):

```sh
pi install --local git:github.com/Wade11s/pi-goal
```

Try it once without adding it to settings:

```sh
pi -e git:github.com/Wade11s/pi-goal
```

For development against a checkout, install the directory directly — a local
package is loaded from its resolved path rather than copied:

```sh
pi install ./            # add to personal settings
pi install --local ./    # or project-local (.pi/settings.json)
```

Update and remove the installed package by source:

```sh
pi update git:github.com/Wade11s/pi-goal   # or: pi update --extensions
pi remove git:github.com/Wade11s/pi-goal
```

The package declares its entry point in `package.json` (`pi.extensions`), is
discoverable through the `pi-package` keyword, has no runtime dependencies, and
uses Pi's host-provided packages (`peerDependencies` only).

## Quick start

```sh
/goal Make the full test suite pass in this repository
```

- The objective is validated (3–2000 characters after trimming), stored as
  durable session state, and confirmed on disk before success is announced.
- The objective is then sent into the model context as a user message, and
  initial work starts immediately.
- When an **unfinished** Goal already exists, `/goal <objective>` asks for
  confirmation before replacing it; a declined, timed-out, or dismissed dialog
  keeps the current Goal untouched.

Add explicit supporting material without changing the Objective's length
policy:

```sh
/goal --file spec.md --image screenshot.png Ship the release using the attached requirements
/goal --remote-image https://example.com/diagram.png Follow the attached diagram
```

`--file`, `--image`, and `--remote-image <https URL>` are repeatable leading
options. Remote images are fetched **once** at creation over HTTPS only, with no
credentials, a 15-second deadline, at most three revalidated redirects, and
loopback/link-local/private destinations refused. Plain arguments remain text,
and model-driven `create_goal` remains text-only. See
[Objective attachments](docs/behavior/attachments.md).

With a UI, a compact indicator tracks the Goal:

```
goal_1a2b3c4d · active · 48210 tok · 201790 left · 5m 12s
```

Bare `/goal` prints the full breakdown: objective, lifecycle status, identity,
timestamps, revision, token budget, accounted usage, active time, and remaining
capacity. A Goal restored on session start is announced with a
`Goal ... restored (active)` notification.

```sh
/goal edit Ship the release notes page instead   # edit in place
/goal pause                                      # stop admission, keep the Goal
/goal resume                                     # restart work with a fresh audit
/goal clear                                      # durable tombstone, no resurrection
```

Every lifecycle transition is **durable before it is announced**, and all of
them work while the agent is busy — an active Goal keeps Pi continuously
occupied, so none of them wait for idle. Details:
[Goal lifecycle](docs/behavior/lifecycle.md).

## Statuses

| Status | Meaning |
| --- | --- |
| `active` | Continues automatically; active time accrues. |
| `paused` | The user stopped admission. In-flight work finishes, nothing continues, and the clock stops. `/goal resume` restarts it (an opt-in resume prompt may offer that at session start). |
| `blocked` | Three consecutive Goal turns reported the same genuine blocker, or made no activity. `/goal resume` restarts with a fresh audit. |
| `usage_limited` | The provider reported an exhausted plan or quota. `/goal resume` restarts. |
| `budget_limited` | The token budget was reached. One bounded wrap-up is allowed, then no continuation. Raise the cumulative budget to resume. |
| `complete` | Terminal for the Goal's identity. Replace it with `/goal <objective>`. |

`goal.enabled` (Pi settings, default `true`) is an **Admission control**, not a
status: while it is false, no new Goal work is admitted — no creation or
replacement, no `create_goal`, no work-admitting objective edit, no resume, and no
automatic continuation — and an active Goal keeps its `active` status and keeps
accruing active time. → [Goal lifecycle](docs/behavior/lifecycle.md)

## How it behaves

### Automatic continuation

Continuation happens at `agent_before_settle` — Pi's final actionable boundary,
after Pi has finished everything it owns: automatic retries, compaction
recovery, and queued follow-ups. Each continuation asks for exactly one further
provider request and appends a `goal-continuation` message that restates the
objective verbatim and requires an evidence audit: read files, command results,
runtime state, and artifacts; separate real progress from narration; check every
explicit requirement. Nothing loops from `agent_end` and no timers are used, so
Pi's own semantics are never bypassed.

→ [Automatic continuation](docs/behavior/continuation.md)

### Stopping safely

A Goal stops only in ways ordinary work cannot trigger:

| Stop | Status |
| --- | --- |
| The same genuine blocker for three **consecutive** Goal turns, identified by the extension-issued Blocker identity | `blocked` |
| Three consecutive activity-free **automatic** Goal turns | `blocked` |
| Three consecutive automatic turns in which commands could not be executed | `blocked` |
| Provider usage limit | `usage_limited` |
| Token budget reached | `budget_limited` |
| Every requirement verified by the model | `complete` |

An ordinary command failure — non-zero exit, timeout, abort — is normal work and
never counts toward the anti-loop bounds. Aborts and provider errors that Pi owns
are hard exits, not Goal malfunctions. A `blocked` or `usage_limited` Goal never
continues automatically: only the user's `/goal resume` restarts it.

→ [Stopping safely on blockers and failures](docs/behavior/stopping.md)

### Budgets

```sh
/goal --budget 250000 Make the full test suite pass in this repository
/goal --no-budget Make the full test suite pass in this repository
```

- `--budget <n>` (or `--budget=<n>`) is recognized only as a *leading* flag.
- `--no-budget` is refused while `goal.maxTokenBudget` is configured.
- `goal.defaultTokenBudget` and `goal.maxTokenBudget` live in Pi settings; the
  maximum is a hard bound on every path — an explicit budget above it is refused,
  a default above it is clamped, and no unbounded Goal can be created while it is
  set.
- Reaching the budget is **not** completion: the Goal becomes `budget_limited`,
  the clock stops, and one bounded wrap-up is requested; the same gate blocks
  every tool call so no further substantive work runs.
- `/goal resume --budget <new-total>` raises the **cumulative** ceiling (not an
  increment). It must exceed the accounted total and stay within the configured
  maximum, and it earns one fresh wrap-up per exhaustion episode.
- Completing a **budgeted** Goal returns a final-response usage report in the
  `update_goal` result: accounted tokens, Active elapsed time, the Token budget,
  remaining capacity, and the accounting approximations behind them. It is built
  from the completion snapshot, so it costs no extra provider request. An
  unbudgeted Goal's completion reports no budget and no remaining capacity.

→ [Token budgets and budget exhaustion](docs/behavior/budgets.md)

### Objective attachments

Use repeatable leading `--file <path>`, `--image <path>`, and
`--remote-image <https-url>` options at creation or Replacement Goal time. Text
files must be non-empty UTF-8; PNG, JPEG, GIF, and WebP images are recognized by
their **bytes**, while SVG and unknown types are refused. Limits are 8
attachments, 1 MiB per text file, 10 MiB per image, and 25 MiB total.

A remote image is fetched once, before the snapshot commits, over HTTPS only.
The fetch sends no credentials, cookies, or referrer, has a 15-second overall
deadline, follows at most three revalidated redirects, and refuses loopback,
link-local, and private-network destinations — including redirect targets and
DNS results. The fetched bytes are validated and materialized exactly like a
local image. The source URL is neither required later nor persisted; only the
immutable manifest's hash, media type, byte size, and a display label derived
from the URL basename remain.

Before the Goal snapshot commits, pi-goal copies the bytes into an immutable,
content-addressed `pi-goal-store/<goal-id>/` beside the session file. Text reaches
the model as encoded, delimited **untrusted data** under the Objective's nonce
boundary; images use Pi's text/image content arrays. Every kickoff and
Continuation loads the same manifest and never refetches a remote source.

An Objective edit retains that manifest; changing attachments requires a
Replacement Goal. Clear and replacement retain committed artifacts so historical
branches remain reconstructable: **V1 has no destructive automatic garbage
collection**. Missing or corrupt restored artifacts produce an explicit error and
suppress automatic Continuation without changing Lifecycle status. This explicit
flow is the supported alternative to Codex composer drafts; Pi has no equivalent
pending-draft object to infer.

→ [Objective attachments](docs/behavior/attachments.md)

### Disabling the extension

```json
{ "goal": { "enabled": false } }
```

`goal.enabled` (default `true`) is an admission control: while it is false,
pi-goal admits no new Goal work, so nothing unattended starts.

- **Refused:** `/goal <objective>` (creation and replacement), `create_goal`,
  `/goal edit` of an *active* Goal (an edit there steers work into a running
  Goal), `/goal resume`, and the automatic continuation or budget wrap-up the
  settlement seam would otherwise request. A pending wrap-up is deferred, not
  lost: it is delivered at the first settlement after re-enabling.
- **Still available:** bare `/goal` and `get_goal`, `/goal pause`, `/goal clear`,
  and every terminal update from work already in flight — including a
  `budget_limited` transition and an `update_goal` completion. An in-flight
  provider request is never aborted.
- **Nothing is rewritten:** the Goal keeps its Lifecycle status and keeps
  accruing active time. **Pausing the Goal, not disabling the extension, stops
  that clock**, so the status report and the compact indicator both say
  `admission off` while an active-but-disabled Goal is not mistaken for one that
  keeps continuing.
- A changed setting takes effect at the next session start or reload, exactly
  like the budget settings; a non-boolean value is reported and ignored.

→ [Goal lifecycle](docs/behavior/lifecycle.md)

### Naming the session from the Objective

```json
{ "goal": { "sessionNameFromObjective": true } }
```

`goal.sessionNameFromObjective` (default `false`) is an opt-in convenience: after a
successful creation, pi-goal may name an otherwise unnamed session from the
Objective, so a Goal is easier to find later in a session list.

- The name is the Objective's **first line**, whitespace-collapsed and capped at
  **80 characters**. Attachment contents never contribute: only the Objective text
  does.
- **A name you provided is never overwritten.** If the session already has a name,
  pi-goal leaves it alone.
- **An Objective edit and a Replacement Goal never rename anything**, and a
  creation that failed, was rolled back, or was cleared while it waited names
  nothing.
- The name is Pi's own session metadata, not Goal state: it is not part of the
  Lifecycle, of accounting, or of the `pi-goal:updated` event stream, and it
  survives a restart because Pi persists it.

→ [Goal lifecycle](docs/behavior/lifecycle.md)

### Optional resume prompt

```json
{ "goal": { "resumePrompt": true } }
```

`goal.resumePrompt` (default `false`) offers **one** confirmation dialog at
session start when a restored Goal is `paused`: accepting runs the same durable
transition as `/goal resume` (same identity and history, fresh Blocked audit),
while declining, dismissing, timing out, or having no dialog-capable UI leaves
the Goal paused and unchanged. Only `paused` is ever prompted for — `blocked`,
`usage_limited`, and `budget_limited` recovery stays an explicit user decision —
and the prompt is never awaited by startup, so print, JSON, and headless RPC
flows never wait for it. While `goal.enabled` is false the prompt is not offered
at all; the restore notice says so instead. →
[Opt-in resume prompt](docs/behavior/lifecycle.md#opt-in-resume-prompt)

### Optional progress plan

```json
{ "goal": { "planTool": true } }
```

`goal.planTool` (default `false`) registers an `update_plan` model tool for long
Goals. It takes one ordered list of steps, each `pending`, `in_progress`, or
`completed`, with **at most one in progress**, so verified progress and
remaining work stay visible across Continuations.

- **Off by default.** While it is off the tool is not registered at all: it is
  not in the model's tool list, no Continuation mentions it, and a call to it is
  refused by Pi. A non-boolean value is reported once and ignored.
- **It is narration, not state.** The plan lives in the tool result's `details`,
  which Pi already persists on the session branch — there is no second Goal
  record, no `goal-state` entry, and no `pi-goal:updated` event. A plan call
  never changes the Lifecycle status, and marking every step completed never
  completes the Goal: only `update_goal` with `complete`, after the evidence
  audit, does that.
- **It is accounted like any other tool call.** No plan-specific accounting
  branch exists, so a plan turn's tokens count against the Token budget exactly
  like every other Goal turn.
- **It never takes another extension's tool.** If something else already
  registered `update_plan`, pi-goal registers nothing, says so, and no
  Continuation names the tool.

→ [Model tools](docs/tools.md#model-tool-update_plan) ·
[Goal lifecycle](docs/behavior/lifecycle.md#optional-progress-plan)

### Usage accounting

The accounted total is `input + output + cacheWrite`. Cached reads are prompt
reuse and are reported but excluded; `cacheWrite1h` is a subset of `cacheWrite`
and `reasoning` a subset of `output`, so neither is added twice. Each report is
charged exactly once, and reconstruction replays the session branch under the
same rule, so a reload, restart, or tree navigation converges on the same
totals.

Usage counts as Goal work only inside an open **admission segment**, opened when
Pi delivers a Goal work message that names the current Goal identity and closed
by a genuine user prompt or a new identity. Active time runs on a monotonic clock
and stops in every non-active status and during process downtime.

→ [Usage accounting](docs/behavior/accounting.md)

### Persistence

Goal snapshots are `goal-state` custom session entries outside the model
context. The last snapshot on the active session branch wins, so restart,
resume, reload, and tree navigation reconstruct the state without restating the
objective; the *selected* branch alone decides it. The newest *current* entry
controls the branch: a malformed or unrecognized one fails closed rather than
falling back to an older snapshot that could resurrect a cleared or replaced
Goal. Usage checkpoints live in separate `goal-usage` entries, and ephemeral
sessions (`--no-session`) refuse to create a Goal at all. Attachment bytes live
outside those entries in the Goal-keyed artifact store beside the session file;
copying a session elsewhere requires that store as well, and restore verifies
every recorded hash.

→ [Persistence model and legacy cutover](docs/behavior/persistence.md)

### Local events and metrics

Other local extensions can react to committed Goal state without polling:
pi-goal publishes a `pi-goal:updated` event after every meaningful durable
transition, and a pre-redacted `pi-goal:metrics` projection for operational
counters (transition kind, Lifecycle status, token totals, Active elapsed time,
budget state, and extension version). The projection is an allowlist: Objective
text, Blocker descriptions, attachment contents, file names, source URLs,
session identifiers, and prompts are never part of a metric. pi-goal performs no
network telemetry and installs no exporter dependency; a hosted exporter is a
separately installed companion that owns its own consent, redaction, retry, and
credentials.

→ [Goal-updated events](docs/behavior/events.md) ·
[Operational metrics and the exporter seam](docs/behavior/metrics.md)

### Goal audit history

Every committed transition is also appended to the session branch as a
`goal-history` entry, and `/goal history` renders them as a readable timeline:
identity, revision, previous and current Lifecycle status, timestamp, usage
summary, Active elapsed time, and attachment manifest hashes when the Goal has
attachments.

- **Non-authoritative.** The durable `goal-state` snapshots and tombstones remain
  the only lifecycle authority. Nothing reconstructs from history, so missing or
  malformed history cannot resurrect, clear, replace, or otherwise change the
  current Goal, and a malformed entry is skipped and surfaced as a rendering
  notice only.
- **Read-only.** No command, tool, or option mutates a Goal from a history
  record; `/goal history` only reads and prints.
- **One record per committed transition** — never per token delta, accounting
  checkpoint, or clock tick, and never for a rolled-back transition.
- **A crash between the commit and the append** leaves a documented diagnostic
  gap: the timeline has no record for that transition, and reconstruction and
  later transitions are unaffected.

→ [Goal audit history](docs/behavior/history.md)

## Limitations

- `create_goal` refuses while **any** Goal exists; replacing, clearing, and
  resuming stay with the user. A blocked or usage-limited Goal therefore waits
  for the user instead of quietly resuming itself.
- Model-requested creation and pause are corroborated by exact-quote matching
  plus conservative deterministic checks. Unusual phrasing, image-only requests,
  and requests whose exact words were never sent as text are refused; the direct
  command always works.
- Budget enforcement happens when a turn's usage is accounted, not inside the
  provider loop, so a run can overshoot before the gate stops further work. A
  tool already in flight when the budget is crossed still finishes and is
  charged.
- Session naming is read from Pi's effective settings at session start, so a
  changed `goal.sessionNameFromObjective` takes effect on the next session start
  or reload. It names only a session that has no name yet and only on a creation,
  so a session whose name came from an earlier Goal keeps that name.
- Attachments are explicit local text/image files or explicit HTTPS remote
  image URLs. pi-goal never infers URLs from plain arguments, model calls, or
  Codex-style composer drafts. A remote image is fetched once; later changes at
  the source URL do not alter the Goal. The fetch refuses non-public
  destinations and pins the validated DNS result to the connection, so a DNS
  change between resolution and fetch cannot redirect it; it does not otherwise
  certify that a public origin is trustworthy. Committed artifacts are retained
  after clear and replacement with no destructive automatic GC, so long-lived
  sessions can accumulate up to 25 MiB per historical Goal. Local attachment
  option values are whitespace-free paths; use a path without spaces in V1.
- `goal.enabled` is read from Pi's effective settings at session start, so a
  changed value takes effect on the next session start or reload rather than
  mid-session. While the extension is disabled, an active Goal accrues no new
  Goal-owned usage either, because every run starts from a user prompt that
  closes the admission segment.
- `/goal history` reports the branch's records as they are. A crash between a
  lifecycle commit and its history append leaves one transition without a record;
  the timeline never invents a placeholder for it, and the authoritative Goal is
  unaffected either way.
- `goal.resumePrompt` is a convenience over the explicit `/goal resume`, never a
  replacement for it: it is off by default, asks only once per session start and
  only for a restored `paused` Goal, and every answer other than an explicit
  "yes" — decline, dismissal, timeout, no UI — leaves the Goal untouched. It
  never resumes `blocked`, `usage_limited`, or `budget_limited` work.
- `goal.planTool` is off by default and registers nothing while off. It is read
  at session start, so a changed value takes effect on the next session start or
  reload; the plan it records is the model's own narration, never verified
  progress, and it is never part of the Lifecycle, of accounting, or of the
  event stream.
- Accounting is provider-neutral but not invoice-exact: cached reads are
  excluded, cache writes counted, and provider billing is not reconciled.
  Migrated 0.1.0 Goals report **legacy reconstructed totals**, not exact
  Goal-owned attribution.
- The activity-free and execution-unavailable counters are per session, not
  durable; a restart gives a malfunctioning loop up to three more empty turns.
  A third extension loaded after pi-goal can still request its own continuation
  at the same boundary.
- Metrics are best-effort local bus delivery: there is no queue, retry, spool,
  or acknowledgement, so a consumer that needs completeness must persist and
  verify records itself. pi-goal ships no hosted exporter and accepts no
  analytics endpoint or credential; a companion exporter is a separate install
  with its own policy, and its delivery guarantees are its own, not pi-goal's.
  No network telemetry happens by default — the only sink is the local
  extension bus.

→ [All limitations](docs/limitations.md)

## Development

```sh
npm install        # development dependencies (TypeScript, Node types, Pi packages for typecheck)
npm run typecheck  # tsc --noEmit
npm test           # real-Pi RPC tests (requires `pi` 1.5.1+ on PATH)
```

The automated tests spawn a real `pi --mode rpc` subprocess per test with
temporary working, session, and agent directories, a scripted test provider, and
no network or model credentials. They assert RPC events, notifications, tool
results, model context, persisted session entries, and survival across hard kills
and restarts. Set `PI_BINARY` to run against a specific Pi binary.

→ [Testing and verification](docs/testing.md)

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
[docs/smoke-test.md](docs/smoke-test.md). The checklist covers installation,
creation, automatic continuation, editing, pause/resume/clear, budget recovery,
the status indicator, restart persistence, the clear tombstone, frozen active
time, identity-scoped attribution of queued work, and local plus remote-image
attachments (fetch-once and stable hashes above all), including artifact
retention and restore verification.

## Documentation

| Doc | Contents |
| --- | --- |
| [Goal lifecycle](docs/behavior/lifecycle.md) | Create, replace, edit, inspect, pause, resume, clear, opt-in convenience UX, and the status indicator |
| [Objective attachments](docs/behavior/attachments.md) | Explicit local text/images and HTTPS remote images, immutable artifacts, fetch security, trust framing, limits, restore verification, and V1 retention |
| [Token budgets](docs/behavior/budgets.md) | `--budget`, settings defaults and hard maximum, raising the ceiling, budget exhaustion |
| [Automatic continuation](docs/behavior/continuation.md) | The settlement seam and the no-progress contract |
| [Stopping safely](docs/behavior/stopping.md) | Blocked audit, anti-loop bounds, usage-limit classification |
| [Usage accounting](docs/behavior/accounting.md) | Token formula, admission segments, active time, durability ordering |
| [Persistence model](docs/behavior/persistence.md) | Snapshots, reconstruction, forks, and the 0.1.0 cutover |
| [Goal-updated events](docs/behavior/events.md) | Committed local transitions and metadata-only attachment manifests |
| [Metrics and the exporter seam](docs/behavior/metrics.md) | Privacy-safe `pi-goal:metrics`, what is never projected, local consumers, and the on-demand hosted companion |
| [Model tools](docs/tools.md) | `get_goal`, `create_goal` (and creation authority), `update_goal`, trust boundary, structured responses |
| [Limitations](docs/limitations.md) | Known boundaries of the current model |
| [Codex migration status](docs/codex-migration.md) | Per-capability comparison and Pi-feasible follow-ups |
| [Subagent usage reporting](docs/subagent-usage.md) | Proposed plugin-neutral provider contract for subagent token accounting |
| [Testing](docs/testing.md) | The automated gate and the rules that keep it honest |
| [Smoke test](docs/smoke-test.md) | Manual real-Pi procedure |
| [ADR-0001](docs/adr/0001-conservative-stopping.md) | Conservative stopping is deterministic and extension-owned |
| [Traceability](docs/traceability/) | Point-in-time evidence matrices for the V1 repair programme |
| [Domain glossary](GLOSSARY.md) | The vocabulary the code and docs use |

The full docs index is at [docs/README.md](docs/README.md).

## Attribution

pi-goal is MIT-licensed. Portions of the Goal lifecycle model and the
continuation, completion, blocked-audit, no-progress, and budget wrap-up prompt
structure are adapted from the OpenAI Codex Goal extension, which is licensed
under the Apache License, Version 2.0. See [NOTICE.md](NOTICE.md) and
[LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt) for the attribution and license
text. The Pi-specific implementation is original and uses Pi's public extension
APIs.
