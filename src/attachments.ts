/**
 * Objective attachments: validation, materialization, and verification of the
 * immutable extension-owned artifact store (issues #49 and #50).
 *
 * A direct user command (`/goal --file <path> --image <path>
 * --remote-image <https-url> ... <objective>`) may attach explicit local text
 * files, local images, and remote images fetched once, to a Goal. The Objective
 * itself stays verbatim with its existing length policy; long or binary
 * supporting material becomes a separate attachment instead of being folded
 * into the Objective. `create_goal` stays text-only, so unquoted files and
 * images never gain Goal creation authority. A remote URL is fetched once into
 * the same store and its URL is never persisted; see `./remote-image.ts` for the
 * HTTPS-only, public-destination, redirect, deadline, and bounded-read policy.
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
 * Source paths and remote source URLs are not required for later Continuations:
 * every kickoff and Continuation re-references the same manifest and re-reads
 * the store.
 *
 * On restore (and before admitting work that would re-send the attachments),
 * the manifest and the artifact hashes are verified. Missing or corrupt
 * artifacts suppress automatic Continuation and surface an explicit error;
 * attachments are never silently dropped, the Goal is never completed, and its
 * Lifecycle status never changes because of an artifact problem.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AttachmentContent, GoalAttachment } from "./goal.ts";
import {
	fetchRemoteImage,
	validateRemoteImageUrl,
	type RemoteImageFetchOptions,
} from "./remote-image.ts";

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
 * `kind` is what the user asked for — a text file (`--file`), a local image
 * (`--image`), or an explicit remote image URL (`--remote-image`) — and decides
 * which limit and which validation apply. Local paths resolve relative to the
 * session's working directory, exactly as the user typed them. A remote URL is
 * fetched once at creation time and never persisted.
 */
export interface LocalAttachmentRequest {
	kind: "text" | "image";
	path: string;
}

/** One explicit remote-image URL request (`--remote-image <url>`). */
export interface RemoteImageAttachmentRequest {
	kind: "remote-image";
	url: string;
}

export type AttachmentRequest = LocalAttachmentRequest | RemoteImageAttachmentRequest;

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

/** Why a bounded attachment read refused the path or the bytes it opened. */
export type AttachmentReadFailure =
	| { kind: "missing" }
	| { kind: "symlink" }
	| { kind: "not-regular" }
	| { kind: "too-large"; size: number }
	| { kind: "changed" }
	| { kind: "unreadable"; error: unknown };

/** Outcome of one bounded, regular-file-only attachment read. */
export type AttachmentBytesResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; failure: AttachmentReadFailure };

/**
 * Deterministic seams for the read-race regression tests. Production callers
 * never pass hooks; they exist so a test can grow, replace, or swap the path
 * after the initial inspection without relying on scheduling luck.
 */
export interface AttachmentReadHooks {
	beforeOpen?(): void;
	afterOpen?(): void;
}

/** Options for materializing attachment sources. */
export interface MaterializeOptions {
	/** Session working directory for relative source paths. */
	cwd?: string;
	/** Test-only observation hooks threaded to the bounded reader. */
	readHooks?: AttachmentReadHooks;
	/** Remote fetch policy; production uses the defaults. */
	remote?: RemoteImageFetchOptions;
}

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

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Read one attachment source through a bounded, regular-file-only descriptor.
 *
 * Symlinks are rejected explicitly (both by `lstat` and by `O_NOFOLLOW` on the
 * open, which also closes the inspect/open race). `O_NONBLOCK` means a FIFO or
 * other special file can never block the command before `fstat` rejects it, and
 * a file is rejected from its opened descriptor size before any content-sized
 * allocation. The read itself tops out at `maxBytes + 1`, so even a file that
 * grows or is replaced mid-read cannot be buffered without bound. A final
 * `fstat` (inode, size, mtime) and a path identity check refuse inconsistent
 * bytes rather than returning a half-observed file.
 *
 * The optional hooks are deterministic test seams; production never passes them.
 */
