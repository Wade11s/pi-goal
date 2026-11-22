# Codex `/goal` migration status

A living comparison between the OpenAI Codex Goal extension and pi-goal. Update
this document when either baseline changes; do not treat a single percentage as a
substitute for the per-capability table.

[← Documentation index](README.md) · See also [accounting](behavior/accounting.md) ·
[limitations](limitations.md) · [subagent usage reporting](subagent-usage.md)

## Baselines and verification

| Side | Baseline |
| --- | --- |
| Codex | [`openai/codex@ab541fb`](https://github.com/openai/codex/tree/ab541fb9908198d95e9420668bb03f94dfe6324e/codex-rs/ext/goal), the source revision named in [NOTICE.md](../NOTICE.md), plus the Goal TUI files under `codex-rs/tui/` at the same revision |
| pi-goal | `main` at `13a341f`, package version 0.1.1 |
| pi-rex-subagent | `5c81045967515804b29e133747472e5d93e0079f`, for the integration proposal below |
| Pi API evidence | pi-goal's declared minimum, Pi 1.5.1; selected behavior also checked against the installed Pi 1.6.0 documentation and type definitions |
| Verification on 2026-11-21 | `npm run typecheck` passed; `npm test` passed 465/465 tests |

The comparison covers the behavior in Codex `ext/goal`, its user-facing TUI
integration, and the corresponding pi-goal behavior. Codex's Rust implementation
is in-tree and can use private host services; pi-goal deliberately uses only Pi's
public extension API.

### Status vocabulary

- **Ported** — equivalent behavior exists.
- **Strengthened** — pi-goal adds a meaningful safety or durability guarantee.
- **Intentional** — a deliberate semantic difference, not missing work.
- **Partial** — the mechanism exists, but an identified integration is missing.
- **Pi-ready gap** — absent today, implementable through public Pi extension APIs.
- **Host-specific** — exact parity requires a host service or UI integration that
  Pi does not currently expose in the same form.

## Overall assessment

The Goal state machine, automatic continuation, deterministic stopping rules,
budgets, durable accounting, and restart/branch reconstruction are migrated. Some
of them are stricter than Codex. The remaining differences are concentrated in
host integration: external subagent-process usage, telemetry, rich objective
attachments, and a few convenience surfaces.

Two corrections prevent an over-broad “complete” claim:

1. pi-goal **already accounts Pi `toolResult.usage`**, including nested tool work
   and summarization usage. The missing piece is specifically a bridge for a Rex
   child, which is a separate Pi process with a separate session file.
2. Codex's continuation template contains an `update_plan` progress-visibility
   section that pi-goal does not reproduce. Pi has no built-in `update_plan` tool;
   this is a prompt/tool integration choice, not a lifecycle defect.

## Per-capability comparison: core behavior

| Capability | Codex at the baseline | pi-goal now | Assessment |
| --- | --- | --- | --- |
| Lifecycle states | `active`, `paused`, `blocked`, `usage_limited`, `budget_limited`, `complete` | Same six states | Ported |
| User lifecycle controls | `/goal`, clear/edit/pause/resume through the command and TUI flows | `/goal <objective>`, bare `/goal`, `edit`, `pause`, `resume`, `clear` | Ported |
| Replacement confirmation | Confirmation for every unfinished status; no confirmation for `complete` | Same rule | Ported |
| Durable lifecycle writes | State DB update under a Goal-state permit | Durable-before-announced session snapshots, with rollback on failed creation/replacement | Strengthened |
| Model tools | `get_goal`, `create_goal`, `update_goal` | Same three tools; `update_goal` uses explicit actions and corroboration fields | Ported |
| Creation intent | Tool description requires an explicit user/system request | Exact-quote, execution-scoped **Goal creation authority**, checked at execution time | Strengthened; intentionally stricter |
| Creation with an existing Goal | Allowed when no Goal exists or the existing one is complete | Refused whenever any Goal exists; replacement and clearing remain user-owned | Intentional |
| Pause authority | Explicit request required by the tool contract | Exact-quote corroboration against recent human messages is also enforced | Strengthened |
| Objective trust boundary | Objective is untrusted context; XML escaping in steering templates | Random-nonce delimiters plus JSON/Unicode escaping on every Goal message | Strengthened |
| Automatic continuation | `on_thread_idle` starts a Goal-triggered turn if idle | One provider request at `agent_before_settle`, after Pi-owned retries, recovery, and queued work | Ported through Pi's native seam |
| Evidence and completion audit | Continuation requires current-state, requirement-by-requirement evidence | Same contract, with the objective restated verbatim on every continuation | Ported |
| No-progress contract | Progress / verified wait / no progress | Same classification and live-handle requirements | Ported |
| Progress planning prompt | Conditional `update_plan` instructions | Not reproduced; no built-in Pi `update_plan` equivalent | Partial; optional custom-tool integration |
| Blocked audit | Three consecutive Goal turns; semantic sameness is model-judged | Extension-issued opaque Blocker identity, durable count, per-turn idempotence, and enforced resets | Strengthened |
| Activity-free stop | Three consecutive empty automatic turns become `blocked` | Three consecutive activity-free automatic Goal turns become `blocked`; attended runs do not count | Ported |
| Execution-unavailable stop | Three consecutive execution-failure turns become `blocked` | Three consecutive automatic turns where the shell could not run become `blocked`; ordinary non-zero exits/timeouts/aborts are excluded | Ported |
| Usage-limit stop | `UsageLimitExceeded` becomes `usage_limited` | Two-tier evidence classification distinguishes plan exhaustion from throttles and failed lookups | Strengthened |
| Other terminal provider errors | Non-retryable turn error becomes `blocked` | Continuation stops for that run, but the Goal stays `active` and can continue after a later successful run | Intentional; see below |
| Token budget configuration | Positive budget and configured `max_goal_token_budget`, which also supplies a default | Separate `goal.defaultTokenBudget` and hard `goal.maxTokenBudget`; `--budget` and `--no-budget` | Strengthened |
| Budget exhaustion | `budget_limited`, a steering wrap-up, no new substantive work | Durable one-wrap-up-per-episode state plus a tool gate that blocks and terminates substantive tool work | Strengthened |
| Budget recovery | External Goal updates can change the budget | `/goal resume --budget <new-total>` raises the cumulative ceiling with explicit headroom/maximum validation | Ported with a clearer user surface |
| Token formula | `input - cached_input + output` | `input + output + cacheWrite`; cached reads excluded, reasoning not added twice | Intentional adapter-specific difference; see below |
| In-process nested model usage | Descendant usage can be folded into root accounting | `toolResult.usage` is charged once by tool-call identity and replayed from the parent branch | Ported |
| External descendant-process usage | Codex thread hierarchy reports descendant token usage to the root accounting state | No automatic bridge for independent external Pi processes | Partial; use the [plugin-neutral provider contract](subagent-usage.md) |
| Active elapsed time | Wall-clock deltas are persisted with Goal usage | Monotonic active clock, stopped in every non-active state and during downtime | Strengthened |
| Persistence | `thread_goals` state DB records; fork flushes in-flight progress | `goal-state` / `goal-usage` entries on the selected session branch, tombstones, superseded records, and legacy cutover | Strengthened for Pi's tree model |
| Ephemeral sessions | Ephemeral threads reject Goals | `--no-session` refuses Goal creation | Ported |
| Stale model transitions | `expected_goal_id` guards persistent updates | Execution binding plus identity/revision checks reject transitions from pre-replacement or otherwise stale runs | Strengthened |
| Automated evidence | Rust unit/integration tests | 465 real-Pi RPC and unit tests at the recorded baseline | Ported with host-level coverage |

## Per-capability comparison: host and UX integration

| Capability | Codex at the baseline | pi-goal now | Assessment and Pi path |
| --- | --- | --- | --- |
| Compact status indicator | Goal status, usage, remaining budget, elapsed time | Equivalent status line across all six states | Ported |
| Full Goal summary | TUI history summary | Bare `/goal` and structured `get_goal` | Ported |
| Interactive objective editor | Prefilled edit prompt | `ctx.ui.editor()` with TUI/RPC support and a headless fallback | Ported |
| Resume prompt after reopening a stopped Goal | TUI can offer “Resume paused goal?” | Restore notification only; resume is explicitly user-owned | Pi-ready via `session_start` + `ctx.ui.select/confirm`; intentional conservative default |
| Rich objective materialization | Oversized text, pasted text, local images, and remote image URLs can become attachment files | Plain text objective, 3–2000 characters; no attachment pipeline | Partial Pi-ready gap; see below |
| Objective length | 1–4000 characters | 3–2000 characters | Intentional local validation choice |
| Thread preview from objective | Empty thread preview is filled from the objective | No automatic session-title/preview update | Pi-ready through `pi.setSessionName()` if desired; avoid overwriting a user-provided name |
| Enable/disable setting | `GoalExtensionConfig.enabled` can be changed by the host | No `goal.enabled`; uninstalling disables the package | Pi-ready through `pi.getSettings()` plus guards on commands, tools, and continuation |
| Completion usage report | Completing a budgeted Goal returns instructions to report final token/time usage | Final usage remains available in the structured result, but there is no equivalent explicit report instruction | Small Pi-ready prompt/tool-result addition |
| Goal update events | `ThreadGoalUpdated` protocol event | UI notifications and durable snapshots; no dedicated public protocol event | Pi-ready locally through `pi.events.emit("pi-goal:updated", …)` |
| Analytics and metrics | Analytics events plus otel counters/histograms | No analytics exporter | Local event/metric production is Pi-ready; hosted telemetry needs an explicit exporter and privacy policy |
| External app-server methods | `thread/goal/get`, `set`, and `clear` | Pi RPC can invoke the command surface; there is no identically shaped Goal RPC namespace | Host-specific; use Pi RPC commands or a small companion RPC adapter if needed |
| Review-subagent tool visibility | Goal tools are hidden from Codex review subagents | No analogous built-in Pi review-thread classification | Host-specific; a Rex child can instead use `--tools` / `--exclude-tools` |
| Plan-mode accounting exclusion | Codex Plan collaboration mode is excluded from Goal token accounting | No identical Pi collaboration mode | Not applicable to current Pi |

## What to do with each divergence or gap

### Differences that should remain

- **Token formula.** Do not copy Codex's arithmetic literally. Pi's `Usage.input`
  already excludes cached reads and cache writes, and `reasoning` is already in
  `output`. pi-goal's formula follows Pi's provider semantics. Codex parity means
  equivalent accounting intent, not identical field arithmetic.
- **Terminal provider errors.** Pi already owns retries and recovery. Blocking the
  Goal on every terminal non-usage error would copy Codex's policy but remove
  pi-goal's ability to continue after a later successful run. If exact Codex
  behavior is ever desired, the existing `message_end` error evidence and
  `agent_before_settle` outcome are sufficient to implement it; no Pi core change
  is needed.
- **Creation and resume authority.** The stricter corroboration and user-owned
  resume rules are safety properties, not missing Codex features.
- **Automatic resume prompts.** These are easy to add with Pi's UI APIs, but the
  current notification-only behavior avoids turning session restoration into an
  implicit lifecycle decision. An opt-in setting would be preferable to changing
  the default silently.

### Gaps implementable without Pi core changes

| Gap | Public Pi feature to use | Scope |
| --- | --- | --- |
| `goal.enabled` | `pi.getSettings()`, lifecycle guards, tool guards, and the existing status API | Small; define whether disabling stops admission only (recommended) or also hides tools |
| Resume prompt | `session_start`, `ctx.hasUI`, `ctx.ui.select()` / `confirm()` | Small; TUI and RPC need tests, print/JSON must not block |
| Completion usage reminder | Structured `update_goal` result or completion-contract wording | Small |
| Local Goal events | `pi.events.emit()` after durable transitions | Small; publish only after the durable write succeeds |
| Durable audit/event history | `pi.appendEntry()` and optionally `pi.registerEntryRenderer()` | Medium; avoid putting a second conflicting lifecycle source of truth on the branch |
| Session title from objective | `ctx.sessionManager.getSessionName()` + `pi.setSessionName()` | Small and optional |
| Long objectives and explicit file references | Node filesystem APIs, `ctx.ui.editor()`, and the existing encoded-objective boundary | Medium; raising the length limit is easy, lifecycle/cleanup of referenced files needs a contract |
| Images in Goal kickoff | `pi.sendUserMessage()` accepts text/image content arrays | Medium; durable attachment ownership and every later continuation must reference the same artifacts |
| Composer-style pending pastes and image drafts | No equivalent extension-command input object exposes Codex's composer draft directly | Host-specific; use explicit files or a custom UI rather than pretending slash-command arguments contain attachments |
| Hosted analytics | A local `pi.events` listener can export to a chosen backend | Integration work, including redaction and consent; not required for Goal correctness |
| `update_plan` parity | Register a Pi custom plan tool and conditionally reference it in the continuation | Optional; do not instruct the model to call a tool that is not registered |

## Rex subagent usage: one reference provider

The normative design is the [plugin-neutral subagent usage contract](subagent-usage.md).
The remainder of this section maps that contract onto Rex as **one interchangeable
provider**. It is not a Rex-specific accounting path in pi-goal. The same contract
can be implemented inside another subagent plugin or by a separate adapter package.

**The remainder of this section is a provider proposal, not current behavior.** No
`usage.json` file or Rex observation tool exists at the recorded baseline.

### Why current Rex usage is invisible to the parent Goal

`rex-subagent spawn` starts an ordinary interactive Pi in a separate process. It
uses a run-specific `--session-dir` and writes the child session under
`~/.pi/agent/rex-subagents/<handle>/sessions/`. The parent normally interacts
with it by running `rex-subagent` through the bash tool.

That separation is useful for visibility and process lifetime, but Pi cannot infer
that tokens in the child's session belong to a tool call in the parent. By
contrast, a tool that calls another Pi tool through `ctx.executeTool()` already
has its nested usage merged into the parent's `toolResult.usage`; pi-goal counts
that case today.

The bridge should therefore use Pi's existing public representation rather than
adding a second Goal-accounting system:

```
child Pi session
  → cumulative usage snapshot for one Rex run
  → parent observation tool returns only the new delta as ToolResultMessage.usage
  → Pi persists that usage on the parent tool result
  → pi-goal's existing live accounting and branch replay charge it once
```

### Preferred provider surface: Pi custom observation tools

Add parent-side custom tools, ideally `rex_subagent_spawn` and
`rex_subagent_wait` (spawn establishes the baseline; wait collects the delta). A
smaller first step is `rex_subagent_sync_usage`, called immediately after the
existing CLI `spawn` and after each CLI `wait`; the Rex skill must then require
those calls before reporting a delegated result.

Returning `{ usage }` from a custom tool is supported by Pi 1.5.1. The parent tool
result is durable, contributes to Pi's full-session statistics, and flows through
pi-goal's existing `nested` accounting path. No change to pi-goal's token formula,
UsageLedger, budget gate, or snapshot schema is required.

A CLI-only `tool_result` hook that parses bash output is possible, but should be a
best-effort compatibility shim only. Shell parsing, truncated output, concurrent
observations, branch-local cursors, and crash windows make it materially easier to
double-charge or lose usage. A custom tool can persist the necessary cursor data
in its own `details` without rewriting `BashToolDetails`.

### 1. Child: publish a cumulative, atomically written snapshot

Add a usage module to pi-rex-subagent and let `child.ts` publish a snapshot at
`session_start`, `turn_end`, `agent_settled`, and clean shutdown. Recomputing from
`ctx.sessionManager.getBranch()` at those boundaries is simple and restart-safe;
an incrementally maintained counter can be added later if profiling justifies it.

Count the same entry classes pi-goal understands:

- every assistant message's `message.usage`;
- every tool-result message's `message.usage` (which may already contain nested
  tool usage);
