/**
 * Issue #45 test-only deterministic subagent provider.
 *
 * Snapshots are administered as files by the conformance fixture. The extension
 * itself is reached only through real Pi custom tools and implements the neutral
 * V1 contract without importing Rex or pi-goal accounting. Private run metadata
 * deliberately contains child active time; the public result must never expose it.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const SOURCE = "pi-goal-deterministic-subagent";
const ROOT = process.env.PI_GOAL_FAKE_SUBAGENT_DIR;
if (!ROOT) throw new Error("PI_GOAL_FAKE_SUBAGENT_DIR is required for the usage conformance fake");
const root = ROOT;

interface Snapshot {
	version: 1;
	source: typeof SOURCE;
	runId: string;
	parentSessionId: string | null;
	childSessionId: string;
	childSessionGeneration: string;
	sequence: number;
	usage: Usage;
	final: boolean;
	updatedAt: string;
}

interface Cursor {
	runId: string;
	childSessionId: string | null;
	generation: string | null;
	sequence: number;
	cumulative: Usage;
	final: boolean;
}

interface Details {
	version: 1;
	source: typeof SOURCE;
	kind: "spawn" | "adoption" | "observation";
	parentSessionId: string;
	runs: Cursor[];
}

interface RunRecord {
	runId: string;
	parentSessionId: string | null;
	activeElapsedMs: number;
}

function runDir(runId: string): string {
	return join(root, runId);
}

function recordPath(runId: string): string {
	return join(runDir(runId), "record.json");
}

function snapshotPath(runId: string): string {
	return join(runDir(runId), "snapshot.json");
}

function readRecord(runId: string): RunRecord | undefined {
	const path = recordPath(runId);
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
	if (value.runId !== runId) throw new Error(`run ${runId} has malformed identity`);
	return value;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberField(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`invalid Usage ${name}`);
	return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
	return value === undefined ? undefined : numberField(value, name);
}

function parseUsage(value: unknown): Usage {
	const raw = object(value);
	const cost = object(raw?.cost);
	if (!raw || !cost) throw new Error("invalid Usage object");
	const cacheWrite1h = optionalNumber(raw.cacheWrite1h, "cacheWrite1h");
	const reasoning = optionalNumber(raw.reasoning, "reasoning");
	if (cost.totalFromProvider !== undefined && typeof cost.totalFromProvider !== "boolean") {
		throw new Error("invalid Usage cost provenance");
	}
	return {
		input: numberField(raw.input, "input"),
		output: numberField(raw.output, "output"),
		cacheRead: numberField(raw.cacheRead, "cacheRead"),
		cacheWrite: numberField(raw.cacheWrite, "cacheWrite"),
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: numberField(raw.totalTokens, "totalTokens"),
		cost: {
			input: numberField(cost.input, "cost.input"),
			output: numberField(cost.output, "cost.output"),
			cacheRead: numberField(cost.cacheRead, "cost.cacheRead"),
			cacheWrite: numberField(cost.cacheWrite, "cost.cacheWrite"),
			total: numberField(cost.total, "cost.total"),
			totalFromProvider: cost.totalFromProvider === true,
		},
	};
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
	};
}

function readSnapshot(runId: string): Snapshot {
	const raw = object(JSON.parse(readFileSync(snapshotPath(runId), "utf8")));
	const parent = raw?.parentSessionId;
	if (
		!raw || raw.version !== 1 || raw.source !== SOURCE || raw.runId !== runId ||
		!(typeof parent === "string" || parent === null) || parent === "" ||
		typeof raw.childSessionId !== "string" || raw.childSessionId.length === 0 ||
		typeof raw.childSessionGeneration !== "string" || raw.childSessionGeneration.length === 0 ||
		!Number.isInteger(raw.sequence) || (raw.sequence as number) < 1 || typeof raw.final !== "boolean" ||
		typeof raw.updatedAt !== "string" || raw.updatedAt.length === 0
	) {
		throw new Error(`run ${runId} has an invalid usage snapshot`);
	}
	return {
		version: 1,
		source: SOURCE,
		runId,
		parentSessionId: parent,
		childSessionId: raw.childSessionId as string,
		childSessionGeneration: raw.childSessionGeneration as string,
		sequence: raw.sequence as number,
		usage: parseUsage(raw.usage),
		final: raw.final,
		updatedAt: raw.updatedAt,
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isZero(usage: Usage): boolean {
	return usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0 &&
		(usage.cacheWrite1h ?? 0) === 0 && (usage.reasoning ?? 0) === 0 && usage.totalTokens === 0 &&
		usage.cost.input === 0 && usage.cost.output === 0 && usage.cost.cacheRead === 0 &&
		usage.cost.cacheWrite === 0 && usage.cost.total === 0;
}

function subtract(current: Usage, previous: Usage): Usage {
	if (!isZero(previous) && !previous.cost.totalFromProvider && current.cost.totalFromProvider) {
		throw new Error("invalid Usage cost-provenance transition");
	}
	if ((previous.cacheWrite1h !== undefined && current.cacheWrite1h === undefined) ||
		(previous.reasoning !== undefined && current.reasoning === undefined)) {
		throw new Error("invalid Usage: an optional component vanished");
	}
	const delta = (now: number, before: number, name: string): number => {
		const value = now - before;
		if (!Number.isFinite(value) || value < 0) throw new Error(`negative Usage delta in ${name}`);
		return value;
	};
	return {
		input: delta(current.input, previous.input, "input"),
		output: delta(current.output, previous.output, "output"),
		cacheRead: delta(current.cacheRead, previous.cacheRead, "cacheRead"),
		cacheWrite: delta(current.cacheWrite, previous.cacheWrite, "cacheWrite"),
		...(current.cacheWrite1h !== undefined || previous.cacheWrite1h !== undefined
			? { cacheWrite1h: delta(current.cacheWrite1h ?? 0, previous.cacheWrite1h ?? 0, "cacheWrite1h") } : {}),
		...(current.reasoning !== undefined || previous.reasoning !== undefined
			? { reasoning: delta(current.reasoning ?? 0, previous.reasoning ?? 0, "reasoning") } : {}),
		totalTokens: delta(current.totalTokens, previous.totalTokens, "totalTokens"),
		cost: {
			input: delta(current.cost.input, previous.cost.input, "cost.input"),
			output: delta(current.cost.output, previous.cost.output, "cost.output"),
			cacheRead: delta(current.cost.cacheRead, previous.cost.cacheRead, "cost.cacheRead"),
			cacheWrite: delta(current.cost.cacheWrite, previous.cost.cacheWrite, "cost.cacheWrite"),
			total: delta(current.cost.total, previous.cost.total, "cost.total"),
			totalFromProvider: isZero(previous) ? current.cost.totalFromProvider === true :
				previous.cost.totalFromProvider === true && current.cost.totalFromProvider === true,
		},
	};
}

function add(first: Usage | undefined, second: Usage): Usage {
	if (!first) return second;
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) } : {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) } : {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
			totalFromProvider: first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
		},
	};
}

function details(kind: Details["kind"], parentSessionId: string, runs: Cursor[]): Details {
	return { version: 1, source: SOURCE, kind, parentSessionId, runs };
}

function text(text: string, body: Details, usage?: Usage): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], details: body, ...(usage ? { usage } : {}) };
}

function failure(error: unknown, kind: Details["kind"], parentSessionId: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: details(kind, parentSessionId, []),
		isError: true,
	};
}

function sameSnapshot(cursor: Cursor, snapshot: Snapshot): boolean {
	return cursor.childSessionId === snapshot.childSessionId && cursor.generation === snapshot.childSessionGeneration &&
		cursor.sequence === snapshot.sequence && cursor.final === snapshot.final &&
		JSON.stringify(cursor.cumulative) === JSON.stringify(snapshot.usage);
}

class Observer {
	private cursors = new Map<string, Cursor>();
	private parentSessionId = "";
	private queue: Promise<void> = Promise.resolve();

	restore(ctx: ExtensionContext): void {
		this.parentSessionId = ctx.sessionManager.getSessionId();
		this.cursors.clear();
		for (const entry of ctx.sessionManager.getBranch()) this.restoreEntry(entry);
	}

	private restoreEntry(entry: SessionEntry): void {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return;
		if (!["usage_fake_spawn", "usage_fake_adopt", "usage_fake_observe", "usage_fake_stop"].includes(entry.message.toolName)) return;
		const raw = object(entry.message.details);
		if (!raw || raw.version !== 1 || raw.source !== SOURCE || raw.parentSessionId !== this.parentSessionId || !Array.isArray(raw.runs)) return;
		for (const value of raw.runs) {
			const cursor = object(value);
			if (!cursor || typeof cursor.runId !== "string" || !Number.isInteger(cursor.sequence)) continue;
			this.cursors.set(cursor.runId, {
				runId: cursor.runId,
				childSessionId: typeof cursor.childSessionId === "string" ? cursor.childSessionId : null,
				generation: typeof cursor.generation === "string" ? cursor.generation : null,
				sequence: cursor.sequence as number,
				cumulative: parseUsage(cursor.cumulative),
				final: cursor.final === true,
			});
		}
	}

	private transaction<T>(operation: () => T): Promise<T> {
		const previous = this.queue;
		let release: () => void = () => undefined;
		this.queue = new Promise<void>((resolve) => { release = resolve; });
		return previous.then(() => {
			try { return operation(); } finally { release(); }
		});
	}

	private requireParent(parentSessionId: string): void {
		if (!this.parentSessionId || this.parentSessionId !== parentSessionId) throw new Error("wrong parent session");
	}

	private requireOwned(runId: string, parentSessionId: string): RunRecord {
		const record = readRecord(runId);
		if (!record) throw new Error(`unknown run ${runId}`);
		if (record.parentSessionId !== parentSessionId) throw new Error(`run ${runId} belongs to another parent`);
		return record;
	}

	spawn(parentSessionId: string, runId: string): Promise<AgentToolResult<Details>> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			if (existsSync(runDir(runId))) throw new Error(`run ${runId} already exists`);
			mkdirSync(runDir(runId), { recursive: true });
			writeJson(recordPath(runId), { runId, parentSessionId, activeElapsedMs: 123456 });
			writeJson(snapshotPath(runId), {
				version: 1, source: SOURCE, runId, parentSessionId,
				childSessionId: `${runId}-child`, childSessionGeneration: `${runId}-generation`,
				sequence: 1, usage: zeroUsage(), final: false, updatedAt: "2026-01-01T00:00:00.000Z",
			});
			const baseline: Cursor = {
				runId, childSessionId: null, generation: null, sequence: 0, cumulative: zeroUsage(), final: false,
			};
			this.cursors.set(runId, baseline);
			return text(`Spawned deterministic child ${runId}`, details("spawn", parentSessionId, [baseline]));
		});
	}

	adopt(parentSessionId: string, runId: string): Promise<AgentToolResult<Details>> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			if (this.cursors.has(runId)) throw new Error(`run ${runId} already has an adoption baseline`);
			const record = readRecord(runId);
			if (!record || (record.parentSessionId !== null && record.parentSessionId !== parentSessionId)) {
				throw new Error(`run ${runId} belongs to another parent`);
			}
			const snapshot = readSnapshot(runId);
			if (snapshot.parentSessionId !== null && snapshot.parentSessionId !== parentSessionId) {
				throw new Error(`run ${runId} snapshot belongs to another parent`);
			}
			record.parentSessionId = parentSessionId;
			snapshot.parentSessionId = parentSessionId;
			writeJson(recordPath(runId), record);
			writeJson(snapshotPath(runId), snapshot);
			const baseline: Cursor = {
				runId, childSessionId: snapshot.childSessionId, generation: snapshot.childSessionGeneration,
				sequence: snapshot.sequence, cumulative: snapshot.usage, final: snapshot.final,
			};
			this.cursors.set(runId, baseline);
			return text(`Adopted deterministic child ${runId}`, details("adoption", parentSessionId, [baseline]));
		});
	}

	observe(parentSessionId: string, handles: string[]): Promise<AgentToolResult<Details>> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			const unique = [...new Set(handles)];
			const next: Cursor[] = [];
			let combined: Usage | undefined;
			for (const runId of unique) {
				this.requireOwned(runId, parentSessionId);
				const previous = this.cursors.get(runId);
				if (!previous) throw new Error(`run ${runId} has no spawn or adoption baseline`);
				const snapshot = readSnapshot(runId);
				if (snapshot.parentSessionId !== parentSessionId) throw new Error(`run ${runId} snapshot has the wrong parent`);
				if (previous.childSessionId !== null && previous.childSessionId !== snapshot.childSessionId) {
					throw new Error(`run ${runId} changed child session`);
				}
				if (previous.generation !== null && previous.generation !== snapshot.childSessionGeneration) {
					throw new Error(`run ${runId} changed child-session generation`);
				}
				if (previous.final && !sameSnapshot(previous, snapshot)) throw new Error(`run ${runId} changed after final`);
				if (snapshot.sequence < previous.sequence) throw new Error(`run ${runId} snapshot sequence regressed`);
				if (snapshot.sequence === previous.sequence && previous.generation !== null && !sameSnapshot(previous, snapshot)) {
					throw new Error(`run ${runId} snapshot conflicts with its cursor`);
				}
				const delta = subtract(snapshot.usage, previous.cumulative);
				if (!isZero(delta)) combined = add(combined, delta);
				next.push({
					runId, childSessionId: snapshot.childSessionId, generation: snapshot.childSessionGeneration,
					sequence: snapshot.sequence, cumulative: snapshot.usage, final: snapshot.final,
				});
			}
			for (const cursor of next) this.cursors.set(cursor.runId, cursor);
			return text("Observed deterministic children", details("observation", parentSessionId, next), combined);
		});
	}

	async stop(parentSessionId: string, runId: string): Promise<AgentToolResult<Details>> {
		this.requireOwned(runId, parentSessionId);
		const snapshot = readSnapshot(runId);
		writeJson(snapshotPath(runId), { ...snapshot, sequence: snapshot.sequence + 1, final: true });
		const observed = await this.observe(parentSessionId, [runId]);
		rmSync(runDir(runId), { recursive: true, force: true });
		return observed;
	}
}

export default function usageConformanceFake(pi: ExtensionAPI): void {
	const observer = new Observer();
	pi.on("session_start", (_event, ctx) => observer.restore(ctx));
	pi.on("session_tree", (_event, ctx) => observer.restore(ctx));

	pi.registerTool({
		name: "usage_fake_spawn",
		label: "Deterministic usage fake spawn",
		description: "Test-only provider spawn with a zero accounting baseline.",
		parameters: Type.Object({ runId: Type.String({ minLength: 1 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			const parent = ctx.sessionManager.getSessionId();
			try { return await observer.spawn(parent, params.runId); } catch (error) { return failure(error, "spawn", parent); }
		},
	});
	pi.registerTool({
		name: "usage_fake_adopt",
		label: "Deterministic usage fake adoption",
		description: "Test-only provider adoption with a free current baseline.",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			const parent = ctx.sessionManager.getSessionId();
			try { return await observer.adopt(parent, params.handle); } catch (error) { return failure(error, "adoption", parent); }
		},
	});
	pi.registerTool({
		name: "usage_fake_observe",
		label: "Deterministic usage fake observation",
		description: "Test-only cumulative snapshot observation.",
		parameters: Type.Object({ handles: Type.Array(Type.String(), { minItems: 1 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			const parent = ctx.sessionManager.getSessionId();
			try { return await observer.observe(parent, params.handles); } catch (error) { return failure(error, "observation", parent); }
		},
	});
	pi.registerTool({
		name: "usage_fake_stop",
		label: "Deterministic usage fake final collection",
		description: "Test-only final observation before record removal.",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }), remove: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, _signal, _update, ctx) {
			const parent = ctx.sessionManager.getSessionId();
			try { return await observer.stop(parent, params.handle); } catch (error) { return failure(error, "observation", parent); }
		},
	});
}
