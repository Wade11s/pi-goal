# Goal lifecycle

Create, replace, edit, inspect, pause, resume, and clear a Goal. Every transition
is durable before it is announced.

[← README](../README.md) · See also [attachments](attachments.md) ·
[budgets](budgets.md) · [continuation](continuation.md) ·
[persistence](persistence.md) · [tools](../tools.md)

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

Explicit local text and image attachments use the same creation path:

```
/goal --file spec.md --image screenshot.png Ship the attached requirements
```

The repeatable leading options materialize and validate every artifact before
the snapshot commits. Disabled admission refuses the command before a
replacement dialog or materialization; plain Objective arguments stay text.
See [Objective attachments](attachments.md) for types, limits, trust framing,
and failure atomicity.

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

A replacement may select a fresh attachment manifest with leading
`--file`/`--image` options. Both identities' committed artifacts remain in the
extension-owned store, because an older selected branch may still reference
them; V1 performs no destructive automatic garbage collection.

## Edit the objective

```
/goal edit Ship the release notes page instead
```

Changes the objective **in place**: the Goal keeps its identity, creation time,
and revision history (the edit is the next revision), so no usage history is
erased. Its immutable attachment manifest is retained verbatim and re-stated
when an active Goal's edit admits work. `/goal edit --file …` and
`/goal edit --image …` are refused with guidance: changing attachments requires
a Replacement Goal. If the Goal is active and a run is in flight, the new objective is
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

