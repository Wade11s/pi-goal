import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function runsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "rex-subagents");
}

export function newHandle(): string {
	return randomBytes(3).toString("hex");
}

export interface RexResources {
	endpoint: string;
	hostId: string;
	sessionId: string;
	windowId: string;
	blockId: string;
}

/** Where the spawning Pi ran, so a child can offer `/back`. */
export interface ParentRexLocation {
	sessionId: string;
	windowId?: string;
	blockId?: string;
}

export type RecordState = "starting" | "running" | "exited" | "stopped" | "failed";

export interface RunRecord {
	version: 1;
	handle: string;
	name: string;
	title?: string;
	group: string;
	cwd: string;
	prompt: string;
	provider?: string;
	model?: string;
	thinking?: string;
	launchArgs: string[];
	parentSessionId?: string;
	parentRex?: ParentRexLocation;
	rex: RexResources;
	state: RecordState;
	error?: string;
	/** Set when a stop attempt could not be confirmed; cleared once it succeeds. */
	stopError?: string;
	/** A live accounting-aware stop must collect a final snapshot before removal. */
	usageFinalizationRequired?: boolean;
	/** A launched child whose spawn baseline failed must not be adopted as unknown history. */
	usageBaselineError?: string;
	createdAt: string;
	updatedAt: string;
}

/** What the child extension reports about the agent's current turn. */
export type SupervisorState = "starting" | "busy" | "idle" | "stopped";

export interface RunStatus {
	state: SupervisorState;
	turn: number;
	/**
	 * Deprecated: the child used to write a hard-coded 0 here, which said
	 * nothing about the OS process. Real exit codes come from the Rex probe
	 * (`RunObservation.processExitCode`). Still parsed for old status files.
	 */
	lastExit?: number | null;
	updatedAt: string;
	transport?: string;
}

/** What the OS-level process behind the Rex window is doing. */
export type ProcessState = "starting" | "running" | "exited" | "gone" | "unknown";

export type DisplayState =
	| "starting"
	| "busy"
	| "idle"
	| "stopping"
	| "exited"
	| "gone"
	| "stopped"
	| "failed"
	| "unknown";

export function isTerminalDisplayState(state: DisplayState): boolean {
	return state === "failed" || state === "stopped" || state === "gone" || state === "exited";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseParentRex(value: unknown): ParentRexLocation | undefined {
	const raw = asRecord(value);
	const sessionId = text(raw?.sessionId);
	if (!sessionId) return undefined;
	const parsed: ParentRexLocation = { sessionId };
	const windowId = text(raw?.windowId);
	const blockId = text(raw?.blockId);
	if (windowId) parsed.windowId = windowId;
	if (blockId) parsed.blockId = blockId;
	return parsed;
}

export function parseRecord(value: unknown): RunRecord | undefined {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return undefined;
	const rex = asRecord(raw.rex);
	const handle = text(raw.handle);
	const name = text(raw.name);
	const cwd = text(raw.cwd);
	const state = text(raw.state);
	const createdAt = text(raw.createdAt);
	const updatedAt = text(raw.updatedAt);
	if (!handle || !name || !cwd || !state || !createdAt || !updatedAt) return undefined;
	if (!["starting", "running", "exited", "stopped", "failed"].includes(state)) return undefined;
	if (!rex) return undefined;
	const endpoint = text(rex.endpoint);
	const hostId = text(rex.hostId);
	const sessionId = typeof rex.sessionId === "string" ? rex.sessionId : undefined;
	const windowId = typeof rex.windowId === "string" ? rex.windowId : undefined;
	const blockId = typeof rex.blockId === "string" ? rex.blockId : undefined;
	if (!endpoint || !hostId || sessionId === undefined || windowId === undefined || blockId === undefined) return undefined;
	if (raw.usageFinalizationRequired !== undefined && typeof raw.usageFinalizationRequired !== "boolean") return undefined;
	if (raw.usageBaselineError !== undefined && typeof raw.usageBaselineError !== "string") return undefined;
	// A staged or failed record may not have Rex resources yet; a live one must.
	if (state !== "starting" && state !== "failed" && !(sessionId && windowId && blockId)) return undefined;
	const launchArgs = Array.isArray(raw.launchArgs)
		? raw.launchArgs.filter((entry): entry is string => typeof entry === "string")
		: [];
	return {
		version: 1,
		handle,
		name,
		title: text(raw.title),
		group: text(raw.group) ?? "rex-subagent",
		cwd,
		prompt: text(raw.prompt) ?? "",
		provider: text(raw.provider),
		model: text(raw.model),
		thinking: text(raw.thinking),
		launchArgs,
		parentSessionId: text(raw.parentSessionId),
		parentRex: parseParentRex(raw.parentRex),
		rex: { endpoint, hostId, sessionId, windowId, blockId },
		state: state as RecordState,
		error: text(raw.error),
		stopError: text(raw.stopError),
		...(raw.usageFinalizationRequired === undefined
			? {}
			: { usageFinalizationRequired: raw.usageFinalizationRequired }),
		usageBaselineError: text(raw.usageBaselineError),
		createdAt,
		updatedAt,
	};
}

export function parseStatus(value: unknown): RunStatus | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;
	const state = text(raw.state);
	if (!state || !["starting", "busy", "idle", "stopped"].includes(state)) return undefined;
	const turn = raw.turn;
	const lastExit = raw.lastExit;
	if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) return undefined;
	if (lastExit !== undefined && lastExit !== null && (typeof lastExit !== "number" || !Number.isInteger(lastExit))) return undefined;
	const transport = text(raw.transport);
	const parsed: RunStatus = { state: state as SupervisorState, turn, updatedAt: text(raw.updatedAt) ?? "" };
	if (lastExit !== undefined) parsed.lastExit = lastExit;
	if (transport) parsed.transport = transport;
	return parsed;
}

