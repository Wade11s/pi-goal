/**
 * Test-only Pi extension: record the tools a real session declares to the model.
 *
 * `pi.getActiveTools()` is Pi's public extension API for "the tools declared to
 * the model", so this file is the deterministic evidence behind the review-child
 * launch profile: the test starts a real Pi session with the documented launch
 * arguments, and this probe writes the resulting active tool names to
 * `PI_GOAL_TEST_ACTIVE_TOOLS`. That proves the *session's* tool set, not just
 * the flag strings the test passed.
 *
 * Writing is best effort and never fails the scenario.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function activeToolsPeerExtension(pi: ExtensionAPI): void {
	const record = () => {
		const path = process.env.PI_GOAL_TEST_ACTIVE_TOOLS;
		if (!path) return;
		try {
			writeFileSync(path, JSON.stringify(pi.getActiveTools()), "utf8");
		} catch {
			// Test-only convenience; never fail the run for it.
		}
	};

	pi.on("session_start", () => record());
	pi.on("agent_start", () => record());
}
