# pi-rex-subagent

Pi subagents that live in Rex terminal windows. Each agent is a **normal
interactive Pi TUI** in its own Rex tab, plus a small extension that delivers
messages from a file inbox. The Rex app shows the session, the tab title, and a
working/finished highlight without any extra tooling.

Planned replacement for `pi-subagent`'s tmux backend; both can coexist.

## Ask your Pi to install it

Copy the prompt below and send it to your Pi — it will check Rex first and
then install the package:

```text
Install the pi-rex-subagent extension for me:

1. Check the prerequisites first, and stop with a clear report if any fail:
   - `rex whoami` answers and reports a unix:// endpoint (Rex server running locally)
   - Node 22.19+ and the `pi` CLI are on PATH
2. Install the package:
     pi install git:github.com/Wade11s/pi-rex-subagent@main
3. Reload Pi so the extension and skill load. The extension automatically
   creates and validates the managed CLI symlink on session start; do not
   create a skill symlink.
4. If setup reports a conflict, preserve the existing file and show me the
   report instead of overwriting it. Use `/rex-subagent-setup` to re-check.
5. Verify that `rex-subagent version` works and `rex-subagent doctor` reports
   both the Rex server and setup status.
```

## What you get

| Need | How it works |
| --- | --- |
| Parallel agents | One Rex session per `--group`, one window per agent; they are tabs, so the Rex app can show and tile them |
| Visible agent | The tab runs the real Pi TUI; you can watch, type, or press ctrl+c yourself |
| Title | Tab label and Pi session name: `task — model:thinking` |
| Program status | Pi reports OSC 7501 natively (`working`, `blocked`, `done`, `error`); nothing in this package filters it, so Rex's Program Activity settings decide indicator, notification, badge, and sound |
| Model override | `--provider/--model/--thinking` map to Pi flags |
| Follow-up turns | `send <handle> "text"` starts the next turn on the same session |
| Steer a running turn | `send <handle> --steer "text"` injects into the running agent |
| Result | `wait` reports the turn count; once the OS process has ended it reports the real exit code; `logs` renders the session transcript |
| Usage accounting | Parent tools return durable child Usage deltas and branch-local cursors through Pi's standard tool results |
| Survival | Rex owns the process, so agents keep running when Pi quits |
| Isolation | `--tools`, `--exclude-tools`, `--no-extensions`, `--no-skills`, `--no-context-files`, `--no-mcp` |

## Requirements

- Pi with Node 22.19 or newer
- A running local Rex server (`rex whoami` must answer over a unix socket)
- `pi` on `PATH` (or `--pi /absolute/path`)

Remote Rex servers are refused on purpose: a subagent must not land on another
machine by accident.

## Install

```sh
pi install git:github.com/Wade11s/pi-rex-subagent@main
```

Restart Pi or run `/reload`. Pi loads the extension and skill from the package.
On the first `session_start`, the extension creates
`~/.pi/agent/bin/rex-subagent` and checks that its directory is on `PATH`.
No skill symlink or build step is needed. Custom Agent directories selected
with `PI_CODING_AGENT_DIR` are respected.

Setup is idempotent and runs again on startup, so package updates only need:

```sh
pi update --extensions
```

Reload or restart Pi to load the updated code; there is no manual setup step.
The managed state in `~/.pi/agent/.rex-subagent-setup.json` lets setup repair a
link left dangling by an updated or removed package path.

To inspect or repair the installation manually:

```sh
rex-subagent setup --json
rex-subagent doctor --json
```

Inside Pi, `/rex-subagent-setup` performs the same check. Setup runs a CLI
health check only when it creates or repairs the link.

### Setup safety

- Missing links are created; current links are left untouched.
- Links from older `pi-rex-subagent` checkouts can be adopted and repaired.
- Regular files, directories and foreign symlinks are never overwritten.
- The package identity, CLI interpreter and executable bit are validated.
- Link replacement uses a temporary symlink and atomic rename; concurrent
  first-time setup converges without exposing a partial link.
- A missing `PATH` entry is reported, but shell startup files are not modified.
- Legacy clone and skill resources are reported so two installations cannot
  silently keep reloading and reclaiming the link.

### Migrate from clone-first installation

