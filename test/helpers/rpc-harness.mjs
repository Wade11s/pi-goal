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

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const PI_BINARY = process.env.PI_BINARY ?? "pi";
export const PI_TIMEOUT_MS = Number(process.env.PI_GOAL_TEST_TIMEOUT_MS ?? 90_000);

let nextRequestId = 0;

export class PiRpcSession {
	constructor(options = {}) {
		this.agentDir = mkdtempSync(join(tmpdir(), "pi-goal-agent-"));
		this.sessionDir = options.sessionDir ?? mkdtempSync(join(tmpdir(), "pi-goal-sessions-"));
		this.cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-goal-work-"));
		this.scriptPath = options.scriptPath ?? join(this.cwd, "provider-script.json");
		this.noSession = options.noSession ?? false;
		this.resumeSessionFile = options.sessionFile;
		// Extra extensions loaded after the scripted provider, for tests that need a
		// second extension composing with pi-goal (for example boundary entries).
		this.extraExtensions = options.extraExtensions ?? [];
		// User-level settings written to <agent-dir>/settings.json before the spawn,
		// for tests that need deterministic retry or compaction behavior.
		this.settings = options.settings ?? undefined;

		// Only remove directories this session created; dirs passed in via options
		// (shared cwd, shared session dir) outlive this instance and are the
		// caller's responsibility.
		this.ownedTempDirs = [this.agentDir];
		if (!options.cwd) this.ownedTempDirs.push(this.cwd);
		if (!options.sessionDir) this.ownedTempDirs.push(this.sessionDir);

		this.records = [];
		this.waiters = [];
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
		const args = [
			"--mode",
			"rpc",
			"-e",
			join(repoRoot), // load the pi-goal package via its package.json pi manifest
			"-e",
			join(repoRoot, "test", "extensions", "scripted-provider.ts"),
			"--provider",
			"scripted",
			"--model",
			"scripted-1",
		];
		for (const extension of this.extraExtensions) args.push("-e", extension);
		if (this.noSession) args.push("--no-session");
		else if (this.resumeSessionFile) args.push("--session", this.resumeSessionFile);
		else args.push("--session-dir", this.sessionDir);

		this.proc = spawn(PI_BINARY, args, {
			cwd: this.cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: this.agentDir,
				PI_GOAL_TEST_SCRIPT: this.scriptPath,
			},
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

/** Find the last goal-state snapshot entry in a session file. */
export function lastGoalSnapshot(entries) {
	let snapshot;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "goal-state") snapshot = entry;
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