export function readAttachmentBytes(
	path: string,
	maxBytes: number,
	hooks?: AttachmentReadHooks,
): AttachmentBytesResult {
	let fd: number | undefined;
	try {
		let link;
		try {
			link = lstatSync(path, { bigint: true });
		} catch (error) {
			const code = errorCode(error);
			return {
				ok: false,
				failure: code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable", error },
			};
		}
		if (link.isSymbolicLink()) return { ok: false, failure: { kind: "symlink" } };
		if (!link.isFile()) return { ok: false, failure: { kind: "not-regular" } };
		hooks?.beforeOpen?.();

		const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
		try {
			fd = openSync(path, flags);
		} catch (error) {
			const code = errorCode(error);
			if (code === "ELOOP") return { ok: false, failure: { kind: "symlink" } };
			if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, failure: { kind: "missing" } };
			return { ok: false, failure: { kind: "unreadable", error } };
		}

		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile()) return { ok: false, failure: { kind: "not-regular" } };
		if (before.size > BigInt(maxBytes)) {
			return { ok: false, failure: { kind: "too-large", size: Number(before.size) } };
		}
		hooks?.afterOpen?.();

		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, length);
			if (read === 0) break;
			length += read;
		}

		const after = fstatSync(fd, { bigint: true });
		if (
			after.ino !== before.ino ||
			after.dev !== before.dev ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs
		) {
			return { ok: false, failure: { kind: "changed" } };
		}
		let pathAfter;
		try {
			pathAfter = lstatSync(path, { bigint: true });
		} catch {
			return { ok: false, failure: { kind: "changed" } };
		}
		if (pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
			return { ok: false, failure: { kind: "changed" } };
		}
		if (length > maxBytes) return { ok: false, failure: { kind: "too-large", size: length } };
		return { ok: true, bytes: buffer.subarray(0, length) };
	} catch (error) {
		return { ok: false, failure: { kind: "unreadable", error } };
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The descriptor is already unusable; no cleanup can improve that.
			}
		}
	}
}

/**
 * Validate one raw local flag value before anything is read.
 *
 * A URL passed to `--image` is refused up front rather than being read as a
 * local path; remote images have their own explicit `--remote-image` option so
 * a remote fetch is never inferred from a local-looking flag. Empty values are
 * refused for both kinds.
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
				`Goal not created: ${flag} accepts a local file path, not a URL. ` +
				"Use --remote-image <https URL> to fetch a remote image explicitly.",
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

function sourceReadError(
	request: LocalAttachmentRequest,
	label: string,
	path: string,
	maxBytes: number,
	failure: AttachmentReadFailure,
): string {
	const kind = request.kind === "image" ? "image" : "text file";
	const maxDescription = request.kind === "image" ? "local image" : "text file";
	switch (failure.kind) {
		case "missing":
			return `Goal not created: the ${kind} ${JSON.stringify(path)} does not exist or cannot be accessed.`;
		case "symlink":
			return (
				`Goal not created: the attachment ${JSON.stringify(label)} is a symbolic link. Symbolic links are not ` +
				"accepted as attachment sources; name the file itself."
			);
		case "not-regular":
			return `Goal not created: ${JSON.stringify(path)} is not a regular file.`;
		case "too-large":
			return (
				`Goal not created: the attachment ${JSON.stringify(label)} is ${formatBytes(failure.size)}, above the ` +
				`${formatBytes(maxBytes)} limit for a ${maxDescription}.`
			);
		case "changed":
			return (
				`Goal not created: the attachment ${JSON.stringify(label)} changed while it was being read; ` +
				"nothing was materialized. Try again with a stable file."
			);
		case "unreadable":
			return `Goal not created: the attachment ${JSON.stringify(label)} could not be read (${describe(failure.error)}).`;
	}
}

interface PreparedAttachment {
	kind: "text" | "image";
	mediaType: string;
	bytes: Uint8Array;
	hash: string;
	label: string;
	size: number;
}

/**
 * Preflight every request without touching the network or the filesystem.
 *
 * Count, per-kind duplicate labels, local SVG names, and remote URL syntax are
 * all refused here, before a replacement confirmation can lead anywhere and
 * before any byte is read or fetched. Media-type validation still happens on
 * the actual bytes later; this is the cheap structural pass.
 */
