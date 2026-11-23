# pi-goal-rpc-companion

Optional Codex-shaped Goal `get` / `set` / `clear` methods for
[pi-goal](https://github.com/Wade11s/pi-goal), for hosts that need an RPC-style
Goal surface.

**This package is optional.** It depends on nothing (only a peer type dependency
on Pi), never becomes a pi-goal runtime dependency, and pi-goal never depends on
it. It maps every method onto pi-goal's *user* command surface through the
documented in-process command bridge, so the single-Goal refusal, `goal.enabled`
admission, Token-budget and attachment validation, and durable-before-announced
ordering stay in pi-goal — one lifecycle, one implementation.

## Install

```sh
pi install /path/to/pi-goal/companion/goal-rpc    # local checkout
pi list                                           # pi-goal-rpc-companion
```

Install [pi-goal](https://github.com/Wade11s/pi-goal) as well; without it every
method answers `unavailable` (structured, never a crash). Remove this package at
any time with `pi remove <source>`.

## Use

One JSON request per call, over the ordinary Pi interaction surfaces (an RPC
`prompt`, a TUI keystroke, or an extension-dispatched command):

```
/goal-rpc {"version":1,"id":"1","method":"thread/goal/get"}
/goal-rpc {"version":1,"id":"2","method":"thread/goal/set","params":{"objective":"Ship the release notes","budget":40000},"authority":"external-user"}
/goal-rpc {"version":1,"id":"3","method":"thread/goal/clear","authority":"external-user"}
```

`version` is required and must be `1`, and a request carries only `version`, `id`,
`method`, `params`, and `authority`. A missing or future version, an unknown
top-level field, an unknown parameter, and an unknown method are all answered
`invalid-request` rather than ignored.

| Method | Params | pi-goal equivalent |
| --- | --- | --- |
| `thread/goal/get` | none | bare `/goal` |
| `thread/goal/set` | `objective`, `budget` (`number` \| `null`), `files`, `images` | `/goal [--budget N\|--no-budget] [--file p] [--image p] <objective>` |
| `thread/goal/clear` | none | `/goal:clear` |

Each call appends one `goal-rpc-response` session entry (published on Pi's RPC
stream as `entry_appended`):

```jsonc
{
  "version": 1,
  "id": "2",
  "method": "thread/goal/set",
  "ok": true,
  "disposition": "committed",
  "goal": { /* the get_goal projection, or null */ },
  "admissionEnabled": true,
  "transitions": [ { "kind": "created", "goal": { /* ... */ } } ],
  "diagnostics": [ { "level": "info", "text": "Goal goal_1a2b created and activated. ..." } ],
  "error": null
}
```

`ok` is true only for a durable commit (or a successful read). `error.code` is one
of `unauthorized`, `invalid-request`, `unavailable`, `refused`, `declined`,
`invalid-command`, and `error.message` carries pi-goal's own diagnostics verbatim.
`refused` is what an unfinished Goal produces for a `set`: the companion reports
the single-Goal refusal (`/goal` never replaces an unfinished Goal; use
`/goal:clear` first) exactly as the command line shows it, with the durable Goal
bytes unchanged and no dialog involved.
`invalid-command` means pi-goal said the named command was not a registered
command at dispatch time, so nothing ran.

Mutating methods require `"authority": "external-user"`: the host's assertion that
a real user action is behind the call. `"model"` is refused with a message pointing
at pi-goal's `create_goal`. This package registers **no model-callable tools**, so a
model has no path to these methods.

## Not Codex's app-server protocol

The method names are Codex-shaped for host familiarity; the envelope, transport,
response channel, and error codes are this package's own. It is **not
wire-compatible** with Codex's private in-tree app-server methods, and it does not
try to be. It also does not emulate composer drafts: `files`/`images` are explicit
local paths handed to pi-goal's attachment options.

## Limits

- A `set` against an unfinished Goal is refused by pi-goal — single-Goal creation
  (ADR-0003): one session works one Goal at a time. The answer is `refused` with
  pi-goal's own diagnostic, which names `/goal:clear`; nothing is replaced and no
  dialog is opened. A `set` against a complete Goal follows the same creation
  path as `/goal <objective>`: with `goal.clarifyOnCreate: false` or no UI it
  commits immediately and supersedes the complete record; with clarification on
  (the default) it starts the interview, answers `declined` because no Goal has
  committed yet, and the later `propose_goal` save outside the bridge performs
  the supersede.
- A `set` objective is pi-goal's to accept or refuse, exactly as if it had been
  typed after `/goal`. The lifecycle verbs are their own command names, which a
  `set` never sends, so no objective can become a pause, clear, resume, edit, or
  history request. The one shape the old space-separated spelling left — an
  objective that is the bare word `clear`, `pause`, `history`, `resume`, or
  `edit` — is refused by pi-goal itself, with its own diagnostic returned here
  verbatim as `refused` and the durable Goal bytes unchanged. An objective that
  merely *starts* with one of those words ("clear the cache", "edit the release
  notes") is created, and a leading option token is consumed by pi-goal's
  creation path just as when it is typed.
- `files`/`images` paths with whitespace are refused rather than reinterpreted
  (pi-goal's command surface has no quoting).
- `PI_GOAL_RPC_TIMEOUT_MS` bounds the wait for a pi-goal answer (default 120 s); a
  timeout is `unavailable`, never a success.
- No network, credentials, telemetry, or store access.

Full contract: [`docs/behavior/companion.md`](../../docs/behavior/companion.md).
