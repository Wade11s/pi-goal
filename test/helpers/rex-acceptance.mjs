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
 *   --listen ... --state-dir ... --restore=false --config <minimal temp file>`),
 *   selected through the `REX_SERVER` environment variable the released
 *   extension's `discoverRex` honors, so no window or session ever touches the
 *   user's own Rex app. The explicit minimal `--config` overrides `REX_CONFIG`
 *   and the default `rex/init.lua`, so the server can never load the developer's
 *   own Rex config and open extra listeners or tailnet endpoints from it;
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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcConformanceSession } from "./subagent-usage-conformance.mjs";
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

/**
 * Whether a `rex` CLI is available to run the isolated server at all.
 *
 * A real version probe with a required clean exit: a `rex` that exists but fails
 * to run (non-zero exit) is not available, and counting it as available would
 * only turn the live acceptance scenarios into confusing failures.
 */
export function rexAvailable() {
	const probe = spawnSync("rex", ["version"], { timeout: 10_000, stdio: "ignore" });
	return probe.error === undefined && probe.status === 0;
}

function sse(object) {
	return `data: ${JSON.stringify(object)}\n\n`;
}

/**
 * Deterministic OpenAI-compatible server for the child Pi.
 *
 * Every `/chat/completions` request streams one assistant answer whose final
 * chunk carries the fixed {@link CHILD_USAGE}. The default answer is text; a
 * test-installed responder can instead emit tool calls for nested delegation.
 * While `hold` is armed each
 * response is deferred until `releaseChild()`, which is how a test keeps the
 * child provably mid-turn (its pre-turn snapshot published, its usage not).
 */
export class ChildProviderServer {
	#release = () => undefined;

	constructor() {
		this.requests = [];
		this.hold = false;
		/** Optional per-request response script used by nested-delegation acceptance. */
		this.responder = undefined;
		/** Failures a responder raised, surfaced instead of crashing the HTTP handler. */
		this.responderErrors = [];
		this.#startHoldGate();
		this.server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				this.requests.push({ url: request.url, body });
				const requestIndex = this.requests.length - 1;
				if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
					response.writeHead(404).end();
					return;
				}
				// The responder may be async (nested acceptance holds a child until
				// another one has been observed), and it may throw. Either way the
				// outcome must reach the test as a failed response plus a recorded
				// error, never as an exception escaping this HTTP handler.
				const finish = async () => {
					const index = requestIndex;
					const answer = (await this.responder?.({ index, body: body ? JSON.parse(body) : {} })) ?? { text: "CHILD_DONE" };
					const delta = { role: "assistant" };
					if (answer.text !== undefined) delta.content = answer.text;
					if (answer.toolCalls) {
						delta.tool_calls = answer.toolCalls.map((call, callIndex) => ({
							index: callIndex,
							id: `child-call-${index}-${callIndex}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.args) },
						}));
					}
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					response.write(
						sse({
							id: "child",
							object: "chat.completion.chunk",
							created: 1,
							model: "child-model",
							choices: [{ index: 0, delta, finish_reason: null }],
						}),
					);
					response.write(
						sse({
							id: "child",
							object: "chat.completion.chunk",
							created: 1,
							model: "child-model",
							choices: [{ index: 0, delta: {}, finish_reason: answer.toolCalls?.length ? "tool_calls" : "stop" }],
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
				const run = () => finish().catch((error) => {
					this.responderErrors.push(error);
					response.writeHead(500, { "content-type": "text/plain" }).end(`responder failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				if (this.hold) {
					this.holdGate.then(run);
					return;
				}
				run();
			});
		});
	}

	#startHoldGate() {
		this.holdGate = new Promise((resolve) => {
			this.#release = resolve;
		});
	}
	/**
	 * Script a response from the OpenAI request body and zero-based request index.
	 * The default remains one fixed text response; nested acceptance uses tool calls.
	 * The responder may be async, so a scenario can hold one child until another
	 * one has provably arrived; a throw is recorded in {@link responderErrors}
	 * and answered as a failed response.
	 */
	setResponder(responder) {
		this.responder = responder;
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
	async waitForChildRequest(count = 1) {
		const deadline = Date.now() + 60_000;
		while (this.requests.length < count) {
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
		return new Promise((resolve) => {
			this.server.close(() => resolve());
			// Drop every open socket so close() cannot block on a child that never
			// finishes its POST (held, blocked, or slow): destroying the sockets lets
			// the close callback fire even while a response is still held.
			this.server.closeAllConnections();
		});
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

/**
 * Stop a detached server process group within `graceMs`, escalating from a
 * group SIGTERM to a group SIGKILL, and always clearing the escalation timer.
 *
 * The server is spawned `detached`, so it leads its own process group and
 * `-child.pid` reaches the server together with every window it spawned (the
 * child Pi). Clearing the timer is what keeps a passing teardown from leaving a
 * pending handle that would otherwise hold `node --test` open for the whole
 * grace period.
 */
export function stopServer(child, exited, graceMs = 5000) {
	return new Promise((resolve) => {
		const signalGroup = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// The group is already gone, or the platform refuses group signals.
			}
		};
		let settled = false;
		let escalation;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(escalation);
			resolve();
		};
		escalation = setTimeout(() => {
			signalGroup("SIGKILL");
			// SIGKILL cannot be blocked; never wait past the grace period.
			settle();
		}, graceMs);
		exited.then(settle);
		signalGroup("SIGTERM");
	});
}

/**
 * Kill and reap every client process an acceptance environment spawned, bounded.
 *
 * `runProcess` retains each handle for the environment's lifetime, so a call the
 * test abandons — a `wait` that outlives its `--for` deadline, a `send` that
 * never returns, a reap loop that gives up — is still reachable here. SIGTERM
 * first, then a bounded escalation to SIGKILL, then a bounded wait for the
 * reaps: teardown never blocks on a client that refuses to die, and never
 * leaves one running after the socket and the temp tree are gone.
 *
 * These are direct children of the test process, so they are signalled
 * individually: the test process must never signal its own process group.
 */
export function stopClients(children, graceMs = 2000) {
	const live = [...children].filter((child) => child.exitCode === null && child.signalCode === null);
	if (live.length === 0) return Promise.resolve();
	const reaped = Promise.all(
		live.map(
			(child) =>
				new Promise((resolve) => {
					const done = () => resolve();
					child.once("exit", done);
					child.once("error", done);
					child.once("close", done);
				}),
		),
	);
	const signal = (signalName) => {
		for (const child of live) {
			try {
				child.kill(signalName);
			} catch {
				// Already dead, or never started: the reap wait settles it anyway.
			}
		}
	};
	return new Promise((resolve) => {
		let settled = false;
		let escalation;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(escalation);
			resolve();
		};
		escalation = setTimeout(() => {
			// SIGKILL cannot be blocked; never wait past the grace period.
			signal("SIGKILL");
			settle();
		}, graceMs);
		reaped.then(settle);
		signal("SIGTERM");
	});
}

/**
 * SHA-256 over a vendored tree: the sorted relative paths followed by each
 * file's bytes, every path and body separated by a NUL so no two distinct trees
 * can collide. Recorded in the fixture's provenance so a later edit to the tree
 * is caught by the acceptance test instead of silently passing.
 */
export function hashTree(dir) {
	const files = [];
	const walk = (current, prefix) => {
		for (const name of readdirSync(current)) {
			const full = join(current, name);
			const rel = prefix ? `${prefix}/${name}` : name;
			if (statSync(full).isDirectory()) walk(full, rel);
			else files.push({ rel, full });
		}
	};
	walk(dir, "");
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const hash = createHash("sha256");
	for (const { rel, full } of files) {
		hash.update(rel, "utf8");
		hash.update("\0");
		hash.update(readFileSync(full));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/**
 * Start one fully isolated acceptance environment: released provider artifact,
 * isolated Rex server, deterministic child provider, and the agent dir both the
 * parent and the spawned child share.
 */
export async function startRexAcceptanceEnv(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-rex-"));
	const agentDir = join(root, "agent");
	const socketPath = join(root, "server.sock");
	const stateDir = join(root, "rex-state");
	mkdirSync(agentDir, { recursive: true });
	// Nested children discover user-level extensions from the shared agent dir.
	// The parent then uses that same single global loading path instead of loading
	// the release twice (once explicitly and once through the symlink).
	if (options.loadProviderGlobally) {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		symlinkSync(REX_ARTIFACT_DIR, join(extensionsDir, "rex-subagent"), "dir");
	}

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

	// Isolate the server from the developer's own Rex config: an explicit minimal
	// `--config` overrides REX_CONFIG and the default rex/init.lua, so the server
	// can never pick up extra listeners or tailnet endpoints from them (see the
	// module header for the full isolation boundary).
	const rexConfigPath = join(root, "rex-init.lua");
	writeFileSync(
		rexConfigPath,
		"# Intentionally minimal Rex config for the isolated acceptance server.\n" +
			"# No bindings, no extra listeners, no tailnet: the only endpoint is the\n" +
			"# private --listen socket, so the server never reaches the user's Rex.\n",
		"utf8",
	);

	// `detached` makes the server its own process-group leader, so stopServer can
	// signal the whole group (-pid) and reap the child Pi window it spawns.
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
			"--config",
			rexConfigPath,
		],
		{
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
			// Rex windows inherit the server's environment. Pinning the endpoint here
			// as well as in the parent keeps a nested child on this private server.
			env: { ...process.env, REX_SERVER: `unix://${socketPath}` },
		},
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

	// Every client this environment spawns — the released CLI and the `rex`
	// client — is a direct child of the test process. Retaining the handles is
	// what lets teardown kill and reap a client whose call was abandoned by a
	// throwing test or a wait timeout, instead of leaking it past the socket and
	// the temp tree it was talking to.
	const clients = new Set();
	const runProcess = async (executable, args, env = sessionEnv) => {
		const child = spawn(executable, args, {
			cwd: root,
			env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined)),
			stdio: ["ignore", "pipe", "pipe"],
		});
		clients.add(child);
		// Forget a client the moment it is no longer running, so teardown only
		// ever signals processes that are still alive. Registered before the
		// await below so an already-exited client can never be signalled.
		const forget = () => clients.delete(child);
		child.once("exit", forget);
		child.once("error", forget);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
		const code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		return { code, stdout, stderr };
	};

	let stopped = false;
	const environment = {
		root,
		agentDir,
		sessionEnv,
		provider,
		runDir(handle) {
			return join(agentDir, "rex-subagents", handle);
		},
		record(handle) {
			return readJsonFile(join(this.runDir(handle), "metadata.json"));
		},
		records() {
			const runsRoot = join(agentDir, "rex-subagents");
			return existsSync(runsRoot) ? readdirSync(runsRoot).map((handle) => this.record(handle)) : [];
		},
		/** Pids of the client processes this environment has left running. */
		clientPids() {
			return [...clients].map((child) => child.pid).filter((pid) => Number.isInteger(pid));
		},
		/**
		 * Run an arbitrary client in the isolated environment. Like the CLI and the
		 * `rex` client, its handle is retained for the environment's lifetime, so
		 * teardown reaps it too — which is what makes that contract testable.
		 */
		runProcess(executable, args, env = sessionEnv) {
			return runProcess(executable, args, env);
		},
		/** Run the released CLI in the same isolated environment, never the user's Rex. */
		async cli(args, { allowFailure = false } = {}) {
			const result = await runProcess(process.execPath, [join(REX_ARTIFACT_DIR, "src", "cli.ts"), ...args], {
				...sessionEnv,
				PI_CODING_AGENT_DIR: agentDir,
				PI_SESSION_ID: undefined,
			});
			if (!allowFailure && result.code !== 0) {
				throw new Error(`rex-subagent ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
			}
			return result;
		},
		async waitForRun(handle) {
			const result = await this.cli(["wait", handle, "--for", "60s", "--json"], { allowFailure: true });
			const [outcome] = JSON.parse(result.stdout);
			if (!outcome || outcome.outcome === "timeout") {
				throw new Error(`child ${handle} did not settle: ${result.stdout || result.stderr}`);
			}
			return outcome;
		},
		async send(handle, message) {
			await this.cli(["send", handle, message]);
		},
		/** Crash only this child, leaving its last durable snapshot untouched. */
		async killChild(handle) {
			const record = this.record(handle);
			const args = [
				"-S", record.rex.endpoint,
				"--autostart=false",
				"block", "call", "-s", record.rex.sessionId, "-b", record.rex.blockId, "process",
			];
			const before = await runProcess("rex", args);
			if (before.code !== 0) throw new Error(`could not inspect child ${handle}: ${before.stderr || before.stdout}`);
			const pid = JSON.parse(before.stdout).child?.pid;
			if (!Number.isInteger(pid)) throw new Error(`child ${handle} has no live process to kill: ${before.stdout}`);
			process.kill(pid, "SIGKILL");
			const deadline = Date.now() + 10_000;
			for (;;) {
				const after = await runProcess("rex", args);
				if (after.code === 0 && JSON.parse(after.stdout).last_exit) return;
				if (Date.now() > deadline) throw new Error(`Rex did not reap killed child ${handle}`);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		},
		/** Options for `PiRpcSession.start`: the released provider rides along. */
		sessionOptions() {
			return {
				agentDir,
				extraExtensions: options.loadProviderGlobally ? [] : [REX_ARTIFACT_DIR],
				env: sessionEnv,
			};
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			try {
				// Release any held child so its in-flight response can drain, then
				// close the deterministic provider. close() also drops every open
				// socket, so it cannot block on a child that never finishes its
				// POST — the state a test that throws or times out before
				// releaseChild() would otherwise leave behind.
				provider.releaseChild();
				await provider.close();
			} finally {
				// Reap this environment's own clients first: they are direct children of
				// the test process, and a call a throwing or timed-out test abandoned can
				// still be running against the socket we are about to remove.
				await stopClients(clients);
				// Kill the whole server process group (the child Pi is a descendant)
				// with a bounded wait, then always remove the temp tree.
				await stopServer(rex, exited);
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

/**
 * Issue #45 neutral-conformance adapter. Snapshot writes below are fixture
 * administration only; every observation under test still crosses the released
 * provider's real public tool-result seam in a real parent Pi.
 */
export async function startRexConformanceProvider() {
	const env = await startRexAcceptanceEnv();
	const rpc = new RpcConformanceSession({
		...env.sessionOptions(),
		toolNames: { spawn: "rex_spawn", adopt: "rex_adopt", observe: "rex_observe", stop: "rex_stop" },
	});
	rpc.spawnArgs = (name) => ({
		prompt: `Run ${name} for neutral usage conformance`,
		name,
		provider: "rexdeterministic",
		model: "child-model",
	});
	await rpc.start();
	const provider = {
		source: "pi-rex-subagent",
		env,
		rpc,
		async spawn(name) {
			const spawned = await rpc.spawn(name);
			if (spawned.runId) await env.waitForRun(spawned.runId);
			return spawned;
		},
		observe: (handles) => rpc.observe(handles),
		observeConcurrent: (groups) => rpc.observeConcurrent(groups),
		adopt: (handle) => rpc.adopt(handle),
		stop: (handle) => rpc.stop(handle),
		restart: () => rpc.restart(),
		assertRestartWasFree: () => rpc.assertRestartWasFree(),
		baselineEntryId: (handle) => rpc.baselineEntryId(handle),
		navigate: (entryId) => rpc.navigate(entryId),
		async snapshot(runId) {
			const raw = JSON.parse(readFileSync(join(env.runDir(runId), "usage.json"), "utf8"));
			return {
				version: raw.version,
				source: raw.source,
				runId: raw.runHandle,
				parentSessionId: raw.parentSessionId,
				childSessionId: raw.childSessionId,
				childSessionGeneration: raw.childSessionGeneration,
				sequence: raw.sequence,
				usage: raw.usage,
				final: raw.final,
			};
		},
		async publish(runId, snapshot) {
			writeFileSync(join(env.runDir(runId), "usage.json"), `${JSON.stringify({
				version: snapshot.version,
				source: snapshot.source,
				runHandle: runId,
				parentSessionId: snapshot.parentSessionId,
				childSessionId: snapshot.childSessionId,
				childSessionGeneration: snapshot.childSessionGeneration,
				sequence: snapshot.sequence,
				usage: snapshot.usage,
				final: snapshot.final,
				updatedAt: "2026-01-01T00:00:00.000Z",
			}, null, 2)}\n`, "utf8");
		},
		async createUnowned(runId, usage) {
			const spawned = await env.cli([
				"spawn", "--name", runId, "--provider", "rexdeterministic", "--model", "child-model",
				"--prompt", "pre-adoption neutral conformance work", "--json",
			]);
			const handle = JSON.parse(spawned.stdout).handle;
			await env.waitForRun(handle);
			await provider.publish(handle, { ...await provider.snapshot(handle), sequence: 1, usage });
			return handle;
		},
		async prepareFinal() {
			// The real idle child publishes its own final snapshot during rex_stop.
		},
		async hasRun(runId) {
			return existsSync(env.runDir(runId));
		},
		async close() {
			await rpc.close();
			await env.stop();
		},
	};
	return provider;
}
