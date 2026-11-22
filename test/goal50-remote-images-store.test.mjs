/**
 * Store-level regressions for remote-image fetching (issue #50).
 *
 * These cover the pieces a real-Pi RPC scenario cannot reach cheaply: URL shape
 * validation and label derivation, the destination-address policy (IPv4, IPv6,
 * mapped, IPv4-translatable, NAT64, 6to4, Teredo, private, loopback,
 * link-local, documentation, and public controls), the bounded
 * fetch/redirect/timeout behavior against the local TLS fixture, and the
 * interaction between fetched bytes and the existing per-image and cumulative
 * materialization limits. Every host name resolves through the fixture's
 * deterministic resolver stub, so no test reads `/etc/hosts` or contacts a
 * public destination.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	DEFAULT_MAX_REMOTE_IMAGE_BYTES,
	fetchRemoteImage,
	isForbiddenDestinationAddress,
	remoteImageLabel,
	validateRemoteImageUrl,
} from "../src/remote-image.ts";
import {
	attachmentStoreRoot,
	MAX_TOTAL_ATTACHMENT_BYTES,
	materializeAttachmentRequests,
	storedGoalIds,
	verifyAttachments,
} from "../src/attachments.ts";
import { FIXTURE_CA, PNG_B64, PNG_BYTES, REMOTE_IMAGE_DNS_STUB, RemoteImageFixture } from "./helpers/remote-image-fixture.mjs";

const CA = readFileSync(FIXTURE_CA);
const PNG_SHA256 = createHash("sha256").update(Buffer.from(PNG_B64, "base64")).digest("hex");

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function tempStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-remote-store-"));
	return { dir, sessionFile: join(dir, "session.jsonl"), root: attachmentStoreRoot(join(dir, "session.jsonl")) };
}

/** The fetch options the local TLS fixture needs; never production defaults. */
function fixtureOptions(fixture, extra = {}) {
	return {
		...extra,
		testOnly: { allowedOrigins: [fixture.origin], ca: CA, resolver: REMOTE_IMAGE_DNS_STUB },
	};
}

/** The same deterministic resolver without opting any origin in. */
function policyOptions(extra = {}) {
	return { ...extra, testOnly: { resolver: REMOTE_IMAGE_DNS_STUB } };
}

test("remote URLs are HTTPS-only, credential-free, and labelled from the path without persisting the URL", () => {
	const ok = validateRemoteImageUrl("https://example.com/images/shot%20one.png?token=secret#fragment");
	assert.equal(ok.ok, true);
	assert.equal(ok.url.href, "https://example.com/images/shot%20one.png?token=secret#fragment");
	assert.equal(ok.label, "shot one.png");
	assert.ok(!ok.label.includes("token"), "the query is not part of the label");

	const credential = "unique-credential-9f3a";
	for (const [url, pattern] of [
		["http://example.com/shot.png", /must use HTTPS/],
		["ftp://example.com/shot.png", /must use HTTPS/],
		[`https://user:${credential}@example.com/shot.png`, /must not include credentials/],
		["", /needs an HTTPS image URL/],
		["not a url", /could not be parsed/],
	]) {
		const result = validateRemoteImageUrl(url);
		assert.equal(result.ok, false, url);
		assert.match(result.error, pattern);
		assert.ok(!result.error.includes(credential), "a refused credential is never echoed");
	}

	assert.equal(validateRemoteImageUrl("https://example.com/").label, "remote-image");
	assert.equal(validateRemoteImageUrl("https://example.com/..").label, "remote-image");
	assert.equal(validateRemoteImageUrl("https://example.com/").ok, true);
	assert.equal(remoteImageLabel(new URL("https://example.com/folder/")), "folder");
	assert.equal(remoteImageLabel(new URL("https://example.com/")), "remote-image");
	assert.equal(remoteImageLabel(new URL(`https://example.com/${"a".repeat(300)}`)).length, 255);
	const url = new URL("https://[2001:4860:4860::8888]/image.png");
	assert.equal(validateRemoteImageUrl(url.href).ok, true);
});

