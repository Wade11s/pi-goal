# Real-Pi interactive smoke test

This procedure verifies the user-facing package against a real Pi process: the
documented installation workflow, Goal creation, automatic continuation,
interactive objective editing, pause, resume, status reporting, restart
persistence, clear, and the colon-namespaced command family with its
old-spelling refusals. It is a manual complement to the deterministic RPC suite
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

To verify the repository package instead, install
`git:github.com/Wade11s/pi-goal` (see the repository README for pinning a tag).

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

The extension registers six Goal commands — `/goal`, `/goal:pause`,
`/goal:resume`, `/goal:clear`, `/goal:history`, and `/goal:edit` — plus the
`get_goal`, `create_goal`, and `update_goal` model tools. Typing `/` lists each
command on its own line with its own description, and there is no `/goal:status`
and no `/goal:create` (bare `/goal` and `/goal <objective>` already are those).
When a UI exists, the footer/status bar shows a compact Goal indicator as soon as
a Goal exists.

## 3. Create a Goal

```
/goal Write a haiku about persistent sessions in a file called haiku.txt
```

With the default `goal.clarifyOnCreate: true` this starts Objective
clarification:

- an `Objective clarification started: no Goal is committed yet.` notification;
- the model asks about the objective, constraints, and acceptance criteria — no
  Goal exists yet, so `/goal` still reports "No Goal is set";
- once you answer, the model calls `propose_goal` and a confirmation editor opens
  with `Title: <draft title>`, a blank line, then the drafted Objective (the
  English three sections). Edit either part and save.

Expect after saving:

- a `Goal ... created and activated` notification;
- the status indicator `goal_<id> · active · <tokens> tok · <remaining> left · <active time>`, and bare `/goal` shows the title you saved;
- the status uses exactly the title and Objective you left in the editor;
- the agent starts working immediately.

Try cancelling a second clarification (`/goal Add a second haiku`) instead of
saving: no Goal is created, nothing is written, and `/goal` still reports the
first Goal unchanged (or "No Goal is set" if you cleared it first).

To verify persistence, start a clarification that holds flags
(`/goal --file notes.md --budget 5000 …`), answer one question, then exit Pi and
resume the session (`pi -c`). Expect an `Objective clarification restored`
notice, bare `/goal` naming the open clarification and its held flags, no
materialized artifact, and no remote-image request; saving the confirmation then
creates the Goal with the held budget and attachment. Typing a new
`/goal <other idea>` while a clarification is open restarts the interview with
the new idea, and saving the replaced editor creates nothing.

To verify the escape hatches, add `{ "goal": { "clarifyOnCreate": false } }` to
`~/.pi/agent/settings.json` and restart: `/goal <objective>` creates immediately
with no editor and no title. A UI-less host (`pi -p`, JSON/RPC without a
dialog-capable client) skips clarification with a notice.

## 4. Inspect status

```
/goal
```

Expect the full report: objective, `active` status, identity, timestamps,
revision, token budget, accounted token usage, active time, and remaining
capacity. The compact footer indicator shows the same status and usage.

Now give the Goal a title:

```
/goal:edit --title "Release prep"
```

Expect a `title set to` notification and the same Goal identity with the next
revision; `/goal` now shows a `Title: Release prep` line above the objective, and
`get_goal` returns the same `title`. The title-only edit starts no work. A title
with a line break or more than 80 characters is refused and changes nothing, and
a title edit never renames the session.

## 5. Watch automatic continuation

Let the agent finish a turn. With the Goal still `active`, Pi continues on its
own at the safe settlement boundary. The continuation restates the objective and
asks for an evidence audit. `/goal` still reports `active`.

## 6. Edit the objective interactively

```
/goal:edit
```

Pi opens a multi-line editor prefilled with the current objective. Change it to:

```
Write the haiku and a limerick about steering
```

Save and exit. Expect an `objective updated` notification, the status indicator
stays `active`, and the running work is steered to the new objective. Cancelling
the editor leaves the objective unchanged. The typed form
`/goal:edit --title <text> <objective>` changes the title and objective together
in one revision.

## 7. Pause

```
/goal:pause
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
/goal:resume
```

Expect a `Goal ... resumed` notification, the status indicator returns to
`active`, and work restarts from retained progress with a fresh blocked audit.

## 10. One Goal at a time

