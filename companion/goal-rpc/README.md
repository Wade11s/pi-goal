# pi-goal-rpc-companion

Optional Codex-shaped Goal `get` / `set` / `clear` methods for
[pi-goal](https://github.com/Wade11s/pi-goal), for hosts that need an RPC-style
Goal surface.

**This package is optional.** It depends on nothing (only a peer type dependency
on Pi), never becomes a pi-goal runtime dependency, and pi-goal never depends on
it. It maps every method onto pi-goal's *user* command surface through the
documented in-process command bridge, so replacement confirmation, `goal.enabled`
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
| `thread/goal/clear` | none | `/goal clear` |

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

- A `set` against an unfinished Goal opens pi-goal's replacement confirmation; the
  call stays unanswered until the host answers the dialog (or it times out).
- A `set` objective is refused when pi-goal's command surface would read it as
  something other than a create: the subcommands `pause`/`clear`/`history`/`edit`/
  `resume`, anything led by `edit` or `resume --budget`, and anything led by
  `--budget`/`--no-budget`/`--file`/`--image`/`--remote-image`. The refusal names
  the collision and states that nothing ran, so a `set` can never clear, pause,
  resume, or edit the current Goal. An objective that merely *starts* with one of
  those words ("clear the cache") is still a create.
- `files`/`images` paths with whitespace are refused rather than reinterpreted
  (pi-goal's command surface has no quoting).
- `PI_GOAL_RPC_TIMEOUT_MS` bounds the wait for a pi-goal answer (default 120 s); a
  timeout is `unavailable`, never a success.
- No network, credentials, telemetry, or store access.

Full contract: [`docs/behavior/companion.md`](../../docs/behavior/companion.md).
