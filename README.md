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
| `/goal edit [objective]` | Change the objective in place, keeping identity and history |
| `/goal pause` · `/goal resume` · `/goal clear` | Stop admission, restart work, or remove the Goal |
| `/goal --budget <n>` · `/goal --no-budget` | Bound unattended usage at creation |
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
| `paused` | The user stopped admission. In-flight work finishes, nothing continues, and the clock stops. `/goal resume` restarts. |
| `blocked` | Three consecutive Goal turns reported the same genuine blocker, or made no activity. `/goal resume` restarts with a fresh audit. |
| `usage_limited` | The provider reported an exhausted plan or quota. `/goal resume` restarts. |
| `budget_limited` | The token budget was reached. One bounded wrap-up is allowed, then no continuation. Raise the cumulative budget to resume. |
| `complete` | Terminal for the Goal's identity. Replace it with `/goal <objective>`. |

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

→ [Token budgets and budget exhaustion](docs/behavior/budgets.md)

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
sessions (`--no-session`) refuse to create a Goal at all.

→ [Persistence model and legacy cutover](docs/behavior/persistence.md)

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
- Accounting is provider-neutral but not invoice-exact: cached reads are
  excluded, cache writes counted, and provider billing is not reconciled.
  Migrated 0.1.0 Goals report **legacy reconstructed totals**, not exact
  Goal-owned attribution.
- The activity-free and execution-unavailable counters are per session, not
  durable; a restart gives a malfunctioning loop up to three more empty turns.
  A third extension loaded after pi-goal can still request its own continuation
  at the same boundary.

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
time, and identity-scoped attribution of queued work.

## Documentation

| Doc | Contents |
| --- | --- |
| [Goal lifecycle](docs/behavior/lifecycle.md) | Create, replace, edit, inspect, pause, resume, clear, and the status indicator |
| [Token budgets](docs/behavior/budgets.md) | `--budget`, settings defaults and hard maximum, raising the ceiling, budget exhaustion |
| [Automatic continuation](docs/behavior/continuation.md) | The settlement seam and the no-progress contract |
| [Stopping safely](docs/behavior/stopping.md) | Blocked audit, anti-loop bounds, usage-limit classification |
| [Usage accounting](docs/behavior/accounting.md) | Token formula, admission segments, active time, durability ordering |
| [Persistence model](docs/behavior/persistence.md) | Snapshots, reconstruction, forks, and the 0.1.0 cutover |
| [Model tools](docs/tools.md) | `get_goal`, `create_goal` (and creation authority), `update_goal`, trust boundary, structured responses |
| [Limitations](docs/limitations.md) | Known boundaries of the current model |
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
