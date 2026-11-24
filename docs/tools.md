# Model tools

`get_goal`, `create_goal`, `update_goal`, `propose_goal`, and the opt-in
`update_plan`: the structured state they return, the authority each transition
requires, and the objective's trust boundary.

[← README](../README.md) · See also [lifecycle](behavior/lifecycle.md) ·
[attachments](behavior/attachments.md) · [stopping](behavior/stopping.md)

## Model tool: `get_goal`

The model can call `get_goal` at any time to retrieve the same structured state
the command reports (or `goal: null` when no Goal is set). Use it whenever the
objective is absent or truncated in context. The payload's `title` is the Goal's
optional one-line label (`null` when it has none), so the model can refer to the
work by the label the user confirmed. A Goal created through Objective
clarification carries the confirmed title; `create_goal`, a UI-less `/goal`, and a
`goal.clarifyOnCreate: false` creation have none until `/goal:edit --title` gives
them one.

While `goal.enabled` is false the tool's text adds an `Admission disabled:` block:
the Goal's Lifecycle status is untouched, no new Goal work is admitted, and
inspection, pause, clear, and terminal updates from in-flight work still work.
For a Goal with attachments, the text and structured state include the immutable
manifest metadata (`hash`, `mediaType`, `bytes`, `label`), never attachment
contents; the model receives those contents in the framed Goal work messages.
With no Goal set, the text says the same thing about `/goal <objective>` and
`create_goal`. The structured `{ goal }` payload is unchanged — admission is a
host preference, not Goal state, so it is never persisted in a snapshot.

## Model tool: `propose_goal`

`propose_goal` is the model's half of **Objective clarification** (ADR-0003). It
takes `{ title, objective }` — the drafted Goal title and Objective — and opens
the confirmation editor as one document: `Title: <text>`, a blank line, then the
Objective body. It is accepted **only while a pending clarification exists**: a
call from an ordinary turn is refused with the unchanged current Goal or
`goal: null` and changes nothing. When `goal.clarifyOnCreate` is false at startup,
the tool is not registered; if a later reload disables the flow while Pi retains
the first registration, calls are still refused.

