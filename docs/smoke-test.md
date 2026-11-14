# Real-Pi interactive smoke test

This procedure verifies the user-facing package against a real Pi process: the
documented installation workflow, Goal creation, automatic continuation,
interactive objective editing, pause, resume, status reporting, restart
persistence, and clear. It is a manual complement to the deterministic RPC suite
(`npm test`), which remains the automated gate.

## Prerequisites

- Pi **1.5.1 or newer** on `PATH` (`pi --version`).
- A checkout of this repository.
- A configured Pi model provider for the interactive steps (the smoke test needs
  real model responses). The deterministic RPC tests need no credentials.

## 1. Install the package

From the checkout:

```sh
cd /path/to/pi-goal
pi install ./            # personal settings (~/.pi/agent/settings.json)
# or, for a project:
pi install --local ./    # .pi/settings.json, after project trust
```

Confirm Pi recorded it:

```sh
pi list
```

Expect the checkout path under **User packages** (or **Project packages** for
`--local`). To try it without installing, use `pi -e ./` instead.

## 2. Start Pi

```sh
pi
```

The extension registers `/goal`, `get_goal`, `create_goal`, and `update_goal`.
When a UI exists, the footer/status bar shows a compact Goal indicator as soon as
a Goal exists.

## 3. Create a Goal

```
/goal Write a haiku about persistent sessions in a file called haiku.txt
```

Expect:

- a `Goal ... created and activated` notification;
- the status indicator `goal_<id> · active · <tokens> tok · <remaining> left · <active time>`;
- the agent starts working immediately.

## 4. Inspect status

```
/goal
```

Expect the full report: objective, `active` status, identity, timestamps,
revision, token budget, accounted token usage, active time, and remaining
capacity. The compact footer indicator shows the same status and usage.

## 5. Watch automatic continuation

Let the agent finish a turn. With the Goal still `active`, Pi continues on its
own at the safe settlement boundary. The continuation restates the objective and
asks for an evidence audit. `/goal` still reports `active`.

## 6. Edit the objective interactively

```
/goal edit
```

Pi opens a multi-line editor prefilled with the current objective. Change it to:

```
Write the haiku and a limerick about steering
```

Save and exit. Expect an `objective updated` notification, the status indicator
stays `active`, and the running work is steered to the new objective. Cancelling
the editor leaves the objective unchanged.

## 7. Pause

```
/goal pause
```

Expect a `Goal ... paused` notification and the status indicator changes to
`paused`. The turn already in flight finishes safely; no further automatic Goal
run starts.

## 8. Inspect the paused Goal

```
/goal
```

Expect `paused` with the paused-state hint line.

## 9. Resume

```
/goal resume
```

Expect a `Goal ... resumed` notification, the status indicator returns to
`active`, and work restarts from retained progress with a fresh blocked audit.

## 10. Replacement confirmation

```
/goal Write a sonnet instead
```

Expect a confirmation dialog describing the current Goal. Answer **No**. Expect
`Replacement cancelled` and the current Goal unchanged. Answer **Yes** on a
second attempt and the old Goal is replaced by a new identity.

## 11. Restart persistence

Exit Pi (Ctrl+D), then resume the session:

```sh
pi -c
```

Expect a `Goal ... restored (active)` notification and `/goal` reporting the same
objective, revision history, accounted usage, and active time.

## 12. Clear

```
/goal clear
/goal
```

Expect `Goal ... cleared`, the status indicator disappears, and the second
command reports `No Goal is set in this session.`

## 13. Verify the tombstone

```
/reload
/goal
```

Expect no `restored` notification and `No Goal is set in this session.` The
durable tombstone prevents a cleared Goal from being resurrected.

## 14. Optional: budget exhaustion and cumulative recovery

```
/goal --budget 1 Write a haiku
```

Expect the Goal to be created, the next accounted turn to exhaust the budget, a
warning notification, exactly one bounded wrap-up summary, and the status
indicator showing `budget_limited`. Budget exhaustion is never reported as
completion.

A `budget_limited` Goal is resumed only by raising its cumulative ceiling. Run
the commands below in order, while the Goal is still `budget_limited`:

