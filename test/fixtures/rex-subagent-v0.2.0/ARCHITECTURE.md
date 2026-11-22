# Architecture

How `rex-subagent` decides what is true, what is terminal, and what may run
concurrently. Read this before changing lifecycle code.

## The three sources of truth

Every run is described by three independent sources, each with its own
lifetime:

| Source | File | Written by | Says |
| --- | --- | --- | --- |
| Record | `metadata.json` | parent CLI and accounting-aware parent tools | pinned Rex endpoint/host, session/window/block ids, accounting ownership, durable state |
| Status | `status.json` | child extension, on every turn event | the agent's current **turn** state |
| Probe | `rex block call … process` | parent CLI, on demand | the **OS process** behind the window, and its real exit code |

`usage.json` is a separate accounting contract, not a fourth source of
lifecycle truth. The child writes cumulative selected-branch Usage snapshots;
the parent's persisted tool results are the authoritative cross-process
accounting records. Neither one changes the record/status/probe state machine.
See [Usage accounting](docs/usage-accounting.md).

Rex `program_status_changed` and `child_exited` events are wakeups, not a fourth
source of truth. `wait --any` subscribes to them, then reconciles the same
record/status/probe state before returning a result. Startup and a slow fallback
snapshot cover reports missed while subscribing or after a disconnect.

The agent's turn state and the OS process state are **separate axes**:

- `agentState` (from `status.json`): `starting | busy | idle | stopped`
- `processState` (from the probe): `starting | running | exited | gone | unknown`
- `processExitCode`: the OS exit code, known only after the process ends

`observeRun` in `src/record.ts` merges them into one display state, with this
precedence (first match wins):

1. record `failed` → the launch never produced a manageable process
2. record `stopped` → stop was confirmed; missing Rex resources are expected
3. probe `missing` → `gone`: the Rex resources no longer exist
4. probe `exited` → terminal, carrying the **real** exit code — even if a stale
   `status.json` still claims `busy` or `idle`. If the child had acknowledged
   the stop sentinel, this counts as a completed `stopped` instead
5. probe `unknown` → Rex unreachable: report the last `busy` signal, or
   `starting` while the record is still starting without any status file
6. otherwise the agent-turn state from `status.json` decides; note that a
   child status of `stopped` while the process still lives is **`stopping`**,
   not `stopped`: the child aborting its own turn is not a confirmed stop

The child extension never writes an exit code. A settled turn (`idle`) says the
*agent* finished; it says nothing about the *process*. The child's old
`lastExit: 0` habit was removed precisely because it fabricated a clean exit
that the process never had.

## Terminal states

`failed`, `stopped`, `gone` and `exited` are terminal. `stopping` is **not**
terminal: it means the child saw the stop sentinel and aborted its turn, but
the OS process is still alive and the close was not confirmed — `wait` keeps
polling until the process really ends (then the outcome is `stopped` with the
real exit code, or `exited`). Nothing in this package restarts a dead run;
there is no recovery path. `wait` resolves terminal states immediately:

- `idle` → turns finished (turn ≥ 1 and an empty inbox), process alive
- `stopped` → stopped on purpose (confirmed record, or child-acknowledged stop
  whose process then ended)
- `exited` → the process ended; `processExitCode` is Rex's `last_exit.exit_code`
- `gone`, `failed` → the run is no longer manageable
- `timeout` → deadline passed while non-terminal (including `stopping`)

A run that dies **before its first turn** or **mid-turn** still resolves as
`exited` (not `timeout`), so callers always learn the real exit code.

`wait --any` additionally returns `blocked` and `error` as early **attention**
outcomes. They are not terminal run states and never count as success; the run
may continue or be steered afterwards. Pending handles are omitted whenever at
least one result is ready. Default `wait` retains its all-settled barrier.

`waitOutcomeOk` classifies an `exited` result as success only when **all** of
these hold: exit code `0`, `agentState` was `idle` (not `busy`/`starting`/never
written), at least one turn ran (`turn > 0`), and no messages were left queued
in the inbox (`pendingMessages === 0`). Exit code 0 alone proves nothing — the
TUI can be closed (or Pi die in startup) before the first turn; that case is
reported as failure, matching "after finishing its turns".

## Stop semantics

`stop` writes the local `stop` sentinel, then closes the Rex session (if the
run owns it) or just the window. The record is marked `stopped` — and `--remove`
may delete the run directory — **only after** Rex confirmed the close, or a
follow-up probe proved the block no longer exists (a client-side timeout may
still have executed server-side).

On failure:

- the record keeps its previous state, so the stop can be retried;
- `stopError` on the record records why;
- `--remove` never runs — deleting the only management record while the child
  may still be alive would orphan it.

