/**
 * Local HTTPS fixture for remote-image tests (issue #50).
 *
 * Every test that exercises a remote fetch talks to this process-local server
 * over an ephemeral loopback port. It never contacts the public internet. The
 * fixture certificate is signed by the committed test CA in
 * `test/fixtures/tls/`, which the spawned Pi trusts through
 * `NODE_EXTRA_CA_CERTS`; the exact fixture origin is opted in through the
 * test-only `PI_GOAL_TEST_REMOTE_IMAGE_ORIGINS` seam because production
 * correctly refuses loopback destinations.
 *
 * The routes cover the acceptance matrix: a valid image, every supported
 * media type, byte-driven MIME mismatches, SVG and unknown content, redirect
 * chains and hostile redirect targets, a hanging response, an explicitly held
 * response (for stalled-fetch races), oversized `content-length` and chunked
 * bodies, credentials, and HTTP. `REMOTE_IMAGE_DNS_STUB` is the deterministic
 * resolver the suites install, so no test depends on `/etc/hosts` or a host
 * resolver.
 */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TLS_DIR = fileURLToPath(new URL("../fixtures/tls/", import.meta.url));
export const FIXTURE_CA = `${TLS_DIR}ca.pem`;

/** A real, decodable 1x1 PNG used as the successful remote image. */
export const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const PNG_BYTES = Buffer.from(PNG_B64, "base64");

/** A minimal JPEG (sniffable SOI/APP0) and GIF/WebP headers for MIME tests. */
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fixture-jpeg")]);
export const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0])]);
export const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
export const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");

/**
 * Deterministic DNS answers shared by the store suite and the spawned Pi.
 *
 * `localhost` is the only name the fixture certificate covers, so the positive
 * hostname path pins it here instead of reading `/etc/hosts`. The remaining
 * names use the reserved `.test` TLD (never resolved for real), and every one
 * is listed so the stub is authoritative: an unlisted name is a hard failure,
 * never a fallback to the host's resolver or the public internet. The mixed
 * answers exercise the rebinding policy without making any connection.
 */
export const REMOTE_IMAGE_DNS_STUB = Object.freeze({
	localhost: ["127.0.0.1"],
	"loopback.remote-image.test": ["127.0.0.1"],
	"rebind.remote-image.test": ["93.184.216.34", "127.0.0.1"],
	"translatable.remote-image.test": ["::ffff:0:7f00:1"],
	"translatable-private.remote-image.test": ["::ffff:0:a00:1"],
	"translatable-rebind.remote-image.test": ["93.184.216.34", "::ffff:0:7f00:1"],
	"nat64-local.remote-image.test": ["64:ff9b:1::a00:1"],
	"six-to-four.remote-image.test": ["2002:7f00:1::1"],
	"teredo.remote-image.test": ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
	"public.remote-image.test": ["93.184.216.34"],
	"unresolvable.remote-image.test": [],
});

/** The same stub in the form the spawned Pi reads from its environment. */
export const REMOTE_IMAGE_DNS_STUB_JSON = JSON.stringify(REMOTE_IMAGE_DNS_STUB);

function imageBuffer(size) {
	const buffer = Buffer.alloc(size);
	PNG_BYTES.copy(buffer);
	return buffer;
}

export class RemoteImageFixture {
	constructor(server, origin) {
		this.server = server;
		this.origin = origin;
		/** Every request the fixture received, in arrival order. */
		this.requests = [];
		/** Responses held open for a stalled-fetch scenario, released explicitly. */
		this.held = [];
		/** Pending `waitForRequest` resolvers, one per awaited path. */
		this.requestWaiters = [];
		this.sockets = new Set();
		this.closed = false;
	}

	static async start() {
		const server = createServer({
			key: readFileSync(`${TLS_DIR}server-key.pem`),
			cert: readFileSync(`${TLS_DIR}server-cert.pem`),
		});
		const fixture = new RemoteImageFixture(server, "");
		server.on("connection", (socket) => {
			fixture.sockets.add(socket);
			socket.on("close", () => fixture.sockets.delete(socket));
		});
		server.on("request", (request, response) => fixture.handle(request, response));
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		fixture.origin = `https://127.0.0.1:${server.address().port}`;
		return fixture;
	}

	url(path) {
		return `${this.origin}${path}`;
	}

	count(pathPrefix) {
		return this.requests.filter((request) => request.url.startsWith(pathPrefix)).length;
	}

	countExact(pathname) {
		return this.requests.filter((request) => new URL(request.url, this.origin).pathname === pathname).length;
	}

	/** Wait until the fixture has received a request for exactly this path. */
	waitForRequest(pathname) {
		const seen = () =>
			this.requests.some((request) => new URL(request.url, this.origin).pathname === pathname);
		if (seen()) return Promise.resolve();
		return new Promise((resolve) => {
			const check = () => {
				if (!seen()) return false;
				resolve();
				return true;
			};
			if (check()) return;
			this.requestWaiters.push({ pathname, check });
		});
	}

