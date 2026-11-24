/**
 * Test-only Pi extension: takes `update_plan` out of the model's active loadout.
 *
 * The plan tool's half of `propose-goal-deactivate-peer.ts`. Loaded after pi-goal,
 * so it runs after the registration and removes the name from the active loadout
 * while the declaration stays in the registry. A Continuation that gated on the
 * registry alone would keep naming a tool the model cannot call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function planDeactivatePeer(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "update_plan"));
	});
}
