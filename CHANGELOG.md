# Changelog

Notable changes to pi-goal. Version headings match the `version` field in
`package.json`; install a release with `pi install
git:github.com/Wade11s/pi-goal@vX.Y.Z`.

## [Unreleased]

- Add the optional Codex-shaped Goal RPC companion
  (`companion/goal-rpc`): independently installable, no dependency on pi-goal,
  removable without affecting pi-goal. It maps `thread/goal/get`,
  `thread/goal/set`, and `thread/goal/clear` onto the *user* command surface
  through the new generic in-process bridge (`pi-goal:command-bridge`), so
  replacement confirmation, `goal.enabled` admission, Token-budget and attachment
  validation, the execution binding, and durable-before-announced ordering all
  stay in one lifecycle: no snapshot, tombstone, or usage checkpoint is read or
  written by the adapter. Each call answers with one `goal-rpc-response` session
  entry whose `ok` is true only for a durable commit (a transition of the kind
  that answers the requested action, still the current Goal identity, and on
  disk) — a creation that committed and then failed its on-disk durability poll
  is reported as `refused` — and whose `error.code` names the refused, declined,
  invalid, unauthorized, or unavailable outcome, never a claimed success.
  Mutating methods require an asserted `authority: "external-user"`; `model` is
  refused and pointed at `create_goal`, and the companion registers no
  model-callable tool, so model-driven creation keeps pi-goal's creation
  authority. The bridge and companion are documented in
  `docs/behavior/companion.md`, including the honest difference from Codex's
  private in-tree app-server methods (Codex-shaped names, not a wire-compatible
  protocol). Deterministic coverage: `test/goal56-command-bridge.test.mjs` and
  `test/goal56-goal-rpc-companion.test.mjs`.

- Add the non-authoritative durable Goal audit history: every committed transition
  covered by `pi-goal:updated` is appended to the session branch as a `goal-history`
  entry and rendered read-only by `/goal history`. Each record carries the
  committed identity, revision, transition, previous and current Lifecycle
  statuses, timestamp, usage summary, Active elapsed time, and attachment manifest
  hashes when present — never attachment contents and never objective text. The
  timeline is written from the same committed-transition seam as the event stream
  and projected from that stream's payload, so the two cannot disagree; it records
  no accounting checkpoint or clock tick and nothing for a rolled-back transition.
  Goal snapshots and tombstones stay the only lifecycle authority: nothing
  reconstructs from history, so missing or malformed history cannot resurrect,
  clear, replace, or otherwise change the current Goal, and a malformed entry is
  skipped and surfaced as a rendering notice only. A crash between the lifecycle
  commit and the history append leaves only a documented diagnostic gap. No
  command, tool, or option mutates a Goal from a history record. The contract is
  documented in `docs/behavior/history.md`.
- Document the read-only review-child launch profile for `rex-subagent`
  dispatches in `docs/agents/subagents.md` and `docs/agents/orchestration.md`:
  `tools` = `read,bash,grep,find,ls`, `excludeTools` =
  `edit,write,get_goal,create_goal,update_goal`. It is a per-child Rex launch
  argument set, not a Pi review-thread classification; pi-goal core gains no
  Rex or review logic, and the parent session keeps its Goal tools and Goal
  state. A deterministic test starts a real Pi session with the documented
  arguments, proves the active tool set is read-only, and drives accidental
  Goal-tool calls to Pi's `Tool <name> not found` refusal without a Goal write;
  a live scenario inspects the released provider's child launch arguments. An
  upstream Rex review preset remains a separate enhancement request.
- Add explicit remote-image Objective attachments through the repeatable leading
  `/goal --remote-image <https-url>` option at creation and Replacement Goal
  time. The image is fetched **once**, before the snapshot commits, over HTTPS
  only, with no credentials, cookies, or referrer, a 15-second overall deadline,
  at most three revalidated redirects, and refusal of loopback, link-local,
  private, and other non-public destinations — including every redirect target
  and every DNS result. The validated addresses are pinned into the connection
  so a DNS answer that changes between resolution and fetch cannot redirect it.
  The response is read through a hard byte bound, and the actual bytes (not the
  URL extension or `Content-Type`) decide PNG/JPEG/GIF/WebP; SVG and unknown
  content are refused, and the existing 10 MiB per-image and 25 MiB total limits
  apply to fetched bytes. The fetched content becomes the same immutable
  Goal-keyed artifact as a local image, with hash/media type/byte size/label in
  the durable manifest; the source URL is never persisted or needed by a later
  Continuation. A failed fetch, validation, materialization, or snapshot leaves
  the previous Goal untouched and emits no success event, and disabled admission
  refuses the command before any request. `create_goal` stays text-only. The
  contract is documented in `docs/behavior/attachments.md`; the automated suite
  uses only a local TLS fixture and never the public network.
- Add the opt-in structured progress-plan tool (`goal.planTool`, default `false`),
  registered as the `update_plan` model tool. It takes one ordered list of steps,
  each `pending`, `in_progress`, or `completed`, with at most one `in_progress`,
  so verified progress and remaining work stay visible across Continuations. Its
  record is the tool result's persisted `details` — the ordinary session-branch
  tool result — so it survives a restart and is visible in the model's own context
  with no second Goal record: no `goal-state` entry, no revision, and no
  `pi-goal:updated` event. It never mutates a Lifecycle status, so a plan that
  marks every step completed cannot complete or bypass the Completion audit, and
  it is accounted like any other tool call. While the setting is off the tool is
  not registered at all and no Continuation mentions it; a name already owned by
  another extension is never replaced. The contract is documented in
  `docs/behavior/lifecycle.md` and `docs/tools.md`.
