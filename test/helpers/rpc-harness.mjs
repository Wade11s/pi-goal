/**
 * Minimal deterministic RPC harness for driving a real `pi --mode rpc` subprocess.
 *
 * Spawns the installed Pi CLI with full environment isolation (temp agent dir,
 * temp session dir, temp working directory) plus the pi-goal package and the
 * scripted test provider. JSONL records are collected and exposed through
 * promise-based waiters so tests can assert on responses, events, extension UI
 * notifications, tool executions, and session files.
 *
 * Temp directories created here are removed when the session is stopped; a
 * session dir passed in via options is left in place for sharing across
 * processes. Spawn failures (for example a missing `pi` binary) reject waiters
 * immediately instead of hanging until the timeout.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Drop undefined values: `spawn` refuses them, and a test may unset a variable. */
function cleanEnv(env) {
	return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export const PI_BINARY = process.env.PI_BINARY ?? "pi";
export const PI_TIMEOUT_MS = Number(process.env.PI_GOAL_TEST_TIMEOUT_MS ?? 90_000);

let nextRequestId = 0;

export class PiRpcSession {
	constructor(options = {}) {
		// A caller-supplied agent dir (the Rex acceptance suite pre-writes models.json
		// there so spawned Rex children resolve the deterministic provider) is the
		// caller's to clean up; only a directory created here is removed on stop.
		this.agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-goal-agent-"));
		this.sessionDir = options.sessionDir ?? mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
		this.cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-goal-work-"));
		this.scriptPath = options.scriptPath ?? join(this.cwd, "provider-script.json");
		this.noSession = options.noSession ?? false;
		this.resumeSessionFile = options.sessionFile;
		// Extensions loaded *before* the pi-goal package. Boundary handlers run in
		// extension load order, so a pre-extension's `agent_before_settle` handler
		// sees pi-goal's proposal in `event.entries` only when it runs first.
		this.preExtensions = options.preExtensions ?? [];
		// Extra extensions loaded after the scripted provider, for tests that need a
		// second extension composing with pi-goal (for example boundary entries).
		this.extraExtensions = options.extraExtensions ?? [];
		// User-level settings written to <agent-dir>/settings.json before the spawn,
		// for tests that need deterministic retry or compaction behavior.
		this.settings = options.settings ?? undefined;
		// Whether the pi-goal package itself is loaded. The companion adapter's
		// optionality test loads only the companion, which is what proves the
		// companion is not a mandatory dependency of pi-goal (and vice versa).
		this.loadPiGoal = options.loadPiGoal ?? true;
		// Pi's `--tools` allowlist and `--exclude-tools` denylist, verbatim. The
		// review-child profile test passes the documented launch arguments here so a
		// real Pi session proves which tools are actually active.
		this.tools = options.tools ?? undefined;
		this.excludeTools = options.excludeTools ?? undefined;
		// Extra environment for the spawned Pi, applied over the harness defaults.
		// The Rex acceptance suite uses it to point the released provider at an
		// isolated Rex server and to strip this terminal's own Rex identity, so a
		// test run from inside a Rex window cannot inherit it.
		this.env = options.env ?? undefined;

		// Only remove directories this session created; dirs passed in via options
		// (shared cwd, shared session dir, caller agent dir) outlive this instance
		// and are the caller's responsibility.
		this.ownedTempDirs = [];
		if (!options.agentDir) this.ownedTempDirs.push(this.agentDir);
		if (!options.cwd) this.ownedTempDirs.push(this.cwd);
		if (!options.sessionDir) this.ownedTempDirs.push(this.sessionDir);

		this.records = [];
		this.waiters = [];
		this.answeredUiRequests = new Set();
		this.exitInfo = null;
		this.spawnError = null;
		this.cleanedUp = false;
		this.closed = false;
	}

	static async start(options) {
		const session = new PiRpcSession(options);
		session.start();
		return session;
	}

	start() {
		if (this.settings) {
			writeFileSync(join(this.agentDir, "settings.json"), JSON.stringify(this.settings), "utf8");
		}
		const args = ["--mode", "rpc"];
		for (const extension of this.preExtensions) args.push("-e", extension);
		if (this.loadPiGoal) args.push("-e", join(repoRoot)); // load pi-goal via its package.json pi manifest
		args.push(
			"-e",
			join(repoRoot, "test", "extensions", "scripted-provider.ts"),
			"--provider",
			"scripted",
			"--model",
			"stepfun-5-preview",
		);
		for (const extension of this.extraExtensions) args.push("-e", extension);
		if (this.tools) args.push("--tools", this.tools);
		if (this.excludeTools) args.push("--exclude-tools", this.excludeTools);
		if (this.noSession) args.push("--no-session");
		else if (this.resumeSessionFile) args.push("--session", this.resumeSessionFile);
		else args.push("--session-dir", this.sessionDir);

		// The exact child argv this session was started with. The review-profile
		// test inspects it, then relies on this same real session to prove the
		// documented arguments actually take effect.
		this.args = args;

		this.proc = spawn(PI_BINARY, args, {
			cwd: this.cwd,
			env: cleanEnv({
				...process.env,
				PI_CODING_AGENT_DIR: this.agentDir,
				PI_GOAL_TEST_SCRIPT: this.scriptPath,
				...(this.env ?? {}),
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});

		let buffer = "";
		this.proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim()) this.onRecord(JSON.parse(line));
			}
		});

		this.stderr = [];
		this.proc.stderr.on("data", (chunk) => this.stderr.push(chunk.toString("utf8")));

		this.proc.on("error", (error) => {
			this.spawnError = new Error(
				`Failed to spawn Pi binary "${PI_BINARY}" (${error.message}). ` +
					"Install Pi 1.5.1+ or set PI_BINARY to a valid binary.",
			);
			this.flushWaiters();
		});

		this.proc.on("exit", (code, signal) => {
			this.exitInfo = { code, signal };
			this.flushWaiters();
		});
	}

	onRecord(record) {
		this.records.push(record);
		this.flushWaiters();
	}

	flushWaiters() {
		this.waiters = this.waiters.filter((waiter) => !waiter.tryResolve(this.records, this.exitInfo));
	}

	/** Wait until a predicate over the accumulated records holds. */
	waitFor(description, predicate, timeoutMs = PI_TIMEOUT_MS) {
		if (this.spawnError) return Promise.reject(this.spawnError);
		const test = (records) => {
			try {
				return predicate(records);
			} catch {
				return undefined;
			}
		};
		const immediate = test(this.records);
		if (immediate !== undefined) return Promise.resolve(immediate);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				reject(
					new Error(
						`Timed out waiting for: ${description}\n` +
							`records so far: ${this.records.map((r) => r.type).join(", ")}\n` +
							`stderr:\n${this.stderr.join("")}`,
					),
				);
			}, timeoutMs);
			const waiter = {
				tryResolve: (records, exitInfo) => {
					if (this.spawnError) {
						clearTimeout(timer);
						reject(this.spawnError);
						return true;
					}
					const value = test(records);
					if (value !== undefined) {
						clearTimeout(timer);
						resolve(value);
						return true;
					}
					if (exitInfo && !this.closed) {
						clearTimeout(timer);
						reject(
							new Error(
								`pi exited (${exitInfo.code ?? exitInfo.signal}) while waiting for: ${description}` +
									(this.stderr.join("").trim() ? `\nstderr:\n${this.stderr.join("")}` : ""),
							),
						);
						return true;
					}
					return false;
				},
			};
			this.waiters.push(waiter);
		});
	}

	writeCommand(command) {
		if (this.spawnError) throw this.spawnError;
		try {
			this.proc.stdin.write(JSON.stringify(command) + "\n");
		} catch (error) {
			throw this.spawnError ?? error;
		}
	}

	/** Send a prompt (user text, possibly an extension command) and await its response record. */
	async prompt(message) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for prompt ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.writeCommand({ id, type: "prompt", message });
		return responsePromise;
	}

	/** Queue a follow-up message while the agent runs; returns its response record. */
	async followUp(message) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for follow_up ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.writeCommand({ id, type: "follow_up", message });
		return responsePromise;
	}

	/**
	 * Queue a steering message while the agent runs; returns its response record.
	 *
	 * A steer is what an interactive user produces by typing while the provider request
	 * is still streaming: Pi dispatches the `input` event immediately and delivers the
	 * message only after the in-flight assistant message and its tool results. That
	 * ordering is the whole point of the ownership tests, so it needs the same
	 * promise-based seam `followUp` has.
	 */
	async steer(message) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for steer ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.writeCommand({ id, type: "steer", message });
		return responsePromise;
	}

	/** Wait for the n-th agent_settled event (1-based). */
	async waitForSettled(count = 1) {
		return this.waitFor(`${count} agent_settled event(s)`, (records) => {
			const settled = records.filter((r) => r.type === "agent_settled");
			return settled.length >= count ? settled[count - 1] : undefined;
		});
	}

	/** Wait for a fire-and-forget extension notify whose message matches. */
	async waitForNotify(matcher) {
		return this.waitFor("matching extension notify", (records) =>
			records.find((r) => r.type === "extension_ui_request" && r.method === "notify" && matcher(r)),
		);
	}

	/**
	 * Wait for a fire-and-forget extension notify that appears strictly after
	 * `mark` records were accumulated (`mark` is usually a captured
	 * `session.records.length`).
	 *
	 * Branch tests navigate one session through several Goal states, so the same
	 * message text ("No Goal is set", "restored", ...) can legitimately appear
	 * many times in one record stream; an unscoped wait would keep matching the
	 * oldest occurrence and hide exactly the state change under test.
	 */
	async notifyAfter(mark, matcher) {
		return this.waitFor("matching extension notify after marker", (records) => {
			for (let index = mark; index < records.length; index++) {
				const record = records[index];
				if (record.type === "extension_ui_request" && record.method === "notify" && matcher(record)) return record;
			}
			return undefined;
		});
	}

	/** All session entries in append order plus the current leaf id (RPC get_entries). */
	async getEntries() {
		return this.sendSimple("get_entries");
	}

	/**
	 * Wait for a blocking extension confirm dialog and answer it.
	 *
	 * Answers over the RPC extension-UI subprotocol exactly like an interactive or
	 * RPC host would: wait for the matching `confirm` request, then send an
	 * `extension_ui_response` with the decision. `confirmed: false` is an
	 * explicit "No" (the same auto-answer a dialog timeout produces). Requests
	 * already answered by an earlier call are skipped, so a matcher like
	 * `() => true` answers the *next* dialog rather than replaying an old one.
	 */
	async respondToConfirm(matcher, confirmed) {
		const request = await this.waitFor("unanswered matching extension confirm dialog", (records) =>
			records.find(
				(r) =>
					r.type === "extension_ui_request" &&
					r.method === "confirm" &&
					!this.answeredUiRequests.has(r.id) &&
					matcher(r),
			),
		);
		this.answeredUiRequests.add(request.id);
		this.writeCommand({ type: "extension_ui_response", id: request.id, confirmed });
		return request;
	}

	/**
	 * Wait for a blocking extension confirm dialog and dismiss it.
	 *
	 * Dismissal is a different wire answer from an explicit "No": a host that
	 * closes the dialog sends `cancelled: true`, which Pi maps to the dialog's
	 * default answer without the user having decided anything. The extension
	 * cannot observe the difference, so this is how a test pins dismissal as its
	 * own path rather than reusing the decline answer.
	 */
	async dismissConfirm(matcher) {
		const request = await this.waitFor("unanswered matching extension confirm dialog", (records) =>
			records.find(
				(r) =>
					r.type === "extension_ui_request" &&
					r.method === "confirm" &&
					!this.answeredUiRequests.has(r.id) &&
					matcher(r),
			),
		);
		this.answeredUiRequests.add(request.id);
		this.writeCommand({ type: "extension_ui_response", id: request.id, cancelled: true });
		return request;
	}

	/**
	 * Wait for a blocking extension editor dialog and answer it with `value`.
	 *
	 * Mirrors `respondToConfirm` for the `editor` method, which carries the
	 * prefilled objective in `prefill` and returns the edited text in `value`.
	 * `cancelled: true` dismisses the dialog (the extension receives undefined).
	 */
	async respondToEditor(matcher, value) {
		const request = await this.waitFor("unanswered matching extension editor dialog", (records) =>
			records.find(
				(r) =>
					r.type === "extension_ui_request" &&
					r.method === "editor" &&
					!this.answeredUiRequests.has(r.id) &&
					matcher(r),
			),
		);
		this.answeredUiRequests.add(request.id);
		this.writeCommand({ type: "extension_ui_response", id: request.id, value });
		return request;
	}

	/** Wait for a tool execution to finish and return its tool_execution_end record. */
	async waitForToolResult(toolName, count = 1) {
		return this.waitFor(`completion of ${count}. ${toolName} tool call`, (records) => {
			const ends = records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
			return ends.length >= count ? ends[count - 1] : undefined;
		});
	}

	async sendSimple(command) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for ${command} ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.writeCommand({ id, type: command });
		const response = await responsePromise;
		if (!response.success) throw new Error(`${command} failed: ${response.error}`);
		return response.data;
	}

	async getState() {
		return this.sendSimple("get_state");
	}

	/**
	 * Rename the session the way an interactive user or a host does (RPC
	 * `set_session_name`).
	 *
	 * This is the *user-provided* name seam: pi-goal must never overwrite it, so a
	 * naming test needs a way to produce a name that did not come from the extension.
	 */
	async setSessionName(name) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for set_session_name ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.writeCommand({ id, type: "set_session_name", name });
		const response = await responsePromise;
		if (!response.success) throw new Error(`set_session_name failed: ${response.error}`);
		return response.data;
	}

	async getCommands() {
		return this.sendSimple("get_commands");
	}

	/** Hard-kill the subprocess without graceful shutdown. */
	killNow() {
		if (!this.exitInfo) this.proc.kill("SIGKILL");
	}

	/** Graceful shutdown; resolves when the process exits. Temp dirs are removed here. */
	async stop() {
		try {
			if (this.spawnError) return;
			if (this.exitInfo || this.closed) {
				await this.waitForExit(5000).catch(() => this.killNow());
				return;
			}
			this.closed = true;
			this.proc.stdin.end();
			try {
				await this.waitForExit(15000);
			} catch {
				this.killNow();
			}
		} finally {
			this.cleanup();
		}
	}

	kill() {
		if (!this.exitInfo) this.proc.kill("SIGKILL");
	}

	waitForExit(timeoutMs = 10000) {
		return new Promise((resolve, reject) => {
			if (this.exitInfo) return resolve(this.exitInfo);
			if (this.spawnError) return reject(this.spawnError);
			const timer = setTimeout(() => reject(new Error("pi did not exit in time")), timeoutMs);
			this.proc.once("exit", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal });
			});
		});
	}

	cleanup() {
		if (this.cleanedUp) return;
		this.cleanedUp = true;
		for (const dir of this.ownedTempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
	}

	/** The session .jsonl file path (persistent sessions only). */
	async sessionFile() {
		const state = await this.getState();
		if (!state.sessionFile) throw new Error("No session file (ephemeral session)");
		return state.sessionFile;
	}

	/** First session .jsonl file in the (owned or shared) session dir, for use after a hard kill. */
	findSessionFile() {
		const files = readdirSync(this.sessionDir).filter((name) => name.endsWith(".jsonl"));
		if (files.length === 0) throw new Error(`No session file in ${this.sessionDir}`);
		return join(this.sessionDir, files[0]);
	}

	extensionErrors() {
		return this.records.filter((r) => r.type === "extension_error");
	}
}

