/**
 * Minimal deterministic RPC harness for driving a real `pi --mode rpc` subprocess.
 *
 * Spawns the installed Pi CLI with full environment isolation (temp agent dir,
 * temp session dir, temp working directory) plus the pi-goal package and the
 * scripted test provider. JSONL records are collected and exposed through
 * promise-based waiters so tests can assert on responses, events, extension UI
 * notifications, tool executions, and session files.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
		this.records = [];
		this.waiters = [];
		this.exitInfo = null;
		this.closed = false;
	}

	static async start(options) {
		const session = new PiRpcSession(options);
		session.start();
		return session;
	}

	start() {
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
		if (this.noSession) args.push("--no-session");
		else if (this.resumeSessionFile) args.push("--session-dir", this.sessionDir, "--session", this.resumeSessionFile);
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
			const waiter = {
				tryResolve: (records, exitInfo) => {
					const value = test(records);
					if (value !== undefined) {
						clearTimeout(timer);
						resolve(value);
						return true;
					}
					if (exitInfo && !this.closed) {
						clearTimeout(timer);
						reject(new Error(`pi exited (${exitInfo.code ?? exitInfo.signal}) while waiting for: ${description}`));
						return true;
					}
					return false;
				},
			};
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
			this.waiters.push(waiter);
		});
	}

	/** Send a prompt (user text, possibly an extension command) and await its response record. */
	async prompt(message) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for prompt ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.proc.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
		return responsePromise;
	}

	async sendCommand(command) {
		return this.prompt(command);
	}

	/** Wait for the n-th agent_settled event (1-based). */
	async waitForSettled(count = 1) {
		return this.waitFor(
			`${count} agent_settled event(s)`,
			(records) => {
				const settled = records.filter((r) => r.type === "agent_settled");
				return settled.length >= count ? settled[count - 1] : undefined;
			},
		);
	}

	/** Wait for a fire-and-forget extension notify whose message matches. */
	async waitForNotify(matcher) {
		return this.waitFor("matching extension notify", (records) => {
			const found = records.find(
				(r) => r.type === "extension_ui_request" && r.method === "notify" && matcher(r),
			);
			return found;
		});
	}

	/** Wait for a tool execution to finish and return its tool_execution_end record. */
	async waitForToolResult(toolName, count = 1) {
		return this.waitFor(`completion of ${count}. ${toolName} tool call`, (records) => {
			const ends = records.filter((r) => r.type === "tool_execution_end" && r.toolName === toolName);
			return ends.length >= count ? ends[count - 1] : undefined;
		});
	}

	async getState() {
		return this.sendSimple("get_state");
	}

	async getCommands() {
		return this.sendSimple("get_commands");
	}

	async sendSimple(command) {
		const id = `req-${++nextRequestId}`;
		const responsePromise = this.waitFor(
			`response for ${command} ${id}`,
			(records) => records.find((r) => r.type === "response" && r.id === id),
		);
		this.proc.stdin.write(JSON.stringify({ id, type: command }) + "\n");
		const response = await responsePromise;
		if (!response.success) throw new Error(`${command} failed: ${response.error}`);
		return response.data;
	}

	/** Graceful shutdown; resolves when the process exits. */
	async stop() {
		if (this.exitInfo || this.closed) {
			await this.waitForExit(5000).catch(() => this.kill());
			return;
		}
		this.closed = true;
		this.proc.stdin.end();
		try {
			await this.waitForExit(15000);
		} catch {
			this.kill();
		}
	}

	kill() {
		if (this.exitInfo) return;
		this.proc.kill("SIGKILL");
	}

	waitForExit(timeoutMs = 10000) {
		return new Promise((resolve, reject) => {
			if (this.exitInfo) return resolve(this.exitInfo);
			const timer = setTimeout(() => reject(new Error("pi did not exit in time")), timeoutMs);
			this.proc.once("exit", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal });
			});
		});
	}

	/** The session .jsonl file path (persistent sessions only). */
	async sessionFile() {
		const state = await this.getState();
		if (!state.sessionFile) throw new Error("No session file (ephemeral session)");
		return state.sessionFile;
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
