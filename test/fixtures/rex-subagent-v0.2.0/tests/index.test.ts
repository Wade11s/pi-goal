import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rexSubagent from "../src/index.ts";
import { tempEnv } from "./helpers.ts";

test("parent extension reconciles setup on session start and exposes manual setup", async () => {
	const fixture = tempEnv();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPath = process.env.PATH;
	const notifications: { message: string; level: string }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools = new Set<string>();
	let ctx!: ExtensionContext;
	try {
		process.env.PI_CODING_AGENT_DIR = fixture.env.PI_CODING_AGENT_DIR;
		process.env.PATH = `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}`;
		const pi = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(tool: { name: string }) {
				tools.add(tool.name);
			},
		} as unknown as ExtensionAPI;
		ctx = {
			sessionManager: { getSessionId: () => "parent-session" },
			ui: {
				setWidget() {},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		rexSubagent(pi);
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(existsSync(join(fixture.dir, "agent", "bin", "rex-subagent")), true);
		assert.equal(commands.has("rex-subagent-setup"), true);
		assert.deepEqual([...tools].sort(), ["rex_adopt", "rex_observe", "rex_spawn", "rex_stop", "rex_wait"]);

		await commands.get("rex-subagent-setup")?.handler("", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /current|ready/i);
		await handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fixture.cleanup();
	}
});