/** Read and parse all entries of a session .jsonl file. */
export function readSessionEntries(sessionFile) {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

/**
 * Write the scripted provider's next responses.
 *
 * Every RPC scenario drives the same scripted test provider, and the provider
 * re-reads this file on every request, so writing it is the one seam a scenario
 * uses to say what the model does next.
 */
export function script(steps, session) {
	writeFileSync(session.scriptPath, JSON.stringify(steps), "utf8");
}

/**
 * Send a command without awaiting its response.
 *
 * A scenario needs this to run a lifecycle command while a provider response is
 * still held open (or while a blocking dialog is unanswered) and observe the
 * ordering, so the response is awaited only once the test is ready for it.
 */
export function submitCommand(session, id, message) {
	const responsePromise = session.waitFor(
		`response for ${id}`,
		(records) => records.find((r) => r.type === "response" && r.id === id),
	);
	session.writeCommand({ id, type: "prompt", message });
	return responsePromise;
}

/** Find the last goal-state snapshot entry in a session file. */
export function lastGoalSnapshot(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state") snapshot = entry;
	}
	return snapshot;
}

/** Every goal-state snapshot entry, in append order. */
export function goalSnapshots(entries) {
	return entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
}

/**
 * The newest *current* goal-state snapshot: the one that selects the session's Goal.
 *
 * A snapshot marked `superseded` is a finalized historical record of a replaced
 * identity. It is valid and replayable, but it never becomes the current Goal, so
 * the newest goal-state entry on the branch is not necessarily this one.
 */