Keep the old checkout if it contains work you need, and move it out of
`~/.pi/agent/extensions` so Pi cannot auto-discover it. Verify the old Skill
symlink target before removing that symlink; the package now supplies the
Skill directly. The old CLI symlink may remain in place: setup recognizes the
exact legacy target and safely repairs it even when the old checkout is gone.

Then install with `pi install` and `/reload`. Review any migration warnings
with `/rex-subagent-setup`. A legacy checkout is never deleted automatically.

For development, a clone under `~/.pi/agent/extensions` is still supported;
update it with `git pull` and `/reload`. Do not keep that clone enabled while
also using `pi install` for the same package.

After `pi remove`, Pi cannot run an extension uninstall hook. Remove the
managed CLI symlink and `.rex-subagent-setup.json` as well if they are no
longer needed, after verifying that the link belongs to this package.

## Use

```sh
# one agent
rex-subagent spawn --name review --prompt "Review the current diff independently"

# three models on the same task, tabs in one Rex session
rex-subagent spawn --name review --model anthropic/claude-sonnet-4 --prompt "..."
rex-subagent spawn --name review --model xai/grok-4.7 --thinking high --prompt "..."
rex-subagent spawn --name review --model magpie/workbuddy/deepseek-v4.1-flash --prompt "..."

rex-subagent list
rex-subagent wait <handle>... --for 10m
rex-subagent logs <handle> --tail 40

rex-subagent send <handle> "Now summarise only the blocking issues"
rex-subagent send <handle> --steer "Stop refactoring; fix the failing test"
rex-subagent send <handle> --follow-up "Then open a PR"

rex-subagent open <handle>   # show the tab in a connected Rex app
rex-subagent stop <handle> --remove
# DANGER: --kill-session kills the WHOLE Rex session, taking every sibling
# window in it down with the agent. Only use it when you own every window.

# inside the subagent's own TUI:
/back                        # return to the tab that spawned it
```

Tabs are titled `task — model:thinking`, so three runs of the same task stay
distinguishable:

```
review — claude-sonnet-4
review — grok-4.7:high
review — deepseek-v4.1-flash
```

Children use Pi's fixed `dark` theme by default, so tool and message panel
backgrounds do not depend on terminal color replies that Rex may not provide
for hidden tabs. Pass `--theme <name>` to select another Pi theme, or `--theme
system` to restore terminal-adaptive colors.

Every command accepts `--json`. Exit codes: `0` ok, `1` failure or wait
timeout, `2` usage, `3` Rex unavailable.

### Incremental waits

Default `wait <handle>...` keeps its all-settled behavior. When handling several
independent issues, use `--any` to process fast finishers without waiting for a
slow sibling:

```sh
rex-subagent wait A B C D --any --for 10m --json
# Read and verify each returned handle, then wait on the remaining handles.
rex-subagent logs A --tail 60
```

`--any` returns all results discovered by that reconciliation pass and omits
handles that are still pending. It also returns `blocked` and `error` early so
the caller can inspect the run; neither is a successful completion.

For this mode, one `rex events` subscription per involved Rex session listens
for Pi's OSC 7501 status reports and terminal `child_exited` events. Events only
trigger reconciliation: the existing record/status/probe state machine still
decides the result, including inbox and exit-code checks. A 2-second snapshot
fallback covers missed events, unavailable streams and disconnections. The
events wake the waiting CLI command; they do not push a message into the parent
Pi session.

`spawn --env KEY=VALUE` (repeatable) exports extra variables into the child.
The child environment is minimal by design — it inherits only `PATH`, `HOME`
and `PI_CODING_AGENT_DIR` — so anything else the task needs (tokens, config
locations) must be passed explicitly with `--env`.

`send` refuses runs that are `stopped`, `gone` or `exited`: nothing would ever
consume the message. When Rex cannot be reached to confirm the process, the
message is still queued and the result reports `unconfirmed: true`.

### Delivery semantics

The child is an interactive Pi, so delivery reuses Pi's own semantics.

| Message | Agent idle | Agent running |
| --- | --- | --- |
| `send` (default) | starts a new turn | steering message: delivered after the current tool calls, before the next model call |
| `--steer` | starts a new turn | same as the default, stated explicitly |
| `--follow-up` | starts a new turn | delivered only after the agent stops |

`wait` reports the delivered-message count and, once the OS process has ended,
its real exit code (from Rex, not from the child). A steer joins the running
turn instead of creating a new one. `wait` resolves each handle as one of:

