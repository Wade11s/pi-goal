/**
 * Test-only Pi extension: the Goal-updated event seam's observer.
 *
 * It subscribes to pi-goal's local `pi-goal:updated` events on Pi's shared
 * extension event bus — the public stream any local extension would consume —
 * and records every event it receives as a `goal-events-log` custom session
 * entry, so a test can assert payload, coverage, and ordering from the session
 * file alone: the log interleaves with the durable `goal-state` entries in
 * append order, which is exactly the order the transitions committed.
 *
 * `/eventsfail <kind>` arms an injected listener failure for one transition
 * kind. The listener records the event first and then throws, which is what the
 * listener-failure regressions need: the event was delivered, the throw cannot
 * roll the committed transition back, and the bus's own diagnostics surface the
 * failure without pi-goal reporting a false durability problem. `/eventsfail`
 * with no argument disarms it again.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_EVENTS_LOG_TYPE = "goal-events-log";
export const GOAL_UPDATED_CHANNEL = "pi-goal:updated";

export default function eventsPeerExtension(pi: ExtensionAPI): void {
	let failOnKind: string | null = null;

	pi.registerCommand("eventsfail", {
		description: "Test helper: make the Goal-updated listener throw for one transition kind",
		handler: async (args, ctx) => {
			failOnKind = args.trim() || null;
			ctx.ui.notify(
				failOnKind === null ? "eventsfail disarmed" : `eventsfail armed for ${failOnKind}`,
				"info",
			);
		},
	});

	pi.events.on(GOAL_UPDATED_CHANNEL, (data) => {
		const kind = (data as { kind?: unknown } | null | undefined)?.kind;
		try {
			pi.appendEntry(GOAL_EVENTS_LOG_TYPE, data);
		} catch {
			// Recording is best effort; the assertions read the session file.
		}
		if (failOnKind !== null && kind === failOnKind) {
			throw new Error(`events-peer injected listener failure for ${String(kind)}`);
		}
	});
}