The user edits either part, and **saving is the creation authority**: the
committed Goal carries exactly the saved title (one line, 1–80 characters) and
Objective (3–2000 characters), with `origin: "command"`, through the same commit
a typed `/goal` uses. The model's arguments are only the prefill. Because the
editor is the only authority on this path, a UI-capable host whose `propose_goal`
tool is unavailable refuses `/goal` outright instead of falling back to a direct
creation; a UI-less host is the one exception, and it creates directly with a
notice. *Unavailable* has three causes, and the refusal names all three rather
than asserting one: another extension already owns the name, pi-goal's
registration of it failed, or this session's tool policy (`--tools` /
`--exclude-tools`) hides the tool. See
[Tool-name ownership](#tool-name-ownership-a-host-tool-policy-is-not-a-foreign-owner). A saved
document whose first line is not the `Title:` line, or whose title breaks the
one-line rule, is refused and the same document reopens for correction instead of
discarding the user's Objective. The saved document uses the same title and
Objective validation as `/goal:edit`; the three Objective sections are **not**
validated.

Cancel, dismissal, and the standard dialog timeout all create nothing new: no
new Goal snapshot, no materialized attachment, no remote fetch, any current Goal untouched,
the pending clarification cleared, and a tool result telling the model that no
Goal was created (a legitimate outcome, so it is not an error result). The clear
is **conditional on the captured clarification still being current** and is made
durable before memory forgets it: a duplicate confirmation whose save already
committed clears nothing and reports the committed Goal, and a failed
`ended` write is surfaced as an error while the clarification stays open — it is
never reported as cleared.

A save is not the same terminal record as a cancel. The confirmed document is
written durably as a **`confirming`** state *before* the creation commit, and the
terminal `ended` state is written only after the Goal commits. A commit that fails
(budget, a stale Goal, an attachment, a fetch, a session write) or a process that
dies mid-fetch therefore leaves the confirmed draft and the held
`--budget`/`--no-budget` and `--file`/`--image`/`--remote-image` flags recoverable:
the next `propose_goal` call reopens the editor with the user's saved draft, and
the retry commits it. Those flags resolve and materialize only inside that commit,
so nothing is read or fetched until a save is under way.

The pending clarification is **durable** and branch-scoped. A graceful or unclean
restart (and a reload, fork/clone, or branch selection that keeps the entry)
reconstructs it, so the same conversation can still call `propose_goal` and
commit, with the raw idea and flags unchanged and nothing read or fetched by the
reconstruction. Bare `/goal` names the open clarification and the flags it is
holding, and a recovered confirmation says its draft is kept. The entry records
the **base Goal identity** it was started against: a Goal created, replaced, or
cleared afterwards supersedes the draft (even after a crash that lost the
retirement write, and even if that Goal later completes), so a stale draft can
never overwrite a Goal the user chose in the meantime. Restoration and
confirmation fail closed while the branch's newest Goal snapshot is unreadable,
and while `goal.clarifyOnCreate` is off, `propose_goal` is not pi-goal's own tool
in force, or the host has no dialog-capable UI — every one of those seams re-reads
the registry instead of trusting the session-start answer. An unreadable newest clarification
entry also fails closed rather than reviving an older one. A **new `/goal <idea>`
replaces** the pending clarification: the new idea and flags win, the interview
starts over, nothing was created for the abandoned idea, and a save from the
replaced editor is refused because the captured clarification is no longer
current — it neither commits nor clears the newer one.

The model-facing description and prompt guidelines carry the drafting template as
a **convention**: `Objective:` (one sentence stating what is different when the
work is done), `Constraints:` (hard limits, `None` when empty), and
`Acceptance criteria:` (numbered, each independently verifiable with its
verification method named). With title and Objective stored as plain Goal text,
the existing Completion audit enforces the criteria with no new audit machinery.

`propose_goal` is also where the session's **single-Goal rule** meets the model:
an unfinished Goal refuses `/goal` before any clarification starts, so the tool
is never called for a creation the command path would reject. A **complete** Goal
does not block; the save commits the new identity and supersedes the complete
record without a second replacement-confirmation dialog. `create_goal` remains
outside this flow: it never clarifies, never sets a title, and still refuses
while any Goal exists.

## Model tool: `create_goal`

`create_goal` lets the model create a Goal, but only for an **explicit user or
system request**, corroborated at execution time. The tool description and its
prompt guidelines say so, and nothing in the extension infers a Goal from an
ordinary task. It validates the objective, refuses an ephemeral session that
could not restore the Goal, refuses while this session already has a Goal
(including when two calls arrive in the same assistant turn), and persists the
snapshot before reporting success. Creating a Goal through the tool does not
send a kickoff message: the model is already mid-run, and the continuation seam
picks the Goal up at the next settlement.

`create_goal` is deliberately **text-only**. It has no file, image, path, or URL
parameters, and extra drifted fields do not gain attachment authority. It also
creates a **title-less** Goal: a title is a label the user confirms in an
Objective clarification or sets with `/goal:edit --title`, never a model-supplied
extra field. Explicit local and remote attachments can be selected only by the
user-entered `/goal --file … --image … --remote-image …` command at fresh or
complete-to-new creation (held until confirmation when clarification is on).
Remote URLs are fetched only there, once, so a model cannot turn a
quoted prompt or an unquoted URL into network material. The existing 3–2000
character Objective validation is unchanged; long supporting material belongs in
a direct text attachment, not in a model-created Objective.

Because it refuses while any Goal exists, a successful `create_goal` is always a
fresh creation, so it is also the tool-side path for the opt-in session name: with
`goal.sessionNameFromObjective` enabled it names an otherwise unnamed session
from the Objective, exactly like `/goal <objective>`. A refused, failed, or
rolled-back creation reports no Goal and names nothing. The name is not part of
the tool result and not part of any Goal-updated event — see
[lifecycle](behavior/lifecycle.md#naming-the-session-from-the-goal-title-or-objective).

The command path is deliberately different in two places. `/goal <objective>`
clarifies by default (ADR-0003), and it may supersede a **complete** Goal, though
never an **unfinished** one: that refusal names `/goal:clear` and happens before
any clarification, dialog, or `propose_goal` call. `create_goal` does neither —
no clarification, no title, and no replacement of any Goal.

While `goal.enabled` is false the tool is refused before anything is validated:
the result is an error carrying the unchanged current Goal (or `goal: null`), and
the one-shot creation authority is left intact, so a corrected call can retry once
the setting is re-enabled.

### Creation authority

`create_goal` requires `user_request`: the exact words of the explicit
Goal-creation request, quoted verbatim. The extension checks the quote against
**one currently authoritative source** — the raw interactive/RPC user input
that started the current execution, or a Pi custom message (any `customType`).
Skill/template expansion and other transformed prompt text are not evidence,
and an extension calling `pi.sendUserMessage()` never acquires human-user
authority through that API. Standing system-prompt instructions do not
authorize a specific Goal.

The quote must be the complete affirmative instruction, not a keyword or a
convenient fragment. Matching is **case-sensitive** and permits only
whitespace-folding differences; a paraphrase is not evidence. The rules are
conservative and deterministic: an express request to create, set, or start a
Goal. Ordinary work, mere mentions, questions, hypotheticals, negations, and
requests merely to keep working do not qualify. Intent is evaluated in clause
order, so a later explicit correction may supersede an earlier negation, while
a later cancellation or negation supersedes the quoted request. Ambiguity fails
closed, and a fragment cannot be lifted out of a negated sentence. The
objective remains model-written and need not repeat the quotation.

Authority belongs to the execution started by the request and survives later
model turns, Pi retries, compaction, and overflow recovery inside it. A newer
interactive/RPC user message or Pi custom message replaces it, even when
unrelated. Settlement, session restart, branch navigation, a successful Goal
creation, and direct Goal lifecycle operations clear it. Authority is
one-shot: a successful creation consumes it, while a rejection leaves it valid
so a corrected call can retry.

A missing, forged, stale, non-explicit, or ambiguous quote is refused with a
tool error carrying `goal: null` and no Goal state is created or mutated. The
refusal opens no interactive confirmation (including in headless/RPC hosts) and
starts no Goal, Continuation, or admitted Goal work. Evidence is checked only
at execution time: snapshots retain `origin: "tool"` and gain no persisted
quotation, source-message id, or reusable authorization marker. The direct
`/goal <objective>` path is unchanged and needs no quotation.

## Model tool: `update_plan`

`update_plan` is the opt-in structured progress plan (`goal.planTool`, default
`false`). It takes one argument — `plan`, an ordered array of `{ step, status }`
where `status` is `pending`, `in_progress`, or `completed` — and replaces any
previous plan wholesale. At most one step may be `in_progress`; a list of 1–20
steps with step text of 1–200 characters is accepted, and anything else is
refused with the rule that was broken.

```json
{
  "plan": {
    "steps": [
      { "step": "Write the failing test", "status": "completed" },
      { "step": "Implement the plan tool", "status": "in_progress" },
      { "step": "Document the tool", "status": "pending" }
    ],
    "counts": { "total": 3, "completed": 1, "inProgress": 1, "pending": 1 }
  }
}
```

That object is the whole result: the tool returns it as both `structuredContent`
and `details`, and Pi persists the tool result — including its `details` — on the
session branch. So the plan's durability is the ordinary tool result, which
survives a restart and is visible to the model in its own context, and there is
no second Goal record: no `goal-state` entry, no revision, and no
`pi-goal:updated` event. A later plan becomes the newest record on the branch and
leaves the earlier one in place as history.

What the tool deliberately does **not** do:

- **It never mutates the Lifecycle.** Nothing in its execution path reaches the
  Goal store, so a plan call cannot complete, pause, block, or budget-limit a
  Goal. A plan that marks every step `completed` leaves the Goal active, and the
  result text says so — a model that has just finished its own list is exactly
  the one that might otherwise read it as a finished Goal.
- **It cannot satisfy or bypass the Completion audit.** Completion remains
  `update_goal` with `complete`, after every requirement of the objective is
  verified by current-state evidence. A plan is narration about what the model
  intends, never evidence that it happened.
- **It performs no model work**, so it reports no usage of its own. Its turn is
  charged by the ordinary accounting path like any other Goal turn, and it counts
  as activity for the anti-loop counters like any other tool call.
- **It never replaces another extension's tool.** If `update_plan` is already
  registered by someone else, pi-goal registers nothing, reports why, and no
  Continuation names the tool. The same ownership rule and the same wording cover
  `propose_goal` — see
  [Tool-name ownership](#tool-name-ownership-a-host-tool-policy-is-not-a-foreign-owner).

Refusals — no Goal set, a second `in_progress` step, an empty or over-long step,
an unknown status, a malformed argument — return an error result with **no**
`details` payload, so the durable plan on a branch is only ever a successful tool
result. A call in a session with no Goal is refused because there is no progress
for a plan to describe and no Continuation that would ever show it.

While the setting is off the tool does not exist: it is not declared to the model,
and Pi refuses a call to it before any extension runs.

## Tool-name ownership: a host tool policy is not a foreign owner

Pi's tool registry is keyed by name across every loaded extension, and
`getAllTools()` returns only the tools the session's `--tools` allowlist and
`--exclude-tools` denylist admit. So a tool missing from that list is ambiguous:
it is as consistent with "this session hides it" as with "nobody registered it".
Both registrations pi-goal performs — `propose_goal` and the opt-in `update_plan`
— therefore decide ownership from what *this runtime* registered, never by
inferring pi-goal's own identity from a particular Goal tool, and they share one
rule and one set of warnings so the two cannot drift apart.

Ownership is decided **before** anything is registered, so pi-goal never replaces
another extension's tool:

| What the registry shows | Outcome |
| --- | --- |
| no tool of that name | the name is free; pi-goal registers it |
| a tool of that name this runtime has not registered | **foreign**; pi-goal registers nothing and says so |
| a tool of that name this runtime registered, from another source | **verified takeover**; pi-goal registers nothing and keeps refusing |
| the registry cannot be read | **unverifiable**; pi-goal registers nothing with a cause-neutral warning |

The registration is then **confirmed rather than assumed**, and every outcome says
what actually happened:

| Outcome | Startup | What `/goal` and the Continuation do |
| --- | --- | --- |
| **owned** — pi-goal's own declaration is in force | silent | the tool is promised |
| **verified takeover** — another extension's declaration displaced it | a warning naming the takeover | `/goal` refuses; no Continuation names a plan tool |
| **hidden** — the registration landed but the session's tool policy keeps the tool out of the model's reach | **silent** | `/goal` refuses with cause-neutral wording; no Continuation names a plan tool |
| **unverifiable** — pi-goal cannot confirm its own declaration is in force | a cause-neutral warning | `/goal` refuses |

Two rules follow from the table, and both are behaviour changes from 0.3.0:

- **A session that hides only `get_goal` but admits `propose_goal` now runs the
  clarification flow** instead of refusing. The old guard read pi-goal's own
  identity out of `get_goal`, so any session that filtered that one tool — the
  documented read-only review-child profile in `docs/agents/subagents.md` is the
  common case — was told another extension owned `propose_goal` and was refused.
  The profile's tool lists are unchanged; only the false notice is gone.
- **A session whose policy hides `propose_goal` itself still refuses**, because
  the confirmation editor is the only creation authority on that path. Its
  refusal now names all three causes instead of asserting one, so a user who
  filtered the tool themselves is not sent hunting for a phantom extension.

Everything except **owned** is fail-closed: not knowing costs a convenience,
while replacing another extension's tool costs that extension its tool. A
registration that the session's policy hides is nobody's fault, so it is silent
at startup and explained at the seam that needs it.

## The objective's trust boundary

The objective is the one part of a Goal message the extension does not author. A
`create_goal` objective is model-written text, and Pi flattens a custom message
into a plain user-role LLM message (dropping `customType`), so the model cannot
tell extension instructions from objective text by channel alone. Interpolating
it raw would let an objective carrying forged `Evidence audit` or `Completion
contract` sections impersonate the contract.

So every Goal message renders the objective as **delimited, encoded data**:

- the objective is reproduced verbatim but encoded by `encodeObjectiveData()`:
  `JSON.stringify` plus an explicit escape of `<`, `>`, U+0085, U+2028, and
  U+2029. `JSON.stringify` alone is not enough — it leaves those characters raw,
  so a literal sentinel would survive encoding and a Unicode line separator would
  split the single data line. The result is still a valid JSON string literal, so
  the objective round-trips byte for byte and stays readable to the model;
- it is wrapped in `>>> BEGIN GOAL OBJECTIVE DATA (nonce …) >>>` and
  `<<< END GOAL OBJECTIVE DATA (nonce …) <<<` sentinels whose nonce is random per
  message, so a sentinel copied from any other message cannot close this block;
- it is preceded by an explicit statement that it is data about what was asked
  for, not an instruction from Pi or from this extension;
- every authoritative instruction (the evidence audit, the completion contract)
  sits **after** the data block.

A regression test drives all of it at once: an objective containing forged
`Evidence audit` / `Completion contract` / `INSTRUCTIONS FROM PI-GOAL` headings,
literal begin and end sentinels, and U+2028/U+2029/U+0085 separators. It asserts
that the objective round-trips exactly, that no sentinel character or Unicode
separator survives in the data line, and that outside the data line the message
contains exactly one of each sentinel and each authoritative heading.

The canonical objective is always available unframed through `get_goal` and in
the structured tool results, and the record carries its `origin` (`command` for
`/goal`, `tool` for `create_goal`).

Text attachments use the same encoding and random-nonce boundary in separate
`GOAL ATTACHMENT DATA` blocks; images travel as Pi image content blocks and are
also identified as untrusted data by label and manifest hash. Neither kind can
rewrite the extension-authored audit or completion instructions. See
[Objective attachments](behavior/attachments.md#the-trust-boundary).

## Model tool: `update_goal`

`update_goal` supports three actions. `complete` is the completion contract: the
model calls it with `{ action: "complete" }` only after every explicit
requirement of the objective is verified against current-state evidence, and a
complete Goal never continues again, including after a restart or reload.

`pause` is accepted **only after an explicit user request**. The call must
quote the user's exact words — `{ action: "pause", userRequest: "please pause
the goal" }` — and the extension corroborates the quote against the most recent
human-authored user messages on the session branch. The quote must appear
verbatim and must name pausing; the clause containing it must be an affirmative
instruction to pause (an imperative or a direct request such as "please pause",
"can you pause", "I want you to pause", or "the goal should be paused"). A
negated instruction ("do not pause the goal", including a trailing "do not"
anywhere in the same message), a whole negated sentence quoted verbatim, a
keep-working or resume instruction, a deferral ("pause, not now"), a mere
mention, an unrelated verb ("park the car" is not pausing the Goal), and a
common word such as "the" are all refused. A newer human message that contradicts
the request supersedes it.

A missing quote, a paraphrase, a quote the user never wrote, or a quote that
only appears inside pi-goal's own messages (the kickoff, steering, and resume
messages, or an objective's encoded data block — a forged objective cannot
authorize its own pause) is refused, and the Goal keeps running. The model
cannot resume, clear, replace, or budget-limit a Goal through the tool at all:
those transitions stay with the user (`/goal:resume`, `/goal:clear`, `/goal
<objective>`).

None of the three actions is an admission decision, so all of them keep working
while `goal.enabled` is false: a run that was already in flight when the extension
was disabled can still complete a Goal, report a blocker, or pause it, and every
successful result carries the disabled condition in its text — including a blocker
report below the audit threshold, which otherwise reads as a Goal that stays
active — so the model does not read the Goal as one that will keep continuing.
The condition follows the status the update leaves: a paused or blocked result
names the refused `/goal:resume` that re-enabling makes available again, while a
completion says the Goal is terminal either way so that replacing it is a new
`/goal <objective>` and not a resume.

`blocked` is the blocker contract. The model calls it with
`{ action: "blocked", blocker: "…" }` — plus `blocker_id` on every later report of
the same condition — while the same genuine blocker persists across consecutive
Goal turns. `complete` and `blocked` are both terminal: the Goal is persisted as
`complete` or `blocked` and never continues again, including after a restart or
reload. Any other action (`resume`, `clear`, a usage-limit or budget-limit
transition) is refused with an explanation, because those transitions stay with
the user.

The extension, not the model, decides when the blocked audit is satisfied, and it
decides it by **identity**, never by wording:

- the first valid report of a condition omits `blocker_id`; pi-goal issues and
  persists an opaque **Blocker identity** together with the latest
  plain-language description and count;
- a later report of the same condition passes that identity back verbatim in
  `blocker_id`, so a reworded description or a changed next step still advances
  the audit;
- omitting `blocker_id` reports a genuinely different condition: it replaces the
  open audit with a fresh identity and count one, and the old chain can never
  resume;
- an identity the extension did not issue for the currently open audit is refused
  without Goal mutation, and the refusal does not own the turn, so a corrected
  call in the same turn records the turn's first valid report;
- there is no free-text normalization, similarity, or hashing anywhere in the
  decision. The model judges semantic equivalence by choosing whether to reuse
  the identity; the extension alone enforces identity, consecutiveness, and the
  threshold. Incorrect reuse can merge different blockers, while an omitted
  identity can split one condition and delay stopping — the latter is the safer
  direction.

On top of that:

- a report is recorded per **Goal turn**, so several calls inside one turn count
  once and cannot satisfy the threshold on their own;
- the chain is **consecutive**: a Goal turn that makes progress, verifies a wait,
  or reports no blocker breaks it, and the count starts again;
- below the threshold the report is persisted and refused with the current count
  and the open audit's identity, which is what keeps a transient failure from
  stopping useful work while telling the model exactly how to report the same
  condition next turn. Both the audit and every break in it are durable, so
  compaction neither hands the model three fresh turns nor resurrects a chain it
  already invalidated, and bare `/goal` after a restart still reports the blocker
  and its count. A prompt the user sends after a restart is itself a user action,
  so it starts a fresh audit.

Every model-side transition is bound to the Goal **identity** the execution that
proposed it was admitted against, not to whatever Goal exists when the call
finally runs. A run's follow-up provider turns are prepared against the context
that run started with plus its tool results, so a `complete`, `blocked`, or
`pause` proposed in a follow-up turn of a run whose Goal the user cleared or
replaced while it was in flight is refused with the current state instead of
being applied to a Goal the model never saw — no mutation, no extra revision, no
newly admitted work, and the new Goal's kickoff and Continuations are untouched.
A **revision** change inside the same execution is still accepted, for two
different reasons: an edit or a resume (including a budget raise) of an active
Goal delivers or steers the revised state into the running work, so the model
has seen it, while an un-steered change — a user pause, a `budget_limited`
transition, or a blocker reaching the threshold — leaves the Goal in a
non-active status whose gate refuses the model's transitions anyway. A
transition in a run Pi starts to retry the one before it (a failed provider
request, or a response compaction recovered) is accepted because that run is the
same execution. A new execution — a kickoff, a Continuation, a resume, or a
prompt the user types — is admitted against the Goal that is current when it
starts.

A report needs a binding too. `blocked` is refused exactly like `complete` and
`pause` when the execution holds no Goal binding, so an ordinary prompt whose
turn started before `/goal <objective>` landed cannot record a blocker against a
Goal the model never saw. A run whose own `create_goal` built the Goal is bound
to it at its next turn, because the tool result is what showed the model that
Goal.

Structured `update_goal` and `get_goal` responses expose the open audit's current
identity, latest description, and count, and every Continuation restates them
while an audit is open. Tool descriptions and guidelines require a report on every
Goal turn a genuine blocker persists — never a wait until the threshold is
satisfied. The human-facing status shows the description and the count; the
opaque identity says nothing useful there and is not displayed.

## Structured tool responses

`get_goal`, `create_goal`, `propose_goal`, and `update_goal` all return the same
structured `{ goal }` payload, so status, budgets, usage, and remaining capacity
are unambiguous for programmatic callers. `propose_goal` uses it for the committed
Goal and for its refusals and cancellations (where it is the unchanged current
Goal or `null`), so a confirmation never invents a second result shape. The
opt-in `update_plan` returns a `{ plan }` payload of its own (see above), which is
deliberately *not* a Goal payload: nothing in it is Goal state.

```json
{
  "goal": {
    "id": "goal_1a2b3c4d",
    "title": "Release prep",
    "status": "active",
    "blocker": "the upstream release API token has not been issued yet",
    "blockerId": "blocker_9f2c1a77",
    "blockedTurns": 2,
    "tokenBudget": 250000,
    "usage": {
      "totalTokens": 48210,
      "inputTokens": 31000,
      "outputTokens": 17000,
      "cacheWriteTokens": 210,
      "cachedReadTokens": 184300,
      "reasoningTokens": 4200,
      "nestedTokens": 0,
      "activeSeconds": 312
    },
    "remainingTokens": 201790,
    "attachments": [
      {
        "hash": "1b4f0e9851971998e732078544c96b36c3d01cedf7caa332359d6f1d835670",
        "mediaType": "text/plain",
        "bytes": 12400,
        "label": "spec.md"
      }
    ],
    "budgetExhausted": false
  }
}
```

`remainingTokens` is `null` when the Goal has no budget and floors at zero once
the budget is reached; `budgetExhausted` is the explicit signal. `attachments`
is `[]` without attachments and otherwise contains metadata only, in immutable
manifest order. The objective, title, identity, origin, timestamps, and revision
are part of the same payload; `title` is `null` rather than omitted when the Goal
has none. The title is label text under the Objective's privacy boundary: it is
in the payload and the status report, and it is never in Goal-updated events,
`goal-history` records, or metrics.

While a blocked audit is open, the same payload carries its **Blocker identity**
(`blockerId`), the latest plain-language `blocker`, and `blockedTurns`, and
`get_goal`'s text repeats the identity so the model can pass it back verbatim in
`update_goal`'s `blocker_id`. The human-facing status deliberately shows only the
description and the count.

### `update_goal`'s completion usage report

A **budgeted** Goal's successful completion adds one field to that result, so the
final response can state what the work cost without another provider request:

```json
{
  "goal": { "id": "goal_1a2b3c4d", "status": "complete", "tokenBudget": 250000, "remainingTokens": 201790, "...": "..." },
  "completionReport": {
    "instruction": "This budgeted Goal is complete. Your final response must report the cost and duration of the work: 48210 accounted tokens of the 250000-token Token budget, 201790 tokens of remaining capacity, and 5m 12s of Active elapsed time. ...",
    "accountedTokens": 48210,
    "activeSeconds": 312,
    "tokenBudget": 250000,
    "remainingTokens": 201790,
    "accountingNotes": ["..."]
  }
}
```

`instruction` is the exact wording the final response must follow, and it is also
appended to the tool result's text content so the model acts on it. The numeric
fields let a programmatic caller read the same facts without parsing prose. See
[budgets](behavior/budgets.md#completion-usage-report) for the accounting
approximations the notes carry.

The report is present only on a successful **budgeted** completion. An
unbudgeted Goal, a refusal, and every other `update_goal` action keep the plain
`{ goal }` payload, so no result ever claims a budget or a remaining capacity
the Goal does not have.

## No model tool for the audit history

The durable audit history (see [behavior/history.md](behavior/history.md)) is
deliberately **not** a model tool. `get_goal` is the model's authoritative view of
the current Goal, and the history is derived diagnostic data: exposing it as a tool
would invite the model to treat a past record as present state — to reason from a
revision that has since moved, or to expect a record to be replayed. The timeline
is therefore a user-facing surface only, rendered read-only by `/goal:history`,
and no tool, command, or option mutates a Goal from a record.
