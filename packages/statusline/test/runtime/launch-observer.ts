import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cfgComposerShape, cfgStatusLinePreset } from "@oh-my-pi/pi-coding-agent/modes/settings";
export default function observer(pi: ExtensionAPI) {
  function record(kind: string, ctx: ExtensionContext) {
    fs.appendFileSync(
      process.env.LAUNCH_EVIDENCE!,
      JSON.stringify({
        kind,
        pid: process.pid,
        title: ctx.sessionManager.getSessionName(),
        session: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
        branch: ctx.sessionManager.getBranch(),
        model: ctx.model?.id,
        provider: ctx.model?.provider,
        editor: ctx.ui.getEditorComponent()?.name,
        shape: cfgComposerShape.get(pi.pi.settings),
        preset: cfgStatusLinePreset.get(pi.pi.settings),
      }) + "\n",
    );
  }
  pi.on("session_start", (_event, ctx) => record("start", ctx));
  pi.registerCommand("owned-seed", {
    description: "Create an owned named session with history",
    async handler(_args, ctx) {
      await ctx.newSession({
        setup: async (manager) => {
          await manager.setSessionName("Owned launcher continuity 🧭", "user");
          manager.appendMessage({
            role: "user",
            content: "owned retained history",
            timestamp: Date.now(),
          });
        },
      });
      record("seeded", ctx);
    },
  });
  pi.registerCommand("owned-probe", {
    description: "Observe normal-profile continuity",
    async handler(_args, ctx) {
      record("probe", ctx);
    },
  });
  pi.registerCommand("owned-exit", {
    description: "Exit through normal OMP terminal interaction",
    async handler(_args, ctx) {
      record("exit", ctx);
      ctx.shutdown();
    },
  });
}