	/** Send the image to every response a `/hold` route left open. */
	releaseHeld(bytes = PNG_BYTES) {
		for (const response of this.held.splice(0)) {
			if (response.destroyed || response.writableEnded) continue;
			response.writeHead(200, { "content-type": "image/png" });
			response.end(bytes);
		}
	}

	releaseWaiters() {
		this.requestWaiters = this.requestWaiters.filter((waiter) => !waiter.check());
	}

	handle(request, response) {
		this.requests.push({ url: request.url, method: request.method, headers: request.headers });
		this.releaseWaiters();
		const url = new URL(request.url, this.origin);
		const path = url.pathname;
		const send = (status, headers, body) => {
			if (response.destroyed || response.writableEnded) return;
			response.writeHead(status, headers);
			response.end(body);
		};
		const redirect = (location, status = 302) => {
			send(status, { location }, "");
		};

		switch (path) {
			case "/png":
				send(200, { "content-type": "image/png" }, PNG_BYTES);
				return;
			case "/jpeg":
				send(200, { "content-type": "image/jpeg" }, JPEG_BYTES);
				return;
			case "/gif":
				send(200, { "content-type": "image/gif" }, GIF_BYTES);
				return;
			case "/webp":
				send(200, { "content-type": "image/webp" }, WEBP_BYTES);
				return;
			case "/mismatch.jpg":
				// The URL extension lies; the fetched bytes are a PNG.
				send(200, { "content-type": "image/jpeg" }, PNG_BYTES);
				return;
			case "/svg":
				send(200, { "content-type": "image/svg+xml" }, SVG_BYTES);
				return;
			case "/unknown":
				send(200, { "content-type": "image/png" }, Buffer.from("definitely not an image"));
				return;
			case "/empty":
				send(200, { "content-type": "image/png" }, Buffer.alloc(0));
				return;
			case "/redirect":
				redirect(url.searchParams.get("to") ?? "/png");
				return;
			case "/redirect-relative":
				redirect("/png");
				return;
			case "/redirect-loop":
				redirect("/redirect-loop");
				return;
			case "/redirect-missing":
				send(302, {}, "");
				return;
			case "/redirect-credentials":
				redirect(`https://user:unique-redirect-credential@127.0.0.1:${this.server.address().port}/png`);
				return;
			case "/redirect-http":
				redirect(`http://127.0.0.1:${this.server.address().port}/png`);
				return;
			case "/redirect-private":
				redirect("https://10.0.0.1/png");
				return;
			case "/redirect-loopback-name":
				redirect(`https://loopback.remote-image.test:${this.server.address().port}/png`);
				return;
			case "/redirect-translatable":
				redirect("https://[::ffff:0:7f00:1]/png");
				return;
			case "/redirect-nat64-local":
				redirect("https://[64:ff9b:1::a00:1]/png");
				return;
			case "/redirect-rebind":
				redirect(`https://rebind.remote-image.test:${this.server.address().port}/png`);
				return;
			case "/redirect-linklocal":
				redirect("https://169.254.169.254/latest/meta-data/");
				return;
			case "/status/500":
				send(500, { "content-type": "text/plain" }, "nope");
				return;
			case "/slow":
				// Never respond; the fetch deadline must tear the socket down.
				return;
			case "/hold":
				// Hold the response until `releaseHeld()`; a stalled network await.
				this.held.push(response);
				return;
			case "/partial":
				response.writeHead(200, { "content-type": "image/png" });
				response.write(PNG_BYTES.subarray(0, 8));
				return;
			default:
				break;
		}

		const chain = /^\/redirect-chain\/(\d+)$/.exec(path);
		if (chain) {
			const remaining = Number(chain[1]);
			if (remaining <= 0) {
				send(200, { "content-type": "image/png" }, PNG_BYTES);
			} else {
				redirect(`/redirect-chain/${remaining - 1}`);
			}
			return;
		}
		const size = /^\/size\/(\d+)$/.exec(path);
		if (size) {
			const bytes = Math.min(Number(size[1]), 16 * 1024 * 1024);
			send(200, { "content-type": "image/png", "content-length": String(bytes) }, imageBuffer(bytes));
			return;
		}
		const chunked = /^\/chunked\/(\d+)$/.exec(path);
		if (chunked) {
			const bytes = Math.min(Number(chunked[1]), 16 * 1024 * 1024);
			response.writeHead(200, { "content-type": "image/png" });
			const chunk = imageBuffer(Math.min(bytes, 64 * 1024));
			let written = 0;
			const write = () => {
				if (response.destroyed || response.writableEnded) return;
				while (written < bytes) {
					const slice = chunk.subarray(0, Math.min(chunk.length, bytes - written));
					written += slice.length;
					if (!response.write(slice)) {
						response.once("drain", write);
						return;
					}
				}
				response.end();
			};
			write();
			return;
		}
		send(404, { "content-type": "text/plain" }, "not found");
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		this.held.length = 0;
		this.requestWaiters.length = 0;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await new Promise((resolve) => this.server.close(resolve));
	}
}
