# pi-goal

Codex-style persistent Goals for [Pi](https://github.com/earendil-works/pi): a `/goal`
command and three model tools (`get_goal`, `create_goal`, `update_goal`) that give a
session a durable, user-controlled objective. While a Goal is active, work
continues automatically at Pi's safe settlement boundary until the model verifies
completion, a genuine blocker persists, a provider usage limit or terminal failure
stops the run, a conservative anti-loop bound is reached, the run is aborted, the
lifecycle changes, or the Goal's token budget runs out.

Requires **Pi 1.5.1 or newer**. The extension uses only public extension APIs and
does not patch Pi core.

## Supported Pi versions

pi-goal targets Pi **1.5.1 and newer**. It is developed against the public
extension APIs available in 1.5.1; `package.json` pins
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.5.1 for
typechecking, and the automated suite runs against the installed `pi` CLI
(1.5.1 or newer; verified on 1.5.2). Pi loads the TypeScript entry point through
its `jiti` loader, so no build step is required.

## Install

The package follows Pi's documented package workflow. From a checkout of this
repository:

```sh
pi install ./            # add to personal settings (~/.pi/agent/settings.json)
pi install --local ./    # or project-local (.pi/settings.json, after project trust)
```

Confirm the installation:

```sh
pi list                  # the checkout appears under User/Project packages
```

Or try it once without installing:

```sh
pi -e ./
```

The package declares its entry point in `package.json` (`pi.extensions`), is
discoverable through the `pi-package` keyword, has no runtime dependencies, and
uses Pi's host-provided packages (`peerDependencies` only). Installed packages
can be updated with `pi update --extensions` and removed with `pi remove <source>`.

## Usage

### Create a Goal

```
/goal Make the full test suite pass in this repository
```

- Validates the objective (3–2000 characters after trimming).
- Stores an **active** Goal as durable session state and confirms it is on disk
  before announcing success.
- Sends the objective into the model context as a user message and starts initial
  work immediately.
- When an **unfinished** Goal already exists, asks for confirmation first (see
  *Replace a Goal* below); the words `pause`, `resume`, and `clear` are
  subcommands only when they are the *entire* argument, and `edit` is a
  subcommand whenever it is the first word — objectives that merely begin with
  one of the other words (for example "clear the lint errors") are accepted.

### Replace a Goal

Setting a new objective while an unfinished Goal exists is a *replacement*: a new
Goal identity takes over the session's single Goal slot and starts at zero
Goal-owned usage. A replacement never happens silently — `/goal <objective>`
shows a confirmation dialog first, and a declined (or timed-out, or dismissed)
dialog keeps the current Goal untouched. The dialog is answered over the RPC
extension-UI subprotocol in RPC mode, so headless hosts confirm the same way an
interactive user does. Modes without any UI cannot confirm and keep the current
Goal (use `/goal clear` then `/goal <objective>` there). Replacing a **complete**
Goal asks nothing, because nothing unfinished is discarded.

The replaced Goal is not erased. Its already-accounted usage is written as a
durable **current** snapshot before the new identity commits — current, not
historical, so a crash between that write and the replacement's own snapshot
still reconstructs the old Goal — and its admission segment stays open past the
commit so a response and tool results that were already in flight are charged to
it rather than to the replacement or to nobody. That tail is frozen onto the old
identity's record as a **superseded** snapshot at the next freeze boundary — the
next delivered user message, a shutdown that keeps the session file, a new Goal
creation, a second replacement, a durability-rollback restore, or the first load
of a branch whose freeze never ran — and a tail that collected nothing new is
never written. `/goal clear` of the replacement does not freeze an open tail: the
old identity's admission stays open past the tombstone so its in-flight work is
still attributed to it, and the tail freezes at the next boundary. The frozen
record is marked `superseded`, so it is loadable and replayable but never becomes
the current Goal: a crash immediately after the freeze still reconstructs the
replacement. The old identity's active-time clock stops at the replacement, its
own budget exhaustion is recorded on its own record only, and it never continues
or earns a wrap-up.

### Edit the objective

```
/goal edit Ship the release notes page instead
```

Changes the objective **in place**: the Goal keeps its identity, creation time,
and revision history (the edit is the next revision), so no usage history is
erased. If the Goal is active and a run is in flight, the new objective is
delivered into that run through Pi's steering mechanism (after the current
turn's tool calls, before the next model request), so the live work is
redirected safely instead of being interrupted; if the session is idle, editing
restarts work with a kickoff message. A paused Goal can be edited too — it stays
paused until resumed. A complete Goal is finished and cannot be edited; replace
it instead.

Bare `/goal edit` opens Pi's multi-line editor prefilled with the current
objective. Saving applies the edit in place; cancelling leaves it unchanged.
The editor is a dialog-capable UI surface: TUI and RPC hosts support it through
Pi's extension-UI subprotocol, while print/JSON mode (`ctx.hasUI` false) prints
guidance to use the typed form instead of blocking on a terminal-only dialog.
Pi's editor dialog has no timeout option, so pi-goal auto-cancels the command
after 120 seconds if the host never answers; the objective is unchanged.

### Inspect the current Goal

```
/goal
```

Reports the objective, lifecycle status, identity, timestamps, revision, the
configured token budget, the accounted token usage, the active elapsed time, and
the remaining capacity:

```
Goal goal_1a2b3c4d — active
Objective: Make the full test suite pass in this repository
Created by: the user (/goal)
Created: 2026-01-01T00:00:00.000Z
Updated: 2026-01-01T00:05:00.000Z
Revision: 0
Token budget: 250000 tokens
Token usage: 48210 tokens (input 31000, output 17000 including reasoning 4200, cache write 210;
            cached read 184300 excluded as reuse, nested 0 counted once)
Active time: 5m 12s
Remaining capacity: 201790 tokens
```

When a session with a Goal starts, restores, or reloads, a `Goal ... restored
(active)` notification confirms reconstruction.

### Status indicator

When a UI exists, pi-goal publishes a compact one-line indicator under the
`goal` status key:

```
goal_1a2b3c4d · active · 48210 tok · 201790 left · 5m 12s
```

The indicator exposes every lifecycle state — `active`, `paused`, `blocked`,
`usage_limited`, `budget_limited`, and `complete` — and is refreshed on session
start/restore, after every lifecycle transition (create, edit, pause, resume,
clear, complete, blocked, usage-limit, budget-limit), and after accounted usage.
Clearing a Goal removes the indicator. The full breakdown is always one `/goal`
away.

### Token budgets

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

### The lifecycle: pause, resume, clear

Every lifecycle transition is **durable before it is announced**: Pi's
`appendEntry` writes the snapshot through to the session file synchronously, and
only a successful write is reported (a failed write keeps the previous state
and is reported as a persistence error).

```
/goal pause
/goal resume
/goal clear
```

- `/goal pause` immediately stops admission of further automatic Goal runs: the
  continuation seam only continues an `active` Goal, so whatever run is in
  flight finishes on its own and its settlement admits no continuation. Pause
  never aborts work — interrupting a run stays with the user, through Pi's
  normal abort. A paused Goal also stops accruing active time, and `/goal resume`
  restarts that clock with the work.
- `/goal resume` restarts eligible work — a **paused**, **blocked**, or
  **usage_limited** Goal: the transition is durable, then a resume kickoff
  message restates the objective and asks for a fresh evidence audit of the
  retained progress. Resuming while another run is in flight steers the resume
  message into it rather than waiting for idle. Resuming a `blocked` or
  `usage_limited` Goal is the user decision those stops ask for, so it keeps the
  same identity, creation time, and history, drops the audit that described the
  stop, and starts a **fresh** blocked audit: the next blocker report counts from
  one rather than inheriting the count the user just overruled. A **complete**
  Goal is terminal for its identity and is refused — replacing it is a new Goal.
- `/goal clear` removes the Goal from any status by writing a durable tombstone
  snapshot, so restarts and reloads cannot resurrect it, and the session returns
  to ordinary prompt-by-prompt behavior.

These commands are **usable while work is running** and never wait for the
agent to become idle — an active Goal's own continuation loop keeps Pi busy
almost continuously, so a lifecycle command that waited for idle could never
run. Pause and clear answer immediately and take effect at the next settlement;
edit, resume, and a confirmed replacement deliver their work message through
Pi's steering when a run is in flight. None of them require abandoning the
session, and none of them cancel the user's run.

### Automatic continuation

While a Goal is **active**, Pi continuing on its own is the normal case:

- Continuation happens at `agent_before_settle`, Pi's final actionable boundary,
  after Pi has already finished everything it owns — automatic retries,
  compaction recovery, and queued follow-ups. Nothing is scheduled with timers
  and nothing loops from `agent_end`, so those mechanisms keep their normal
  semantics and are never bypassed.
- Each continuation appends a `goal-continuation` custom message that restates
  the objective verbatim and asks for an evidence audit of the current state:
  read the files, command results, runtime state, and artifacts; separate real
  progress from narration; check every explicit requirement.
- The same message carries the no-progress contract: classify the previous Goal
  turn as **progress** (authoritative state changed, work completed, or evidence
  that changes the next action), a **verified wait** (a specific live handle was
  polled), or **no progress** (status narration and unexecuted plans). It states
  that equivalent blockers count as one condition across turns, and it states the
  three-consecutive-Goal-turn blocked audit the extension enforces.
- The continuation requests exactly one further provider request per
  settlement. If queued work already causes that request, Pi satisfies the
  decision with it and makes no extra one.
- Entries proposed by other extensions at the same boundary are chained, never
  replaced.
- A run that was aborted or that ended in a provider error is a hard exit: Pi
  owns retries, so the Goal does not add a retry loop of its own. The Goal stays
  active and continues on the next successful run.

### Usage accounting

Token usage and active elapsed time are durable Goal state, recovered from the
session after a restart, a resume, a reload, or tree navigation.

**Tokens.** Pi reports a `Usage` record on every assistant message, and optionally
on tool-result messages for model work a tool performed. The accounted total is

```
input + output + cacheWrite
```

because that is what Pi's documented usage semantics mean:

- `input` excludes cached reads *and* cache writes — every Pi provider adapter
  subtracts both (`input = prompt_tokens - cached - cache_write`), so adding
  `cacheRead` on top would double-count reuse;
- `cacheRead` is prompt reuse, not new work, so it is excluded from the total and
  reported separately for transparency;
- `cacheWrite` is freshly processed prompt tokens that Pi itself counts in session
  totals, so it is real consumption (`cacheWrite1h` is a subset of it and is never
  added again);
- `reasoning` is already a subset of `output` in every Pi provider adapter, so it
  is reported and never added a second time.

Each report is charged exactly once: an assistant response, a tool result (by tool
call id), and a summarization entry (compaction, branch summary) each have a
stable identity, and nested tool usage — which Pi merges into the calling tool
result's own `usage` and never persists separately — is therefore counted once,
not twice. Reconstruction replays the session branch under the same rule, so a
reload, a restart, or a tree navigation converges on the same totals instead of
re-charging them.

A report is Goal work only inside an open **admission segment**. A segment opens
when Pi delivers a Goal work message — the `/goal` kickoff, an objective edit, a
resume, an automatic Continuation, or the one Budget wrap-up — and closes when Pi
delivers a genuine user prompt or a new Goal identity. `/goal <objective>` therefore
starts attribution at its actual kickoff: the ordinary run the command waited for
is never adopted. `create_goal` leaves its creating run ordinary, and attribution
starts at the first subsequent Continuation; pre-creation responses, creation
controls, and unrelated same-batch tool results are excluded. Ordinary prompts
are excluded in every lifecycle status.

Delivery is the seam at both ends because it is the entry the branch replay reads
back. A steer queued during an in-flight response reaches the branch only *after*
that response and its tool results, so a segment opened at queue time would charge
the previous identity's work to the new Goal; and a prompt typed while a response
streams is delivered only after that response, so a segment closed when the prompt
was typed would drop work the Goal had already admitted. Either way live accounting
and replay would disagree — and a budget only the live path failed to stop would be
crossed on reload, where the reconstruction re-derives the stop from the branch.
Work already admitted stays attributable through pause, completion, a blocked or
usage-limit stop, and other lifecycle boundaries, while no new substantive work is
admitted after the stop. Completion stays terminal on both paths, which is what
keeps the completing batch aligned with a replay that skips everything after a
completion snapshot.

Durable writes happen only at boundaries where every entry they cover is already
on the branch. The ordering matters: Pi dispatches `message_end` to extensions
*before* it appends the message that triggered it, so a checkpoint or a lifecycle
transition written from inside that handler would sit on the branch *ahead* of the
entry it already accounts for, and a reconstruction would replay that entry and
charge it a second time. Usage is therefore charged at `message_end` — enforcement
and status have to be immediate — and persisted at `turn_end`, `agent_before_settle`,
`agent_settled`, and shutdown.

The invariant has two halves, and both have to hold: a durable write must not sit
ahead of an entry it covers, and it must cover *every* entry already on the
branch. Every durable snapshot — a lifecycle transition as much as an accounting
checkpoint — therefore carries the live accounting view at the moment it is
written rather than the totals some earlier decision froze, so usage that lands
in between — a concurrent nested tool result that was already in flight when the
budget was crossed — is inside the snapshot instead of falling into the gap in
front of it, where the replay can reach in neither direction.

A checkpoint is a shortcut over that replay, never a second source of truth: the
branch is the authority. Reconstruction adopts a checkpoint only when adopting it
loses nothing, comparing its totals against the entries between the snapshot and
it. A checkpoint that reports *fewer* tokens than those entries account for means
the live path declined a report the replay charges, and adopting it would seal the
omission permanently — the entry sits before the checkpoint, so no later replay can
reach it. Such a checkpoint is discarded, the replay carries on, and only its
active time is kept, because that is the one thing the branch cannot reconstruct.

What is *not* counted: Pi's `usage` session entries (cache-warming refreshes),
which are reported outside the transcript and outside Goal work; and any response
produced after a Goal is complete, because completion is terminal. What *is*
counted: the turn that completes a Goal or exhausts its budget, the one bounded
wrap-up, and every later run of a `budget_limited` Goal. The branch replay after a
restart draws exactly the same line, so an unclean exit cannot reclassify
post-completion work as Goal usage.

**Active time.** A monotonic clock (`performance.now()`, sampled exactly once per
operation and clamped to the highest value seen) runs while a Goal is active in a
live session. Paused time, process downtime, and a stopped Goal (complete,
budget-limited) do not accrue. Folding a segment into the record at a lifecycle
boundary neither loses nor double-counts time, and the accounted value is
checkpointed durably at most once per accounted second of Goal activity, at every
settlement, and at shutdown. Because the source is monotonic, a clock adjustment
cannot make accounted time jump or shrink.

Checkpoints are event-driven, not periodic: an *idle* active Goal accrues active
time that only becomes durable at its next settlement or shutdown, so an unclean
exit can lose more than one second of active time. Tokens are never lost that way —
they are always recoverable from the branch, and a checkpoint that disagrees with
the branch is discarded rather than adopted (see above).

### Budget exhaustion

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

Raising the budget or changing the objective is a user decision; resuming a
budget-limited Goal arrives with the lifecycle commands.

### Model tool: `get_goal`

The model can call `get_goal` at any time to retrieve the same structured state
the command reports (or `goal: null` when no Goal is set). Use it whenever the
objective is absent or truncated in context.

### Model tool: `create_goal`

`create_goal` lets the model create a Goal, but only for an **explicit user or
system request** — the tool description and its prompt guidelines say so, and
nothing in the extension infers a Goal from an ordinary task. It validates the
objective, refuses an ephemeral session that could not restore the Goal, refuses
while this session already has a Goal (including when two calls arrive in the
same assistant turn), and persists the snapshot before reporting success.
Creating a Goal through the tool does not send a kickoff message: the model is
already mid-run, and the continuation seam picks the Goal up at the next
settlement.

### The objective's trust boundary

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

### Model tool: `update_goal`

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
`{ action: "blocked", blocker: "…" }` once the same genuine blocker has persisted
for at least **three consecutive Goal turns**. `complete` and `blocked` are both
terminal: the Goal is persisted as `complete` or `blocked` and never continues
again, including after a restart or reload. Any other action (`resume`, `clear`, a
usage-limit or budget-limit transition) is refused with an explanation, because
those transitions stay with the user.

The extension, not the model, decides when the blocked audit is satisfied:

- a report is recorded per **Goal turn**, so several calls inside one turn count
  once and cannot satisfy the threshold on their own;
- the chain is **consecutive**: a Goal turn that makes progress, verifies a wait,
  or reports no blocker breaks it, and the count starts again;
- blockers are compared after normalizing case, whitespace, and trailing
  punctuation, so a reworded repetition still advances the audit while a genuinely
  different blocker restarts it at one;
- below the threshold the report is persisted and refused with the current count,
  which is what keeps a transient failure from stopping useful work. Both the audit
  and every break in it are durable, so compaction neither hands the model three
  fresh turns nor resurrects a chain it already invalidated, and bare `/goal` after
  a restart still reports the blocker and its count. A prompt the user sends after
  a restart is itself a user action, so it starts a fresh audit.

### Stopping safely on blockers and failures

A Goal can also be stopped without the model asking for it. Every rule is
deterministic, and every one of them is narrow enough that ordinary work is never
mistaken for a malfunction.

| Stop | Status | Why it is not ordinary work |
| --- | --- | --- |
| Same genuine blocker for three **consecutive** Goal turns | `blocked` | reported by the model through `update_goal`, enforced by the extension |
| Three consecutive activity-free **automatic** Goal turns | `blocked` | no tool call, no output, and no reasoning: the continuation loop is malfunctioning |
| Three consecutive automatic turns in which commands could not be executed | `blocked` | the shell itself failed to run |
| Provider usage limit | `usage_limited` | the error says the plan or budget is exhausted |

The unit of counting is the **Goal turn**, and a Goal turn is a *chain* of runs.
One run can contain several provider requests (a tool call and its follow-up, a
steering message), and Pi can turn one Goal turn into several runs in two more
ways: by retrying a failed provider request, and by compacting for overflow
recovery — a recoverable length stop or a context-overflow error — and retrying the
same response. All of them keep the Goal turn's identity and its accumulated
observations, so three failing shell attempts inside one continuation are one Goal
turn, and a Goal turn whose response was truncated, compacted, and retried empty is
still one activity-free Goal turn. Everything Pi owns — retries, final-attempt
recovery, compaction retries, queued messages — finishes before a Goal turn is
evaluated at the settlement boundary, which is the only place a Goal turn is known
to be over.

- A **blocked** or **usage_limited** Goal never continues automatically. Only the
  user can resume one, with `/goal resume`, which restarts it with a fresh audit;
  a complete Goal is never resumed, only replaced.
- An **ordinary command failure** — the command ran and exited non-zero, timed
  out, died without an exit code, or was aborted — is normal work. It never counts
  toward the execution-unavailable stop.
- Only a **shell command that actually ran** may break an execution-failure chain.
  Two things that look like shell outcomes prove nothing either way and are
  ignored: a successful `get_goal`, `read`, or `grep` (which says nothing about
  whether the shell works — and the continuation contract tells the model to read
  state, so that mix is the ordinary shape of a broken shell), and a shell call
  that never ran at all (invalid arguments, a permission block, an abort before
  start), which Pi reports as an error result with no measured duration. A call
  that never ran neither counts as an execution failure nor stands in for a shell
  that worked, so it cannot hide a genuine spawn failure in the same Goal turn.
- Only **automatic** continuations count toward the anti-loop bounds. The kickoff
  and any run the user started are attended work, so an empty kickoff followed by
  two empty automatic responses is two activity-free turns, not three.
- An **aborted** run is a hard exit Pi already owns. It is not counted as a Goal
  malfunction, and it resets the counters.
- A **terminal provider error** that is not a usage limit stops the continuation
  for that run and is surfaced as a warning, while the Goal stays active and
  continues on the next successful run. Pi's own retries are untouched. A Goal
  that has already stopped (`blocked`, `usage_limited`, `budget_limited`,
  `paused`, `complete`) has no continuation to stop, so the same failure is
  reported against that status: it changes nothing, and it is never described as
  an active Goal or as a write that failed.
- A **usage-limit** error is only classified as one when Pi exposes enough
  evidence, and the evidence is read in two tiers:
  - **Account or plan depletion is decisive.** A provider error code whose meaning
    is a plan usage limit (`insufficient_quota`, `GoUsageLimitError`, code `1308`,
    `subscription_sharing_…_usage_limit_exceeded`), a *usage limit*, a *billing,
    plan, spending, account, or subscription limit*, *account/plan/period quota*, or
    *account/plan/period budget* paired with an exhaustion verb **in either word
    order** (`billing hard limit has been reached`, `You have reached your billing
    limit`), an empty credit pool (`out of credits`, `credit balance is too low`).
    This tier survives throttle wording in the same failure, because
    it says the plan itself is used up rather than that a rate was hit —
    `429 rate limit reached; insufficient_quota: current quota exhausted` is a usage
    limit, not a throttle. It does not survive a `reached` whose object is a lookup:
    `The account quota service reached a timeout while checking your account` is a
    check that timed out, and qualifying the noun does not change that. The noun
    phrase the verb governs is read for the limit its *head noun* names — the last
    noun in the phrase, which is what the phrase is — so `You have reached your
    usage limit; please check your plan` stays genuine exhaustion, and so does
    naming the API or the service as the *scope* of the limit, before it or after
    it (`You have reached your usage limit for the Anthropic API`, `Monthly usage
    limit reached for this service`, `You have reached the API usage limit`, `You
    have reached your service usage limit`), because the verb reached a limit, not a
    lookup. The head cuts both ways: `You have reached the quota service`, `You have
    reached the account quota service`, `You have reached the billing limit check`,
    and `You have reached the usage limit service` all have a service or a check as
    their head, so the limit vocabulary in front of them is a modifier and the object
    is the lookup. Reading the head rather than the raw end of the phrase is what a
    trailing comma, an exclamation mark, or a trailing adverb cannot get past (`You
    have reached the quota service, please retry`, `You have reached the quota
    service now`), and the phrasal verb `reached out to` reaches what follows its
    particle. A rate dimension is read first, so `reached a rate limit` and `reached
    a quota metric` stay throttles.
  - **A bare quota plus an exhaustion verb is not decisive.** That is also exactly
    how a provider describes a *per-minute quota metric*, which resets within a
    minute, so it only counts when its sentence is not about a rate dimension.
  Every match of every pattern is scanned, so a rejected earlier lookup or throttle
  cannot hide a later explicit statement of exhaustion.

  These look-alikes are deliberately not enough, and each of them would wedge the
  Goal on evidence that does not support it:

  | Look-alike | Example |
  | --- | --- |
  | A transient throttle described with quota vocabulary | `Rate limit exceeded; quota is not exhausted.`, `429 rate limit exceeded for quota metric requests per minute`, `Quota exceeded for quota metric 'Generate Content API requests per minute'` |
  | A lookup or a throttle, including a *qualified* one — what decides is the verb's object, not how the subject was named | `The quota service reached a timeout while checking your account`, `The account quota service reached a timeout while checking your account`, `The billing limit check reached a timeout…`, `The spending limit lookup reached a timeout…`, `The monthly budget service reached a timeout…`, `The quota service reached a rate limit while checking your account`, `The usage limit check reached a timeout while checking your account`, `The billing service reached its rate limit while checking your account`, `The API check reached a timeout while checking your account`, `You have reached the service timeout`, `You have reached the quota service`, `You have reached the account quota service`, `You have reached the account quota service and timed out`, `You have reached the billing limit check`, `You have reached the billing limit lookup`, `You have reached the usage limit service`, `You have reached the quota service while checking your account`, `You have reached the quota service, please retry`, `You have reached the account quota service, please retry`, `You have reached the billing limit check, please retry`, `You have reached the quota service!`, `You have reached the quota service now`, `You have reached out to the quota service` |
  | A negated statement | `You have not exceeded your quota`, `Your quota is not exceeded`, `Your quota has not been exceeded`, `Your plan limit has not been reached`, `No quota exceeded` |
  | An internal or per-request budget | `Retry budget exhausted after 3 attempts`, `token budget exceeded for this request`, `The request is out of budget for this call` |
  | Bare account vocabulary | `Your billing address could not be verified; update your account details`, `Billing service temporarily unavailable; please retry later` |
- Every stop is explained to the user through a notification and recorded on the
  Goal, so `get_goal` and bare `/goal` report the blocker and the audit count.
- **User actions reset the counters.** A prompt the user types (including one
  queued while the agent is busy) and an abort both restart the blocked audit and
  the anti-loop counters, and a replacement Goal starts from a fresh record.

Budget exhaustion never reaches this tool as a completion: a `budget_limited`
Goal is not active, so `update_goal complete` is refused for it, and the wrap-up
message says so explicitly.

### Structured tool responses

`get_goal`, `create_goal`, and `update_goal` all return the same structured
`{ goal }` payload, so status, budgets, usage, and remaining capacity are
unambiguous for programmatic callers:

```json
{
  "goal": {
    "id": "goal_1a2b3c4d",
    "status": "active",
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

## Persistence model

- Goal snapshots are stored as **custom session entries** (`goal-state`), which
  live outside the model context. The last snapshot on the active session branch
  wins, so restart, resume (`--continue` / `--session`), and extension reload
  (`/reload`, or any runtime replacement) reconstruct the state without the user
  restating the objective. Reconstruction also runs after `session_tree`
  navigation and on forked sessions: the *selected* branch alone decides the
  state, so snapshots on an abandoned branch cannot leak into the newly selected
  one, a cleared Goal stays cleared on the branch that cleared it. The newest
  *current* `goal-state` entry controls the branch: if it is malformed or has an
  unrecognized version, reconstruction **fails closed** with no current Goal and
  an actionable notification rather than falling back to an older snapshot, which
  could resurrect a cleared, replaced, or stopped Goal. A later valid snapshot or
  tombstone still wins. An entry marked `superseded` is a finalized historical
  record of a replaced identity: it is valid and replayable, but it never wins,
  so freezing the old identity's tail can never make it the current Goal. A
  branch change is announced only when the reconstructed state observably
  changed.
- A snapshot carries the optional `blockedAudit` (`{ blocker, turns }`): the
  blocker that stopped the Goal, or that is accumulating toward the blocked
  threshold, and how many consecutive Goal turns reported it. It is durable for
  the same reason the audit has to survive compaction, and a malformed one is
  dropped during reconstruction rather than trusted.
- The kickoff is delivered as a **user message** carrying the user's own
  objective (attributed as user-provided Goal data). As the session's first
  conversation entry it also makes Pi create and flush the session file, which
  Pi otherwise defers until a user/assistant message exists. Continuation uses
  the separate `goal-continuation` **custom-message** channel, because
  `agent_before_settle` drafts are custom messages: they participate in model
  context. Note that Pi flattens a custom message into a plain user-role LLM
  message and drops `customType` at the provider boundary, so the channel name
  alone cannot mark a message as extension-authored — which is why each message
  on the channel states its own authority and frames the objective as delimited
  data (see *The objective's trust boundary* above).
- Creation is durability-first: the snapshot is written and made visible, the
  kickoff triggers the file flush, and only after that snapshot is the **last**
  `goal-state` entry on disk is success announced. Visibility comes first so a
  `/goal clear`, `edit`, `pause`, or `resume` issued while creation waits for
  idle acts on the same record the creation captured; every wait revalidates
  the exact id and revision, and a changed record suppresses the queued stale
  kickoff. A tombstone written during the wait therefore counts as *not* durable
  and cannot be overridden by a pre-tombstone entry exhibiting the same id. The
  continuation seam also declines to adopt the run that creation is waiting for
  for as long as that staged Goal identity is the pending creation, including
  after an edit bumps its revision, so the wait ends at idle instead of
  consuming the creation's own kickoff.
  If writing fails (unwritable session file or storage) for a brand-new Goal,
  creation reports a clear persistence error and retracts any in-memory state
  with a durable tombstone snapshot. A failed **replacement** write leaves the
  existing Goal untouched in memory and on disk (no tombstone, no resurrection
  on restart), and `/goal <objective>` can simply be retried.
- Usage accounting is durable too. Token totals are always recoverable from the
  session branch, and the accounted active time is checkpointed into separate
  `goal-usage` custom entries — kept apart from `goal-state` so the lifecycle log
  stays one entry per transition. On reconstruction the branch is replayed from
  after the newest checkpoint or snapshot, which is why a restart recovers usage
  accrued since the last write and can never charge it twice.
- Interrupting the kickoff (Ctrl+C, killing the process, a hung model) does not
  lose the Goal: the snapshot and kickoff are already on disk and are restored
  by the next session.
- Concurrent `/goal` commands (for example two issued while Pi is busy with a
  run) are serialized: the Goal slot is decided exclusively, and a second
  command that would replace an unfinished Goal has to be confirmed before
  anything is discarded — a silent replacement cannot happen.
- Lifecycle transitions (pause, resume, clear, edit) append their snapshot
  through the same write-through path, so a transition is on disk before its
  notification is emitted, and a failed write leaves the previous state in
  force with a retryable error instead of a phantom transition.
- Ephemeral sessions (started with `--no-session`) cannot persist a Goal:
  creating one returns a clear error instead of claiming durable storage.
- Sessions without a Goal behave exactly as before; installing the extension
  only adds the command, the three tools, and the state they manage.

## Legacy 0.1.0 cutover

A `goal-state` snapshot written by pi-goal 0.1.0 is still loadable. It is never
reinterpreted as evidence it cannot contain, and loading or migration sends no
message and triggers no provider request.

- The newest valid snapshot or tombstone determines the branch state. A malformed
  or unrecognized newest `goal-state` fails closed with no current Goal and
  actionable guidance; the extension never falls back to an older entry.
- Once, under the 0.1.0 status-only accounting rules, the legacy token totals and
  active milliseconds are reconstructed and frozen as the Goal's **legacy
  reconstructed totals**. They are a historical baseline, not exact Goal-owned
  attribution rebuilt under the repaired rules; `/goal` reports them as they are.
- Before any repaired Goal work is admitted, the repaired snapshot and a
  branch-local `goal-cutover` marker are written durably. A fork copied before the
  cutover performs its own migration when selected; a fork copied after it
  inherits the baseline. The legacy prefix is never replayed or merged again.
- Absent optional fields keep their 0.1.0 meanings: origin `command`, zero usage
  and active time, `wrapUpPending` false, and no open audit. An active Goal keeps
  its normal continuation eligibility; every non-active status stays stopped,
  `complete` stays terminal, and a tombstone leaves no current Goal.
- The configured `goal.maxTokenBudget` is a hard safety bound during migration: an
  unbounded Goal or one above the maximum is migrated to the maximum with an
  explicit notice, while `goal.defaultTokenBudget` is never applied
  retroactively. An active Goal whose reconstructed usage already reached its
  effective budget becomes `budget_limited` and earns one bounded wrap-up; a
  pending legacy wrap-up is delivered at most once.
- A valid legacy open-audit description and count are preserved for the
  Blocker-identity handoff; no text-similarity equivalence is introduced. An
  existing `origin: "tool"` Goal remains a valid historical Goal, but migration
  grants no fresh Goal-creation authority.

## How the tests stay honest

A scripted-provider step that runs out throws, and that failure would also stop
an active Goal — so a test that settles on a missing step proves the error path,
not the Goal lifecycle. Three rules keep the suite from passing for the wrong
reason:

- every script is sized through the last natural post-tool turn, and every test
  ends with `assertCleanRun()` (or `assertOnlyFailures()` when a failure is the
  subject), which fails on any assistant outcome that is `error` or `aborted`;
- every anti-loop test asserts the number of provider responses it asked for
  (`assertStepsConsumed`) together with the exact continuation and run counts, so
  a stop is proved to be the Goal lifecycle and not an exhausted script. Two tests
  deliberately let the script run out, because a terminal provider error is what
  settles a session whose Goal is still active; both assert that exact failure;
- the test-only boundary peer bounds its own continuation requests, so a
  composition test is bounded by the fixture rather than by a provider error.

This is verified, not assumed: instrumenting the scripted provider to log every
missing step and running the whole suite reports **zero** missing steps, so no
test settles on a provider error.

## Limitations (later milestones)

- `create_goal` (the model tool) refuses while **any** Goal exists, including a
  complete, blocked, or usage-limited one, because replacing and clearing are
  user-owned actions, confirmed through `/goal <objective>`. The tool description,
  its error message, and this section all say so. Because of that, a blocked or
  usage-limited Goal waits for the user: the model cannot complete or resume it
  either, so it does not quietly resume work the user was told had stopped.
  Restarting it is the user's `/goal resume`, which keeps the identity and starts
  a fresh audit.
- A model-requested pause is corroborated by exact-quote matching plus a
  conservative lexical check that the newer human message contains an
  affirmative pause instruction. The extension does not semantically understand
  the request: unusual phrasing can be refused, and a pause request delivered
  only as an image, or one whose exact words were never sent as text, cannot be
  corroborated. The user can always pause directly with `/goal pause`.
- An edit preserves the Goal identity, creation time, origin, budget, and usage
  history: only the objective changes and the revision advances. Replacement of
  an unfinished Goal gives the session a fresh identity and fresh revisions, and
  preserves the replaced Goal's accounted history on its own superseded record
  rather than transferring any of it. Refining the finish line without replacing
  anything is what `/goal edit` is for.
- Bare `/goal edit` needs a dialog-capable UI. TUI and RPC hosts that implement
  Pi's extension-UI subprotocol can answer the editor dialog; print/JSON mode and
  hosts without a dialog-capable UI get guidance to use
  `/goal edit <objective>` instead of blocking. A dialog that is never answered
  auto-cancels after 120 seconds and leaves the objective unchanged.
- Budget enforcement happens when a turn's usage is accounted, not inside the
  provider loop: the extension cannot preempt a model call Pi has already
  started, so a run in flight can overshoot the budget before it stops. It
  cannot overshoot by unbounded work: the gate blocks every tool call from the
  crossing response onwards, so no further substantive work runs. A tool that
  was already in flight when the budget was crossed still finishes, and its
  usage is accounted: the durable snapshot is written at the next
  post-persistence boundary and carries it.
- Because a durable accounting write never precedes the entry it covers, a crash
  in the narrow window between crossing the budget and the next
  post-persistence boundary leaves the Goal durably `active` with the budget
  already exhausted. It self-corrects on the next accounted turn, and `/goal`
  reports `budgetExhausted: true` with `remaining: 0` in the meantime.
- Token accounting is provider-neutral but not invoice-exact: it excludes cached
  reads and counts cache writes, and it does not reconcile against provider
  billing. Pi's cache-warming `usage` entries are not counted.
- Migrated 0.1.0 Goals report **legacy reconstructed totals**: a one-time
  baseline under the 0.1.0 status-only rule, not exact Goal-owned attribution
  rebuilt under the repaired rules. Only work after the branch-local cutover is
  attributed under the repaired contract.
- Active time is durable to within one accounted second; an unclean exit loses
  at most that.
- A `budget_limited` Goal cannot be resumed with a higher budget yet — that
  arrives with the lifecycle ticket.
- The activity-free and execution-unavailable counters are per session, not
  durable. A restart or an extension reload gives a malfunctioning loop up to
  three more empty turns before it is stopped again; the blocked audit is durable
  and survives a restart, except that the prompt which resumes work after one is a
  user action and starts a fresh audit.
- A third extension loaded after pi-goal can still request its own continuation
  at the same boundary (Pi's last-handler-wins rule). pi-goal declines to request
  one when it should not continue; it does not veto another extension's request.

## Attribution

pi-goal is MIT-licensed. Portions of the Goal lifecycle model and the
continuation, completion, blocked-audit, no-progress, and budget wrap-up prompt
structure are adapted from the OpenAI Codex Goal extension, which is licensed
under the Apache License, Version 2.0. See [NOTICE.md](NOTICE.md) and
[LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt) for the attribution and license
text. The Pi-specific implementation is original and uses Pi's public extension
APIs.

## Development

```sh
npm install        # development dependencies (TypeScript, Node types, Pi packages for typecheck)
npm run typecheck  # tsc --noEmit
npm test           # real-Pi RPC tests (requires `pi` 1.5.1+ on PATH)
```

The automated tests spawn a real `pi --mode rpc` subprocess per test with
temporary working, session, and agent directories (`PI_CODING_AGENT_DIR` /
`--session-dir`; the temp directories are removed when each test finishes), a
scripted test model provider (`test/extensions/scripted-provider.ts`, driven by
`PI_GOAL_TEST_SCRIPT`, including hanging and delayed responses for
interrupted-run and queueing tests), an optional second extension
(`test/extensions/boundary-peer.ts`) for boundary-composition tests, and no
network or model credentials. They assert public behavior end to end: RPC
events, extension notifications, tool results, model context, persisted session
entries, and survival across hard kills and restarts. Set `PI_BINARY` to run
against a specific Pi binary; a missing binary fails fast instead of hanging.

Accounting rules that are impractical to cover exhaustively through the RPC seam
(the token formula, deduplication, the active-time boundaries, budget validation)
are unit-tested directly in `test/accounting.test.mjs` against the accounting
module with an injected clock. The durability boundaries — snapshot aliasing,
replay baselines, terminal-status replay, tombstones — are unit-tested in
`test/store.test.mjs` against a fake Pi API that reproduces Pi's object-retention
semantics, which is the only way to exercise the same-process reconstruction
ordering an RPC test cannot reach. The RPC tests cover everything observable,
including real nested usage (`test/extensions/nested-usage.ts`), real budget
exhaustion with an attempted tool call during the wrap-up, and recovery after both
a graceful and an unclean restart.

### Interactive smoke test

Deterministic RPC tests are the automated gate. The manual real-Pi procedure —
installation, creation, automatic continuation, interactive editing, pause,
resume, status, restart persistence, clear, and the clear tombstone — is in
[docs/smoke-test.md](docs/smoke-test.md).

## Verification

```sh
npm run typecheck  # tsc --noEmit
npm test           # deterministic real-Pi RPC suite (requires pi 1.5.1+ on PATH)
```

`npm test` runs the complete RPC suite plus unit tests for accounting, the
store's durability boundaries, the compact status line, the interactive/headless
editing guard, and the `pi install` package workflow. It needs no model
credentials or network service.

To verify the package installation and the interactive surface by hand, follow
[docs/smoke-test.md](docs/smoke-test.md). The smoke test covers:

- [ ] `pi install ./` and `pi list`
- [ ] `/goal <objective>` creation and immediate work
- [ ] automatic continuation at settlement
- [ ] bare `/goal edit` interactive editing
- [ ] `/goal pause`, `/goal resume`, and `/goal clear`
- [ ] the compact status indicator for `active`, `paused`, `blocked`,
      `usage_limited`, `budget_limited`, and `complete`
- [ ] restart persistence and the clear tombstone