While `goal.enabled` is false, editing the objective of an **active** Goal is
refused: the edit would steer a new objective into the running work, which is new
Goal work. The refusal happens before the editor dialog opens. Editing a Goal
that is already stopped (`paused`, `blocked`, `usage_limited`, `budget_limited`)
changes only durable state, so it stays available, and its notice says that no
work was started because admission is off.

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
Attachments: 2 — spec.md (text/plain, 12.4 KB); screenshot.png (image/png, 84.1 KB)
Remaining capacity: 201790 tokens
```

The `Attachments:` line is present only for a Goal with attachments and exposes
manifest metadata, never contents.

When a session with a Goal starts, restores, or reloads, a `Goal ... restored
(active)` notification confirms reconstruction. A restored **active** Goal while
the extension is disabled adds that the Goal keeps its status and keeps accruing
active time but admits no new Goal work, so an active-but-disabled Goal is never
mistaken for a continuing one.

Bare `/goal` also reports the disabled condition when `goal.enabled` is false —
an `Admission disabled:` block naming what is refused and what still works. The
block is status-aware: for an `active` Goal it adds that pausing, not disabling
the extension, is what stops the clock, while a Goal that has already stopped
says its clock is already stopped and that the refused Resume would be what
restarts it after re-enabling. The per-status resume hints follow the same rule,
so a disabled report never promises that `/goal resume` starts work.

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
Clearing a Goal removes the indicator. While `goal.enabled` is false the line
ends with `admission off`, so an active-but-disabled Goal is visible as one that
is not admitting anything. The full breakdown is always one `/goal` away.

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
  Before a resume re-sends attachments, they are loaded and authenticated once:
  the manifest size, per-file/total limits, and content hashes are checked on
  the exact bytes the resume message will carry. That load happens **before**
  the durable resume transition, so a missing or corrupt artifact refuses the
  resume with an explicit integrity error and leaves the stopped Lifecycle
  status, revision, and snapshot unchanged; `/goal resume` remains actionable
  after the artifact is repaired or the Goal is replaced.
  The `--budget` option is valid only for a `budget_limited` Goal; it is refused
  for `active`, `paused`, `blocked`, `usage_limited`, and `complete`, whose
  existing lifecycle behavior is unchanged.
- `/goal clear` removes the Goal from any status by writing a durable tombstone
  snapshot, so restarts and reloads cannot resurrect it, and the session returns
  to ordinary prompt-by-prompt behavior. Its committed attachment artifacts are
  retained for historical branches; clear is not a destructive GC operation.

## Opt-in resume prompt

```json
{ "goal": { "resumePrompt": true } }
```

`goal.resumePrompt` (Pi settings, default `false`) is convenience over the
user-owned resume, never a replacement for it. When a session start restores a
Goal whose Lifecycle status is `paused` and a dialog-capable UI exists, pi-goal
asks **once** whether to resume it.

- **Accept** runs the same durable transition as `/goal resume`: the same
  identity, creation time, objective, and accounted history, one revision
  advance, and a **fresh Blocked audit** (the audit that described the stop the
  user just overruled is dropped). The resume kickoff then restarts work exactly as
  the command would.
- **Decline, dismissal, timeout, and no UI change nothing.** The answer is
  revalidated against the exact record the dialog described, so a Goal that was
  edited, resumed, replaced, or cleared while the dialog was open is not resumed
  by a stale answer. The dialog is bounded, and its default answer is "no".
- **Only `paused` is prompted for.** `active`, `complete`, `blocked`,
  `usage_limited`, and `budget_limited` never prompt in V1: blocked and
  usage-limited recovery is an explicit user decision with its own reasoning,
  and budget-limited recovery still requires valid new headroom
  (`/goal resume --budget <new-total>`).
- **Nothing waits on the prompt.** Print and JSON modes have no dialog-capable
  UI, so nothing is asked and the notice says the Goal stays paused. In TUI and
  RPC mode the dialog is created without being awaited by the `session_start`
  handler, so the session is usable while the request is still pending and a
  headless RPC caller can ignore it entirely; the safety bound then resolves it
  to "no".
- **A disabled extension does not ask.** While `goal.enabled` is false the prompt
  cannot admit the resume it would perform, so it is not offered at all: the
  restore notice names the disabled condition and the two explicit ways forward
  (re-enable and `/goal resume`, or leave the Goal paused).

The prompt is read from Pi's effective settings at session start like the other
settings, so changing it takes effect on the next session start or reload. An
invalid value is reported once and leaves the prompt off — a configuration
mistake can never opt a user into a question they did not enable.

## Disabling the extension (`goal.enabled`)

`goal.enabled` (Pi settings, default `true`) is an **admission control**, not a
Lifecycle status and not an implicit pause. While it is false, pi-goal admits no
new Goal work:

| Refused while disabled | Why |
| --- | --- |
| `/goal <objective>` — creation **and** replacement | Both open a new Goal identity and start work. The refusal comes before the replacement confirmation and before any attachment is materialized, so no dialog or artifact promises a replacement that will not happen. |
| `create_goal` | Same admission, from the model side. The refusal reports `goal: null` (or the unchanged current Goal) and leaves the one-shot creation authority intact, so a corrected call can retry after re-enabling. |
| `/goal edit <objective>` of an **active** Goal | An edit of an active Goal steers a new objective into the running work, so it is work-admitting. |
| `/goal resume` | The resume message restarts the loop. |
| The automatic Continuation, and an owed Budget wrap-up | Both are unattended Goal work. A pending wrap-up is **deferred, not lost**: it is delivered at the first settlement after re-enabling. |
| The opt-in resume prompt (`goal.resumePrompt`) | The dialog would only offer a resume that admission refuses, so it is not opened; the restore notice says why. |

What stays available: bare `/goal` and `get_goal` (which surface the disabled
condition), `/goal pause`, `/goal clear`, and every terminal update from work
already in flight — a `budget_limited` transition, an `update_goal` completion, a
blocker report. An in-flight provider request is never aborted, and work already
queued is delivered as ordinary work rather than dropped.

Nothing is rewritten: the Goal keeps its Lifecycle status, including `active`. An
`active` Goal keeps accruing active time, because stopping that clock is a pause
rather than a host preference; a Goal that has already stopped keeps its stopped
clock. The status report and the compact indicator therefore carry the disabled
condition separately (`Admission disabled: …` / `admission off`) so an
active-but-disabled Goal is never mistaken for one that keeps continuing.

An edit of a Goal that is *already stopped* is not work-admitting — it changes
only durable state — so it stays available while disabled, and its notice says
that no work was started. Re-enabling restores admission, and an active Goal
continues only at Pi's normal settlement seam.

## Naming the session from the Objective

```json
{ "goal": { "sessionNameFromObjective": true } }
```

`goal.sessionNameFromObjective` (Pi settings, default `false`) is an opt-in
convenience: after a successful creation, pi-goal may name an otherwise unnamed
session from the Objective, so a Goal is easier to find later in a session list.

- The name is the Objective's **first line**, whitespace-collapsed and capped at
  **80 characters**. Truncation is silent — no ellipsis — because a session name is
  a label in a selector, and the Objective stays the authoritative text. Only the
  Objective text contributes: attachment contents are supporting material with
  their own trust boundary and never reach a name.
- The name is written through Pi's own seam, so it is a `session_info` entry in the
  session file. It is **host metadata, not Goal state**: it is never persisted in a
  snapshot, never reconstructed from a branch, never part of a `pi-goal:updated`
  event, and never counted in accounting. It survives a restart because Pi
  persists it.
- The write happens **after** the durable commit it describes and only while the
  session has no name, so it is gated by exactly the checks that decide whether a
  creation stands.

What it never does:

| Case | Behavior |
| --- | --- |
| The setting is absent or `false` (the default) | Nothing is read and nothing is written. A non-boolean value is reported once and ignored, which keeps sessions unnamed exactly as an unset value does. |
| The session already has a name — whether the user typed it or an earlier Goal wrote it | Left alone. A name that exists is never overwritten. |
| An Objective edit | Never renames. The edit changes the Goal in place, not the session. |
| A Replacement Goal | Never renames. A replacement is a new Goal in a session that already has Goal history, so naming it would relabel a session the user may already recognize. |
| A refused, failed, or rolled-back creation | Never names. The write sits after the durable commit, so a creation that did not stand leaves no name behind. |
| A creation cleared while it waited for the current run | Never names. The command reports that the Goal was cleared instead of claiming success, and the naming goes with the success it never had. |

A failure to write the name (a full disk, an unwritable session file) is reported
as a warning and never as a creation failure: the Goal is already durable, and the
name is metadata about the session. Both creation paths name the session —
`/goal <objective>` for a fresh creation and `create_goal`, which refuses while
any Goal exists and is therefore always a fresh one — and nothing else in the
extension ever writes a session name.

These commands are **usable while work is running** and never wait for the
agent to become idle — an active Goal's own continuation loop keeps Pi busy
almost continuously, so a lifecycle command that waited for idle could never
run. Pause and clear answer immediately and take effect at the next settlement;
edit, resume, and a confirmed replacement deliver their work message through
Pi's steering when a run is in flight. None of them require abandoning the
session, and none of them cancel the user's run.
