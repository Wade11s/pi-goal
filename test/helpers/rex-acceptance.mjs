/**
 * Issue #43: isolated real-Pi acceptance environment for the *released*
 * pi-rex-subagent provider.
 *
 * The suite loads the vendored v0.2.0 release tree (see
 * `test/fixtures/rex-subagent-v0.2.0` and its provenance record) as a real Pi
 * extension next to pi-goal, so every child run goes through the released
 * `rex_spawn` / `rex_wait` / `rex_observe` / `rex_stop` tools — never a local Rex
 * checkout and never a fake adapter in front of pi-goal.
 *
 * Isolation comes from three per-test resources, all under one temp directory:
 *
 * - a foreground Rex server on a private Unix socket (`rex server run
 *   --listen ... --state-dir ... --restore=false`), selected through the
 *   `REX_SERVER` environment variable the released extension's `discoverRex`
 *   honors, so no window or session ever touches the user's own Rex app;
 * - a deterministic OpenAI-compatible chat-completions server the spawned child
 *   Pi resolves through `models.json` in the shared `PI_CODING_AGENT_DIR`
 *   (`buildChildScript` exports that variable to the child), so the child needs
 *   no credentials and reports exactly the scripted `Usage`;
 * - that agent dir itself, which also isolates the provider's run records
 *   (`<agent-dir>/rex-subagents/<handle>`).
 *
 * The fake provider reports one fixed usage per child turn, chosen so every
 * component of pi-goal's formula is exercised: non-cached input, output that
 * contains reasoning tokens, cache writes that count, and cache reads that must
 * stay visible but excluded. A hold gate can keep the child mid-turn so a test
 * can observe the zero-usage snapshot a running child has already published.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readJsonFile(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** The vendored, verbatim v0.2.0 release tree the acceptance suite loads. */
export const REX_ARTIFACT_DIR = join(repoRoot, "test", "fixtures", "rex-subagent-v0.2.0");
/** Provenance recorded when the release tree was vendored (tag, commit, sha). */
export const REX_PROVENANCE = readJsonFile(join(repoRoot, "test", "fixtures", "rex-subagent-v0.2.0.provenance.json"));

/**
 * The one usage report every child turn produces, as Pi's openai-completions
 * adapter maps it: `input = prompt_tokens - cached - cache_write`.
 */
export const CHILD_USAGE = { input: 60, output: 30, cacheRead: 50, cacheWrite: 10, reasoning: 12 };
/** The child usage pi-goal must account: input + output + cacheWrite. */
export const CHILD_ACCOUNTED = CHILD_USAGE.input + CHILD_USAGE.output + CHILD_USAGE.cacheWrite;

/** Whether a `rex` CLI is available to run the isolated server at all. */
export function rexAvailable() {
	const probe = spawnSync("rex", ["--help"], { timeout: 10_000, stdio: "ignore" });
	return probe.error === undefined;
}

function sse(object) {
	return `data: ${JSON.stringify(object)}\n\n`;
}

/**
 * Deterministic OpenAI-compatible server for the child Pi.
 *
 * Every `/chat/completions` request streams one assistant answer whose final
 * chunk carries the fixed {@link CHILD_USAGE}. While `hold` is armed each
 * response is deferred until `releaseChild()`, which is how a test keeps the
 * child provably mid-turn (its pre-turn snapshot published, its usage not).
 */
class ChildProviderServer {
	#release = () => undefined;

