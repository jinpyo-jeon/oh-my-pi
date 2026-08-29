import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/split slash command", () => {
	it("starts the split while the parent response is still streaming", async () => {
		const handleSplitCommand = vi.fn(async () => {});
		const setText = vi.fn();
		const runtime = {
			ctx: {
				collabGuest: false,
				session: { isStreaming: true },
				handleSplitCommand,
				editor: { setText },
			} as unknown as InteractiveModeContext,
		};

		expect(await executeBuiltinSlashCommand("/split", runtime)).toBe(true);
		expect(handleSplitCommand).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
	});
});
