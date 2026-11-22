# Objective attachments

Explicit local text files and images attached to a Goal: how they are selected,
materialized, framed, verified, and retained.

[← README](../../README.md) · See also [lifecycle](lifecycle.md) ·
[persistence](persistence.md) · [events](events.md) · [tools](../tools.md)

## Why explicit attachments

The Objective is the user's finish line, stored verbatim under a strict length
policy (3–2000 characters). Long supporting material — a specification, a
transcript, a screenshot — does not belong inside that policy, and weakening the
policy to admit it would weaken the Objective for everyone. Attachments are the
separate, explicit channel: the user names the files at creation or Replacement
Goal time, the Objective stays verbatim, and the extension owns everything else.

This explicit flow is also the supported alternative to Codex's *composer
drafts* — pending pastes and image drafts that a host assembles before sending.
Pi exposes no equivalent draft object, so pi-goal does not infer one: plain
command arguments remain text, nothing is attached implicitly, and model-driven
creation stays text-only. What Pi does expose — `TextContent`/`ImageContent`
content arrays on user messages and custom messages — is exactly what
attachments use.

## Selecting attachments

```
/goal --file spec.md --image shot.png Ship the release with the attached material
```

- `--file <path>` selects a local **text file**; `--image <path>` selects a
  local **image**. Both are *leading* options, repeatable, mixable with the
  budget flags, and usable in the `--flag=value` spelling. Everything after the
  leading options is the Objective, so an objective that merely contains the
  word `--file` (or even starts a sentence with it) is never truncated — only a
  genuine leading flag is consumed.
- Attachment selection exists at **creation** and **Replacement Goal** time. A
  replacement confirmation is asked first exactly as for a text-only
  replacement; a declined dialog changes nothing.
- **Plain arguments remain text.** `/goal Read the --file flag in the README`
  creates a Goal whose objective is that whole sentence, with no attachments.
- **`create_goal` stays text-only.** Attachment-bearing creation is a direct
  user action only, so unquoted files and images never gain Goal creation
  authority: a drifted model call naming `file` or `images` parameters finds no
  such parameters, and nothing is attached.
- **Objective edit retains the manifest.** `/goal edit <objective>` keeps the
  immutable attachment manifest verbatim; an edit that starts with
  `--file`/`--image` is refused with guidance, because changing attachments
  requires a Replacement Goal. Editing also re-states the attachments in the
  edit message (unchanged, as data).
- **Disabled admission is enforced first.** While `goal.enabled` is false, an
  attachment-bearing creation or replacement is refused before the replacement
  dialog and before any byte is materialized.
- Remote image URLs are **not** supported in V1: `--image https://…` is refused
  up front. Remote fetching (HTTPS-only, fetched once, never refetched) is the
  scope of issue #50.

## Limits and supported types

| Rule | Value |
| --- | --- |
| Supported image media types | PNG, JPEG, GIF, WebP (decided by magic bytes, not by extension) |
| Rejected | SVG (explicitly, by extension and by policy) and every unknown media type |
| Text files must be | Valid UTF-8, non-empty |
| Maximum attachments per Goal | 8 |
| Maximum per text file | 1 MiB |
| Maximum per image | 10 MiB |
| Maximum total materialized content | 25 MiB |

Sniffing — not the file extension — decides the image media type, so a renamed
file cannot smuggle an unsupported format in. A duplicate `--file`/`--image`
label is refused rather than silently deduplicated in the manifest.

## Materialization and the artifact store

Before the Goal snapshot is committed, every attachment is **materialized**
into an immutable, extension-owned store keyed by Goal identity:

```
<session-directory>/pi-goal-store/<goal_id>/<sha256>.<ext>
```

- The store directory lives **beside the session file**, because Goal state is
  session state: a restart, a reload, a fork, and a clone all reconstruct from
  a session file in that directory, so the artifacts those branches reference
  stay resolvable. Copying a session file elsewhere without the store directory
  leaves the manifest unverifiable — the documented missing-artifact behavior,
  never a silent drop.
- Files are **content-addressed** (`<sha256>.<ext>`) and written read-only.
  Identical bytes are adopted rather than rewritten, so a retried command and a
  Goal that shares content with another Goal write nothing new.
- The durable manifest — the `attachments` array on every `goal-state`
  snapshot — records each attachment's **content hash, media type, byte size,
  and display label**. Source paths are not required for later Continuations:
  every kickoff and Continuation re-references the manifest and re-reads the
  store.
