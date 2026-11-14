# Repair batch 4 traceability: explicit Goal creation authority

Issue: #27. Source decisions: #18 (creation authority), #17 (Goal-owned work),
#21 (regression contract), #23 (implementation sequence). Behavior reference:
ADR-0001 and the parent Spec #1.

This document maps every defect and behavioral row owned by batch 4 to the test
that covers it, and records the pre-repair failure evidence required by #21.
The automated gate is `npm test`; every RPC scenario ends with `assertCleanRun`
or an exact `assertOnlyFailures`, asserts exact run/continuation counts, and
asserts the persisted entries. The required seams are real `pi --mode rpc`
behavior plus the narrow combinatorial unit tests named in the ticket.

## Decision-to-test matrix

| Row | Contract | Test evidence |
| --- | --- | --- |
| Accepted raw interactive/RPC request | A raw user prompt containing an explicit Goal-creation request authorizes `create_goal` in that execution | `test/goal12-creation-authority.test.mjs` ("a raw interactive/RPC request authorizes…") |
| Accepted Pi custom message | A Pi custom message of any `customType` containing the explicit request authorizes creation | `test/goal12-creation-authority.test.mjs` ("a Pi custom message authorizes creation") |
| Complete affirmative quotation | The model must quote the complete affirmative instruction, not a keyword or fragment | `test/goal12-creation-authority-store.test.mjs` (quotation-shape rows); `test/goal12-creation-authority.test.mjs` ("rejection is fail-closed: keyword fragment") |
| Case-sensitive, whitespace-folded matching | Only whitespace folding is allowed; case differences and paraphrases are refused | `test/goal12-creation-authority-store.test.mjs` (case rows); `test/goal12-creation-authority.test.mjs` ("whitespace folding accepts…"; "a quotation with different casing is not evidence") |
| Objective independence | The objective is model-written and need not repeat the quotation | `test/goal12-creation-authority.test.mjs` ("a raw interactive/RPC request authorizes…" asserts an objective that differs from the quote); `test/goal12-creation-authority-store.test.mjs` ("the objective is never required to repeat the quotation") |
| Clause order: later correction | A later explicit correction supersedes an earlier negation | `test/goal12-creation-authority-store.test.mjs` ("Do not create a goal. Create a goal." rows) |
| Clause order: later cancellation | A later cancellation or negation supersedes the quoted request | `test/goal12-creation-authority-store.test.mjs` (cancellation rows); `test/goal12-creation-authority.test.mjs` ("rejection is fail-closed: later-cancelled request") |
| Fragment cannot be lifted from a negation | A quote found only inside a negated sentence is refused | `test/goal12-creation-authority-store.test.mjs` ("I did not say create a goal"); `test/goal12-creation-authority.test.mjs` ("rejection is fail-closed: negated request") |
| Typographic apostrophes | A cancellation or negation written with U+2018/U+2019 cancels exactly like the straight-apostrophe form, so a later "Don’t." cannot authorize the Goal or pause it cancels | `test/goal12-creation-authority-store.test.mjs` (typographic-apostrophe rows); `test/goal12-pause-corroboration.test.mjs` ("a later typographic-apostrophe cancellation cannot corroborate a pause") |
| Shared pause vocabulary | The shared `REQUEST_LEAD` widening accepts a comma-less discourse-marker lead ("Actually pause the goal") on the pause path | `test/goal12-pause-corroboration.test.mjs` ("a comma-less discourse-marker lead corroborates a pause") |
| Hypotheticals and questions | Conditional, tentative, and question-shaped clauses do not qualify | `test/goal12-creation-authority-store.test.mjs` (hypothetical/question rows); `test/goal12-creation-authority.test.mjs` ("rejection is fail-closed: hypothetical request"; "…question"; "…tentative request") |
| Non-explicit ordinary work | Ordinary work, mentions, and keep-working requests do not qualify | `test/goal12-creation-authority-store.test.mjs` (mention/ordinary-work rows); `test/goal12-creation-authority.test.mjs` ("rejection is fail-closed: non-explicit ordinary work") |
| Extension-originated user message | `pi.sendUserMessage()` never acquires human-user authority | `test/goal12-creation-authority.test.mjs` ("an extension sendUserMessage does not acquire human-user authority") |
| Transformed prompt text | Skill/template expansion and other transformed text are not evidence | `test/goal12-creation-authority.test.mjs` ("transformed prompt text is not evidence") |
| System-prompt-only instruction | A standing system-prompt instruction does not authorize a specific Goal | `test/goal12-creation-authority.test.mjs` ("a standing system-prompt instruction does not authorize a Goal") |
| Wrong-source evidence | A quotation from an older message is refused | `test/goal12-creation-authority.test.mjs` ("a newer interactive/RPC user message replaces prior authority…"; "a newer Pi custom message replaces prior authority") |
| Authority survives model turns | A later turn in the same execution can still create | `test/goal12-creation-authority.test.mjs` ("a raw interactive/RPC request authorizes…": turn 1 is ordinary work, turn 2 creates) |
| Authority survives retries | A provider retry inside the execution keeps the authority | `test/goal12-creation-authority.test.mjs` ("authority survives a provider retry inside one execution") |
| Authority survives compaction/overflow | Compaction and overflow recovery keep the authority | `test/goal12-creation-authority.test.mjs` ("authority survives compaction and overflow recovery inside one execution") |
| Replacement by newer user message | A newer interactive/RPC user message replaces prior authority | `test/goal12-creation-authority.test.mjs` ("a newer interactive/RPC user message replaces prior authority even when unrelated") |
| Replacement by newer custom message | A newer Pi custom message replaces prior authority | `test/goal12-creation-authority.test.mjs` ("a newer Pi custom message replaces prior authority") |
| Expiry at settlement | A settled execution's authority does not carry into the next | `test/goal12-creation-authority.test.mjs` ("settlement ends the execution's authority") |
| Expiry at restart | A restarted runtime has no reusable authority | `test/goal12-creation-authority.test.mjs` ("a session restart expires the prior execution's authority") |
| Expiry at branch navigation | Tree navigation clears the runtime authority | `test/goal12-creation-authority.test.mjs` ("tree navigation expires the prior branch's creation authority") |
| Expiry at direct lifecycle operations | `/goal` lifecycle commands clear the model-held authority | `test/goal12-creation-authority.test.mjs` ("a direct Goal lifecycle operation clears creation authority") |
| One-shot success | A successful creation consumes the authority; the session's single Goal slot stays occupied | `test/goal12-creation-authority.test.mjs` ("a successful creation is one-shot and a second call in the same execution is refused") |
| Corrected retries | A rejected call leaves the authority valid for a corrected retry | `test/goal12-creation-authority.test.mjs` ("a corrected call retries while the same authority remains valid") |
| Fail-closed rejection | Missing, forged, stale, ambiguous, negated, later-cancelled, hypothetical, non-explicit, wrong-source, and case-paraphrased evidence is refused | `test/goal12-creation-authority.test.mjs` (the ten "rejection is fail-closed" rows) |
| Rejection returns `goal: null` | Every rejection reports the same structured null payload | The same ten rows assert `structuredContent.goal === null` and `details.goal === null` |
| Rejection changes nothing | No Goal state, continuation, dialog, or admitted usage | The same ten rows assert zero `goal-state`, `goal-continuation`, and `goal-usage` entries, zero dialogs, and `runCount === 1` |
| No persisted reusable evidence | Snapshots keep `origin: "tool"` and gain no quotation, source id, or authority marker | `test/goal12-creation-authority.test.mjs` ("a successful tool creation persists no reusable authorization evidence") |
| Unchanged direct `/goal` creation | `/goal <objective>` creates without model quotation | `test/goal12-creation-authority.test.mjs` ("direct /goal creation remains available without model quotation"); `test/goal.test.mjs`, `test/goal4.test.mjs` |
| Non-retroactive accounting | The creating run stays ordinary; attribution starts at the first Continuation | `test/goal12-creation-authority.test.mjs` ("a raw interactive/RPC request authorizes…" asserts only the completing turn is charged); `test/goal6.test.mjs` ("create_goal leaves its creating run ordinary…") |
| Extension error cleanliness | No unexpected extension errors or unconsumed scripted steps | Every RPC test asserts `session.extensionErrors().length === 0` and `assertStepsConsumed` with the exact provider-response count, so a scripted step left unconsumed fails the test. The compaction scenario asserts four: its summary request consumes a step but leaves no assistant turn |

