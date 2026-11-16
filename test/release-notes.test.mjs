/**
 * The release workflow publishes only when CHANGELOG.md has a section for the
 * tagged version, and uses that section as the GitHub Release body. These tests
 * pin the extraction rules so a release cannot silently ship empty or
 * wrong-version notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/release-notes.mjs", import.meta.url));

const CHANGELOG = `# Changelog

Release notes for @wade11s/pi-goal.

## [0.1.2] - 2026-02-01

- Added a thing.
- Fixed another thing.

## [0.1.1]

- Middle release.
- Spans
  multiple lines.

## 0.1.0 - 2026-01-01

- First release.

## [0.1.10] - 2026-03-01

- Later release that must not be matched as 0.1.1.
`;

function run(args, changelog = CHANGELOG) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-notes-"));
	try {
		const file = join(dir, "CHANGELOG.md");
		writeFileSync(file, changelog);
		return spawnSync(process.execPath, [script, ...args, file], { encoding: "utf8" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("extracts a bracketed dated section up to the next heading", () => {
	const result = run(["0.1.2"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "- Added a thing.\n- Fixed another thing.\n");
});

test("extracts an undated bracketed section", () => {
	const result = run(["0.1.1"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "- Middle release.\n- Spans\n  multiple lines.\n");
});

test("extracts an unbracketed dated section", () => {
	const result = run(["0.1.0"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "- First release.\n");
});

test("does not match a longer version that starts with the requested one", () => {
	const result = run(["0.1.1"]);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(!result.stdout.includes("Later release"), "0.1.10 notes leaked into 0.1.1");
});

test("fails when the version has no entry", () => {
	const result = run(["9.9.9"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no CHANGELOG entry for 9\.9\.9/);
	assert.equal(result.stdout, "");
});

test("fails when the entry is empty", () => {
	const result = run(["0.2.0"], "# Changelog\n\n## [0.2.0] - 2026-03-01\n\n## [0.1.0]\n\n- First.\n");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /CHANGELOG entry for 0\.2\.0 .* is empty/);
});

test("fails without a version argument", () => {
	const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /usage:/);
});
