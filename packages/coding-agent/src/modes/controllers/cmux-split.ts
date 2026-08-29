import * as path from "node:path";
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { SessionManager } from "../../session/session-manager";
import { type OmpCommand, resolveOmpCommand } from "../../task/omp-command";

const CMUX_COMMAND_TIMEOUT_MS = 5_000;

export interface CmuxCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type CmuxProcessRunner = (
	command: string,
	args: readonly string[],
	env: Record<string, string | undefined>,
) => Promise<CmuxCommandResult>;

export interface CmuxSplitOptions {
	env?: Record<string, string | undefined>;
	runCmux?: CmuxProcessRunner;
	ompCommand?: OmpCommand;
	activeProfile?: string | null;
}

export interface CmuxSplitResult {
	forkSessionFile: string;
	forkSessionId: string;
	surfaceId: string;
	focused: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runCmuxProcess(
	command: string,
	args: readonly string[],
	env: Record<string, string | undefined>,
): Promise<CmuxCommandResult> {
	try {
		const child = Bun.spawn([command, ...args], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(CMUX_COMMAND_TIMEOUT_MS),
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	} catch (error) {
		throw new Error(`cmux command failed: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`/split requires ${name} from a cmux terminal`);
	return value;
}

async function runChecked(
	runCmux: CmuxProcessRunner,
	command: string,
	args: readonly string[],
	env: Record<string, string | undefined>,
	label: string,
): Promise<CmuxCommandResult> {
	const result = await runCmux(command, args, env);
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
		throw new Error(`${label}: ${detail}`);
	}
	return result;
}

function parseSurfaceId(stdout: string): string {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`cmux returned invalid split JSON: ${errorMessage(error)}`);
	}
	if (!payload || typeof payload !== "object") throw new Error("cmux split response was not an object");
	const surfaceId = Reflect.get(payload, "surface_id");
	if (typeof surfaceId !== "string" || surfaceId.length === 0) {
		throw new Error("cmux split response did not include surface_id");
	}
	return surfaceId;
}

function buildResumeCommand(command: OmpCommand, profile: string | null | undefined, sessionFile: string): string {
	const argv = [command.cmd, ...command.args, ...(profile ? ["--profile", profile] : []), "--resume", sessionFile];
	return `exec ${argv.map(arg => $.escape(arg)).join(" ")}`;
}

export async function splitSessionIntoCmux(
	sessionManager: SessionManager,
	options: CmuxSplitOptions = {},
): Promise<CmuxSplitResult> {
	const env = options.env ?? process.env;
	const workspaceId = requiredEnv(env, "CMUX_WORKSPACE_ID");
	const parentSurfaceId = requiredEnv(env, "CMUX_SURFACE_ID");
	requiredEnv(env, "CMUX_SOCKET_PATH");

	const sourceFile = sessionManager.getSessionFile();
	if (!sourceFile) throw new Error("/split requires a persisted session");
	const ompCommand = options.ompCommand ?? resolveOmpCommand();
	if (ompCommand.shell) throw new Error("/split requires a directly executable OMP command");

	await sessionManager.ensureOnDisk();
	await sessionManager.flush();
	const fork = await SessionManager.forkFrom(
		sourceFile,
		sessionManager.getCwd(),
		path.dirname(sourceFile),
		undefined,
		{
			suppressBreadcrumb: true,
		},
	);
	const forkSessionFile = fork.getSessionFile();
	const forkSessionId = fork.getSessionId();
	if (!forkSessionFile) {
		await fork.close();
		throw new Error("Failed to persist the forked session");
	}
	await fork.close();

	const cmux = env.CMUX_OMP_CMUX_BIN?.trim() || "cmux";
	const runCmux = options.runCmux ?? runCmuxProcess;
	let surfaceId: string;
	try {
		const split = await runChecked(
			runCmux,
			cmux,
			[
				"--json",
				"--id-format",
				"uuids",
				"new-split",
				"right",
				"--workspace",
				workspaceId,
				"--surface",
				parentSurfaceId,
				"--focus",
				"false",
			],
			env,
			"Failed to create cmux split",
		);
		surfaceId = parseSurfaceId(split.stdout);
	} catch (splitError) {
		try {
			await fork.dropSession(forkSessionFile);
		} catch (cleanupError) {
			throw new Error(
				`${errorMessage(splitError)}; cleanup failed, fork preserved at ${forkSessionFile}: ${errorMessage(cleanupError)}`,
				{ cause: splitError },
			);
		}
		throw splitError;
	}

	const activeProfile = options.activeProfile === undefined ? getActiveProfile() : options.activeProfile;
	const resumeCommand = buildResumeCommand(ompCommand, activeProfile, forkSessionFile);
	try {
		await runChecked(
			runCmux,
			cmux,
			["respawn-pane", "--workspace", workspaceId, "--surface", surfaceId, "--command", resumeCommand],
			env,
			"Failed to launch forked OMP session",
		);
	} catch (launchError) {
		try {
			await runChecked(
				runCmux,
				cmux,
				["close-surface", "--workspace", workspaceId, "--surface", surfaceId],
				env,
				"Failed to close unused cmux split",
			);
			await fork.dropSession(forkSessionFile);
		} catch (cleanupError) {
			throw new Error(
				`${errorMessage(launchError)}; cleanup failed, fork preserved at ${forkSessionFile}: ${errorMessage(cleanupError)}`,
				{ cause: launchError },
			);
		}
		throw launchError;
	}

	let focused = true;
	try {
		await runChecked(
			runCmux,
			cmux,
			["focus-panel", "--workspace", workspaceId, "--panel", surfaceId],
			env,
			"Failed to focus forked OMP session",
		);
	} catch {
		focused = false;
	}

	return { forkSessionFile, forkSessionId, surfaceId, focused };
}
