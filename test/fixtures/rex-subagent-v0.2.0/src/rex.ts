import { spawn } from "node:child_process";

export interface CommandRunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface CommandRunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface CommandRunner {
	run(command: string, args: string[], options?: CommandRunOptions): Promise<CommandRunResult>;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
const REX_API_TIMEOUT = "5s";
/** Cap captured output so a runaway command cannot exhaust memory. */
const MAX_CAPTURED_OUTPUT = 2_000_000;
const TRUNCATED_MARKER = "\n[output truncated]";

interface Capture {
	text: string;
	truncated: boolean;
}

function appendCapped(current: Capture, chunk: string): Capture {
	if (current.text.length >= MAX_CAPTURED_OUTPUT) return { text: current.text, truncated: true };
	const next = current.text + chunk;
	if (next.length > MAX_CAPTURED_OUTPUT) {
		return { text: next.slice(0, MAX_CAPTURED_OUTPUT), truncated: true };
	}
	return { text: next, truncated: current.truncated };
}

function withMarker(capture: Capture): string {
	return capture.truncated ? `${capture.text}${TRUNCATED_MARKER}` : capture.text;
}

export const defaultRunner: CommandRunner = {
	run(command, args, options = {}) {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (result: CommandRunResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};
			const child = spawn(command, args, {
				cwd: options.cwd,
				env: options.env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout: Capture = { text: "", truncated: false };
			let stderr: Capture = { text: "", truncated: false };
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout = appendCapped(stdout, chunk.toString());
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr = appendCapped(stderr, chunk.toString());
			});
			child.on("error", (error: Error) => {
				finish({ code: -1, stdout: withMarker(stdout), stderr: `${withMarker(stderr)}${error.message}`, timedOut });
			});
			child.on("close", (code: number | null) => {
				finish({ code: code ?? -1, stdout: withMarker(stdout), stderr: withMarker(stderr), timedOut });
			});
		});
	},
};

export type RexFailureKind = "unavailable" | "invalid" | "failed" | "stale";

export class RexError extends Error {
	readonly kind: RexFailureKind;
	readonly code: number;

	constructor(kind: RexFailureKind, message: string, code = -1) {
		super(message);
		this.name = "RexError";
		this.kind = kind;
		this.code = code;
	}
}

export interface RexLocation {
	endpoint: string;
	hostId: string;
	account?: string;
	version?: string;
	pid?: number;
}

export interface RexSessionSummary {
	sessionId: string;
	label: string;
}

export interface RexWindowSummary {
	windowId: string;
	label: string;
	blockIds: string[];
}

export interface RexApp {
	clientId: string;
	label: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function rexArgs(location: RexLocation, args: string[]): string[] {
	return ["-S", location.endpoint, "--autostart=false", "--timeout", REX_API_TIMEOUT, ...args];
}

async function runRex(
	location: RexLocation,
	args: string[],
	runner: CommandRunner,
	options: CommandRunOptions = {},
): Promise<CommandRunResult> {
	return runner.run("rex", rexArgs(location, args), options);
}

async function rexJson(
	location: RexLocation,
	args: string[],
	runner: CommandRunner,
	description: string,
): Promise<unknown> {
	const result = await runRex(location, args, runner);
	if (result.timedOut) throw new RexError("unavailable", `rex ${description} timed out`, result.code);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		throw new RexError("failed", `rex ${description} failed: ${detail}`, result.code);
	}
	const parsed = parseJson(result.stdout);
	if (parsed === undefined) throw new RexError("invalid", `rex ${description} returned unparsable JSON`);
	return parsed;
}

/**
 * Resolve the Rex server that this machine already runs. Only a local unix
 * socket is accepted: a subagent must not land on another host by accident.
 */
export async function discoverRex(
	runner: CommandRunner = defaultRunner,
	env: NodeJS.ProcessEnv = process.env,
): Promise<RexLocation> {
	const result = await runner.run("rex", ["whoami", "--json"], { env, timeoutMs: 10_000 });
	if (result.timedOut) throw new RexError("unavailable", "rex whoami timed out; is the Rex server running?");
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		throw new RexError("unavailable", `rex whoami failed: ${detail}`, result.code);
	}
	const parsed = asRecord(parseJson(result.stdout));
	const endpoint = stringField(parsed, "endpoint");
	const hostId = stringField(parsed, "host_id");
	if (!endpoint || !hostId) {
		throw new RexError("invalid", "rex whoami did not report an endpoint and host_id");
	}
	if (!endpoint.startsWith("unix://")) {
		throw new RexError("invalid", `refusing non-local Rex endpoint ${endpoint}`);
	}
	return {
		endpoint,
		hostId,
		account: stringField(parsed, "account"),
		version: stringField(parsed, "rex_version"),
		pid: numberField(parsed, "pid"),
	};
}

