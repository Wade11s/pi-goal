/**
 * Test-only Pi extension: drives real Pi tree navigation from RPC tests.
 *
 * The RPC protocol has no tree-navigation command (the interactive /tree screen
 * owns it interactively), so branch-switch tests need an extension command that
 * calls the same `ctx.navigateTree()` API the interactive mode uses. The command
 * is a thin passthrough: it never edits state itself, which keeps every
 * assertion about branch-aware Goal reconstruction pointed at real Pi and real
 * pi-goal behavior rather than at this helper.
 *
 * Commands:
 *   /nav <entryId> [summarize]   Navigate the session tree to an entry id.
 *                                Optional second token "summarize" asks Pi for a
 *                                branch summary (exercises the summary path).
 *   /navleaf                     Report the current leaf entry id (sanity checks).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function treeNavExtension(pi: ExtensionAPI): void {
	pi.registerCommand("nav", {
		description: "Test helper: navigate the session tree to an entry id",
		handler: async (args, ctx) => {
			const trimmed = args.trim().split(/\s+/);
			const targetId = trimmed[0] ?? "";
			const summarize = trimmed[1] === "summarize";
			if (!targetId) {
				ctx.ui.notify("nav: an entry id is required", "error");
				return;
			}
			try {
				const result = await ctx.navigateTree(targetId, { summarize });
				ctx.ui.notify(
					result.cancelled ? `nav: navigation to ${targetId} was cancelled` : `nav: navigated to ${targetId}`,
					result.cancelled ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(`nav failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
	pi.registerCommand("navleaf", {
		description: "Test helper: report the current session leaf entry id",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`navleaf: ${ctx.sessionManager.getLeafId() ?? "null"}`, "info");
		},
	});
}