export function currentGoalSnapshot(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state" && entry.data?.superseded !== true) {
			snapshot = entry;
		}
	}
	return snapshot;
}

/** Every goal-continuation custom-message entry, in append order. */
export function continuationEntries(entries) {
	return entries.filter((e) => e.type === "custom_message" && e.customType === "goal-continuation");
}

/** Every entry of one custom-message channel, in append order. */
export function customMessageEntries(entries, customType) {
	return entries.filter((e) => e.type === "custom_message" && e.customType === customType);
}

/** Count agent runs that started, from the accumulated RPC event records. */
export function runCount(session) {
	return session.records.filter((r) => r.type === "agent_start").length;
}

/**
 * Every finalized assistant outcome, in order.
 *
 * A test must be able to tell a clean settle from a settle that only happened
 * because the scripted provider ran out of steps: the provider throws when a
 * step is missing, which surfaces as `stopReason: "error"` and lets an active
 * Goal stop for the wrong reason.
 */
export function assistantOutcomes(session) {
	return session.records
		.filter((r) => r.type === "message_end" && r.message.role === "assistant")
		.map((r) => ({ stopReason: r.message.stopReason, errorMessage: r.message.errorMessage }));
}

/** Assistant outcomes that ended the run as a failure (errored or aborted). */
export function failedAssistantOutcomes(session) {
	return assistantOutcomes(session).filter((o) => o.stopReason === "error" || o.stopReason === "aborted");
}

