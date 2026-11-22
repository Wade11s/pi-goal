/** Issue #45 fixture administration for the deterministic public-tool provider. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_USAGE, RpcConformanceSession } from "./subagent-usage-conformance.mjs";

const EXTENSION = fileURLToPath(new URL("../extensions/usage-conformance-fake.ts", import.meta.url));
const SOURCE = "pi-goal-deterministic-subagent";

function writeJson(path, value) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function snapshotPath(root, runId) {
	return join(root, runId, "snapshot.json");
}

export async function startFakeConformanceProvider() {
	const root = mkdtempSync(join(tmpdir(), "pi-goal-fake-subagent-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const rpc = new RpcConformanceSession({
		agentDir,
		extraExtensions: [EXTENSION],
		env: { PI_GOAL_FAKE_SUBAGENT_DIR: root },
		toolNames: {
			spawn: "usage_fake_spawn",
			adopt: "usage_fake_adopt",
			observe: "usage_fake_observe",
			stop: "usage_fake_stop",
		},
	});
	await rpc.start();
	const provider = {
		source: SOURCE,
		rpc,
		spawn: (name) => rpc.spawn(name),
		observe: (handles) => rpc.observe(handles),
		observeConcurrent: (groups) => rpc.observeConcurrent(groups),
		adopt: (handle) => rpc.adopt(handle),
		stop: (handle) => rpc.stop(handle),
		restart: () => rpc.restart(),
		assertRestartWasFree: () => rpc.assertRestartWasFree(),
		baselineEntryId: (handle) => rpc.baselineEntryId(handle),
		navigate: (entryId) => rpc.navigate(entryId),
		async snapshot(runId) {
			return JSON.parse(readFileSync(snapshotPath(root, runId), "utf8"));
		},
		async publish(runId, snapshot) {
			writeJson(snapshotPath(root, runId), snapshot);
		},
		async createUnowned(runId, usage) {
			writeJson(join(root, runId, "record.json"), { runId, parentSessionId: null, activeElapsedMs: 987654 });
			writeJson(snapshotPath(root, runId), {
				version: 1,
				source: SOURCE,
				runId,
				parentSessionId: null,
				childSessionId: `${runId}-child`,
				childSessionGeneration: `${runId}-generation`,
				sequence: 1,
				usage,
				final: false,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
			return runId;
		},
		async prepareFinal(runId) {
			const snapshot = await provider.snapshot(runId);
			await provider.publish(runId, { ...snapshot, sequence: 2, usage: FIRST_USAGE });
		},
		async hasRun(runId) {
			return existsSync(join(root, runId));
		},
		async close() {
			await rpc.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
	return provider;
}
