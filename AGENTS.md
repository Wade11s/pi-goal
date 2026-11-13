## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `Wade11s/pi-goal` using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels with their default names. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Orchestration

For planning, issue delegation, implementation, PR review, and merges, follow `docs/agents/orchestration.md`.

---
## Code review (open-code-review delegate mode)

All code reviews must use the `open-code-review-delegate` skill: OCR only selects files and supplies rules; the reviewing agent performs the review itself using its own model.

- When to review: before merging every PR, and whenever dispatching a review subagent.
- Instruction for review subagents: "Use the open-code-review-delegate skill to review `<base>..<head>`, following the skill's Step 1–6. Report issues only; do not modify code." The default base is `main`, and the default head is the current branch.
- Required workflow:
  1. Run `ocr delegate preview --format json --from <base> --to <head>`; when requirement context is available (issue, acceptance criteria), add `-b "<summary>"`.
  2. Run `ocr delegate rule --format json <all reviewable files from preview>`.
  3. Read the diff at the merge_base supplied by preview. Every git invocation must include `--no-pager --no-ext-diff --no-textconv --no-color`.
  4. Review each file against its rule group, reading surrounding context when needed. Mark every file as reviewed, or skipped with a stated reason.
- Output format: every finding must include `path`, `start_line`, `end_line`, `category` (bug/security/performance/maintainability/test/style/documentation/other), `severity` (critical/high/medium/low), and `content`. Group findings by severity, and end with total_files, reviewed_files, skipped_files, and coverage_rate.
- Coverage must be 100%: never silently omit a file from preview. Silently discard likely false positives, and report low-severity findings only when clearly valuable.
- Review subagents only review; they must not modify code. The main agent arranges fixes separately based on review results. A PR must not be merged until all critical/high findings are resolved.
- If `--format` fails with `unknown flag`, remove that parameter, fall back to text output, and remind the user to upgrade ocr. For any other error, stop and report it; do not bypass the error.
---
