# Model tools

`get_goal`, `create_goal`, and `update_goal`: the structured state they return,
the authority each transition requires, and the objective's trust boundary.

[← README](../README.md) · See also [lifecycle](behavior/lifecycle.md) ·
[stopping](behavior/stopping.md)

## Model tool: `get_goal`

The model can call `get_goal` at any time to retrieve the same structured state
the command reports (or `goal: null` when no Goal is set). Use it whenever the
objective is absent or truncated in context.

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
those transitions stay with the user (`/goal resume`, `/goal clear`, `/goal
<objective>`).

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

`get_goal`, `create_goal`, and `update_goal` all return the same structured
`{ goal }` payload, so status, budgets, usage, and remaining capacity are
unambiguous for programmatic callers:

```json
{
  "goal": {
    "id": "goal_1a2b3c4d",
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
    "budgetExhausted": false
  }
}
```

`remainingTokens` is `null` when the Goal has no budget and floors at zero once
the budget is reached; `budgetExhausted` is the explicit signal. The objective,
identity, origin, timestamps, and revision are part of the same payload.

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
