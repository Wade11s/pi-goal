# ADR-0003: Objective clarification by default, and no in-place replacement

- Status: accepted
- Date: 2026-11-24
- Relates to: the "Objective clarification", "Pending clarification", "Goal title",
  "Goal", "Objective", "Replacement Goal", and "Session naming" entries in
  `GLOSSARY.md`

## Context

Users routinely hand `/goal` a vague or overly broad Objective. The agent then
starts work immediately on an ambiguous finish line, and the completed work
fails the user's unstated acceptance standard. The creation flow needed a step
that turns a raw idea into a confirmed Objective — goal, constraints, and
acceptance criteria — before any Goal work is admitted. Separately, combining
that conversational flow with the existing replacement-confirmation dialog
raised the question of what `/goal <objective>` should do while an unfinished
Goal exists.

## Decision

1. **Every `/goal` creation clarifies by default** (`goal.clarifyOnCreate`,
   default `true`; `false` restores the direct-create behavior). The command
   starts a conversation instead of committing a Goal: the model interviews the
   user, drafts the final Objective and a Goal title, and opens a confirmation
   editor where both are editable. Saving the draft is the creation authority
   and commits the Goal; cancelling is zero-side-effect — no new Goal, no
   materialized artifacts, no remote fetches, current Goal untouched.
   Attachment arguments (`--file`/`--image`/`--remote-image`) are held and only
   materialized after the confirmed save. The pending entry is durable and moves
   through `pending` → `confirming` → `ended`; it is reconstructed on the selected
   branch and anchored to the base Goal identity, so a later Goal-slot change
   makes a stale draft unconfirmable. A host without UI skips clarification,
   creates directly as before, and prints a notice.
2. **The Objective template is a drafting convention, not a validation rule.**
   The model drafts three English-titled sections — `Objective:` (one sentence
   stating what is different when done), `Constraints:` (hard limits, `None`
   when empty), and `Acceptance criteria:` (numbered, each independently
   verifiable with its verification method named). Extension validation stays
   at 3–2000 characters. Because the criteria live in the Objective text, the
   existing Completion audit enforces them requirement by requirement with no
   new audit machinery. A considered "Out of scope" section was dropped as not
   useful.
3. **Goal title is persisted Goal state**: one line, 1–80 characters,
   model-drafted during clarification, user-confirmed, stored in the snapshot,
   editable with `/goal:edit`, shown in status output. Session naming prefers
   the title over the Objective's first line.
4. **`/goal` no longer replaces an unfinished Goal.** With an unfinished Goal
   present it refuses with a warning directing the user to `/goal:clear` (or
   finish the current Goal) instead of showing a replacement confirmation;
   a complete Goal does not block creation. Bare `/goal` remains the status
   report, so no `/goal:status` is added. The Replacement Goal / Superseded
   record machinery remains for historical branches and for superseding a
   complete Goal without a replacement-confirmation dialog (normal clarification still
   applies); it is never used to replace an unfinished one. The
   `create_goal` tool path is unchanged by all of the above.

### Considered options

- **Opt-in clarification (default off)**, matching the other convenience
  settings. Rejected by the user: vague objectives are the default problem, so
  the remedy must be the default path; the setting remains as an escape hatch.
- **Fold replacement confirmation into the clarification editor.** Rejected by
  the user: one session works one Goal at a time, and abandoning a Goal should
  be an explicit `/goal:clear`, not a side effect of a creation dialog.
- **Enforce the three sections in code.** Rejected: cross-language section
  detection is brittle and would reject legitimate simple objectives.
- **Separate `constraints` / `acceptanceCriteria` schema fields.** Rejected:
  they would ripple through snapshots, events, history, and the RPC companion,
  while the Completion audit already reads the Objective text.
- **`/goal:status` to replace inspection.** Rejected: bare `/goal` already is
  the status report; only the argument-bearing creation path changes.

## Consequences

- This is a **breaking default-behavior change** for `/goal`: creation no longer
  commits immediately, and in-place replacement is gone. With an unfinished Goal
  present the command refuses and names `/goal:clear`; only a complete Goal is
  superseded, without a replacement-confirmation dialog (normal clarification
  still applies). The CHANGELOG, README, and lifecycle docs must say so,
  and the glossary's Replacement Goal family of entries is revised with it.
- The confirmation editor, not a verbatim quotation, is the creation authority
  for the clarified path; `create_goal`'s quotation authority is untouched.
- Structured tool payloads, the status report, session naming, and the RPC
  companion's get response gain the title. Title text is **excluded** from
  Goal-updated events, `goal-history` records, and Goal metrics: it follows the
  Objective's privacy boundary, so it stays in the durable snapshot and the
  user-facing surfaces. (This corrects the earlier consequence note, which would
  have added the title to the event stream.) A title-only edit still commits an
  ordinary in-place transition, without the label text. The work is sized in the
  implementation spec.
