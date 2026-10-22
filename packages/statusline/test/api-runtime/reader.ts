import * as fs from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage, Model, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
const provider = "statusline-owned-fixture";
const output = process.env.METRICS_EVIDENCE!;
let calls = 0,
  fetches = 0,
  accountId = "account-A";
const reset = 1900000000123;
function delay(ms: number) {
  const pending = Promise.withResolvers<void>();
  setTimeout(pending.resolve, ms);
  return pending.promise;
}
function log(value: unknown) {
  fs.appendFileSync(output, JSON.stringify(value) + "\n");
}
function sample(label: string, ctx: ExtensionContext) {
  const before = fetches;
  const getter = Reflect.get(ctx, "getStatusLineMetrics");
  const metrics =
    process.env.METRICS_UNUSED !== "1" && typeof getter === "function" ? getter.call(ctx) : null;
  if (process.env.METRICS_UNUSED !== "1" && typeof getter === "function")
    for (let i = 0; i < 100; i++) getter.call(ctx);
  log({
    label,
    mode: ctx.mode,
    metrics,
    usage: ctx.getContextUsage(),
    calls,
    fetches,
    readFetches: fetches - before,
    accountId,
    model: ctx.model?.id,
  });
}
function stream(model: Model) {
  const events = new AssistantMessageEventStream();
  const response: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 100,
      output: 0,
      cacheRead: 900,
      cacheWrite: 0,
      totalTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const index = ++calls;
  void (async () => {
    events.push({ type: "start", partial: response });
    const text = { type: "text" as const, text: "" };
    response.content.push(text);
    events.push({ type: "text_start", contentIndex: 0, partial: response });
    const chunks = index === 1 && process.env.METRICS_FAST !== "1" ? 12 : 1;
    for (let i = 0; i < chunks; i++) {
      if (chunks > 1) await delay(450);
      const delta =
        chunks > 1
          ? Array.from(
              { length: 40 },
              (_, j) => `owned_${i}_${j}_${(j * 7919 + i * 104729).toString(36)} `,
            ).join("")
          : "owned-fixture-complete";
      text.text += delta;
      events.push({ type: "text_delta", contentIndex: 0, delta, partial: response });
    }
    events.push({ type: "text_end", contentIndex: 0, content: text.text, partial: response });
    if (index === 1 && chunks > 1) {
      const toolCall = {
        type: "toolCall" as const,
        id: "owned-wait-1",
        name: "fixture_wait",
        arguments: {},
      };
      response.content.push(toolCall);
      events.push({ type: "toolcall_start", contentIndex: 1, partial: response });
      events.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: response });
      events.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: response });
      response.stopReason = "toolUse";
    }
    response.usage.output = chunks > 1 ? 2500 : 10;
    response.usage.totalTokens = 1000 + response.usage.output;
    response.duration = Date.now() - response.timestamp;
    events.push({
      type: "done",
      reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
      message: response,
    });
  })().catch((error) => {
    log({ label: "fixture-error", error: String(error), stack: error?.stack });
    events.fail(error);
  });
  return events;
}
export default function (pi: ExtensionAPI) {
  const base = {
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500000,
    maxTokens: 5000,
  };
  pi.registerProvider(provider, {
    baseUrl: "https://invalid.invalid",
    apiKey: "owned-noncredential",
    api: "statusline-owned-stream",
    models: [
      { ...base, id: "model-one", name: "Owned fixture one" },
      { ...base, id: "model-two", name: "Owned fixture two" },
      { ...base, id: "no-window", name: "Owned no window", contextWindow: 0 },
    ],
    streamSimple: stream,
    usage: {
      id: provider,
      async fetchUsage(): Promise<UsageReport> {
        fetches++;
        log({ label: "native-usage-fetch", fetches, accountId });
        return {
          provider,
          fetchedAt: Date.now(),
          metadata: { accountId },
          limits: [
            {
              id: "weekly",
              label: "Weekly",
              scope: { provider, accountId, modelId: "model-one", windowId: "7d" },
              window: { id: "7d", label: "Weekly", resetsAt: reset },
              amount: { unit: "percent", usedFraction: 0.59 },
              status: "ok",
            },
            {
              id: "five-hour",
              label: "Five hour",
              scope: { provider, accountId, modelId: "model-one", windowId: "5h" },
              window: { id: "5h", label: "Five hour", resetsAt: reset - 100000 },
              amount: { unit: "percent", usedFraction: 0 },
              status: "ok",
            },
            {
              id: "wrong-model",
              label: "Wrong model",
              scope: { provider, accountId, modelId: "not-active", windowId: "7d" },
              amount: { unit: "percent", usedFraction: 0.99 },
              status: "ok",
            },
          ],
        };
      },
    },
  });
  pi.registerTool({
    name: "fixture_wait",
    label: "Owned wait",
    description: "Deterministic local tool fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _update, ctx) {
      sample("tool-before", ctx);
      await delay(1000);
      sample("tool-during", ctx);
      return { content: [{ type: "text", text: "owned-tool-complete" }] };
    },
  });
  pi.on("session_start", async (_, ctx) => {
    // Only this process's isolated fixture registry is changed; no stored account or credentials are touched.
    ctx.modelRegistry.authStorage.oauth.identity = () => ({ accountId });
    sample("session_start", ctx);
  });
  pi.on("message_update", async (_event, ctx) => sample("message_update", ctx));
  pi.on("message_end", async (event, ctx) => {
    log({ label: "message-evidence", event });
    sample("message_end", ctx);
  });
  pi.on("tool_execution_start", async (_event, ctx) => sample("tool_execution_start", ctx));
  pi.on("tool_execution_end", async (_event, ctx) => sample("tool_execution_end", ctx));
  pi.on("agent_end", async (_event, ctx) => sample("agent_end", ctx));
  pi.registerCommand("metrics-probe", {
    description: "Read owned fixture metrics",
    handler: async (_, ctx) => sample("probe", ctx),
  });
  pi.registerCommand("metrics-account", {
    description: "Switch owned identity fixture",
    handler: async (_, ctx) => {
      accountId = "account-B";
      sample("account-switch", ctx);
    },
  });
  pi.registerCommand("metrics-model", {
    description: "Switch owned model scope",
    handler: async (_, ctx) => {
      await pi.setModel(ctx.modelRegistry.find(provider, "model-two")!);
      sample("model-switch", ctx);
    },
  });
  pi.registerCommand("metrics-exit", {
    description: "Finish owned fixture",
    handler: async (_, ctx) => {
      sample("finish", ctx);
      ctx.shutdown();
    },
  });
}