```
/goal resume
/goal resume --budget 1
/goal resume --budget=500
```

- The bare resume is refused with guidance to supply a new total
  (`/goal resume --budget <new-total>`).
- A value at or below the current usage is refused with the no-positive-headroom
  reason, and the Goal stays `budget_limited`. `--budget 1` is always such a
  value here: the Goal was created with `--budget 1`, so its usage has already
  reached that total.
- A value above the configured `goal.maxTokenBudget` is refused, never clamped,
  and the Goal also stays `budget_limited`. With `"maxTokenBudget": 100000` set
  in Pi settings, `/goal resume --budget=200000` shows the refusal; without a
  configured maximum no raise is refused on that ground.
- `--budget=500` — the `=` spelling, on a still-`budget_limited` Goal — is the
  successful raise. It sets the absolute ceiling to 500 tokens and the Goal
  becomes `active`. `/goal` shows the full prior usage still accounted against
  the new ceiling (never reset or discounted).
- A further `--budget` after a successful raise (for example `--budget=250`
  tried out of habit) is refused for status, not for headroom or maximum:
  "the `--budget` option only resumes a budget_limited Goal". Use a bare
  `/goal resume`, which reports the Goal already active, or let the resumed work
  exhaust the new ceiling first so the Goal is `budget_limited` again.
- The pending old-episode wrap-up is cancelled by a valid raise. If the resumed
  work later exhausts the new ceiling, the Goal is `budget_limited` again and
  another raise — either spelling — resumes it; exactly one fresh wrap-up is
  delivered for that new exhaustion episode.
- `/goal edit <objective>` without a resume preserves `budget_limited` and does
  not cancel an owed wrap-up; edit first, then resume with the new budget.

## 15. Optional: RPC / headless check

The deterministic suite already drives `pi --mode rpc` with the package loaded
and asserts the same command surface, the editor dialog over the extension-UI
subprotocol, and the headless no-UI guard. To try it manually:

```sh
pi --mode rpc -e ./
```

A host that implements the RPC extension-UI subprotocol can answer the
`/goal edit` editor dialog; a host without a dialog-capable UI receives guidance
to use `/goal edit <objective>` instead of a blocking terminal dialog.

## 16. Optional: blocker identity and the blocked audit

With an active Goal, ask the model to report a genuine blocker on three
consecutive Goal turns, using the identity pi-goal issues.

- The first `update_goal { action: "blocked", blocker: "..." }` report omits
  `blocker_id`. pi-goal records it, refuses it with `Blocker recorded (1 of 3
  consecutive Goal turns)`, and publishes the opaque **Blocker identity** in the
  structured result and in `get_goal`.
- Every later report of the *same* condition passes that identity back verbatim:
  `update_goal { action: "blocked", blocker: "<reworded>", blocker_id:
  "blocker_..." }`. Rewording alone never advances the audit — pi-goal never
  compares blocker text.
- Omitting `blocker_id` reports a genuinely different condition and starts a new
  chain at one with a fresh identity; an identity the extension did not issue for
  the currently open audit is refused without changing the Goal.
- Several reports inside one Goal turn are one audit step. Only the third
  *consecutive* Goal turn moves the Goal to `blocked`; a turn that makes progress,
  verifies a wait, or reports nothing breaks the chain, and so does any user
  action, a resume, or a Replacement Goal.
- `/goal` shows the blocker description and the `Blocked audit: N of 3` count. It
  deliberately does not show the opaque identity.
- `/goal resume` after the stop restarts the Goal with a fresh audit.

## 17. Optional: legacy 0.1.0 cutover

Resume a session that was created by pi-goal 0.1.0 with the repaired version
installed. Expect:

- a `Goal ... restored (...)` notification, and no agent run started by the load
  itself;
- the Goal's **legacy reconstructed totals** reported by `/goal` — the 0.1.0
  baseline, not exact Goal-owned attribution rebuilt under the repaired rules;
- a durable `goal-cutover` marker in the session entries (inspect the session
  `.jsonl`) and a repaired snapshot immediately after the legacy one;
