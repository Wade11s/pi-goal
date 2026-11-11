# ADR-0001: Conservative stopping is deterministic and extension-owned

- Status: accepted
- Date: 2026-11-10
- Relates to: the parent spec "Codex-style persistent /goal for Pi" (issue #1) and issue #5

## Context

An active Goal keeps asking for one more provider request at Pi's safe settlement
boundary until something stops it. The model can stop it by completing the Goal or
by reporting a genuine blocker, but an unattended loop cannot rely on the model
behaving: a malfunctioning continuation, a broken shell, or an exhausted provider
quota would otherwise burn turns indefinitely.

The parent spec requires stopping that is conservative in both directions. It must
stop a malfunctioning loop, and it must not stop useful work by mistaking normal
work for a malfunction. Two failure modes are equally bad: an unattended retry
loop that consumes tokens, and a Goal that quits on the first failing test.

## Decision

Every automatic stop is a deterministic rule the extension owns, evaluated from
observable Pi events, with thresholds that are constants rather than settings.

1. **The blocked audit is enforced, not requested.** `update_goal` accepts
   `blocked` with a blocker description, but the Goal only becomes `blocked` once
   the same blocker has been reported for three *consecutive* Goal turns. Reports
   are counted per Goal turn, compared after normalizing case, whitespace, and
   trailing punctuation, and persisted on the Goal record so compaction cannot hand
   the model three fresh turns. A Goal turn that reports no blocker — it made
   progress, verified a wait, or simply had nothing to report — breaks the chain,
   and that break is persisted too, because an in-memory-only reset would let a
   reload resurrect a count the model already invalidated. What durability cannot
   do is outlast a user action: the prompt that resumes work after a restart is
   itself a user action and starts a fresh audit, which is the intended trade
   between "the user stepped in" and "the loop kept its count".
2. **Activity-free turns are bounded.** An *automatic* Goal turn with no tool call,
   no output, and no reasoning is a malfunctioning continuation. Three in a row
   stop the Goal as `blocked`. Any activity resets the counter, and a kickoff or a
   user-started run never counts, because the user is watching those.
3. **Execution-unavailable turns are bounded, and ordinary command failures are
   excluded.** A turn counts only when a shell tool ran and failed for an
   infrastructure reason — the executable is missing, the process could not be
   spawned — which Pi reports as an error result with a measured duration and no
   exit code. A command that ran and ended in any of the ways Pi reports as an
   ordinary outcome (a non-zero exit code, a timeout, no exit code, an abort)
   carries that text and is normal work, so it never counts. The chain is only
   broken by a shell command that actually ran, which Pi marks with a measured
   duration: a successful `get_goal` or `read` says nothing about whether the shell
   works, and the continuation contract tells the model to read state, so that mix
   is the ordinary shape of a broken shell rather than a rare one. A shell call
   that never ran — invalid arguments, a permission block, an abort before start —
   carries no duration and is ignored entirely, because it is neither an execution
   failure nor evidence that the shell works, and counting it either way would let
   it hide a genuine spawn failure in the same Goal turn. Three unavailable turns in
   a row stop the Goal.
4. **Provider failures are classified from Pi's evidence, and only definitive
   exhaustion evidence counts.** A terminal provider error becomes `usage_limited`
   only when the error text or a provider diagnostic carries one of two kinds of
   evidence:
   - *decisive* account or plan depletion — a provider usage-limit error code, a
     usage limit, a billing or plan limit, an account/plan/period quota or budget,
     or an empty credit pool. This tier survives throttle wording in the same
     failure, because it says the plan itself is used up rather than that a rate
     was hit, but not a `reached` whose object is a lookup: "The account quota
     service reached a timeout" is a check that timed out, and qualifying the noun
     changes nothing. What decides is the head of the noun phrase the verb governs,
     which is also why "You have reached your usage limit; please check your plan"
     stays genuine exhaustion, and so does naming the API or the service as the
     scope of the limit — "You have reached your usage limit for the Anthropic API"
     and "Monthly usage limit reached for this service" reached a usage limit, not a
     lookup;
   - a bare quota plus an exhaustion verb, which is *not* decisive on its own,
     because that is also exactly how a provider describes a per-minute quota
     metric that resets within a minute. It only counts when its sentence is not
     about a rate dimension.

   Bare account vocabulary, internal and per-request budgets, negated statements,
   and lookups are all excluded, because `usage_limited` is terminal and a false
   positive would wedge the session's Goal. Negation is checked inside the matched
   phrase as well as in front of it, since "quota is not exceeded" and "not
   exceeded your quota" are equally clear statements that the plan is fine, and a
   leading "no" counts too. Every match of every pattern is scanned, so a rejected
   earlier lookup cannot hide a later explicit statement of exhaustion. Exhaustion evidence is evaluated before anything else, so a
   failure that reports both a throttle and an exhausted quota is classified by the
   quota. Anything else stops the continuation for that run, is surfaced to the
   user, and leaves the Goal active so the next successful run resumes it.
5. **User actions reset everything.** A prompt the user types (including one
   queued while the agent is busy) and an abort both end the unattended phase, so
   the counters and the blocked audit start over. A replacement Goal starts from a
   fresh record for the same reason.

## Consequences

- Stopping needs no model cooperation and no judge service: the same events Pi
  already emits (`message_start`, `message_end`, `tool_execution_end`,
  `agent_start`, `agent_end`, `agent_before_settle`, `session_compact`) are enough,
  and the rules are unit-testable and reproducible. Observations are aggregated per
  Goal turn and evaluated once, at the settlement boundary, because a Goal turn can
  span several runs — Pi retries a failed provider request with `agent.continue()`,
  and it compacts for overflow recovery and retries the same response — and only
  the whole turn says whether the Goal could act. Evaluating at an intermediate
  `agent_end` would judge a run Pi is about to retry and then misread the retry as a
  fresh user run, which is exactly what wiped a blocked audit on a transient error
  before this was fixed. The recoverable-length case needs the `session_compact`
  signal, because that run *completed*: an error outcome alone would classify its
  retry as a user run, and a Goal turn whose response was truncated, compacted, and
  retried empty would never reach an anti-loop bound.
- A Goal that stops is never silently restarted. `blocked` and `usage_limited` are
  terminal for continuation, and only a user decision resumes them — which is why
  resume is deliberately not a model tool.
- The thresholds trade tokens for patience. Three turns is enough for a transient
  failure to clear and small enough that a broken loop costs three turns, not
  thirty. Making them constants rather than settings means a drifted configuration
  cannot silently widen an unattended safety bound.
- The activity-free and execution-unavailable counters are per session, because
  they describe a live malfunction; the blocked audit is durable, because it
  describes a condition the model already reported. A restart therefore gives a
  malfunctioning loop at most three more turns, while a genuine blocker keeps its
  count.
- Because a shell tool's failure is read from Pi's result shape, a provider or Pi
  version that changes how shell failures are reported could make an ordinary
  failure look like an execution failure. The classification is deliberately narrow
  (shell tools only, error results only, measured duration only, no exit code, and
  none of the ordinary-outcome texts) to keep that risk small, and it is covered by
  negative-control tests for both a non-zero exit and a timeout.
- Usage-limit classification has the mirror-image risk: a false positive is
  terminal for continuation and needs a user decision to undo, so the evidence bar
  is an exhaustion verb next to a quota, usage-limit, budget, or credit noun —
  never bare account vocabulary. A false negative only costs one more surfaced
  terminal error.
