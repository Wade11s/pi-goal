# Automatic continuation

What Pi does on its own while a Goal is active, and the no-progress contract
every continuation carries.

[← README](../README.md) · See also [stopping](stopping.md) ·
[accounting](accounting.md)

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
  polled), or **no progress** (status narration and unexecuted plans). While a
  blocked audit is open it restates that audit's Blocker identity, latest
  description, and count, and it states the three-consecutive-Goal-turn blocked
  audit the extension enforces.
- The continuation requests exactly one further provider request per
  settlement. If queued work already causes that request, Pi satisfies the
  decision with it and makes no extra one.
- Entries proposed by other extensions at the same boundary are chained, never
  replaced.
- A run that was aborted or that ended in a provider error is a hard exit: Pi
  owns retries, so the Goal does not add a retry loop of its own. The Goal stays
  active and continues on the next successful run.
