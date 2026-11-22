/**
 * Store-level regressions for Objective attachments (issue #49).
 *
 * These cover the seams a real-Pi RPC test cannot reach cheaply: media-type
 * sniffing, the enforced limits, content-addressed materialization and its
 * idempotence, manifest verification against corruption and loss, and the
 * snapshot-side manifest validation that fails closed on a malformed manifest.
 * Everything observable end to end (model context, events, restart, branches,
 * edit, replacement, rollback, disabled admission, corruption) is covered in
 * `test/goal49-attachments.test.mjs` against a real Pi subprocess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GoalStore } from "../src/store.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/goal.ts";
import {
	artifactPath,
	attachmentStoreRoot,
	discardUncommittedArtifacts,
	goalStoreDir,
	loadAttachments,
	MAX_IMAGE_ATTACHMENT_BYTES,
	MAX_TEXT_ATTACHMENT_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES,
	materializeAttachments,
	sniffImageMediaType,
	storedGoalIds,
	validateAttachmentPath,
	verifyAttachments,
} from "../src/attachments.ts";
import { toGoalUpdatedEvent } from "../src/events.ts";

/** Minimal valid PNG: an 8-byte signature plus a dummy chunk tail. */
const PNG_BYTES = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
]);

/** Minimal JPEG (JFIF SOI + APP0 through a fake EOI). */
const JPEG_BYTES = Buffer.concat([
	Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
	Buffer.from("JFIF-placeholder", "latin1"),
]);

/** Minimal GIF87a header plus a placeholder block. */
const GIF_BYTES = Buffer.concat([Buffer.from("GIF87a"), Buffer.from([0x01, 0x00, 0x01, 0x00])]);

/** Minimal WebP: RIFF container naming a WEBP VP8 chunk. */
const WEBP_BYTES = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.from([0x24, 0x00, 0x00, 0x00]),
	Buffer.from("WEBPVP8 "),
]);

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function tempStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-attachments-"));
	const sessionFile = join(dir, "session.jsonl");
	return { dir, sessionFile, root: attachmentStoreRoot(sessionFile) };
}

/** Minimal `ExtensionAPI` stand-in that retains what it is given, like Pi does. */
function fakePi() {
	const entries = [];
	return {
		entries,
		appendEntry(customType, data) {
			entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data });
		},
	};
}

function fakeCtx(entries, sessionFile) {
	return { sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile } };
}

/** A goal-state entry as the session manager would persist it. */
function goalStateEntry(data) {
	return { type: "custom", id: `entry-${Math.random().toString(16).slice(2)}`, customType: CUSTOM_ENTRY_TYPE, data };
}

function textRequest(path) {
	return { kind: "text", path };
}

function imageRequest(path) {
	return { kind: "image", path };
}