test("the destination policy refuses loopback, link-local, private, mapped, and reserved addresses but permits public ones", () => {
	for (const address of [
		"127.0.0.1",
		"127.10.20.30",
		"0.0.0.0",
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"192.0.2.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"::ffff:0:7f00:1",
		"::ffff:0:a00:1",
		"::ffff:0:c0a8:101",
		"::ffff:0:0",
		"::0.0.0.1",
		"64:ff9b::7f00:1",
		"64:ff9b:1::7f00:1",
		"64:ff9b:1::a00:1",
		"64:ff9b:1::c0a8:101",
		"5f00::1",
		"2001:2::1",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"fec0::1",
		"ff02::1",
		"not-an-address",
	]) {
		assert.equal(isForbiddenDestinationAddress(address), true, address);
	}
	for (const address of [
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",
		// A public IPv4 stays reachable through its IPv4-mapped form; only the
		// embedded private destination is refused above.
		"::ffff:8.8.8.8",
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
	]) {
		assert.equal(isForbiddenDestinationAddress(address), false, address);
	}
});

test("IPv4 translation forms cannot smuggle a private destination past literals, DNS answers, or redirects", async () => {
	// Literal IPv6 translation forms embed an IPv4 destination and are refused
	// before any socket is opened: no fixture, resolver, or public host is used.
	for (const url of [
		"https://[::ffff:0:7f00:1]/image.png",
		"https://[::ffff:0:a00:1]/image.png",
		"https://[::ffff:0:c0a8:101]/image.png",
		"https://[64:ff9b::7f00:1]/image.png",
		"https://[64:ff9b:1::7f00:1]/image.png",
		"https://[64:ff9b:1::a00:1]/image.png",
		"https://[2002:7f00:1::1]/image.png",
		"https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/image.png",
	]) {
		const refused = await fetchRemoteImage(url);
		assert.equal(refused.ok, false, url);
		assert.match(refused.error, /loopback, link-local, or private-network/, url);
	}

	const fixture = await RemoteImageFixture.start();
	const port = new URL(fixture.origin).port;
	try {
		// Every DNS answer is checked, so a name that embeds a private IPv4 inside
		// an IPv4-translatable, local-use NAT64, 6to4, or Teredo form is refused
		// before a connection. The resolver stub is authoritative: these names are
		// never handed to the host's resolver.
		const requestsBefore = fixture.requests.length;
		for (const hostname of [
			"translatable.remote-image.test",
			"translatable-private.remote-image.test",
			"nat64-local.remote-image.test",
			"six-to-four.remote-image.test",
			"teredo.remote-image.test",
			"rebind.remote-image.test",
			"translatable-rebind.remote-image.test",
		]) {
			const refused = await fetchRemoteImage(`https://${hostname}:${port}/png`, policyOptions());
			assert.equal(refused.ok, false, hostname);
			assert.match(refused.error, /loopback, link-local, or private-network/, hostname);
		}
		assert.equal(fixture.requests.length, requestsBefore, "no refused destination was contacted");

		// A name the stub does not list does not resolve at all: a test can never
		// fall through to `/etc/hosts`, a local resolver, or the public internet.
		const unresolved = await fetchRemoteImage(
			`https://unmapped.remote-image.test:${port}/png`,
			policyOptions(),
		);
		assert.equal(unresolved.ok, false);
		assert.match(unresolved.error, /host name could not be resolved/);
		const empty = await fetchRemoteImage(
			`https://unresolvable.remote-image.test:${port}/png`,
			policyOptions(),
		);
		assert.equal(empty.ok, false);
		assert.match(empty.error, /host name could not be resolved/);
		assert.equal(fixture.requests.length, requestsBefore, "no unresolved name was contacted");

		// Redirect targets go through the same literal and DNS policy; the target
		// image is never requested.
		const redirectTargets = [
			"/redirect-translatable",
			"/redirect-nat64-local",
			"/redirect-rebind",
			`/redirect?to=${encodeURIComponent(`https://translatable.remote-image.test:${port}/png`)}`,
		];
		for (const path of redirectTargets) {
			const refused = await fetchRemoteImage(fixture.url(path), fixtureOptions(fixture));
			assert.equal(refused.ok, false, path);
			assert.match(refused.error, /loopback, link-local, or private-network/, path);
		}
		assert.equal(fixture.countExact("/png"), 0, "no redirect reached the private-IPv4 target");
	} finally {
		await fixture.close();
	}
});

