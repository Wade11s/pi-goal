# Subagent model and review policy

Read this before spawning or steering a `rex-subagent`. Explicit user instructions for a model or thinking level override this policy. Role responsibilities and the issue/PR flow live in `docs/agents/orchestration.md`; this file is the single source for model selection.

## Selection rules

- Select models from Pi's current scoped-models (`enabledModels`). If a listed route is absent or unavailable, use another primary in the same row before trying its backups.
- Quota substitution: when a `magpie/zhipu/glm-5.3` route cannot be used because its quota is exhausted, substitute `magpie/deepai/muse-ember` + `medium` for that slot instead of skipping the review or waiting for the quota. Record the substitution and its reason in the review report.
- Pass `--model` and `--thinking` explicitly. Thinking support is model-specific; do not assume that every model supports `medium`.
- Keep every DeepAI model in a backup role. Primary rotations contain only non-DeepAI models.
- Reserve `max` and `xhigh` for exceptionally difficult or high-risk work. In the table, `high → max` means start at `high` and escalate only when warranted.
- Keep the same model for follow-up turns sent to an existing run.

## Task pools

| Task | Primary pool | Backups |
| --- | --- | --- |
| File location, log summarization, mechanical extraction | `magpie/workbuddy/hy4flash-free` + `high` (its only supported level) | `magpie/dgx-spark/inkling-2-mini` + `off` for pure extraction or `low` for light synthesis; `magpie/deepai/deepseek-v4.1-flash` + `minimal/low` |
| Read-only code exploration, routine research | `magpie/workbuddy/hy4flash-free` + `high`; `magpie/dgx-spark/inkling-2-mini` + `high` | `magpie/stepfun-cn/step-5-preview` + `medium`; `magpie/zhipu/glm-5.3-flash` + `high`; `magpie/deepai/glm-5.3-flash` + `medium` |
| Routine implementation, localized fixes, test runs | `magpie/stepfun-cn/step-5-preview` + `high`; `magpie/mistral/deepseek-v4-1-flash-1017` + `high` | `magpie/kimi-code-cn/k3.1-pro` + `high`; `magpie/deepai/deepseek-v4.1-flash` + `high` |
| Cross-module implementation, difficult debugging, architecture analysis | `magpie/kimi-code-cn/k3.1-pro` + `high → max` | `magpie/zhipu/glm-5.3` + `high → max`; `magpie/workbuddy/deepseek-v4.1-flash` + `max` |
| Independent code review, second opinion | `magpie/grok/grok-4.7@500k` + `high`; `magpie/zhipu/glm-5.3` + `high` | `magpie/dgx-spark/inkling-2-mini` + `max`; `magpie/stepfun-cn/step-5-preview` + `high`; `magpie/deepai/muse-ember` + `medium` |
| Security review, data-loss risk, final high-risk review | `magpie/grok/grok-4.7@500k` + `xhigh` | A different model family from the implementer: `magpie/zhipu/glm-5.3` + `max` or `magpie/kimi-code-cn/k3.1-pro` + `max` |

## Load balancing

For each new routine implementation task, advance through this cycle within the current parent session:

```text
magpie/stepfun-cn/step-5-preview:high
→ magpie/mistral/deepseek-v4-1-flash-1017:high
```

For each new independent-review task, alternate between:

```text
magpie/grok/grok-4.7@500k:high
↔ magpie/zhipu/glm-5.3:high
```

When the glm slot is unavailable because of exhausted quota, use
`magpie/deepai/muse-ember:medium` for that turn.

Assign parallel independent tasks to different primary models when practical. When multiple reviewers inspect the same change, use both reviewer primaries. Prefer a reviewer from a different model family than the implementer.

## Review-child launch profile

Every review dispatch uses the read-only launch profile below. It is a Rex launch
profile, **not** a Pi review-thread classification: Pi exposes no built-in way to
mark a session as a review, and pi-goal adds none. The profile is data passed to
`rex_spawn` (or the equivalent `rex-subagent spawn` flags), so it constrains only
the child process; the parent session keeps its own tools and Goal state.