- `compaction` and `branch_summary` entry `usage`;
- not standalone `usage` entries such as cache warming, matching pi-goal's current
  exclusion.

Suggested versioned shape:

```json
{
  "version": 1,
  "handle": "a1b2c3",
  "sessionKey": "<child session id or file identity>",
  "sequence": 42,
  "updatedAt": "2026-11-21T12:00:00.000Z",
  "usage": {
    "input": 12000,
    "output": 3000,
    "cacheRead": 40000,
    "cacheWrite": 500,
    "reasoning": 700,
    "totalTokens": 55500,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
  }
}
```

`sequence` must increase for every published snapshot, and `usage` is cumulative
for the child session, not a per-turn delta. Write by temporary-file-plus-rename,
as Rex already does for status and inbox records. Validate all numbers as finite,
non-negative values when reading; reject a regressed sequence or a changed
`sessionKey` rather than silently clamping it into a plausible-looking charge.

Only token usage should flow into the parent's Goal. Do **not** add child active
time to the parent's active time: parallel children would otherwise multiply
elapsed wall-clock time.

### 2. Parent: turn cumulative snapshots into exactly-once deltas

The observation tool keeps a per-handle cursor containing the last reported
`sessionKey`, `sequence`, and cumulative `Usage`. For one new snapshot:

