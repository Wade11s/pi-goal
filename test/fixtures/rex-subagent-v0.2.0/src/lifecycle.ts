import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	closeWindow,
	defaultRunner,
	discoverRex,
	killSession,
	listApps,
	listSessions,
	listWindows,
	probeBlock,
	readProgramStatus,
	selectSession,
	validateRex,
	DEFAULT_TIMEOUT_MS,
	type CommandRunner,
	type ProbeResult,
	type ProgramStatusRecord,
	type RexLocation,
} from "./rex.ts";
import { watchRexEvents, type RexBlockEvent, type RexEventSubscription, type WatchRexEvents } from "./rex-events.ts";
import { transcriptFromSession } from "./session-log.ts";
import { reconcileSetup, type SetupReport } from "./setup.ts";
import {
	inboxIndexes,
	listRecords,
	queueMessage,
	readRecord,
	readStatus,
	readTranscript,
	removeRun,
	runDirFor,
	updateRecord,
	observeRun,
	type Delivery,
	type DisplayState,
	type ProcessState,
	type RunObservation,
	type RunRecord,
	type RunStatus,
	type SupervisorState,
} from "./record.ts";

export interface Deps {
	runner?: CommandRunner;
	env?: NodeJS.ProcessEnv;
}

export class LifecycleError extends Error {}

export interface RunView {
	handle: string;
	name: string;
	group: string;
	/** Merged display state (agent turn + OS process); see ARCHITECTURE.md. */
	state: DisplayState;
	/** What the child's status.json says about the current turn, if anything. */
	agentState?: SupervisorState;
	/** What the OS-level process is doing. */
	processState: ProcessState;
	/** Real OS exit code, from the Rex probe; null while the process lives. */
	processExitCode: number | null;
	turn: number;
	provider?: string;
	model?: string;
	thinking?: string;
	cwd: string;
	sessionId: string;
	windowId: string;
	blockId: string;
	error?: string;
	/** Set when the last stop attempt could not be confirmed; retry the stop. */
	stopError?: string;
	detail?: string;
	record: RunRecord;
	status?: RunStatus;
}

function view(record: RunRecord, observation: RunObservation, status?: RunStatus, detail?: string): RunView {
	return {
		handle: record.handle,
		name: record.name,
		group: record.group,
		state: observation.state,
		agentState: status?.state,
		processState: observation.processState,
		processExitCode: observation.processExitCode,
		turn: status?.turn ?? 0,
		provider: record.provider,
		model: record.model,
		thinking: record.thinking,
		cwd: record.cwd,
		sessionId: record.rex.sessionId,
		windowId: record.rex.windowId,
		blockId: record.rex.blockId,
		error: record.error,
		stopError: record.stopError,
		detail,
		record,
		status,
	};
}

