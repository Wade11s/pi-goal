---
name: rex-subagent
description: Delegate work to Pi subagents that run as visible Pi TUIs in Rex tabs. Use for parallel reviews, independent investigations, multi-model comparisons, delegated implementation, and steering a running agent.
---

# Rex subagents

`rex-subagent` starts a separate Pi in its own Rex tab: a real interactive TUI
with its own session, named `task — model:thinking`, highlighted by Rex while it
works. You can read its result, queue turns, and steer a running agent.

## When to use it

Use a subagent when work is independent enough to run in parallel, when a second
opinion should not share your context, or when you want to change an agent's
direction while it runs. Do the work yourself when you would only wait on one
small step.

Do not spawn more than about four agents without a concrete reason. Every agent
is a full Pi session and costs tokens.

## Spawn

Use the accounting-aware `rex_spawn` tool for normal delegation:

```json
{
  "prompt": "Review the current diff for correctness",
  "name": "review",
  "tools": "read,bash,grep,find"
}
```

Optional parameters include `cwd`, `provider`, `model`, `thinking`, `theme`,
`excludeTools`, `group`, and `batch`. The tool returns the handle and an explicit
zero usage baseline. Keep the handle: every later operation needs it.

- Agents spawned with the same `group` share one Rex session, so their tabs sit
  next to each other.
- The tab title is `task — model:thinking`; use a short, specific `name`.
- The child is an ordinary interactive Pi: it reports OSC 7501 (`working`,
  `blocked`, `done`, `error`) itself. This package never filters or disables it;
  Rex's Program Activity settings decide indicators, notifications, and sounds.
- Add `provider`, `model`, or `thinking` to override the parent's model.
- `theme` selects the child's Pi theme (default: `dark`, which keeps panel
  backgrounds in hidden tabs). Use `system` to follow terminal colors.
- Restrict a read-only investigation with `tools: "read,grep,find"`.
- The CLI spawn command remains available for diagnostics and manual runs, but
  such a run has no parent-branch baseline. Call `rex_adopt` before observing it.

## Wait and read

Completion is pull-based: a finished child does not automatically message or
wake the parent agent. After spawning, do any independent local work, then call
`rex_wait` before reporting delegated work as complete. It reconciles lifecycle
state and returns only newly observed child usage through the parent tool result.

```json
{
  "handles": ["handle-a", "handle-b"],
  "any": true,
  "timeoutMs": 600000
}
```

For several independent tasks, prefer `any: true`: it uses Rex events to return
fast finishers (and blocked/error runs) without waiting for slow siblings.
Process each returned handle, then wait again on only the remaining handles.
Every requested handle is observed for usage, including pending, timeout,
blocked, error, stopped, and exited outcomes. Use `rex_observe` with the same
`handles` array when you need a usage observation without waiting.

Widget updates and Rex notifications are for the human UI only. After `rex_wait`
returns, read each child's result with `rex-subagent logs` and verify it before
presenting it as completed work:

```sh
rex-subagent logs <handle> --tail 60
rex-subagent status <handle>
```

`wait` reports `idle`, `stopped`, `exited`, `gone`, `failed`, or `timeout`;
`--any` can also return `blocked` or `error` early. Exit 0 means every returned
result settled cleanly: `idle`, `stopped`, or `exited` with exit code 0 after
genuinely finishing its turns — the agent was idle, at least one turn ran, and
no message was left undelivered. In default all mode that includes every
requested run; `--any` omits pending handles. Blocked, error and timeout are
not success. Exit code 0 before the first turn (a closed TUI or an early crash)
is a failure, not success. An `exited` run carries the real process exit code —
believe it over any older output. A
timeout is not proof that the agent failed: check `status` and `logs` before
deciding.

Do not interrupt an agent that is still running unless the user asks for it.

The agent is a normal TUI. If it asks a question or needs permission, it shows
`blocked` in Rex; read `logs` or ask the user to look at the tab.

## Follow up and steer

```sh
rex-subagent send <handle> "Focus only on the error handling"        # next turn
rex-subagent send <handle> --steer "Stop refactoring; fix the test"  # running turn
rex-subagent send <handle> --follow-up "Then write the summary"      # after the turn
```

`--steer` (and the default while the agent is busy) injects the message into the
running turn, after its current tool calls. `--follow-up` waits until the agent
stops. A steer does not create a new turn.

`send` refuses stopped, gone or exited runs — a dead run never consumes
messages. If Rex cannot be reached, the message is still queued but marked
`unconfirmed`.

To stop an agent entirely use `rex_stop`, which aborts it. Do not try to
interrupt by sending text.

## Adopt an existing run

A pre-existing CLI-created run must be explicitly adopted before observation:

```json
{
  "handle": "existing-handle"
}
```

Call this through `rex_adopt`. Adoption records the current snapshot as the
baseline, so earlier work is not charged retroactively. Unowned and same-parent
runs can be adopted; runs owned by another parent are rejected. A root cannot
adopt its own grandchild and charge it a second time.

## Stop

```json
{
  "handle": "existing-handle",
  "remove": true
}
```

Call this through `rex_stop`. Stop every agent when its result is no longer
needed. Do not leave idle agents running. A live child publishes final usage
after the aborted turn and its tool results settle; the parent observes it
before removing records. A provably terminal retry may instead report
`finalization: "unconfirmed"` for the last non-final snapshot, or an explicit
`snapshot: "missing"` zero-observation recovery. Never treat either diagnostic
as proof of final or zero historical usage. If accounting cannot be confirmed,
the tool preserves the run records and snapshots for retry — never delete the
run directory manually to "fix" a stuck stop.

Never pass `killSession: true` unless the user asks for it: it kills the entire
Rex session, closing every sibling window in it, not just this agent. The CLI
stop and prune commands remain management operations, not accounting-aware
removal workflows.

## Return to the parent

Inside a subagent's TUI, `/back` selects the tab that spawned it. It does not
stop or close anything, and it fails with a message when the parent was not in a
Rex tab or when several Rex apps are connected.

## Rules

- CLI setup runs automatically when the parent session starts. If the command
  is unavailable, use `/rex-subagent-setup` and inspect `rex-subagent doctor`;
  preserve foreign files and follow the reported conflict instead of replacing them.
- Never spawn from inside a subagent. The guard sets `PI_REX_SUBAGENT_HANDLE`;
  only pass `allowNested: true` (or the CLI's `--allow-nested`) when the user asks
  for recursion.
- Use `rex_spawn`, `rex_wait`/`rex_observe`, and `rex_stop` for the normal
  delegation workflow. Bare CLI wait/stop/removal does not establish or advance
  the parent's accounting cursor. If a run was created through the CLI, adopt it
  first with `rex_adopt`.
- A managed child refuses session replacement, fork, and tree navigation to keep
  its cumulative accounting stream coherent; spawn a replacement run instead.
- Report which handle produced a result. Do not present a subagent's output as
  your own verification.
- Use `rex-subagent open <handle>` only when the user asks to see the tab; it
  changes which session the Rex app shows.
- Always address runs by handle. `rex-subagent` resolves the session, window and
  block ids from `metadata.json`; never run `rex window close` or `rex kill` in a
  shell loop, and never pass an empty or guessed session id — an empty id
  addresses the caller's own session.
- `list` shows this session's runs; add `--all` to see every run on the machine.