```
/goal Write a sonnet instead
```

While the current Goal is unfinished — `active`, `paused`, `blocked`,
`usage_limited`, or `budget_limited` — expect a warning that an unfinished Goal is
already set and that `/goal:clear` is the way out. No dialog opens, no
clarification starts, and the current Goal is unchanged.

Finish the current Goal (`update_goal` with `action: "complete"`, or let the
agent complete it) and run the same command: a complete Goal does not block, so
the creation proceeds (after the confirmation editor with clarification on) with
a new identity, and the complete record is superseded in `/goal:history`.

## 11. Restart persistence

Exit Pi (Ctrl+D), then resume the session:

```sh
pi -c
```

Expect a `Goal ... restored (active)` notification and `/goal` reporting the same
objective, revision history, accounted usage, and active time.

## 12. Clear

```
/goal:clear
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
/goal:resume
/goal:resume --budget 1
/goal:resume --budget=500
```

- The bare resume is refused with guidance to supply a new total
  (`/goal:resume --budget <new-total>`).
- A value at or below the current usage is refused with the no-positive-headroom
  reason, and the Goal stays `budget_limited`. `--budget 1` is always such a
  value here: the Goal was created with `--budget 1`, so its usage has already
  reached that total.
- A value above the configured `goal.maxTokenBudget` is refused, never clamped,
  and the Goal also stays `budget_limited`. With `"maxTokenBudget": 100000` set
  in Pi settings, `/goal:resume --budget=200000` shows the refusal; without a
  configured maximum no raise is refused on that ground.
- `--budget=500` — the `=` spelling, on a still-`budget_limited` Goal — is the
  successful raise. It sets the absolute ceiling to 500 tokens and the Goal
  becomes `active`. `/goal` shows the full prior usage still accounted against
  the new ceiling (never reset or discounted).
- A further `--budget` after a successful raise (for example `--budget=250`
  tried out of habit) is refused for status, not for headroom or maximum:
  "the `--budget` option only resumes a budget_limited Goal". Use a bare
  `/goal:resume`, which reports the Goal already active, or let the resumed work
  exhaust the new ceiling first so the Goal is `budget_limited` again.
- The pending old-episode wrap-up is cancelled by a valid raise. If the resumed
  work later exhausts the new ceiling, the Goal is `budget_limited` again and
  another raise — either spelling — resumes it; exactly one fresh wrap-up is
  delivered for that new exhaustion episode.
- `/goal:edit <objective>` without a resume preserves `budget_limited` and does
  not cancel an owed wrap-up; edit first, then resume with the new budget.

## 15. Optional: RPC / headless check

The deterministic suite already drives `pi --mode rpc` with the package loaded
and asserts the same command surface, the editor dialog over the extension-UI
subprotocol, and the headless no-UI guard. To try it manually:

```sh
pi --mode rpc -e ./
```

A host that implements the RPC extension-UI subprotocol can answer the
`/goal:edit` editor dialog; a host without a dialog-capable UI receives guidance
to use `/goal:edit <objective>` instead of a blocking terminal dialog.

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
- `/goal:resume` after the stop restarts the Goal with a fresh audit.

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

## 20. Optional: hostile orderings across a Goal boundary

Two orderings put work that belongs to one Goal in front of a different one. Both
are pinned by the deterministic suite
(`test/goal39-work-message-identity.test.mjs`,
`test/goal39-work-message-identity-store.test.mjs`,
`test/goal37-stale-execution.test.mjs`); the steps below reproduce them by hand
with a real provider.

**A stale queued work message never opens or charges the new Goal.**

1. Create a Goal whose run stays busy for several turns, and let its first turn
   land.
2. `/goal:pause`, then `/goal:resume` immediately: the resume work message is
   queued as a steer while the run is busy.
3. `/goal:clear`, then `/goal --budget 1 <objective>` for the new Goal.
4. Let the queued message land.

Expect the new Goal's own kickoff to be delivered exactly once and its ledger to
carry only its own work — the stale message for the cleared identity opens
nothing, so the old run's later turns are charged to nobody. The cleared identity
earns no further Continuation or Budget wrap-up.

**A stale execution cannot drive the new Goal's lifecycle.**

1. Create a Goal whose single run keeps taking turns and ends with an
   `update_goal { action: "complete" }` call; let that call land while the run is
   still streaming its final response.
