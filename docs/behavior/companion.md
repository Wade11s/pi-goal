# Host companion adapters and the Goal command bridge

An optional, independently installable companion that offers Codex-shaped Goal
`get` / `set` / `clear` methods to external consumers, and the generic in-process
bridge it is built on. pi-goal core stays free of host-specific protocols, and the
companion is never a runtime dependency of pi-goal.

[← README](../../README.md) · See also [lifecycle](lifecycle.md) ·
[persistence](persistence.md) · [events](events.md) ·
[codex migration](../codex-migration.md)

## Why a companion instead of core RPC methods

Codex exposes Goal methods through its own in-tree app-server protocol. Pi has no
equivalent host service, and inventing one inside pi-goal would make a
host-specific wire format part of the extension's public surface — a format
pi-goal would then have to keep compatible for consumers it does not control.

So the split is:

| Layer | Lives in | Responsibility |
| --- | --- | --- |
| Goal lifecycle | pi-goal core (`src/`) | The single lifecycle: parsing, the single-Goal refusal, admission, budgets, attachments, durability, events |
| Command bridge | pi-goal core (`src/command-bridge.ts`) | Runs the *same* `/goal` command an extension asks for and reports what it did, structurally |
| Goal RPC companion | `companion/goal-rpc/` (separate package) | Translates Codex-shaped methods into a Goal command family command name plus its argument text, and the answers back into its own envelope |

Removing the companion leaves pi-goal complete. Removing pi-goal leaves the
companion loaded, answering `unavailable` instead of crashing. Neither declares a
dependency on the other.

## The Goal command bridge

The bridge is a request/response pair on Pi's shared extension event bus, channel
`pi-goal:command-bridge`, version `2`:

```jsonc
// request (emitted by a consumer on the bus)
{
  "version": 2,
  "id": "caller-supplied correlation id",
  "name": "goal",            // one of goal, goal:pause, goal:resume, goal:clear, goal:history, goal:edit
  "args": "the text a user would type after the command (empty = the bare status read)",
  "reply": (result) => { /* called exactly once */ }
}
```

The request carries Pi's own dispatch shape — the command name Pi dispatches on
and the text after it — so the bridge never parses anything. A `name` outside the
Goal command family is malformed and dropped, like a bad version; a version-1
request (the old `command` string) is dropped for the same reason, so the caller's
own timeout answers `unavailable` rather than a refusal, and pi-goal logs the
upgrade diagnostic in its own console so the mismatch is visible to whoever reads
that side.

The result echoes `name` and `args` (so a caller correlates the answer with
exactly what it sent) and adds:

