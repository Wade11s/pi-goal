# Objective attachments

Explicit local text files, local images, and fetched remote images attached to
a Goal: how they are selected, fetched, materialized, framed, verified, and
retained.

[← README](../../README.md) · See also [lifecycle](lifecycle.md) ·
[persistence](persistence.md) · [events](events.md) · [tools](../tools.md)

## Why explicit attachments

The Objective is the user's finish line, stored verbatim under a strict length
policy (3–2000 characters). Long supporting material — a specification, a
transcript, a screenshot — does not belong inside that policy, and weakening the
policy to admit it would weaken the Objective for everyone. Attachments are the
separate, explicit channel: the user names the files or the HTTPS image URL at
creation or Replacement Goal time, the Objective stays verbatim, and the
extension owns everything else.

This explicit flow is also the supported alternative to Codex's *composer
drafts* — pending pastes and image drafts that a host assembles before sending.
Pi exposes no equivalent draft object, so pi-goal does not infer one: plain
command arguments remain text, nothing is attached implicitly, and model-driven
creation stays text-only. What Pi does expose — `TextContent`/`ImageContent`
content arrays on user messages and custom messages — is exactly what
attachments use.

## Selecting attachments

```
/goal --file spec.md --image shot.png --remote-image https://example.com/diagram.png Ship the release
```

- `--file <path>` selects a local **text file**; `--image <path>` selects a
  local **image**; `--remote-image <https-url>` selects a **remote image** to
  fetch once. All three are *leading* options, repeatable, mixable with the
  budget flags, and usable in the `--flag=value` spelling. Everything after the
  leading options is the Objective, so an Objective that merely contains the
  word `--file` after its first plain word is never truncated — only a genuine
  leading flag is consumed. Local option values are whitespace-free paths;
  paths containing spaces are not representable by this parser.
- Attachment selection exists at **creation** and **Replacement Goal** time. A
  replacement confirmation is asked first exactly as for a text-only
  replacement; a declined dialog changes nothing.
- Relative paths resolve against the **session working directory** recorded in
  the session header, not against the directory the Pi process happens to be
  launched from. A session resumed from another directory therefore attaches
  the same-named file beside the session, never a namesake in the launch
  directory. Absolute paths are used unchanged.
- Sources must be **regular files**. Symlinks are refused explicitly rather
  than followed, and FIFOs, devices, and directories are refused without being
  opened for content (a FIFO can never block the command).
- **Plain arguments remain text.** `/goal Read the --file flag in the README`
  creates a Goal whose objective is that whole sentence, with no attachments.
- **`create_goal` stays text-only.** Attachment-bearing creation is a direct
  user action only, so unquoted files and images never gain Goal creation
  authority: a drifted model call naming `file` or `images` parameters finds no
  such parameters, and nothing is attached.
- **Objective edit retains the manifest.** `/goal edit <objective>` keeps the
  immutable attachment manifest verbatim; an edit that starts with
  `--file`/`--image`/`--remote-image` is refused with guidance, because changing
  attachments requires a Replacement Goal. Editing also re-states the
  attachments in the edit message (unchanged, as data).
- **Disabled admission is enforced first.** While `goal.enabled` is false, an
  attachment-bearing creation or replacement is refused before the replacement
  dialog and before any byte is materialized.
- **Remote images are explicit.** `--image https://…` is refused: use
  `--remote-image <https-url>` so the user unambiguously selected a fetch.
  Remote fetching is never inferred from plain text, a model call, or a composer
  draft, and `create_goal` stays text-only.

## Remote fetching

A remote image is fetched once, at creation or Replacement Goal time, into the
same immutable store as a local image. Every later Continuation reads the stored
bytes and never contacts the source URL again.

- **HTTPS only.** HTTP, FTP, and every other scheme are refused before a
  connection. URL credentials (`user:password@`) are refused outright rather
  than stripped, and the request sends no `Authorization`, `Cookie`, or
  `Referer` header.
