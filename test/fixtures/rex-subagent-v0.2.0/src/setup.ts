import { constants, accessSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { agentDir } from "./record.ts";
import { defaultRunner, type CommandRunner } from "./rex.ts";

const defaultPackageDir = dirname(dirname(fileURLToPath(import.meta.url)));

export type SetupStatus = "ready" | "created" | "repaired" | "missing" | "outdated" | "conflict" | "invalid" | "unhealthy";

export interface SetupReport {
	status: SetupStatus;
	ok: boolean;
	changed: boolean;
	packageDir: string;
	cliPath: string;
	linkPath: string;
	pathConfigured: boolean;
	message: string;
	legacyResources: string[];
	version?: string;
}

export interface SetupOptions {
	repair?: boolean;
	env?: NodeJS.ProcessEnv;
	runner?: CommandRunner;
	packageDir?: string;
}

function sourcePaths(packageDir: string): { packageDir: string; cliPath: string } {
	const canonicalPackageDir = realpathSync(packageDir);
	const manifest = JSON.parse(readFileSync(join(canonicalPackageDir, "package.json"), "utf8")) as {
		name?: string;
		bin?: string | Record<string, string>;
	};
	const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["rex-subagent"];
	if (manifest.name !== "pi-rex-subagent" || declared !== "./src/cli.ts") {
		throw new Error("package.json does not identify the expected pi-rex-subagent CLI");
	}
	const cliPath = realpathSync(join(canonicalPackageDir, "src", "cli.ts"));
	if (!statSync(cliPath).isFile()) throw new Error("src/cli.ts is not a regular file");
	accessSync(cliPath, constants.X_OK);
	const firstLine = readFileSync(cliPath, "utf8").split(/\r?\n/, 1)[0];
	if (firstLine !== "#!/usr/bin/env node") throw new Error("src/cli.ts has an unexpected interpreter");
	return { packageDir: canonicalPackageDir, cliPath };
}

function isManagedTarget(target: string): boolean {
	if (!target.endsWith(join("src", "cli.ts"))) return false;
	try {
		sourcePaths(dirname(dirname(target)));
		return true;
	} catch {
		return false;
	}
}

/** Create or inspect the stable CLI link without ever overwriting a foreign file. */
export async function reconcileSetup(options: SetupOptions = {}): Promise<SetupReport> {
	const env = options.env ?? process.env;
	const runner = options.runner ?? defaultRunner;
	const requestedPackageDir = options.packageDir ?? defaultPackageDir;
	const binDir = join(agentDir(env), "bin");
	const linkPath = join(binDir, "rex-subagent");
	const statePath = join(agentDir(env), ".rex-subagent-setup.json");
	const pathConfigured = (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.some((entry) => resolve(entry) === binDir);
	let packageDir = requestedPackageDir;
	let cliPath = join(requestedPackageDir, "src", "cli.ts");
	const legacyResources: string[] = [];
	const legacyPackageDir = join(agentDir(env), "extensions", "pi-rex-subagent");
	const samePath = (left: string, right: string): boolean => {
		try {
			return realpathSync(left) === realpathSync(right);
		} catch {
			return resolve(left) === resolve(right);
		}
	};

	const report = (status: SetupStatus, message: string, changed = false, version?: string): SetupReport => {
		const usable = status === "ready" || status === "created" || status === "repaired";
		const pathMessage = pathConfigured ? "" : `; ${binDir} is not on PATH`;
		const legacyMessage = legacyResources.length > 0 ? `; migrate legacy resources: ${legacyResources.join(", ")}` : "";
		return {
			status,
			ok: usable && pathConfigured && legacyResources.length === 0,
			changed,
			packageDir,
			cliPath,
			linkPath,
			pathConfigured,
			message: message + pathMessage + legacyMessage,
			legacyResources: [...legacyResources],
			...(version ? { version } : {}),
		};
	};

	try {
		({ packageDir, cliPath } = sourcePaths(requestedPackageDir));
	} catch (error) {
		return report("invalid", `invalid package source: ${error instanceof Error ? error.message : String(error)}`);
	}

	const currentIsLegacy = samePath(packageDir, legacyPackageDir);
	if (!currentIsLegacy) {
		if (lstatSync(legacyPackageDir, { throwIfNoEntry: false })) legacyResources.push(legacyPackageDir);
		const legacySkill = join(agentDir(env), "skills", "rex-subagent");
		if (lstatSync(legacySkill, { throwIfNoEntry: false })) legacyResources.push(legacySkill);
	}

	const readManagedTarget = (): string | undefined => {
		try {
			const state = JSON.parse(readFileSync(statePath, "utf8")) as { version?: number; linkPath?: string; target?: string };
			return state.version === 1 && state.linkPath === linkPath ? state.target : undefined;
		} catch {
			return undefined;
		}
	};

	const writeManagedTarget = (): void => {
		if (readManagedTarget() === cliPath) return;
		mkdirSync(agentDir(env), { recursive: true });
		const temporary = `${statePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: 1, linkPath, target: cliPath })}\n`);
			renameSync(temporary, statePath);
		} finally {
			rmSync(temporary, { force: true });
		}
	};

	try {
		const stat = lstatSync(binDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return report("conflict", `${binDir} is not a real directory`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return report("conflict", error instanceof Error ? error.message : String(error));
		}
		if (options.repair) mkdirSync(binDir, { recursive: true });
	}

	const healthCheck = async (): Promise<string> => {
		const result = await runner.run(cliPath, ["version"], { env, timeoutMs: 5_000 });
		const version = result.stdout.trim();
		if (result.code !== 0 || !/^rex-subagent \d/.test(version)) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
		}
		return version;
	};

	let link: ReturnType<typeof lstatSync> | undefined;
	try {
		link = lstatSync(linkPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return report("conflict", error instanceof Error ? error.message : String(error));
		}
	}

	if (!link) {
		if (!options.repair) return report("missing", `CLI link is missing: ${linkPath}`);
		let version: string;
		try {
			version = await healthCheck();
		} catch (error) {
			return report("unhealthy", `CLI health check failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			symlinkSync(cliPath, linkPath);
		} catch (error) {
			const wonRace = (error as NodeJS.ErrnoException).code === "EEXIST" &&
				lstatSync(linkPath).isSymbolicLink() &&
				resolve(dirname(linkPath), readlinkSync(linkPath)) === cliPath;
			if (!wonRace) return report("unhealthy", `CLI setup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			writeManagedTarget();
		} catch (error) {
			return report("unhealthy", `could not record managed link state: ${error instanceof Error ? error.message : String(error)}`);
		}
		return report("created", `created ${linkPath} -> ${cliPath}`, true, version);
	}

	if (!link.isSymbolicLink()) return report("conflict", `refusing to replace non-symlink ${linkPath}`);
	const target = resolve(dirname(linkPath), readlinkSync(linkPath));
	if (target === cliPath) {
		if (options.repair) {
			try {
				writeManagedTarget();
			} catch (error) {
				return report("unhealthy", `could not record managed link state: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return report("ready", `CLI link is current: ${linkPath}`);
	}
	if (!options.repair) return report("outdated", `CLI link points to ${target}`);
	if (currentIsLegacy) {
		return report("conflict", "multiple installations detected; the legacy checkout must not reclaim the managed CLI link");
	}
	const exactLegacyTarget = target === join(legacyPackageDir, "src", "cli.ts");
	if (!exactLegacyTarget && !isManagedTarget(target) && readManagedTarget() !== target) {
		return report("conflict", `refusing to replace foreign symlink ${linkPath} -> ${target}`);
	}

	try {
		const version = await healthCheck();
		const temporary = join(binDir, `.rex-subagent-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
		try {
			symlinkSync(cliPath, temporary);
			renameSync(temporary, linkPath);
		} finally {
			rmSync(temporary, { force: true });
		}
		writeManagedTarget();
		return report("repaired", `repaired ${linkPath} -> ${cliPath}`, true, version);
	} catch (error) {
		return report("unhealthy", `CLI repair failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
