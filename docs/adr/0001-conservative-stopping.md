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
   the same blocker has been reported for three *consecutive* Goal turns. The first
   valid report omits a blocker ID; the extension issues and persists an opaque
   **Blocker identity**. A later report of the same condition reuses the current
   ID, so differently worded descriptions and changed next steps still advance the
   audit. Omitting the ID reports a genuinely different condition and starts a new
   chain at one with a fresh ID. An unrecognized or non-current ID is rejected
   without mutation; free-text similarity is never a fallback. The model therefore
   judges semantic equivalence by choosing whether to reuse the ID, while the
   extension alone enforces identity, consecutiveness, and the threshold. Incorrect
   reuse can merge different blockers, while an omitted ID can split one condition
   and delay stopping; the latter is the safer failure direction.

   Reports are counted per Goal turn and persisted on the Goal record so compaction
   cannot hand the model three fresh turns. The first valid report owns its turn;
   later calls in that turn are idempotent and cannot advance, reset, or replace
   the audit, even with different text or a different ID. A rejected call does not
   own the turn, so a corrected call in the same turn records the turn's first
   valid report. A Goal turn that reports no blocker — it made progress, verified a
   wait, or simply had nothing to report — breaks the chain, and that break is
   persisted too, because an in-memory-only reset would let a reload resurrect a
   count the model already invalidated. What durability cannot do is outlast a user
   action: the prompt that resumes work after a restart is itself a user action and
   starts a fresh audit, which is the intended trade between "the user stepped in"
   and "the loop kept its count". Resume and Replacement Goals also start fresh.

   The tool and continuation contracts both require a report on every Goal turn
   while a genuine blocker persists, rather than waiting until the threshold is
   already satisfied. Structured tool responses, `get_goal`, and continuations
   expose the open audit's current ID, latest description, and count so the model
   can reuse the identity after compaction or restart; the human-facing status
   shows the description and the count and deliberately does not show the opaque
   ID. The third consecutive report
   performs the transition; earlier reports are recorded and refused.
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
     usage limit, a billing, plan, spending, account, or subscription limit (in
     either word order), an account/plan/period quota or budget, or an empty credit
     pool. This tier survives throttle wording in the same
     failure, because it says the plan itself is used up rather than that a rate
     was hit, but not a `reached` whose object is a lookup: "The account quota
     service reached a timeout" is a check that timed out, and qualifying the noun
     changes nothing. What decides is the *head noun* of the object the verb governs
     — the last noun in the phrase, which is what the phrase is, and which a
     trailing comma, an exclamation mark, or a trailing adverb cannot hide — which is also
     why "You have reached your usage limit; please check your plan" stays genuine
     exhaustion, and so does naming the API or the service as the scope of the
     limit — "You have reached your usage limit for the Anthropic API", "Monthly
     usage limit reached for this service", "You have reached the API usage limit",
     and "You have reached your service usage limit" all reached a usage limit, not
     a lookup. The head cuts both ways: "You have reached the quota service", "You
     have reached the account quota service", "You have reached the billing limit
     check", and "You have reached the usage limit service" all have a service or a
     check as their head, so the limit vocabulary in front of them is a modifier and
     the object is the lookup — and so do the same phrases with trailing punctuation
     or a retry clause after them, because the head noun is read rather than the raw
     end of the phrase. The phrasal verb "reached out to" reaches what follows its
     particle. A rate dimension is checked first, so "reached a rate limit" and
     "reached a quota metric" stay throttles whatever else the phrase says;
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
   user, and leaves the Goal active so the next successful run resumes it. That
   description is of an *active* Goal, and only an active Goal is classified or
   transitioned: a Goal that has already stopped has no continuation to stop, so a
   provider failure on it is reported against its real status rather than as an
   active Goal or as a failed write — the store refuses a non-active record with
   `not-active`, which is not a persistence failure and must never be printed as
   one with an empty detail.
5. **User actions reset everything.** A prompt the user types (including one
   queued while the agent is busy) and an abort both end the unattended phase, so
   the counters and the blocked audit start over. A replacement Goal starts from a
   fresh record for the same reason.

### Repair batch 1: attribution around a stop, and legacy audits