The sentinel is always written. The child that sees it aborts the running turn
and publishes an early non-final usage snapshot. Once the aborted turn and its
tool results settle, it publishes the final snapshot, writes `status: stopped`,
and requests Pi's graceful shutdown (which exits with the normal success code).
So even when the Rex CLI is unreachable, the agent process can end and the next
probe observes the real exit. Until stop is confirmed the run displays
`stopping` — not a terminal `stopped`.

That graceful path is bounded (10 s by default, overridable with
`REX_SUBAGENT_STOP_GRACE_MS`). If the aborted turn never settles, or the final
snapshot cannot be published, the child falls back to the pre-accounting forced
success exit: it writes `status: stopped` and exits 0, so an intentional stop
is never reclassified as an incidental nonzero `exited` outcome by a window
kill. The fallback never claims a final snapshot for an unsettled turn. The
first live parent attempt still requires a final snapshot and keeps records
(plus the `usageFinalizationRequired` marker) when it is unavailable. A later
retry that proves the process terminal may instead finish with an explicit
`finalization: "unconfirmed"` or `snapshot: "missing"` diagnostic and remove
the records, so unsettled usage may remain unrecoverable; child `stopped` status
is not an accounting-completion signal.

The accounting-aware parent stop path waits up to 15 s for that final snapshot
before the close, deliberately longer than the child's default 10 s grace so a
healthy slow settlement is not preempted. It performs final observation before
removal. A finalization failure
does not prevent the safety stop, but it prevents that accounting-aware removal
attempt and leaves a durable `usageFinalizationRequired` marker. The marker is
persisted only when the run was reliably live immediately before the stop; an
undeterminable pre-stop state (a failed describe or an `unknown` display state)
fails closed for that attempt alone and cannot poison later dead-child
collection.

A later retry with a provably terminal pre-stop process can collect the last
valid non-final snapshot as `finalization: "unconfirmed"`, without changing
its `final: false` value. Successful collection clears the marker and permits
removal. Malformed snapshots remain untouched and keep the retry state. If an
owned direct-spawn or pre-upgrade run dies before ever publishing a snapshot,
terminal wait/stop can record a sequence-zero `snapshot: "missing"`,
`finalization: "unconfirmed"` cursor with no Usage delta, even when the old run
has no branch baseline. Its zero value is recovery bookkeeping, not a historical
usage claim; replay is idempotent, live/missing and adoption/missing remain
errors, and a later-appearing snapshot is rejected rather than charged as
unknown history. Existing CLI stop and prune behavior does not provide
accounting-aware removal guarantees.

If a child launches but its parent spawn baseline cannot be recorded, the
accounting spawn path stores `usageBaselineError` and rolls back through a
non-removing stop. The failed tool result reports the handle and whether
rollback succeeded; a rollback failure explicitly requires external management.
The retained failed spawn cannot be adopted to discard its unknown history.
Existing CLI stop remains available for that management path.

## Message delivery semantics

- A message is one JSON file, `inbox/NNNN.json`, written atomically
  (temp file + rename) — readers never see partial writes.
- Delivery is **at least once into the inbox, exactly one file per message**:
  the child consumes files in order and unlinks each after handing it to Pi.
  If the child dies between delivering and unlinking, the message is re-delivered
  on restart of the same run; it is lost if the run is removed.
- Sending to a run whose process is provably dead (`stopped`, `gone`, `exited`,
  `failed`) is **rejected** — nothing would ever consume the file.
- When the probe is `unknown` (Rex unreachable) the message is still queued,
  and the result says `unconfirmed: true`: it will be delivered only if the
  child turns out to be alive. The child polls the inbox locally; delivery does
  not depend on Rex.

### Inbox concurrency

Two CLI processes sending to one run must not pick the same index (POSIX
`rename` would let the second silently overwrite the first). `queueMessage`
serializes allocate-index → write → update-`.seq` behind `inbox/.lock`:

- the lock is created with `O_EXCL` and holds a unique **owner token**;
- a fresh lock is waited on (bounded); a lock older than 10 s is treated as
  abandoned and stolen;
- a holder whose lock was stolen neither releases the successor's lock (the
  token is re-read before unlink) nor publishes under it (`owns()` is re-read
  before the rename; on mismatch the allocation restarts). The remaining
  exposure is the tiny verify→rename gap, and only for a holder that already
  looked 10 s stale;
- the index is `max(last file, .seq) + 1` (plus a same-name guard for crash
  leftovers), so numbering survives a crash between the rename and the `.seq`
  write **as long as the message file is still present** to be scanned. If the
  child already consumed and unlinked it before the next sender runs, the
  number may be reused once — harmless, because indexes only order the files
  present in the inbox, they are not message identities.

Within one process, concurrent `queueMessage` calls interleave the same way.

