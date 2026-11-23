# Limitations

Known boundaries of the current model: what the extension does not understand,
what it cannot preempt, and what is intentionally left to the user.

[← README](../README.md) · See also [tools](tools.md) ·
[attachments](behavior/attachments.md) · [history](behavior/history.md)

- `create_goal` (the model tool) refuses while **any** Goal exists, including a
  complete, blocked, or usage-limited one, because replacing and clearing are
  user-owned actions, confirmed through `/goal <objective>`. The tool description,
  its error message, and this section all say so. Because of that, a blocked or
  usage-limited Goal waits for the user: the model cannot complete or resume it
  either, so it does not quietly resume work the user was told had stopped.
  Restarting it is the user's `/goal:resume`, which keeps the identity and starts
  a fresh audit.
- A model-requested pause is corroborated by exact-quote matching plus a
  conservative lexical check that the newer human message contains an
  affirmative pause instruction. The extension does not semantically understand
  the request: unusual phrasing can be refused, and a pause request delivered
  only as an image, or one whose exact words were never sent as text, cannot be
  corroborated. The user can always pause directly with `/goal:pause`.
- `create_goal` is corroborated by exact-quote matching plus a conservative
  deterministic clause-order check. The extension does not semantically
  understand the request: unusual phrasing can be refused, a request delivered
  only as an image cannot be corroborated, and other languages retain
  `/goal <objective>` as the direct creation path. A quotation is checked
  against the one currently authoritative raw interactive/RPC input or Pi
  custom message, so a request whose exact words were never sent as text, or
  one that a newer message has replaced, is refused with `goal: null`. The user
  can always create a Goal directly with `/goal <objective>`.
- V1 attachments are explicit **local** text files, local PNG/JPEG/GIF/WebP
  images, or explicit **HTTPS** remote image URLs selected with
  `--remote-image`. Remote fetching is one-shot at creation: a later change at
  the source URL does not alter the Goal. The fetch refuses non-public
  destinations — including redirect targets and every DNS result — and pins the
  validated addresses into the connection, so DNS cannot change the destination
  between resolution and fetch. It trusts the public origin and the resolver's
  answer themselves, and it does not authenticate the image's contents beyond
  the media-type sniff and size bounds. SVG and unknown image types are rejected
  from the actual bytes, and local paths containing whitespace are not
  representable by the current leading-option parser. Pi exposes no Codex
  composer pending-draft object, so pi-goal never infers attachments from plain
  arguments; the explicit `/goal --file … --image … --remote-image …` flow is
  the supported alternative. A model without image input depends on Pi's normal
  image handling rather than pi-goal inventing a vision capability.
- Committed attachment artifacts survive clear and replacement so historical
  branches remain reconstructable. **V1 has no destructive automatic garbage
  collection**: up to 25 MiB can remain for each historical Goal until the user
  removes the session's `pi-goal-store` deliberately. Only artifacts from a
  creation that never committed may be retracted automatically. Copying a
  session file without its sibling artifact store leaves its Goals restorable
  but their attachments unverifiable; automatic Continuation then stops with an
  explicit error and no artifact-driven Lifecycle change until the original
  bytes are restored or the Goal is replaced.
- `/goal:history` reports the branch's `goal-history` records as they are. A
  process that dies between a lifecycle commit and the history append leaves one
  transition with no record: the timeline never invents a placeholder for it, and
  the authoritative Goal — reconstructed from `goal-state` alone — is unaffected.
  A record that is present but unreadable is skipped and counted rather than
  trusted, so a hand-edited or truncated file produces a shorter timeline with a
  notice, never a different Goal.
- An edit preserves the Goal identity, creation time, origin, budget, attachment
  manifest, and usage history: only the objective changes and the revision
  advances. Changing attachments requires a Replacement Goal. Replacement of
  an unfinished Goal gives the session a fresh identity and fresh revisions, and
  preserves the replaced Goal's accounted history on its own superseded record
  rather than transferring any of it. Refining the finish line without replacing
  anything is what `/goal:edit` is for.
