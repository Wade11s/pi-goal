/**
 * Test-only Pi extension: a second extension that proposes its own boundary
 * entries at `agent_before_settle`.
 *
 * It exists to prove how pi-goal composes with other extensions at the same
 * boundary, in both load orders:
 *
 * - loaded after pi-goal, it observes pi-goal's proposal in `event.entries` and
 *   must preserve it;
 * - loaded before pi-goal, pi-goal must preserve *its* proposal.
 *
 * The peer is deliberately bounded independently of any Goal: it stops after
 * `MAX_PEER_CONTINUATIONS` completed outcomes, whatever the Goal is doing. That
 * keeps the fixture honest (an unbounded `continue: true` spins forever, which is
 * exactly the defect Pi's docs warn about) and keeps the loop bounded by the peer
 * rather than by a scripted-provider error.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PEER_CUSTOM_TYPE = "peer-boundary";
export const PEER_NOTE = "peer boundary note";
/** Independent bound on this fixture's own continuation requests. */
export const MAX_PEER_CONTINUATIONS = 2;

export default function boundaryPeerExtension(pi: ExtensionAPI): void {
	let peerContinuations = 0;

	pi.on("agent_before_settle", async (event) => {
		// Guarded on the outcome exactly like pi-goal is: an aborted or errored run
		// is a hard exit, so continuing it would be an unattended retry loop.
		if (event.outcome !== "completed") return;
		if (peerContinuations >= MAX_PEER_CONTINUATIONS) return;
		peerContinuations += 1;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: PEER_CUSTOM_TYPE,
					content: PEER_NOTE,
					display: true,
				},
			],
			continue: true,
		};
	});
}
