# Changelog

Notable changes to pi-goal. Version headings match the `version` field in
`package.json`; install a release with `pi install
git:github.com/Wade11s/pi-goal@vX.Y.Z`.

## [Unreleased]

- Add the opt-in structured progress-plan tool (`goal.planTool`, default `false`),
  registered as the `update_plan` model tool. It takes one ordered list of steps,
  each `pending`, `in_progress`, or `completed`, with at most one `in_progress`,
  so verified progress and remaining work stay visible across Continuations. Its
  record is the tool result's persisted `details` — the ordinary session-branch
  tool result — so it survives a restart and is visible in the model's own context
  with no second Goal record: no `goal-state` entry, no revision, and no
  `pi-goal:updated` event. It never mutates a Lifecycle status, so a plan that
  marks every step completed cannot complete or bypass the Completion audit, and
  it is accounted like any other tool call. While the setting is off the tool is
  not registered at all and no Continuation mentions it; a name already owned by
  another extension is never replaced. The contract is documented in
  `docs/behavior/lifecycle.md` and `docs/tools.md`.
- Add the opt-in paused-Goal resume prompt (`goal.resumePrompt`, default `false`):
  one confirmation at session start for a restored `paused` Goal. Accepting runs
  the same durable `/goal resume` transition (same identity and history, fresh
  Blocked audit); declining, dismissing, timing out, or having no interactive UI
  leaves the Goal unchanged. It is never offered for any other Lifecycle status,
  never makes print/JSON/headless startup wait, and is not offered at all while
  `goal.enabled` is false. The contract is documented in
  `docs/behavior/lifecycle.md`.
- Add the opt-in `goal.sessionNameFromObjective` setting (default `false`): after a
  successful *fresh* creation it names an otherwise unnamed session from the
  Objective's first line — whitespace-collapsed, capped at 80 characters, and
  attachment-agnostic. The name is written through Pi's own `session_info` seam, so
  it is host metadata rather than Goal state: it is never persisted in a snapshot,
  never reconstructed from a branch, never part of the `pi-goal:updated` stream, and
  never counted in accounting. A name that already exists is never overwritten, an
  Objective edit and a Replacement Goal never rename anything, and a refused, failed,
  rolled-back, or cleared-while-waiting creation names nothing.
- Emit a local `pi-goal:updated` event on Pi's shared extension event bus after
  every meaningful durable Goal transition (creation, replacement, objective
  edit, pause, resume, budget recovery, clear, blocked, usage-limited,
  budget-limited, completion), carrying the committed identity, revision,
  transition kind, status, objective metadata, usage summary, active time, and
  timestamp. Refused, failed, and retracted transitions emit nothing; token
  deltas and active-time ticks never emit. Listener failures are isolated by
  the bus and never roll back committed state. The contract is documented in
  `docs/behavior/events.md`.

## [0.1.1] - 2026-11-16

- Add the docs map: the behavioral contract lives in `docs/behavior/`, the model
tools in `docs/tools.md`, testing in `docs/testing.md`, and historical evidence
in `docs/traceability/`.
- Require Node 22.19+ (Pi's own minimum) and run the suite from an explicit file
glob so it also runs on Node 24.
- Make the legacy fixtures portable: the copied session header is retargeted at
the current temp directory instead of the macOS path recorded at capture.
- Stabilize the scripted provider and the blocked-audit chains against mid-write
script reads and settle ordering.

## [0.1.0] - 2026-11-16

First release.

- `/goal` command: create, replace, edit, inspect, pause, resume, and clear a
  Goal, with durable-before-announced lifecycle transitions.
- Model tools `get_goal`, `create_goal`, and `update_goal`, with quotation-based
  creation authority, exact-quote pause corroboration, and execution binding for
  every model-side transition.
- Automatic continuation at `agent_before_settle`, one provider request per
  settlement, with an evidence audit and a no-progress contract.
- Deterministic stopping on three consecutive blocker reports (opaque Blocker
  identity), activity-free and execution-unavailable anti-loop bounds, and
  provider usage limits.
- Durable token and active-time accounting: `input + output + cacheWrite`,
  charged once per report, replayed identically after restart, reload, and tree
  navigation.
- Token budgets with extension-level defaults and a hard maximum, cumulative
  budget raises, and one bounded wrap-up per exhaustion episode.
- `goal-state` and `goal-usage` session entries, tombstones, superseded records,
  and the one-time 0.1.0 cutover with legacy reconstructed totals.
- Compact `goal` status indicator across every lifecycle state.
