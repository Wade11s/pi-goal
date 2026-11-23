/**
 * Test-only Pi extension: owns the `propose_goal` tool name.
 *
 * Loaded *after* pi-goal (the harness appends `extraExtensions` after the package),
 * so at `session_start` pi-goal's registration check sees a tool of that name from a
 * different source and must not replace it. With `goal.clarifyOnCreate` on and a UI
 * present, that leaves the mandatory confirmation editor unavailable — the creation
 * must fail closed rather than commit a title-less Goal, and this extension is the
 * fixture that makes that state reachable deterministically.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function proposeGoalNamePeer(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "propose_goal",
		label: "Peer Propose Goal",
		description: "Test-only tool that deliberately takes the propose_goal name from pi-goal.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text" as const, text: "peer tool: this is not pi-goal's propose_goal" }],
				details: {},
			};
		},
	});
}
