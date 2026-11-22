/**
 * Issue #57: the read-only review-child launch profile.
 *
 * The profile is documentation plus a launch argument set, not a pi-goal
 * feature: pi-goal core must keep no Rex knowledge and no review-thread
 * classification. These tests therefore pin three things through public seams:
 *
 * 1. the documented profile is read-only and excludes every Goal tool, in both
 *    its `rex_spawn` JSON form and its equivalent CLI form;
 * 2. a real Pi session started with exactly those documented launch arguments
 *    declares only `read,bash,grep,find,ls` to the model, while an ordinary
 *    parent session still declares the Goal tools and keeps its own Goal state;
 * 3. an accidental `get_goal`/`create_goal`/`update_goal` call in the review
 *    child is refused by Pi and writes no Goal transition.
 *
 * The live scenario, when a local `rex` CLI exists, inspects the released
 * provider's run record and proves the profile reaches the child Pi as the real
 * `--tools` / `--exclude-tools` launch arguments.
 *
 * The isolation scenario re-runs the child *after* the parent Goal exists, so its
 * byte comparison must wait for that second run to settle: a prompt response only
 * acknowledges acceptance, and a busy child would silently discard the second
 * scripted step while the comparison still passed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PiRpcSession,
	assertStepsConsumed,
	readSessionEntries,
	runCount,
	script,
	waitForSnapshot,
} from "./helpers/rpc-harness.mjs";
import { rexAvailable, startRexAcceptanceEnv } from "./helpers/rex-acceptance.mjs";

const SUBAGENTS_DOC = join(import.meta.dirname, "..", "docs", "agents", "subagents.md");
const ACTIVE_TOOLS_PEER = join(import.meta.dirname, "extensions", "active-tools-peer.ts");

/** The profile's read-only allowlist, in its canonical order. */
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
/** Tools a review child must never have: code mutation and Goal lifecycle. */
const DENIED_TOOLS = ["edit", "write", "get_goal", "create_goal", "update_goal"];
const GOAL_TOOLS = ["get_goal", "create_goal", "update_goal"];

function fencedBlock(markdown, infoString) {
	const escaped = infoString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = markdown.match(new RegExp("```" + escaped + "\\n([\\s\\S]*?)```"));
	assert.ok(match, `docs/agents/subagents.md must contain a \`\`\`${infoString} block`);
	return match[1].trim();
}

function splitList(value) {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Read the canonical profile from the docs, in both documented forms. */
function readDocumentedProfile() {
	const markdown = readFileSync(SUBAGENTS_DOC, "utf8");
	const json = JSON.parse(fencedBlock(markdown, "json review-child-profile"));
	const cli = fencedBlock(markdown, "sh review-child-cli");
	return { json, cli };
}

/** Parse `--flag value` pairs from the documented spawn command, up to `--prompt`. */
function parseSpawnFlags(cli) {
	const tokens = cli.split(/\s+/);
	const flags = new Map();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--prompt") break;
		if (!token.startsWith("--")) continue;
		flags.set(token.slice(2), tokens[index + 1]);
		index += 1;
	}
	return flags;
}

/** The exact Pi argv pairs the documented profile turns into. */
function launchArgs(profile) {
	return ["--tools", profile.tools, "--exclude-tools", profile.excludeTools];
}

function assertProfileLaunchArgs(args, profile) {
	const toolsIndex = args.indexOf("--tools");
	assert.ok(toolsIndex >= 0, "the child launch must carry --tools");
	assert.equal(args[toolsIndex + 1], profile.tools);
	const excludeIndex = args.indexOf("--exclude-tools");
	assert.ok(excludeIndex >= 0, "the child launch must carry --exclude-tools");
	assert.equal(args[excludeIndex + 1], profile.excludeTools);
}

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-review-profile-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("the documented review-child profile is read-only and excludes every Goal tool", () => {
	const { json, cli } = readDocumentedProfile();

	assert.deepEqual(Object.keys(json).sort(), ["excludeTools", "tools"], "the profile declares exactly the tool lists");
	const allowed = splitList(json.tools);
	const denied = splitList(json.excludeTools);
	assert.deepEqual(allowed, READ_ONLY_TOOLS, "the allowlist is the ordinary read-only tool set");
	assert.deepEqual(denied, DENIED_TOOLS, "the denylist names code mutation and every Goal tool");
	assert.deepEqual(allowed.filter((name) => denied.includes(name)), [], "allowlist and denylist never overlap");
	for (const name of [...GOAL_TOOLS, "edit", "write"]) {
		assert.ok(!allowed.includes(name), `the allowlist must not admit ${name}`);
	}
	for (const name of READ_ONLY_TOOLS) {
		assert.ok(!denied.includes(name), `the denylist must not remove the ordinary read-only tool ${name}`);
	}

	// The CLI form is the same launch, so an operator or a diagnostic run cannot
	// drift from the tool profile the orchestrator passes to rex_spawn.
	assert.match(cli, /^rex-subagent spawn /, "the documented CLI form is a real spawn command");
	const flags = parseSpawnFlags(cli);
	assert.equal(flags.get("tools"), json.tools);
	assert.equal(flags.get("exclude-tools"), json.excludeTools);
	assert.equal(flags.get("name"), "review");
});