function preflightRequests(requests: readonly AttachmentRequest[]): { ok: true } | { ok: false; error: string } {
	if (requests.length === 0) return { ok: true };
	if (requests.length > MAX_ATTACHMENTS) {
		return {
			ok: false,
			error:
				`Goal not created: at most ${MAX_ATTACHMENTS} attachments are allowed per Goal ` +
				`(${requests.length} were requested).`,
		};
	}
	const labelSeen = new Set<string>();
	for (const request of requests) {
		let label: string;
		let category: string;
		let flag: string;
		if (request.kind === "remote-image") {
			const validated = validateRemoteImageUrl(request.url);
			if (!validated.ok) return { ok: false, error: validated.error };
			label = validated.label;
			category = "image";
			flag = "--remote-image";
		} else {
			label = basename(request.path) || request.path;
			category = request.kind;
			flag = request.kind === "image" ? "--image" : "--file";
			if (request.kind === "image" && isSvgPath(request.path)) {
				return {
					ok: false,
					error:
						`Goal not created: the attachment ${JSON.stringify(label)} is an SVG. SVG is not a supported image ` +
						"attachment (its markup is executable in some hosts); use PNG, JPEG, GIF, or WebP.",
				};
			}
		}
		if (labelSeen.has(`${category}:${label}`)) {
			return {
				ok: false,
				error: `Goal not created: ${flag} names ${JSON.stringify(label)} more than once.`,
			};
		}
		labelSeen.add(`${category}:${label}`);
	}
	return { ok: true };
}

/**
 * Validate one source's already-read bytes and build its prepared manifest
 * entry. The media type is decided by the bytes, never by the URL or path
 * extension.
 */
