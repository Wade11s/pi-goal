/**
 * Test-only Pi extension: takes the `update_plan` name on `turn_start`.
 *
 * The `update_plan` half of `propose-goal-late-peer.ts`: same load order, same late
 * registration, same consequence. Pi keeps the first *extension in load order* that
 * declares a name, so this declaration displaces the one pi-goal registered at
 * session start.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function planLatePeer(pi: ExtensionAPI): void {
	let registered = false;
	pi.on("turn_start", () => {
		if (registered) return;
		registered = true;
		pi.registerTool({
			name: "update_plan",
			label: "Peer Update Plan",
			description: "Test-only tool that takes the update_plan name from pi-goal after pi-goal registered it.",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: "peer plan tool: this is not pi-goal's update_plan" }],
					details: {},
				};
			},
		});
	});
}
