import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { claimRecordOwner, readRecord, runDirFor, type RunRecord } from "./record.ts";
import { addUsage, parseUsage, readUsageSnapshot, zeroUsage, type UsageSnapshot } from "./usage.ts";

export const ACCOUNTING_DETAILS_VERSION = 1;

export type AccountingKind = "spawn" | "adoption" | "observation";

export interface RunCursor {
	handle: string;
	childSessionId: string | null;
	generation: string | null;
	sequence: number;
	cumulative: Usage;
	final: boolean;
	/** A terminal stop collected a durable non-final snapshot after finalization became impossible. */
	finalization?: "unconfirmed";
	/** A terminal owned run had no snapshot; zero is bookkeeping, not a claim about unknown history. */
	snapshot?: "missing";
	/** True only while this cursor is the exact unowned adoption baseline. */
	unownedAdoption?: true;
}

export interface AccountingDetails {
	version: 1;
	kind: AccountingKind;
	parentSessionId: string;
	runs: RunCursor[];
}

export interface Observation {
	details: AccountingDetails;
	usage?: Usage;
}

export class AccountingError extends Error {}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseCursor(value: unknown, kind: AccountingKind): RunCursor {
	const raw = objectValue(value);
	if (!raw || typeof raw.handle !== "string" || raw.handle.length === 0 || typeof raw.final !== "boolean") {
		throw new AccountingError("invalid accounting cursor in parent tool result");
	}
	if (!Number.isInteger(raw.sequence) || (raw.sequence as number) < 0) throw new AccountingError("invalid accounting cursor sequence");
	if (raw.finalization !== undefined && raw.finalization !== "unconfirmed") {
		throw new AccountingError("invalid accounting cursor finalization diagnostic");
	}
	if (raw.snapshot !== undefined && raw.snapshot !== "missing") {
		throw new AccountingError("invalid accounting cursor snapshot diagnostic");
	}
	if (raw.final === true && raw.finalization !== undefined) {
		throw new AccountingError("a final accounting cursor cannot have unconfirmed finalization");
	}
	if (raw.unownedAdoption !== undefined && raw.unownedAdoption !== true) {
		throw new AccountingError("invalid accounting cursor unowned-adoption marker");
	}
	const generation = raw.generation;
	if (generation !== null && (typeof generation !== "string" || generation.length === 0)) {
		throw new AccountingError("invalid accounting cursor generation");
	}
	const childSessionId = raw.childSessionId;
	if (childSessionId !== null && (typeof childSessionId !== "string" || childSessionId.length === 0)) {
		throw new AccountingError("invalid accounting cursor child session");
	}
	const cursor: RunCursor = {
		handle: raw.handle,
		childSessionId: childSessionId as string | null,
		generation: generation as string | null,
		sequence: raw.sequence as number,
		cumulative: parseUsage(raw.cumulative),
		final: raw.final,
		...(raw.finalization === "unconfirmed" ? { finalization: "unconfirmed" as const } : {}),
		...(raw.snapshot === "missing" ? { snapshot: "missing" as const } : {}),
		...(raw.unownedAdoption === true ? { unownedAdoption: true as const } : {}),
	};
	if (kind === "spawn") {
		if (
			cursor.childSessionId !== null ||
			cursor.generation !== null ||
			cursor.sequence !== 0 ||
			cursor.final ||
			cursor.finalization ||
			cursor.snapshot ||
			cursor.unownedAdoption ||
			!isZeroUsage(cursor.cumulative)
		) {
			throw new AccountingError("invalid spawn baseline in parent tool result");
		}
	} else if (cursor.snapshot === "missing") {
		if (
			kind !== "observation" ||
			cursor.childSessionId !== null ||
			cursor.generation !== null ||
			cursor.sequence !== 0 ||
			cursor.final ||
			cursor.finalization !== "unconfirmed" ||
			cursor.unownedAdoption ||
			!isZeroUsage(cursor.cumulative)
		) {
			throw new AccountingError("invalid missing-snapshot cursor in parent tool result");
		}
	} else if (cursor.childSessionId === null || cursor.generation === null || cursor.sequence < 1) {
		throw new AccountingError("invalid non-spawn cursor in parent tool result");
	}
	return cursor;
}

