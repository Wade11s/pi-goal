/**
 * Test-only Pi extension: a second extension that proposes its own boundary
 * entries at `agent_before_settle`.
 *
 * Loaded after pi-goal so it observes pi-goal's proposal in `event.entries`. It
 * exists to prove that pi-goal chains with other extensions instead of replacing
 * their proposals, and that two continuation requests still produce exactly one
 * further provider request.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PEER_CUSTOM_TYPE = "peer-boundary";

export default function boundaryPeerExtension(pi: ExtensionAPI): void {
	// Guarded exactly like pi-goal is: an unconditional `continue: true` is
	// re-evaluated after the next response and spins forever, which is why both
	// extensions refuse to continue an aborted or errored run.
	pi.on("agent_before_settle", async (event) => {
		if (event.outcome !== "completed") return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: PEER_CUSTOM_TYPE,
					content: "peer boundary note",
					display: true,
				},
			],
			continue: true,
		};
	});
}
