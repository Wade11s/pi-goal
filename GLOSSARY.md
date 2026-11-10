# GLOSSARY

Domain vocabulary for pi-goal. Terms are used exactly as defined here in issue
titles, code, tests, and documentation; if a concept is missing, that is a gap to
close rather than a licence to invent a synonym.

| Term | Definition |
| --- | --- |
| **Goal** | A durable, session-scoped objective with a lifecycle status, a stable identity, and usage accounting. Persisted as custom session entries and reconstructed from the active session branch. One Goal per session at a time. |
| **Objective** | The user's finish line, stored verbatim and never rewritten by the extension. The one part of a Goal message the extension does not author, which is why it is always rendered as delimited, encoded data. |
| **Lifecycle status** | One of `active`, `paused`, `blocked`, `usage_limited`, `budget_limited`, `complete`. Only `active` continues automatically; every other status is a stop. Clearing is a durable tombstone, not a status. |
| **Continuation** | One further provider request pi-goal asks for at `agent_before_settle`, delivered as a `goal-continuation` custom message that restates the objective and asks for an evidence audit. Never scheduled by a timer and never driven from `agent_end`. |
| **Goal turn** | One run of Goal work: the run the user started (the kickoff) plus every run Pi started because pi-goal asked for a continuation. The unit the anti-loop counters and the blocked audit count. |
| **Activity** | Anything in a Goal turn that could move the objective: a tool call, non-whitespace output, or non-empty reasoning. Its absence is what an activity-free turn means. |
| **Completion audit** | The requirement-by-requirement, current-state-evidence check the model performs before calling `update_goal` with `complete`. Model-executed and extension-enforced only at the lifecycle level. |
| **Blocked audit** | The rule that the same genuine blocker must persist for at least three consecutive Goal turns before a Goal may become `blocked`. Enforced by the extension, not trusted to the model. |
| **Blocker** | The genuine condition preventing progress, as the model reports it through `update_goal`. Equivalent blockers (same condition, different wording) count as one; a genuinely different blocker restarts the audit. |
| **No-progress check** | The classification of the previous Goal turn as **progress**, a **verified wait**, or **no progress**. A verified wait polls a specific live handle; status narration and unexecuted plans are no progress. |
| **Conservative stop** | A deterministic, extension-owned stop that does not depend on the model's cooperation: repeated activity-free Goal turns, repeated execution-unavailable Goal turns, or a terminal provider failure. |
| **Activity-free turn** | A Goal turn with no activity at all. Three in a row stop the Goal as `blocked`. |
| **Execution-unavailable turn** | A Goal turn in which the model tried to run a command and the shell itself could not run it. An ordinary command failure (a non-zero exit code) is not one. Three in a row stop the Goal as `blocked`. |
| **Usage limit** | A provider failure whose evidence says the account, plan, or budget is exhausted. Moves the Goal to `usage_limited`. A transient rate limit is not one. |
| **Terminal provider error** | A provider failure that is not a usage limit and that Pi is not retrying. Stops the continuation for that run, is surfaced, and leaves the Goal active. |
| **User action** | A prompt the user types (including one queued while the agent is busy) or an abort. Ends the unattended phase and resets the anti-loop counters and the blocked audit. |
| **Replacement Goal** | A new Goal identity taking over a session's single Goal slot. Arrives with the lifecycle milestone; it resets every counter because the old ones describe work that no longer exists. |
| **Token budget** | An optional bound on unattended model usage, with an extension-level default and maximum. Reserved for the budget milestone. |
| **Active elapsed time** | Time accrued while a Goal is active in a live session, excluding paused durations and process downtime. Reserved for the budget milestone. |
