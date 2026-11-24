/**
 * Test-only Pi extension: takes `propose_goal` out of the model's active loadout.
 *
 * Loaded *after* pi-goal, so its `session_start` runs after pi-goal has registered
 * the tool, and it then calls `pi.setActiveTools()` without that name. The
 * declaration stays in the registry — `getAllTools()` still lists it — so a rule
 * that only asks the registry would keep promising a tool the model can no longer
 * call: `/goal` would record and send an interview whose confirmation could never
 * be opened.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function proposeGoalDeactivatePeer(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "propose_goal"));
	});
}
