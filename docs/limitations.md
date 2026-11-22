# Limitations

Known boundaries of the current model: what the extension does not understand,
what it cannot preempt, and what is intentionally left to the user.

[← README](../README.md) · See also [tools](tools.md)

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
- `create_goal` is corroborated by exact-quote matching plus a conservative
  deterministic clause-order check. The extension does not semantically
  understand the request: unusual phrasing can be refused, a request delivered
  only as an image cannot be corroborated, and other languages retain
  `/goal <objective>` as the direct creation path. A quotation is checked
  against the one currently authoritative raw interactive/RPC input or Pi
  custom message, so a request whose exact words were never sent as text, or
  one that a newer message has replaced, is refused with `goal: null`. The user
  can always create a Goal directly with `/goal <objective>`.
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
- Pi nested tool usage (`toolResult.usage`) is counted, but model usage inside an
  independent subprocess is not visible automatically. Each `pi-rex-subagent`
  child is a separate Pi session, so its usage does not count toward the parent
  Goal or its budget until a parent tool reports the child's delta as
  `toolResult.usage`. The proposed bridge is specified in
  [Subagent usage reporting](subagent-usage.md).
- pi-goal emits Pi notifications and durable Goal entries, not Codex's
  `ThreadGoalUpdated` protocol events, analytics events, or otel metrics. A local
  integration could subscribe to a future `pi.events` event; hosted telemetry
  would additionally require an explicit exporter and privacy policy.
- Active time is durable to within one accounted second; an unclean exit loses
  at most that.
- The activity-free and execution-unavailable counters are per session, not
  durable. A restart or an extension reload gives a malfunctioning loop up to
  three more empty turns before it is stopped again; the blocked audit is durable
  and survives a restart, except that the prompt which resumes work after one is a
  user action and starts a fresh audit.
- A third extension loaded after pi-goal can still request its own continuation
  at the same boundary (Pi's last-handler-wins rule). pi-goal declines to request
  one when it should not continue; it does not veto another extension's request.
