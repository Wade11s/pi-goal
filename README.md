# pi-goal

Codex-style persistent Goals for [Pi](https://github.com/earendil-works/pi): a `/goal`
command and a `get_goal` model tool that give a session a durable, user-controlled
objective. This package implements **milestone 1** (create and restore a persistent
Goal); automatic continuation, lifecycle subcommands, and usage accounting land in
later milestones.

Requires **Pi 1.5.1 or newer**. The extension uses only public extension APIs and
does not patch Pi core.

## Install

From a checkout of this repository:

```sh
pi install ./            # add to personal settings
pi install --local ./    # or project-local (.pi/settings.json, after project trust)
```

Or try it once without installing:

```sh
pi -e ./
```

The package declares its entry point in `package.json` (`pi.extensions`), has no
runtime dependencies, and uses Pi's host-provided packages.

## Usage

### Create a Goal

```
/goal Make the full test suite pass in this repository
```

- Validates the objective (3–2000 characters after trimming).
- Stores an **active** Goal as durable session state and confirms it is on disk
  before announcing success.
- Sends the objective into the model context as a user message and starts initial
  work immediately.
- Refuses to replace an existing Goal (replacement confirmation and `edit`
  arrive in a later milestone). The words `edit`, `pause`, `resume`, and `clear`
  are refused only when they are the *entire* argument — objectives that merely
  begin with one of them (for example "clear the lint errors") are accepted.

### Inspect the current Goal

```
/goal
```

Reports the objective, lifecycle status, identity, timestamps, revision, and the
usage fields that currently exist. Token usage and active time report
`not tracked yet` until usage accounting lands in a later milestone. When a
session with a Goal starts, restores, or reloads, a `Goal ... restored (active)`
notification confirms reconstruction.

### Model tool: `get_goal`

The model can call `get_goal` at any time to retrieve the same structured state
the command reports (or `goal: null` when no Goal is set). Use it whenever the
objective is absent or truncated in context.

## Persistence model

- Goal snapshots are stored as **custom session entries** (`goal-state`), which
  live outside the model context. The last snapshot on the active session branch
  wins, so restart, resume (`--continue` / `--session`), and extension reload
  (`/reload`, or any runtime replacement) reconstruct the state without the user
  restating the objective. Reconstruction also runs after `session_tree`
  navigation and on forked sessions; dedicated branch-navigation coverage lands
  with the branch-state ticket.
- The kickoff is delivered as a **user message** carrying the user's own
  objective (attributed as user-provided Goal data). As the session's first
  conversation entry it also makes Pi create and flush the session file, which
  Pi otherwise defers until a user/assistant message exists. The
  `goal-continuation` custom-message channel is reserved for the automatic
  continuation seam of a later milestone.
- Creation is durability-first: the snapshot is written, the kickoff triggers the
  file flush, and only after the snapshot is confirmed on disk is the Goal
  announced (and made visible to `get_goal`). If writing fails (unwritable
  session file or storage), creation reports a clear persistence error, leaves
  no Goal behind, retracts any in-memory state with a durable tombstone
  snapshot, and `/goal <objective>` can simply be retried.
- Interrupting the kickoff (Ctrl+C, killing the process, a hung model) does not
  lose the Goal: the snapshot and kickoff are already on disk and are restored
  by the next session.
- Ephemeral sessions (started with `--no-session`) cannot persist a Goal:
  creating one returns a clear error instead of claiming durable storage.
- Sessions without a Goal behave exactly as before; installing the extension
  only adds the command, the tool, and the state they manage.

## Limitations (later milestones)

- No automatic continuation after a completed run yet; the Goal persists but Pi
  stops when the initial work settles until you prompt again.
- No `edit`, `pause`, `resume`, or `clear` lifecycle commands yet (only the bare
  words are reserved as future subcommands).
- No `create_goal`/`update_goal` model tools yet; the model can only read state.
- No token budget, usage accounting, or active-time tracking yet.
- No completion or blocked audits yet.

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
`PI_GOAL_TEST_SCRIPT`, including hanging responses for interrupted-run tests),
and no network or model credentials. They assert public behavior end to end: RPC
events, extension notifications, tool results, persisted session entries, and
survival across hard kills and restarts. Set `PI_BINARY` to run against a
specific Pi binary; a missing binary fails fast instead of hanging.

### Interactive smoke test

Deterministic RPC tests are the automated gate; this manual procedure verifies
interactive installation and rendering:

```sh
cd /path/to/this/checkout
pi -e ./
# In Pi:
# 1. /goal Write a haiku about persistent sessions in a file called haiku.txt
#    -> notification "Goal ... created and activated", agent starts working.
# 2. /goal
#    -> status report with the objective, "active", revision, timestamps.
# 3. /reload
#    -> "Goal ... restored (active)" notification.
# 4. /goal
#    -> the same objective is reported after the extension reload.
# 5. Exit (Ctrl+D), then: pi -c
# 6. /goal
#    -> the Goal survives the restart and is restored on resume.
```