2. `/goal <new objective>` while that completed Goal's run is still in flight (no
   replacement dialog exists; a complete Goal is superseded silently, after the
   confirmation editor if clarification is on).

Expect the replacement to commit, the old execution's later
`update_goal` call to be refused (the execution is bound to the identity it was
admitted against), and the new Goal to stay `active` at revision 0 with its own
kickoff rather than being marked `complete` with no work. The replaced identity
keeps its own durable superseded record.

## 21. Optional: disabling the extension (`goal.enabled`)

`goal.enabled` is an admission control, not a Lifecycle status. The deterministic
coverage is `test/goal46-admission-control.test.mjs` (a real `pi --mode rpc`
session per case, resumed with a different `settings.json`); the steps below
reproduce the user-visible surface by hand.

1. Create a Goal and let a continuation run (sections 3–5).
2. Add `"goal": { "enabled": false }` to Pi settings and restart Pi on the same
   session (`pi --continue`, or resume the session file).
3. Run `/goal`. Expect the ordinary report plus an `Admission disabled:` block,
   and a status line ending in `admission off`.
4. Send an ordinary prompt. Expect the work to run and finish, and a
   `... no continuation was requested at this settlement` notification. Bare
   `/goal` twice a few seconds apart: `Active time` must still be increasing —
   disabling the extension does not stop the clock.
5. Try `/goal <objective>`, `/goal:edit <objective>`, and `/goal:resume`. Expect a
   refusal naming what is refused and what still works; no replacement
   confirmation dialog may open.
6. `/goal:pause`, then `/goal:edit <objective>`: the edit of an already-stopped
   Goal is allowed and says no work was started.
7. Remove the setting (or set it to `true`) and restart on the same session. The
   restored active Goal continues at the next settlement again.

## 22. Optional: the paused-Goal resume prompt (`goal.resumePrompt`)

`goal.resumePrompt` is convenience over `/goal:resume`, not a replacement for it.
The deterministic coverage is `test/goal51-resume-prompt.test.mjs` (a real `pi
--mode rpc` session per case, reopened on a copied session file); the steps below
reproduce the user-visible surface by hand.

1. `/goal <objective>`, let one continuation run, then `/goal:pause`.
2. Add `"goal": { "resumePrompt": true }` to Pi settings and restart Pi on the
   same session. Expect one `Resume the paused Goal?` confirmation after the
   `Goal ... restored (paused)` notice. Do **not** answer it yet: `/goal` must
   still respond and report `paused`, because startup never waits on the dialog.
3. Answer **Yes**. Expect `Goal ... resumed (revision N)` and a fresh resume
   kickoff; bare `/goal` reports `active`, and a subsequent model blocker report
   starts a fresh audit rather than inheriting the pre-pause one.
4. Repeat from step 1 and answer **No** (or dismiss the dialog, or leave it
   unanswered until it times out). Expect `Resume prompt not confirmed
   (declined, dismissed, or timed out)` and a Goal that is still `paused` with an
   unchanged revision, no new run, and no new continuation.
5. While a `blocked`, `usage_limited`, or `budget_limited` Goal is restored, no
   prompt may appear; those recoveries stay explicit (`/goal:resume`, or
   `/goal:resume --budget <new-total>` with valid new headroom).
6. Set `"goal": { "enabled": false, "resumePrompt": true }` and restart on a
   paused Goal. Expect no dialog, a notice that the prompt is enabled but
   pi-goal is disabled, and `/goal:resume` still refused; the Goal stays paused
   either way.
7. Remove the setting (or set it to `false`) and restart: the paused Goal is
   restored with no dialog and only `/goal:resume` restarts it.

## 23. Optional: naming the session from the Objective

`goal.sessionNameFromObjective` (default `false`) is a convenience, not a
Lifecycle behavior. The deterministic coverage is
`test/goal52-session-naming.test.mjs` (a real `pi --mode rpc` session per case);
the steps below reproduce the user-visible surface by hand.

1. Add `"goal": { "sessionNameFromObjective": true }` to Pi settings and restart Pi.
2. `/goal <objective>` in a session with no name. Expect the session name (shown in
   the session selector and the footer) to become the Objective's first line.
3. Name the session yourself (`/name <name>` or `ctrl+r` to rename it in place),
   then `/goal:clear` and `/goal <another objective>`. Expect your name to survive:
   pi-goal never overwrites a name that exists.