- the Goal continues under the repaired attribution: ordinary prompts are not
  charged, only kickoff/edit/resume/Continuation/wrap-up work is;
- if the 0.1.0 snapshot carried a valid open audit (a structurally valid count of
  one or two), its description and count are preserved and a fresh opaque Blocker
  identity is issued and persisted in the same cutover transition. The next report
  of that condition must reuse the identity to advance; omitting it starts a fresh
  chain at one. The handoff grants no extra unattended turns and changes no reset
  rule — the first user prompt is still a user action that starts a fresh audit.

## 18. Optional: model-tool creation authority

`create_goal` creates a Goal only from an explicit request, corroborated at
execution time. With no Goal set, type a request that expressly asks for a Goal:

```
Please create a Goal for writing the release notes
```

Expect the model to call `create_goal` with `user_request` quoting your words
verbatim, and a `Goal ... created and activated` notification. The objective the
model writes need not repeat your quotation.

Then try the negative controls:

- ask the model to create a Goal **without** an explicit request (for example
  "work on the release notes") and it must refuse with `goal: null`, change
  nothing, and start no continuation;
- send a newer message that does not ask for a Goal, then have the model quote
  the earlier request: the newer message replaces the authority, so the call is
  refused;
- use `/goal <objective>` directly: it still creates a Goal with no quotation.

## 19. Optional: blocked and usage_limited active time

Active elapsed time must stop at *every* non-active status. The deterministic
regressions `test/goal34-active-time-stop.test.mjs` (a real `pi --mode rpc`
blocked Goal, idle time, an ordinary run, and a restart) and
`test/goal34-active-time-stop-store.test.mjs` (the `usage_limited` stop, the
conservative stop, and a reconstruction) pin the exact frozen values.

To check it by hand with a real provider, drive a Goal to `blocked` (section
16), then run `/goal` twice a few seconds apart: the `Active time` value must
not change while the Goal is `blocked`. Restart Pi and run `/goal` again: the
value must still be the frozen one. `usage_limited` needs a real provider
usage-limit error, so the deterministic store/RPC regressions are the practical
verification for that status.

## Checklist

- [ ] Installed with `pi install ./` and visible in `pi list`.
- [ ] `/goal <objective>` creates an active Goal and starts work.
- [ ] The status indicator and bare `/goal` report `active`.
- [ ] An active Goal continues automatically after a turn.
- [ ] Bare `/goal edit` opens a prefilled editor and applies the edit.
- [ ] `/goal pause` changes status to `paused` and stops continuation.
- [ ] `/goal resume` changes status back to `active` and restarts work.
- [ ] `/goal resume --budget <new-total>` resumes a `budget_limited` Goal with a
      higher cumulative ceiling, and the `--budget=` spelling works.
- [ ] A bare `/goal resume` of a `budget_limited` Goal, a no-headroom raise, and
      a raise above `goal.maxTokenBudget` are all refused with guidance.
- [ ] `/goal clear` removes the Goal and the status indicator.
- [ ] The Goal survives a restart with its usage intact.
- [ ] `/reload` after a clear does not resurrect the Goal.
- [ ] A legacy 0.1.0 session loads without work, is cut over once, and reports its
      legacy reconstructed totals.
- [ ] A blocker reported on three consecutive Goal turns, identified by the
      Blocker identity pi-goal issues, moves the Goal to `blocked`; reworded
      reports that reuse the identity advance the audit and an omitted identity
      starts a fresh chain.
- [ ] A legacy open audit is preserved with its description and count and is issued
      a fresh Blocker identity at cutover, granting no extra unattended turns.
- [ ] A `blocked` Goal's `Active time` is frozen across idle time and a restart,
      and the `usage_limited` freeze is covered by the deterministic regressions.
- [ ] `create_goal` succeeds only for a verbatim, affirmative, currently
      authoritative request, and refuses forged, stale, negated, hypothetical,
      question-shaped, non-explicit, and wrong-source quotations with
      `goal: null` and no state change.
- [ ] `/goal <objective>` still creates a Goal without a quotation.
