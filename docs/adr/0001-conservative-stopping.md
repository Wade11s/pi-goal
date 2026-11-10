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
   the same blocker has been reported for three consecutive Goal turns. Reports
   are counted per Goal turn, compared after normalizing case, whitespace, and
   trailing punctuation, and persisted on the Goal record so compaction and a
   session restore cannot hand the model three fresh turns.
2. **Activity-free turns are bounded.** A Goal turn with no tool call, no output,
   and no reasoning is a malfunctioning continuation. Three in a row stop the Goal
   as `blocked`. Any activity resets the counter.
3. **Execution-unavailable turns are bounded, and ordinary command failures are
   excluded.** A turn counts only when a shell tool ran and failed for an
   infrastructure reason — the executable is missing, the process could not be
   spawned — which Pi reports as an error result with a measured duration and no
   exit code. A command that ran and exited non-zero carries an exit code and is
   normal work, so it never counts. Three unavailable turns in a row stop the Goal.
4. **Provider failures are classified from Pi's evidence.** A terminal provider
   error becomes `usage_limited` only when the error text or a provider diagnostic
   says the quota, budget, billing, or subscription usage limit is exhausted.
   Anything else stops the continuation for that run, is surfaced to the user, and
   leaves the Goal active so the next successful run resumes it.
5. **User actions reset everything.** A prompt the user types (including one
   queued while the agent is busy) and an abort both end the unattended phase, so
   the counters and the blocked audit start over. A replacement Goal starts from a
   fresh record for the same reason.

## Consequences

- Stopping needs no model cooperation and no judge service: the same events Pi
  already emits (`message_end`, `tool_execution_end`, `turn_end`,
  `agent_before_settle`) are enough, and the rules are unit-testable and
  reproducible.
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
  (shell tools only, error results only, measured duration only, no exit code) to
  keep that risk small, and it is covered by a negative-control test.
