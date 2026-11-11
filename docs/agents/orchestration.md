# Orchestration Workflow

## Roles

### Orchestrator

The main Pi session is the orchestrator. It owns repository planning, uses the `to-spec` and `to-tickets` workflows, publishes and sequences GitHub issues, delegates implementation and review, verifies delivered work, and performs every final merge.

### Implementation workers

Implementation issues are delegated through `rex-subagent` to this worker pool, using high thinking effort:

| Worker model |
| --- |
| `magpie/zcode/GLM-5.3:high` |
| `magpie/stepfun-cn/step-5-preview:high` |
| `magpie/deepai/deepseek-v4.1-flash:high` |

Balance assignments across the pool by active workload, issue size, and relevant experience. Do not assign all tickets to one model. Keep each issue assignment and result traceable to its subagent handle.

### PR reviewers

Pull requests are reviewed through `rex-subagent` by this reviewer pool, using high thinking effort:

| Reviewer model |
| --- |
| `magpie/kimi-code-cn/k3.1-pro:high` |
| `magpie/grok/grok-4.7@500k:high` |
| `magpie/deepai/deepseek-v4.1-flash:high` |

Grok temporarily replaces `workbuddy/hy4free:high` until that reviewer's usage limit resets. Completed hy4free reviews remain valid; new or unfinished review assignments use Grok.

The orchestrator dispatches reviews, routes requested changes back to the implementation worker, and verifies the resulting updates.

## Issue and pull request flow

1. The orchestrator turns the agreed plan into a spec and tracer-bullet issues, including explicit blocking relationships.
2. The orchestrator assigns only unblocked issues and balances concurrent assignments across the worker pool.
3. Each worker uses a dedicated branch and worktree based on the current integration base. The worker implements the issue, runs its acceptance checks, commits and pushes the branch, and opens a pull request linked to the issue.
4. Workers must not merge their own pull requests or land their work directly on `main`.
5. The orchestrator sends each pull request to the designated reviewer pool. Review feedback returns to the worker through the same branch and pull request.
6. The orchestrator checks the final diff, acceptance evidence, review outcome, and required checks. Only the orchestrator performs the final merge.
7. After completion, the orchestrator records the issue, branch, PR, worker, reviewers, and verification result, then releases the next unblocked issue.

## Subagent operation

Use `rex-subagent` for every worker and reviewer dispatch. Wait for delegated runs, read their logs, and independently verify reported results before treating them as complete. Stop subagents when their results are no longer needed.
