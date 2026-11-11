/**
 * Issue #8 acceptance test: the package installs through Pi's documented
 * package workflow (`pi install <local-path>`), is recorded in the agent
 * settings, and is visible to `pi list`.
 *
 * The install is isolated in a temporary PI_CODING_AGENT_DIR so the user's real
 * Pi settings are never modified.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PI_BINARY = process.env.PI_BINARY ?? "pi";

test("the package installs through Pi's documented package workflow", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-goal-install-"));
	try {
		const install = spawnSync(PI_BINARY, ["install", repoRoot], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
		});
		assert.equal(install.status, 0, `pi install failed:\n${install.stdout}\n${install.stderr}`);

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.ok(Array.isArray(settings.packages), "settings declare a packages array");
		const declared = settings.packages[0];
		assert.ok(typeof declared === "string" && declared.length > 0, "the package source was recorded");
		assert.equal(realpathSync(resolve(agentDir, declared)), realpathSync(repoRoot));

		const list = spawnSync(PI_BINARY, ["list"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
		});
		assert.equal(list.status, 0, `pi list failed:\n${list.stdout}\n${list.stderr}`);
		assert.ok(
			list.stdout.includes(realpathSync(repoRoot)),
			`the installed package is not listed:\n${list.stdout}`,
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