- All validation happens before any byte is written, and the whole request is
  refused on the first problem. A refused materialization retracts only the
  uncommitted store directory of the Goal that never committed.

**Failure atomicity**: a failed validation, materialization, or snapshot write
leaves the previous Goal untouched (nothing appended, its artifacts intact),
starts no kickoff, and emits no success event. A partially materialized
request — some artifacts written, then a missing file — retracts the whole
uncommitted directory. Artifacts of a Goal whose snapshot *did* commit,
including a replacement that was later retracted by its durability rollback,
are retained (below).

### Retention: nothing is garbage-collected in V1

Clearing a Goal and replacing it **retain every committed artifact**, because
another selected session branch — a fork taken before the clear, a clone, an
abandoned alternative — may still reference them through its own snapshots.
V1 performs no destructive automatic garbage collection; the only removal is
the retraction of a *never-committed* Goal's store directory after a failed
creation. The cost is bounded by the enforced limits (at most 25 MiB per Goal)
and is honest about what it is: artifacts are small, immutable, and permanent —
no background job ever decides that a branch you might return to no longer
needs its context.

## The trust boundary

Attachment content is exactly as untrusted as the Objective, and it is framed
the same way in every Goal message:

- **Text attachments** render as *encoded, delimited data* under the same
  random-nonce trust boundary as the Objective: a single line produced by the
  reversible `encodeObjectiveData` encoding (a JSON string literal with `<`,
  `>`, U+0085, U+2028, and U+2029 escaped), wrapped in
  `>>> BEGIN GOAL ATTACHMENT DATA (nonce …, label …, sha256 …) >>>` /
  `<<< END GOAL ATTACHMENT DATA (nonce …) <<<` sentinels whose nonce is random
  per message. A text file carrying forged `INSTRUCTIONS FROM PI-GOAL`
  headings or literal sentinels cannot close its own block, split the data
  line, or impersonate the contract.
- **Images** are sent through Pi's text/image content arrays: the kickoff is a
  user message whose content is `[text, image…]`, and Continuations are
  `goal-continuation` custom messages with the same shape. Pi normalizes
  prompt images exactly as it does for any user prompt (the durable artifact
  keeps the original bytes; the model sees Pi's normalized render).
- Every block names its **label and its manifest hash**, so every kickoff and
  Continuation references the same manifest entries; the nonce is fresh per
  message while the hashes never change.
- The one bounded budget wrap-up lists the manifest **metadata** (labels, media
  types, hashes) without repeating contents: no further Goal work is executed
  for a budget-limited Goal.

The pause and creation corroboration rules also exclude messages embedding the
attachment sentinels, exactly as they exclude the Objective's data block.

## Restore verification

On restore (session start and tree navigation) — and again before admitting
work that would re-send the attachments (a Continuation, a resume, an
active-Goal edit) — the manifest is verified against the store: every artifact
must exist and hash to its recorded sha256.

A **missing or corrupt** artifact:

- suppresses the automatic Continuation (and the Goal's continuation stays
  suppressed for as long as verification fails);
- surfaces an **explicit error** naming each failing attachment and the
  recovery path (restore the original bytes to the content-addressed path under
  `pi-goal-store`, or replace the Goal with one that re-attaches the files);
- **never** silently drops attachments, marks the Goal complete, or changes
  its Lifecycle status. The Goal keeps whatever status its durable snapshot
  recorded; `/goal pause` and `/goal clear` stay available; a resume of a
  stopped Goal is refused with the same explicit error rather than starting
  work from an incomplete Objective package.

A snapshot whose `attachments` manifest is structurally malformed (a bad hash,
an unsupported media type, a size above the enforced limit) is an unrecognized
snapshot: reconstruction fails closed with no current Goal, exactly like any
other hand-edited or future-versioned `goal-state` entry, rather than loading a
Goal whose required context cannot be named.

## Events

`pi-goal:updated` events carry the immutable **manifest metadata** — one
`{ hash, mediaType, bytes, label }` entry per attachment, an empty array for a
Goal without attachments — and **never attachment contents**, for the same
reason the objective travels as metadata only: the event is machine-consumed
by any loaded extension and is therefore the same trust and privacy surface as
a log line. See [events](events.md).

## Status reporting

Bare `/goal`, `get_goal`, and the structured tool payloads expose the manifest
as metadata: an `Attachments:` line naming each label, media type, and size.
The display label is the source file's basename; source paths are not kept.
