# Token budgets and budget exhaustion

Per-Goal budgets, the extension-level default and hard maximum, raising a budget
after exhaustion, and the single bounded wrap-up a `budget_limited` Goal earns
per episode.

[← README](../README.md) · See also [accounting](accounting.md) ·
[lifecycle](lifecycle.md)

## Token budgets

A Goal can carry a token budget that bounds unattended model usage:

```
/goal --budget 250000 Make the full test suite pass in this repository
/goal --no-budget Make the full test suite pass in this repository
```

- `--budget <n>` (or `--budget=<n>`) sets an explicit per-Goal budget. It is only
  recognized as a *leading* flag, so an objective that merely contains the word
  `--budget` is never truncated.
- `--no-budget` asks for an unbounded Goal. It is honoured only when **no**
  `goal.maxTokenBudget` is configured; with a maximum configured it is refused,
  because it would create exactly the Goal the configuration forbids.
- With no flag, the extension-level default applies, and when only a maximum is
  configured the maximum is the bound — so a session that configures a maximum
  never gets an unbounded Goal by omission.
- `create_goal` accepts the same budget as an optional `tokenBudget` argument.

A `budget_limited` Goal can be resumed only by raising its **cumulative**
ceiling:

```
/goal resume --budget 500000
/goal resume --budget=500000
```

- The new value is the Goal's new absolute total, not an increment and not a
  fresh allowance. All Goal-owned usage already accounted — including overshoot
  and every admitted wrap-up — stays charged against it, so the value must be
  strictly greater than the current `usage.totalTokens` and is refused otherwise
  (no-headroom resumes are rejected rather than resuming into an immediate stop).
- The configured `goal.maxTokenBudget` remains a hard cap: a value above it is
  refused, never clamped. `goal.defaultTokenBudget` is never implicit resume
  authority; a bare `/goal resume` of a `budget_limited` Goal is refused with
  guidance to supply a new total.
- A successful raise is one durable transition: it preserves the identity,
  creation time, origin, objective, and complete usage history, sets the new
  ceiling and `active`, cancels any pending old-episode wrap-up, advances the
  revision exactly once, starts a fresh active-time segment, and commits before
  any resumed work message is admitted.
- `/goal edit <objective>` stays independent: it preserves `budget_limited` and
  admits no substantive Goal work. To change both, edit first and then resume
  with the new budget. There is no combined edit-and-resume command.

Extension-level defaults live in Pi's settings (agent-directory or project):

```json
{
  "goal": {
    "defaultTokenBudget": 250000,
    "maxTokenBudget": 1000000
  }
}
```

- `goal.defaultTokenBudget` is applied to every new Goal that does not ask for an
  explicit budget.
- `goal.maxTokenBudget` is a **hard** bound that constrains every path: an
  explicit budget above it is refused with an error (never clamped), a default
  above it is clamped to it (the maximum is the safety bound, so it always wins),
  and an unbounded Goal cannot be created while it is set. All three facts are
  reported as a warning notification when the session starts.
- Invalid values (not whole numbers of at least 1 token) are dropped and reported
  rather than silently coerced.

When the accounted usage reaches the budget, the Goal transitions to
`budget_limited` (see *Budget exhaustion* below).

## Budget exhaustion

Reaching the token budget is **not** completion:

1. The Goal transitions to `budget_limited`, its active-time clock stops, and a
   warning notification reports the accounted usage against the budget.
2. Substantive continuation stops. At the next settlement of a *completed* run,
   exactly one bounded wrap-up is requested on its own `goal-budget-wrapup`
   custom-message channel: a concise summary of verified progress, remaining work,
   blockers, and the single next useful action, with an explicit statement that
   the budget ran out and the objective was not verified complete, and an explicit
   instruction not to call `update_goal`.
