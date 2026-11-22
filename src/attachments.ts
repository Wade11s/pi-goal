/**
 * Objective attachments: validation, materialization, and verification of the
 * immutable extension-owned artifact store (issue #49).
 *
 * A direct user command (`/goal --file <path> --image <path> ... <objective>`)
 * may attach explicit local text files and local images to a Goal. The
 * Objective itself stays verbatim with its existing length policy; long or
 * binary supporting material becomes a separate attachment instead of being
 * folded into the Objective. `create_goal` stays text-only, so unquoted files
 * and images never gain Goal creation authority.
 *
 * Artifacts are materialized into a store **keyed by Goal identity** — one
 * directory per Goal under a `pi-goal-store` directory that lives beside the
 * session file — before the Goal snapshot is committed. Files inside are
 * content-addressed (`<sha256>.<ext>`), written read-only, and never rewritten
 * or garbage-collected: another selected session branch (a fork, a clone, or an
 * abandoned alternative) may still reference them, so clear and replacement
 * retain every committed artifact. V1 performs no destructive garbage
 * collection; only artifacts of a Goal whose creation failed *before* any
 * snapshot referenced them are retracted (`discardUncommittedArtifacts`).
 *
 * The durable manifest — the `attachments` array on the Goal snapshot — records
 * each attachment's content hash, media type, byte size, and display label.
 * Source paths are not required for later Continuations: every kickoff and
 * Continuation re-references the same manifest and re-reads the store.
 *
 * On restore (and before admitting work that would re-send the attachments),
 * the manifest and the artifact hashes are verified. Missing or corrupt
 * artifacts suppress automatic Continuation and surface an explicit error;
 * attachments are never silently dropped, the Goal is never completed, and its
 * Lifecycle status never changes because of an artifact problem.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AttachmentContent, GoalAttachment } from "./goal.ts";

/** At most this many attachments per Goal (text and images together). */
export const MAX_ATTACHMENTS = 8;

/** At most this many bytes per text file after materialization. */
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024; // 1 MiB

/** At most this many bytes per image after materialization. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

/** At most this many bytes of materialized attachment content per Goal. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB

/** The one supported text media type. */
export const TEXT_ATTACHMENT_MEDIA_TYPE = "text/plain";

/** The image media types V1 supports, in manifest-canonical order. */
export const IMAGE_ATTACHMENT_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

/** Every media type a manifest entry may carry. */
export const ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set<string>([
	TEXT_ATTACHMENT_MEDIA_TYPE,
	...IMAGE_ATTACHMENT_MEDIA_TYPES,
]);

/** Directory name of the artifact store inside the session directory. */
export const ATTACHMENT_STORE_DIR = "pi-goal-store";

/**
 * One explicit attachment request parsed from the leading `/goal` options.
 *
 * `kind` is what the user asked for — a text file (`--file`) or a local image
 * (`--image`) — and decides which limit and which validation apply. The path is
 * resolved relative to the session's working directory, exactly as the user
 * typed it.
 */
export interface AttachmentRequest {
	kind: "text" | "image";
	path: string;
}

/** Outcome of validating and materializing a request list. */
export type MaterializeResult =
	| { ok: true; attachments: GoalAttachment[]; contents: AttachmentContent[] }
	| { ok: false; error: string };

/** Outcome of verifying a committed manifest against the store. */
export type VerifyResult = { ok: true } | { ok: false; problems: string[] };

/** Outcome of loading committed artifacts for message rendering. */
export type LoadResult =
	| { ok: true; contents: AttachmentContent[] }
	| { ok: false; error: string };

/**
 * The artifact store root for a session: a `pi-goal-store` directory beside the
 * session file.
 *
 * Keyed to the session file's own directory because Goal state is session
 * state: a restart, a reload, a fork, and a clone all reconstruct from a session
 * file in this directory, so the artifacts those branches reference stay
 * resolvable. Copying a session file elsewhere without the store directory
 * leaves the manifest unverifiable — which is the documented missing-artifact
 * behavior (continuation suppressed, explicit error), never a silent drop.
 */
export function attachmentStoreRoot(sessionFile: string): string {
	return join(dirname(sessionFile), ATTACHMENT_STORE_DIR);
}

/** The per-Goal store directory (one per Goal identity). */
export function goalStoreDir(storeRoot: string, goalId: string): string {
	return join(storeRoot, goalId);
}

