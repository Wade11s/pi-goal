/**
 * Test-only Pi extension: registers a deterministic "scripted" model provider.
 *
 * The provider serves responses from a JSON script file (PI_GOAL_TEST_SCRIPT).
 * Each model request consumes the next step in order; the counter resets with
 * the process. A step is one of:
 *
 *   { "text": "...", "usage"?: {input,output,cacheRead?,cacheWrite?} }
 *   { "toolCalls": [{ "name": "get_goal", "args": {} }], "usage"?: {...} }
 *   { "error": "message", "stopReason"?: "error" }
 *   { "hang": true }   // never completes; for interrupted-run tests
 *   { "waitForFile": "/abs/path" } // holds the response until the file exists
 *
 * No network access or credentials are required, which lets the RPC tests drive
 * real Pi sessions end to end.
 */
import { existsSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ScriptedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Subset of `output`, exactly as Pi's providers report reasoning tokens. */
	reasoning?: number;
}

export interface ScriptedStep {
	text?: string;
	toolCalls?: { name: string; args: JsonObject }[];
	usage?: ScriptedUsage;
	stopReason?: string;
	error?: string;
	/** Never complete this response; the agent run hangs until aborted or killed. */
	hang?: boolean;
	/**
	 * Hold the response until this absolute path exists (polled every 5ms, and
	 * released by an abort). Unlike a fixed delay this is race-free: the test
	 * knows the agent is provably busy, and releases the response only once it
	 * has queued whatever it wanted to queue.
	 */
	waitForFile?: string;
}

function readSteps(): ScriptedStep[] {
	const path = process.env.PI_GOAL_TEST_SCRIPT;
	if (!path) throw new Error("PI_GOAL_TEST_SCRIPT is not set");
	return JSON.parse(readFileSync(path, "utf8")) as ScriptedStep[];
}

export default function scriptedProviderExtension(pi: ExtensionAPI): void {
	let callCount = 0;

	pi.registerProvider("scripted", {
		name: "Scripted Test Provider",
		api: "scripted-test",
		baseUrl: "http://localhost:0",
		apiKey: "scripted-test-key",
		models: [
			{
				id: "scripted-1",
				name: "Scripted 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		streamSimple(model, _context, options) {
			return streamScriptedStep(model, _context, options, () => callCount++);
		},
	});
}

function streamScriptedStep(
	model: Model<string>,
	_context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	nextIndex: () => number,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const index = nextIndex();
		const steps = readSteps();
		const step = steps[index];
		if (!step) throw new Error(`scripted provider: no step at index ${index} in PI_GOAL_TEST_SCRIPT`);

		const usage = {
			input: step.usage?.input ?? 10,
			output: step.usage?.output ?? 5,
			cacheRead: step.usage?.cacheRead ?? 0,
			cacheWrite: step.usage?.cacheWrite ?? 0,
			reasoning: step.usage?.reasoning ?? 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

		if (step.hang) {
			// Emit the start event, then hold the stream open forever so the agent
			// run never receives a response.
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: { ...partial } });
			await new Promise<void>((resolve) => {
				options?.signal?.addEventListener("abort", () => resolve());
			});
			const aborted: AssistantMessage = {
				...partial,
				stopReason: "aborted",
				errorMessage: "hang step aborted",
			};
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		// Hold the response until the test releases it, so a test has a
		// deterministic window in which the agent is provably busy (for queueing
		// steering or follow-up messages) without depending on wall-clock timing.
		if (step.waitForFile !== undefined) {
			const gate = step.waitForFile;
			await new Promise<void>((resolve) => {
				const poll = () => {
					if (existsSync(gate)) {
						resolve();
						return;
					}
					setTimeout(poll, 5);
				};
				options?.signal?.addEventListener("abort", () => resolve());
				poll();
			});
		}

		const content: AssistantMessage["content"] = [];
		for (const call of step.toolCalls ?? []) {
			content.push({
				type: "toolCall",
				id: `call_${index}_${content.length}`,
				name: call.name,
				arguments: call.args,
			});
		}
		if (step.text !== undefined) {
			content.push({ type: "text", text: step.text });
		}

		const stopReason = (step.error !== undefined
			? "error"
			: (step.stopReason ?? (step.toolCalls?.length ? "toolUse" : "stop"))) as AssistantMessage["stopReason"];
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason,
			...(step.error !== undefined ? { errorMessage: step.error } : {}),
			timestamp: Date.now(),
		};

		if (stopReason === "error" || stopReason === "aborted") {
			stream.push({ type: "error", reason: stopReason, error: message });
			stream.end(message);
			return;
		}

		const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
		// Accumulated content for the partial snapshots: each event must carry every
		// block streamed so far, because `contentIndex` addresses that array.
		const streamed: AssistantMessage["content"] = [];
		stream.push({ type: "start", partial: { ...partial } });
		for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
			if (options?.signal?.aborted) break;
			const block = content[contentIndex]!;
			streamed.push(block);
			const partialContent = [...streamed];
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial: { ...partial, content: partialContent } });
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: { ...partial, content: partialContent } });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: { ...partial, content: partialContent } });
			} else if (block.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex, partial: { ...partial, content: partialContent } });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: { ...partial, content: partialContent } });
			}
		}

		if (options?.signal?.aborted) {
			const aborted: AssistantMessage = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length" | "deferred", message });
		stream.end(message);
	})().catch((error: unknown) => {
		const failed: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: failed });
		stream.end(failed);
	});

	return stream;
}