1. Serialize snapshot-to-delta observation per handle, so two concurrent tool
   calls cannot both charge against the same baseline.
2. Verify that the run belongs to the current parent session
   (`RunRecord.parentSessionId`) or was explicitly admitted by that session. This
   prevents unrelated runs—and nested grandchildren—from being charged twice.
3. Establish the first baseline explicitly. A custom spawn tool records a zero
   baseline in its result when it launches a new child, so the first observation
   reports all of that delegated child's work. A pre-existing run has no such
   evidence: adopting it must record the current snapshot as its baseline, or
   attribution must be refused. Never default an unknown existing run to zero,
   which would retroactively charge work done before the Goal owned it.
4. Otherwise subtract each usage/cost component from the last reported snapshot.
   Reject negative deltas or an older sequence; they indicate a reset, corruption,
   or out-of-order observation that needs a new versioning rule.
5. Return one combined Pi `Usage` delta for all observed handles. Pi's
   `Usage.totalTokens` remains the full Pi usage total (including cached reads);
   pi-goal independently applies its `input + output + cacheWrite` formula and
   excludes cached reads.
6. Put `{ handle, sessionKey, sequence, usage: cumulativeSnapshot }` for every
   observation in the custom tool result's `details`, including zero-delta
   observations. Omit `usage` on the tool result itself when the combined delta is
   zero.