const REX_ACCOUNTING_TOOLS = ["rex_spawn", "rex_adopt", "rex_observe", "rex_wait", "rex_stop"];

function accountingKindForTool(toolName: string): AccountingKind {
	if (toolName === "rex_spawn") return "spawn";
	if (toolName === "rex_adopt") return "adoption";
	return "observation";
}

/** Best-effort run handle a raw cursor entry mentions, for diagnostics. */
function rawCursorHandle(value: unknown): string | undefined {
	const handle = objectValue(value)?.handle;
	return typeof handle === "string" && handle.length > 0 ? handle : undefined;
}

/** Best-effort run handles a raw tool-result payload mentions, for diagnostics. */
function rawCursorHandles(value: unknown): string[] {
	const raw = objectValue(value);
	if (!raw || !Array.isArray(raw.runs)) return [];
	return raw.runs.map(rawCursorHandle).filter((handle): handle is string => handle !== undefined);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface EntryEnvelope {
	kind: AccountingKind;
	runs: unknown[];
}

/** Validate a persisted payload's envelope; undefined means "not our parent". */
function parseEnvelope(value: unknown, parentSessionId: string): EntryEnvelope | undefined {
	const raw = objectValue(value);
	if (!raw) throw new AccountingError("invalid accounting details: expected an object with a parent session");
	if (raw.parentSessionId === undefined) throw new AccountingError("invalid accounting details: missing parent session");
	if (raw.parentSessionId !== parentSessionId) return undefined;
	if (raw.version !== ACCOUNTING_DETAILS_VERSION || !["spawn", "adoption", "observation"].includes(String(raw.kind)) || !Array.isArray(raw.runs)) {
		throw new AccountingError("invalid accounting details in parent tool result");
	}
	return { kind: raw.kind as AccountingKind, runs: raw.runs };
}

export function accountingDetails(kind: AccountingKind, parentSessionId: string, runs: RunCursor[]): AccountingDetails {
	return { version: ACCOUNTING_DETAILS_VERSION, kind, parentSessionId, runs };
}

export function spawnCursor(handle: string): RunCursor {
	return { handle, childSessionId: null, generation: null, sequence: 0, cumulative: zeroUsage(), final: false };
}

function isDirectSpawnZeroCursor(cursor: RunCursor): boolean {
	return (
		cursor.childSessionId === null &&
		cursor.generation === null &&
		cursor.sequence === 0 &&
		!cursor.final &&
		!cursor.unownedAdoption &&
		isZeroUsage(cursor.cumulative)
	);
}

function isZeroUsage(usage: Usage): boolean {
	return (
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0 &&
		(usage.cacheWrite1h ?? 0) === 0 &&
		(usage.reasoning ?? 0) === 0 &&
		usage.totalTokens === 0 &&
		usage.cost.input === 0 &&
		usage.cost.output === 0 &&
		usage.cost.cacheRead === 0 &&
		usage.cost.cacheWrite === 0 &&
		usage.cost.total === 0
	);
}

function usageEqual(first: Usage, second: Usage): boolean {
	return JSON.stringify(first) === JSON.stringify(second);
}

function subtractUsage(current: Usage, previous: Usage): Usage {
	if (!isZeroUsage(previous) && !previous.cost.totalFromProvider && current.cost.totalFromProvider) {
		throw new AccountingError("cumulative Usage cost provenance changed from estimated/mixed to provider-reported");
	}
	if ((previous.cacheWrite1h !== undefined && current.cacheWrite1h === undefined) || (previous.reasoning !== undefined && current.reasoning === undefined)) {
		throw new AccountingError("cumulative Usage lost an optional numeric component");
	}
	const delta = (now: number, before: number, name: string): number => {
		const value = now - before;
		if (!Number.isFinite(value) || value < 0) throw new AccountingError(`negative or invalid Usage delta in ${name}`);
		return value;
	};
	return {
		input: delta(current.input, previous.input, "input"),
		output: delta(current.output, previous.output, "output"),
		cacheRead: delta(current.cacheRead, previous.cacheRead, "cacheRead"),
		cacheWrite: delta(current.cacheWrite, previous.cacheWrite, "cacheWrite"),
		...(current.cacheWrite1h !== undefined || previous.cacheWrite1h !== undefined
			? { cacheWrite1h: delta(current.cacheWrite1h ?? 0, previous.cacheWrite1h ?? 0, "cacheWrite1h") }
			: {}),
		...(current.reasoning !== undefined || previous.reasoning !== undefined
			? { reasoning: delta(current.reasoning ?? 0, previous.reasoning ?? 0, "reasoning") }
			: {}),
		totalTokens: delta(current.totalTokens, previous.totalTokens, "totalTokens"),
		cost: {
			input: delta(current.cost.input, previous.cost.input, "cost.input"),
			output: delta(current.cost.output, previous.cost.output, "cost.output"),
			cacheRead: delta(current.cost.cacheRead, previous.cost.cacheRead, "cost.cacheRead"),
			cacheWrite: delta(current.cost.cacheWrite, previous.cost.cacheWrite, "cost.cacheWrite"),
			total: delta(current.cost.total, previous.cost.total, "cost.total"),
			totalFromProvider: isZeroUsage(previous)
				? current.cost.totalFromProvider === true
				: previous.cost.totalFromProvider === true && current.cost.totalFromProvider === true,
		},
	};
}

function cursorFromSnapshot(
	snapshot: UsageSnapshot,
	unownedAdoption = false,
	finalization?: "unconfirmed",
): RunCursor {
	return {
		handle: snapshot.runHandle,
		childSessionId: snapshot.childSessionId,
		generation: snapshot.childSessionGeneration,
		sequence: snapshot.sequence,
		cumulative: snapshot.usage,
		final: snapshot.final,
		...(finalization && !snapshot.final ? { finalization } : {}),
		...(unownedAdoption ? { unownedAdoption: true as const } : {}),
	};
}

function sameSnapshot(cursor: RunCursor, snapshot: UsageSnapshot): boolean {
	return (
		cursor.childSessionId === snapshot.childSessionId &&
		cursor.generation === snapshot.childSessionGeneration &&
		cursor.sequence === snapshot.sequence &&
		cursor.final === snapshot.final &&
		usageEqual(cursor.cumulative, snapshot.usage)
	);
}

function combineDeltas(deltas: Usage[]): Usage | undefined {
	let combined: Usage | undefined;
	for (const delta of deltas) {
		if (!isZeroUsage(delta)) combined = addUsage(combined, delta);
	}
	return combined;
}

export class UsageObserver {
	private readonly cursors = new Map<string, RunCursor>();
	/**
	 * Runs whose durable cursor could not be restored from a corrupt tool
	 * result, mapped to a diagnostic naming the entry and tool. The run fails
	 * closed on every later call — malformed data is never zero-defaulted and
	 * never authorizes an observation — but unrelated runs and tools keep
	 * working. Folding in branch order lets a later valid result clear it.
	 */
	private readonly unusableCursors = new Map<string, string>();
	private parentSessionId = "";
	private restoreError: string | undefined;
	private queue: Promise<void> = Promise.resolve();
	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
	}

	restore(ctx: ExtensionContext): void {
		this.parentSessionId = ctx.sessionManager.getSessionId();
		this.cursors.clear();
		this.unusableCursors.clear();
		this.restoreError = undefined;
		let branch: SessionEntry[];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch (error) {
			// Without the branch nothing can be reconstructed at all, so the whole
			// session fails closed rather than guessing per-run state.
			this.restoreError = errorMessage(error);
			return;
		}
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
			if (!REX_ACCOUNTING_TOOLS.includes(entry.message.toolName)) continue;
			this.restoreEntry(entry);
		}
	}

	/**
	 * Fold one persisted accounting tool result. A malformed payload degrades
	 * to the runs it covers: their cursors stay unloaded, so only those runs
	 * fail closed while sibling runs and unrelated spawn/adopt/wait/stop calls
	 * keep working.
	 */
	private restoreEntry(entry: SessionEntry): void {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return;
		const toolName = entry.message.toolName;
		const label = `parent tool result ${entry.id} (${toolName})`;
		let envelope: EntryEnvelope | undefined;
		try {
			envelope = parseEnvelope(entry.message.details, this.parentSessionId);
			if (envelope && accountingKindForTool(toolName) !== envelope.kind) {
				throw new AccountingError("accounting tool name and result kind disagree");
			}
		} catch (error) {
			// The envelope or the tool/kind pairing is unusable, so no cursor in
			// this payload may be trusted: fail closed for every run it mentions.
			// A payload that mentions no run at all authorizes nothing and is
			// simply skipped — there is no run left to fail closed for.
			const reason = `${label}: ${errorMessage(error)}`;
			const handles = rawCursorHandles(entry.message.details);
			if (handles.length === 0) {
				// A payload with no attributable run cannot safely degrade per run.
				// Falling back to older cursors could charge an already-accounted
				// delta a second time, so the whole selected branch fails closed.
				this.restoreError = `malformed accounting payload cannot be attributed to a run: ${reason}`;
				return;
			}
			for (const handle of handles) this.unusableCursors.set(handle, reason);
			return;
		}
		if (!envelope) return; // a payload belonging to a different parent session
		const seen = new Set<string>();
		for (const raw of envelope.runs) {
			let cursor: RunCursor;
			try {
				cursor = parseCursor(raw, envelope.kind);
				if (seen.has(cursor.handle)) throw new AccountingError("duplicate run cursor in parent tool result");
			} catch (error) {
				// Degrade per run: only this cursor's run loses its baseline.
				const handle = rawCursorHandle(raw);
				if (handle) this.unusableCursors.set(handle, `${label}: ${errorMessage(error)}`);
				continue;
			}
			seen.add(cursor.handle);
			this.cursors.set(cursor.handle, cursor);
			this.unusableCursors.delete(cursor.handle);
		}
	}

	private requireCursorIntact(handle: string): void {
		const unusable = this.unusableCursors.get(handle);
		if (unusable) {
			throw new AccountingError(
				`run ${handle} has a corrupt accounting cursor from ${unusable}; it stays fail closed until a later valid rex_observe or rex_adopt result restores its baseline`,
			);
		}
	}

	private requireCursor(handle: string): RunCursor {
		this.requireCursorIntact(handle);
		const cursor = this.cursors.get(handle);
		if (!cursor) throw new AccountingError(`run ${handle} has no spawn or adoption baseline on this parent branch`);
		return cursor;
	}

	recordSpawn(parentSessionId: string, handle: string): Promise<AccountingDetails> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			const cursor = spawnCursor(handle);
			this.cursors.set(handle, cursor);
			return accountingDetails("spawn", parentSessionId, [cursor]);
		});
	}

	adopt(parentSessionId: string, handle: string): Promise<AccountingDetails> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			const unusable = this.unusableCursors.get(handle);
			if (unusable) {
				throw new AccountingError(
					`run ${handle} has a corrupt accounting cursor from ${unusable}; re-adoption is refused because its durable accounting history cannot be trusted`,
				);
			}
			if (this.cursors.has(handle)) throw new AccountingError(`run ${handle} already has a baseline on this parent branch`);
			const record = readRecord(handle, this.env);
			if (!record) throw new AccountingError(`run ${handle} accounting ownership could not be read, or no such run exists`);
			if (record.parentSessionId && record.parentSessionId !== parentSessionId) {
				throw new AccountingError(`run ${handle} belongs to a different parent session`);
			}
			if (record.usageBaselineError) {
				throw new AccountingError(
					`run ${handle} cannot be adopted after its spawn accounting baseline failure: ${record.usageBaselineError}`,
				);
			}
			const snapshot = this.readSnapshot(handle);
			if (!snapshot) throw new AccountingError(`run ${handle} has no usage snapshot to adopt`);
			if (
				snapshot.runHandle !== handle ||
				(snapshot.parentSessionId !== null && snapshot.parentSessionId !== parentSessionId) ||
				(!record.parentSessionId && snapshot.parentSessionId !== null)
			) {
				throw new AccountingError(`run ${handle} snapshot has the wrong identity or owner`);
			}
			if (!record.parentSessionId) {
				let created = false;
				try {
					// Atomic hard-link publication makes the first complete claim win
					// across processes. Existing claims are never overwritten.
					created = claimRecordOwner(handle, parentSessionId, this.env);
				} catch (error) {
					throw new AccountingError(`run ${handle} accounting ownership could not be claimed: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (readRecord(handle, this.env)?.parentSessionId !== parentSessionId) {
					const outcome = created ? "after publishing a new claim" : "because an existing claim won the race";
					throw new AccountingError(`run ${handle} accounting ownership could not be confirmed ${outcome}`);
				}
			}
			if (readRecord(handle, this.env)?.parentSessionId !== parentSessionId) {
				throw new AccountingError(`run ${handle} accounting ownership could not be confirmed`);
			}
			const cursor = cursorFromSnapshot(snapshot, snapshot.parentSessionId === null);
			this.cursors.set(handle, cursor);
			return accountingDetails("adoption", parentSessionId, [cursor]);
		});
	}
	validate(
		parentSessionId: string,
		handles: string[],
		options: { allowMissingBaseline?: boolean } = {},
	): Promise<void> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			for (const handle of new Set(handles)) {
				this.requireOwnedRun(parentSessionId, handle);
				this.requireCursorIntact(handle);
				if (!options.allowMissingBaseline) this.requireCursor(handle);
			}
		});
	}

	observe(
		parentSessionId: string,
		handles: string[],
		options: {
			requireFinal?: boolean;
			allowUnconfirmedFinal?: boolean;
			allowMissingSnapshotFor?: readonly string[];
		} = {},
	): Promise<Observation> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			const unique = [...new Set(handles)];
			if (unique.length === 0) throw new AccountingError("at least one run handle is required");
			const next: RunCursor[] = [];
			const deltas: Usage[] = [];
			for (const handle of unique) {
				this.requireOwnedRun(parentSessionId, handle);
				this.requireCursorIntact(handle);
				const previous = this.cursors.get(handle);
				if (!previous && options.allowMissingSnapshotFor?.includes(handle) !== true) this.requireCursor(handle);
				const snapshot = this.readSnapshot(handle);
				if (!snapshot) {
					const terminalProof = options.allowMissingSnapshotFor?.includes(handle) === true;
					const replayedTerminalProof = previous?.snapshot === "missing" && !options.requireFinal;
					if ((terminalProof || replayedTerminalProof) && (!previous || isDirectSpawnZeroCursor(previous))) {
						next.push(
							previous
								? { ...previous, finalization: "unconfirmed", snapshot: "missing" }
								: {
										handle,
										childSessionId: null,
										generation: null,
										sequence: 0,
										cumulative: zeroUsage(),
										final: false,
										finalization: "unconfirmed",
										snapshot: "missing",
									},
						);
						continue;
					}
					throw new AccountingError(`run ${handle} has no usage snapshot`);
				}
				if (previous?.snapshot === "missing") {
					throw new AccountingError(`run ${handle} published a snapshot after terminal missing-snapshot recovery`);
				}
				if (!previous) throw new AccountingError(`run ${handle} has no spawn or adoption baseline on this parent branch`);
				if (snapshot.runHandle !== handle) throw new AccountingError(`run ${handle} snapshot has the wrong identity`);
				// A busy unowned child can publish a newer null-owner snapshot that was
				// already in flight while adoption claimed the run. While the cursor
				// keeps its unowned-adoption marker — no owned snapshot has been
				// observed yet — such pre-claim publications are legitimate and are
				// charged with their exact delta. Once any owned snapshot has advanced
				// the cursor, null-owner snapshots are rejected for good.
				const preClaimUnowned = previous.unownedAdoption === true && snapshot.parentSessionId === null;
				const finalization =
					!snapshot.final && (options.allowUnconfirmedFinal === true || previous.finalization === "unconfirmed")
						? ("unconfirmed" as const)
						: undefined;
				if (snapshot.parentSessionId !== parentSessionId && !preClaimUnowned) {
					throw new AccountingError(`run ${handle} snapshot has the wrong owner`);
				}
				if (options.requireFinal && !snapshot.final) {
					throw new AccountingError(`run ${handle} has not published its final usage snapshot`);
				}
				if (previous.childSessionId !== null && previous.childSessionId !== snapshot.childSessionId) {
					throw new AccountingError(`run ${handle} changed child session`);
				}
				if (previous.generation !== null && previous.generation !== snapshot.childSessionGeneration) {
					throw new AccountingError(`run ${handle} changed child-session generation`);
				}
				if (previous.final) {
					if (!sameSnapshot(previous, snapshot)) throw new AccountingError(`run ${handle} published usage after its final snapshot`);
					next.push(cursorFromSnapshot(snapshot, preClaimUnowned, finalization));
					deltas.push(subtractUsage(snapshot.usage, previous.cumulative));
					continue;
				}
				if (snapshot.sequence < previous.sequence) throw new AccountingError(`run ${handle} snapshot sequence regressed`);
				if (snapshot.sequence === previous.sequence && previous.generation !== null) {
					if (!sameSnapshot(previous, snapshot)) throw new AccountingError(`run ${handle} snapshot conflicts with its cursor`);
					next.push(cursorFromSnapshot(snapshot, preClaimUnowned, finalization));
					deltas.push(subtractUsage(snapshot.usage, previous.cumulative));
					continue;
				}
				deltas.push(subtractUsage(snapshot.usage, previous.cumulative));
				next.push(cursorFromSnapshot(snapshot, preClaimUnowned, finalization));
			}
			for (const cursor of next) this.cursors.set(cursor.handle, cursor);
			const usage = combineDeltas(deltas);
			return { details: accountingDetails("observation", parentSessionId, next), ...(usage ? { usage } : {}) };
		});
	}

	private requireParent(parentSessionId: string): void {
		if (this.restoreError) throw new AccountingError(`cannot restore Rex accounting cursors: ${this.restoreError}`);
		if (!this.parentSessionId) throw new AccountingError("accounting observer has not been restored for this session");
		if (this.parentSessionId !== parentSessionId) throw new AccountingError("accounting observer belongs to a different parent session");
	}

	private readSnapshot(handle: string): UsageSnapshot | undefined {
		try {
			return readUsageSnapshot(runDirFor(handle, this.env));
		} catch (error) {
			throw new AccountingError(`run ${handle} has an invalid usage snapshot: ${errorMessage(error)}`);
		}
	}

	private requireOwnedRun(parentSessionId: string, handle: string): RunRecord {
		const record = readRecord(handle, this.env);
		if (!record) throw new AccountingError(`no Rex subagent with handle ${handle}`);
		if (record.parentSessionId !== parentSessionId) throw new AccountingError(`run ${handle} belongs to a different parent session`);
		return record;
	}

	private async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.queue;
		let release: () => void = () => undefined;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
