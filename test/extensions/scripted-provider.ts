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
 *
 * Two testing conveniences ride along:
 *
 * - the scripted model declares image input, so Goal attachment images reach the
 *   provider as real image content blocks instead of being downgraded to
 *   placeholders at the provider boundary (Pi replaces images with text
 *   placeholders for text-only models);
 * - when PI_GOAL_TEST_CAPTURE_DIR is set, every request's full message list is
 *   dumped there as `request-<n>.json`, which is how tests assert on the exact
 *   model context (encoded attachment data blocks, image blocks) a real Pi
 *   session produced.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
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

/**
 * Read the scripted steps, retrying a torn read.
 *
 * Tests rewrite this file between turns while Pi may already be requesting the
 * next response. A plain read can land mid-write and see invalid JSON, which
 * ends the run as a provider error instead of exercising the scenario under
 * test. The writer replaces the whole file, so a retry sees either the old
 * complete script or the new complete one; both are valid for the turn already
 * in flight, and the gate step each scenario writes is identical in both.
 */
async function readSteps(): Promise<ScriptedStep[]> {
	const path = process.env.PI_GOAL_TEST_SCRIPT;
	if (!path) throw new Error("PI_GOAL_TEST_SCRIPT is not set");
	for (let attempt = 0; ; attempt += 1) {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as ScriptedStep[];
		} catch (error) {
			if (!(error instanceof SyntaxError) || attempt >= 100) throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
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
				id: "stepfun-5-preview",
				name: "StepFun 5 Preview (scripted)",
				reasoning: false,
				// Image input is declared so attachment tests exercise the real image
				// path: a text-only model would have every image block downgraded to a
				// placeholder before the provider sees it.
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		streamSimple(model, context, options) {
			captureRequest(callCount, context.messages);
			return streamScriptedStep(model, context, options, () => callCount++);
		},
	});
}

/**
 * Dump one request's messages when PI_GOAL_TEST_CAPTURE_DIR is set.
 *
 * The capture is test-only evidence of the exact model context: which message
 * carried the encoded attachment data blocks, which carried image blocks, and
 * what text surrounded them. Writing is best effort; a capture failure never
 * breaks the scenario under test.
 */
function captureRequest(index: number, messages: readonly Message[]): void {
	const dir = process.env.PI_GOAL_TEST_CAPTURE_DIR;
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/request-${index}.json`,
			JSON.stringify(messages, null, "\t"),
			"utf8",
		);
	} catch {
		// Test-only convenience; never fail the run for it.
	}
}

function streamScriptedStep(
	model: Model<string>,
	_context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	nextIndex: () => number,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		// Read before advancing the index: a free read can throw, and Pi retries a
		// failed provider request. Consuming an index on a throw would shift every
		// later step, so a retried request must be served the same step.
		const steps = await readSteps();
		const index = nextIndex();
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