4. With a named session, `/goal:edit <new objective>`. Expect the name to be
   unchanged while the Goal's objective and revision change.
5. With a named session, `/goal <another objective>` and confirm the replacement.
   Expect the name to be unchanged again.
6. A long objective (over 80 characters) is named with exactly its first 80
   characters, and a multi-line objective with only its first line.

## 24. Optional: local Objective attachments

Choose a small UTF-8 text file and a local PNG, JPEG, GIF, or WebP image, then
create a Goal with explicit leading options:

```
/goal --file ./requirements.txt --image ./screenshot.png Implement the attached requirements
```

Expect the ordinary creation confirmation and immediate work, with the model
using both files. `/goal` adds an `Attachments:` metadata line (labels, media
types, sizes), not file contents. The first work message contains the text as an
encoded `GOAL ATTACHMENT DATA` block and the image as a Pi image content block;
the next automatic Continuation names the same hashes and carries the same
attachments.

The durable artifacts live beside the session file:

```
<session-directory>/pi-goal-store/<goal-id>/<sha256>.<ext>
```

1. Run `/goal:edit Refine the attached requirements without changing the files`.
   The manifest and hashes stay unchanged. `/goal:edit --file ./other.txt New
   objective` is refused with Replacement Goal guidance.
2. Replace the Goal with a different `--file`/`--image` selection and confirm.
   The new identity gets its own manifest; the old identity's artifact directory
   remains.
3. Restart the session. The attachments verify and later Continuations use the
   same hashes; the original source paths are not needed.
4. `/goal:clear` removes the current Goal but does **not** remove either Goal's
   committed artifacts. V1 deliberately has no destructive automatic garbage
   collection because an older selected branch may still need them.
5. For the integrity check, create another attachment-bearing active Goal, stop
   Pi, and temporarily move one content-addressed artifact aside. Restart and
   send an ordinary prompt. Expect an explicit missing-artifact error and no
   automatic Continuation; `/goal` keeps the same Lifecycle status and manifest.
   Restore the original bytes to the exact content-addressed path before
   resuming. Do not edit the artifact in place unless corruption behavior is
   what you intend to test.
6. With `goal.enabled: false`, retry an attachment-bearing creation. It is
   refused before materialization, no `pi-goal-store` entry is created, and the
   previous Goal is unchanged.

SVG, unknown image bytes, empty/invalid UTF-8 text, more than eight attachments,
and files over the documented limits are refused without a success event or
kickoff. Plain Objective text mentioning `--file` remains plain text, and
`create_goal` has no attachment parameters. This explicit flow—not inferred
composer drafts—is the V1 alternative to Codex pending pastes and image drafts.

### Remote image variant

Use a small image URL you control (the automated suite uses only a local HTTPS
fixture; this manual check may use the network):

```
/goal --remote-image https://example.com/diagram.png Implement the attached diagram
```

1. Expect one fetch, then a kickoff and Continuation with the same image hash.
   `/goal` lists the manifest label, media type, and size without the URL.
2. Restart Pi and continue. Expect no second request to the URL and the same
   hash; the source URL is not needed after creation.
3. Retry with `--remote-image http://example.com/diagram.png`, a URL containing
   `user:password@`, `https://127.0.0.1/...`, and an https URL for a hostname
   that resolves to loopback. Expect each refusal before a Goal is written or a
   fetch completes. A redirect to a private address, too many redirects, a
   non-image response, and an oversized response are refused the same way.
4. With `goal.enabled: false`, retry a remote-image creation. Expect the
   disabled refusal before any request is attempted.

## 25. Optional: the structured progress plan (`goal.planTool`)

`goal.planTool` (default `false`) registers an `update_plan` model tool. The
deterministic coverage is `test/goal53-progress-plan.test.mjs` (a real `pi --mode
rpc` session per case, driving real model tool calls); the steps below reproduce
the user-visible surface by hand.

1. Add `"goal": { "planTool": true }` to Pi settings and restart Pi.
2. `/goal <objective>` and let one Continuation run. Ask the model to keep a plan.
   Expect an `update_plan` call whose result restates the steps and their statuses,
   and expect the tool to appear in the model's tool list.
3. Ask for a plan with two steps marked in progress. Expect a refusal naming the
   one-in-progress rule, with no plan recorded.
