# Goal lifecycle

Create, replace, edit, inspect, pause, resume, and clear a Goal. Every transition
is durable before it is announced.

[← README](../README.md) · See also [budgets](budgets.md) ·
[continuation](continuation.md) · [persistence](persistence.md) · [tools](../tools.md)

## Create a Goal

```
/goal Make the full test suite pass in this repository
```

- Validates the objective (3–2000 characters after trimming).
- Stores an **active** Goal as durable session state and confirms it is on disk
  before announcing success.
- Sends the objective into the model context as a user message and starts initial
  work immediately.
- When an **unfinished** Goal already exists, asks for confirmation first (see
  *Replace a Goal* below); the words `pause`, `resume`, and `clear` are
  subcommands only when they are the *entire* argument, and `edit` is a
  subcommand whenever it is the first word — objectives that merely begin with
  one of the other words (for example "clear the lint errors") are accepted.

## Replace a Goal

Setting a new objective while an unfinished Goal exists is a *replacement*: a new
Goal identity takes over the session's single Goal slot and starts at zero
Goal-owned usage. A replacement never happens silently — `/goal <objective>`
shows a confirmation dialog first, and a declined (or timed-out, or dismissed)
dialog keeps the current Goal untouched. The dialog is answered over the RPC
extension-UI subprotocol in RPC mode, so headless hosts confirm the same way an
interactive user does. Modes without any UI cannot confirm and keep the current
Goal (use `/goal clear` then `/goal <objective>` there). Replacing a **complete**
Goal asks nothing, because nothing unfinished is discarded.

The replaced Goal is not erased. Its already-accounted usage is written as a
durable **current** snapshot before the new identity commits — current, not
historical, so a crash between that write and the replacement's own snapshot
still reconstructs the old Goal — and its admission segment stays open past the
commit so a response and tool results that were already in flight are charged to
it rather than to the replacement or to nobody. That tail is frozen onto the old
identity's record as a **superseded** snapshot at the next freeze boundary — the
next delivered user message, a shutdown that keeps the session file, a new Goal
creation, a second replacement, a durability-rollback restore, or the first load
of a branch whose freeze never ran — and a tail that collected nothing new is not
written at a boundary that carries its own marker on the branch, so an idle
replacement does not grow the snapshot log. Creating a Goal is the exception: it
leaves no marker of its own, so an open admission is closed *durably* there, as a
superseded snapshot. That write is the only evidence on the branch that the
admission closed, and it is what makes the live path refuse a response that lands
after the creation exactly as the replay does, instead of one charging it to the
old identity. A replacement whose durability cannot be confirmed is retracted by
restoring the previous record: the tail is frozen onto that record first — its
entries sit before the restored snapshot, so no later replay could recover them —
and the restored identity's admission stays open, so a response that was still
streaming when the replacement was retracted is charged to it rather than dropped.
`/goal clear` of the replacement does not freeze an open tail: the
old identity's admission stays open past the tombstone so its in-flight work is
still attributed to it, and the tail freezes at the next boundary. The frozen
record is marked `superseded`, so it is loadable and replayable but never becomes
the current Goal: a crash immediately after the freeze still reconstructs the
replacement. The old identity's active-time clock stops at the replacement, its
own budget exhaustion is recorded on its own record only, and it never continues
or earns a wrap-up.

## Edit the objective

```
/goal edit Ship the release notes page instead
```

Changes the objective **in place**: the Goal keeps its identity, creation time,
and revision history (the edit is the next revision), so no usage history is
erased. If the Goal is active and a run is in flight, the new objective is
delivered into that run through Pi's steering mechanism (after the current
turn's tool calls, before the next model request), so the live work is
redirected safely instead of being interrupted; if the session is idle, editing
restarts work with a kickoff message. A paused Goal can be edited too — it stays
paused until resumed. A complete Goal is finished and cannot be edited; replace
it instead.