/**
 * Fail unless every assistant response completed cleanly.
 *
 * Used at the end of every Goal test so a green result can only come from the
 * Goal lifecycle (completion, abort, refusal) and never from a scripted-provider
 * error such as "no step at index N".
 */
export function assertCleanRun(session) {
	assertOnlyFailures(session, []);
}

/**
 * Fail unless the run's only non-clean assistant outcomes are exactly `expected`.
 *
 * Used when a failure is the subject of the test (an aborted run, a terminal
 * provider error) so the expectation is explicit rather than implied.
 */
export function assertOnlyFailures(session, expected) {
	const failed = failedAssistantOutcomes(session);
	assert.equal(
		failed.length,
		expected.length,
		`expected exactly ${expected.length} failed assistant outcome(s), got ${JSON.stringify(failed)}`,
	);
	for (const [index, want] of expected.entries()) {
		assert.equal(failed[index].stopReason, want.stopReason, `outcome ${index}`);
		if (want.errorMessage !== undefined) {
			assert.ok(
				String(failed[index].errorMessage).includes(want.errorMessage),
				`outcome ${index} message: expected ${want.errorMessage}, got ${failed[index].errorMessage}`,
			);
		}
	}
}

/**
 * Fail unless exactly `steps` provider responses were consumed.
 *
 * One shared body is what keeps this meaning the same thing in every scenario: a
 * script that is over- or under-sized fails here instead of silently changing what
 * the run under test actually did.
 */