export function runDirFor(handle: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(runsRoot(env), handle);
}

const ACCOUNTING_OWNER_FILE = ".accounting-owner.json";

export function accountingOwnerPath(handle: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(runDirFor(handle, env), ACCOUNTING_OWNER_FILE);
}

function readClaimedOwner(dir: string): string | undefined {
	const path = join(dir, ACCOUNTING_OWNER_FILE);
	if (!existsSync(path)) return undefined;
	const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
	if (raw?.version !== 1) throw new Error("invalid accounting owner claim");
	const owner = text(raw.parentSessionId);
	if (!owner) throw new Error("invalid accounting owner claim");
	return owner;
}

/** Atomically claim an unowned run. Existing claims are never overwritten. */
export function claimRecordOwner(handle: string, parentSessionId: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const path = accountingOwnerPath(handle, env);
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	try {
		// Publish only complete content. link(2) provides atomic no-overwrite
		// creation, while EEXIST leaves the existing durable owner untouched.
		writeFileSync(temporary, `${JSON.stringify({ version: 1, parentSessionId })}\n`, { encoding: "utf8", flag: "wx" });
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		return true;
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function ensureRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
	const root = runsRoot(env);
	mkdirSync(root, { recursive: true });
	return root;
}

export function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

export function readRecordFrom(dir: string): RunRecord | undefined {
	const path = join(dir, "metadata.json");
	if (!existsSync(path)) return undefined;
	try {
		const record = parseRecord(JSON.parse(readFileSync(path, "utf8")));
		if (!record) return undefined;
		const claimedOwner = readClaimedOwner(dir);
		if (claimedOwner !== undefined) {
			// Conflicting durable identities are corruption, not permission to
			// choose one. A matching claim overlays older metadata for compatibility.
			if (record.parentSessionId && record.parentSessionId !== claimedOwner) return undefined;
			record.parentSessionId = claimedOwner;
		}
		return record;
	} catch {
		return undefined;
	}
}

export function readRecord(handle: string, env: NodeJS.ProcessEnv = process.env): RunRecord | undefined {
	return readRecordFrom(runDirFor(handle, env));
}

export function writeRecord(record: RunRecord, env: NodeJS.ProcessEnv = process.env): RunRecord {
	const dir = runDirFor(record.handle, env);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "metadata.json"), record);
	return record;
}

export function updateRecord(
	handle: string,
	patch: Partial<RunRecord>,
	env: NodeJS.ProcessEnv = process.env,
): RunRecord | undefined {
	const current = readRecord(handle, env);
	if (!current) return undefined;
	const next: RunRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
	writeRecord(next, env);
	return next;
}

export interface RecordEntry {
	record: RunRecord;
	dir: string;
}

export function listRecords(env: NodeJS.ProcessEnv = process.env): RecordEntry[] {
	const root = runsRoot(env);
	if (!existsSync(root)) return [];
	const entries: RecordEntry[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		const record = readRecordFrom(dir);
		if (record) entries.push({ record, dir });
	}
	return entries.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
}

export function removeRun(handle: string, env: NodeJS.ProcessEnv = process.env): void {
	rmSync(runDirFor(handle, env), { recursive: true, force: true });
}

