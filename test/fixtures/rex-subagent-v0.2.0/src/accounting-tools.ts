import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { UsageObserver, accountingDetails, type AccountingDetails, type AccountingKind } from "./accounting.ts";
import { spawnRun, type SpawnOptions, type SpawnResult } from "./launch.ts";
import {
	describeRun,
	stopRun,
	waitRuns,
	type RunView,
	type StopOptions,
	type StopResult,
	type WaitOptions,
	type WaitResult,
} from "./lifecycle.ts";
import { isTerminalDisplayState, readRecord, removeRun, runDirFor, updateRecord } from "./record.ts";
import { DEFAULT_FINALIZATION_WAIT_MS } from "./stop-policy.ts";
import { readUsageSnapshot, usageSnapshotPath } from "./usage.ts";

export interface AccountingToolDeps {
	env?: NodeJS.ProcessEnv;
	spawn?: (options: SpawnOptions) => Promise<SpawnResult>;
	wait?: (handles: string[], options: WaitOptions) => Promise<WaitResult[]>;
	stop?: (handle: string, options: StopOptions) => Promise<StopResult>;
	describe?: (handle: string) => Promise<Pick<RunView, "state">>;
	remove?: (handle: string) => void;
	finalizationTimeoutMs?: number;
}

function textResult(text: string, details: AccountingDetails, usage?: import("@earendil-works/pi-ai").Usage): AgentToolResult<AccountingDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...(usage ? { usage } : {}),
	};
}

function errorResult(error: unknown, kind: AccountingKind, parentSessionId: string): AgentToolResult<AccountingDetails> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: accountingDetails(kind, parentSessionId, []),
		isError: true,
	};
}