test("the documented launch arguments produce a read-only real Pi session, leaving the parent untouched", async (t) => {
	const dir = tempDir(t);
	const { json: profile } = readDocumentedProfile();

	const childToolsPath = join(dir, "child-tools.json");
	const child = await PiRpcSession.start({
		tools: profile.tools,
		excludeTools: profile.excludeTools,
		extraExtensions: [ACTIVE_TOOLS_PEER],
		env: { PI_GOAL_TEST_ACTIVE_TOOLS: childToolsPath },
	});
	t.after(() => child.stop());
	script([{ text: "Review complete." }, { text: "Still review only." }], child);
	await child.prompt("Review the branch please.");
	await child.waitForSettled(1);

	// Launch-argument inspection: the real child Pi process was started with the
	// documented profile, as adjacent flag/value pairs.
	assertProfileLaunchArgs(child.args, profile);
	assert.equal(child.args.filter((arg) => arg === "--tools").length, 1);

	// Integration check: the session's actual model-visible tool set is read-only.
	assert.deepEqual(JSON.parse(readFileSync(childToolsPath, "utf8")).sort(), [...READ_ONLY_TOOLS].sort());
	const childGoalState = readSessionEntries(await child.sessionFile()).filter(
		(entry) => entry.type === "custom" && entry.customType === "goal-state",
	);
	assert.deepEqual(childGoalState, [], "a review child without Goal tools writes no Goal state");

	// The parent is a different, ordinary session: it keeps the Goal tools and its
	// own durable Goal, which is precisely what the child profile must not affect.
	const parentToolsPath = join(dir, "parent-tools.json");
	const parent = await PiRpcSession.start({
		extraExtensions: [ACTIVE_TOOLS_PEER],
		env: { PI_GOAL_TEST_ACTIVE_TOOLS: parentToolsPath },
	});
	t.after(() => parent.stop());
	script([{ text: "On it." }, { hang: true }], parent);
	await parent.prompt("/goal --no-budget Keep the parent Goal state intact");
	await waitForSnapshot(parent, (snapshot) => snapshot.data.goal?.status === "active", "the parent Goal creation");
	await parent.prompt("/goal pause");
	const parentFile = await parent.sessionFile();
	const beforeSnapshot = await waitForSnapshot(parent, (snapshot) => snapshot.data.goal?.status === "paused", "the parent pause");
	const before = readFileSync(parentFile);
	assert.equal(beforeSnapshot.data.goal.status, "paused");
	assert.equal(beforeSnapshot.data.goal.objective, "Keep the parent Goal state intact");

	const parentTools = JSON.parse(readFileSync(parentToolsPath, "utf8"));
	for (const name of ["read", "edit", "write", ...GOAL_TOOLS]) {
		assert.ok(parentTools.includes(name), `the parent session still declares ${name}`);
	}
	assert.equal(parent.args.includes("--tools"), false, "the parent session is not launched with the review profile");
	assert.equal(parent.args.includes("--exclude-tools"), false);

	// Re-run the child after the parent Goal exists, then prove the parent's
	// durable session bytes are unchanged: the child cannot reach across sessions.
	// The response only acknowledges prompt acceptance, so wait for the second run
	// to actually settle before comparing bytes. Without that wait a busy child
	// would drop the second scripted step and the comparison would still pass,
	// which is why the step count and the second reply are asserted as well.
	await child.prompt("Summarize the review.");
	await child.waitForSettled(2);
	assertStepsConsumed(child, 2);
	assert.equal(runCount(child), 2, "the child ran the re-review as a second agent run");
	assert.deepEqual(
		child.records
			.filter((record) => record.type === "message_end" && record.message.role === "assistant")
			.map((record) =>
				record.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(""),
			),
		["Review complete.", "Still review only."],
		"the second scripted step is the re-run's reply, not a discarded step",
	);
	assert.deepEqual(readFileSync(parentFile), before, "the parent's durable Goal state is byte-for-byte unchanged");
});