function prepareBytes(
	kind: "text" | "image",
	bytes: Uint8Array,
	label: string,
): { ok: true; prepared: PreparedAttachment } | { ok: false; error: string } {
	if (bytes.length === 0) {
		return { ok: false, error: `Goal not created: the attachment ${JSON.stringify(label)} is empty.` };
	}
	let mediaType: string;
	if (kind === "image") {
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
	return {
		ok: true,
		prepared: { kind, mediaType, bytes, hash: sha256(bytes), label, size: bytes.length },
	};
}

/** Validate and read one local request into a prepared entry. */
function prepareLocalRequest(
	request: LocalAttachmentRequest,
	cwd: string,
	readHooks: AttachmentReadHooks | undefined,
): { ok: true; prepared: PreparedAttachment } | { ok: false; error: string } {
	const label = basename(request.path) || request.path;
	const sourcePath = isAbsolute(request.path) ? request.path : resolve(cwd, request.path);
	const maxBytes = request.kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
	const read = readAttachmentBytes(sourcePath, maxBytes, readHooks);
	if (!read.ok) {
		return { ok: false, error: sourceReadError(request, label, request.path, maxBytes, read.failure) };
	}
	return prepareBytes(request.kind, read.bytes, label);
}

function totalLimitError(total: number): string {
	return (
		`Goal not created: the attachments materialize to ${formatBytes(total)}, above the ` +
		`${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total limit.`
	);
}

/**
 * Write every prepared source into the Goal-keyed content-addressed store and
 * build the manifest and renderable contents.
 *
 * Called only after every source validated, so a validation or fetch failure
 * never writes a partial Goal. A write failure after some artifacts landed is
 * cleaned up by the caller through `discardUncommittedArtifacts` (no snapshot
 * referenced them).
 */
function materializePrepared(
	storeRoot: string,
	goalId: string,
	prepared: readonly PreparedAttachment[],
): MaterializeResult {
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
				const existing = readAttachmentBytes(artifact, item.size);
				if (!existing.ok || sha256(existing.bytes) !== item.hash) {
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
				item.kind === "image"
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

/**
 * Validate and materialize explicit local requests into the Goal's store.
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
	requests: readonly LocalAttachmentRequest[],
	options: MaterializeOptions = {},
): MaterializeResult {
	if (requests.length === 0) return { ok: true, attachments: [], contents: [] };
	const preflight = preflightRequests(requests);
	if (!preflight.ok) return { ok: false, error: preflight.error };
	const cwd = options.cwd ?? process.cwd();
	const prepared: PreparedAttachment[] = [];
	let total = 0;
	for (const request of requests) {
		const result = prepareLocalRequest(request, cwd, options.readHooks);
		if (!result.ok) return { ok: false, error: result.error };
		total += result.prepared.size;
		if (total > MAX_TOTAL_ATTACHMENT_BYTES) return { ok: false, error: totalLimitError(total) };
		prepared.push(result.prepared);
	}
	return materializePrepared(storeRoot, goalId, prepared);
}

/**
 * Validate, fetch, and materialize every request — local text, local image, and
 * explicit remote image URLs — into one immutable manifest and store directory.
 *
 * Remote images are fetched here, once, before any Goal snapshot commits. Each
 * fetch is bounded both by the per-image limit and by the remaining total, so a
 * remote body can never push the Goal past the cumulative limit. A fetch or
 * validation failure refuses the whole request and writes nothing.
 */
export async function materializeAttachmentRequests(
	storeRoot: string,
	goalId: string,
	requests: readonly AttachmentRequest[],
	options: MaterializeOptions = {},
): Promise<MaterializeResult> {
	if (requests.length === 0) return { ok: true, attachments: [], contents: [] };
	const preflight = preflightRequests(requests);
	if (!preflight.ok) return { ok: false, error: preflight.error };
	const cwd = options.cwd ?? process.cwd();
	const prepared: PreparedAttachment[] = [];
	let total = 0;
	for (const request of requests) {
		if (request.kind === "remote-image") {
			const remaining = MAX_TOTAL_ATTACHMENT_BYTES - total;
			if (remaining <= 0) return { ok: false, error: totalLimitError(total) };
			const fetched = await fetchRemoteImage(request.url, {
				...options.remote,
				maxBytes: Math.min(MAX_IMAGE_ATTACHMENT_BYTES, remaining),
			});
			if (!fetched.ok) return { ok: false, error: fetched.error };
			const result = prepareBytes("image", fetched.bytes, fetched.label);
			if (!result.ok) return { ok: false, error: result.error };
			total += result.prepared.size;
			if (total > MAX_TOTAL_ATTACHMENT_BYTES) return { ok: false, error: totalLimitError(total) };
			prepared.push(result.prepared);
			continue;
		}
		const result = prepareLocalRequest(request, cwd, options.readHooks);
		if (!result.ok) return { ok: false, error: result.error };
		total += result.prepared.size;
		if (total > MAX_TOTAL_ATTACHMENT_BYTES) return { ok: false, error: totalLimitError(total) };
		prepared.push(result.prepared);
	}
	return materializePrepared(storeRoot, goalId, prepared);
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

const ATTACHMENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function attachmentByteLimit(mediaType: string): number | null {
	if (mediaType === TEXT_ATTACHMENT_MEDIA_TYPE) return MAX_TEXT_ATTACHMENT_BYTES;
	if ((IMAGE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType)) return MAX_IMAGE_ATTACHMENT_BYTES;
	return null;
}

function attachmentKind(mediaType: string): string {
	return mediaType === TEXT_ATTACHMENT_MEDIA_TYPE ? "text file" : "image";
}

/** Structural checks applied before any artifact byte is read. */
function manifestReadProblem(manifest: readonly GoalAttachment[]): string | null {
	if (manifest.length > MAX_ATTACHMENTS) {
		return (
			`the attachment manifest names ${manifest.length} entries, above the ${MAX_ATTACHMENTS}-attachment ` +
			"limit"
		);
	}
	for (const attachment of manifest) {
		if (!ATTACHMENT_HASH_PATTERN.test(attachment.hash)) {
			return `the attachment ${JSON.stringify(attachment.label)} has an invalid content hash`;
		}
		const limit = attachmentByteLimit(attachment.mediaType);
		if (limit === null) {
			return `the attachment ${JSON.stringify(attachment.label)} has the unsupported media type ${JSON.stringify(attachment.mediaType)}`;
		}
		if (!Number.isInteger(attachment.bytes) || attachment.bytes <= 0) {
			return `the attachment ${JSON.stringify(attachment.label)} has an invalid recorded byte size`;
		}
		if (attachment.bytes > limit) {
			return (
				`the attachment ${JSON.stringify(attachment.label)} records ${formatBytes(attachment.bytes)}, above the ` +
				`${formatBytes(limit)} limit for a ${attachmentKind(attachment.mediaType)}`
			);
		}
	}
	return null;
}

function artifactReadProblem(
	attachment: GoalAttachment,
	failure: AttachmentReadFailure,
	perFileLimit: number,
): string {
	const label = JSON.stringify(attachment.label);
	switch (failure.kind) {
		case "missing":
			return (
				`the ${attachmentKind(attachment.mediaType)} ${label} (sha256 ${attachment.hash.slice(0, 12)}…) ` +
				"is missing from the attachment store"
			);
		case "symlink":
			return `the attachment ${label} is a symbolic link, not a regular immutable artifact`;
		case "not-regular":
			return `the attachment ${label} is not a regular file`;
		case "too-large":
			if (failure.size > perFileLimit) {
				return (
					`the attachment ${label} is ${formatBytes(failure.size)}, above the ` +
					`${formatBytes(perFileLimit)} limit for a ${attachmentKind(attachment.mediaType)}`
				);
			}
			return (
				`the attachments are above the ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total limit at ${label}`
			);
		case "changed":
			return `the attachment ${label} changed while it was being read; refusing the inconsistent bytes`;
		case "unreadable":
			return `the attachment ${label} could not be read from the store (${describe(failure.error)})`;
	}
}

/**
 * Read, bound, size-check, and hash-check one artifact exactly once.
 *
 * The returned bytes are the authenticated bytes: callers must render these,
 * never re-open the path. `remainingTotal` is the actual-byte budget left for
 * this Goal, so the read itself cannot climb past the cumulative limit even
 * when a hand-edited manifest understates a file's size.
 */
function authenticateAttachment(
	storeRoot: string,
	goalId: string,
	attachment: GoalAttachment,
	remainingTotal: number,
): { ok: true; bytes: Uint8Array } | { ok: false; problems: string[]; bytes?: Uint8Array } {
	const perFileLimit = attachmentByteLimit(attachment.mediaType)!;
	const allowed = Math.min(perFileLimit, remainingTotal);
	const read = readAttachmentBytes(artifactPath(storeRoot, goalId, attachment), allowed);
	if (!read.ok) {
		return { ok: false, problems: [artifactReadProblem(attachment, read.failure, perFileLimit)] };
	}
	const bytes = read.bytes;
	const details: string[] = [];
	if (bytes.length !== attachment.bytes) {
		details.push(
			`its content is ${formatBytes(bytes.length)} but the manifest records ${formatBytes(attachment.bytes)}`,
		);
	}
	const actual = sha256(bytes);
	if (actual !== attachment.hash) {
		details.push(
			`its content hashes to ${actual.slice(0, 12)}… but the manifest records ${attachment.hash.slice(0, 12)}…`,
		);
	}
	if (details.length === 0) return { ok: true, bytes };
	return {
		ok: false,
		problems: [`the attachment ${JSON.stringify(attachment.label)} is corrupt: ${details.join("; ")}`],
		bytes,
	};
}

/**
 * Verify a committed manifest against the store: every artifact must exist,
 * be a bounded regular file, fit its manifest size and the enforced per-file
 * and total limits, and hash to the manifest's content hash.
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
	const structural = manifestReadProblem(manifest);
	if (structural !== null) return { ok: false, problems: [structural] };
	const problems: string[] = [];
	let remainingTotal = MAX_TOTAL_ATTACHMENT_BYTES;
	for (const attachment of manifest) {
		const result = authenticateAttachment(storeRoot, goalId, attachment, remainingTotal);
		if (result.ok) {
			remainingTotal -= result.bytes.length;
			continue;
		}
		problems.push(...result.problems);
		if (result.bytes) remainingTotal -= result.bytes.length;
	}
	return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Load committed artifacts for message rendering through the one authenticated
 * read path.
 *
 * Each artifact is opened and read once, under the same symlink/special-file,
 * bounded-read, and stable-descriptor rules as materialization. The manifest's
 * recorded size, the per-file limit, the cumulative limit, and the recorded
 * hash are all enforced on those exact bytes. Text is then decoded, and images
 * are rendered as base64 for Pi image content blocks. A caller that gets
 * `ok: true` must use `contents`; it must never re-read the artifact path,
 * because a later read could observe different bytes than the ones verified
 * here.
 */
export function loadAttachments(
	storeRoot: string,
	goalId: string,
	manifest: readonly GoalAttachment[],
): LoadResult {
	if (manifest.length === 0) return { ok: true, contents: [] };
	const structural = manifestReadProblem(manifest);
	if (structural !== null) return { ok: false, error: structural };
	const contents: AttachmentContent[] = [];
	let remainingTotal = MAX_TOTAL_ATTACHMENT_BYTES;
	for (const meta of manifest) {
		const result = authenticateAttachment(storeRoot, goalId, meta, remainingTotal);
		if (!result.ok) return { ok: false, error: result.problems.join("; ") };
		remainingTotal -= result.bytes.length;
		if (meta.mediaType === TEXT_ATTACHMENT_MEDIA_TYPE) {
			const text = decodeStrictUtf8(result.bytes);
			if (text === null) {
				return {
					ok: false,
					error: `the text attachment ${JSON.stringify(meta.label)} is no longer valid UTF-8`,
				};
			}
			contents.push({ meta, kind: "text", text });
		} else {
			contents.push({ meta, kind: "image", data: Buffer.from(result.bytes).toString("base64") });
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
