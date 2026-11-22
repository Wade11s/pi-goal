import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LogMessage {
	role: "user" | "assistant";
	text: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null) {
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
		}
	}
	return parts.join("\n");
}

/**
 * When a tail is requested, never read more than this many bytes from the end
 * of the session file; long sessions must not make `logs --tail` slow.
 */
export const TAIL_READ_BYTES = 1_000_000;

/** Read the visible user/assistant turns from a Pi session JSONL file. */
export function readSessionMessages(path: string, options: { tailBytes?: number } = {}): LogMessage[] {
	const messages: LogMessage[] = [];
	let raw: string;
	try {
		if (options.tailBytes !== undefined) {
			const size = statSync(path).size;
			const start = Math.max(0, size - options.tailBytes);
			const fd = openSync(path, "r");
			try {
				const buffer = Buffer.alloc(size - start);
				readSync(fd, buffer, 0, buffer.length, start);
				raw = buffer.toString("utf8");
			} finally {
				closeSync(fd);
			}
			// The chunk may start mid-line; drop the partial line unless we read all.
			if (start > 0) {
				const newline = raw.indexOf("\n");
				raw = newline >= 0 ? raw.slice(newline + 1) : "";
			}
		} else {
			raw = readFileSync(path, "utf8");
		}
	} catch {
		return messages;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const message = record.message;
		if (typeof message !== "object" || message === null) continue;
		const fields = message as Record<string, unknown>;
		const role = fields.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(fields.content).trim();
		if (text.length === 0) continue;
		messages.push({ role, text });
	}
	return messages;
}

export function newestSessionFile(sessionsDir: string): string | undefined {
	if (!existsSync(sessionsDir)) return undefined;
	let best: { path: string; mtime: number } | undefined;
	for (const name of readdirSync(sessionsDir)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(sessionsDir, name);
		try {
			const mtime = statSync(path).mtimeMs;
			if (!best || mtime > best.mtime) best = { path, mtime };
		} catch {
			// A file removed mid-scan is simply skipped.
		}
	}
	return best?.path;
}

function renderTranscript(messages: LogMessage[]): string {
	const blocks: string[] = [];
	let turn = 0;
	for (const message of messages) {
		if (message.role === "user") {
			turn += 1;
			blocks.push(`=== prompt ${turn} ===\n${message.text}`);
			continue;
		}
		blocks.push(`=== answer ${turn} ===\n${message.text}`);
	}
	return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/**
 * Render the child session as a transcript. The child is a normal TUI Pi, so its
 * session file is the record of what happened; nothing needs to be captured
 * from the terminal. With `tailLines`, only the end of a long session is read.
 */
export function transcriptFromSession(sessionsDir: string, options: { tailLines?: number } = {}): string {
	const file = newestSessionFile(sessionsDir);
	if (!file) return "";
	const tailLines = options.tailLines !== undefined && options.tailLines > 0 ? options.tailLines : undefined;
	const messages = readSessionMessages(file, tailLines === undefined ? {} : { tailBytes: TAIL_READ_BYTES });
	const text = renderTranscript(messages);
	if (tailLines === undefined) return text;
	const lines = text.split("\n");
	return lines.slice(Math.max(0, lines.length - tailLines)).join("\n");
}