The delta is calculated from snapshots, but the **parent tool result is the
accounting record**. Do not also append the same delta as a separate Goal charge.

### 3. Restart and branch navigation: reconstruct cursors from the parent branch

On `session_start` and `session_tree`, rebuild the per-handle cursors from the
selected parent branch's observation-tool results:

- charge nothing yourself during this scan—pi-goal already replays each persisted
  `toolResult.usage`;
- read each result's `details` snapshot and select the highest valid sequence per
  `(handle, sessionKey)` as the baseline for future observations;
- use only the selected branch, not `getEntries()` across abandoned alternatives.

Branch-local reconstruction matters. If a user navigates to a branch that never
contained an earlier observation but does contain the child's delegation/adoption
baseline, charging the unobserved usage on that branch is correct; a
process-global cursor would incorrectly suppress it. If the baseline is absent
too, apply the adoption rule rather than inventing one. Switching back to the
original branch restores that branch's cursor and prevents a second charge there.

### 4. Lifecycle ownership and final collection

Pi decides whether an observation is Goal-owned: pi-goal charges the parent tool
result only inside the corresponding admission segment. Observations made during
an ordinary user prompt still contribute to Pi session statistics but not to Goal
usage.

Choose and document one boundary for work that a child performs while a Goal is
stopped but no observation happens until after resume:

