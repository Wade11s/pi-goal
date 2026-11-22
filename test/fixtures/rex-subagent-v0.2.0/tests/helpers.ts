import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner, CommandRunOptions, CommandRunResult } from "../src/rex.ts";

export interface FakeCall {
	command: string;
	args: string[];
	options?: CommandRunOptions;
}

export interface RecordingRunner extends CommandRunner {
	calls: FakeCall[];
}

export function result(partial: Partial<CommandRunResult> & Pick<CommandRunResult, "code">): CommandRunResult {
	return { stdout: "", stderr: "", timedOut: false, ...partial };
}

export function json(value: unknown, code = 0): CommandRunResult {
	return result({ code, stdout: `${JSON.stringify(value)}\n` });
}

export function fakeRunner(
	handler: (command: string, args: string[], options?: CommandRunOptions) => CommandRunResult | Promise<CommandRunResult>,
): RecordingRunner {
	const calls: FakeCall[] = [];
	return {
		calls,
		async run(command, args, options) {
			calls.push({ command, args: [...args], options });
			return handler(command, args, options);
		},
	};
}

/** Drop Rex global flags so a handler sees only the command itself. */
export function rexCommand(args: string[]): string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "-S" || arg === "--timeout") {
			index += 2;
			continue;
		}
		if (arg === "--autostart=false" || arg === "--autostart") {
			index += 1;
			continue;
		}
		break;
	}
	return args.slice(index);
}

export interface TempEnv {
	env: NodeJS.ProcessEnv;
	dir: string;
	cleanup: () => void;
}

/** Isolated agent directory so tests never touch the real run records. */
export function tempEnv(extra: NodeJS.ProcessEnv = {}): TempEnv {
	const dir = mkdtempSync(join(tmpdir(), "rex-subagent-test-"));
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	return {
		dir,
		env: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			HOME: dir,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			...extra,
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export function writeExecutable(path: string, content: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}
