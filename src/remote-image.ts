/**
 * Explicit remote-image fetching for Objective attachments (issue #50).
 *
 * A direct `/goal --remote-image <url>` request is the only path that fetches
 * remote content. `create_goal` stays text-only and plain arguments stay text,
 * so unquoted or model-selected URLs never gain Goal creation authority.
 *
 * The URL is treated as untrusted input:
 *
 * - HTTPS only, no URL credentials, and fresh request headers carrying no
 *   cookies, authorization, or referrer;
 * - one overall deadline (15 seconds by default) covering DNS, redirects, and
 *   the bounded body read;
 * - at most three redirects, each target re-validated exactly like the original
 *   URL (HTTPS, no credentials, public destination);
 * - loopback, link-local, private, and other non-public destinations refused —
 *   for IP literals, for DNS results, and for every redirect target;
 * - a bounded body read: `content-length` is checked before reading and the
 *   stream is destroyed as soon as more than the limit has arrived, so an
 *   endless response cannot be buffered.
 *
 * DNS rebinding is handled by validating every resolved address and then
 * connecting through a lookup function that returns exactly those validated
 * addresses. The socket therefore cannot connect to a different address than
 * the one that passed the policy, even if DNS changes between resolution and
 * connection. The TLS peer name is still validated against the URL hostname by
 * Node's normal certificate checks.
 *
 * The returned bytes are still untrusted content: the attachment layer decides
 * the image media type from the bytes themselves, and only then materializes
 * them into the same immutable Goal-keyed store as a local image. URLs are
 * never persisted in the Goal manifest or emitted in Goal-updated events; the
 * display label is derived from the URL's basename and is metadata only.
 */
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

/** The default per-image fetch limit: the same 10 MiB image limit as local images. */
export const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

/** The production fetch deadline, covering DNS, redirects, and the body read. */
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

/** The maximum number of redirects that are followed and revalidated. */
export const MAX_REMOTE_IMAGE_REDIRECTS = 3;

/** A redirect body is never the image; bound it so a hostile one cannot buffer. */
const REDIRECT_BODY_LIMIT = 64 * 1024;

/** Outcome of validating a remote image URL before any network access. */
export type RemoteImageUrlResult =
	| { ok: true; url: URL; label: string }
	| { ok: false; error: string };

/** Outcome of one fetch, after redirects and the bounded body read. */
export type RemoteImageFetchResult =
	| { ok: true; bytes: Uint8Array; label: string }
	| { ok: false; error: string };

/**
 * Fetch options. Production callers pass only the defaults (or a shortened
 * timeout in the deterministic suite). `testOnly` exists for the local TLS
 * fixture: it trusts that fixture's CA and permits exactly its loopback origin,
 * which the production destination policy otherwise refuses. It is never set
 * from user or model input; see `docs/testing.md`.
 */
export interface RemoteImageFetchOptions {
	/** Overall deadline for DNS, redirects, and the body. */
	timeoutMs?: number;
	/** Maximum redirects to follow (each one revalidated). */
	maxRedirects?: number;
	/** Maximum accepted body bytes; the read never buffers more than this + one chunk. */
	maxBytes?: number;
	/** Deterministic-suite seams; never set in production. */
	testOnly?: {
		/** Exact HTTPS origins that may resolve to a non-public address (the local fixture). */
		allowedOrigins?: readonly string[];
		/** Additional CA certificate for the local TLS fixture. */
		ca?: string | Buffer;
	};
}