/** Verify a pinned location still exists before acting on stored resources. */
export async function validateRex(
	location: RexLocation,
	runner: CommandRunner = defaultRunner,
): Promise<RexLocation> {
	const parsed = asRecord(await rexJson(location, ["whoami", "--json"], runner, "whoami"));
	const endpoint = stringField(parsed, "endpoint");
	const hostId = stringField(parsed, "host_id");
	if (!endpoint || !hostId) throw new RexError("invalid", "rex whoami did not report an endpoint and host_id");
	if (endpoint !== location.endpoint || hostId !== location.hostId) {
		throw new RexError("stale", `Rex server changed (${endpoint} / ${hostId}); the run cannot be managed`);
	}
	return location;
}

export async function listSessions(
	location: RexLocation,
	runner: CommandRunner = defaultRunner,
): Promise<RexSessionSummary[]> {
	const parsed = asRecord(await rexJson(location, ["ls", "--json"], runner, "ls"));
	const raw = parsed?.sessions;
	if (!Array.isArray(raw)) return [];
	const sessions: RexSessionSummary[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		const sessionId = stringField(record, "session_id");
		if (!sessionId) continue;
		sessions.push({ sessionId, label: stringField(record, "label") ?? "" });
	}
	return sessions;
}

export interface LaunchRequest {
	label: string;
	windowLabel: string;
	cwd: string;
	argv: string[];
}

export interface LaunchedWindow {
	sessionId: string;
	windowId: string;
	blockId: string;
}

/** Create a session whose first window runs `argv` directly, without a shell. */
export async function createSession(
	location: RexLocation,
	request: LaunchRequest,
	runner: CommandRunner = defaultRunner,
): Promise<LaunchedWindow> {
	const parsed = asRecord(
		await rexJson(
			location,
			[
				"new",
				request.label,
				"--window",
				request.windowLabel,
				"-c",
				request.cwd,
				"--shell=none",
				"--keep-open",
				"--json",
				"--",
				...request.argv,
			],
			runner,
			"new",
		),
	);
	const sessionId = stringField(parsed, "session_id");
	const windows = parsed?.initial_windows;
	const first = Array.isArray(windows) ? asRecord(windows[0]) : undefined;
	const windowId = stringField(first, "window_id");
	const blockIds = first?.block_ids;
	const blockId = Array.isArray(blockIds) ? blockIds.find((id): id is string => typeof id === "string") : undefined;
	if (!sessionId || !windowId || !blockId) {
		throw new RexError("invalid", "rex new did not report a session, window and block");
	}
	return { sessionId, windowId, blockId };
}

/** Add one agent window to an existing batch session. */
export async function addWindow(
	location: RexLocation,
	sessionId: string,
	request: Omit<LaunchRequest, "label">,
	runner: CommandRunner = defaultRunner,
): Promise<LaunchedWindow> {
	const parsed = asRecord(
		await rexJson(
			location,
			[
				"window",
				"new",
				"-s",
				sessionId,
				request.windowLabel,
				"-c",
				request.cwd,
				"--shell=none",
				"--keep-open",
				"--focus=false",
				"--json",
				"--",
				...request.argv,
			],
			runner,
			"window new",
		),
	);
	const windowId = stringField(parsed, "window_id");
	const blockIds = parsed?.block_ids;
	const blockId = Array.isArray(blockIds) ? blockIds.find((id): id is string => typeof id === "string") : undefined;
	if (!windowId || !blockId) throw new RexError("invalid", "rex window new did not report a window and block");
	return { sessionId, windowId, blockId };
}

export async function listWindows(
	location: RexLocation,
	sessionId: string,
	runner: CommandRunner = defaultRunner,
): Promise<RexWindowSummary[]> {
	const parsed = asRecord(await rexJson(location, ["session", "inspect", sessionId, "--json"], runner, "session inspect"));
	const windows = parsed?.windows;
	if (!Array.isArray(windows)) return [];
	const result: RexWindowSummary[] = [];
	for (const entry of windows) {
		const record = asRecord(entry);
		const windowId = stringField(record, "window_id");
		if (!windowId) continue;
		const blockIds: string[] = [];
		const layers = record?.layers;
		if (Array.isArray(layers)) {
			for (const layer of layers) {
				const blocks = asRecord(layer)?.blocks;
				if (!Array.isArray(blocks)) continue;
				for (const block of blocks) {
					const blockId = stringField(asRecord(block), "block_id");
					if (blockId) blockIds.push(blockId);
				}
			}
		}
		result.push({ windowId, label: stringField(record, "label") ?? "", blockIds });
	}
	return result;
}

export type ProbeState = "running" | "exited" | "missing" | "unknown";

export interface ProbeResult {
	state: ProbeState;
	exitCode?: number;
	detail?: string;
}

/**
 * Ask Rex about the terminal's real child process. Existence of a window is not
 * evidence that the agent still runs, and an unreachable server is not evidence
 * that it exited.
 */