## Concurrency contracts

| Operations | Contract |
| --- | --- |
| `send` ∥ `send` | serialized by the inbox lock; distinct indexes |
| `send` ∥ `spawn` | the first message is queued before the window exists; the child drains on boot |
| `send` ∥ `stop` | a stop may race a send; once the run is `stopping` the child no longer drains, so sends are refused |
| `stop` ∥ `stop` | idempotent; both converge on `stopped` or the same `stopError` |
| `observe` ∥ `observe` | parent-local transaction queue; each snapshot delta is charged at most once, multi-run calls commit atomically |
| `adopt` ∥ `adopt` | a complete per-run owner temporary file is published once by atomic no-overwrite hard link; the first complete claim wins across independent parent processes, later adopters re-read it, and no stale lock needs stealing or deletion |
| `spawn` ∥ `prune` | `prune` keeps `starting` records younger than 5 minutes, so an in-flight launch is never deleted |
| `spawn`/`prune`/`stop` ∥ `send` | a run directory may vanish between operations; every reader treats a missing record as "no such run" |
| record updates | read-modify-write per-field patches. `parentSessionId` may only be claimed once by adoption, under the parent-local transaction queue and atomic hard-link claim publication; `usageFinalizationRequired` is set only from a reliably live pre-stop state and cleared after successful collection; `usageBaselineError` is retained when post-launch baseline recording fails. As with concurrent CLI calls, bare CLI operations must not race accounting updates on the same run; no same-field multi-writer guarantee is added |

## Probe batching and caching

`status`/`list`/`wait` used to run one `rex whoami` (validation) plus one probe
per run, serially. Now:

- `whoami` validation is cached per `(endpoint, hostId)` for 10 s per runner
  instance (failures are not cached); concurrent probes share one in-flight
  validation;
- probes run with a concurrency limit of 6;
- `wait` bounds every Rex call by the remaining wall-clock budget, so one slow
  probe cannot blow past `--for`;
- `wait --any` opens one streaming `rex events` subscription per involved
  session instead of relying on the 400 ms polling loop. Its 2 s reconciliation
  fallback still uses the same probe concurrency and deadline limits. The
  streaming client has a separate runner because `defaultRunner`'s output cap
  and process timeout are inappropriate for a long-lived event stream.

Mutating operations (`stop`, `open`) still validate uncached — they must not act
against a server that changed seconds ago.

Widgets use `probe: false`: they read only local files, which means they can
briefly show a stale `busy`/`idle` for a process that just died. The next
probing command (`status`, `wait`, `list --json`) corrects it.

## Logs

`logs --tail N` renders only the last ~1 MB of the newest session JSONL, then
keeps the final N lines — long sessions must not make the CLI slow or heavy.
The transcript numbering (`=== prompt k ===`) is relative to the messages that
were actually read; with a truncated tail, `k` starts at the first complete
message in the window.

## Command runner limits

`defaultRunner` kills commands after 15 s (Rex calls after 5 s) and caps
captured stdout/stderr at ~2 MB each, appending `[output truncated]`. Callers
that need more must stream it themselves.

## Known limits

- **Ownership-claim crash debris.** `.accounting-owner.json` is written as a
  complete temporary file and published by atomic no-overwrite hard link, so an
  existing claim is never overwritten and readers never see a create→write
  partial claim. Ordinary failures clean the temporary file. An actual process
  crash can leave an orphaned `.tmp-*` file, which readers ignore; before the
  link the run remains unowned, and after it the complete winner survives.
  Malformed legacy/external claims and conflicting metadata identities still
  fail closed rather than being automatically removed or replaced.
- **Hard-link filesystem support.** Ownership claims publish a complete
  temporary file with `link(2)` so readers never see partial content and an
  existing owner is never overwritten. Filesystems that do not support hard
  links return a run-level accounting error and no claim is published; there is
  deliberately no direct-write fallback that would reintroduce partial claims.
  The temporary file and target share a directory, so cross-device links are not
  attempted.
- **Inbox lock, verify→rename gap.** The ownership token eliminates the
  realistic stale-lock accidents (deleting a successor's lock, publishing under
  a successor), but the `owns()` check and the `renameSync` publish are not one
  atomic step. Two processes can in principle interleave in that gap — only if
  a holder already looked 10 s stale *and* was still alive. The critical
  section is a few synchronous fs operations, so a holder slow enough to be
  stolen from is effectively wedged, not healthy; we accept this as a
  documented low-probability residual risk. A strictly guaranteed lock would
  need a heartbeat/liveness-checked (or advisory-`flock`-style) scheme.
- **Widget staleness.** The status widget reads only local files, so it can
  briefly show a stale `busy`/`idle`/`stopping` for a run whose process just
  died; the next probing command corrects it.
