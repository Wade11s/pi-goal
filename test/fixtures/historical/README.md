# Historical session fixtures

Branches captured from a **released** pi-goal that the current code must still
reconstruct correctly. Unlike `../legacy/` (pre-repair 0.1.0 snapshots), these are
already in the repaired snapshot format; what makes them historical is that the
*command surface* can no longer produce them.

## `v0.2.0-open-superseded-tail.jsonl`

A session in which `/goal <objective>` **replaced an unfinished Goal** — the
behavior pi-goal 0.2.0 had (a confirmation dialog), removed by #83 / ADR-0003 — and
which then crashed in the window the superseded-record machinery exists for.

Provenance:

- Captured from pi-goal `0.2.0` at commit `bdc7197` (the last `main` before #83),
  on Pi `1.6.0`, through the same RPC harness the suite uses (`scripted` provider,
  isolated agent/session/working directories).
- Scenario: Goal `goal_a59e4c80` was created and its kickoff response (a `bash`
  tool call, 110 tokens) was held; `/goal A replacement objective` was confirmed,
  committing `goal_298e9038` while the first response was still in flight; the
  response was released and the process was `SIGKILL`ed **after** its assistant
  message reached the branch but **before** any freeze boundary (the replacement's
  steered kickoff was never delivered). That is the crash window of the former
  "hard crash between the old identity's tail and its freeze boundary" scenario.
- Edits to the captured file, both mechanical: the session header's `cwd` is a
  placeholder (`test/helpers/legacy-fixture.mjs` retargets the copy it hands to
  Pi), and Pi's stored system-prompt message was dropped because it carried the
  capturing machine's paths — the kickoff message that was parented to it is
  re-parented to the preceding entry so the branch chain stays complete. Every
  other line is byte-identical to the capture.
- Consumer: `test/goal9-ownership.test.mjs` ("a historical branch that replaced an
  unfinished Goal mid-flight …"). It proves the retained machinery end to end: on
  load the replacement is the current Goal at zero usage, the old identity's tail
  is recovered and frozen as one `superseded` snapshot carrying the 110 tokens, and
  the restored replacement is an ordinary unfinished Goal that `/goal <objective>`
  now refuses to replace.