/** File extension for one media type (display only; addressing is by hash). */
function extensionFor(mediaType: string): string {
	switch (mediaType) {
		case "image/png":
			return ".png";
		case "image/jpeg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		default:
			return ".txt";
	}
}

/** The content-addressed artifact path for one manifest entry. */
export function artifactPath(storeRoot: string, goalId: string, attachment: GoalAttachment): string {
	return join(goalStoreDir(storeRoot, goalId), `${attachment.hash}${extensionFor(attachment.mediaType)}`);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate one raw flag value before anything is read.
 *
 * Remote image URLs are deliberately unsupported in V1 (issue #50 owns remote
 * fetching), so an `--image https://…` request is refused up front rather than
 * being read as a local path. Empty values are refused for both kinds.
 */
export function validateAttachmentPath(kind: "text" | "image", raw: string): { ok: true; path: string } | { ok: false; error: string } {
	const path = raw.trim();
	const flag = kind === "image" ? "--image" : "--file";
	if (path === "") {
		return { ok: false, error: `Goal not created: ${flag} needs a local file path.` };
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) {
		return {
			ok: false,
			error:
				`Goal not created: ${flag} accepts a local file path, not the URL ${JSON.stringify(path)}. ` +
				"Remote image fetching is not supported yet.",
		};
	}
	return { ok: true, path };
}

/**
 * Sniff an image's media type from its leading bytes.
 *
 * PNG, JPEG, GIF, and WebP are recognized by magic bytes; SVG is rejected
 * explicitly (its extension is enough to refuse it before reading), and
 * everything else is an unknown media type. Sniffing — not the extension —
 * decides, so a renamed file cannot smuggle an unsupported format in.
 */
export function sniffImageMediaType(bytes: Uint8Array): (typeof IMAGE_ATTACHMENT_MEDIA_TYPES)[number] | null {
	const startsWith = (prefix: number[] | string, offset = 0): boolean => {
		if (bytes.length < offset + prefix.length) return false;
		if (typeof prefix === "string") {
			for (let i = 0; i < prefix.length; i++) {
				if (bytes[offset + i] !== prefix.charCodeAt(i)) return false;
			}
			return true;
		}
		for (let i = 0; i < prefix.length; i++) {
			if (bytes[offset + i] !== prefix[i]) return false;
		}
		return true;
	};
	if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith("GIF87a") || startsWith("GIF89a")) return "image/gif";
	if (startsWith("RIFF") && startsWith("WEBP", 8)) return "image/webp";
	return null;
}

/** Whether a source path is an SVG by extension (refused before reading). */
function isSvgPath(path: string): boolean {
	return /\.svgz?$/i.test(path);
}

/** Decode strict UTF-8, rejecting invalid sequences and lone surrogates. */
function decodeStrictUtf8(bytes: Uint8Array): string | null {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		// Reject unpaired surrogates: they survive JSON round-trips badly and are
		// not honest text content.
		if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) return null;
		return text;
	} catch {
		return null;
	}
}

/**
 * Validate and materialize every request into the Goal's store directory.
 *
 * All validation happens before any byte is written; the first problem refuses
 * the whole request, so a partially materialized Goal never commits. Sizes are
 * the *materialized* bytes (text is stored as its UTF-8 bytes, decoded once for
 * rendering), and the limits are per text file, per image, and cumulative.
 *
 * Content-addressed writes are idempotent: an artifact that already exists with
 * the manifest hash is adopted (its bytes are identical by construction), and
 * one that exists with different bytes is a hash collision or tampering and is
 * refused. New artifacts are written read-only, which is the store's
 * immutability gesture at the filesystem level; verification, not the mode
 * bits, is the actual integrity guarantee.
 */
