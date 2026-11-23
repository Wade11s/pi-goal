# Stopping safely on blockers and failures

Every deterministic stop the extension owns, the Blocker identity contract, the
anti-loop bounds, and the provider failures that are deliberately not stops.

[← README](../README.md) · See also [continuation](continuation.md) ·
[tools](../tools.md)

A Goal can also be stopped without the model asking for it. Every rule is
deterministic, and every one of them is narrow enough that ordinary work is never
mistaken for a malfunction.

| Stop | Status | Why it is not ordinary work |
| --- | --- | --- |
| Same genuine blocker for three **consecutive** Goal turns, identified by the Blocker identity the extension issued | `blocked` | reported by the model through `update_goal`, enforced by the extension |
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
  user can resume one, with `/goal:resume`, which restarts it with a fresh audit;
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
  continues on the next successful run. Pi's own retries are untouched. While
  `goal.enabled` is false that notice names the disabled condition instead: the
  next settlement admits nothing, so promising the next successful run would
  describe a continuation the gate refuses. A Goal
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
  While `goal.enabled` is false the usage-limit notice names the admission
  condition as well: the stop still lands, but the `/goal:resume` it names is
  refused until the setting is re-enabled.
- **User actions reset the counters.** A prompt the user types (including one
  queued while the agent is busy) and an abort both restart the blocked audit and
  the anti-loop counters, and a replacement Goal starts from a fresh record.

Budget exhaustion never reaches this tool as a completion: a `budget_limited`
Goal is not active, so `update_goal complete` is refused for it, and the wrap-up
message says so explicitly.