- **Observation-based V1 (simplest):** the delta belongs to the segment that
  observes it. This is deterministic and crash-safe, but can attribute some
  previously unobserved paused-time work to the resumed segment.
- **Strict lifecycle attribution:** reconcile all known child cursors at pause,
  completion, clear/replacement, and immediately before resume admission. This
  excludes stopped-time work more closely, at the cost of more integration code.

For either choice, a final observation must happen before `rex-subagent stop
--remove` deletes the run directory. A combined Rex stop tool should collect the
last snapshot before removal; otherwise late, uncollected child usage is lost.

### 5. Minimal file-level change plan

| Repository / file | Proposed change |
| --- | --- |
| `pi-rex-subagent/src/usage.ts` (new) | Usage validation, branch aggregation, snapshot reading/writing, delta calculation |
| `pi-rex-subagent/src/child.ts` | Publish cumulative snapshots at the listed persistence boundaries |
| `pi-rex-subagent/src/index.ts` | Register the parent spawn/observation/wait tools and reconstruct cursors on session start/tree navigation |
| `pi-rex-subagent/src/lifecycle.ts` | Reuse `waitRuns` / `describeRun`; expose run ownership and final-observation hooks |
| `pi-rex-subagent/src/cli.ts` (optional) | Include snapshots in `status --json` / `wait --json` for diagnostics and a transitional adapter |
| `pi-rex-subagent/skills/rex-subagent/SKILL.md` | Require the observation tool, or use the combined wait tool, before accepting a child result |
| `pi-goal` | No accounting change for the custom-tool design; optionally add an integration contract test with pi-rex-subagent |