/** The non-public IPv4 and IPv6 ranges remote fetching refuses. */
const FORBIDDEN_DESTINATIONS = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // RFC 1918 private
	["100.64.0.0", 10], // shared address space / carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local
	["172.16.0.0", 12], // RFC 1918 private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // TEST-NET-1
	["192.88.99.0", 24], // 6to4 relay anycast
	["192.168.0.0", 16], // RFC 1918 private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // TEST-NET-2
	["203.0.113.0", 24], // TEST-NET-3
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, includes broadcast
] as const) {
	FORBIDDEN_DESTINATIONS.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 96], // unspecified, loopback, IPv4-compatible
	["64:ff9b::", 96], // NAT64: may translate to a private IPv4 destination
	["100::", 64], // discard-only
	["2001::", 23], // IETF protocol assignments, includes Teredo
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4: embeds an IPv4 destination
	["3fff::", 20], // documentation
	["fc00::", 7], // unique local (private)
	["fe80::", 10], // link-local
	["fec0::", 10], // deprecated site-local
	["ff00::", 8], // multicast
] as const) {
	FORBIDDEN_DESTINATIONS.addSubnet(network, prefix, "ipv6");
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Whether an address is outside the public internet space remote fetching
 * permits. Invalid addresses are refused too: the policy is an allow-by-shape
 * check, so an unparsable value must never fall through to a connection.
 */
export function isForbiddenDestinationAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return FORBIDDEN_DESTINATIONS.check(address, "ipv4");
	if (family === 6) return FORBIDDEN_DESTINATIONS.check(address, "ipv6");
	return true;
}

/**
 * Derive the metadata-only display label from a URL's last path segment.
 *
 * The URL itself is never stored. Percent escapes are decoded, control
 * characters are removed (a label appears in messages and snapshots), and the
 * label is capped at the manifest's 255-character structural bound. A URL with
 * no usable basename gets a stable generic label.
 */
export function remoteImageLabel(url: URL): string {
	const raw = url.pathname.split("/").filter((segment) => segment !== "").pop() ?? "";
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// Keep the raw segment when it is not valid percent encoding.
	}
	decoded = decoded.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (decoded === "" || decoded === "." || decoded === "..") return "remote-image";
	return decoded.length > 255 ? decoded.slice(0, 255) : decoded;
}

/**
 * Validate a remote image URL before any DNS lookup or fetch.
 *
 * Only HTTPS is accepted, URL credentials are refused outright (rather than
 * stripped), and the label is derived from the URL without persisting it.
 */
export function validateRemoteImageUrl(raw: string): RemoteImageUrlResult {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: false, error: "Goal not created: --remote-image needs an HTTPS image URL." };
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return {
			ok: false,
			error: "Goal not created: --remote-image needs a valid absolute URL (it could not be parsed).",
		};
	}
	if (url.protocol !== "https:") {
		return {
			ok: false,
			error:
				"Goal not created: remote image URLs must use HTTPS; " +
				`${JSON.stringify(url.protocol)} is refused because the fetch must not travel in clear text.`,
		};
	}
	if (url.username !== "" || url.password !== "") {
		return {
			ok: false,
			error:
				"Goal not created: a remote image URL must not include credentials. " +
				"Remove the user name and password from the URL.",
		};
	}
	if (stripIpv6Brackets(url.hostname) === "") {
		return { ok: false, error: "Goal not created: the remote image URL has no host name." };
	}
	if (url.port === "0") {
		return { ok: false, error: "Goal not created: the remote image URL uses the invalid port 0." };
	}
	return { ok: true, url, label: remoteImageLabel(url) };
}

interface ResolvedDestination {
	addresses: string[];
}

function timeoutError(): Error {
	return new Error("timed out");
}

function isTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === "timed out";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function allowedOriginSet(options: RemoteImageFetchOptions): Set<string> {
	const origins = new Set<string>();
	for (const value of options.testOnly?.allowedOrigins ?? []) {
		try {
			const url = new URL(value);
			if (url.protocol === "https:") origins.add(url.origin);
		} catch {
			// An invalid test-only allowlist entry simply permits nothing.
		}
	}
	return origins;
}

/**
 * Resolve a host with the remaining deadline.
 *
 * `dns.lookup` honors the host's normal resolver (including `/etc/hosts`), and
 * its result is what the policy checks. The operation itself cannot be
 * cancelled, so a race bounds it; a late answer is ignored.
 */
