# Real-provider smoke drivers

Drive a real `pi --mode rpc` session with this repository loaded as an
extension, using a real model provider (no scripted provider, no credentials
needed beyond your normal Pi setup). The confirmation editor is answered over
the RPC extension-UI subprotocol, so the whole interactive flow runs headlessly.

These scripts complement the manual procedure in `docs/smoke-test.md`; the
deterministic gate remains `npm test`.

## Usage

```sh
node scripts/smoke/smoke.mjs
node scripts/smoke/smoke-restart.mjs
```

- `SMOKE_MODEL` — provider/model route (default `magpie/qoder/hmodel`). Pick a
  route with quota available; the scripts print provider errors as they happen.
- `SMOKE_TIMEOUT_MS` — per-wait timeout for the main script (default 240000).

Each run uses a fresh temporary working directory and session directory, and
`-ne` disables your installed extensions so only this checkout is loaded.

## Coverage

`smoke.mjs`: clarified creation with an edited title, bare `/goal` title
display, the unfinished-Goal refusal naming `/goal:clear`, `/goal:edit --title`,
pause/resume, clear, and a cancelled confirmation creating nothing.

`smoke-restart.mjs`: a clarification holding `--budget` is killed mid-editor
(SIGKILL), then the resumed session restores it with its held flags and the
confirmation commits the Goal with the held budget.