/** Trust only the pinned server the run was launched on. */
export async function pinnedLocation(record: RunRecord, deps: Deps = {}): Promise<RexLocation> {
	const runner = deps.runner ?? defaultRunner;
	try {
		return await validateRex({ endpoint: record.rex.endpoint, hostId: record.rex.hostId }, runner);
	} catch (error) {
		throw new LifecycleError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * validateRex costs one `rex whoami` per call. Batch operations would repeat it
 * for every run on the same server, so cache the validation briefly per runner.
 * Mutating operations (stop, open) still use the uncached pinnedLocation.
 */
const LOCATION_TTL_MS = 10_000;
const locationCache = new WeakMap<CommandRunner, Map<string, { location: Promise<RexLocation>; at: number }>>();

async function pinnedLocationCached(record: RunRecord, deps: Deps = {}): Promise<RexLocation> {
	const runner = deps.runner ?? defaultRunner;
	const key = `${record.rex.endpoint}|${record.rex.hostId}`;
	let cache = locationCache.get(runner);
	if (!cache) {
		cache = new Map();
		locationCache.set(runner, cache);
	}
	const now = Date.now();
	const hit = cache.get(key);
	// Cache the promise itself so concurrently starting probes share one whoami.
	if (hit && now - hit.at < LOCATION_TTL_MS) return hit.location;
	const location = pinnedLocation(record, deps);
	cache.set(key, { location, at: now });
	// Do not cache failures: let the next call retry the validation.
	location.catch(() => {
		const current = cache.get(key);
		if (current && current.location === location) cache.delete(key);
	});
	return location;
}

export async function describeRun(
	handle: string,
	deps: Deps = {},
	options: { probe?: boolean } = {},
): Promise<RunView> {
	const env = deps.env ?? process.env;
	const record = readRecord(handle, env);
	if (!record) throw new LifecycleError(`no rex subagent with handle ${handle}`);
	const dir = runDirFor(handle, env);
	const status = readStatus(dir);
	if (record.state === "failed") return view(record, observeRun(record, status, undefined), status, record.error);
	if (!record.rex.sessionId) {
		return view(record, observeRun(record, status, undefined), status, "launch never published Rex resources");
	}
	if (options.probe === false) {
		// Cheap read for widgets: trust the supervisor's status file and skip Rex.
		return view(record, observeRun(record, status, undefined), status);
	}

	let probe: ProbeResult;
	try {
		const location = await pinnedLocationCached(record, deps);
		probe = await probeBlock(location, record.rex.sessionId, record.rex.blockId, deps.runner ?? defaultRunner);
	} catch (error) {
		probe = { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
	}
	return view(record, observeRun(record, status, probe), status, probe.detail);
}

/** Run an async map with bounded concurrency, preserving input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await fn(items[index] as T);
		}
	});
	await Promise.all(workers);
	return results;
}

const PROBE_CONCURRENCY = 6;

export async function listRuns(
	deps: Deps = {},
	filter: { parentSessionId?: string } = {},
	options: { probe?: boolean } = {},
): Promise<RunView[]> {
	const env = deps.env ?? process.env;
	const records = listRecords(env)
		.map((entry) => entry.record)
		.filter((record) => !filter.parentSessionId || record.parentSessionId === filter.parentSessionId);
	return mapLimited(records, PROBE_CONCURRENCY, async (record) => {
		try {
			return await describeRun(record.handle, deps, options);
		} catch {
			return view(record, { state: "failed", processState: "gone", processExitCode: null }, undefined, "metadata unreadable");
		}
	});
}

export type WaitOutcome = "idle" | "stopped" | "exited" | "gone" | "failed" | "blocked" | "error" | "timeout";

export interface WaitResult {
	handle: string;
	outcome: WaitOutcome;
	state: DisplayState;
	agentState?: SupervisorState;
	turn: number;
	processExitCode: number | null;
	/** Messages still waiting in the inbox when the run settled, if any. */
	pendingMessages?: number;
	/** Pi's blocked reason or latest error, when Rex reported one. */
	detail?: string;
}

export interface WaitOptions {
	timeoutMs?: number;
	/** Polling interval for all mode, or snapshot fallback interval for any mode. */
	pollMs?: number;
	mode?: "all" | "any";
}

export interface WaitDeps extends Deps {
	watchEvents?: WatchRexEvents;
}

function settled(view: RunView): WaitOutcome | undefined {
	if (view.state === "idle") return "idle";
	if (view.state === "stopped") return "stopped";
	// A dead process is terminal, even mid-turn or before the first turn.
	if (view.state === "exited") return "exited";
	if (view.state === "gone") return "gone";
	if (view.state === "failed") return "failed";
	// "stopping" is deliberately absent: an unconfirmed stop with a live
	// process is not a terminal state; wait until the process really ends.
	return undefined;
}

/** A wait result counts as success only if the queued turns truly finished. */
export function waitOutcomeOk(result: WaitResult): boolean {
	if (result.outcome === "idle" || result.outcome === "stopped") return true;
	if (result.outcome === "exited") {
		// Exit code 0 alone proves nothing: the TUI may have been closed (or Pi
		// died during startup) before the first turn ran. The work counts as
		// finished only when a turn actually completed and nothing is queued.
		return (
				result.processExitCode === 0 &&
				result.agentState === "idle" &&
				result.turn > 0 &&
				(result.pendingMessages ?? 0) === 0
		);
	}
	return false;
}

/**
 * Bound every Rex call inside a wait loop by the remaining wall-clock budget, so
 * one slow probe cannot run far past the deadline.
 */
function deadlineRunner(runner: CommandRunner, deadline: number): CommandRunner {
	return {
		run(command, args, options = {}) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return Promise.resolve({ code: -1, stdout: "", stderr: "wait deadline exceeded", timedOut: true });
			}
			const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining);
			return runner.run(command, args, { ...options, timeoutMs });
		},
	};
}