test("magic-byte sniffing recognizes exactly the four supported image types", () => {
	assert.equal(sniffImageMediaType(PNG_BYTES), "image/png");
	assert.equal(sniffImageMediaType(JPEG_BYTES), "image/jpeg");
	assert.equal(sniffImageMediaType(GIF_BYTES), "image/gif");
	assert.equal(sniffImageMediaType(WEBP_BYTES), "image/webp");
	// Unknown content, SVG markup, and truncated headers are all unknown types.
	assert.equal(sniffImageMediaType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")), null);
	assert.equal(sniffImageMediaType(Buffer.from("plain text named .png")), null);
	assert.equal(sniffImageMediaType(PNG_BYTES.subarray(0, 4)), null);
	assert.equal(sniffImageMediaType(Buffer.alloc(0)), null);
});

test("attachment flag values are validated before anything is read", () => {
	assert.deepEqual(validateAttachmentPath("text", "notes.md"), { ok: true, path: "notes.md" });
	assert.equal(validateAttachmentPath("image", "https://example.com/cat.png").ok, false);
	assert.match(validateAttachmentPath("image", "https://example.com/cat.png").error, /--image accepts a local file path/);
	assert.match(validateAttachmentPath("image", "https://example.com/cat.png").error, /Use --remote-image <https URL>/);
	assert.equal(validateAttachmentPath("text", "  ").ok, false);
});

test("text and image files materialize into a content-addressed, read-only, Goal-keyed store", () => {
	const { dir, root } = tempStore();
	try {
		const textPath = join(dir, "spec.md");
		writeFileSync(textPath, "# Spec\n\nShip the attachments feature.\n", "utf8");
		const imagePath = join(dir, "shot.png");
		writeFileSync(imagePath, PNG_BYTES);

		const result = materializeAttachments(root, "goal_11223344", [textRequest(textPath), imageRequest(imagePath)]);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(
			result.attachments.map((attachment) => [attachment.label, attachment.mediaType, attachment.bytes]),
			[
				["spec.md", "text/plain", Buffer.byteLength("# Spec\n\nShip the attachments feature.\n", "utf8")],
				["shot.png", "image/png", PNG_BYTES.length],
			],
		);
		assert.equal(result.attachments[0].hash, sha256(Buffer.from("# Spec\n\nShip the attachments feature.\n", "utf8")));
		assert.equal(result.attachments[1].hash, sha256(PNG_BYTES));

		// Keyed by Goal identity, content-addressed, read-only.
		const goalDir = goalStoreDir(root, "goal_11223344");
		assert.deepEqual(storedGoalIds(root), ["goal_11223344"]);
		assert.equal(readFileSync(join(goalDir, `${result.attachments[0].hash}.txt`), "utf8"), "# Spec\n\nShip the attachments feature.\n");
		assert.equal(statSync(join(goalDir, `${result.attachments[1].hash}.png`)).mode & 0o222, 0, "artifact is read-only");

		// The loaded contents match what the kickoff will render.
		assert.deepEqual(result.contents[0], { meta: result.attachments[0], kind: "text", text: "# Spec\n\nShip the attachments feature.\n" });
		assert.deepEqual(result.contents[1], { meta: result.attachments[1], kind: "image", data: PNG_BYTES.toString("base64") });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("materialization is idempotent: identical bytes adopt the existing artifact", () => {
	const { dir, root } = tempStore();
	try {
		const textPath = join(dir, "notes.txt");
		writeFileSync(textPath, "same bytes", "utf8");
		const first = materializeAttachments(root, "goal_aaaabbbb", [textRequest(textPath)]);
		assert.equal(first.ok, true);
		const second = materializeAttachments(root, "goal_aaaabbbb", [textRequest(textPath)]);
		assert.equal(second.ok, true);
		assert.deepEqual(second.attachments, first.attachments);
		assert.deepEqual(storedGoalIds(root), ["goal_aaaabbbb"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unsupported, malformed, and missing sources are refused before anything commits", () => {
	const { dir, root } = tempStore();
	try {
		const svg = join(dir, "drawing.svg");
		writeFileSync(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "utf8");
		const renamed = join(dir, "renamed.png");
		writeFileSync(renamed, "not really an image", "utf8");
		const binary = join(dir, "binary.txt");
		writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
		const empty = join(dir, "empty.txt");
		writeFileSync(empty, "", "utf8");
		const missing = join(dir, "missing.txt");

		const cases = [
			[[imageRequest(svg)], /SVG is not a supported image attachment/],
			[[imageRequest(renamed)], /not a recognized image/],
			[[textRequest(binary)], /not valid UTF-8 text/],
			[[textRequest(empty)], /is empty/],
			[[textRequest(missing)], /does not exist or cannot be accessed/],
		];
		for (const [requests, pattern] of cases) {
			const result = materializeAttachments(root, "goal_ccccdddd", requests);
			assert.equal(result.ok, false, JSON.stringify(requests));
			assert.match(result.error, pattern);
			assert.match(result.error, /Goal not created:/);
		}
		// A directory is not a regular file.
		const directory = join(dir, "a-directory");
		mkdirSync(directory);
		const dirResult = materializeAttachments(root, "goal_ccccdddd", [textRequest(directory)]);
		assert.equal(dirResult.ok, false);
		assert.match(dirResult.error, /not a regular file/);
		// Nothing was written for the refused Goal.
		assert.deepEqual(storedGoalIds(root), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the enforced limits refuse count, per-file, and total sizes", () => {
	const { dir, root } = tempStore();
	try {
		const small = join(dir, "small.txt");
		writeFileSync(small, "small", "utf8");
		const smallImage = join(dir, "small.png");
		writeFileSync(smallImage, PNG_BYTES);

		// Nine attachments exceed the count limit of eight.
		const nine = Array.from({ length: 9 }, () => textRequest(small));
		const count = materializeAttachments(root, "goal_eeeeffff", nine);
		assert.equal(count.ok, false);
		assert.match(count.error, /at most 8 attachments/);

		// A text file above 1 MiB.
		const bigText = join(dir, "big.txt");
		writeFileSync(bigText, Buffer.alloc(1024 * 1024 + 1, 0x61));
		const text = materializeAttachments(root, "goal_eeeeffff", [textRequest(bigText)]);
		assert.equal(text.ok, false);
		assert.match(text.error, /above the 1\.0 MB limit for a text file/);

		// An image above 10 MiB.
		const bigImage = join(dir, "big.png");
		writeFileSync(bigImage, Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024 + 1, 0x00)]));
		const image = materializeAttachments(root, "goal_eeeeffff", [imageRequest(bigImage)]);
		assert.equal(image.ok, false);
		assert.match(image.error, /above the 10\.0 MB limit for a local image/);

		// The cumulative 25 MiB total: three ~9.5 MiB images with distinct labels.
		const mediums = [1, 2, 3].map((index) => {
			const path = join(dir, `medium-${index}.png`);
			writeFileSync(path, Buffer.concat([PNG_BYTES, Buffer.alloc(9_500_000, 0x00)]));
			return path;
		});
		const total = materializeAttachments(root, "goal_eeeeffff", mediums.map((path) => imageRequest(path)));
		assert.equal(total.ok, false);
		assert.match(total.error, /above the 25\.0 MB total limit/);

		// A duplicate label is ambiguous in the manifest and refused.
		const duplicate = materializeAttachments(root, "goal_eeeeffff", [textRequest(small), textRequest(small)]);
		assert.equal(duplicate.ok, false);
		assert.match(duplicate.error, /more than once/);

		assert.deepEqual(storedGoalIds(root), [], "no refused request left artifacts behind");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("uncommitted cleanup retracts a refused Goal's whole store directory", () => {
	const { dir, root } = tempStore();
	try {
		const good = join(dir, "good.txt");
		writeFileSync(good, "good bytes", "utf8");
		const written = materializeAttachments(root, "goal_12345678", [textRequest(good)]);
		assert.equal(written.ok, true);
		const result = materializeAttachments(root, "goal_12345678", [textRequest(good), textRequest(join(dir, "missing.txt"))]);
		assert.equal(result.ok, false, "the missing second file refuses the whole request");
		// No snapshot references this identity, so the caller retracts the whole
		// uncommitted directory, including bytes written before the refusal.
		discardUncommittedArtifacts(root, "goal_12345678");
		assert.deepEqual(storedGoalIds(root), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("verification detects missing and corrupt artifacts and passes intact ones", () => {
	const { dir, root } = tempStore();
	try {
		const textPath = join(dir, "spec.md");
		const TEXT = "the specification body";
		writeFileSync(textPath, TEXT, "utf8");
		const imagePath = join(dir, "shot.png");
		writeFileSync(imagePath, PNG_BYTES);
		const goalId = "goal_deadbeef";
		const { attachments } = materializeAttachments(root, goalId, [textRequest(textPath), imageRequest(imagePath)]);

		assert.deepEqual(verifyAttachments(root, goalId, attachments), { ok: true });
		const loaded = loadAttachments(root, goalId, attachments);
		assert.equal(loaded.ok, true);
		assert.deepEqual(loaded.contents.map((content) => content.kind), ["text", "image"]);

		// Corruption: replace the image's bytes (the store is read-only, so make it
		// writable first, exactly like an external tamperer would).
		const imageArtifact = artifactPath(root, goalId, attachments[1]);
		chmodSync(imageArtifact, 0o644);
		writeFileSync(imageArtifact, Buffer.concat([PNG_BYTES, Buffer.from("tampered")]));
		const corrupt = verifyAttachments(root, goalId, attachments);
		assert.equal(corrupt.ok, false);
		assert.equal(corrupt.problems.length, 1);
		assert.match(corrupt.problems[0], /"shot\.png" is corrupt/);
		assert.match(corrupt.problems[0], /hashes to .* but the manifest records/);

		// Missing: delete the text artifact.
		rmSync(artifactPath(root, goalId, attachments[0]));
		const missing = verifyAttachments(root, goalId, attachments);
		assert.equal(missing.ok, false);
		assert.equal(missing.problems.length, 2, "one problem per failing attachment");
		assert.match(missing.problems.find((p) => p.includes("spec.md")), /is missing from the attachment store/);

		// An empty manifest is trivially verifiable.
		assert.deepEqual(verifyAttachments(root, goalId, []), { ok: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the durable snapshot carries the manifest, and events carry its metadata only", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("Ship attachments end to end", "command");
	const manifest = [
		{ hash: sha256(Buffer.from("spec")), mediaType: "text/plain", bytes: 3, label: "spec.md" },
	];
	goal.attachments = manifest;
	store.stage(pi, goal);
	store.commit(goal);
	const snapshot = pi.entries.find((entry) => entry.customType === CUSTOM_ENTRY_TYPE);
	assert.deepEqual(snapshot.data.goal.attachments, manifest, "the manifest is durable Goal state");

	const event = toGoalUpdatedEvent("created", goal);
	assert.deepEqual(
		event.goal.attachments,
		[{ hash: manifest[0].hash, mediaType: "text/plain", bytes: 3, label: "spec.md" }],
		"events carry the manifest metadata",
	);
	assert.equal("content" in event.goal.attachments[0], false);
	assert.equal(JSON.stringify(event).includes("spec"), true, "only the label, never the contents");
});

test("reconstruction keeps a valid manifest and fails closed on a malformed one", () => {
	const { dir, sessionFile } = tempStore();
	try {
		const manifest = [
			{ hash: sha256(PNG_BYTES), mediaType: "image/png", bytes: PNG_BYTES.length, label: "shot.png" },
		];
		const valid = goalStateEntry({
			version: 1,
			repaired: true,
			goal: {
				id: "goal_validman",
				objective: "Ship attachments",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revision: 0,
				attachments: manifest,
				usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cachedReadTokens: 0, reasoningTokens: 0, nestedTokens: 0, activeMs: 0 },
			},
		});
		const store = new GoalStore();
		const restored = store.reconstruct(fakeCtx([valid], sessionFile));
		assert.equal(restored?.id, "goal_validman");
		assert.deepEqual(restored?.attachments, manifest);

		// A malformed manifest is unrecognized snapshot data: reconstruction fails
		// closed rather than silently dropping the attachments.
		const bad = goalStateEntry({
			version: 1,
			repaired: true,
			goal: { ...valid.data.goal, id: "goal_badman1", attachments: [{ hash: "not-a-hash", mediaType: "image/png", bytes: 4, label: "x.png" }] },
		});
		const store2 = new GoalStore();
		assert.equal(store2.reconstruct(fakeCtx([bad], sessionFile)), null);
		assert.match(store2.takeNotice(), /could not read the newest Goal snapshot/);

		// An unsupported media type in the manifest is equally unrecognizable.
		const svg = goalStateEntry({
			version: 1,
			repaired: true,
			goal: { ...valid.data.goal, id: "goal_badman2", attachments: [{ hash: sha256(Buffer.from("x")), mediaType: "image/svg+xml", bytes: 1, label: "x.svg" }] },
		});
		const store3 = new GoalStore();
		assert.equal(store3.reconstruct(fakeCtx([svg], sessionFile)), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an objective edit retains the immutable manifest in the committed snapshot", () => {
	const pi = fakePi();
	const store = new GoalStore();
	const goal = store.create("First objective", "command");
	const manifest = [{ hash: sha256(Buffer.from("data")), mediaType: "text/plain", bytes: 4, label: "notes.txt" }];
	goal.attachments = manifest;
	store.stage(pi, goal);
	store.commit(goal);
	const edited = store.editObjective(pi, "Second objective, same attachments");
	assert.equal(edited.ok, true);
	const snapshots = pi.entries.filter((entry) => entry.customType === CUSTOM_ENTRY_TYPE);
	assert.deepEqual(snapshots.at(-1).data.goal.attachments, manifest, "the edit keeps the manifest verbatim");
	assert.equal(snapshots.at(-1).data.goal.objective, "Second objective, same attachments");
});

test("materialization refuses a symlink source instead of following it", () => {
	const { dir, root } = tempStore();
	try {
		const target = join(dir, "target.txt");
		writeFileSync(target, "the symlink target", "utf8");
		const link = join(dir, "link.txt");
		symlinkSync(target, link);

		const result = materializeAttachments(root, "goal_symlink1", [textRequest(link)]);
		assert.equal(result.ok, false, "a symlink is not an accepted attachment source");
		assert.match(result.error, /symbolic link/);
		assert.deepEqual(storedGoalIds(root), [], "nothing was materialized");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a path swapped to a FIFO after inspection fails fast and cannot block the read", { timeout: 5000 }, (t) => {
	const { dir, root } = tempStore();
	try {
		const source = join(dir, "source.txt");
		writeFileSync(source, "regular bytes", "utf8");
		const fifoProbe = spawnSync("mkfifo", [join(dir, "probe.fifo")], { stdio: "ignore" });
		if (fifoProbe.error?.code === "ENOENT" || fifoProbe.status !== 0) {
			t.skip("mkfifo is unavailable on this platform");
			return;
		}

		let swapped = false;
		const result = materializeAttachments(root, "goal_fifo0001", [textRequest(source)], {
			readHooks: {
				beforeOpen() {
					if (swapped) return;
					swapped = true;
					rmSync(source);
					const made = spawnSync("mkfifo", [source], { stdio: "ignore" });
					assert.equal(made.status, 0, "the test FIFO was created");
				},
			},
		});
		assert.equal(swapped, true, "the deterministic swap ran");
		assert.equal(result.ok, false, "a FIFO is not a regular file");
		assert.match(result.error, /not a regular file/);
		assert.deepEqual(storedGoalIds(root), [], "nothing was materialized");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("materialization detects a file that grows while it is being read", () => {
	const { dir, root } = tempStore();
	try {
		const source = join(dir, "growing.txt");
		writeFileSync(source, "initial bytes\n", "utf8");
		const result = materializeAttachments(root, "goal_growth01", [textRequest(source)], {
			readHooks: {
				afterOpen() {
					appendFileSync(source, Buffer.alloc(2048, 0x62));
				},
			},
		});
		assert.equal(result.ok, false, "the descriptor changed under the read");
		assert.match(result.error, /changed while it was being read/);
		assert.deepEqual(storedGoalIds(root), [], "nothing was materialized");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("materialization detects a path replaced while it is being read", () => {
	const { dir, root } = tempStore();
	try {
		const source = join(dir, "replace-me.txt");
		const replacement = join(dir, "replacement.txt");
		writeFileSync(source, "original bytes", "utf8");
		writeFileSync(replacement, "replacement bytes that are longer than the original", "utf8");
		const result = materializeAttachments(root, "goal_replace1", [textRequest(source)], {
			readHooks: {
				afterOpen() {
					renameSync(replacement, source);
				},
			},
		});
		assert.equal(result.ok, false, "the path no longer names the opened inode");
		assert.match(result.error, /changed while it was being read/);
		assert.deepEqual(storedGoalIds(root), [], "nothing was materialized");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an oversized source is refused from its descriptor size without allocating its contents", () => {
	const { dir, root } = tempStore();
	try {
		const sparse = join(dir, "oversized.txt");
		writeFileSync(sparse, "", "utf8");
		truncateSync(sparse, 64 * 1024 * 1024);
		const before = process.memoryUsage().arrayBuffers;
		const result = materializeAttachments(root, "goal_oversize", [textRequest(sparse)]);
		const after = process.memoryUsage().arrayBuffers;
		assert.equal(result.ok, false);
		assert.match(result.error, /above the 1\.0 MB limit for a text file/);
		assert.ok(after - before < 8 * 1024 * 1024, `the oversized file was not buffered (${after - before} bytes)`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loading authenticates the bytes it returns after a separate verification", () => {
	const { dir, root } = tempStore();
	try {
		const TEXT = "the specification body";
		const textPath = join(dir, "spec.md");
		writeFileSync(textPath, TEXT, "utf8");
		const goalId = "goal_swap0001";
		const { attachments } = materializeAttachments(root, goalId, [textRequest(textPath)]);
		assert.deepEqual(verifyAttachments(root, goalId, attachments), { ok: true });

		const artifact = artifactPath(root, goalId, attachments[0]);
		chmodSync(artifact, 0o644);
		writeFileSync(artifact, TEXT.replace("body", "BODY"), "utf8");

		const loaded = loadAttachments(root, goalId, attachments);
		assert.equal(loaded.ok, false, "the bytes read after verification still have to match the hash");
		assert.match(loaded.error, /"spec\.md" is corrupt/);
		assert.match(loaded.error, /hashes to .* but the manifest records/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loading rejects a hand-edited small manifest size for larger artifact bytes", () => {
	const { dir, root } = tempStore();
	try {
		const goalId = "goal_smallbyt";
		const actual = Buffer.alloc(900 * 1024, 0x61);
		const manifest = [
			{ hash: sha256(actual), mediaType: "text/plain", bytes: 5, label: "declared-small.txt" },
		];
		mkdirSync(goalStoreDir(root, goalId), { recursive: true });
		writeFileSync(artifactPath(root, goalId, manifest[0]), actual);

		const loaded = loadAttachments(root, goalId, manifest);
		assert.equal(loaded.ok, false, "the manifest byte size is enforced on the loaded bytes");
		assert.match(loaded.error, /"declared-small\.txt" is corrupt/);
		assert.match(loaded.error, /5 B/);
		assert.equal(verifyAttachments(root, goalId, manifest).ok, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loading enforces per-file and total limits on artifact bytes", () => {
	const { dir, root } = tempStore();
	try {
		const goalId = "goal_loadlim";
		const oversizedText = Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1, 0x61);
		const oversizedManifest = [
			{ hash: sha256(oversizedText), mediaType: "text/plain", bytes: 1, label: "oversized.txt" },
		];
		mkdirSync(goalStoreDir(root, goalId), { recursive: true });
		writeFileSync(artifactPath(root, goalId, oversizedManifest[0]), oversizedText);
		const perFile = loadAttachments(root, goalId, oversizedManifest);
		assert.equal(perFile.ok, false);
		assert.match(perFile.error, /above the 1\.0 MB limit for a text file/);

		const imageBytes = Buffer.concat([
			PNG_BYTES,
			Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES - 1024 * 1024 - PNG_BYTES.length, 0x00),
		]);
		const hash = sha256(imageBytes);
		const totalManifest = ["a.png", "b.png", "c.png"].map((label) => ({
			hash,
			mediaType: "image/png",
			bytes: imageBytes.length,
			label,
		}));
		assert.ok(imageBytes.length * totalManifest.length > MAX_TOTAL_ATTACHMENT_BYTES);
		writeFileSync(artifactPath(root, goalId, totalManifest[0]), imageBytes);
		const total = loadAttachments(root, goalId, totalManifest);
		assert.equal(total.ok, false, "three 9 MiB artifacts exceed the 25 MiB total");
		assert.match(total.error, /above the 25\.0 MB total limit/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
