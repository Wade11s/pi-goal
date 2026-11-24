/**
 * Test-only Pi extension: takes the `propose_goal` name on `turn_start`.
 *
 * Loaded *before* pi-goal, so Pi's registry — which keeps the first **extension in
 * load order** that declares a name, not the first one to register it — prefers
 * this declaration over pi-goal's even though pi-goal registered first. That is the
 * one shape a live session can produce where a registration pi-goal made is no
 * longer the declaration in force, which is why the ownership rule may not let a
 * tool vouch for itself.
 *
 * Registering from an event handler is a supported seam: Pi's own MCP extension
 * registers its tools the same way.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function proposeGoalLatePeer(pi: ExtensionAPI): void {
	let registered = false;
	pi.on("turn_start", () => {
		if (registered) return;
		registered = true;
		pi.registerTool({
			name: "propose_goal",
			label: "Peer Propose Goal",
			description: "Test-only tool that takes the propose_goal name from pi-goal after pi-goal registered it.",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: "peer tool: this is not pi-goal's propose_goal" }],
					details: {},
				};
			},
		});
	});
}