interface AnyObservation {
	handle: string;
	view?: RunView;
	program?: ProgramStatusRecord;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function eventProgramState(event: RexBlockEvent): string | undefined {
	const state = objectValue(objectValue(event.payload)?.record)?.state;
	return typeof state === "string" ? state : undefined;
}

async function observeAny(handle: string, deps: WaitDeps): Promise<AnyObservation> {
	try {
		const current = await describeRun(handle, deps);
		let program: ProgramStatusRecord | undefined;
		if (
			current.record.rex.sessionId &&
			current.processState !== "exited" &&
			current.processState !== "gone" &&
			current.state !== "failed" &&
			current.state !== "stopped"
		) {
			const records = await readProgramStatus(
				{ endpoint: current.record.rex.endpoint, hostId: current.record.rex.hostId },
				current.record.rex.sessionId,
				current.record.rex.blockId,
				deps.runner ?? defaultRunner,
			);
			// Pi reports on the root record. Ignore nested records from other programs.
			program = records.find((record) => !record.id);
		}
		return { handle, view: current, program };
	} catch {
		return { handle };
	}
}

function anyResult(observation: AnyObservation, env: NodeJS.ProcessEnv): WaitResult | undefined {
	const current = observation.view;
	if (!current) {
		return { handle: observation.handle, outcome: "failed", state: "failed", turn: 0, processExitCode: null };
	}
	const queued = inboxIndexes(runDirFor(observation.handle, env)).length;
	const normal = current.state === "idle" && (current.turn === 0 || queued > 0) ? undefined : settled(current);
	const base = {
		handle: observation.handle,
		state: current.state,
		agentState: current.agentState,
		turn: current.turn,
		processExitCode: current.processExitCode,
	};
	// A real terminal state takes precedence over a stale OSC status record.
	if (normal && normal !== "idle") {
		const result: WaitResult = { ...base, outcome: normal };
		if (normal === "exited" && queued > 0) result.pendingMessages = queued;
		return result;
	}
	const program = observation.program;
	if (program?.state === "blocked" || program?.state === "error") {
		const detail = [program.kind, program.msg].filter(Boolean).join(": ");
		return { ...base, outcome: program.state, ...(detail ? { detail } : {}) };
	}
	return normal ? { ...base, outcome: normal } : undefined;
}

/** Wait for the first settled or attention-worthy run, using Rex events as wakeups. */
async function waitRunsAny(handles: string[], options: WaitOptions, deps: WaitDeps): Promise<WaitResult[]> {
	const timeoutMs = options.timeoutMs ?? 0;
	const fallbackPollMs = options.pollMs ?? 2000;
	const env = deps.env ?? process.env;
	const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : Number.POSITIVE_INFINITY);
	const bounded: WaitDeps = { ...deps, runner: deadlineRunner(deps.runner ?? defaultRunner, deadline) };
	const pending = new Set(handles);
	const latest = new Map<string, RunView>();
	const subscriptions: RexEventSubscription[] = [];
	const retryTimers = new Set<ReturnType<typeof setTimeout>>();
	let wake: (() => void) | undefined;
	let eventVersion = 0;
	const signal = (): void => {
		eventVersion += 1;
		wake?.();
	};

	// Start subscriptions before the first snapshot. A second snapshot or the
	// slow fallback covers reports missed while a stream is being established.
	const groups = new Map<string, { location: RexLocation; sessionId: string }>();
	const handlesByBlock = new Map<string, string>();
	for (const handle of handles) {
		const record = readRecord(handle, env);
		if (!record?.rex.sessionId) continue;
		const groupKey = `${record.rex.endpoint}|${record.rex.sessionId}`;
		groups.set(groupKey, {
			location: { endpoint: record.rex.endpoint, hostId: record.rex.hostId },
			sessionId: record.rex.sessionId,
		});
		handlesByBlock.set(`${groupKey}|${record.rex.blockId}`, handle);
	}
	const handleForEvent = (event: RexBlockEvent, endpoint: string): string | undefined =>
		handlesByBlock.get(`${endpoint}|${event.sessionId}|${event.blockId}`);
	const watcher = deps.watchEvents ?? watchRexEvents;
	for (const group of groups.values()) {
		try {
			subscriptions.push(
				watcher(group.location, group.sessionId, {
					onEvent(event) {
						const handle = handleForEvent(event, group.location.endpoint);
						if (!handle || !pending.has(handle)) return;
						if (event.name === "child_exited") {
							signal();
							return;
						}
						if (event.name !== "program_status_changed") return;
						const state = eventProgramState(event);
						if (!state || !["done", "idle", "blocked", "error"].includes(state)) return;
						signal();
						if (state === "done" || state === "idle") {
							// Pi's OSC report and the child extension's status rename are
							// separate operations; retry once if the report arrived first.
							const timer = setTimeout(() => {
								retryTimers.delete(timer);
								signal();
							}, 25);
							retryTimers.add(timer);
						}
					},
					onClose: signal,
				}),
			);
		} catch {
			// Snapshot polling below remains sufficient when events are unavailable.
		}
	}