- Bare `/goal:edit` needs a dialog-capable UI. TUI and RPC hosts that implement
  Pi's extension-UI subprotocol can answer the editor dialog; print/JSON mode and
  hosts without a dialog-capable UI get guidance to use
  `/goal:edit <objective>` instead of blocking. A dialog that is never answered
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
  billing. Pi's cache-warming `usage` entries are not counted. External child
  usage uses observation-time ownership in V1: work performed while a Goal is
  paused but first observed after resume can belong to the observing segment,
  not the segment in which the child executed it. Strict lifecycle attribution
  is not claimed, and work a crashed child never persisted to its session or a
  durable usage snapshot cannot be recovered.
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
- `goal.enabled` is read from Pi's effective settings at session start, so a
  changed value takes effect on the next session start or reload, never
  retroactively for work already in flight. A non-boolean value is reported once
  and ignored, which keeps admission enabled exactly as an unset value does.
- Disabling the extension is not a pause: an active-but-disabled Goal keeps
  accruing Active elapsed time until the user pauses it, and no new Goal-owned
  usage is admitted while it is disabled, because every run starts from a user
  prompt that closes the admission segment. Work already queued when the
  extension is disabled is delivered as ordinary work rather than dropped.
- `goal.resumePrompt` (default `false`) is asked **once per session start** and
  only for a restored `paused` Goal with a dialog-capable UI. Restarting again
  asks again; there is no durable "already asked" marker. It never prompts for
  `active`, `complete`, `blocked`, `usage_limited`, or `budget_limited` work, and
  branch navigation does not ask even when it restores a paused Goal. The dialog
  is bounded by its own safety timeout, so an unanswered prompt resolves to "no"
  rather than waiting forever, and because `session_start` never awaits it a
  headless RPC host is usable while the request is still pending.
- A third extension loaded after pi-goal can still request its own continuation
  at the same boundary (Pi's last-handler-wins rule). pi-goal declines to request
  one when it should not continue; it does not veto another extension's request.
- Session naming is opt-in and one-shot in effect: it names only a session that
  has no name yet, and only on a creation. A session whose name came from an
  earlier Goal keeps that name until the user renames it, and pi-goal never
  removes a name — clearing a Goal does not clear the session name, because the
  name describes the session's history rather than the Goal that is current.
- `goal.sessionNameFromObjective` is read from Pi's effective settings at session
  start, so a changed value takes effect on the next session start or reload,
  never for a Goal that already exists. A non-boolean value is reported once and
  ignored, which leaves sessions unnamed exactly as an unset value does.
- `goal.planTool` (default `false`) is also read at session start, and it is the
  one setting here that changes what is *registered*. Because Pi has no
  unregister-tool seam, a value changed mid-session leaves the registration in
  place: the tool then refuses its calls — saying the setting is off and that a
  reload reconciles the two — until the session is reloaded.
- The plan tool's record is the model's own narration, never verified progress.
  Nothing checks that a `completed` step really happened, and a plan is not
  surfaced by `get_goal`, bare `/goal`, or any event: the model reads it back from
  its own tool result. It is a visibility aid for long Goals, not an audit trail.
- A plan is only ever recorded for a session that has a Goal, so a plan written
  while a Goal was active stays on the branch after a clear or a replacement as
  ordinary session history. It describes no current Goal, and no Goal record is
  derived from it.
- If another extension already registered a tool named `update_plan`, pi-goal
  registers nothing, reports why, and no Continuation mentions the tool. pi-goal
  will not replace another extension's tool for the sake of a conventional name,
  and the tool's own registration is confirmed rather than assumed for the same
  reason.
- Metrics are local and best-effort: `pi-goal:metrics` delivery has no queue,
  retry, spool, acknowledgement, or replay. A consumer that needs completeness
  must persist and verify records itself and treat gaps as possible. pi-goal
  ships no hosted exporter, performs no network telemetry, accepts no analytics
  endpoint or credential, and installs no exporter dependency; a companion
  exporter is a separate install whose consent, redaction, retry, delivery
  guarantee, and credentials are its own responsibility.
