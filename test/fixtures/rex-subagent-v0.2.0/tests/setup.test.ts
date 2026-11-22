import assert from "node:assert/strict";
import { mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { reconcileSetup } from "../src/setup.ts";
import { fakeRunner, result, tempEnv, writeExecutable } from "./helpers.ts";

function writePackage(root: string): void {
	writeExecutable(join(root, "src", "cli.ts"), "#!/usr/bin/env node\n");
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "pi-rex-subagent", bin: { "rex-subagent": "./src/cli.ts" } }),
	);
}

test("concurrent first setup converges on one usable managed link", async () => {
	const fixture = tempEnv();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const runner = fakeRunner(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return result({ code: 0, stdout: "rex-subagent 1.0.0\n" });
		});
		const packageDir = join(fixture.dir, "package");
		writePackage(packageDir);

		const reports = await Promise.all(
			Array.from({ length: 8 }, () => reconcileSetup({ repair: true, packageDir, env, runner })),
		);
		for (const report of reports) assert.equal(report.ok, true, report.message);
		assert.equal(readlinkSync(reports[0].linkPath), realpathSync(join(packageDir, "src", "cli.ts")));
	} finally {
		fixture.cleanup();
	}
});

test("setup reports legacy resources and prevents an old clone from reclaiming the link", async () => {
	const fixture = tempEnv();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const runner = fakeRunner(() => result({ code: 0, stdout: "rex-subagent 1.0.0\n" }));
		const current = join(fixture.dir, "managed-package");
		const legacy = join(fixture.dir, "agent", "extensions", "pi-rex-subagent");
		writePackage(current);
		writePackage(legacy);
		mkdirSync(join(legacy, "skills", "rex-subagent"), { recursive: true });
		mkdirSync(join(fixture.dir, "agent", "skills"), { recursive: true });
		symlinkSync(join(legacy, "skills", "rex-subagent"), join(fixture.dir, "agent", "skills", "rex-subagent"));

		const migrated = await reconcileSetup({ repair: true, packageDir: current, env, runner });
		assert.equal(migrated.status, "created");
		assert.equal(migrated.ok, false);
		assert.deepEqual(migrated.legacyResources, [legacy, join(fixture.dir, "agent", "skills", "rex-subagent")]);
		const currentTarget = readlinkSync(migrated.linkPath);

		const oldCheckout = await reconcileSetup({ repair: true, packageDir: legacy, env, runner });
		assert.equal(oldCheckout.status, "conflict");
		assert.equal(readlinkSync(migrated.linkPath), currentTarget, "the old extension must not reverse the migration");
	} finally {
		fixture.cleanup();
	}
});

test("setup adopts the exact legacy CLI link after its old checkout is moved", async () => {
	const fixture = tempEnv();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const runner = fakeRunner(() => result({ code: 0, stdout: "rex-subagent 1.0.0\n" }));
		const current = join(fixture.dir, "managed-package");
		writePackage(current);
		const link = join(fixture.dir, "agent", "bin", "rex-subagent");
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(join(fixture.dir, "agent", "extensions", "pi-rex-subagent", "src", "cli.ts"), link);

		const report = await reconcileSetup({ repair: true, packageDir: current, env, runner });
		assert.equal(report.status, "repaired");
		assert.equal(readlinkSync(link), realpathSync(join(current, "src", "cli.ts")));
	} finally {
		fixture.cleanup();
	}
});

test("setup repairs a dangling link only when its managed state matches", async () => {
	const fixture = tempEnv();
	try {
		const env = { ...fixture.env, PATH: `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}` };
		const runner = fakeRunner(() => result({ code: 0, stdout: "rex-subagent 1.0.0\n" }));
		const first = join(fixture.dir, "package-v1");
		const second = join(fixture.dir, "package-v2");
		writePackage(first);
		writePackage(second);

		const created = await reconcileSetup({ repair: true, packageDir: first, env, runner });
		assert.equal(created.status, "created");
		rmSync(first, { recursive: true, force: true });

		const repaired = await reconcileSetup({ repair: true, packageDir: second, env, runner });
		assert.equal(repaired.status, "repaired");
		assert.equal(readlinkSync(repaired.linkPath), realpathSync(join(second, "src", "cli.ts")));
	} finally {
		fixture.cleanup();
	}
});
