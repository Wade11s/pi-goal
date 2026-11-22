# pi-goal documentation

Start with the [README](../README.md) for installation and a quick tour. This
directory holds the full behavioral contract, the reference material, the testing
procedure, and the historical evidence behind the V1 repair programme.

## Reading paths

- **Using pi-goal** — [README](../README.md) → [lifecycle](behavior/lifecycle.md)
  → [budgets](behavior/budgets.md). Read [limitations](limitations.md) for the
  honest edges.
- **Changing behavior** — [ADR-0001](adr/0001-conservative-stopping.md) →
  [continuation](behavior/continuation.md) → [stopping](behavior/stopping.md) →
  [accounting](behavior/accounting.md). The
  [glossary](../GLOSSARY.md) fixes the vocabulary these docs use.
- **Verifying a change** — [testing](testing.md) → [smoke test](smoke-test.md) →
  the relevant [traceability](#traceability) matrix.

## Behavioral contract

Every rule the extension enforces, and every reason it is shaped that way.

| Doc | Covers |
| --- | --- |
| [behavior/lifecycle.md](behavior/lifecycle.md) | Create, replace, edit, inspect, the status indicator, pause/resume/clear, the opt-in resume prompt, opt-in session naming from the Objective, and the `goal.enabled` admission control |
| [behavior/budgets.md](behavior/budgets.md) | `--budget` and `--no-budget`, settings defaults and hard maximum, cumulative budget raises, budget exhaustion and the bounded wrap-up |
| [behavior/continuation.md](behavior/continuation.md) | The `agent_before_settle` seam, one provider request per settlement, the evidence audit, and the no-progress contract |
| [behavior/stopping.md](behavior/stopping.md) | The Blocker identity contract, blocked-audit thresholds, anti-loop bounds, and the usage-limit classification tiers |
| [behavior/accounting.md](behavior/accounting.md) | The `input + output + cacheWrite` formula, deduplication, admission segments, active time, and durable-write ordering |
| [behavior/persistence.md](behavior/persistence.md) | `goal-state` and `goal-usage` entries, reconstruction, forks, tombstones, superseded records, and the 0.1.0 cutover |
| [behavior/events.md](behavior/events.md) | The local `pi-goal:updated` event stream: payload, transition kinds, durable-before-announced ordering, no-flood rules, and listener-failure isolation |

## Reference

| Doc | Covers |
| --- | --- |
| [tools.md](tools.md) | `get_goal`, `create_goal` and its creation authority, the objective's trust boundary, `update_goal` and its execution binding, structured tool responses |
| [limitations.md](limitations.md) | What the extension does not understand, cannot preempt, or intentionally leaves to the user |

## Testing and verification

| Doc | Covers |
| --- | --- |
| [testing.md](testing.md) | The automated gate, the rules that keep the RPC suite from passing for the wrong reason, development setup, and the verification commands |
| [smoke-test.md](smoke-test.md) | The manual real-Pi procedure and its checklist |

## Decisions and conventions

| Doc | Covers |
| --- | --- |
| [adr/0001-conservative-stopping.md](adr/0001-conservative-stopping.md) | Why stopping is deterministic and extension-owned |
| [agents/domain.md](agents/domain.md) | How agents consume the glossary and ADRs |
| [agents/issue-tracker.md](agents/issue-tracker.md) | GitHub issue conventions |
| [agents/triage-labels.md](agents/triage-labels.md) | Triage roles and label strings |
| [agents/orchestration.md](agents/orchestration.md) | Planning, delegation, review, and merge rules |

The [glossary](../GLOSSARY.md) at the repository root is the single source of
truth for domain terms.

## Traceability

`traceability/` holds the evidence matrices produced by the V1 repair programme:
each behavioral row mapped to the test that covers it, with pre-repair failure
evidence and the PR that supplied the fix. They are **point-in-time audit
records**: they cite paths and wording as of their PR, so a paragraph that has
since moved (for example from the root README into `behavior/`) is still correct
for the commit it describes. Do not treat them as current documentation; use the
behavioral contract above.

| Doc | Issue |
| --- | --- |
| [repair-batch-1-traceability.md](traceability/repair-batch-1-traceability.md) | #24 — durable Goal ownership and legacy cutover |
| [repair-batch-2-traceability.md](traceability/repair-batch-2-traceability.md) | #25 — cumulative budget recovery and per-episode wrap-ups |
| [repair-batch-3-traceability.md](traceability/repair-batch-3-traceability.md) | #26 — opaque Blocker identity and the legacy-audit handoff |
| [repair-batch-4-traceability.md](traceability/repair-batch-4-traceability.md) | #27 — explicit Goal creation authority |
| [repair-issue-28-traceability.md](traceability/repair-issue-28-traceability.md) | #28 — integrated V1 acceptance |
| [repair-issue-34-traceability.md](traceability/repair-issue-34-traceability.md) | #34 — active time stops at every non-active status |
| [repair-issue-37-traceability.md](traceability/repair-issue-37-traceability.md) | #37 — reject stale lifecycle transitions from pre-replacement runs |
| [repair-issue-39-traceability.md](traceability/repair-issue-39-traceability.md) | #39 — bind delivered work messages to their admitted identity |