test("a fetch is bounded, follows only revalidated HTTPS redirects, sends no credentials, and never returns forbidden content", async () => {
	const fixture = await RemoteImageFixture.start();
	try {
		const ok = await fetchRemoteImage(fixture.url("/png"), fixtureOptions(fixture));
		assert.equal(ok.ok, true, JSON.stringify(ok));
		assert.deepEqual(Buffer.from(ok.bytes), PNG_BYTES);
		assert.equal(ok.label, "png");
		const request = fixture.requests.at(-1);
		assert.equal(request.headers.authorization, undefined);
		assert.equal(request.headers.cookie, undefined);
		assert.equal(request.headers.referer, undefined);

		const relative = await fetchRemoteImage(fixture.url("/redirect-relative"), fixtureOptions(fixture));
		assert.equal(relative.ok, true);
		assert.deepEqual(Buffer.from(relative.bytes), PNG_BYTES);

		// The DNS-resolved path is exercised through `localhost`: the deterministic
		// resolver stub pins it to loopback, the exact fixture origin is opted in,
		// the resolved loopback address is pinned into the connection, and TLS
		// still verifies the `localhost` name.
		const hostnameOrigin = `https://localhost:${new URL(fixture.origin).port}`;
		const viaHostname = await fetchRemoteImage(
			`${hostnameOrigin}/png`,
			{ testOnly: { allowedOrigins: [hostnameOrigin], ca: CA, resolver: REMOTE_IMAGE_DNS_STUB } },
		);
		assert.equal(viaHostname.ok, true, JSON.stringify(viaHostname));
		assert.deepEqual(Buffer.from(viaHostname.bytes), PNG_BYTES);

		const chain = await fetchRemoteImage(fixture.url("/redirect-chain/3"), fixtureOptions(fixture));
		assert.equal(chain.ok, true);
		const tooMany = await fetchRemoteImage(fixture.url("/redirect-loop"), fixtureOptions(fixture));
		assert.equal(tooMany.ok, false);
		assert.match(tooMany.error, /redirected more than 3 times/);

		for (const [path, pattern] of [
			["/redirect-http", /must use HTTPS/],
			["/redirect-credentials", /must not include credentials/],
			["/redirect-private", /loopback, link-local, or private-network/],
			["/redirect-linklocal", /loopback, link-local, or private-network/],
			["/redirect-loopback-name", /loopback, link-local, or private-network/],
			["/status/500", /returned HTTP 500/],
		]) {
			const refused = await fetchRemoteImage(fixture.url(path), fixtureOptions(fixture));
			assert.equal(refused.ok, false, path);
			assert.match(refused.error, pattern, path);
		}
		const credentialError = await fetchRemoteImage(fixture.url("/redirect-credentials"), fixtureOptions(fixture));
		assert.ok(!credentialError.error.includes("unique-redirect-credential"), "a redirect credential is never echoed");

		// The stub's answer for `localhost` is loopback even though the URL is not
		// the opted-in origin; no host resolver is consulted.
		const localhost = await fetchRemoteImage(
			`https://localhost:${new URL(fixture.origin).port}/png`,
			fixtureOptions(fixture),
		);
		assert.equal(localhost.ok, false);
		assert.match(localhost.error, /loopback, link-local, or private-network/);

		// A caller-provided smaller bound stops both a declared and a streamed body.
		const small = await fetchRemoteImage(fixture.url("/size/1000"), fixtureOptions(fixture, { maxBytes: 100 }));
		assert.equal(small.ok, false);
		assert.match(small.error, /above the .* fetch limit|larger than the .* fetch limit/);
		const chunked = await fetchRemoteImage(
			fixture.url("/chunked/1000"),
			fixtureOptions(fixture, { maxBytes: 100 }),
		);
		assert.equal(chunked.ok, false);
		assert.match(chunked.error, /larger than the .* fetch limit/);

		const stalled = await fetchRemoteImage(fixture.url("/slow"), fixtureOptions(fixture, { timeoutMs: 150 }));
		assert.equal(stalled.ok, false);
		assert.match(stalled.error, /timed out/);

		// The production default is the 10 MiB image limit.
		assert.equal(DEFAULT_MAX_REMOTE_IMAGE_BYTES, 10 * 1024 * 1024);
	} finally {
		await fixture.close();
	}
});

