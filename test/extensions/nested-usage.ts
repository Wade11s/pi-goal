/**
 * Test-only Pi extension: a tool that performs nested model work through
 * `ctx.executeTool()`.
 *
 * It exists to make Pi's *reported nested usage* observable end to end. A nested
 * call is not persisted as its own message: Pi folds its usage into the calling
 * tool result's `usage` (`NestedToolCallRunner`), which is exactly the shape a
 * real accounting path has to deduplicate. Charging the parent result once is
 * therefore what keeps nested work from being counted twice, and these fixtures
 * let the RPC tests prove it against real Pi behavior rather than a mock.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync } from "node:fs";

/** Leaf tool: reports its own model usage, like a tool that calls a model. */
export const NESTED_LEAF_TOOL = "nested_usage_leaf";
/** Outer tool: calls the leaf tool through `ctx.executeTool()`. */
export const NESTED_OUTER_TOOL = "nested_usage_outer";
/**
 * Outer tool that holds its call until a gate file exists, then performs the same
 * nested model work. It exists to reproduce the ordering that breaks accounting:
 * a Goal created (by `/goal` or by `create_goal`) while this tool is still in
 * flight commits its creation snapshot *before* the tool result lands, so the
 * turn's own assistant `message_end` predates the Goal while its tool result does
 * not. The gate path comes from `PI_GOAL_TEST_GATE`; without it the tool never
 * blocks, so an unrelated test that somehow reaches it still terminates.
 */
export const NESTED_GATED_TOOL = "nested_usage_gated";

/** Poll for the gate file, released early by an abort. */
async function waitForGate(signal: AbortSignal | undefined): Promise<void> {
	const gate = process.env.PI_GOAL_TEST_GATE;
	if (!gate) return;
	await new Promise<void>((resolve) => {
		const poll = () => {
			if (existsSync(gate)) {
				resolve();
				return;
			}
			setTimeout(poll, 5);
		};
		signal?.addEventListener("abort", () => resolve());
		poll();
	});
}

/** Usage the leaf reports. Cached reads dominate on purpose: they must not count. */
export const NESTED_LEAF_USAGE: Usage = {
	input: 40,
	output: 7,
	cacheRead: 100,
	cacheWrite: 3,
	reasoning: 4,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The accounted contribution of the nested usage: 40 + 7 + 3, cache read excluded. */
export const NESTED_LEAF_ACCOUNTED = 50;

function emptyCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export default function nestedUsageExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: NESTED_LEAF_TOOL,
		label: "Nested Usage Leaf",
		description: "Test-only leaf tool that reports model usage of its own.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "nested leaf done" }],
				details: { leaf: true },
				usage: { ...NESTED_LEAF_USAGE, cost: emptyCost() },
			};
		},
	});

	pi.registerTool({
		name: NESTED_OUTER_TOOL,
		label: "Nested Usage Outer",
		description: "Test-only tool that calls the leaf tool through ctx.executeTool().",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool(NESTED_LEAF_TOOL, {});
			return {
				content: [{ type: "text", text: `nested outer done (${outcome.isError ? "error" : "ok"})` }],
				details: { outer: true },
			};
		},
	});

	pi.registerTool({
		name: NESTED_GATED_TOOL,
		label: "Nested Usage Gated",
		description: "Test-only tool that waits for a gate file, then performs nested model work.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			await waitForGate(signal);
			const outcome = await ctx.executeTool(NESTED_LEAF_TOOL, {});
			return {
				content: [{ type: "text", text: `nested gated done (${outcome.isError ? "error" : "ok"})` }],
				details: { gated: true },
			};
		},
	});
}