async function waitForFinalSnapshot(handle: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshot = readUsageSnapshot(runDirFor(handle, env));
		if (snapshot?.final && snapshot.runHandle === handle) return;
		if (Date.now() >= deadline) throw new Error(`run ${handle} did not publish a final usage snapshot before stop`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export function registerAccountingTools(pi: ExtensionAPI, deps: AccountingToolDeps = {}): void {
	const observer = new UsageObserver(deps.env);
	const launch = deps.spawn ?? ((options: SpawnOptions) => spawnRun(options, { env: deps.env }));
	const wait = deps.wait ?? ((handles: string[], options: WaitOptions) => waitRuns(handles, options, { env: deps.env }));
	const stop = deps.stop ?? ((handle: string, options: StopOptions) => stopRun(handle, options, { env: deps.env }));
	const describe = deps.describe ?? ((handle: string) => describeRun(handle, { env: deps.env }));
	const remove = deps.remove ?? ((handle: string) => removeRun(handle, deps.env));
	const finalizationTimeoutMs = deps.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_WAIT_MS;

	pi.on("session_start", (_event, ctx) => {
		observer.restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		observer.restore(ctx);
	});

	pi.registerTool({
		name: "rex_spawn",
		label: "Rex subagent spawn",
		description: "Launch a direct Rex child with durable parent-side usage accounting.",
		parameters: Type.Object({
			prompt: Type.String(),
			name: Type.Optional(Type.String()),
			cwd: Type.Optional(Type.String()),
			provider: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.String()),
			theme: Type.Optional(Type.String()),
			tools: Type.Optional(Type.String()),
			excludeTools: Type.Optional(Type.String()),
			group: Type.Optional(Type.String()),
			batch: Type.Optional(Type.String()),
			allowNested: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			const env = deps.env ?? process.env;
			let spawned: SpawnResult | undefined;
			try {
				spawned = await launch({
					prompts: [params.prompt],
					files: [],
					cwd: params.cwd ?? ctx.cwd,
					name: params.name,
					provider: params.provider,
					model: params.model,
					thinking: params.thinking,
					theme: params.theme,
					tools: params.tools,
					excludeTools: params.excludeTools,
					group: params.group,
					batch: params.batch,
					allowNested: params.allowNested,
					parentSessionId,
				});
				const details = await observer.recordSpawn(parentSessionId, spawned.handle);
				return textResult(`Spawned Rex subagent ${spawned.handle}. Use rex_wait or rex_observe before accepting its result.`, details);
			} catch (error) {
				if (!spawned) return errorResult(error, "spawn", parentSessionId);
				const baselineError = error instanceof Error ? error.message : String(error);
				let preservationError: string | undefined;
				try {
					const retained = updateRecord(
						spawned.handle,
						{ usageBaselineError: `accounting baseline failed after launch: ${baselineError}` },
						env,
					);
					if (!retained) throw new Error("run record is unavailable");
				} catch (recordError) {
					preservationError = recordError instanceof Error ? recordError.message : String(recordError);
				}

				let rollbackError: string | undefined;
				try {
					const rollback = await stop(spawned.handle, { remove: false });
					if (!rollback.stopped) throw new Error(rollback.detail ?? "stop could not be confirmed");
				} catch (error) {
					rollbackError = error instanceof Error ? error.message : String(error);
				}
				const preservation = preservationError ? ` Run-record diagnostic could not be persisted: ${preservationError}.` : "";
				if (rollbackError) {
					return errorResult(
						new Error(
							`Rex subagent ${spawned.handle} launched, but its accounting baseline failed: ${baselineError}. ` +
								`Rollback failed: ${rollbackError}. The child may still be running without a baseline; explicit management of ${spawned.handle} is required.${preservation}`,
						),
						"spawn",
						parentSessionId,
					);
				}
				return errorResult(
					new Error(
						`Rex subagent ${spawned.handle} launched, but its accounting baseline failed: ${baselineError}. ` +
							`The child was stopped and its records retained for explicit recovery; no usage was charged and the failed spawn cannot be adopted.${preservation}`,
					),
					"spawn",
					parentSessionId,
				);
			}
		},
	});

	pi.registerTool({
		name: "rex_wait",
		label: "Rex subagent wait",
		description: "Wait for Rex children, then observe every requested handle for newly published usage.",
		parameters: Type.Object({
			handles: Type.Array(Type.String(), { minItems: 1 }),
			timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
			any: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			let outcomes: WaitResult[] | undefined;
			try {
				const handles = [...new Set(params.handles)];
				// Ownership and replay integrity must be valid before waiting. A
				// missing baseline is decided only after terminal/missing evidence
				// exists; ordinary observations still enforce it below.
				await observer.validate(parentSessionId, handles, { allowMissingBaseline: true });
				outcomes = await wait(handles, { timeoutMs: params.timeoutMs, mode: params.any ? "any" : "all" });
				const terminalHandles = outcomes.filter((outcome) => isTerminalDisplayState(outcome.state)).map((outcome) => outcome.handle);
				const observed = await observer.observe(parentSessionId, handles, { allowMissingSnapshotFor: terminalHandles });
				const missing = observed.details.runs.filter((run) => run.snapshot === "missing");
				return textResult(
					JSON.stringify({
						outcomes,
						...(missing.length > 0
							? {
									diagnostics: missing.map((run) => ({
										handle: run.handle,
										snapshot: "missing",
										finalization: "unconfirmed",
										detail: "terminal owned run had no usage snapshot; zero is bookkeeping only and unknown history was not charged",
									})),
								}
							: {}),
					}),
					observed.details,
					observed.usage,
				);
			} catch (error) {
				// Lifecycle outcomes are the run's terminal state; a failed usage
				// observation must not hide them, exactly as rex_stop preserves its
				// stop outcome alongside an accounting error.
				const message = error instanceof Error ? error.message : String(error);
				const lifecycle = outcomes ? `\n${JSON.stringify({ outcomes })}` : "";
				return errorResult(new Error(`${message}${lifecycle}`), "observation", parentSessionId);
			}
		},
	});

	pi.registerTool({
		name: "rex_stop",
		label: "Rex subagent stop",
		description: "Stop a Rex child, collect its durable usage, and remove records only after accounting succeeds.",
		parameters: Type.Object({
			handle: Type.String(),
			remove: Type.Optional(Type.Boolean()),
			killSession: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			const env = deps.env ?? process.env;
			let stopOutcome: StopResult | undefined;
			try {
				await observer.validate(parentSessionId, [params.handle], { allowMissingBaseline: true });
				const existing = readRecord(params.handle, env);
				const before = await describe(params.handle).catch(() => undefined);
				const state = before?.state;
				const provablyTerminal = state !== undefined && isTerminalDisplayState(state);
				// Only a reliably live pre-stop state may persist the finalization
				// requirement. A describe failure or an "unknown" display state is
				// undeterminable: it fails closed for this attempt but must not
				// poison later collection of a provably dead child.
				const reliablyLive = state !== undefined && !provablyTerminal && state !== "unknown";
				const missingSnapshot = !existsSync(usageSnapshotPath(runDirFor(params.handle, env)));
				// Preserve fail-before-stop behavior for an unadopted run with a
				// snapshot and for every live run. Only terminal absence can use
				// the explicit zero-observation recovery cursor.
				await observer.validate(parentSessionId, [params.handle], {
					allowMissingBaseline: provablyTerminal && missingSnapshot,
				});
				// A live stop must finalize before close. Once the pre-stop process
				// state is provably terminal, however, no later final can arrive and
				// an existing marker must not make the durable remainder uncollectible.
				const requireFinal = !provablyTerminal;
				const hasFinalizationMarker = existing?.usageFinalizationRequired === true || (requireFinal && reliablyLive);
				if (requireFinal && reliablyLive && existing?.usageFinalizationRequired !== true) {
					if (!updateRecord(params.handle, { usageFinalizationRequired: true }, env)) {
						throw new Error(`no Rex subagent with handle ${params.handle}`);
					}
				}
				stopOutcome = await stop(params.handle, {
					remove: false,
					killSession: params.killSession,
					beforeClose: requireFinal ? () => waitForFinalSnapshot(params.handle, env, finalizationTimeoutMs) : undefined,
				});
				if (!stopOutcome.stopped) throw new Error(stopOutcome.detail ?? `could not confirm stop for ${params.handle}`);
				const observed = await observer.observe(parentSessionId, [params.handle], {
					requireFinal,
					allowUnconfirmedFinal: provablyTerminal,
					allowMissingSnapshotFor: provablyTerminal ? [params.handle] : [],
				});
				let finalizationMarkerError: string | undefined;
				if (hasFinalizationMarker) {
					try {
						if (!updateRecord(params.handle, { usageFinalizationRequired: undefined }, env)) {
							throw new Error("run record is unavailable");
						}
					} catch (error) {
						// The observation is already committed. Preserve its Usage and
						// cursors while surfacing the remaining management problem.
						finalizationMarkerError = error instanceof Error ? error.message : String(error);
					}
				}
				let removalError: string | undefined;
				if (params.remove) {
					try {
						remove(params.handle);
					} catch (error) {
						// Accounting already succeeded. Return its Usage and cursors so a
						// removal error cannot hide them from durable branch replay.
						removalError = error instanceof Error ? error.message : String(error);
					}
				}
				// The lifecycle stop ran with remove:false, so its own removed flag is
				// always false. Report the final end state in both places: the model
				// must never see stopOutcome.removed contradict the top-level removed.
				const removed = params.remove === true && removalError === undefined;
				return textResult(
					JSON.stringify({
						stopped: { ...stopOutcome, removed },
						removed,
						...(observed.details.runs[0]?.finalization
							? { finalization: observed.details.runs[0].finalization }
							: {}),
						...(observed.details.runs[0]?.snapshot
							? {
									snapshot: observed.details.runs[0].snapshot,
									diagnostic:
										"terminal owned run had no usage snapshot; zero is bookkeeping only and unknown history was not charged",
								}
							: {}),
						...(finalizationMarkerError ? { finalizationMarkerError } : {}),
						...(removalError ? { removalError } : {}),
					}),
					observed.details,
					observed.usage,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const outcome = stopOutcome ? `\n${JSON.stringify({ stopped: stopOutcome })}` : "";
				return errorResult(new Error(`${message}${outcome}`), "observation", parentSessionId);
			}
		},
	});

	pi.registerTool({
		name: "rex_adopt",
		label: "Rex subagent adopt",
		description: "Adopt an unowned or same-parent CLI-created Rex run at its current usage snapshot.",
		parameters: Type.Object({ handle: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			try {
				const details = await observer.adopt(parentSessionId, params.handle);
				return textResult(`Adopted Rex subagent ${params.handle} at its current usage baseline.`, details);
			} catch (error) {
				return errorResult(error, "adoption", parentSessionId);
			}
		},
	});

	pi.registerTool({
		name: "rex_observe",
		label: "Rex subagent observe",
		description: "Observe direct Rex children and return only newly observed model usage.",
		parameters: Type.Object({ handles: Type.Array(Type.String(), { minItems: 1 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			try {
				const observed = await observer.observe(parentSessionId, params.handles);
				return textResult(`Observed ${observed.details.runs.length} Rex subagent(s).`, observed.details, observed.usage);
			} catch (error) {
				return errorResult(error, "observation", parentSessionId);
			}
		},
	});
}