## Pre-repair failure evidence

The new tests were run against the pre-repair `src/` (the
`integration/spec-1-v1-repair` tip, commit `c6aad14`) with the new tests and
fixtures in place. Result: **92 tests, 8 pass, 84 fail.** Representative
failures:

```text
✖ corroborates "Please create a goal" against "Please create a goal for the release" as ok
  TypeError: corroborateGoalCreationRequest is not a function

✖ a quotation with different casing is not evidence
  AssertionError: case-sensitive matching refuses the paraphrased casing
    actual: false, expected: true
    (the pre-repair tool created the Goal without any quotation check)

✖ a newer interactive/RPC user message replaces prior authority even when unrelated
  AssertionError: Expected values to be strictly equal:
    actual: false, expected: true
    (the pre-repair tool created the Goal from the older request)

✖ settlement ends the execution's authority
  AssertionError: Expected values to be strictly equal:
    actual: false, expected: true

✖ a corrected call retries while the same authority remains valid
  AssertionError: Expected values to be strictly equal:
    actual: false, expected: true

✖ rejection is fail-closed: forged quote
  AssertionError: the call is refused
    actual: false, expected: true
    (the pre-repair tool created the Goal from a fabricated quotation)

✖ rejection is fail-closed: negated request
✖ rejection is fail-closed: later-cancelled request
✖ rejection is fail-closed: hypothetical request
✖ rejection is fail-closed: question
✖ rejection is fail-closed: keyword fragment
✖ rejection is fail-closed: missing quotation
✖ an extension sendUserMessage does not acquire human-user authority
✖ transformed prompt text is not evidence
✖ a standing system-prompt instruction does not authorize a Goal
  AssertionError: the call is refused
    actual: false, expected: true
```