4. Ask the model to mark every step completed. Expect the Goal to stay `active`
   with an unchanged revision, and expect the next turn to keep working: only
   `update_goal` with `complete` ends the Goal.
5. Restart Pi on the same session. The plan is still part of the model's context,
   and the tool is registered again.
6. Remove the setting (or set it to `false`) and restart. Expect no `update_plan`
   in the tool list, no mention of it in any Continuation, and a refusal if the
   model calls it anyway.

## 26. Optional: the Goal audit history

After any of the transitions above, read the timeline:

```
/goal:history
```

Expect one line per committed transition — identity, revision, previous and
current Lifecycle status, timestamp, usage summary, Active elapsed time, and an
`attachments:` line with manifest hashes when the Goal has attachments. The
header names the timeline as non-authoritative.

1. Restart the session and run `/goal:history` again: the same records, because
   they are durable session entries rather than runtime state.
2. Run `/goal` before and after `/goal:history`: nothing changes. The rendering
   writes no `goal-state`, `goal-history`, or `goal-usage` entry and starts no
   run, and no command mutates a Goal from a record.
3. Pause, resume, edit, and clear, checking the timeline after each: every
   committed transition gets exactly one record, and refusals (a second pause, a
   second clear, a declined replacement) get none.
4. For the malformed-entry check, stop Pi and truncate one `goal-history` line's
   JSON payload in the session file (leave the entry's id, parent, and timestamp
   intact). Restart: `/goal` reports the unchanged Goal, and `/goal:history`
   renders the readable records plus a notice that one entry could not be read.
5. For the crash-gap check, stop Pi and delete one `goal-history` line, re-pointing
   the following entry's `parentId` at the removed entry's parent. Restart: the
   Goal is unchanged, the timeline simply has no record for that transition, and
   the next transition appends normally.

## 27. Optional: the command family, its completions, and both refusals

Section 2 checks that the six commands are listed. These steps check that they
behave as a namespace and that the old spelling has no side effects.

1. Type `/` and read the Goal lines: `/goal`, `/goal:pause`, `/goal:resume`,
   `/goal:clear`, `/goal:history`, `/goal:edit` — six entries, each with its own
   description. Nothing matching `goal*` beyond those six.
