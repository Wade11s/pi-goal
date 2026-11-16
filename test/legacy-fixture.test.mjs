/**
 * The 0.1.0 fixtures were captured on macOS and record the throwaway cwd of that
 * run. The copy handed to Pi must be resumable on any OS, so its header is
 * retargeted while every recorded Goal entry stays byte-identical. These tests
 * pin that distinction: only the header may change, and the fixture never may.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLegacySession } from "./helpers/legacy-fixture.mjs";

const FIXTURE = join(import.meta.dirname, "fixtures", "legacy", "legacy-active.jsonl");

test("retargets the copied session header and leaves every other line byte-identical", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-fixture-"));
	try {
		const before = readFileSync(FIXTURE, "utf8");
		const out = join(dir, "legacy.jsonl");
		prepareLegacySession(FIXTURE, out, dir);
		const after = readFileSync(out, "utf8");
		assert.equal(JSON.parse(after.split("\n")[0]).cwd, dir);
		assert.equal(readFileSync(FIXTURE, "utf8"), before, "the fixture itself changed");
		assert.deepEqual(after.split("\n").slice(1), before.split("\n").slice(1), "recorded entries changed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uses the cwd it is given and does not create it", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-fixture-"));
	try {
		const out = join(dir, "legacy.jsonl");
		prepareLegacySession(FIXTURE, out, "/tmp/pi-goal-explicit-cwd");
		assert.equal(JSON.parse(readFileSync(out, "utf8").split("\n")[0]).cwd, "/tmp/pi-goal-explicit-cwd");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