| Field | Meaning |
| --- | --- |
| `ok` | `true` only for `committed` and `reported`, and only when the effect is in place (and, for a mutation, durable) |
| `disposition` | `committed` · `reported` · `declined` · `refused` · `invalid` |
| `action` | Derived from `name`: `goal` with empty `args` is `status`, with any `args` it is `create`; each verb is its own action (`pause` · `resume` · `clear` · `history` · `edit`). `invalid` only for a family name that is not a registered command at dispatch time; `null` when the bridge refused the request itself |
| `goal` | The public Goal projection after the command (`get_goal`'s shape), or `null` |
| `admissionEnabled` | Whether `goal.enabled` admission was on while the command ran |
| `transitions` | The committed transitions that answer this command, in commit order |
| `diagnostics` | Everything the command reported, verbatim, with severity |

Because `action` is derived from the name and not from the argument, `/goal` with
the argument `pause` is a `create` that pi-goal's reserved-word guard *refuses*:
the answer is `refused` with pi-goal's diagnostic, never `invalid`. Nothing is
"could not parse" any more.

### It is the command, not a second lifecycle

A bridged command runs pi-goal's own command handler for that name with the same
argument text, so everything the user gets applies unchanged: an unfinished Goal
refuses creation with the same warning (and no dialog), `goal.enabled` refuses
creation before anything else, Token budgets and attachment paths are validated by
the same rules, a creation that supersedes a complete Goal preserves the old
identity's admitted work, and the kickoff is delivered through the same steering
path. The bridge adds two things only: a structured answer, and a recording wrapper
around the command's UI notifications (which still reach the user).

The bridge never reads a `goal-state` entry, never writes one, and never
touches a tombstone or a `goal-usage` checkpoint. The only writer is the store
behind the command handler.

### How `ok: true` is proved

Success is derived from the commit, never from a message:

1. A transition is recorded only when the store announces a **durable**
   transition. Refused, declined, failed, and retracted commands announce nothing.
2. A recorded transition is accepted only if it answers *this* command — creation
   accepts `created`/`replaced`, clear accepts `cleared`, and so on. A completion
   that lands while the command is still waiting (for a dialog, or for the session
   to go idle) is not the answer to that request.
3. The accepted transition must still describe the current Goal identity (or, for
   a clear, that no Goal is current) **and** its snapshot must be on disk. That is
   the same on-disk bar the command's own success announcement waits for, so a
   creation that committed in memory and then failed its durability poll is
   reported as `refused`, never as `committed`. A later legitimate transition of
   the same Goal does not undo the commit.

Diagnostics are never parsed. Their **severity** is the only signal used, and only
when nothing committed: a warning or error means `refused`; info-only means
`declined` (the user answered "no", or there was nothing to do). Rewording a
message can therefore never change a machine-readable outcome.

Because the bridge answers from the commit, the event stream and a bridge result
can differ in one honest way: a creation whose snapshot committed and whose
on-disk poll then failed is already on `pi-goal:updated` (the store's commit is
that stream's bar) while the bridge reports `refused` (the command's bar). A
consumer that needs the user-facing truth should prefer the bridge result; a
consumer that reacts to commits should keep reading the event stream.

### Guards

- **One command at a time.** A confirmation dialog can keep a command busy for
  minutes, so a second bridged command is refused immediately rather than queued,
  and the answer is `refused` (retryable — nothing ran) rather than `unavailable`
  (permanently missing).
  The alternative — overlapping dialogs and interleaved transitions — is exactly
  how "which command committed?" becomes unanswerable.
- **No session yet.** Before `session_start`, pi-goal has no session context, so
  the bridge refuses instead of running a command against nothing.
- **Validated envelopes.** A malformed request — an unknown or old `version`, a
  `name` outside the Goal command family, a non-string `args` — is dropped rather
  than guessed, because it has no trustworthy `reply`; the caller's own timeout
  covers the lost answer and pi-goal logs the refusal ("upgrade the companion or
  pi-goal" for a version mismatch) in its console; a family `name` that Pi does
  not list as a registered command at dispatch time is answered `invalid`
  without running anything.
- **No session control.** A bridged command may not start, fork, navigate, switch,
  or reload a session, and may not abort the user's run, compact its context, or
  shut Pi down. That is the whole session-control and agent/process-control
  surface Pi offers a command handler, and `/goal` uses none of it; every one of
  those methods throws a loud error from a bridged context, so a future change
  that started to reach for one would fail visibly instead of changing a user's
  session out from under an external caller.
- **Exactly one answer.** `reply` is called exactly once per request, including
  when the callback itself throws: a broken host channel is a lost answer, not a
  second attempt.

### What the bridge is *not*

It is not an authority boundary. Any loaded extension can already run
`/goal ...` by dispatching the command, and the bridge confers nothing beyond
that; it cannot verify who is calling, and does not pretend to. The
**authoritative user action is asserted by the consumer**, which is where the
next section puts its gate. Model-driven Goal creation never flows through the
bridge: that is `create_goal`, with its own creation-authority corroboration.

## The companion: `companion/goal-rpc`

An independent Pi package. It registers one extension command and no tools.

### Install

```sh
# from a checkout of this repository
pi install /path/to/pi-goal/companion/goal-rpc

# verify
pi list          # pi-goal-rpc-companion appears under User packages
```

The companion is separately removable (`pi remove <source>`) and pi-goal keeps
working without it. Install pi-goal as well for the methods to do anything —
without it they answer `unavailable`.

### Protocol

One JSON request per invocation, sent the way a host sends any Pi interaction (an
RPC `prompt`, a TUI keystroke, or an extension-dispatched command):

```
/goal-rpc {"version":1,"id":"1","method":"thread/goal/set","params":{"objective":"Ship the release notes","budget":40000},"authority":"external-user"}
```

The envelope is strict in both directions. `version` is **required** and must be
`1`; a request with no version, or any other version, is answered
`invalid-request` instead of being guessed at. Unknown top-level fields are
refused for the same reason — a field this package does not read is a field the
caller expected something to read, and ignoring it would run a different request
than the host sent while answering `ok: true`. The accepted top-level fields are
exactly `version`, `id`, `method`, `params`, and `authority`.

| Method | Params | `/goal` equivalent |
| --- | --- | --- |
| `thread/goal/get` | none | `{ "name": "goal", "args": "" }` — bare `/goal` |
| `thread/goal/set` | `objective` (required), `budget` (`number` or `null`), `files`, `images` | `{ "name": "goal", "args": "[--budget N\|--no-budget] [--file p] [--image p] <objective>" }` |
| `thread/goal/clear` | none | `{ "name": "goal:clear", "args": "" }` |

Each call appends one `goal-rpc-response` session entry, which Pi also publishes
on its RPC stream as `entry_appended`. Correlate on the echoed `id`:

```jsonc
{
  "version": 1,
  "id": "1",
  "method": "thread/goal/set",
  "ok": true,
  "disposition": "committed",
  "goal": { /* the get_goal projection, or null */ },
  "admissionEnabled": true,
  "transitions": [ { "kind": "created", "goal": { /* ... */ } } ],
  "diagnostics": [ { "level": "info", "text": "Goal goal_1a2b created and activated. Initial work started." } ],
  "error": null
}
```

`error` is non-null exactly when `ok` is false, and its `code` is one of:

| Code | Meaning |
| --- | --- |
| `unauthorized` | The mutating call did not declare `"authority":"external-user"`, or declared `"model"` |
| `invalid-request` | The envelope (including `version` and unknown fields), method, or parameters were not acceptable to the companion |
| `unavailable` | pi-goal did not answer: it is not installed (or predates the bridge), or it needed longer than the timeout. Install or upgrade pi-goal, then retry |
| `refused` | pi-goal ran the command and refused it (disabled, an unfinished Goal already set, not applicable, rolled back, ...), **or** did not run it because another bridged command was still in flight — retryable, and nothing changed |
| `declined` | pi-goal ran the command, changed nothing, and reported no problem (for example clearing when no Goal is set, or a cancelled objective editor) |
| `invalid-command` | pi-goal answered that the named command was not a registered command at dispatch time, so nothing ran |

A busy pi-goal is therefore `refused`, not `unavailable`: `unavailable` means the
call never reached a working pi-goal, while a busy bridge answered and asked for a
retry. A host that treats `refused` as retryable and `unavailable` as a
reinstall/upgrade signal gets both cases right.

`error.message` carries pi-goal's own diagnostics verbatim where pi-goal reported
some, so a host can show the real reason without a second lookup.

### A `set` cannot smuggle a lifecycle command

`set` sends `{ "name": "goal", "args": "<objective>" }` and pi-goal runs `/goal`
with that argument. An Objective is only ever the argument of `/goal` — the
lifecycle verbs are their own command names, which `set` never sends — so there
is no text a `set` could write that pi-goal would read as a pause, clear, resume,
edit, or history request. The companion therefore holds no copy of pi-goal's
parser: the one it used to keep (and its eight collision refusals) is gone.

The one case that still needs a rule is the old space-separated spelling: an
Objective that is the bare word `clear` lands after `/goal ` with a space, which
0.1.x read as the clear command. pi-goal's own creation path refuses it — *"Goal not created:
`clear` is a Goal command; use /goal:clear."* — and that refusal comes back
through the bridge as `refused` with the diagnostic verbatim and no durable Goal
write. The rule has one source of truth, and Objective rules are identical
whether the text is typed or sent over RPC: an Objective that merely *begins*
with a verb word (`clear the cache`, `history of the release`, and `edit the
release notes`) is created. A leading option token in an Objective is consumed by
pi-goal's creation path exactly as if the user had typed it.

### A `set` on an unfinished Goal is refused, not a replacement

One session works one Goal at a time (ADR-0003). `set` never replaces an unfinished
Goal: the command refuses it with a warning that names `/goal:clear`, and the
companion answers `ok: false`, `disposition: "refused"`, `error.code: "refused"`
with pi-goal's own diagnostic verbatim, the id of the Goal that was kept, and
**no** durable Goal write. There is no dialog to answer and no declined-replacement
outcome. If the current Goal is **complete**, `set` commits: it supersedes the
complete record exactly as `/goal <objective>` does.

### Creation authority

Mutating methods require `"authority": "external-user"`, which is how the embedding
host asserts that a real user action is behind the call — the same assertion Pi's
own RPC `prompt` carries when a user types `/goal`. Anything else is refused
without running a command, and `"model"` gets its own message naming
`create_goal`.

Two structural facts back that gate:

- the companion registers **no model-callable tools**, so a model has no path to
  these methods at all;
- a bridged `set` is the *user* path: the durable record says `origin: "command"`,
  and pi-goal's one-shot creation authority for `create_goal` is untouched (a
  command run by a user or a host also revokes it, exactly as `/goal` does).

The honest limit: no Pi extension can *verify* that a declared user action is
genuine. The companion therefore does not claim to enforce user intent; it refuses
non-user declarations and leaves the assertion where it belongs — with the host
that received the click, keystroke, or authenticated RPC call. A host that forwards
a model's suggestion as `external-user` is bypassing its own gate, and no adapter
can prevent that.

### Intentional differences from Codex's app-server methods

- **Not wire-compatible.** The method *names* are Codex-shaped for host
  familiarity. The envelope, transport (a Pi extension command), session-entry
  response, and error codes are this package's own; a Codex app-server client
  cannot talk to it without an adapter, and nothing here claims otherwise.
- **No streaming or subscriptions.** One request, one response entry. A host that
  wants Goal updates subscribes to `pi-goal:updated` / `pi-goal:metrics` locally.
- **A dialog can be part of a call.** Codex's `set` has no confirmation
  interaction; here an unfinished Goal requires the user's answer, so a `set` may
  stay unanswered until the host answers the dialog or the dialog times out.
- **Four methods, not a lifecycle API.** No `pause`, `resume`, `edit`, or
  separate attachment method: those stay user commands. `set` accepts local `files` and
  `images` because the command surface does, but nothing here infers a composer
  draft.
- **Path and text constraints come from the command surface.** A `files`/`images`
  path containing whitespace is refused (the command surface has no quoting). An
  Objective is not interpreted here at all: a reserved word is refused by
  pi-goal's creation path with pi-goal's own message, and a leading option token
  is consumed by pi-goal as the option the user typed.
- **The envelope is strict and versioned.** `version: 1` is required; an unknown
  version, an unknown top-level field, an unknown parameter, or an unknown method
  is refused rather than ignored.
- **Authority is declared, not provable**, as described above.

### Limits

- No hosted/network transport, no credentials, no telemetry: the companion adds no
  network code, and every test runs offline against a scripted provider.
- `PI_GOAL_RPC_TIMEOUT_MS` bounds the wait for a bridge answer (default 120 s,
  because a command can wait for a dialog or for the session to go idle). A
  timeout is `unavailable`, never a success.
- No store access, so the companion cannot describe a Goal pi-goal does not
  report. `get` returns exactly what `get_goal` would.
- A response entry that cannot be appended is reported through the ordinary
  notification channel as *unconfirmed* rather than as a success.

## Verification

| Guarantee | Test |
| --- | --- |
| Outcome classifier never claims unproven success; transition filtering; strict v2 request validation (name in the family, string args, version-1 dropped with the upgrade diagnostic); action derived from the name for all six commands; a family name not registered at dispatch time answers `invalid` and runs nothing | `test/goal56-command-bridge.test.mjs` |
| Bridged status/create/clear run the user command surface (`origin: "command"`) | `test/goal56-command-bridge.test.mjs` |
| A creation that fails its durability poll answers `refused` and writes nothing | `test/goal56-command-bridge.test.mjs` |
| Busy guard; an unfinished Goal refuses `set` with pi-goal's warning verbatim and leaves Goal bytes identical | `test/goal56-command-bridge.test.mjs` |
| No-session guard | `test/goal56-command-bridge.test.mjs` |
| Protocol constants agree; companion has no pi-goal import, dependency, or tool | `test/goal56-command-bridge.test.mjs` |
| Public-protocol get/set/clear round-trip against a real Pi RPC session | `test/goal56-goal-rpc-companion.test.mjs` |
| Replacement confirmation (decline and accept), superseded history, stale-run binding | `test/goal56-goal-rpc-companion.test.mjs` |
| Disabled admission, invalid budgets, unauthorized model creation | `test/goal56-goal-rpc-companion.test.mjs` |
| Explicit `files`/`images` reach pi-goal's attachment materialization; a whitespace path is refused | `test/goal56-goal-rpc-companion.test.mjs` |
| A reserved-word Objective is refused by pi-goal itself (`refused`, diagnostic verbatim, Goal bytes unchanged); an Objective beginning with `edit` is created | `test/goal56-goal-rpc-companion.test.mjs` |
| Envelope validation (unknown parameter, malformed JSON) answers `invalid-request`, even with no pi-goal | `test/goal56-goal-rpc-companion.test.mjs` |
| `unavailable` when pi-goal is not installed; the documented `pi install` path works standalone | `test/goal56-goal-rpc-companion.test.mjs`, `test/goal56-command-bridge.test.mjs` |