Batch 1 of the V1 repair (issue #24) changes what work is *charged*, not when a
Goal stops. A conservative stop still ends automatic continuation at the next
settlement, but work already admitted before the stop stays attributable: the
Goal-owned segment opened by the run's work message remains open until a genuine
user prompt or a new identity closes it, so an in-flight response or tool result
that was already admitted is accounted even though no new substantive work is
admitted after the stop. Ordinary prompts are never Goal work, whatever the
Goal's status.

The batch also preserves the durable audit across the 0.1.0 cutover: a valid
legacy open audit keeps its description and count for the Blocker-identity handoff
in batch 3, and the extension does not introduce text-similarity equivalence to
recover it. Nothing in this ADR's thresholds or reset rules changes.

### Repair batch 3: opaque Blocker identity and the legacy-audit handoff

Batch 3 (issue #26) makes the audit's equivalence rule the model's *choice* rather
than the extension's guess. The first valid report of a chain omits `blocker_id`
and the extension issues an opaque **Blocker identity**; every later report of the
same condition passes it back verbatim, so a reworded description or a changed
next step still advances the audit. Omitting it reports a genuinely different
condition and starts a fresh chain at one, and an identity the extension did not
issue for the currently open audit is refused without Goal mutation — which also
means the refusal does not own the turn, so a corrected call in the same turn
records that turn's first valid report. There is no text normalization,
similarity, or hashing anywhere in the decision: the model judges semantic
equivalence by choosing whether to reuse the identity, and the extension alone
enforces identity, consecutiveness, and the three-Goal-turn threshold. A same-turn
repeat is idempotent even when it arrives with different text or a different ID.

An *active* 0.1.0 Goal whose audit is still open (a structurally valid count of one
or two) is handed a fresh identity in the same durable cutover transition. Its
description and count are carried over unchanged, the identity is not derived from
the blocker text, and nothing extra is granted: the preserved chain still needs its
remaining turns, omitting the identity starts a fresh chain at one, and every reset
rule — a Goal turn with no report, any user action, a resume, a Replacement Goal —
still applies, so the prompt that follows a load is itself a user action and starts
a fresh audit. A stopped Goal's audit describes its stop, is never advanced again,
and gets no identity.

This batch does not change any threshold or reset rule in this ADR, and it removes
no conservative stop. It completes the mandatory batch 1–3 compatibility landing
unit: cutover without it could not advance a preserved legacy audit by identity,
and the audit could not recognize a reworded report at all.

### Repair batch 2: cumulative budget recovery and per-episode wrap-ups

Batch 2 (issue #25) repairs how a `budget_limited` Goal resumes. The old budget
is a cumulative ceiling, so an explicit raise — and only an explicit raise — can
restart the same identity: `/goal resume --budget <new-total>` (or
`--budget=<new-total>`). The value is the new absolute total, not an increment;
it must be strictly greater than the accounted usage so the resumed Goal has
positive headroom, and at most the configured `goal.maxTokenBudget`, which is
never clamped. `goal.defaultTokenBudget` is never implicit resume authority.

A successful raise is one durable transition: identity, creation time, origin,
objective, and complete usage history are preserved; the ceiling and
`status: active` are set; any pending old-episode wrap-up is cleared; the
revision advances exactly once; and a fresh active-time segment starts. The
commit precedes any resumed work message. A validation or persistence failure
leaves the Goal `budget_limited` with its old budget and wrap-up state.

One bounded wrap-up is owed per exhaustion episode, not per Goal lifetime. A
valid raise cancels an undelivered wrap-up. If the old wrap-up is already in
flight, its admitted usage stays charged; the old budget gate lifts only after
the raise is durable, the resumed work is steered through Pi's normal seam, and
no second old-budget wrap-up is sent. Already-admitted in-flight usage can
immediately exhaust the new ceiling, in which case the Goal becomes
`budget_limited` again and earns the new episode's one wrap-up. Editing the
objective without resuming does not cancel an owed wrap-up: an undelivered
wrap-up uses the latest durable objective, and an in-flight or completed one is
never duplicated. `/goal edit` stays independent, so changing both the
objective and the budget is edit first, then a budget-raising resume.

This batch does not change any threshold or reset rule in this ADR. The
conservative stops still end automatic continuation, and the blocked audit still
starts fresh on a user resume.

### Repair batch 4: explicit Goal creation authority

Batch 4 (issue #27) repairs how `create_goal` proves an explicit request. The
model must quote the complete affirmative Goal-creation instruction, and the
extension corroborates the quote at execution time against the one currently
authoritative source: the raw interactive/RPC user input that started the
execution, or a Pi custom message of any `customType`. Skill/template expansion
and other transformed prompt text are not evidence, and an extension calling
`pi.sendUserMessage()` never acquires human-user authority through that API.
Standing system-prompt instructions do not authorize a specific Goal.

Matching is case-sensitive and permits only whitespace-folding differences; a
paraphrase is not evidence. The rules are conservative and deterministic: an
express request to create, set, or start a Goal. Ordinary work, mere mentions,
questions, hypotheticals, negations, and requests merely to keep working do not
qualify. Intent is evaluated in clause order, so a later explicit correction may
supersede an earlier negation while a later cancellation or negation supersedes
the quoted request. Ambiguity fails closed, and a fragment cannot be lifted out
of a negated sentence. The objective remains model-written and need not repeat
the quotation.

Authority belongs to the execution started by the request and survives later
model turns, Pi retries, compaction, and overflow recovery inside it. A newer
interactive/RPC user message or Pi custom message replaces it, even when
unrelated. Settlement, session restart, branch navigation, a successful Goal
creation, and direct Goal lifecycle operations clear it. Authority is one-shot:
a successful creation consumes it, while a rejection leaves it valid so a
corrected call can retry. A missing, forged, stale, non-explicit, or ambiguous
quote is refused with a tool error carrying `goal: null` and no Goal state is
created or mutated; the refusal opens no interactive confirmation and starts no
Goal, Continuation, or admitted Goal work. Evidence is checked only at
execution time, so a snapshot retains `origin: "tool"` and gains no persisted
quotation, source-message id, or reusable authorization marker. The direct
`/goal <objective>` path is unchanged and needs no quotation, and batch 1's
non-retroactive attribution is unchanged.

This batch does not change any threshold or reset rule in this ADR, and it
removes no conservative stop. It depends on the complete batch 1–3 compatibility
landing unit.

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
  resume is deliberately not a model tool. That decision is `/goal resume`, the same
  command that restarts a paused Goal, so all three non-continuing states end the
  same way: the identity, creation time, and history are kept, the audit that
  described the stop is dropped, and a fresh blocked audit starts from one. A
  `complete` Goal is terminal for its identity and is never resumed, only replaced.
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
