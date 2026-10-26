import { hostname, homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getComposerStyle, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { resolveActiveRepoContextSync } from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { lowerRail, metricsSchema, recentCache, upperMetricFields } from "./rails";

/** Explicit loading only: no package discovery registration or editor ownership. */
export default function statusline(pi: ExtensionAPI): void {
  let nativeActivity = "";
  pi.registerComposerShape({
    label: "Personal native status line",
    description: "Themed rails with native activity alongside session facts",
    style: {
      ...getComposerStyle("borderless"),
      id: "personal-native-statusline",
      statusAttachment: "top-border",
      bottomBar: "none",
      bottomBarGap: false,
      renderTop(chrome) {
        // The host appends a rule after its native brand/spinner/timer. Keep its ANSI intact.
        nativeActivity = (chrome.topBorder?.content ?? "")
          .replace(/─+(?=(?:\x1b\[[0-9;]*m|\s)*$)/u, "");
        return undefined;
      },
    },
  });
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
    clearInterval(stopTimer);
    if (installed && context) {
      context.ui.setWidget("personal-statusline-upper", undefined);
      context.ui.setWidget("personal-statusline-lower", undefined);
    }
    installed = false;
    requestRender = undefined;
    nativeActivity = "";
    context = ctx;
    pending = [];
    cacheIdentity = undefined;
    generation++;
    lastVcsRead = 0;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (
      typeof Reflect.get(ctx, "getStatusLineMetrics") !== "function" ||
      typeof Reflect.get(ctx.ui, "getStatus") !== "function"
    ) {
      ctx.ui.notify(
        "Status line requires the supported compaction/rate/quota metrics API and read-only status getter. Use the verified companion host; native OMP remains available.",
        "warning",
      );
      return;
    }
    // Shapes are registered and disposed by the extension host; only keyed widgets reattach.
    installed = true;
    ctx.ui.setWidget(
      "personal-statusline-upper",
      (tui, theme) => {
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
            const { rate, fields } = upperMetricFields(
              snapshot.data, cache(active), active.getContextUsage()?.tokens, Date.now(),
            );
            const rateText = theme.fg("accent", rate.trimStart());
            const rateWidth = Bun.stringWidth(rateText);
            const availableWidth = Math.max(1, width);
            const reserve = Math.max(11, rateWidth);
            const metricRows: string[] = [];
            let metricRow = "";
            let metricWidth = Math.max(1, availableWidth - reserve - 2);
            const separator = theme.fg("dim", "  ·  ");
            for (const field of fields) {
              const value = theme.fg(field.tone, field.text);
              const joined = metricRow ? metricRow + separator + value : value;
              if (Bun.stringWidth(joined) <= metricWidth) metricRow = joined;
              else {
                if (metricRow) {
                  metricRows.push(metricRow);
                  metricWidth = availableWidth;
                }
                const wrapped = wrapTextWithAnsi(value, metricWidth);
                metricRows.push(...wrapped.slice(0, -1));
                metricRow = wrapped.at(-1) ?? "";
                if (metricRows.length) metricWidth = availableWidth;
              }
            }
            metricRows.push(metricRow);
            if (availableWidth >= reserve + 3) {
              const first = metricRows[0] ?? "";
              metricRows[0] = first +
                " ".repeat(availableWidth - Bun.stringWidth(first) - rateWidth) + rateText;
            } else {
              const metricsText = fields.map((field) => theme.fg(field.tone, field.text))
                .join(separator);
              // Extremely narrow terminals still retain both facts and the complete rate.
              metricRows.splice(0, metricRows.length,
                ...wrapTextWithAnsi(metricsText, availableWidth),
                ...wrapTextWithAnsi(rateText, availableWidth));
            }
            return [
              ...wrapTextWithAnsi(theme.bold(theme.fg("accent", title)), availableWidth),
              ...metricRows,
            ];
          },
        };
      },
      { placement: "aboveEditor" },
    );
    ctx.ui.setWidget(
      "personal-statusline-lower",
      (_tui, theme) => ({
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
            `⌂ ${hostname()}`,
            `◉ ${active.model?.name ?? active.model?.id ?? "model unavailable"}`,
            `▰ ${path}`,
          ];
          if (repositoryCwd === cwd && branchLabel) fields.push(`⎇ ${branchLabel}`);
          const separator = theme.fg("dim", "  ·  ");
          const renderedFields = fields.map((field, index) =>
            theme.fg(index === 1 ? "accent" : index === 3 ? "warning" : "muted",
              sanitizeStatusText(field)),
          );
          const getter = Reflect.get(active.ui, "getStatus");
          const status: unknown = typeof getter === "function"
            ? getter.call(active.ui, "agent-mail") : undefined;
          const identity = typeof status === "string"
            ? /^mail ([^\s]+) \S+(?: .*)?$/u.exec(status)?.[1] : undefined;
          const mail = identity && identity !== "unassigned"
            ? theme.fg("accent", `✉ ${sanitizeStatusText(identity)}`) : undefined;
          return lowerRail(
            [nativeActivity, ...renderedFields.slice(0, 2)].filter(Boolean),
            renderedFields.slice(2),
            mail,
            width,
            separator,
          );
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
    if (installed && context) {
      context.ui.setWidget("personal-statusline-upper", undefined);
      context.ui.setWidget("personal-statusline-lower", undefined);
    }
    installed = false;
    nativeActivity = "";
    generation++;
    context = undefined;
    pending = [];
    requestRender = undefined;
  });
}