	try {
		while (pending.size > 0) {
			if (Date.now() >= deadline) break;
			const observedVersion = eventVersion;
			const observations = await mapLimited([...pending], PROBE_CONCURRENCY, (handle) => observeAny(handle, bounded));
			const results = new Map<string, WaitResult>();
			for (const observation of observations) {
				if (observation.view) latest.set(observation.handle, observation.view);
				const result = anyResult(observation, env);
				if (!result) continue;
				pending.delete(observation.handle);
				results.set(observation.handle, result);
			}
			if (results.size > 0) {
				return handles.filter((handle) => results.has(handle)).map((handle) => results.get(handle) as WaitResult);
			}
			if (pending.size === 0) break;
			if (Date.now() >= deadline) break;
			if (eventVersion !== observedVersion) continue;
			const remaining = deadline - Date.now();
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(fallbackPollMs, Math.max(1, remaining)));
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			wake = undefined;
		}
		return [...pending].map((handle) => {
			const last = latest.get(handle);
			return {
				handle,
				outcome: "timeout",
				state: last?.state ?? "starting",
				agentState: last?.agentState,
				turn: last?.turn ?? 0,
				processExitCode: last?.processExitCode ?? null,
			};
		});
	} finally {
		for (const subscription of subscriptions) subscription.close();
		for (const timer of retryTimers) clearTimeout(timer);
	}
}

/** Wait until every run finishes its queued turns (or the deadline passes). */
export async function waitRuns(handles: string[], options: WaitOptions = {}, deps: WaitDeps = {}): Promise<WaitResult[]> {
	if (options.mode === "any") return waitRunsAny(handles, options, deps);
	const timeoutMs = options.timeoutMs ?? 0;
	const pollMs = options.pollMs ?? 400;
	const env = deps.env ?? process.env;
	const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : Number.POSITIVE_INFINITY);
	const bounded: Deps = { ...deps, runner: deadlineRunner(deps.runner ?? defaultRunner, deadline) };
	const pending = new Set(handles);
	const results = new Map<string, WaitResult>();
	const latest = new Map<string, RunView>();

	const timeoutPending = (): void => {
		for (const handle of pending) {
			const last = latest.get(handle);
			results.set(handle, {
				handle,
				outcome: "timeout",
				state: last?.state ?? "starting",
				agentState: last?.agentState,
				turn: last?.turn ?? 0,
				processExitCode: last?.processExitCode ?? null,
			});
		}
		pending.clear();
	};

	while (pending.size > 0) {
		if (Date.now() >= deadline) {
			timeoutPending();
			break;
		}
		const views = await mapLimited([...pending], PROBE_CONCURRENCY, async (handle) => {
			try {
				return { handle, view: await describeRun(handle, bounded) };
			} catch {
				return { handle, view: undefined };
			}
		});
		for (const entry of views) {
			if (!entry.view) {
				pending.delete(entry.handle);
				results.set(entry.handle, {
					handle: entry.handle,
					outcome: "failed",
					state: "failed",
					turn: 0,
					processExitCode: null,
				});
				continue;
			}
			const current = entry.view;
			latest.set(entry.handle, current);
			// An idle supervisor that has not finished its first turn is still
			// starting; an idle supervisor with queued messages has not finished
			// the requested work either — it will pick them up within a tick.
			const queued = inboxIndexes(runDirFor(entry.handle, env)).length;
			const outcome = current.state === "idle" && (current.turn === 0 || queued > 0) ? undefined : settled(current);
			if (!outcome) continue;
			pending.delete(entry.handle);
			const result: WaitResult = {
				handle: entry.handle,
				outcome,
				state: current.state,
				agentState: current.agentState,
				turn: current.turn,
				processExitCode: current.processExitCode,
			};
			if (outcome === "exited" && queued > 0) result.pendingMessages = queued;
			results.set(entry.handle, result);
		}
		if (pending.size === 0) break;
		if (Date.now() >= deadline) {
			timeoutPending();
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
	}
	return handles.map(
		(handle) =>
			results.get(handle) ?? {
				handle,
				outcome: "failed" as WaitOutcome,
				state: "failed" as DisplayState,
				turn: 0,
				processExitCode: null,
			},
	);
}