function resolveHostnames(hostname: string, deadline: number): Promise<Array<{ address: string; family: number }>> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(timeoutError());
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(timeoutError());
		}, remaining);
		dnsLookup(hostname, { all: true, verbatim: true }).then(
			(records) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(records);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Resolve and policy-check every address the destination names.
 *
 * All resolved addresses are checked, not just the one a connection might
 * prefer: a hostname with a public and a private answer is refused rather than
 * gambled on. The exact test-only fixture origin may be non-public, and only
 * that exact origin.
 */
async function resolveDestination(
	url: URL,
	deadline: number,
	allowedOrigins: ReadonlySet<string>,
): Promise<ResolvedDestination> {
	const hostname = stripIpv6Brackets(url.hostname);
	let addresses: string[];
	if (isIP(hostname) !== 0) {
		addresses = [hostname];
	} else {
		const records = await resolveHostnames(hostname, deadline);
		addresses = [...new Set(records.map((record) => record.address))];
	}
	if (addresses.length === 0) {
		throw new Error("host name could not be resolved");
	}
	if (!allowedOrigins.has(url.origin)) {
		for (const address of addresses) {
			if (isForbiddenDestinationAddress(address)) {
				throw new Error("resolves to a loopback, link-local, or private-network address");
			}
		}
	}
	return { addresses };
}

/**
 * A lookup function that returns only the addresses already policy-checked.
 *
 * Pinning the validated addresses here is what closes the DNS-rebinding gap
 * between resolution and the connection: the socket cannot ask the resolver a
 * second time and receive a different (forbidden) address.
 */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
	const records = addresses.map((address) => ({ address, family: isIP(address) }));
	return (_hostname, options, callback) => {
		const first = records[0];
		if (!first) {
			const error = new Error("no validated address") as NodeJS.ErrnoException;
			error.code = "ENOTFOUND";
			callback(error, [], 4);
			return;
		}
		if (options.all) {
			callback(null, records);
			return;
		}
		callback(null, first.address, first.family);
	};
}

interface HttpResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: Uint8Array;
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Perform exactly one HTTP request over the pinned, validated address.
 *
 * The deadline covers the entire exchange, including the body. Reading stops at
 * `limit + one chunk`: the excess is never accumulated, and the response is
 * destroyed as soon as the limit is crossed. Redirect bodies get their own small
 * bound because only the `Location` header matters.
 */