Bare `/goal edit` opens Pi's multi-line editor prefilled with the current
objective. Saving applies the edit in place; cancelling leaves it unchanged.
The editor is a dialog-capable UI surface: TUI and RPC hosts support it through
Pi's extension-UI subprotocol, while print/JSON mode (`ctx.hasUI` false) prints
guidance to use the typed form instead of blocking on a terminal-only dialog.
Pi's editor dialog has no timeout option, so pi-goal auto-cancels the command
after 120 seconds if the host never answers; the objective is unchanged.

## Inspect the current Goal

```
/goal
```

Reports the objective, lifecycle status, identity, timestamps, revision, the
configured token budget, the accounted token usage, the active elapsed time, and
the remaining capacity:

```
Goal goal_1a2b3c4d — active
Objective: Make the full test suite pass in this repository
Created by: the user (/goal)
Created: 2026-01-01T00:00:00.000Z
Updated: 2026-01-01T00:05:00.000Z
Revision: 0
Token budget: 250000 tokens
Token usage: 48210 tokens (input 31000, output 17000 including reasoning 4200, cache write 210;
            cached read 184300 excluded as reuse, nested 0 counted once)
Active time: 5m 12s
Remaining capacity: 201790 tokens
```

When a session with a Goal starts, restores, or reloads, a `Goal ... restored
(active)` notification confirms reconstruction.

## Status indicator

When a UI exists, pi-goal publishes a compact one-line indicator under the
`goal` status key:

```
goal_1a2b3c4d · active · 48210 tok · 201790 left · 5m 12s
```

The indicator exposes every lifecycle state — `active`, `paused`, `blocked`,
`usage_limited`, `budget_limited`, and `complete` — and is refreshed on session
start/restore, after every lifecycle transition (create, edit, pause, resume,
clear, complete, blocked, usage-limit, budget-limit), and after accounted usage.
Clearing a Goal removes the indicator. The full breakdown is always one `/goal`
away.

## The lifecycle: pause, resume, clear

Every lifecycle transition is **durable before it is announced**: Pi's
`appendEntry` writes the snapshot through to the session file synchronously, and
only a successful write is reported (a failed write keeps the previous state
and is reported as a persistence error).

```
/goal pause
/goal resume
/goal clear
```

- `/goal pause` immediately stops admission of further automatic Goal runs: the
  continuation seam only continues an `active` Goal, so whatever run is in
  flight finishes on its own and its settlement admits no continuation. Pause
  never aborts work — interrupting a run stays with the user, through Pi's
  normal abort. A paused Goal also stops accruing active time, and `/goal resume`
  restarts that clock with the work.
- `/goal resume` restarts eligible work — a **paused**, **blocked**, or
  **usage_limited** Goal, or a **budget_limited** Goal with a higher cumulative
  token budget: the transition is durable, then a resume kickoff message
  restates the objective and asks for a fresh evidence audit of the retained
  progress. Resuming while another run is in flight steers the resume message
  into it rather than waiting for idle. Resuming a `blocked` or
  `usage_limited` Goal is the user decision those stops ask for, so it keeps the
  same identity, creation time, and history, drops the audit that described the
  stop, and starts a **fresh** blocked audit: the next blocker report counts from
  one rather than inheriting the count the user just overruled. A **complete**
  Goal is terminal for its identity and is refused — replacing it is a new Goal.
  The `--budget` option is valid only for a `budget_limited` Goal; it is refused
  for `active`, `paused`, `blocked`, `usage_limited`, and `complete`, whose
  existing lifecycle behavior is unchanged.
- `/goal clear` removes the Goal from any status by writing a durable tombstone
  snapshot, so restarts and reloads cannot resurrect it, and the session returns
  to ordinary prompt-by-prompt behavior.

These commands are **usable while work is running** and never wait for the
agent to become idle — an active Goal's own continuation loop keeps Pi busy
almost continuously, so a lifecycle command that waited for idle could never
run. Pause and clear answer immediately and take effect at the next settlement;
edit, resume, and a confirmed replacement deliver their work message through
Pi's steering when a run is in flight. None of them require abandoning the
session, and none of them cancel the user's run.
