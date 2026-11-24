# Orchestration Workflow

## Roles

### Orchestrator

The main Pi session is the orchestrator. It owns repository planning, uses the `to-spec` and `to-tickets` workflows, publishes and sequences GitHub issues, delegates implementation and review, verifies delivered work, and performs every final merge.

### Implementation workers

Implementation issues are delegated through `rex-subagent`. Select the worker model from the task pools in `docs/agents/subagents.md`: routine implementation, localized fixes, and test runs use the rotating primary pool; cross-module implementation, difficult debugging, and architecture analysis use the difficult-work pool.

Balance assignments across the pool by active workload, issue size, and relevant experience, advancing the routine-implementation cycle for each new task. Do not assign all tickets to one model. Keep each issue assignment and result traceable to its subagent handle.

### PR reviewers

Pull requests are reviewed through `rex-subagent`. Select reviewers from the independent-review pool in `docs/agents/subagents.md`, alternating primaries and preferring a different model family than the implementer; security, data-loss-risk, and final high-risk reviews use the high-risk review pool. Every review subagent follows the `open-code-review-delegate` workflow defined in the root `AGENTS.md`.

Every review child is launched with the read-only review-child profile in
`docs/agents/subagents.md`: `tools` = `read,bash,grep,find,ls` and `excludeTools` =
`edit,write,get_goal,create_goal,update_goal`. The profile is a Rex launch
argument set, not a Pi review-thread classification; the parent session keeps its
Goal tools and Goal state. If a review child reports that a Goal tool is
unavailable, that is the intended refusal, not a provider problem.

The orchestrator dispatches reviews, routes requested changes back to the implementation worker, and verifies the resulting updates.

## Issue and pull request flow

1. The orchestrator turns the agreed plan into a spec and tracer-bullet issues, including explicit blocking relationships.
2. The orchestrator assigns only unblocked issues and balances concurrent assignments across the worker pool.
3. Each worker uses a dedicated branch and worktree based on the current integration base. The worker implements the issue, runs its acceptance checks, commits and pushes the branch, and opens a pull request linked to the issue. The PR body names `Closes #<ticket>` and, when the ticket belongs to a spec, `Part of #<spec>`, so merging closes the ticket automatically.
4. Workers must not merge their own pull requests or land their work directly on `main`.
5. The orchestrator sends each pull request to the designated reviewer pool. Review feedback returns to the worker through the same branch and pull request.
6. The orchestrator checks the final diff, acceptance evidence, review outcome, and required checks. Only the orchestrator performs the final merge.
7. After completion, the orchestrator records the issue, branch, PR, worker, reviewers, and verification result, then releases the next unblocked issue.

## Subagent operation

Use `rex-subagent` for every worker and reviewer dispatch. Read `docs/agents/subagents.md` before each dispatch and pass `--model` and `--thinking` explicitly. Review dispatches also pass the documented review-child tool profile; implementation dispatches keep their ordinary tools. Wait for delegated runs, read their logs, and independently verify reported results before treating them as complete. Stop subagents when their results are no longer needed.

Probe every new dispatch for liveness within 5–10 minutes: read `rex-subagent logs <handle> --tail 20`, and when the run has produced no assistant output by then, treat the route as unavailable and re-dispatch with another model from the same pool row instead of waiting out a full timeout. When a worker and a reviewer run in parallel, assign different provider families, not just different models: routes in one family share its quota, so pairing them can stall both.