export function readStatus(dir: string): RunStatus | undefined {
	const path = join(dir, "status.json");
	if (!existsSync(path)) return undefined;
	try {
		return parseStatus(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

export type Delivery = "auto" | "steer" | "followUp";

export interface InboxPayload {
	message: string;
	delivery: Delivery;
}

export function inboxDir(dir: string): string {
	return join(dir, "inbox");
}

export function inboxPath(dir: string, index: number): string {
	return join(inboxDir(dir), `${String(index).padStart(4, "0")}.json`);
}

export function inboxIndexes(dir: string): number[] {
	const path = inboxDir(dir);
	if (!existsSync(path)) return [];
	return readdirSync(path)
		.map((name) => (/^(\d{4})\.json$/.exec(name)?.[1] ?? ""))
		.filter((value) => value.length > 0)
		.map((value) => Number(value))
		.sort((a, b) => a - b);
}

export function parseInboxPayload(value: unknown): InboxPayload | undefined {
	const raw = asRecord(value);
	const message = text(raw?.message);
	if (!message) return undefined;
	const delivery = text(raw?.delivery);
	return {
		message,
		delivery: delivery === "steer" || delivery === "followUp" ? delivery : "auto",
	};
}

export function readInboxMessage(dir: string, index: number): InboxPayload | undefined {
	const path = inboxPath(dir, index);
	if (!existsSync(path)) return undefined;
	try {
		return parseInboxPayload(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

function sequencePath(dir: string): string {
	return join(inboxDir(dir), ".seq");
}

function readSequence(dir: string): number {
	try {
		const value = Number(readFileSync(sequencePath(dir), "utf8").trim());
		return Number.isInteger(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}

const LOCK_NAME = ".lock";
/** A lock older than this is assumed abandoned (crashed holder) and stolen. */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;

/** Thrown inside a critical section that lost its lock to a stale steal. */
export class InboxLockStolen extends Error {
	constructor() {
		super("inbox lock was stolen while held");
		this.name = "InboxLockStolen";
	}
}

function readLockToken(lockPath: string): string | undefined {
	try {
		return readFileSync(lockPath, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Serialize "allocate index + publish message" across processes. Atomic renames
 * make each file appear whole, but without the lock two concurrent senders
 * could compute the same index and one rename would silently overwrite the
 * other's message.
 *
 * Ownership: the lock file holds a unique token. A holder whose lock was stolen
 * (because it looked stale) neither releases the successor's lock nor publishes
 * under it: `owns()` re-reads the token before the critical section commits, and
 * a stolen holder raises {@link InboxLockStolen} so the allocation restarts.
 * This narrows the steal hazard to the verify-to-rename gap, and only for a
 * holder that already looked 10 s stale.
 */
export async function withInboxLock<T>(
	critical: (owns: () => boolean) => T,
	dir: string,
	waitMs: number,
): Promise<T> {
	mkdirSync(inboxDir(dir), { recursive: true });
	const lockPath = join(inboxDir(dir), LOCK_NAME);
	const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + waitMs;
	for (;;) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Held by someone else: wait, or steal it once it looks abandoned.
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lockPath);
				} else if (Date.now() >= deadline) {
					throw new Error(`inbox lock busy: ${lockPath}`);
				} else {
					await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
				}
			} catch (inner) {
				if (inner instanceof Error && inner.message.startsWith("inbox lock busy")) throw inner;
				// Only a vanished lock (ENOENT) may be retried immediately;
				// anything else (e.g. EACCES) must surface instead of busy-looping.
				if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
			}
			continue;
		}
		const owns = (): boolean => readLockToken(lockPath) === token;
		try {
			writeSync(fd, `${token}\n`);
			return critical(owns);
		} catch (error) {
			if (error instanceof InboxLockStolen) continue; // restart the allocation
			throw error;
		} finally {
			closeSync(fd);
			// Never release a lock that was stolen from us: it belongs to a successor.
			if (owns()) {
				try {
					unlinkSync(lockPath);
				} catch {
					// Already gone.
				}
			}
		}
	}
}

/**
 * Write one message so the runner never observes a partial file. The counter is
 * persisted because consumed messages disappear; numbering must stay monotonic.
 * The inbox lock makes concurrent senders pick distinct indexes instead of
 * racing to the same file name.
 */
export async function queueMessage(
	dir: string,
	message: string,
	delivery: Delivery = "auto",
	options: { lockWaitMs?: number } = {},
): Promise<number> {
	return withInboxLock(
		(owns) => {
			const indexes = inboxIndexes(dir);
			const last = indexes[indexes.length - 1] ?? 0;
			let index = Math.max(last, readSequence(dir)) + 1;
			// Belt and braces against crash leftovers; under the lock nothing
			// else allocates, so this loop cannot spin.
			let path = inboxPath(dir, index);
			while (existsSync(path)) {
				index += 1;
				path = inboxPath(dir, index);
			}
			const temporary = `${path}.tmp-${process.pid}`;
			writeFileSync(temporary, `${JSON.stringify({ message, delivery })}\n`, "utf8");
			// Our lock may have been stolen as stale while we worked; publishing
			// now could collide with the successor's allocation. Restart instead.
			if (!owns()) {
				try {
					unlinkSync(temporary);
				} catch {
					// Best effort; a leftover tmp file is never read as a message.
				}
				throw new InboxLockStolen();
			}
			renameSync(temporary, path);
			writeFileSync(sequencePath(dir), String(index), "utf8");
			return index;
		},
		dir,
		options.lockWaitMs ?? 5_000,
	);
}

export function readTranscript(dir: string): string {
	const path = join(dir, "transcript.log");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The part of a Rex probe that the state machine needs. */
export interface RunProbe {
	state: "running" | "exited" | "missing" | "unknown";
	exitCode?: number;
}

/** Agent-turn state and OS-process state, merged for display. */
export interface RunObservation {
	state: DisplayState;
	processState: ProcessState;
	processExitCode: number | null;
}

function agentTurnDisplay(record: RunRecord, status: RunStatus | undefined): DisplayState {
	if (status?.state === "busy") return "busy";
	if (status?.state === "idle") return "idle";
	// The child saw the stop sentinel and aborted its turn — that alone is not
	// a confirmed stop: while the process lives the run is merely "stopping".
	if (status?.state === "stopped") return "stopping";
	// No status file yet: the child has not booted far enough to write one.
	return "starting";
}

/**
 * Merge durable metadata, the child's turn status and the Rex process probe.
 *
 * Precedence (first match wins) — see ARCHITECTURE.md:
 *  1. record failed  → the launch never produced a manageable process.
 *  2. record stopped → stop was confirmed; closed resources are expected.
 *  3. probe missing  → the Rex resources are gone.
 *  4. probe exited   → the OS process ended; terminal, with its real exit code,
 *                      even when a stale status.json still claims busy/idle.
 *                      If the child had acknowledged a stop, this counts as a
 *                      completed stop instead of an incidental exit.
 *  5. probe unknown  → Rex is unreachable; report the last busy signal, or
 *      "starting" while the record is still starting without any status.
 *  6. otherwise the agent-turn state from status.json decides; a child that
 *      acknowledged the stop sentinel while the process lives is "stopping",
 *      not stopped — the stop is not confirmed until the process ends or Rex
 *      confirms the close.
 */
export function observeRun(record: RunRecord, status: RunStatus | undefined, probe: RunProbe | undefined): RunObservation {
	if (record.state === "failed") return { state: "failed", processState: "gone", processExitCode: null };
	if (record.state === "stopped") return { state: "stopped", processState: "gone", processExitCode: null };
	if (!probe) {
		if (record.state === "exited") return { state: "exited", processState: "exited", processExitCode: null };
		return { state: agentTurnDisplay(record, status), processState: "unknown", processExitCode: null };
	}
	if (probe.state === "missing") return { state: "gone", processState: "gone", processExitCode: null };
	if (probe.state === "exited") {
		// The child acknowledged a stop and then the process ended: that is a
		// completed stop (with the real exit code), not an incidental crash.
		if (status?.state === "stopped") {
			return { state: "stopped", processState: "exited", processExitCode: probe.exitCode ?? null };
		}
		return { state: "exited", processState: "exited", processExitCode: probe.exitCode ?? null };
	}
	if (probe.state === "unknown") {
		if (record.state === "starting" && !status) return { state: "starting", processState: "unknown", processExitCode: null };
		// The child acknowledged the stop even though Rex cannot be probed:
		// it is shutting down and will not drain anything — keep refusing sends.
		if (status?.state === "stopped") return { state: "stopping", processState: "unknown", processExitCode: null };
		return { state: status?.state === "busy" ? "busy" : "unknown", processState: "unknown", processExitCode: null };
	}
	return { state: agentTurnDisplay(record, status), processState: "running", processExitCode: null };
}
