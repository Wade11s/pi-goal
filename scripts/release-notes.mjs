#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section for one version, as a GitHub Release body.
 *
 * Usage: node scripts/release-notes.mjs <version> [changelog-path]
 *
 * Recognized headings:
 *   ## [1.2.3]
 *   ## [1.2.3] - 2026-01-01
 *   ## 1.2.3 - 2026-01-01
 *
 * The section ends at the next level-2 heading. A missing or empty entry is an
 * error: the release workflow must not publish without notes.
 */
import { readFileSync } from "node:fs";

const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
if (!version) {
	console.error("usage: node scripts/release-notes.mjs <version> [changelog-path]");
	process.exit(1);
}

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^##\\s+(?:\\[${escaped}\\]|${escaped})(?:\\s|$)`);
const lines = readFileSync(file, "utf8").split(/\r?\n/);

let start = -1;
for (let i = 0; i < lines.length; i += 1) {
	if (heading.test(lines[i])) {
		start = i + 1;
		break;
	}
}
if (start === -1) {
	console.error(`no CHANGELOG entry for ${version} in ${file}`);
	process.exit(1);
}

let end = lines.length;
for (let i = start; i < lines.length; i += 1) {
	if (/^##\s/.test(lines[i])) {
		end = i;
		break;
	}
}

const notes = lines.slice(start, end).join("\n").trim();
if (!notes) {
	console.error(`CHANGELOG entry for ${version} in ${file} is empty`);
	process.exit(1);
}

process.stdout.write(`${notes}\n`);