export function assertStepsConsumed(session, steps, expectedFailures = []) {
	assert.equal(
		assistantOutcomes(session).length,
		steps,
		`expected exactly ${steps} provider responses, got ${assistantOutcomes(session).length}`,
	);
	assertOnlyFailures(session, expectedFailures);
}

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the session file until the newest Goal snapshot satisfies `predicate`.
 *
 * The snapshot is durable state written by the extension, so polling for it is how
 * a scenario waits for a transition to be committed rather than guessing at a
 * delay.
 */
export async function waitForSnapshot(session, predicate, description, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshot = lastGoalSnapshot(readSessionEntries(await session.sessionFile()));
		if (snapshot && predicate(snapshot)) return snapshot;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await sleep(20);
	}
}

/**
 * The live accounted total reported by bare `/goal`.
 *
 * The status report is the user-facing contract for accounted usage, so reading the
 * total out of it pins the observable view rather than a snapshot field that only a
 * durable transition folds.
 */
export async function liveUsage(session) {
	const seen = session.records.filter(
		(r) => r.type === "extension_ui_request" && r.method === "notify" && /Token usage: \d+ tokens/.test(r.message),
	).length;
	await session.prompt("/goal");
	const notify = await session.waitFor("a fresh /goal report", (records) => {
		const matches = records.filter(
			(r) => r.type === "extension_ui_request" && r.method === "notify" && /Token usage: \d+ tokens/.test(r.message),
		);
		return matches.length > seen ? matches.at(-1) : undefined;
	});
	const match = /Token usage: (\d+) tokens/.exec(notify.message);
	assert.ok(match, `no usage in: ${notify.message}`);
	return Number(match[1]);
}
