# pi-goal

Codex-style persistent Goals for [Pi](https://github.com/earendil-works/pi): a `/goal`
command and three model tools (`get_goal`, `create_goal`, `update_goal`) that give a
session a durable, user-controlled objective. While a Goal is active, work
continues automatically at Pi's safe settlement boundary until the model verifies
completion, a genuine blocker persists, a provider usage limit or terminal failure
stops the run, a conservative anti-loop bound is reached, the run is aborted, or
the lifecycle changes.

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
- Refuses to replace an existing Goal (replacement confirmation and `edit`
  arrive in a later milestone). The words `edit`, `pause`, `resume`, and `clear`
  are refused only when they are the *entire* argument — objectives that merely
  begin with one of them (for example "clear the lint errors") are accepted.

### Inspect the current Goal

```
/goal
```

Reports the objective, lifecycle status, identity, timestamps, revision, and the
usage fields that currently exist. Token usage and active time report
`not tracked yet` until usage accounting lands in a later milestone. When a
session with a Goal starts, restores, or reloads, a `Goal ... restored (active)`
notification confirms reconstruction.

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

`update_goal` is the completion and blocked contract. The model calls it with
`{ action: "complete" }` only after every explicit requirement of the objective
is verified against current-state evidence, or with
`{ action: "blocked", blocker: "…" }` once the same genuine blocker has persisted
for at least **three consecutive Goal turns**. Both are terminal: the Goal is
persisted as `complete` or `blocked` and never continues again, including after a
restart or reload. Any other action (`pause`, `resume`, `clear`, a usage-limit or
budget-limit transition) is refused with an explanation, because those
transitions stay with the user.

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
  user can resume one, and resume arrives with the lifecycle milestone.
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
  continues on the next successful run. Pi's own retries are untouched.
- A **usage-limit** error is only classified as one when Pi exposes enough
  evidence, and the evidence is read in two tiers:
  - **Account or plan depletion is decisive.** A provider error code whose meaning
    is a plan usage limit (`insufficient_quota`, `GoUsageLimitError`, code `1308`,
    `subscription_sharing_…_usage_limit_exceeded`), a *usage limit*, *billing or
    plan limit*, *account/plan/period quota*, or *account/plan/period budget* paired
    with an exhaustion verb, an empty credit pool (`out of credits`, `credit balance
    is too low`). This tier survives throttle wording in the same failure, because
    it says the plan itself is used up rather than that a rate was hit —
    `429 rate limit reached; insufficient_quota: current quota exhausted` is a usage
    limit, not a throttle. It does not survive a `reached` whose object is a lookup:
    `The account quota service reached a timeout while checking your account` is a
    check that timed out, and qualifying the noun does not change that. Only the
    noun phrase the verb governs is inspected, so `You have reached your usage
    limit; please check your plan` stays genuine exhaustion — and so does naming the
    API or the service as the *scope* of the limit (`You have reached your usage
    limit for the Anthropic API`, `Monthly usage limit reached for this service`),
    because the verb reached a limit, not a lookup.
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
  | A lookup or a throttle, including a *qualified* one — what decides is the verb's object, not how the subject was named | `The quota service reached a timeout while checking your account`, `The account quota service reached a timeout while checking your account`, `The billing limit check reached a timeout…`, `The spending limit lookup reached a timeout…`, `The monthly budget service reached a timeout…`, `The quota service reached a rate limit while checking your account`, `The usage limit check reached a timeout while checking your account`, `The billing service reached its rate limit while checking your account` |
  | A negated statement | `You have not exceeded your quota`, `Your quota is not exceeded`, `Your quota has not been exceeded`, `Your plan limit has not been reached`, `No quota exceeded` |
  | An internal or per-request budget | `Retry budget exhausted after 3 attempts`, `token budget exceeded for this request`, `The request is out of budget for this call` |
  | Bare account vocabulary | `Your billing address could not be verified; update your account details`, `Billing service temporarily unavailable; please retry later` |
- Every stop is explained to the user through a notification and recorded on the
  Goal, so `get_goal` and bare `/goal` report the blocker and the audit count.
- **User actions reset the counters.** A prompt the user types (including one
  queued while the agent is busy) and an abort both restart the blocked audit and
  the anti-loop counters, and a replacement Goal starts from a fresh record.

## Persistence model

- Goal snapshots are stored as **custom session entries** (`goal-state`), which
  live outside the model context. The last snapshot on the active session branch
  wins, so restart, resume (`--continue` / `--session`), and extension reload
  (`/reload`, or any runtime replacement) reconstruct the state without the user
  restating the objective. Reconstruction also runs after `session_tree`
  navigation and on forked sessions; dedicated branch-navigation coverage lands
  with the branch-state ticket.
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
- Creation is durability-first: the snapshot is written, the kickoff triggers the
  file flush, and only after the snapshot is confirmed on disk is the Goal
  announced (and made visible to `get_goal`). If writing fails (unwritable
  session file or storage), creation reports a clear persistence error, leaves
  no Goal behind, retracts any in-memory state with a durable tombstone
  snapshot, and `/goal <objective>` can simply be retried.
- Interrupting the kickoff (Ctrl+C, killing the process, a hung model) does not
  lose the Goal: the snapshot and kickoff are already on disk and are restored
  by the next session.
- Concurrent `/goal` commands (for example two issued while Pi is busy with a
  run) are serialized: exactly one Goal is created and the losing command is
  refused with the already-set warning — a silent replacement cannot happen.
- Ephemeral sessions (started with `--no-session`) cannot persist a Goal:
  creating one returns a clear error instead of claiming durable storage.
- Sessions without a Goal behave exactly as before; installing the extension
  only adds the command, the three tools, and the state they manage.

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

- No `edit`, `pause`, `resume`, or `clear` lifecycle commands yet (only the bare
  words are reserved as future subcommands), so an active Goal can only be ended
  by the model completing it, by the model reporting a persistent blocker, by a
  conservative stop, by the user aborting the run, or by a failure.
- `create_goal` refuses while **any** Goal exists, including a complete, blocked,
  or usage-limited one, because replacement and clearing arrive with the
  lifecycle ticket. The tool description, its error message, and this section all
  say so. Because of that, a blocked or usage-limited Goal currently waits for the
  user: the model cannot complete it either, so it does not quietly resume work
  the user was told had stopped.
- No token budget, usage accounting, or active-time tracking yet, so unattended
  work has no token bound. The anti-loop stops bound a malfunctioning loop, not a
  healthy one: an active Goal whose runs keep completing keeps being continued.
- The activity-free and execution-unavailable counters are per session, not
  durable. A restart or an extension reload gives a malfunctioning loop up to
  three more empty turns before it is stopped again; the blocked audit is durable
  and survives a restart, except that the prompt which resumes work after one is a
  user action and starts a fresh audit.
- A third extension loaded after pi-goal can still request its own continuation
  at the same boundary (Pi's last-handler-wins rule). pi-goal declines to request
  one when it should not continue; it does not veto another extension's request.
- No status/widget UI yet.

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
#    -> status report with the objective, "active", revision, timestamps.
# 3. Let the agent finish a turn.
#    -> it continues on its own; the continuation prompt restates the objective
#       and carries the no-progress and blocked-audit contract.
# 4. /reload
#    -> "Goal ... restored (active)" notification.
# 5. /goal
#    -> the same objective is reported after the extension reload.
# 6. Exit (Ctrl+D), then: pi -c
# 7. /goal
#    -> the Goal survives the restart and is restored on resume.
```

To see a conservative stop interactively, give the agent a Goal it cannot make
progress on — for example an objective that needs a credential the environment does
not have — and let it run. After the same blocker has been reported for three
consecutive Goal turns the Goal becomes `blocked`, bare `/goal` reports the blocker
and the audit count, and no further turn starts on its own.