test("materializeAttachmentRequests turns a fetched remote image into the same immutable artifact and enforces the remaining total", async () => {
	const fixture = await RemoteImageFixture.start();
	const { dir, root } = tempStore();
	try {
		const spec = join(dir, "spec.md");
		writeFileSync(spec, "Supporting text beside a remote image.", "utf8");
		const success = await materializeAttachmentRequests(
			root,
			"goal_remote_ok",
			[
				{ kind: "text", path: spec },
				{ kind: "remote-image", url: fixture.url("/png") },
			],
			{ remote: fixtureOptions(fixture) },
		);
		assert.equal(success.ok, true, JSON.stringify(success));
		assert.deepEqual(
			success.attachments.map((attachment) => [attachment.label, attachment.mediaType]),
			[
				["spec.md", "text/plain"],
				["png", "image/png"],
			],
		);
		assert.equal(success.attachments[1].hash, PNG_SHA256);
		assert.equal(success.attachments[1].bytes, PNG_BYTES.length);
		assert.deepEqual(success.contents[1], {
			meta: success.attachments[1],
			kind: "image",
			data: PNG_B64,
		});
		assert.deepEqual(storedGoalIds(root), ["goal_remote_ok"]);
		assert.deepEqual(
			readFileSync(join(root, "goal_remote_ok", `${PNG_SHA256}.png`)),
			Buffer.from(PNG_B64, "base64"),
		);
		assert.deepEqual(verifyAttachments(root, "goal_remote_ok", success.attachments), { ok: true });

		// Two local 10 MiB images leave 5 MiB of the cumulative budget. The remote
		// fetch is bounded by that remainder, so a 6 MiB body is refused before any
		// artifact is written.
		const localA = join(dir, "a.png");
		const localB = join(dir, "b.png");
		const tenMiB = Buffer.alloc(10 * 1024 * 1024);
		PNG_BYTES.copy(tenMiB);
		writeFileSync(localA, tenMiB);
		writeFileSync(localB, tenMiB);
		assert.ok(10 * 1024 * 1024 * 2 <= MAX_TOTAL_ATTACHMENT_BYTES);
		const overTotal = await materializeAttachmentRequests(
			root,
			"goal_remote_total",
			[
				{ kind: "image", path: localA },
				{ kind: "image", path: localB },
				{ kind: "remote-image", url: fixture.url("/size/6291456") },
			],
			{ remote: fixtureOptions(fixture) },
		);
		assert.equal(overTotal.ok, false);
		assert.match(overTotal.error, /above the .* fetch limit|larger than the .* fetch limit/);
		assert.deepEqual(storedGoalIds(root), ["goal_remote_ok"], "the failed total wrote no new Goal directory");
		assert.ok(!existsSync(join(root, "goal_remote_total")));

		// Remote SVG/unknown bytes are refused by the bytes, not by the URL.
		for (const path of ["/svg", "/unknown"]) {
			const refused = await materializeAttachmentRequests(
				root,
				`goal_remote_${path.slice(1)}`,
				[{ kind: "remote-image", url: fixture.url(path) }],
				{ remote: fixtureOptions(fixture) },
			);
			assert.equal(refused.ok, false);
			assert.match(refused.error, /not a recognized image/);
		}
		assert.deepEqual(storedGoalIds(root), ["goal_remote_ok"]);
	} finally {
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
