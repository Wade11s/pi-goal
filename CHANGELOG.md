# Changelog

Release notes for `@wade11s/pi-goal`. Pi shows entries newer than the last seen
version after a package update, matching these headings against the `version`
field in `package.json`.

## [0.1.1] - 2026-11-16

- Publish from CI: pushing a `v*` tag runs typecheck and the full test suite,
  publishes with npm Trusted Publishing (OIDC), and creates a GitHub release from
  this changelog — no npm token is stored in the repository.
- Add `scripts/release-notes.mjs` and tests that pin its changelog extraction
  rules, plus `docs/release.md` for the release procedure.
- Document the npm-first install flow and the reorganized docs map.

## [0.1.0] - 2026-11-16

First npm release.

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
