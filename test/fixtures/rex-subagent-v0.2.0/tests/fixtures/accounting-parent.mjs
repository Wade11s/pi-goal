import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAccountingTools } from "../../src/accounting-tools.ts";

const [handle, parentSessionId, barrierDir] = process.argv.slice(2);
if (!handle || !parentSessionId || !barrierDir) throw new Error("handle, parent session, and barrier directory are required");

const handlers = new Map();
const tools = new Map();
const pi = {
	on(name, handler) {
		handlers.set(name, handler);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
};
const context = {
	cwd: "/tmp/project",
	sessionManager: {
		getSessionId: () => parentSessionId,
		getBranch: () => [],
	},
};

registerAccountingTools(pi, { env: process.env });
await handlers.get("session_start")?.({}, context);
if (barrierDir !== "-") {
	writeFileSync(join(barrierDir, `${parentSessionId}.ready`), "ready\n");
	while (!existsSync(join(barrierDir, "adopt.go"))) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
const tool = tools.get("rex_adopt");
if (!tool) throw new Error("rex_adopt was not registered");
const result = await tool.execute("call-1", { handle }, undefined, undefined, context);
process.stdout.write(JSON.stringify(result));
