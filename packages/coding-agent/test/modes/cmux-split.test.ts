import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CmuxCommandResult,
	type CmuxProcessRunner,
	splitSessionIntoCmux,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/cmux-split";
import type { SessionHeader, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

interface CmuxInvocation {
	command: string;
	args: string[];
}

const CMUX_ENV = {
	CMUX_SOCKET_PATH: "/tmp/cmux.sock",
	CMUX_WORKSPACE_ID: "workspace-parent",
	CMUX_SURFACE_ID: "surface-parent",
	CMUX_OMP_CMUX_BIN: "/custom/cmux",
};

function success(stdout: string = ""): CmuxCommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

describe("splitSessionIntoCmux", () => {
	let tempDir: string;
	let sessionDir: string;
	let parent: SessionManager;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `cmux split's test-${Snowflake.next()}`);
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(tempDir, { recursive: true });
		parent = SessionManager.create(tempDir, sessionDir);
		parent.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await parent.ensureOnDisk();
	});

	afterEach(async () => {
		await parent.close();
		removeSyncWithRetries(tempDir);
	});

	it("opens an independent fork without changing the active parent session", async () => {
		const calls: CmuxInvocation[] = [];
		const runCmux: CmuxProcessRunner = async (command, args) => {
			calls.push({ command, args: [...args] });
			if (args.includes("new-split")) return success('{"surface_id":"surface-child"}');
			return success();
		};
		const parentFile = parent.getSessionFile();
		const parentId = parent.getSessionId();

		const result = await splitSessionIntoCmux(parent, {
			env: CMUX_ENV,
			runCmux,
			ompCommand: { cmd: "/usr/bin/printf", args: ["[%s]\\n"], shell: false },
			activeProfile: "work",
		});

		expect(parent.getSessionFile()).toBe(parentFile);
		expect(parent.getSessionId()).toBe(parentId);
		expect(result.surfaceId).toBe("surface-child");
		expect(result.forkSessionFile).not.toBe(parentFile);
		expect(result.focused).toBe(true);

		const entries = await loadEntriesFromFile(result.forkSessionFile);
		const header = entries[0] as SessionHeader;
		const message = entries.find(entry => entry.type === "message") as SessionMessageEntry;
		expect(header.id).toBe(result.forkSessionId);
		expect(header.parentSession).toBe(parentId);
		expect(message.message).toEqual({ role: "user", content: "hello", timestamp: 1 });

		expect(calls[0]).toEqual({
			command: "/custom/cmux",
			args: [
				"--json",
				"--id-format",
				"uuids",
				"new-split",
				"right",
				"--workspace",
				"workspace-parent",
				"--surface",
				"surface-parent",
				"--focus",
				"false",
			],
		});
		expect(calls[1]?.args.slice(0, -1)).toEqual([
			"respawn-pane",
			"--workspace",
			"workspace-parent",
			"--surface",
			"surface-child",
			"--command",
		]);
		const launchCommand = calls[1]?.args.at(-1);
		expect(launchCommand).toBeDefined();
		const launch = Bun.spawnSync(["/bin/zsh", "-c", launchCommand ?? ""], { stdout: "pipe", stderr: "pipe" });
		expect(launch.exitCode).toBe(0);
		expect(launch.stdout.toString()).toBe(`[--profile]\n[work]\n[--resume]\n[${result.forkSessionFile}]\n`);
		expect(calls[2]?.args).toEqual(["focus-panel", "--workspace", "workspace-parent", "--panel", "surface-child"]);
	});

	it("removes the unused fork when cmux cannot create the pane", async () => {
		const runCmux: CmuxProcessRunner = async () => ({ exitCode: 1, stdout: "", stderr: "split failed" });

		await expect(
			splitSessionIntoCmux(parent, {
				env: CMUX_ENV,
				runCmux,
				ompCommand: { cmd: "omp", args: [], shell: false },
			}),
		).rejects.toThrow("split failed");

		expect(fs.readdirSync(sessionDir).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("reports the preserved fork when cleanup after pane creation failure also fails", async () => {
		vi.spyOn(SessionManager.prototype, "dropSession").mockRejectedValueOnce(new Error("delete failed"));
		const runCmux: CmuxProcessRunner = async () => ({ exitCode: 1, stdout: "", stderr: "split failed" });

		await expect(
			splitSessionIntoCmux(parent, {
				env: CMUX_ENV,
				runCmux,
				ompCommand: { cmd: "omp", args: [], shell: false },
			}),
		).rejects.toThrow("split failed; cleanup failed, fork preserved at");
	});

	it("closes the created pane before removing a fork whose launch failed", async () => {
		const calls: CmuxInvocation[] = [];
		const runCmux: CmuxProcessRunner = async (command, args) => {
			calls.push({ command, args: [...args] });
			if (args.includes("new-split")) return success('{"surface_id":"surface-child"}');
			if (args.includes("respawn-pane")) return { exitCode: 1, stdout: "", stderr: "respawn failed" };
			return success();
		};

		await expect(
			splitSessionIntoCmux(parent, {
				env: CMUX_ENV,
				runCmux,
				ompCommand: { cmd: "omp", args: [], shell: false },
			}),
		).rejects.toThrow("respawn failed");

		expect(calls.at(-1)?.args).toEqual([
			"close-surface",
			"--workspace",
			"workspace-parent",
			"--surface",
			"surface-child",
		]);
		expect(fs.readdirSync(sessionDir).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("preserves the fork when a failed launch pane cannot be closed safely", async () => {
		const runCmux: CmuxProcessRunner = async (_command, args) => {
			if (args.includes("new-split")) return success('{"surface_id":"surface-child"}');
			if (args.includes("respawn-pane")) return { exitCode: 1, stdout: "", stderr: "respawn failed" };
			return { exitCode: 1, stdout: "", stderr: "close failed" };
		};

		await expect(
			splitSessionIntoCmux(parent, {
				env: CMUX_ENV,
				runCmux,
				ompCommand: { cmd: "omp", args: [], shell: false },
			}),
		).rejects.toThrow("cleanup failed, fork preserved at");

		expect(fs.readdirSync(sessionDir).filter(name => name.endsWith(".jsonl"))).toHaveLength(2);
	});

	it("reports a missing persisted session before changing cmux topology", async () => {
		const inMemory = SessionManager.inMemory(tempDir);
		let called = false;
		const runCmux: CmuxProcessRunner = async () => {
			called = true;
			return success();
		};

		await expect(
			splitSessionIntoCmux(inMemory, {
				env: CMUX_ENV,
				runCmux,
				ompCommand: { cmd: "omp", args: [], shell: false },
			}),
		).rejects.toThrow("persisted session");
		expect(called).toBe(false);
	});
});