The complete captured run is quoted in the PR description. After the repair,
the same suite passes (92/92) and `npm run typecheck` passes.

## Limitations

- The quotation rules are deliberately conservative deterministic English rules.
  Unusual phrasing can be refused, a request delivered only as an image cannot be
  corroborated, and other languages retain `/goal <objective>` as the direct
  creation path.
- The typographic-apostrophe fold is confined to the negation and cancellation
  vocabulary, so it can only make recognition stricter: a curly-apostrophe lead
  ("Let’s create a goal") is refused rather than read as its straight-apostrophe
  twin, and the byte-exact quotation match is unchanged. Both fail closed.
- The raw input is captured at the `input` seam and applied when the user
  message is delivered. An extension that handles input (returns `handled`)
  before pi-goal's own `input` handler could leave a stale pending entry; this
  narrow extension-authored edge is outside the approved seams and is not
  covered by the suite.
- Settlement, restart, and tree-navigation expiry are observable as a refused
  old quotation, but a new execution always starts from its own request source,
  so those boundaries are not isolated from ordinary replacement in the RPC
  scenarios.

## Compatibility landing constraint

Batch 4 depends on the complete batch 1–3 compatibility landing unit (see #23).
It changes no batch 1–3 behavior except the necessary integration: the
`create_goal` tool now requires corroborated execution-time evidence, and the
direct `/goal <objective>` path, the accounting boundaries, the cutover, the
budget recovery, and the Blocker identity are unchanged.
