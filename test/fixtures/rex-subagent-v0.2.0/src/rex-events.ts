import { spawn } from "node:child_process";
import { rexArgs, type RexLocation } from "./rex.ts";

/** A custom event emitted by one block in a Rex session. */
export interface RexBlockEvent {
	sessionId: string;
	blockId: string;
	name: string;
	payload: unknown;
}

export interface RexEventHandlers {
	onEvent: (event: RexBlockEvent) => void;
	/** The stream ended or failed; callers should reconcile from snapshots. */
	onClose: () => void;
}

export interface RexEventSubscription {
	close: () => void;
}

export type WatchRexEvents = (
	location: RexLocation,
	sessionId: string,
	handlers: RexEventHandlers,
) => RexEventSubscription;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parse the envelope emitted by `rex events --json`; unrelated events return undefined. */
export function parseRexBlockEvent(line: string): RexBlockEvent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	const envelope = asRecord(value);
	if (envelope?.type !== "session_event") return undefined;
	const session = asRecord(envelope.payload);
	const event = asRecord(session?.event);
	if (event?.type !== "block_event") return undefined;
	const block = asRecord(event.payload);
	const sessionId = session?.session_id;
	const blockId = block?.block_id;
	const name = block?.name;
	if (!block || typeof sessionId !== "string" || typeof blockId !== "string" || typeof name !== "string") return undefined;
	return { sessionId, blockId, name, payload: block.payload };
}

/**
 * Stream a session's block events without the output cap and process timeout of
 * defaultRunner. Closing the subscription terminates only this `rex events`
 * client; it does not alter the observed session.
 */
export const watchRexEvents: WatchRexEvents = (location, sessionId, handlers) => {
	const child = spawn("rex", rexArgs(location, ["events", "-s", sessionId, "--json"]), {
		stdio: ["ignore", "pipe", "ignore"],
	});
	let closed = false;
	let closeNotified = false;
	let buffered = "";
	const notifyClose = (): void => {
		if (closed || closeNotified) return;
		closeNotified = true;
		handlers.onClose();
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			const event = parseRexBlockEvent(line);
			if (event) handlers.onEvent(event);
		}
	});
	child.on("error", notifyClose);
	child.on("close", notifyClose);
	return {
		close() {
			if (closed) return;
			closed = true;
			child.kill("SIGTERM");
		},
	};
};