3. The budget boundary and the wrap-up are both *enforced*, not merely requested.
   The same gate blocks and terminates every tool call while it is armed (Pi's
   documented mechanism for stopping after the current tool batch), so a model that
   reaches for a tool gets a refusal instead of an execution and the run ends after
   that response: no substantive work, no additional model turn, no side effects.
   It is armed the moment the budget is crossed — so the rest of *that* run cannot
   work — and again for the wrap-up run, and it is cleared only at final settlement,
   because Pi's `agent_end` is explicitly not final: retry backoff, final-attempt
   recovery, and compaction retries all happen after it, so a retried wrap-up stays
   gated. A genuine user turn disarms the gate immediately, so steering during a
   gated run keeps its tools; while disarmed the gate returns nothing at all, so
   other extensions' `tool_call` decisions are untouched.
4. After that one response the Goal never continues again — including after a
   restart, because the pending-wrap-up flag is durable. Later usage is still
   accounted, so remaining capacity keeps being reported (floored at zero).

One bounded wrap-up is owed **per budget-exhaustion episode**, not per Goal
lifetime. A valid `/goal resume --budget <new-total>` cancels an undelivered
wrap-up; if the old wrap-up is already in flight, its admitted usage stays
charged, the old budget gate lifts only after the new ceiling is durably
authorized, and no second old-budget wrap-up is sent. If the resumed work later
exhausts the new ceiling — including immediately, when already-admitted
in-flight usage crosses it — the Goal becomes `budget_limited` again and earns
exactly one fresh wrap-up. Editing the objective without resuming does not
cancel an owed wrap-up; an undelivered wrap-up uses the latest durable
objective, and an in-flight or completed wrap-up is never duplicated by an edit.

A disabled extension (`goal.enabled: false`) defers an owed wrap-up instead of
delivering it, because the wrap-up is unattended Goal work. The pending-wrap-up
flag is durable, so nothing is lost: the wrap-up is delivered at the first
settlement after the setting is re-enabled, exactly once.

Raising the budget or changing the objective is a user decision; a
`budget_limited` Goal is resumed with `/goal resume --budget <new-total>`.

## Completion usage report

Completing a Goal with a Token budget also reports what it cost. The structured
`update_goal` result of that one call carries a `completionReport` next to the
usual `{ goal }` payload, and the model-visible result text repeats its
`instruction`:

```json
{
  "goal": { "id": "goal_1a2b3c4d", "status": "complete", "tokenBudget": 250000, "...": "..." },
  "completionReport": {
    "instruction": "This budgeted Goal is complete. Your final response must report the cost and duration of the work: 48210 accounted tokens of the 250000-token Token budget, 201790 tokens of remaining capacity, and 5m 12s of Active elapsed time. ...",
    "accountedTokens": 48210,
    "activeSeconds": 312,
    "tokenBudget": 250000,
    "remainingTokens": 201790,
    "accountingNotes": ["Accounted tokens are pi-goal's accounting approximation, ...", "..."]
  }
}
```

- It is built from the completion snapshot the extension just wrote — the same
  accounted tokens, Active elapsed time, Token budget, and remaining capacity
  every other surface reports — so the reminder needs **no additional provider
  request** and changes no completion or accounting behavior. The completing
  run's own follow-up response is where the model states the report.
- `remainingTokens` floors at zero, exactly like every other remaining-capacity
  surface.
- The approximations travel with the numbers, single-sourced into
  `accountingNotes` and repeated in `instruction`: the accounted total is
  `input + output + cacheWrite` under Pi's usage semantics (cached reads
  excluded as reuse, reasoning already inside output, nested usage counted once),
  and Active elapsed time counts live-session time in whole seconds, excluding
  non-active statuses and process downtime. Nothing describes the total as
  invoice-exact: it is pi-goal's accounting rule applied to what Pi reports, and
  provider billing is not reconciled.
- An **unbudgeted** Goal completes exactly as before: the result carries the
  `{ goal }` payload and no `completionReport`, so it never claims a budget or a
  remaining capacity it does not have.
- A Goal completed by an automatic Continuation reports the same way; the report
  is attached to whichever `update_goal` call completed it.
