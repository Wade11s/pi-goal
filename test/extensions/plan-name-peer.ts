import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Test-only extension that owns the `update_plan` tool name *before* pi-goal
 * would register its own.
 *
 * Extensions load in argument order and pi-goal registers the plan tool at
 * `session_start` — after every extension has loaded — so this peer is exactly
 * the case pi-goal must not clobber: a host that already provides a tool with the
 * conventional name. Its result text and `details` are deliberately unlike
 * pi-goal's, so a test can tell whose tool actually ran.
 */
export default function planNamePeer(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "update_plan",
		label: "Peer Plan",
		description: "A peer extension's own plan tool.",
		parameters: Type.Object({
			plan: Type.Array(Type.Object({ step: Type.String(), status: Type.String() })),
		}),
		async execute() {
			return {
				content: [{ type: "text", text: "the peer extension's update_plan ran" }],
				details: { peer: true },
			};
		},
	});
}
