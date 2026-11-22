import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USAGE_SNAPSHOT_SOURCE = "pi-rex-subagent";
export const USAGE_SNAPSHOT_VERSION = 1;

export interface UsageSnapshot {
	version: 1;
	source: typeof USAGE_SNAPSHOT_SOURCE;
	runHandle: string;
	parentSessionId: string | null;
	childSessionId: string;
	childSessionGeneration: string;
	sequence: number;
	usage: Usage;
	final: boolean;
	updatedAt: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberField(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`invalid Usage ${name}: expected a finite non-negative number`);
	}
	return value;
}

function optionalNumberField(value: unknown, name: string): number | undefined {
	return value === undefined ? undefined : numberField(value, name);
}

export function parseUsage(value: unknown): Usage {
	const raw = record(value);
	const rawCost = record(raw?.cost);
	if (!raw || !rawCost) throw new Error("invalid Usage: expected an object with cost");
	const cacheWrite1h = optionalNumberField(raw.cacheWrite1h, "cacheWrite1h");
	const reasoning = optionalNumberField(raw.reasoning, "reasoning");
	const totalFromProvider = rawCost.totalFromProvider;
	if (totalFromProvider !== undefined && typeof totalFromProvider !== "boolean") {
		throw new Error("invalid Usage cost.totalFromProvider: expected a boolean");
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
			input: numberField(rawCost.input, "cost.input"),
			output: numberField(rawCost.output, "cost.output"),
			cacheRead: numberField(rawCost.cacheRead, "cost.cacheRead"),
			cacheWrite: numberField(rawCost.cacheWrite, "cost.cacheWrite"),
			total: numberField(rawCost.total, "cost.total"),
			totalFromProvider: totalFromProvider === true,
		},
	};
}

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
	};
}

export function addUsage(first: Usage | undefined, secondValue: unknown): Usage {
	const second = parseUsage(secondValue);
	if (!first) return second;
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
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

export function usageFromBranch(entries: SessionEntry[]): Usage {
	let total: Usage | undefined;
	for (const entry of entries) {
		if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			if (entry.message.usage) total = addUsage(total, entry.message.usage);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			total = addUsage(total, entry.usage);
		}
	}
	return total ?? zeroUsage();
}

export function childSessionGeneration(ctx: ExtensionContext): string {
	const header = ctx.sessionManager.getHeader();
	if (!header) throw new Error("cannot publish child usage without a persisted session header");
	return `${header.id}:${header.timestamp}`;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseUsageSnapshot(value: unknown): UsageSnapshot {
	const raw = record(value);
	const parent = raw?.parentSessionId;
	if (
		!raw ||
		raw.version !== USAGE_SNAPSHOT_VERSION ||
		raw.source !== USAGE_SNAPSHOT_SOURCE ||
		!text(raw.runHandle) ||
		!(typeof parent === "string" || parent === null) ||
		parent === "" ||
		!text(raw.childSessionId) ||
		!text(raw.childSessionGeneration) ||
		!Number.isInteger(raw.sequence) ||
		(raw.sequence as number) < 1 ||
		typeof raw.final !== "boolean" ||
		!text(raw.updatedAt)
	) {
		throw new Error("invalid Rex usage snapshot");
	}
	return {
		version: 1,
		source: USAGE_SNAPSHOT_SOURCE,
		runHandle: raw.runHandle as string,
		parentSessionId: parent as string | null,
		childSessionId: raw.childSessionId as string,
		childSessionGeneration: raw.childSessionGeneration as string,
		sequence: raw.sequence as number,
		usage: parseUsage(raw.usage),
		final: raw.final,
		updatedAt: raw.updatedAt as string,
	};
}

export function usageSnapshotPath(runDir: string): string {
	return join(runDir, "usage.json");
}

export function readUsageSnapshot(runDir: string): UsageSnapshot | undefined {
	const path = usageSnapshotPath(runDir);
	if (!existsSync(path)) return undefined;
	return parseUsageSnapshot(JSON.parse(readFileSync(path, "utf8")));
}

export function publishUsageSnapshot(
	ctx: ExtensionContext,
	runDir: string,
	runHandle: string,
	parentSessionId: string | null,
	final = false,
): UsageSnapshot {
	const generation = childSessionGeneration(ctx);
	const previous = readUsageSnapshot(runDir);
	if (previous?.final && previous.childSessionGeneration === generation) {
		throw new Error(`run ${runHandle} already published its final usage snapshot`);
	}
	const snapshot: UsageSnapshot = {
		version: 1,
		source: USAGE_SNAPSHOT_SOURCE,
		runHandle,
		parentSessionId,
		childSessionId: ctx.sessionManager.getSessionId(),
		childSessionGeneration: generation,
		sequence: previous?.childSessionGeneration === generation ? previous.sequence + 1 : 1,
		usage: usageFromBranch(ctx.sessionManager.getBranch()),
		final,
		updatedAt: new Date().toISOString(),
	};
	const path = usageSnapshotPath(runDir);
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
	return snapshot;
}
