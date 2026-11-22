# Changelog

Notable changes to pi-goal. Version headings match the `version` field in
`package.json`; install a release with `pi install
git:github.com/Wade11s/pi-goal@vX.Y.Z`.

## [Unreleased]

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
