import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const prefixPath = fileURLToPath(new URL("../prompt-prefix.txt", import.meta.url));

export default function promptPrefix(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    // These prefixes are interpreted by OMP after input handlers run.
    if (event.source !== "interactive" || /^(?:[\/!$]|->|=>)/.test(event.text.trimStart())) return;
    try {
      const prefix = await readFile(prefixPath, "utf8");
      if (prefix.trim()) return { text: `${prefix}\n\n${event.text}` };
    } catch (error) {
      ctx.ui.notify(`Cannot read ${prefixPath}: ${error instanceof Error ? error.message : String(error)}. Sending original prompt.`, "warning");
    }
  });

  pi.registerCommand("prompt-prefix", {
    description: "Edit the text prepended to chat prompts; save empty to disable",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        pi.logger.warn("/prompt-prefix requires an interactive editor");
        return;
      }
      try {
        let current = "";
        try {
          current = await readFile(prefixPath, "utf8");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const edited = await ctx.ui.editor("Prompt prefix — save empty to disable", current);
        if (edited === undefined) return;
        await writeFile(prefixPath, edited, { encoding: "utf8", mode: 0o600 });
        ctx.ui.notify(edited.trim() ? "Prompt prefix saved; applies to your next chat prompt." : "Prompt prefix disabled.", "info");
      } catch (error) {
        ctx.ui.notify(`Cannot edit ${prefixPath}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