- **One 15-second deadline** covers DNS resolution, every redirect, and the body
  read. A stalled response or a stalled body is torn down at the deadline.
- **At most three redirects**, each target revalidated exactly like the original
  URL: HTTPS, no credentials, and a public destination. A redirect downgrade, a
  credential-bearing target, a missing `Location`, or a target resolving to a
  forbidden address is refused before that target is contacted.
- **Public destinations only.** Loopback, link-local, private, unique-local,
  IPv4-mapped private, NAT64/6to4, multicast, and other reserved or
  documentation ranges are refused. The check runs on IP literals, on **every**
  DNS result (not just a preferred one), and on every redirect target. The
  validated addresses are then pinned into the connection's lookup, so a DNS
  answer that changes between resolution and connection cannot redirect the
  socket. The resolver's answer itself is trusted as the resolver gave it; TLS
  certificate validation still checks the URL hostname independently.
- **Bounded reads.** `Content-Length` over the remaining limit is refused before
  the body is read, and a streaming body is destroyed as soon as it exceeds the
  limit. The body is never buffered without bound; redirect bodies have a
  separate small bound.
- **Bytes, not the URL, decide the media type.** The fetched bytes go through the
  same PNG/JPEG/GIF/WebP magic-byte sniffing as a local image. SVG and unknown
  content are refused even when the URL ends in `.png` or the server labels it
  `image/png`; a `.jpg` URL serving PNG bytes is stored as PNG.
- **Nothing is persisted from the source.** The durable manifest records the
  content hash, media type, byte size, and a display label derived from the URL
  basename. The URL, its query string, and its credentials are not stored in a
  snapshot, an event, or a metric. The source URL is not required by a later
  Continuation.

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

Sniffing — not the file extension or a remote `Content-Type` — decides the
image media type, so a renamed file or a mislabelled response cannot smuggle an
unsupported format in. A duplicate `--file`/`--image`/`--remote-image` label is
refused rather than silently deduplicated in the manifest.

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
  and display label**. Local source paths and remote source URLs are not
  required for later Continuations: every kickoff and Continuation
  re-references the manifest and re-reads the store.
- Source validation happens before any byte is written, and the whole request
  is refused on the first problem. A write failure can leave a partially written
  directory, so any refused materialization or pre-commit snapshot failure
  retracts only the uncommitted store directory of the Goal that never
  committed.
- Each local source is read once through a descriptor opened with `O_NOFOLLOW`
  and a non-blocking flag. Its size is checked on the opened descriptor before
  any content-sized allocation, no more than the applicable limit plus one byte
  is read, and a final descriptor/path check refuses a file that grew, shrank, or
  was replaced during the read. A stable oversized file is refused from its
  descriptor size without being buffered.
- Each remote source is fetched once through the bounded policy above, then its
  bytes take exactly the local materialization path. The fetch is capped by both
  the 10 MiB per-image limit and the remaining 25 MiB total, so a remote body
  cannot push the Goal over the cumulative limit.

**Failure atomicity**: a failed fetch, validation, materialization, or snapshot
write leaves the previous Goal untouched (nothing appended, its artifacts
intact), starts no kickoff, and emits no success event. A partially materialized
request — some artifacts written, then a store write failure — retracts the
whole uncommitted directory. Artifacts of a Goal whose snapshot *did* commit,
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
must exist, be a regular bounded file, fit its recorded byte size and the
per-file/total limits, and hash to its recorded sha256.

Work-admitting paths use one **authenticated load**, not a separate verify and
then a second read. The loader opens each artifact once under the same
symlink/special-file and bounded-read rules as materialization, enforces the
manifest size and limits on those bytes, verifies the hash on those bytes, and
returns exactly those bytes for message construction. A file replaced after an
earlier verification therefore cannot be sent while the message quotes the old
hash. A resume loads and authenticates its attachments **before** the durable
resume transition, so a load failure leaves the Goal paused instead of active
with no work started.

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
The display label is the local source file's basename, or the remote URL's
basename after decoding; source paths and source URLs are not kept.
