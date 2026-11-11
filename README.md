# pi-goal

Codex-style persistent Goals for [Pi](https://github.com/earendil-works/pi): a `/goal`
command and three model tools (`get_goal`, `create_goal`, `update_goal`) that give a
session a durable, user-controlled objective. While a Goal is active, work
continues automatically at Pi's safe settlement boundary until the model verifies
completion, the run is aborted or fails, the lifecycle changes, or the Goal's
token budget runs out.

Requires **Pi 1.5.1 or newer**. The extension uses only public extension APIs and
does not patch Pi core.

## Install

From a checkout of this repository:

```sh
pi install ./            # add to personal settings
pi install --local ./    # or project-local (.pi/settings.json, after project trust)
```

Or try it once without installing:

```sh
pi -e ./
```

The package declares its entry point in `package.json` (`pi.extensions`), has no
runtime dependencies, and uses Pi's host-provided packages.

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

Setting a new objective while an unfinished Goal exists is a *replacement*: the
old Goal is discarded (fresh identity, no retained history) and a new one
starts. A replacement never happens silently — `/goal <objective>` shows a
confirmation dialog first, and a declined (or timed-out, or dismissed) dialog
keeps the current Goal untouched. The dialog is answered over the RPC
extension-UI subprotocol in RPC mode, so headless hosts confirm the same way an
interactive user does. Modes without any UI cannot confirm and keep the current
Goal (use `/goal clear` then `/goal <objective>` there). Replacing a **complete**
Goal asks nothing, because nothing unfinished is discarded.

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
(active)` notification confirms reconstruction. A compact one-line indicator
(`goal_1a2b3c4d · active · 48210 tok · 201790 left · 5m 12s`) is published to
Pi's status/footer surface whenever it exists.

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
- `/goal resume` restarts eligible (paused) work: the transition is durable,
  then a resume kickoff message restates the objective and asks for a fresh
  evidence audit of the retained progress. Resuming while another run is in
  flight steers the resume message into it rather than waiting for idle.
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
they are always recoverable from the branch.

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

`update_goal` supports two actions. `complete` is the completion contract: the
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
  navigation and on forked sessions; dedicated branch-navigation coverage lands
  with the branch-state ticket.
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

## How the tests stay honest

A scripted-provider step that runs out throws, and that failure would also stop
an active Goal — so a test that settles on a missing step proves the error path,
not the Goal lifecycle. Two rules keep the suite from passing for the wrong
reason:

- every script is sized through the last natural post-tool turn, and every test
  ends with `assertCleanRun()` (or `assertOnlyFailures()` when a failure is the
  subject), which fails on any assistant outcome that is `error` or `aborted`;
- the test-only boundary peer bounds its own continuation requests, so a
  composition test is bounded by the fixture rather than by a provider error.

This is verified, not assumed: instrumenting the scripted provider to log every
missing step and running the whole suite reports **zero** missing steps, so no
test in any file settles on a provider error.

## Limitations (later milestones)

- `create_goal` (the model tool) refuses while **any** Goal exists, including a
  complete one: replacing is a user-owned action, confirmed through `/goal
  <objective>`. The tool description, its error message, and this section all
  say so.
- A model-requested pause is corroborated by exact-quote matching plus a
  conservative lexical check that the newer human message contains an
  affirmative pause instruction. The extension does not semantically understand
  the request: unusual phrasing can be refused, and a pause request delivered
  only as an image, or one whose exact words were never sent as text, cannot be
  corroborated. The user can always pause directly with `/goal pause`.
- An edit preserves the Goal identity, creation time, origin, budget, and usage
  history: only the objective changes and the revision advances. Replacement of
  an unfinished Goal instead discards the old Goal entirely (fresh identity,
  fresh revisions). Refining the finish line without discarding anything is what
  `/goal edit` is for.
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
- Active time is durable to within one accounted second; an unclean exit loses
  at most that.
- A `budget_limited` Goal cannot be resumed with a higher budget yet — that
  arrives with the lifecycle ticket.
- No blocked audit (the same genuine blocker for three consecutive Goal turns),
  no usage-limit classification, and no anti-loop stop for repeated
  activity-free automatic responses. Until those land, an active Goal whose runs
  keep completing will keep being continued; the model is instructed to report a
  persistent blocker instead of spinning, and aborts and provider errors stop
  continuation immediately.
- A third extension loaded after pi-goal can still request its own continuation
  at the same boundary (Pi's last-handler-wins rule). pi-goal declines to request
  one when it should not continue; it does not veto another extension's request.
- No root `GLOSSARY.md` or `docs/adr/` entries.

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

Deterministic RPC tests are the automated gate; this manual procedure verifies
interactive installation and rendering:

```sh
cd /path/to/this/checkout
pi -e ./
# In Pi:
# 1. /goal Write a haiku about persistent sessions in a file called haiku.txt
#    -> notification "Goal ... created and activated", agent starts working.
# 2. /goal
#    -> status report with the objective, "active", revision, timestamps, token
#       usage, active time, and remaining capacity.
# 3. Let the agent finish a turn.
#    -> it continues on its own; the continuation prompt restates the objective.
# 4. /goal edit Write the haiku and a limerick about steering
#    -> "objective updated"; the running work is steered to the new objective.
# 5. /goal pause
#    -> "Goal ... paused"; the current turn finishes and nothing continues.
# 6. /goal
#    -> status "paused" with the paused-state hint line.
# 7. /goal resume
#    -> "Goal ... resumed"; work restarts from retained progress.
# 8. /goal Write a sonnet instead
#    -> confirmation dialog; answer No -> "Replacement cancelled".
# 9. /reload
#    -> "Goal ... restored (active)" notification, and /goal reports the same
#       objective and the same accounted usage after the reload.
# 10. Exit (Ctrl+D), then: pi -c
# 11. /goal
#     -> the Goal, its usage, and its active time survive the restart.
# 12. /goal clear
#     -> "Goal ... cleared"; the session is back to ordinary prompts.
# 13. /reload
#     -> no "restored" notification: the tombstone means no Goal comes back.
# 14. /goal
#     -> "No Goal is set in this session."
#
# Budget check (optional):
# 15. /goal --budget 1 Write a haiku
#     -> the Goal is created, the very next accounted turn exhausts the budget,
#        a warning notification reports it, exactly one wrap-up summary is
#        produced, and the Goal stops continuing (status: budget_limited).
```