	constructor() {
		this.requests = [];
		this.hold = false;
		this.#startHoldGate();
		this.server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				this.requests.push({ url: request.url, body });
				if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
					response.writeHead(404).end();
					return;
				}
				const finish = () => {
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					response.write(
						sse({
							id: "child",
							object: "chat.completion.chunk",
							created: 1,
							model: "child-model",
							choices: [{ index: 0, delta: { role: "assistant", content: "CHILD_DONE" }, finish_reason: null }],
						}),
					);
					response.write(
						sse({
							id: "child",
							object: "chat.completion.chunk",
							created: 1,
							model: "child-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: CHILD_USAGE.input + CHILD_USAGE.cacheRead + CHILD_USAGE.cacheWrite,
								completion_tokens: CHILD_USAGE.output,
								prompt_tokens_details: {
									cached_tokens: CHILD_USAGE.cacheRead,
									cache_write_tokens: CHILD_USAGE.cacheWrite,
								},
								completion_tokens_details: { reasoning_tokens: CHILD_USAGE.reasoning },
							},
						}),
					);
					response.write("data: [DONE]\n\n");
					response.end();
				};
				if (this.hold) {
					this.holdGate.then(finish);
					return;
				}
				finish();
			});
		});
	}

	#startHoldGate() {
		this.holdGate = new Promise((resolve) => {
			this.#release = resolve;
		});
	}
	/** Keep every further child response until {@link releaseChild}. */
	armHold() {
		this.hold = true;
	}

	/** Let exactly the held child responses through. */
	releaseChild() {
		this.hold = false;
		this.#release();
		this.#startHoldGate();
	}

	/** Resolve once the child has requested its first turn (so its pre-turn snapshot exists). */
	async waitForChildRequest() {
		const deadline = Date.now() + 60_000;
		while (this.requests.length === 0) {
			if (Date.now() > deadline) throw new Error("the Rex child never requested its deterministic provider");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	listen() {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => resolve(this.server.address().port));
		});
	}

	close() {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

function waitForSocket(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (existsSync(path)) return resolve();
			if (Date.now() > deadline) return reject(new Error(`isolated Rex server never listened on ${path}`));
			setTimeout(poll, 25);
		};
		poll();
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start one fully isolated acceptance environment: released provider artifact,
 * isolated Rex server, deterministic child provider, and the agent dir both the
 * parent and the spawned child share.
 */
export async function startRexAcceptanceEnv() {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-rex-"));
	const agentDir = join(root, "agent");
	const socketPath = join(root, "server.sock");
	const stateDir = join(root, "rex-state");
	mkdirSync(agentDir, { recursive: true });

	const provider = new ChildProviderServer();
	const port = await provider.listen();

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					rexdeterministic: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "pi-goal-acceptance",
						models: [{ id: "child-model" }],
					},
				},
			},
			null,
			"\t",
		) + "\n",
		"utf8",
	);

	const rex = spawn(
		"rex",
		[
			"server",
			"run",
			"--listen",
			`unix://${socketPath}`,
			"--state-dir",
			stateDir,
			"--restore=false",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	rex.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
	const exited = new Promise((resolve) => rex.once("exit", (code, signal) => resolve({ code, signal })));

	// A parent Pi spawned from inside a Rex window (for example a delegated
	// worker) must not inherit that window's identity: the released provider
	// refuses to nest, and the parent tab is none of the test's business. The
	// private socket is the only Rex this environment may talk to. The `pi`
	// binary's directory leads PATH so a PI_BINARY override still reaches children.
	const pathPrefix = process.env.PI_BINARY ? [dirname(process.env.PI_BINARY)] : [];
	const sessionEnv = {
		REX_SERVER: `unix://${socketPath}`,
		PI_REX_SUBAGENT_HANDLE: undefined,
		REX_SESSION: undefined,
		REX_BLOCK: undefined,
		REX_CLIENT: undefined,
		PATH: [...pathPrefix, process.env.PATH].filter(Boolean).join(":"),
	};

	let stopped = false;
	const environment = {
		agentDir,
		sessionEnv,
		provider,
		/** Options for `PiRpcSession.start`: the released provider rides along. */
		sessionOptions() {
			return {
				agentDir,
				extraExtensions: [REX_ARTIFACT_DIR],
				env: sessionEnv,
			};
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			try {
				rex.kill("SIGTERM");
				await Promise.race([exited, sleep(10_000).then(() => rex.kill("SIGKILL"))]);
			} finally {
				await provider.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
	// A failure after the server spawn must not leak the process and the socket.
	try {
		await waitForSocket(socketPath, 20_000);
	} catch (error) {
		await environment.stop();
		throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `; rex stderr: ${stderr}` : ""}`);
	}
	return environment;
}
