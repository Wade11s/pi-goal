/**
 * Test-only Pi extension: the Goal-metrics seam's fake local consumer/exporter.
 *
 * It subscribes to pi-goal's `pi-goal:metrics` channel on Pi's shared extension
 * event bus — the pre-redacted projection any local consumer or companion
 * exporter receives — and records each metric as a `goal-metrics-log` custom
 * session entry. The log entry pairs the metric with the process-wide count of
 * `fetch` attempts observed *at emission time*, so a test can prove that
 * pi-goal's default path performed no network I/O while it produced the metric.
 *
 * `/netcheck` appends a `net-probe` entry with every URL the process attempted
 * to fetch, which is the standing proof for the whole scenario rather than one
 * moment of it. The spy wraps the host's own `fetch` instead of replacing it, so
 * it would not hide a call the host actually makes.
 *
 * `/metricsfail <kind>` arms an injected consumer failure for one transition
 * kind. The consumer records the metric first and then throws, which is what the
 * failure-isolation regression needs: the metric was delivered, the throw cannot
 * roll the committed transition back, and the bus's own diagnostics surface the
 * failure without pi-goal reporting a false durability problem.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_METRICS_LOG_TYPE = "goal-metrics-log";
export const NET_PROBE_LOG_TYPE = "net-probe";
export const GOAL_METRICS_CHANNEL = "pi-goal:metrics";

export default function metricsPeerExtension(pi: ExtensionAPI): void {
	let failOnKind: string | null = null;

	// Watch the process's fetch without changing its behavior: a call is counted
	// and then forwarded to the host's real implementation.
	const calls: string[] = [];
	const host = globalThis as { fetch?: (input: unknown, init?: unknown) => unknown };
	const originalFetch = host.fetch;
	if (typeof originalFetch === "function") {
		host.fetch = (input: unknown, init?: unknown) => {
			try {
				calls.push(String(input));
			} catch {
				calls.push("<unstringifiable>");
			}
			return originalFetch(input, init);
		};
	}

	pi.registerCommand("metricsfail", {
		description: "Test helper: make the Goal-metrics consumer throw for one transition kind",
		handler: async (args, ctx) => {
			failOnKind = args.trim() || null;
			ctx.ui.notify(
				failOnKind === null ? "metricsfail disarmed" : `metricsfail armed for ${failOnKind}`,
				"info",
			);
		},
	});

	pi.registerCommand("netcheck", {
		description: "Test helper: record every fetch attempt the process has made",
		handler: async (_args, ctx) => {
			try {
				pi.appendEntry(NET_PROBE_LOG_TYPE, { calls: [...calls] });
			} catch {
				// Recording is best effort; the assertions read the session file.
			}
			ctx.ui.notify(`fetch attempts: ${calls.length}`, "info");
		},
	});

	pi.events.on(GOAL_METRICS_CHANNEL, (data) => {
		const kind = (data as { kind?: unknown } | null | undefined)?.kind;
		try {
			pi.appendEntry(GOAL_METRICS_LOG_TYPE, { fetchCalls: calls.length, metrics: data });
		} catch {
			// Recording is best effort; the assertions read the session file.
		}
		if (failOnKind !== null && kind === failOnKind) {
			throw new Error(`metrics-peer injected consumer failure for ${String(kind)}`);
		}
	});
}