### Acceptance tests

At minimum, prove all of these against real Pi usage records:

1. One child observed twice charges the first delta and then zero.
2. Two parallel children are each charged once; a repeated handle in one call is
   deduplicated.
3. Two concurrent observations of the same child cannot charge the same snapshot.
4. Child nested tool usage and compaction usage are included; cached reads remain
   visible but outside pi-goal's accounted total; cache-warming entries are not
   charged.
5. Parent restart after each observation restores both Goal totals and the future
   observation cursor without loss or duplication.
6. Parent tree navigation reconstructs the selected branch's cursor and totals,
   including a branch that did not contain the original observation.
7. Out-of-order, regressed, malformed, or changed-session snapshots fail closed.
8. A zero-delta observation advances the cursor without adding usage.
9. Final usage is collected before `stop --remove`; a dead child's existing
   snapshot remains collectible after parent restart.
10. Adopting a pre-existing child cannot charge work from before its recorded
    adoption baseline; a newly spawned child starts from the recorded zero
    baseline even when its first wait happens after several child turns.
11. Nested delegation is charged only through the immediate child's aggregate,
    not again through a direct observation of the grandchild.

## Maintenance and priority

When updating this comparison, record the new source revision, change the affected
row rather than only the summary, and link the behavioral/test document that
provides current evidence.

Recommended order for actual implementation:

1. Implement the neutral snapshot/provider contract and its reusable conformance
   suite. Use `ToolResultMessage.usage` for custom-tool providers and one generic
   async collector for external-process providers. This is the only missing piece
   that changes budget correctness for the user's current subagent setup.
2. Supply Rex support as one provider—inside pi-rex-subagent or in a separate
   adapter—without adding Rex-specific logic to pi-goal.
3. `goal.enabled` and the completion usage reminder as small UX additions.
4. Local `pi.events` Goal-updated notifications; add an exporter only when a real
   consumer exists.
5. Rich objective attachments only after attachment lifetime, trust boundaries,
   and continuation behavior are specified.
