# ADR-0002: The Goal command family is colon-namespaced

- Status: accepted
- Date: 2026-11-23
- Relates to: [Codex `/goal` migration status](../codex-migration.md), the
  "Goal command family", "Goal command bridge", and "Goal RPC companion" entries
  in `GLOSSARY.md`

## Context

Codex spells its user lifecycle controls as space-separated subcommands of one
command: `/goal`, `/goal pause`, `/goal resume`, `/goal clear`. pi-goal 0.1.x
ported that spelling. Pi dispatches an extension command by the text before the
first space only, so every one of those spellings reached the same handler with
the rest of the line as a free-text argument, and the handler had to decide from
the text alone whether it was looking at a lifecycle action or at an Objective.

That decision needed rules, and the rules had costs. `pause`, `resume`, `clear`,
and `history` were subcommands only when they were the *entire* argument;
`edit` was a subcommand whenever it was the *first* word, so an Objective that
began with it (`/goal Edit the README …`) was silently applied as an Objective
edit of the current Goal instead of creating one, and no Objective starting with
"edit" could be typed at all. `resume <anything else>` kept a pre-repair meaning
as an Objective. The RPC companion had to mirror the parser so that a `set` whose
Objective was the single word `clear` could not render `/goal clear` and clear
the Goal. None of that complexity bought anything a user could see; it existed to
make one command name carry six meanings.

Pi already has a namespace convention for exactly this: `/skill:name` is a
separate registered command per skill, and duplicate registrations are told
apart with the same punctuation (`/review:1`). Every registered command is
listed on its own line in the `/` menu with its own description.

## Decision

The Goal command family is six separately registered commands that share the
`goal` namespace: `/goal` (create with an Objective, inspect without one) and
`/goal:pause`, `/goal:resume` (`--budget` unchanged), `/goal:clear`,
`/goal:history`, `/goal:edit`. There is no `/goal:status` and no `/goal:create`:
bare `/goal` already is the status report and `/goal <objective>` already is the
creation.

1. **The old spellings are refused, not aliased.** The `/goal` creation path
   refuses an argument whose trimmed, case-insensitive form is exactly one of
   `pause`, `resume`, `clear`, `history`, `edit`, or begins with
   `resume --budget`, and points at the verb: "Goal not created: `pause` is a
   Goal command; use /goal:pause." Everything else is an Objective, so
   `Clear the lint errors`, `Edit the README`, and `Resume work on X` create
   Goals. The guard exists so that Codex muscle memory is corrected once instead
   of silently creating a Goal named "resume"; it is the only trace of the old
   spelling in the code. `create_goal` has no such guard: it is text-only and has
   its own authority check, so there is no command ambiguity to resolve.
2. **The verb commands take no arguments**, except `/goal:resume --budget` and
   `/goal:edit <objective>`; anything else is a usage error that touches no Goal.
   `/goal:edit` keeps both of today's forms: bare opens the prefilled editor
   dialog, with an argument it is the typed edit for headless and dialog-less
   hosts.
3. **The command bridge carries Pi's own dispatch shape.** A request is
   `{ version: 2, id, name, args, reply }` — the command name and the text after
   it — instead of "the text after `/goal`". The result echoes `name` and `args`
   in place of `command`; the dispositions (`committed`, `reported`, `declined`,
   `refused`, `invalid`) are unchanged, and `invalid` is only a `name` outside
   the family.
4. **The companion no longer mirrors the parser.** Its `set` sends
   `{ name: "goal", args: <objective> }` and pi-goal's own refusal comes back
   through the bridge as `refused` with the diagnostic verbatim. A `set` can no
   more smuggle a lifecycle command than a typed Objective can, because an
   Objective is only ever the argument of `/goal`.

### Considered options

- **Keep the space-separated subcommands** (the Codex spelling). Rejected: the
  ambiguity is inherent to one name carrying six meanings, and the rules that
  resolve it are the complexity above.
- **Register the colon commands and keep the space forms as aliases.** Rejected:
  two spellings live in the documentation forever, the ambiguity and the
  companion's mirror guard stay, and nobody who types the old form is ever told
  the new one.
- **Hard-break with no guard.** Rejected: `/goal edit` would create a Goal named
  "edit" — three characters, valid — and `/goal resume` would create one named
  "resume" and start working on it. That is worse than a usage error.
- **`/goal.edit` instead of `/goal:edit`.** Rejected: Pi's own namespace
  punctuation is `:`; `.` would introduce a second convention for no gain.

## Consequences

- **Spelling parity with Codex is dropped; capability parity is kept.** The
  migration table says so explicitly. A Codex user gets one refusal with the
  right spelling in it, not a silent misbehaviour.
- An Objective can never be read as a lifecycle action, so the "entire argument"
  and "first word" rules, the `resume <other>` legacy branch, and the companion's
  mirror parser all disappear. `parseGoalCommand` reduces to "empty means status,
  otherwise create", and the bridge's action is the command name.
- The `/` menu grows from one entry to six, each self-describing; argument
  completion for the creation flags (`/goal `) and for `--budget`
  (`/goal:resume `) closes the other half of discoverability.
- The bridge version bump is a breaking change for the only consumer, the
  optional companion, which is bumped with it. The model-facing tool descriptions
  and guidelines change by exactly the spelling, nothing else.
- The reserved-word guard is permanent. It is small, it is tested for every word
  and both `--budget` spellings, and it is the one place a future reader will
  find the old syntax — which is why this record exists.