| Outcome | Meaning | exit code contribution |
| --- | --- | --- |
| `idle` | queued turns finished, agent alive | 0 |
| `stopped` | stopped on purpose | 0 |
| `exited` | the OS process ended | 0 only when it exited `0` after finishing its turns: agent idle, at least one turn ran, nothing left queued |
| `gone` / `failed` | run is no longer manageable | 1 |
| `blocked` | `--any`: Pi is waiting for permission, a question or authentication | 1 |
| `error` | `--any`: Pi reported an error; inspect the run | 1 |
| `timeout` | deadline passed | 1 |

A run that dies before its first turn or mid-turn resolves as `exited` with the
real exit code instead of hanging until the timeout. A run whose stop was
requested but not yet completed shows `stopping`: it becomes `stopped` only
once the process really ended or Rex confirmed the close.

## Usage accounting

Use `rex_spawn`, `rex_wait`/`rex_observe`, and `rex_stop` for the normal parent
delegation flow. These tools bridge the child's independent Pi session into the
parent's standard tool-result `usage` and `details`: only the newly observed
Usage delta is returned, while durable per-run cursors survive parent restart
and selected-branch replay. Use `rex_adopt` before observing a pre-existing
CLI-created run.

The child atomically publishes cumulative `usage.json` snapshots from its
selected Pi session branch. Assistant, nested tool-result, compaction, and
branch-summary usage are included; standalone cache-warming entries are not.
Accounting-aware live stop collects the final snapshot before removing records.
A provably terminal retry can instead retain an explicit unconfirmed non-final
or missing-snapshot diagnostic without inventing usage. Malformed, regressed,
conflicting, negative, or generation-changing snapshots
fail closed instead of being clamped or re-baselined.

See [Usage accounting](docs/usage-accounting.md) for the snapshot schema,
transaction and ownership rules, adoption and nested delegation, finalization,
and the observation-time V1 limitation for Goal consumers.

## How a run is laid out

```
~/.pi/agent/rex-subagents/<handle>/
  metadata.json     pinned endpoint + host id + session/window/block ids + title
  .accounting-owner.json
                    atomic durable adoption owner claim; created at most once
  child.sh          exports the run env, then execs the Pi TUI
  inbox/NNNN.json   {"message":"...","delivery":"auto|steer|followUp"}
  inbox/.seq        monotonic message counter
  inbox/.lock       held while a sender allocates the next index
  status.json       {"state":"starting|busy|idle|stopped","turn":N,"transport":"tui"}
  usage.json        cumulative selected-branch Usage, generation, sequence, final marker
  sessions/         the child Pi session JSONL; `logs` renders it
  stop              sentinel: the child aborts, publishes final usage, and shuts down
  child.err.log     delivery diagnostics
```

`spawn` writes the record, the launcher and the first message *before* creating
the Rex window, so a launch either leaves a readable record or a failed one with
the error. Status comes from two sources: the pinned Rex probe proves the process
is alive, `status.json` (written by the child extension) proves whether a turn is
running. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine,
terminal-state definitions, message-delivery semantics and the concurrency
contracts (inbox locking, confirmed stops, probe batching).

`status.json` is written by the child extension and describes only the current
turn; it carries no exit code (older versions wrote a misleading `lastExit: 0`,
which is ignored now). Exit codes come from the Rex probe once the process ends.

## Program status is Pi's

The child is an ordinary interactive Pi, so it reports the full OSC 7501 sequence
on its own: `working` during a run, `blocked` while a dialog waits for the user,
then `done` or `error`, with the session name as the message.

This package does not filter, delay, or disable those reports. Rex maps them to
tab indicators, system notifications, Dock badges, and sounds, each configured
globally under **Settings → Notifications → Program Activity**. If subagents
should be quieter or louder, change those Rex settings; a per-session mute does
not exist.

```
none → idle → working → done      final: {"state":"done","msg":"<title>"}
```

When stopping or renaming, always address the session and window ids from
`metadata.json`. Never loop over `rex window ls -s ""` or an unset variable: an
empty session id addresses the caller's own session.

## Returning to the parent

`spawn` records where the parent Pi was running (`REX_SESSION` / `REX_BLOCK`,
resolved to a window id) in `metadata.json` under `parentRex`. The child then
offers:

