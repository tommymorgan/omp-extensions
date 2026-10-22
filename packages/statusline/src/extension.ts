import { hostname, homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { resolveActiveRepoContextSync } from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { metricsSchema, recentCache, upperMetrics } from "./rails";

/** Explicit loading only: no package discovery registration or editor ownership. */
export default function statusline(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let requestRender: (() => void) | undefined;
  let branchLabel: string | undefined;
  let repositoryCwd: string | undefined;
  let lastVcsRead = 0;
  let readingVcs = false;
  let generation = 0;
  let pending: unknown[] = [];
  let installed = false;
  let cacheIdentity: string | undefined;
  let cachedPercentage: number | undefined;
  let completionRevision = 0;
  const key = (message: unknown) => JSON.stringify(message);
  function cache(ctx: ExtensionContext): number | undefined {
    const identity = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}:${completionRevision}`;
    if (identity === cacheIdentity) return cachedPercentage;
    const messages = ctx.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const known = new Set(messages.map(key));
    cachedPercentage = recentCache([
      ...messages,
      ...pending.filter((message) => !known.has(key(message))),
    ]);
    cacheIdentity = identity;
    return cachedPercentage;
  }
  async function refreshVcs(ctx: ExtensionContext): Promise<void> {
    if (readingVcs || Date.now() - lastVcsRead < 2000) return;
    readingVcs = true;
    const current = ++generation,
      cwd = ctx.cwd;
    try {
      const active = resolveActiveRepoContextSync(cwd);
      const root = active?.repoRoot ?? cwd;
      const repository = vcs.repoForDisplay(root);
      const label = await repository?.label(AbortSignal.timeout(1500));
      if (current === generation && context?.cwd === cwd) {
        branchLabel = label ? sanitizeStatusText(label) : undefined;
        repositoryCwd = cwd;
      }
    } catch {
      if (current === generation) branchLabel = undefined;
    } finally {
      readingVcs = false;
      lastVcsRead = Date.now();
      requestRender?.();
    }
  }
  function start(ctx: ExtensionContext): void {
    context = ctx;
    pending = [];
    cacheIdentity = undefined;
    generation++;
    lastVcsRead = 0;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (!("getStatusLineMetrics" in ctx) || typeof ctx.getStatusLineMetrics !== "function") {
      ctx.ui.notify(
        "Status line requires the supported compaction/rate/quota metrics API. Use the verified companion host; native OMP remains available.",
        "warning",
      );
      return;
    }
    // Session transitions replace the composer's widget host; reattach the same keyed rails.
    clearInterval(stopTimer);
    installed = true;
    ctx.ui.setWidget(
      "personal-statusline-upper",
      (tui) => {
        requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          render(width: number) {
            const active = context;
            if (!active) return [];
            const accessor = Reflect.get(active, "getStatusLineMetrics");
            const snapshot = metricsSchema.safeParse(
              typeof accessor === "function" ? accessor.call(active) : undefined,
            );
            if (!snapshot.success)
              return ["Status line unavailable: host metrics contract mismatch"];
            const title = sanitizeDisplaySingleLine(
              active.sessionManager.getSessionName() ?? "Untitled session",
            );
            return [
              ...wrapTextWithAnsi(title, Math.max(1, width)),
              ...wrapTextWithAnsi(
                upperMetrics(
                  snapshot.data,
                  cache(active),
                  active.getContextUsage()?.tokens,
                  Date.now(),
                ),
                Math.max(1, width),
              ),
            ];
          },
        };
      },
      { placement: "aboveEditor" },
    );
    ctx.ui.setWidget(
      "personal-statusline-lower",
      () => ({
        invalidate() {},
        render(width: number) {
          const active = context;
          if (!active) return [];
          void refreshVcs(active);
          const home = homedir(),
            cwd = active.cwd;
          const path =
            cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
          const fields = [
            hostname(),
            active.model?.name ?? active.model?.id ?? "model unavailable",
            path,
          ];
          if (repositoryCwd === cwd && branchLabel) fields.push(branchLabel);
          return wrapTextWithAnsi(fields.map(sanitizeStatusText).join("  ·  "), Math.max(1, width));
        },
      }),
      { placement: "belowEditor" },
    );
    // Only time-dependent presentation: quota countdowns and the host's retained native rate.
    stopTimer = setInterval(() => requestRender?.(), 1000);
    stopTimer.unref();
  }
  pi.on("session_start", (_event, ctx) => start(ctx));
  const transition = (_event: unknown, ctx: ExtensionContext) => start(ctx);
  pi.on("session_switch", transition);
  pi.on("session_branch", transition);
  pi.on("session_tree", transition);
  pi.on("message_end", (event, ctx) => {
    context = ctx;
    if (
      installed &&
      event.message.role === "assistant" &&
      event.message.stopReason !== "error" &&
      event.message.stopReason !== "aborted"
    ) {
      pending = [...pending.slice(-9), event.message];
      completionRevision++;
    }
    requestRender?.();
  });
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    context = ctx;
    requestRender?.();
  };
  pi.on("session_compact", refresh);
  pi.on("agent_end", refresh);
  pi.on("message_update", refresh);
  pi.on("session_shutdown", () => {
    clearInterval(stopTimer);
    generation++;
    context = undefined;
    pending = [];
    requestRender = undefined;
  });
}