export function materializeAttachments(
	storeRoot: string,
	goalId: string,
	requests: readonly AttachmentRequest[],
): MaterializeResult {
	if (requests.length === 0) return { ok: true, attachments: [], contents: [] };
	if (requests.length > MAX_ATTACHMENTS) {
		return {
			ok: false,
			error:
				`Goal not created: at most ${MAX_ATTACHMENTS} attachments are allowed per Goal ` +
				`(${requests.length} were requested).`,
		};
	}
	const labelSeen = new Set<string>();
	const prepared: Array<{ request: AttachmentRequest; mediaType: string; bytes: Uint8Array; hash: string; label: string; size: number }> = [];
	let total = 0;
	for (const request of requests) {
		const label = basename(request.path) || request.path;
		if (labelSeen.has(`${request.kind}:${label}`)) {
			return {
				ok: false,
				error: `Goal not created: ${request.kind === "image" ? "--image" : "--file"} names ${JSON.stringify(label)} more than once.`,
			};
		}
		labelSeen.add(`${request.kind}:${label}`);
		let stat;
		try {
			stat = statSync(request.path);
		} catch {
			return {
				ok: false,
				error: `Goal not created: the ${request.kind === "image" ? "image" : "text file"} ${JSON.stringify(request.path)} does not exist or cannot be accessed.`,
			};
		}
		if (!stat.isFile()) {
			return {
				ok: false,
				error: `Goal not created: ${JSON.stringify(request.path)} is not a regular file.`,
			};
		}
		const maxBytes = request.kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
		if (stat.size > maxBytes) {
			return {
				ok: false,
				error:
					`Goal not created: the attachment ${JSON.stringify(label)} is ${formatBytes(stat.size)}, above the ` +
					`${formatBytes(maxBytes)} limit for a ${request.kind === "image" ? "local image" : "text file"}.`,
			};
		}
		if (request.kind === "image" && isSvgPath(request.path)) {
			return {
				ok: false,
				error:
					`Goal not created: the attachment ${JSON.stringify(label)} is an SVG. SVG is not a supported image ` +
					"attachment (its markup is executable in some hosts); use PNG, JPEG, GIF, or WebP.",
			};
		}
		let bytes: Uint8Array;
		try {
			bytes = readFileSync(request.path);
		} catch (error) {
			return {
				ok: false,
				error: `Goal not created: the attachment ${JSON.stringify(label)} could not be read (${describe(error)}).`,
			};
		}
		if (bytes.length === 0) {
			return { ok: false, error: `Goal not created: the attachment ${JSON.stringify(label)} is empty.` };
		}
		// Enforce the limit on the bytes actually materialized, not only on the
		// earlier stat: a local file can grow between those two reads.
		if (bytes.length > maxBytes) {
			return {
				ok: false,
				error:
					`Goal not created: the attachment ${JSON.stringify(label)} is ${formatBytes(bytes.length)}, above the ` +
					`${formatBytes(maxBytes)} limit for a ${request.kind === "image" ? "local image" : "text file"}.`,
			};
		}
		let mediaType: string;
		if (request.kind === "image") {
			const sniffed = sniffImageMediaType(bytes);
			if (sniffed === null) {
				return {
					ok: false,
					error:
						`Goal not created: the attachment ${JSON.stringify(label)} is not a recognized image. Supported image ` +
						"types are PNG, JPEG, GIF, and WebP; SVG and unknown media types are rejected.",
				};
			}
			mediaType = sniffed;
		} else {
			if (decodeStrictUtf8(bytes) === null) {
				return {
					ok: false,
					error:
						`Goal not created: the attachment ${JSON.stringify(label)} is not valid UTF-8 text. Text ` +
						"attachments must be decodable text files.",
				};
			}
			mediaType = TEXT_ATTACHMENT_MEDIA_TYPE;
		}
		total += bytes.length;
		if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
			return {
				ok: false,
				error:
					`Goal not created: the attachments materialize to ${formatBytes(total)}, above the ` +
					`${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total limit.`,
			};
		}
		prepared.push({ request, mediaType, bytes, hash: sha256(bytes), label, size: bytes.length });
	}

	// Everything validated: write the store directory and its content-addressed
	// artifacts. A write failure after some artifacts landed is cleaned up by the
	// caller through `discardUncommittedArtifacts` (no snapshot referenced them).
	try {
		mkdirSync(goalStoreDir(storeRoot, goalId), { recursive: true });
		const attachments: GoalAttachment[] = [];
		const contents: AttachmentContent[] = [];
		for (const item of prepared) {
			const artifact = join(
				goalStoreDir(storeRoot, goalId),
				`${item.hash}${extensionFor(item.mediaType)}`,
			);
			if (existsStrict(artifact)) {
				const existing = readFileSync(artifact);
				if (sha256(existing) !== item.hash) {
					return {
						ok: false,
						error:
							`Goal not created: the artifact store already holds different bytes for the attachment ` +
							`${JSON.stringify(item.label)} (hash ${item.hash.slice(0, 12)}…). Refusing to overwrite stored artifacts.`,
					};
				}
			} else {
				writeFileSync(artifact, item.bytes, { mode: 0o444 });
			}
			const meta: GoalAttachment = {
				hash: item.hash,
				mediaType: item.mediaType,
				bytes: item.size,
				label: item.label,
			};
			attachments.push(meta);
			contents.push(
				item.request.kind === "image"
					? { meta, kind: "image", data: Buffer.from(item.bytes).toString("base64") }
					: { meta, kind: "text", text: decodeStrictUtf8(item.bytes)! },
			);
		}
		return { ok: true, attachments, contents };
	} catch (error) {
		return {
			ok: false,
			error: `Goal not created: the attachment store could not be written (${describe(error)}).`,
		};
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function existsStrict(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Verify a committed manifest against the store: every artifact must exist and
 * hash to the manifest's content hash.
 *
 * Returns one problem string per failing attachment so the surfaced error can
 * name exactly what is missing or corrupt and how to restore it (copy the
 * original bytes back to the content-addressed path).
 */
export function verifyAttachments(
	storeRoot: string,
	goalId: string,
	manifest: readonly GoalAttachment[],
): VerifyResult {
	if (manifest.length === 0) return { ok: true };
	const problems: string[] = [];
	for (const attachment of manifest) {
		const artifact = artifactPath(storeRoot, goalId, attachment);
		let bytes: Uint8Array;
		try {
			bytes = readFileSync(artifact);
		} catch {
			problems.push(
				`the ${attachment.mediaType === TEXT_ATTACHMENT_MEDIA_TYPE ? "text file" : "image"} ${JSON.stringify(attachment.label)} ` +
					`(sha256 ${attachment.hash.slice(0, 12)}…) is missing from the attachment store`,
			);
			continue;
		}
		const actual = sha256(bytes);
		if (actual !== attachment.hash) {
			problems.push(
				`the attachment ${JSON.stringify(attachment.label)} is corrupt: its content hashes to ${actual.slice(0, 12)}… ` +
					`but the manifest records ${attachment.hash.slice(0, 12)}…`,
			);
		}
	}
	return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Load committed artifacts for message rendering.
 *
 * Text is decoded (it was validated UTF-8 at materialization; a decode failure
 * here means the artifact changed on disk and is reported as an error rather
 * than silently dropped). Images are read as base64 for Pi's image content
 * blocks. Callers that must not admit work on unverifiable artifacts verify
 * first (`verifyAttachments`); this loader reports the same failure class for
 * the read path.
 */
export function loadAttachments(
	storeRoot: string,
	goalId: string,
	manifest: readonly GoalAttachment[],
): LoadResult {
	if (manifest.length === 0) return { ok: true, contents: [] };
	const contents: AttachmentContent[] = [];
	for (const meta of manifest) {
		const artifact = artifactPath(storeRoot, goalId, meta);
		let bytes: Uint8Array;
		try {
			bytes = readFileSync(artifact);
		} catch (error) {
			return {
				ok: false,
				error: `the attachment ${JSON.stringify(meta.label)} could not be read from the store (${describe(error)})`,
			};
		}
		if (meta.mediaType === TEXT_ATTACHMENT_MEDIA_TYPE) {
			const text = decodeStrictUtf8(bytes);
			if (text === null) {
				return {
					ok: false,
					error: `the text attachment ${JSON.stringify(meta.label)} is no longer valid UTF-8`,
				};
			}
			contents.push({ meta, kind: "text", text });
		} else {
			contents.push({ meta, kind: "image", data: Buffer.from(bytes).toString("base64") });
		}
	}
	return { ok: true, contents };
}

/**
 * Retract the store directory of a Goal whose creation failed before any
 * snapshot referenced its manifest.
 *
 * This is the only removal in V1 and it is not garbage collection: it aborts an
 * uncommitted transaction. Artifacts of a Goal whose snapshot committed —
 * including a replacement that was later retracted, and a Goal that was cleared
 * — are retained forever, because another selected session branch may still
 * reference them.
 */
export function discardUncommittedArtifacts(storeRoot: string, goalId: string): void {
	try {
		rmSync(goalStoreDir(storeRoot, goalId), { recursive: true, force: true });
	} catch {
		// Best effort: an orphaned directory is retained, never fatal.
	}
}

/** Whether the store root exists (diagnostics for tests and smoke checks). */
export function storeExists(storeRoot: string): boolean {
	return existsStrict(storeRoot);
}

/** Every Goal identity with a store directory, for tests and smoke checks. */
export function storedGoalIds(storeRoot: string): string[] {
	try {
		return readdirSync(storeRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
