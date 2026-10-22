import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// A separate extension publishes through the real host UI; the reader owns no backing state.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("status-produce", {
    description: "Publish isolated native status fixtures",
    handler: async (phase, ctx) => {
      if (phase === "first") {
        ctx.ui.setStatus("agent-mail-work", "work published");
        ctx.ui.setStatus("agent-mail", "\x1b[32mmail AssignedAgent active\x1b[0m");
      } else if (phase === "replace") {
        ctx.ui.setStatus("agent-mail", "mail ReplacementAgent idle");
      } else if (phase === "empty") {
        ctx.ui.setStatus("agent-mail", "");
      } else if (phase === "clear") {
        ctx.ui.setStatus("agent-mail", undefined);
      }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (process.env.METRICS_UNUSED !== "1") ctx.ui.setStatus("status-api-presence", "owned-native-status");
  });
}