export interface SendResult {
	/** Inbox message number; not the agent's delivered-turn count. */
	message: number;
	delivery: Delivery;
	queuedBehindRunningTurn: boolean;
	/**
	 * False when the process state could not be confirmed (Rex unreachable or
	 * still starting): the message waits in the local inbox and is delivered
	 * only if the child turns out to be alive.
	 */
	unconfirmed: boolean;
}

/**
 * Queue one message for the supervisor. A busy run picks it up after the
 * current turn; an idle run starts a new turn immediately. Runs whose process
 * is provably dead are rejected: nothing would ever consume the message.
 */
export async function sendMessage(
	handle: string,
	message: string,
	options: { delivery?: Delivery } = {},
	deps: Deps = {},
): Promise<SendResult> {
	const env = deps.env ?? process.env;
	const record = readRecord(handle, env);
	if (!record) throw new LifecycleError(`no rex subagent with handle ${handle}`);
	if (!message.trim()) throw new LifecycleError("message is empty");
	if (record.state === "failed") throw new LifecycleError(`run ${handle} failed to launch: ${record.error ?? "unknown error"}`);
	if (record.state === "stopped") throw new LifecycleError(`run ${handle} is stopped; spawn a new run instead`);
	if (record.state === "exited") throw new LifecycleError(`run ${handle} already exited; spawn a new run instead`);

	const current = record.rex.sessionId ? await describeRun(handle, deps).catch(() => undefined) : undefined;
	if (current && ["exited", "gone", "stopped", "failed", "stopping"].includes(current.state)) {
		throw new LifecycleError(
			`run ${handle} is ${current.state} (${current.detail ?? "nothing would consume the message"}); spawn a new run instead`,
		);
	}
	const dir = runDirFor(handle, env);
	const delivery = options.delivery ?? "auto";
	const queued = await queueMessage(dir, message, delivery);
	const busy = current?.state === "busy";
	return {
		message: queued,
		delivery,
		queuedBehindRunningTurn: busy && delivery !== "steer",
		unconfirmed: current?.processState !== "running",
	};
}

export interface StopOptions {
	remove?: boolean;
	killSession?: boolean;
	/** Accounting-aware callers use this to let the child publish before close. */
	beforeClose?: () => Promise<void>;
}

export interface StopResult {
	handle: string;
	stopped: boolean;
	removed: boolean;
	detail?: string;
}

/**
 * Stop one run: stop sentinel first, then close only the owned window. The
 * record is marked stopped (and may be removed) only once Rex confirmed the
 * close — or a follow-up probe proved the resources no longer exist. On
 * failure the record keeps its state and gains a `stopError`, so the stop can
 * simply be retried.
 */
export async function stopRun(
	handle: string,
	options: StopOptions = {},
	deps: Deps = {},
): Promise<StopResult> {
	const env = deps.env ?? process.env;
	const record = readRecord(handle, env);
	if (!record) throw new LifecycleError(`no rex subagent with handle ${handle}`);
	const dir = runDirFor(handle, env);
	// The sentinel is local: even if Rex is unreachable, a live child sees it,
	// aborts and exits. It never justifies deleting the record, though.
	writeFileSync(join(dir, "stop"), "");

	let finalizationError: string | undefined;
	try {
		await options.beforeClose?.();
	} catch (error) {
		// The lifecycle stop still proceeds for safety. The error prevents
		// accounting-aware removal and remains visible to the caller.
		finalizationError = error instanceof Error ? error.message : String(error);
	}

	let unconfirmed: string | undefined;
	if (record.rex.sessionId) {
		const runner = deps.runner ?? defaultRunner;
		try {
			const location = await pinnedLocation(record, deps);
			try {
				const windows = await listWindows(location, record.rex.sessionId, runner);
				// Do not take the whole batch session down when siblings still run.
				const soleWindow = windows.length <= 1 || windows.every((window) => window.windowId === record.rex.windowId);
				if (options.killSession || soleWindow) await killSession(location, record.rex.sessionId, runner);
				else await closeWindow(location, record.rex.sessionId, record.rex.windowId, runner);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// The command may have timed out client-side yet still executed on
				// the server; confirm with a probe before declaring failure.
				let confirmed = false;
				try {
					const probe = await probeBlock(location, record.rex.sessionId, record.rex.blockId, runner);
					confirmed = probe.state === "missing";
				} catch {
					// The confirming probe failed too; treat as unconfirmed.
				}
				if (!confirmed) unconfirmed = message;
			}
		} catch (error) {
			unconfirmed = error instanceof Error ? error.message : String(error);
		}
	}

	if (unconfirmed !== undefined) {
		updateRecord(handle, { stopError: unconfirmed }, env);
		const detail = [finalizationError, unconfirmed].filter(Boolean).join("; ");
		return { handle, stopped: false, removed: false, detail };
	}
	updateRecord(handle, { state: "stopped", stopError: undefined }, env);
	const removed = options.remove === true && finalizationError === undefined;
	if (removed) removeRun(handle, env);
	return { handle, stopped: true, removed, ...(finalizationError ? { detail: finalizationError } : {}) };
}

