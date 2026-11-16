/**
 * Prepare a copy of an immutable 0.1.0 session fixture for a real Pi run.
 *
 * The fixtures were captured on macOS, and their session header records the
 * throwaway working directory of the run that produced them. Pi refuses to resume
 * a session whose stored working directory is missing, and that macOS path cannot
 * be recreated on another OS, so the *copy* gets the current temp cwd instead.
 *
 * Only the header line changes. The `goal-state` entries, their order, and every
 * other line stay byte-identical, so the 0.1.0 state under test is untouched and
 * the fixture file itself is never rewritten.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

export function prepareLegacySession(fixturePath, sessionFile, cwd) {
	copyFileSync(fixturePath, sessionFile);
	const lines = readFileSync(sessionFile, "utf8").split("\n");
	const header = JSON.parse(lines[0]);
	header.cwd = cwd;
	lines[0] = JSON.stringify(header);
	writeFileSync(sessionFile, lines.join("\n"));
}