function requestOnce(
	url: URL,
	destination: ResolvedDestination,
	maxBytes: number,
	deadline: number,
	ca: string | Buffer | undefined,
): Promise<HttpResponse> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(timeoutError());
	return new Promise<HttpResponse>((resolve, reject) => {
		let settled = false;
		let request: ReturnType<typeof httpsRequest> | undefined;
		let response: import("node:http").IncomingMessage | undefined;
		const timer = setTimeout(() => finish(timeoutError()), remaining);

		const finish = (error?: Error, value?: HttpResponse): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				request?.destroy();
				response?.destroy();
				reject(error);
				return;
			}
			resolve(value!);
		};

		try {
			request = httpsRequest(
				url,
				{
					method: "GET",
					headers: {
						accept: "image/png,image/jpeg,image/gif,image/webp",
						"accept-encoding": "identity",
						"user-agent": "pi-goal-remote-image/1",
					},
					agent: false,
					lookup: pinnedLookup(destination.addresses),
					timeout: Math.max(1, remaining),
					...(ca === undefined ? {} : { ca }),
				},
				(incoming) => {
					response = incoming;
					incoming.on("aborted", () => finish(new Error("the response was aborted")));
					incoming.on("error", (error) => finish(error));
					const status = incoming.statusCode ?? 0;
					const limit = isRedirectStatus(status) ? REDIRECT_BODY_LIMIT : maxBytes;
					const declared = Number(incoming.headers["content-length"]);
					if (Number.isFinite(declared) && declared > limit) {
						finish(
							new Error(
								isRedirectStatus(status)
									? "the redirect response was too large"
									: `the response is ${formatBytes(declared)}, above the ${formatBytes(maxBytes)} fetch limit`,
							),
						);
						return;
					}
					const chunks: Uint8Array[] = [];
					let total = 0;
					incoming.on("data", (chunk: Buffer) => {
						if (settled) return;
						total += chunk.length;
						if (total > limit) {
							finish(
								new Error(
									isRedirectStatus(status)
										? "the redirect response was too large"
										: `the response is larger than the ${formatBytes(maxBytes)} fetch limit`,
								),
							);
							return;
						}
						chunks.push(chunk);
					});
					incoming.on("end", () => {
						if (settled) return;
						finish(undefined, {
							status,
							headers: incoming.headers,
							body: Buffer.concat(chunks, total),
						});
					});
				},
			);
			request.on("error", (error) => finish(error));
			request.end();
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function withoutGoalPrefix(message: string): string {
	return message.startsWith("Goal not created: ") ? message.slice("Goal not created: ".length) : message;
}

function failure(label: string, reason: string): RemoteImageFetchResult {
	return {
		ok: false,
		error:
			`Goal not created: the remote image ${JSON.stringify(label)} could not be fetched: ${reason}.` +
			" Nothing was materialized and the previous Goal, if any, is unchanged.",
	};
}

/**
 * Fetch one explicitly selected remote image.
 *
 * The initial URL and every redirect target are validated before their request
 * is made. The body is bounded by `maxBytes`; only a `200` response is treated
 * as image content. The bytes are returned as-is for the caller's magic-byte
 * media-type check — this module fetches untrusted bytes, it does not decide
 * whether they are a supported image.
 */
export async function fetchRemoteImage(
	rawUrl: string,
	options: RemoteImageFetchOptions = {},
): Promise<RemoteImageFetchResult> {
	const validated = validateRemoteImageUrl(rawUrl);
	if (!validated.ok) return validated;
	const label = validated.label;
	const timeoutMs =
		Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
			? options.timeoutMs!
			: REMOTE_IMAGE_TIMEOUT_MS;
	const maxRedirects =
		Number.isSafeInteger(options.maxRedirects) && (options.maxRedirects ?? -1) >= 0
			? options.maxRedirects!
			: MAX_REMOTE_IMAGE_REDIRECTS;
	const maxBytes =
		Number.isSafeInteger(options.maxBytes) && (options.maxBytes ?? 0) > 0
			? options.maxBytes!
			: DEFAULT_MAX_REMOTE_IMAGE_BYTES;
	const deadline = Date.now() + timeoutMs;
	const allowedOrigins = allowedOriginSet(options);
	let current = validated.url;

	for (let followed = 0; ; followed += 1) {
		let destination: ResolvedDestination;
		try {
			destination = await resolveDestination(current, deadline, allowedOrigins);
		} catch (error) {
			const reason = isTimeout(error)
				? `it timed out after ${timeoutMs / 1000} seconds while resolving the host name`
				: error instanceof Error
					? error.message
					: String(error);
			return failure(label, reason);
		}

		let response: HttpResponse;
		try {
			response = await requestOnce(current, destination, maxBytes, deadline, options.testOnly?.ca);
		} catch (error) {
			const reason = isTimeout(error)
				? `it timed out after ${timeoutMs / 1000} seconds`
				: error instanceof Error
					? error.message
					: String(error);
			return failure(label, reason);
		}

		if (isRedirectStatus(response.status)) {
			if (followed >= maxRedirects) {
				return failure(
					label,
					`it redirected more than ${maxRedirects} time${maxRedirects === 1 ? "" : "s"}, ` +
						"above the revalidated redirect limit",
				);
			}
			const location = response.headers.location;
			const target = Array.isArray(location) ? location[0] : location;
			if (!target) {
				return failure(label, `it returned HTTP ${response.status} without a Location header`);
			}
			let next: URL;
			try {
				next = new URL(target, current);
			} catch {
				return failure(label, "its redirect target is not a valid URL");
			}
			const targetValidation = validateRemoteImageUrl(next.href);
			if (!targetValidation.ok) {
				return failure(label, `its redirect target was refused (${withoutGoalPrefix(targetValidation.error)})`);
			}
			current = targetValidation.url;
			continue;
		}

		if (response.status !== 200) {
			return failure(label, `it returned HTTP ${response.status}; only a 200 response is accepted`);
		}
		return { ok: true, bytes: response.body, label };
	}
}