export interface OpenResult {
	sessionId: string;
	windowId: string;
	clientId: string;
}

/** Show a run in a connected Rex app instead of attaching to a terminal. */
export async function openRun(handle: string, options: { clientId?: string } = {}, deps: Deps = {}): Promise<OpenResult> {
	const env = deps.env ?? process.env;
	const record = readRecord(handle, env);
	if (!record) throw new LifecycleError(`no rex subagent with handle ${handle}`);
	if (!record.rex.sessionId) throw new LifecycleError(`run ${handle} has no Rex resources to show`);
	const location = await pinnedLocation(record, deps);
	const runner = deps.runner ?? defaultRunner;
	let clientId = options.clientId;
	if (!clientId) {
		const apps = await listApps(location, runner);
		if (apps.length === 0) throw new LifecycleError("no Rex app is connected; open Rex, then try again");
		if (apps.length > 1) {
			throw new LifecycleError(`multiple Rex apps are connected (${apps.map((app) => app.label).join(", ")}); pass --client`);
		}
		const only = apps[0];
		if (!only) throw new LifecycleError("no Rex app is connected; open Rex, then try again");
		clientId = only.clientId;
	}
	await selectSession(location, record.rex.sessionId, record.rex.windowId, runner, clientId);
	return { sessionId: record.rex.sessionId, windowId: record.rex.windowId, clientId };
}

export function readLog(handle: string, options: { tail?: number } = {}, env: NodeJS.ProcessEnv = process.env): string {
	const dir = runDirFor(handle, env);
	return transcriptFromSession(join(dir, "sessions"), { tailLines: options.tail });
}

export interface PruneResult {
	removed: string[];
	kept: number;
}

/** A starting record without resources is only prunable after this grace. */
const STARTING_GRACE_MS = 5 * 60_000;

/** Remove records whose Rex window is already gone. Never removes a live run. */
export async function pruneRuns(deps: Deps = {}): Promise<PruneResult> {
	const env = deps.env ?? process.env;
	const removed: string[] = [];
	let kept = 0;
	for (const entry of listRecords(env)) {
		if (!entry.record.rex.sessionId) {
			// spawn writes this record before the Rex window exists; a concurrent
			// prune must not delete a launch that is still in progress.
			const createdAt = Date.parse(entry.record.createdAt);
			const stillStarting = entry.record.state === "starting" && Number.isFinite(createdAt) && Date.now() - createdAt < STARTING_GRACE_MS;
			if (stillStarting) {
				kept += 1;
				continue;
			}
			removed.push(entry.record.handle);
			removeRun(entry.record.handle, env);
			continue;
		}
		const current = await describeRun(entry.record.handle, deps).catch(() => undefined);
		const state = current?.state ?? "unknown";
		if (state === "gone" || state === "stopped") {
			removed.push(entry.record.handle);
			removeRun(entry.record.handle, env);
		} else kept += 1;
	}
	return { removed, kept };
}

export interface DoctorReport {
	endpoint: string;
	hostId: string;
	version?: string;
	sessions: number;
	runs: number;
	apps: string[];
	setup: SetupReport;
}

export async function doctor(deps: Deps = {}): Promise<DoctorReport> {
	const env = deps.env ?? process.env;
	const runner = deps.runner ?? defaultRunner;
	const location = await discoverRex(runner, env);
	const apps = await listApps(location, runner);
	const sessions = await listSessions(location, runner);
	const setup = await reconcileSetup({ repair: false, env, runner });
	return {
		endpoint: location.endpoint,
		hostId: location.hostId,
		version: location.version,
		sessions: sessions.length,
		runs: listRecords(env).length,
		apps: apps.map((app) => app.label),
		setup,
	};
}

export { readTranscript };