export async function probeBlock(
	location: RexLocation,
	sessionId: string,
	blockId: string,
	runner: CommandRunner = defaultRunner,
): Promise<ProbeResult> {
	const result = await runRex(location, ["block", "call", "-s", sessionId, "-b", blockId, "process"], runner);
	if (result.timedOut) return { state: "unknown", detail: "rex probe timed out" };
	if (result.code !== 0) {
		const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
		if (text.includes("not found") || text.includes("no such")) return { state: "missing" };
		return { state: "unknown", detail: result.stderr.trim() || `probe exit ${result.code}` };
	}
	const parsed = asRecord(parseJson(result.stdout));
	if (!parsed) return { state: "unknown", detail: "unparsable probe reply" };
	const lastExit = asRecord(parsed.last_exit);
	if (lastExit) {
		const exitCode = numberField(lastExit, "exit_code");
		return exitCode === undefined ? { state: "exited" } : { state: "exited", exitCode };
	}
	if (asRecord(parsed.child)) return { state: "running" };
	return { state: "unknown", detail: "probe reported neither child nor last_exit" };
}

export async function closeWindow(
	location: RexLocation,
	sessionId: string,
	windowId: string,
	runner: CommandRunner = defaultRunner,
): Promise<void> {
	const result = await runRex(location, ["window", "close", "-s", sessionId, windowId], runner);
	if (result.code !== 0) {
		const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
		if (text.includes("not found") || text.includes("no such")) return;
		throw new RexError("failed", `rex window close failed: ${result.stderr.trim() || `exit ${result.code}`}`, result.code);
	}
}

export async function killSession(
	location: RexLocation,
	sessionId: string,
	runner: CommandRunner = defaultRunner,
): Promise<void> {
	const result = await runRex(location, ["kill", sessionId], runner);
	if (result.code !== 0) {
		const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
		if (text.includes("not found") || text.includes("no such")) return;
		throw new RexError("failed", `rex kill failed: ${result.stderr.trim() || `exit ${result.code}`}`, result.code);
	}
}

export async function listApps(
	location: RexLocation,
	runner: CommandRunner = defaultRunner,
): Promise<RexApp[]> {
	const parsed = asRecord(await rexJson(location, ["client", "ls", "--json"], runner, "client ls"));
	const raw = parsed?.clients;
	if (!Array.isArray(raw)) return [];
	const apps: RexApp[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		const clientId = stringField(record, "client_id");
		const info = asRecord(record?.info);
		if (!clientId || !info || stringField(info, "kind") !== "app") continue;
		apps.push({ clientId, label: stringField(info, "label") ?? clientId });
	}
	return apps;
}

export async function selectSession(
	location: RexLocation,
	sessionId: string,
	windowId: string | undefined,
	runner: CommandRunner = defaultRunner,
	clientId?: string,
): Promise<void> {
	const args = clientId ? ["-C", clientId, "do"] : ["do"];
	args.push("session.select", `session_id=${sessionId}`);
	if (windowId) args.push(`window_id=${windowId}`);
	const result = await runRex(location, args, runner);
	if (result.code !== 0) {
		throw new RexError("failed", `rex session.select failed: ${result.stderr.trim() || `exit ${result.code}`}`, result.code);
	}
}

/** Resolve the window that holds a block, used to remember the parent tab. */
export async function inspectBlock(
	location: RexLocation,
	sessionId: string,
	blockId: string,
	runner: CommandRunner = defaultRunner,
): Promise<string | undefined> {
	const parsed = asRecord(
		await rexJson(location, ["block", "inspect", "-s", sessionId, blockId, "--json"], runner, "block inspect"),
	);
	return stringField(asRecord(parsed?.block), "window_id");
}

export interface ProgramStatusRecord {
	id?: string;
	state?: string;
	kind?: string;
	msg?: string;
	app?: string;
}

/** Read the terminal's OSC 7501 records (the tab/session attention indicator). */
export async function readProgramStatus(
	location: RexLocation,
	sessionId: string,
	blockId: string,
	runner: CommandRunner = defaultRunner,
): Promise<ProgramStatusRecord[]> {
	const result = await runRex(location, ["block", "call", "-s", sessionId, "-b", blockId, "program_status"], runner);
	if (result.code !== 0) return [];
	const parsed = asRecord(parseJson(result.stdout));
	const records = parsed?.records;
	if (!Array.isArray(records)) return [];
	const output: ProgramStatusRecord[] = [];
	for (const entry of records) {
		const record = asRecord(entry);
		if (!record) continue;
		output.push({
			id: stringField(record, "id"),
			state: stringField(record, "state"),
			kind: stringField(record, "kind"),
			msg: stringField(record, "msg"),
			app: stringField(record, "app"),
		});
	}
	return output;
}

export async function captureBlock(
	location: RexLocation,
	sessionId: string,
	blockId: string,
	runner: CommandRunner = defaultRunner,
): Promise<string> {
	const result = await runRex(location, ["capture", "-s", sessionId, "-b", blockId, "--trim"], runner);
	if (result.code !== 0) return "";
	return result.stdout;
}