- Add the privacy-safe `pi-goal:metrics` projection derived only from committed
  Goal-updated events: transition kind, Lifecycle status, token totals, Active
  elapsed time, budget state, extension version, and timestamp. The projection
  is an allowlist built field by field, so Objective text, Blocker descriptions,
  attachment contents, source file names, source URLs, session identifiers,
  Goal identity, and raw prompts are absent by construction. pi-goal performs no
  network export and installs no exporter dependency; the optional local
  consumer seam is failure-isolated, and the on-demand hosted companion's
  consent, redaction, retry, and credential ownership are documented in
  `docs/behavior/metrics.md`.
- Add explicit local Objective attachments through repeatable leading `/goal
  --file <path>` and `--image <path>` options at creation and Replacement Goal
  time. Materialize UTF-8 text and PNG/JPEG/GIF/WebP images into an immutable,
  Goal-keyed artifact store before the snapshot commits; enforce 8 attachments,
  1 MiB per text file, 10 MiB per image, and 25 MiB total. Text is encoded and
  nonce-delimited as untrusted data, images use Pi content arrays, and every
  kickoff and Continuation references the same durable hash/media-type/size/label
  manifest. Objective edits retain that manifest, `create_goal` stays text-only,
  disabled admission runs before materialization, and failed creation leaves the
  previous Goal untouched without a success event. Missing or corrupt restored
  artifacts suppress automatic Continuation with an explicit error and no
  artifact-driven Lifecycle change. Clear and replacement retain committed
  artifacts; V1 deliberately has no destructive automatic garbage collection.
  This explicit flow is the supported alternative to Codex composer drafts.
  Relative source paths resolve against the session working directory rather
  than the launch directory; reads are bounded regular-file reads that refuse
  symlinks and special files, and work messages render one authenticated load
  instead of a separate verify and re-read. A resume loads its attachments
  before committing the durable resume transition, so a failed load leaves the
  Goal paused. Explicit remote images are the separate `--remote-image` flow
  documented in the entry above and in `docs/behavior/attachments.md`.
- Add the opt-in paused-Goal resume prompt (`goal.resumePrompt`, default `false`):
  one confirmation at session start for a restored `paused` Goal. Accepting runs
  the same durable `/goal resume` transition (same identity and history, fresh
  Blocked audit); declining, dismissing, timing out, or having no interactive UI
  leaves the Goal unchanged. It is never offered for any other Lifecycle status,
  never makes print/JSON/headless startup wait, and is not offered at all while
  `goal.enabled` is false. The contract is documented in
  `docs/behavior/lifecycle.md`.
- Add the opt-in `goal.sessionNameFromObjective` setting (default `false`): after a
  successful *fresh* creation it names an otherwise unnamed session from the
  Objective's first line — whitespace-collapsed, capped at 80 characters, and
  attachment-agnostic. The name is written through Pi's own `session_info` seam, so
  it is host metadata rather than Goal state: it is never persisted in a snapshot,
  never reconstructed from a branch, never part of the `pi-goal:updated` stream, and
  never counted in accounting. A name that already exists is never overwritten, an
  Objective edit and a Replacement Goal never rename anything, and a refused, failed,
  rolled-back, or cleared-while-waiting creation names nothing.
- Emit a local `pi-goal:updated` event on Pi's shared extension event bus after
  every meaningful durable Goal transition (creation, replacement, objective
  edit, pause, resume, budget recovery, clear, blocked, usage-limited,
  budget-limited, completion), carrying the committed identity, revision,
  transition kind, status, objective metadata, usage summary, active time, and
  timestamp. Refused, failed, and retracted transitions emit nothing; token
  deltas and active-time ticks never emit. Listener failures are isolated by
  the bus and never roll back committed state. The contract is documented in
  `docs/behavior/events.md`.

## [0.1.1] - 2026-11-16

- Add the docs map: the behavioral contract lives in `docs/behavior/`, the model
tools in `docs/tools.md`, testing in `docs/testing.md`, and historical evidence
in `docs/traceability/`.
- Require Node 22.19+ (Pi's own minimum) and run the suite from an explicit file
glob so it also runs on Node 24.
- Make the legacy fixtures portable: the copied session header is retargeted at
the current temp directory instead of the macOS path recorded at capture.
- Stabilize the scripted provider and the blocked-audit chains against mid-write
script reads and settle ordering.

## [0.1.0] - 2026-11-16

First release.

- `/goal` command: create, replace, edit, inspect, pause, resume, and clear a
  Goal, with durable-before-announced lifecycle transitions.
- Model tools `get_goal`, `create_goal`, and `update_goal`, with quotation-based
  creation authority, exact-quote pause corroboration, and execution binding for
  every model-side transition.
- Automatic continuation at `agent_before_settle`, one provider request per
  settlement, with an evidence audit and a no-progress contract.
- Deterministic stopping on three consecutive blocker reports (opaque Blocker
  identity), activity-free and execution-unavailable anti-loop bounds, and
  provider usage limits.
- Durable token and active-time accounting: `input + output + cacheWrite`,
  charged once per report, replayed identically after restart, reload, and tree
  navigation.
- Token budgets with extension-level defaults and a hard maximum, cumulative
  budget raises, and one bounded wrap-up per exhaustion episode.
- `goal-state` and `goal-usage` session entries, tombstones, superseded records,
  and the one-time 0.1.0 cutover with legacy reconstructed totals.
- Compact `goal` status indicator across every lifecycle state.