```
/back   # ask the connected Rex app to select the parent tab
```

Requirements and failure modes:

- The parent must have been running inside a Rex tab. Spawning from a plain
  terminal records no `parentRex`, and `/back` says so.
- Exactly one Rex app must be connected. With several, `/back` refuses to guess
  and names them; use `rex-subagent open <handle> --client <id>` from the CLI.
- `/back` only changes which session/tab the app shows. It does not close,
  stop, or restart anything.

## Steering: what Pi already provides

The tmux subagent runs an interactive child with its own extension, which polls
an inbox and calls `pi.sendUserMessage(message, { deliverAs: "steer" | "followUp" })`.
This project keeps that design — the child is a TUI — but owns the extension:
`src/child.ts` is loaded with `-e`, polls `<run>/inbox` every 200 ms, and writes
`status.json`. Steer and follow-up therefore have exactly Pi's semantics.

Highlighting needs no code from us: Pi's interactive mode already reports OSC 7501
(working / done / error) with the session name as the message. Because `spawn`
sets `--name "<task> — <model>:<thinking>"`, Rex shows:

- a spinner on the tab while the agent works (unfocused tabs),
- an indicator in the session picker once a result is ready,
- the same string as the tab label and the Pi session name.

Nothing is written to the terminal from the extension, so the TUI is untouched.

## Behaviour that differs from tmux subagents

- **Nothing is suspended when Pi exits.** The Rex window keeps running; resume
  management does not exist because it is not needed.
- **Nesting is refused.** A child sets `PI_REX_SUBAGENT_HANDLE`; spawning from
  inside it fails unless `--allow-nested` is passed.
- **The agent's TUI is not attached.** It runs in its own tab; `open` asks a
  connected Rex app to show that tab.
- **Interrupt ≠ steer.** To stop work entirely use `stop` (the child aborts), or
  press ctrl+c in the Rex tab.
- **The first turn waits ~0.5 s** so the TUI has initialized before the run
  starts; without that delay Pi's status reporter can miss `working`.

## Tests

```sh
npm test          # deterministic tests, no Rex server or LLM needed
npm run typecheck # tsc on src (strict) and tests
npm run test:live # opt-in: real Rex server, real Pi TUI turns (costs API calls)
```

- `tests/child.test.ts` drives the real child extension through a fake Pi API:
  delivery, steering, follow-ups, stop, `/back`, and unreadable inbox files.
- `tests/cli.test.ts` runs the real CLI end to end against
  `tests/fixtures/fake-rex.mjs`, including the generated launcher and titles.
- `tests/session-log.test.ts` covers the transcript rendering used by `logs`,
  including tail reads of long sessions.
- `tests/record.test.ts` covers the state machine and inbox concurrency
  (in-process and cross-process).

## Verified manually

- Plain titles: a spawned run's window label stayed
  `<task> — <model>:<thinking>` while busy and after settling (`rex session inspect`).
- Program status: a run reported `none → idle → working → done` and ended on
  `{"state":"done","msg":"<title>"}` — the full Pi sequence, untouched.
- `/back`: the exact calls the child makes (`client ls`, then
  `do session.select session_id=… window_id=…`) both exited 0 against the live
  server; `/back` itself is covered by unit tests with a fake `rex`.
- Event wait: a no-LLM synthetic terminal emitted OSC 7501 `done` and
  `wait --any` returned `idle` before its deliberately slow 4 s fallback. A
  separate early-exit fixture returned `child_exited` with the real exit code.
- Steer: an agent told to `sleep 20` then reply `DONE` replied `STEERED` instead,
  and the session transcript contained no `DONE` answer.
- `rex-subagent open` / `session.select` with Remote Control enabled switched the
  Rex app to the agent's tab.
- Stop while busy: the Rex session disappeared and no child process leaked.

## Known limits

- macOS in practice: the launcher assumes `/bin/sh` and absolute paths.
- `status` costs one Rex probe per run; the Pi widget reads only local files to
  avoid probing on every tick, so it can briefly show a stale state for a run
  that just died.
- A `stop` that cannot be confirmed keeps the record with a `stopError` so it
  can be retried; the CLI exits 1 in that case.
- Nothing restarts a dead run: `exited`, `gone`, `stopped` and `failed` are
  terminal. Spawn a new run instead.