2. Type `/goal ` and wait: the completion list offers `--budget`, `--no-budget`,
   `--file`, `--image`, and `--remote-image`, filtered as you type (`--f` leaves
   `--file`; `--zzz` leaves nothing and Pi's default behaviour applies).
3. Type `/goal:resume ` and wait: the list offers `--budget`. No other command in
   the family completes anything.
4. With an `active` Goal, run `/goal` and `/goal:history` and note the reported
   state and the timeline's length. Now type the old spellings one at a time:
   `/goal pause`, `/goal resume`, `/goal clear`, `/goal history`, `/goal edit`,
   `/goal Pause`, `/goal  pause  `, `/goal resume --budget 150`, and
   `/goal resume --budget=150`. Each answers an error notification of the form
   *"Goal not created: `pause` is a Goal command; use /goal:pause."* (the resume
   cases name `/goal:resume --budget <new-total> (or --budget=<new-total>)`). No
   confirmation opens, no run starts, and `/goal` plus
   `/goal:history` show exactly the state and timeline you noted: no snapshot, no
   transition, no history record.
5. Try the stray-argument usage errors: `/goal:pause foo`, `/goal:clear the lint
   errors`, and `/goal:history of the release` each answer *"/goal:<verb> takes no
   argument."* and change nothing; `/goal:resume --budget` without a number is
   refused with the guidance to supply a new total. None of them half-applies a
   lifecycle action.
6. Confirm the behaviour flip the other way: `/goal Edit the README to add a
   smoke-test line` **creates** a Goal named after that Objective (it is not an
   edit of the current Goal), and so does `/goal Clear the lint errors`.

## Checklist

- [ ] Installed with `pi install ./` and visible in `pi list`.
- [ ] `--file`/`--image` attachments reach kickoff and Continuation with stable
      hashes, survive restart and replacement/clear retention, and fail closed
      with an explicit error when an artifact is missing or corrupt.
- [ ] `--remote-image` fetches once over HTTPS, keeps the same hash across
      Continuations and restarts, sends no credentials/cookies/referrer, and
      refuses HTTP, credentials, non-public destinations, bad redirects, MIME
      mismatches, and oversized bodies without a success event.
- [ ] `/goal <objective>` creates an active Goal and starts work.
- [ ] The `/` menu lists exactly the six Goal commands, `/goal ` completes the
      five creation flags and `/goal:resume ` completes `--budget`, every old
      space-separated spelling is refused with the verb to type and no side
      effect, a stray verb argument is a usage error, and an Objective that
      begins with a verb word (`/goal Edit …`, `/goal Clear …`) still creates.
- [ ] The status indicator and bare `/goal` report `active`.
- [ ] An active Goal continues automatically after a turn.
- [ ] Bare `/goal:edit` opens a prefilled editor and applies the edit.
- [ ] `/goal:pause` changes status to `paused` and stops continuation.
- [ ] `/goal:resume` changes status back to `active` and restarts work.
- [ ] `/goal:resume --budget <new-total>` resumes a `budget_limited` Goal with a
      higher cumulative ceiling, and the `--budget=` spelling works.
- [ ] A bare `/goal:resume` of a `budget_limited` Goal, a no-headroom raise, and
      a raise above `goal.maxTokenBudget` are all refused with guidance.
- [ ] `/goal:clear` removes the Goal and the status indicator.
- [ ] A clarification survives a restart (or a killed process): the notice names
      it, `/goal` reports the held flags, `propose_goal` still commits with them,
      and nothing was read or fetched before the save; a new `/goal` replaces it
      and the replaced editor's save creates nothing.
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
- [ ] A work message queued for a Goal that is then cleared or replaced is
      delivered after the new Goal commits but opens nothing: the new Goal's own
      kickoff runs exactly once and only its own work is charged.
- [ ] A run admitted against a replaced identity cannot complete, report a
      blocker against, or pause the Goal that replaced it; the replaced identity
      keeps its own durable superseded record.
- [ ] With `goal.enabled: false`, creation, replacement, `create_goal`, a
      work-admitting edit, resume, and automatic continuation are all refused,
      while inspection, pause, clear, and in-flight terminal updates still work.
- [ ] An active-but-disabled Goal keeps its `active` status and keeps accruing
      `Active time`; `/goal:pause`, not disabling the extension, stops it.
- [ ] Re-enabling `goal.enabled` restores admission, and the restored active Goal
      continues only at the next settlement.
- [ ] With `goal.resumePrompt: true`, a restored `paused` Goal is asked once;
      accepting runs `/goal:resume`'s durable transition (fresh Blocked audit),
      while declining, dismissing, timing out, or having no UI leaves it paused
      and unchanged.
- [ ] `active`, `complete`, `blocked`, `usage_limited`, and `budget_limited` Goals
      are never prompted for, and a disabled extension never offers the prompt.
- [ ] With `goal.sessionNameFromObjective: true`, `/goal <objective>` names an
      unnamed session from the Objective's first line (whitespace-collapsed, at
      most 80 characters), and `create_goal` does the same.
- [ ] With the setting absent or `false`, no session is ever named.
- [ ] A session name the user provided is never overwritten, an Objective edit and
      a Replacement Goal never rename it, and a failed or rolled-back creation
      leaves the session unnamed.
- [ ] With `goal.planTool: true`, an `update_plan` call records an ordered plan
      with at most one in-progress step, and the plan is visible in the model's
      context again after a restart.
- [ ] A plan with two in-progress steps is refused and records nothing, and a plan
      that marks every step completed leaves the Goal `active` with an unchanged
      revision — only `update_goal` completes it.
- [ ] With the setting absent or `false`, no `update_plan` tool is registered and
      no Continuation mentions it.
- [ ] `/goal:history` renders one record per committed transition (identity,
      revision, previous/current status, timestamp, usage, active time, manifest
      hashes), survives a restart, writes nothing, and mutates nothing.
- [ ] A truncated `goal-history` entry is skipped and surfaced as a notice while
      the Goal reconstructs unchanged, and a missing one leaves only the
      documented diagnostic gap.
- [ ] `create_goal` succeeds only for a verbatim, affirmative, currently
      authoritative request, and refuses forged, stale, negated, hypothetical,
      question-shaped, non-explicit, and wrong-source quotations with
      `goal: null` and no state change.
- [ ] `/goal <objective>` still creates a Goal without a quotation.
