import * as fs from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage, Model, UsageReport, UsageLimit } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  cfgCompactionEnabled,
  cfgCompactionThresholdTokens,
  cfgCompactionModelThresholds,
  cfgCompactionKeepRecentTokens,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import statusline from "../../src/extension";
const output = process.env.STATUSLINE_EVIDENCE!;
const editorFactories = new WeakMap<object, number>();
let nextEditorFactory = 0;
function editorIdentity(ctx: ExtensionContext): number | undefined {
  const factory = ctx.ui.getEditorComponent();
  if (!factory) return undefined;
  let identity = editorFactories.get(factory);
  if (identity === undefined) {
    identity = ++nextEditorFactory;
    editorFactories.set(factory, identity);
  }
  return identity;
}
const title = "🧭 Investigate cache accounting across the entire selected deployment boundary";
let calls = 0,
  quotaFetches = 0,
  loop = false;
const epoch = Date.now();
const quotaMode = process.env.STATUSLINE_QUOTA ?? "both";
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
function quotaReport(): UsageReport | null {
  if (quotaMode === "unavailable") return null;
  const exhausted = quotaMode === "exhausted";
  const limits: UsageLimit[] = [
    {
      id: "weekly",
      label: "Weekly",
      scope: { provider: "statusline-ui-fixture", modelId: "model-one", windowId: "7d" },
      window: {
        id: "7d",
        label: "Weekly",
        resetsAt:
          quotaMode === "no-reset"
            ? undefined
            : epoch + (exhausted ? 120 * 60000 : (5 * 24 + 5) * 3600000),
      },
      amount: { unit: "percent", usedFraction: exhausted ? 0.96 : 0.59 },
      status: "ok",
    },
  ];
  if (quotaMode === "both" || exhausted)
    limits.push({
      id: "five-hour",
      label: "Five hour",
      scope: { provider: "statusline-ui-fixture", modelId: "model-one", windowId: "5h" },
      window: { id: "5h", label: "Five hour", resetsAt: epoch + (exhausted ? 30 : 192) * 60000 },
      amount: { unit: "percent", usedFraction: exhausted ? 1 : 0.26 },
      status: "ok",
    });
  return { provider: "statusline-ui-fixture", fetchedAt: Date.now(), limits };
}
const log = (value: unknown) => fs.appendFileSync(output, `${JSON.stringify(value)}\n`);
function delay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
function nativeMetrics(ctx: ExtensionContext): unknown {
  const getter = Reflect.get(ctx, "getStatusLineMetrics");
  return typeof getter === "function" ? getter.call(ctx) : undefined;
}
function response(
  model: Model,
  input = 100,
  cacheRead = 900,
  ending: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "owned fixture response" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: ending,
    timestamp: Date.now() + calls,
    usage: {
      input,
      cacheRead,
      cacheWrite: 0,
      output: 10,
      totalTokens: input + cacheRead + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function stream(model: Model) {
  const events = new AssistantMessageEventStream();
  const index = ++calls;
  const message = response(
    model,
    loop && index === 12 ? 9000 : 100,
    loop && index === 12 ? 1000 : 900,
  );
  message.content = [];
  void (async () => {
    events.push({ type: "start", partial: message });
    const text = { type: "text" as const, text: "" };
    message.content.push(text);
    events.push({ type: "text_start", contentIndex: 0, partial: message });
    const chunks = loop ? 1 : 12;
    for (let i = 0; i < chunks; i++) {
      await delay(loop ? 30 : 450);
      const delta = loop
        ? `loop-response-${index}`
        : Array.from(
            { length: 40 },
            (_, j) => `owned_${index}_${i}_${j}_${j * 7919 + i * 104729} `,
          ).join("");
      text.text += delta;
      events.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
    }
    events.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
    if ((loop && index < 12) || (!loop && index === 1)) {
      const toolCall = {
        type: "toolCall" as const,
        id: `owned-${index}`,
        name: "fixture_wait",
        arguments: { index },
      };
      message.content.push(toolCall);
      events.push({ type: "toolcall_start", contentIndex: 1, partial: message });
      events.push({
        type: "toolcall_delta",
        contentIndex: 1,
        delta: JSON.stringify(toolCall.arguments),
        partial: message,
      });
      events.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
      message.stopReason = "toolUse";
    }
    message.usage.output = loop && index === 12 ? 1000000 : 2500;
    events.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
  })().catch((error) => events.fail(error));
  return events;
}
export default function fixture(pi: ExtensionAPI) {
  // Observe the actual component output while still returning it to the real compiled composer.
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  let lastRead: unknown;
  const wrapped = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "on") return Reflect.get(target, property, receiver);
      return (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        const existing = handlers.get(name) ?? [];
        existing.push(handler);
        handlers.set(name, existing);
        return pi.on(name as "session_start", async (event, ctx) => {
          if (name.startsWith("session_"))
            log({
              kind: "lifecycle",
              name,
              session: ctx.sessionManager.getSessionId(),
              branch: ctx.sessionManager.getBranch(),
            });
          const ui = new Proxy(ctx.ui, {
            get(uiTarget, uiProperty, uiReceiver) {
              if (uiProperty === "notify")
                return (message: string, type: "info" | "warning" | "error") => {
                  log({ kind: "notification", message });
                  ctx.ui.notify(message, type);
                };
              if (uiProperty !== "setWidget") return Reflect.get(uiTarget, uiProperty, uiReceiver);
              return (key: string, content: unknown, options: unknown) => {
                log({ kind: "widget-installed", key });
                if (typeof content !== "function")
                  throw new Error("Expected real component widget");
                ctx.ui.setWidget(
                  key,
                  (...args) => {
                    const component = content(...args);
                    return {
                      ...component,
                      render(width: number) {
                        const rows = component.render(width);
                        log({
                          kind: "rail",
                          key,
                          width,
                          rows,
                          editor: ctx.ui.getEditorComponent()?.name,
                          editorIdentity: editorIdentity(ctx),
                          draft: ctx.ui.getEditorText(),
                          metrics: lastRead,
                          usage: ctx.getContextUsage(),
                          session: ctx.sessionManager.getSessionId(),
                          leaf: ctx.sessionManager.getLeafId(),
                          calls,
                          quotaFetches,
                        });
                        return rows;
                      },
                    };
                  },
                  options as { placement: "aboveEditor" | "belowEditor" },
                );
              };
            },
          });
          const observed = new Proxy(ctx, {
            get(target, key, receiver) {
              if (key === "ui") return ui;
              if (key === "getStatusLineMetrics")
                return () => {
                  lastRead = nativeMetrics(ctx);
                  return lastRead;
                };
              return Reflect.get(target, key, receiver);
            },
          });
          await handler(event, observed);
        });
      };
    },
  });
  statusline(wrapped);
  const base = {
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500000,
    maxTokens: 5000,
  };
  pi.registerProvider("statusline-ui-fixture", {
    baseUrl: "https://invalid.invalid",
    apiKey: "owned-noncredential",
    api: "statusline-ui-stream",
    models: [
      { ...base, id: "model-one", name: "GPT-6.1 Sol" },
      { ...base, id: "model-two", name: "Owned second model" },
      { ...base, id: "no-window", name: "Owned unknown context", contextWindow: 0 },
    ],
    streamSimple: stream,
    usage: {
      id: "statusline-ui-fixture",
      async fetchUsage() {
        quotaFetches++;
        return quotaReport();
      },
    },
  });
  pi.registerTool({
    name: "fixture_wait",
    label: "Owned local wait",
    description: "Owned deterministic local tool",
    parameters: { type: "object", properties: { index: { type: "number" } } },
    async execute(_id, _params, _signal, _update, ctx) {
      log({ kind: "tool-before", metrics: nativeMetrics(ctx) });
      await delay(loop ? 30 : 1000);
      log({ kind: "tool-after", metrics: nativeMetrics(ctx) });
      return { content: [{ type: "text", text: "owned-tool-done" }] };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.sessionManager.getSessionName()) await pi.setSessionName(title);
    log({ kind: "start", session: ctx.sessionManager.getSessionId() });
  });
  pi.on("agent_end", (_event, ctx) =>
    log({ kind: "agent-end", calls, metrics: nativeMetrics(ctx) }),
  );
  pi.registerCommand("fixture-probe", {
    description: "Observe current owned host",
    async handler(_args, ctx) {
      log({
        kind: "probe",
        draft: ctx.ui.getEditorText(),
        editor: ctx.ui.getEditorComponent()?.name,
        editorIdentity: editorIdentity(ctx),
        branch: ctx.sessionManager.getBranch(),
        metrics: nativeMetrics(ctx),
        calls,
        quotaFetches,
      });
    },
  });
  pi.registerCommand("fixture-loop", {
    description: "Enable twelve-response local tool loop",
    async handler() {
      loop = true;
      calls = 0;
    },
  });
  pi.registerCommand("fixture-clock", {
    description: "Advance only the owned fixture clock five minutes",
    async handler() {
      clockOffset += 5 * 60000;
      log({ kind: "clock-advanced" });
    },
  });
  pi.registerCommand("fixture-case", {
    description: "Construct owned saved response histories",
    async handler(args, ctx) {
      await ctx.newSession({
        setup: async (manager) => {
          await manager.setSessionName(title, "auto");
          manager.appendMessage({
            role: "user",
            content: "owned history prompt",
            timestamp: Date.now(),
          });
          const append = (
            input: number,
            read: number,
            ending: AssistantMessage["stopReason"] = "stop",
          ) => manager.appendMessage(response(ctx.model!, input, read, ending));
          if (args.startsWith("meter-")) {
            const message = response(ctx.model!, Number(args.slice(6)), 0);
            if (Number(args.slice(6)) === 0) {
              // A real zero estimate needs a usable native anchor, not an all-zero usage report.
              message.usage.input = 1;
              message.usage.totalTokens = 11;
              message.contextSnapshot = {
                promptTokens: 1,
                historyRewriteTokensRemoved: 1,
                nonMessageTokens: ctx.getContextUsage()?.tokens ?? 0,
              };
            }
            manager.appendMessage(message);
          }
          if (args === "old") {
            append(100000, 0);
            append(0, 100000);
          }
          if (args === "pair" || args === "endings") {
            append(100, 900);
            if (args === "pair")
              manager.appendMessage({
                role: "user",
                content: "owned second turn",
                timestamp: Date.now(),
              });
            append(900, 100, args === "endings" ? "toolUse" : "stop");
          }
          if (args === "endings") {
            append(500, 500, "length");
            append(0, 100000, "error");
            append(900000, 0, "aborted");
          }
          if (args === "zero" || args === "missing") {
            append(0, 100000);
            for (let i = 0; i < 10; i++) {
              const message = response(ctx.model!, 0, 0);
              if (args === "missing" && i === 9)
                Reflect.deleteProperty(message.usage, "cacheWrite");
              manager.appendMessage(message);
            }
          }
        },
      });
      await ctx.reload();
      log({ kind: "case-ready", case: args, session: ctx.sessionManager.getSessionId() });
    },
  });
  pi.registerCommand("fixture-history", {
    description: "Create owned saved branch response fixtures",
    async handler(args, ctx) {
      const rate = Number(args) || 20;
      await ctx.newSession({
        setup: async (manager) => {
          await manager.setSessionName(title, "auto");
          manager.appendMessage({
            role: "user",
            content: "owned saved prompt",
            timestamp: Date.now(),
          });
          manager.appendMessage(response(ctx.model!, 1000 - rate * 10, rate * 10));
        },
      });
      await ctx.reload();
      log({
        kind: "history-ready",
        rate,
        session: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
        leaf: ctx.sessionManager.getLeafId(),
        titleOrigin: ctx.sessionManager
          .getEntries()
          .findLast((entry) => entry.type === "title_change"),
      });
    },
  });
  pi.registerCommand("fixture-switch", {
    description: "Switch owned saved session",
    async handler(args, ctx) {
      await ctx.switchSession(args);
      log({ kind: "switched", session: ctx.sessionManager.getSessionId() });
    },
  });
  pi.registerCommand("fixture-model", {
    description: "Switch model without replacing branch",
    async handler(args, ctx) {
      await pi.setModel(
        ctx.modelRegistry.find("statusline-ui-fixture", args.trim() || "model-two")!,
      );
      log({ kind: "model-switched" });
    },
  });
  pi.registerCommand("fixture-overlap", {
    description: "Redeliver real last persisted completion",
    async handler(_args, ctx) {
      const last = ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === "message" && e.message.role === "assistant")
        .at(-1);
      if (last?.type === "message")
        for (const handler of handlers.get("message_end") ?? [])
          await handler({ type: "message_end", message: last.message }, ctx);
      log({ kind: "overlap" });
    },
  });
  pi.registerCommand("fixture-budget", {
    description: "Change only owned central compaction settings",
    async handler(args) {
      cfgCompactionEnabled.override(pi.pi.settings, args !== "off");
      if (args === "model")
        cfgCompactionModelThresholds.override(pi.pi.settings, {
          "statusline-ui-fixture/model-two": "f250000",
        });
      else if (args !== "off") cfgCompactionThresholdTokens.override(pi.pi.settings, Number(args));
      log({ kind: "budget-changed", value: args });
    },
  });
  pi.registerCommand("fixture-compact", {
    description: "Run real owned context compaction",
    async handler(_args, ctx) {
      cfgCompactionKeepRecentTokens.override(pi.pi.settings, 0);
      await ctx.compact({ mode: "soft" });
      log({
        kind: "compacted",
        usage: ctx.getContextUsage(),
        compactions: ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction")
          .length,
      });
    },
  });
  pi.registerCommand("fixture-tree", {
    description: "Create two real branches plus excluded usage and tool messages",
    async handler(_args, ctx) {
      let first = "",
        second = "";
      await ctx.newSession({
        setup: async (manager) => {
          await manager.setSessionName(title, "auto");
          const root = manager.appendMessage({
            role: "user",
            content: "owned tree root",
            timestamp: Date.now(),
          });
          first = manager.appendMessage(response(ctx.model!, 100, 900));
          manager.branch(root);
          second = manager.appendMessage(response(ctx.model!, 800, 200));
          const usage = response(ctx.model!, 0, 100000);
          manager.appendModelUsage(
            {
              purpose: "owned nontranscript",
              api: usage.api,
              provider: usage.provider,
              model: usage.model,
              usage: usage.usage,
              stopReason: "stop",
            },
            { sessionId: manager.getSessionId(), parentId: manager.getLeafId() },
          );
          manager.appendMessage({
            role: "toolResult",
            toolCallId: "owned-history-tool",
            toolName: "fixture_wait",
            content: [{ type: "text", text: "not a response" }],
            isError: false,
            timestamp: Date.now(),
          });
        },
      });
      await ctx.reload();
      log({ kind: "tree-ready", first, second, session: ctx.sessionManager.getSessionId() });
    },
  });
  pi.registerCommand("fixture-navigate", {
    description: "Use the real supported tree navigation action",
    async handler(args, ctx) {
      await ctx.navigateTree(args, { summarize: false });
      log({ kind: "navigated", session: ctx.sessionManager.getSessionId() });
    },
  });
  pi.registerCommand("fixture-exit", {
    description: "Exit owned host",
    async handler(_args, ctx) {
      log({
        kind: "exit",
        draft: ctx.ui.getEditorText(),
        editor: ctx.ui.getEditorComponent()?.name,
        editorIdentity: editorIdentity(ctx),
      });
      ctx.shutdown();
    },
  });
}
