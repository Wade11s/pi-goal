/**
 * Test-only Pi extension: the authority seam's negative and positive controls.
 *
 * It exists so the batch-4 RPC tests can drive the exact sources the creation
 * authority contract distinguishes, without relying on a real model to produce
 * them:
 *
 * - `/sendcustom <text>` sends a Pi custom message with `triggerTurn`, which is
 *   an accepted authority source of any customType;
 * - `/senduser <text>` calls `pi.sendUserMessage()`, which is an
 *   extension-originated user message and must never acquire human-user
 *   authority;
 * - `/transform <text>` makes the extension's `input` handler rewrite every
 *   later raw prompt to `<text>`, which is transformed prompt text and must not
 *   become evidence (pi-goal's own `input` handler runs first and captures the
 *   raw text);
 * - `/systeminstruction <text>` appends a standing system-prompt instruction,
 *   which must not authorize a specific Goal.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AUTHORITY_CUSTOM_TYPE = "authority-test";

let transformedInput: string | null = null;
let systemInstruction: string | null = null;

export default function authorityPeerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("sendcustom", {
		description: "Test helper: send a Pi custom message that starts a run",
		handler: async (args, ctx) => {
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("sendcustom: a message is required", "error");
				return;
			}
			await pi.sendMessage(
				{ customType: AUTHORITY_CUSTOM_TYPE, content, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("senduser", {
		description: "Test helper: send an extension-originated user message",
		handler: async (args, ctx) => {
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("senduser: a message is required", "error");
				return;
			}
			await pi.sendUserMessage(content);
		},
	});

	pi.registerCommand("transform", {
		description: "Test helper: transform subsequent raw input",
		handler: async (args, ctx) => {
			transformedInput = args.trim();
			ctx.ui.notify(`transform set to ${JSON.stringify(transformedInput)}`, "info");
		},
	});

	pi.registerCommand("systeminstruction", {
		description: "Test helper: append a standing system-prompt instruction",
		handler: async (args, ctx) => {
			systemInstruction = args.trim();
			ctx.ui.notify("system instruction set", "info");
		},
	});

	// Loaded as an extra extension (after pi-goal), so this handler runs after
	// pi-goal's own `input` handler has captured the raw text. The transform is
	// therefore a transformation of the prompt the model sees, not of the raw
	// input the authority is checked against.
	pi.on("input", (event) => {
		if (transformedInput !== null) return { action: "transform", text: transformedInput };
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		if (systemInstruction === null) return;
		event.systemPromptOptions.appendSystemPrompt = [
			event.systemPromptOptions.appendSystemPrompt,
			systemInstruction,
		]
			.filter(Boolean)
			.join("\n\n");
	});
}