Canonical `rex_spawn` arguments (the profile contract this document owns):

```json review-child-profile
{
  "tools": "read,bash,grep,find",
  "excludeTools": "edit,write,get_goal,create_goal,update_goal"
}
```

Equivalent CLI dispatch for diagnostics and manual runs:

```sh review-child-cli
rex-subagent spawn --name review --tools read,bash,grep,find --exclude-tools edit,write,get_goal,create_goal,update_goal --prompt "Review <base>..<head>"
```

Rules:

- `tools` is Pi's `--tools` allowlist. `read`, `grep`, and `find` are the reading
  tools; `bash` is required for OCR and Git. `grep`, `find`, and `ls` are
  off-by-default built-ins, so name the ones a Reviewer needs explicitly.
- `excludeTools` is Pi's `--exclude-tools` denylist. `edit` and `write` are
  excluded because a Reviewer never modifies code; `get_goal`, `create_goal`, and
  `update_goal` are excluded because lifecycle controls belong to the parent
  workflow. The denylist is redundant with the allowlist on purpose: exclusion is
  then explicit, inspectable, and survives a later widening of the allowlist.
- Never pass `--no-skills`: the Reviewer needs the `open-code-review-delegate`
  skill. Never pass `--no-extensions` either; leaving extensions enabled is what
  lets the child see the same repository extensions, and the allowlist already
  keeps their tools out of the model's active set.
- Model and thinking level still come from the pools above; the profile only
  fixes tools. If a review would need to write to the repository, stop and report
  instead of widening the profile.
- The parent is unaffected. These are child launch arguments, and pi-goal keeps
  registering and honoring the Goal tools in the parent session.

Accidental Goal-tool invocation in a review child fails closed: Pi refuses the
call with `Tool <name> not found`, the child records no Goal transition, and the
parent's durable Goal entries are not touched. The Reviewers' prompt says the
lifecycle controls are unavailable and out of scope so a model does not spend a
retry discovering the refusal.

### Upstream request (pi-rex-subagent, not pi-goal)

A durable Rex review preset (for example `--preset review`, or a named profile
that expands to the same allowlist and denylist) would remove this copy-paste
from every dispatch. That is an upstream `pi-rex-subagent` enhancement request,
not current behavior and not something pi-goal core provides. Until it ships,
pass the profile explicitly as documented here and in
`docs/agents/orchestration.md`. Do not add Rex-specific knowledge or review-thread
classification to pi-goal's `src/` for it.

## Mandatory Reviewer workflow

A subagent assigned any review of workspace changes, a PR, a commit, or a branch comparison is a **Reviewer**. Launch it with the review-child launch profile above, and it must load and follow the `open-code-review-delegate` skill for all of that review work, using the delegation flow and output format specified in the root `AGENTS.md` ("Code review (open-code-review delegate mode)").

- Use delegation mode only: `ocr delegate preview`, `ocr delegate rule`, mode-appropriate diffs, per-file review, and the required finding format. Pass the requested scope and matching refs to both OCR subcommands.
- Account for every `reviewable_files` entry as `reviewed` or `skipped` with a concrete reason. Report `total_files`, `reviewed_files`, `skipped_files`, and `coverage_rate`.
- Keep skills enabled and give the Reviewer at least `read,bash,grep,find`. Bash is required for OCR and Git; do not spawn a Reviewer with a tool set that omits Bash or with `--no-skills`.
- Reviewers only review; they must not modify code. The profile above removes `edit` and `write`, and the Reviewer must not write through `bash` either; the orchestrator arranges fixes separately based on review results.
- If the OCR CLI is unavailable or the workflow is blocked, follow the skill's troubleshooting instructions and report the blocker; do not substitute native `open-code-review` or an ad hoc diff review.
