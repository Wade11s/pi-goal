import assert from "node:assert/strict";
import test from "node:test";
import { runTitle, sanitizeLabel, sessionLabel, shortModel } from "../src/labels.ts";

test("runTitle puts the task first, then model and thinking", () => {
	assert.equal(runTitle({ name: "review diff", model: "xai/grok-4.7", thinking: "high", handle: "abc123" }), "review diff — grok-4.7:high");
	assert.equal(runTitle({ name: "review diff", model: "magpie/workbuddy/deepseek-v4.1-flash", handle: "abc123" }), "review diff — deepseek-v4.1-flash");
	assert.equal(runTitle({ name: "review diff", thinking: "max", handle: "abc123" }), "review diff — max");
});

test("runTitle falls back to the model or the handle", () => {
	assert.equal(runTitle({ model: "xai/grok-4.7", handle: "abc123" }), "grok-4.7 — grok-4.7");
	assert.equal(runTitle({ handle: "abc123" }), "agent abc123");
});

test("runTitle keeps a tab-sized label", () => {
	const title = runTitle({ name: "x".repeat(200), model: "m", thinking: "high", handle: "h" });
	assert.ok(title.length <= 80);
	assert.ok(title.endsWith("…"));
});

test("sanitizeLabel flattens whitespace and control characters", () => {
	assert.equal(sanitizeLabel("  a\nb\tc  "), "a b c");
	assert.equal(sanitizeLabel("\u0000\u001b"), "");
});

test("shortModel keeps the last path segment", () => {
	assert.equal(shortModel("magpie/workbuddy/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
	assert.equal(shortModel("grok"), "grok");
	assert.equal(shortModel(undefined), undefined);
});

test("sessionLabel names the group", () => {
	assert.equal(sessionLabel("subagents"), "rex-subagents");
	assert.equal(sessionLabel("video style"), "rex-video style");
});