test("an accidental Goal-tool call in the review child is refused and writes nothing", async (t) => {
	const dir = tempDir(t);
	const { json: profile } = readDocumentedProfile();

	// A parent Goal the review child must not be able to touch.
	const parent = await PiRpcSession.start();
	t.after(() => parent.stop());
	script([{ text: "On it." }, { hang: true }], parent);
	await parent.prompt("/goal --no-budget Preserve this parent Goal");
	await waitForSnapshot(parent, (snapshot) => snapshot.data.goal?.status === "active", "the parent Goal creation");
	await parent.prompt("/goal pause");
	const parentFile = await parent.sessionFile();
	await waitForSnapshot(parent, (snapshot) => snapshot.data.goal?.status === "paused", "the parent paused Goal");
	const parentBefore = readFileSync(parentFile);

	const childToolsPath = join(dir, "refusal-tools.json");
	const child = await PiRpcSession.start({
		tools: profile.tools,
		excludeTools: profile.excludeTools,
		extraExtensions: [ACTIVE_TOOLS_PEER],
		env: { PI_GOAL_TEST_ACTIVE_TOOLS: childToolsPath },
	});
	t.after(() => child.stop());

	script(
		[
			{ toolCalls: [{ name: "get_goal", args: {} }] },
			{ toolCalls: [{ name: "create_goal", args: { objective: "Escaped review Goal" } }] },
			{ toolCalls: [{ name: "update_goal", args: { action: "complete" } }] },
			{ text: "The lifecycle tools are unavailable; reporting that instead." },
		],
		child,
	);
	await child.prompt("Try to operate the Goal lifecycle.");
	await child.waitForToolResult("update_goal", 1);
	await child.waitForSettled(1);

	const ends = child.records.filter((record) => record.type === "tool_execution_end");
	assert.deepEqual(
		ends.map((record) => record.toolName),
		GOAL_TOOLS,
		"every accidental Goal-tool call reached the refusal boundary",
	);
	for (const end of ends) {
		assert.equal(end.isError, true, `${end.toolName} must be refused in the review child`);
		assert.match(end.result.content[0].text, /not found/i, `${end.toolName} is absent, not merely disabled`);
	}

	const childEntries = readSessionEntries(await child.sessionFile());
	assert.deepEqual(
		childEntries.filter((entry) => entry.type === "custom" && entry.customType === "goal-state"),
		[],
		"a refused call writes no Goal snapshot",
	);
	assert.deepEqual(readFileSync(parentFile), parentBefore, "the parent Goal session is untouched by the refusals");
	assert.deepEqual(JSON.parse(readFileSync(childToolsPath, "utf8")).sort(), [...READ_ONLY_TOOLS].sort());
});

const live = rexAvailable();
const skipLive = { skip: live ? false : "needs a local `rex` CLI to run the isolated Rex server" };

test("released Rex launches the review child with the documented tool arguments", skipLive, async (t) => {
	const env = await startRexAcceptanceEnv();
	t.after(async () => {
		await env.stop();
	});
	const { json: profile } = readDocumentedProfile();

	const session = await PiRpcSession.start(env.sessionOptions());
	t.after(async () => {
		await session.stop();
	});
	script(
		[
			{
				toolCalls: [
					{
						name: "rex_spawn",
						args: {
							prompt: "Say REVIEW_READY",
							name: "review",
							provider: "rexdeterministic",
							model: "child-model",
							thinking: "low",
							...profile,
						},
					},
				],
			},
			{ text: "Review child spawned." },
		],
		session,
	);

	await session.prompt("Dispatch the review child.");
	const spawnEnd = await session.waitForToolResult("rex_spawn", 1);
	assert.equal(spawnEnd.isError, false, `rex_spawn failed: ${JSON.stringify(spawnEnd.result)}`);
	const handle = spawnEnd.result?.details?.runs?.[0]?.handle;
	assert.ok(handle, "the released provider reports the review run handle");

	// The released provider's own durable run record carries the child Pi argv.
	const record = env.record(handle);
	assertProfileLaunchArgs(record.launchArgs, profile);
	assert.equal(record.launchArgs.includes("--no-skills"), false, "the Reviewer keeps skills for the OCR workflow");
	assert.equal(record.launchArgs.includes("--no-extensions"), false);

	// The child really starts with that argv; its deterministic provider is asked
	// for the first turn, which is the successful-launch evidence.
	await env.provider.waitForChildRequest();
});
