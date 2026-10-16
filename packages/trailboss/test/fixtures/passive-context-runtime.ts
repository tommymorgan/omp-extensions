import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { registerCustomApi, type Api, type AssistantMessage, type Context, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession, Settings, type ExtensionContext, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import trailboss from "tommy-omp-trailboss";

// This child deliberately uses real AgentSession, extension loading, EventBus,
// context conversion, provider dispatch and tool execution. Only the provider's
// remote I/O is replaced at the SDK's custom-API seam. It never echoes context.
const order = process.argv[2];
assert.ok(order === "producer-first" || order === "trailboss-first");
const api = "trailboss-passive-runtime";
const provider = "trailboss-fixture";
const bus = new EventBus();
const requests: Context[] = [];
const errors: unknown[] = [];
const lifecycle: string[] = [];
const allEvents: string[] = [];
const contextSnapshots: unknown[][] = [];
const toolSignals: (AbortSignal | undefined)[] = [];
const toolCompletions: string[] = [];
const requestEntered = Promise.withResolvers<void>();
const requestRelease = Promise.withResolvers<void>();
const toolEntered = Promise.withResolvers<void>();
const toolRelease = Promise.withResolvers<void>();
let racePublication = false;
let publishAtAgentEnd = false;
let startupCount = 0;
let sessionId = "";

// Any accidental network path is a failure, not a request to a real account.
globalThis.fetch = (async () => { throw new Error("Unexpected network I/O in passive-context fixture"); }) as typeof fetch;

function publish(id: string, value: string, source = "runtime-fixture", customType = "runtime-fixture-context"): void {
  let accepted = false;
  bus.emit("trailboss:context:publish", {
    source,
    sessionId: id,
    message: {
      customType,
      content: value,
      display: false,
      details: { fixtureScope: id, fixtureVersion: value },
    },
    accept() { accepted = true; },
  });
  assert.equal(accepted, true, "real extension must synchronously accept the cached publication");
}

const producer: ExtensionFactory = pi => {
  const start = async (_event: unknown, ctx: ExtensionContext) => {
    sessionId = ctx.sessionManager.getSessionId();
    startupCount++;
    await publish(sessionId, `TRAILBOSS_BOOT_${startupCount}`);
  };
  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.registerTool({
    name: "fixture_hold",
    label: "Fixture hold",
    description: "Deterministically gate a harmless foreground tool batch.",
    parameters: pi.arktype({ label: "string" }),
    async execute(_id, params, signal) {
      toolSignals.push(signal);
      toolEntered.resolve();
      await toolRelease.promise;
      assert.notEqual(signal?.aborted, true, "context publication must not interrupt foreground tools");
      toolCompletions.push(params.label);
      return { content: [{ type: "text", text: `completed ${params.label}` }], details: {} };
    },
  });
};
const observeContext: ExtensionFactory = pi => {
  pi.on("context", event => {
    contextSnapshots.push(structuredClone(event.messages));
  });
};

function message(tools = false): AssistantMessage {
  return {
    role: "assistant",
    api,
    provider,
    model: "deterministic",
    content: tools
      ? [
          { type: "toolCall", id: "fixture-a", name: "fixture_hold", arguments: { label: "a" } },
          { type: "toolCall", id: "fixture-b", name: "fixture_hold", arguments: { label: "b" } },
        ]
      : [{ type: "text", text: "Ordinary foreground work completed." }],
    stopReason: tools ? "toolUse" : "stop",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

registerCustomApi(api, (_model, context) => {
  // Runtime tool schemas can contain functions; snapshot only the provider's
  // message payload, which is the immutable evidence needed by these assertions.
  requests.push({ ...context, messages: structuredClone(context.messages) });
  const number = requests.length;
  const stream = new AssistantMessageEventStream();
  void (async () => {
    if (number === 2) {
      requestEntered.resolve();
      await requestRelease.promise;
    }
    const result = message(number === 2);
    stream.push({ type: "start", partial: result });
    // The real loop intentionally drops tool calls that never reached a
    // toolcall_end boundary (incomplete arguments are unsafe to execute).
    for (const [contentIndex, block] of result.content.entries()) {
      if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: result });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: result });
      }
    }
    stream.push({ type: "done", reason: result.stopReason === "toolUse" ? "toolUse" : "stop", message: result });
  })().catch(error => { errors.push(error); stream.end(); });
  return stream;
});

const model = buildModel({
  id: "deterministic", name: "Trailboss deterministic runtime fixture", api, provider,
  baseUrl: "http://127.0.0.1:1/never-used", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768, maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;
const cwd = process.cwd();
const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
authStorage.keys.setRuntime(provider, "synthetic-local-fixture-key");
const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"));
const { session } = await createAgentSession({
  cwd,
  agentDir: join(cwd, "agent"),
  sessionManager: SessionManager.inMemory(cwd),
  authStorage,
  modelRegistry,
  model,
  eventBus: bus,
  settings: Settings.isolated({ "compaction.enabled": false, "provider.appendOnlyContext": "off" }),
  disableExtensionDiscovery: true,
  extensions: order === "producer-first" ? [producer, trailboss, observeContext] : [trailboss, producer, observeContext],
  skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [],
  toolNames: [], enableMCP: false, enableLsp: false, skipPythonPreflight: true,
  taskDepth: 1, agentId: "SubAgent",
});

session.subscribe(event => {
  allEvents.push(event.type);
  if (["agent_start", "agent_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) {
    lifecycle.push(event.type);
  }
  // Publish at the actual active -> idle boundary, not after an arbitrary sleep.
  if (event.type === "agent_end" && publishAtAgentEnd) {
    publishAtAgentEnd = false;
    publish(session.sessionId, "TRAILBOSS_IDLE_RACE");
    racePublication = true;
  }
});

async function quiesce() {
  // Event-loop barriers drain queued continuations without guessing a duration.
  await setImmediate();
  await setImmediate();
  assert.deepEqual(errors, []);
}
function counts() {
  return { requests: requests.length, lifecycle: lifecycle.length, events: allEvents.length };
}
function requestText(index: number) {
  assert.ok(requests[index], `provider request ${index + 1} must exist`);
  return JSON.stringify(requests[index].messages);
}
function latest(index: number, value: string, absent: string[]) {
  const text = requestText(index);
  assert.equal(text.split(value).length - 1, 1, "latest snapshot must appear exactly once at the actual provider boundary");
  for (const old of absent) assert.equal(text.includes(old), false, `superseded/foreign snapshot leaked: ${old}`);
}

try {
  await initializeExtensions(session, {
    reportSendError: (_action, error) => errors.push(error),
    reportRuntimeError: error => errors.push(error),
  });
  await quiesce();
  assert.equal(startupCount, 1);
  assert.equal(requests.length, 0, "startup context must not call a provider");
  assert.deepEqual(lifecycle, [], "startup context must not create attention-clearing lifecycle events");

  const idle = counts();
  await publish(sessionId, "TRAILBOSS_IDLE_OLD");
  await publish(sessionId, "TRAILBOSS_IDLE_LATEST");
  await publish("different-session", "TRAILBOSS_FOREIGN", "foreign-fixture", "foreign-fixture-context");
  await quiesce();
  assert.deepEqual(counts(), idle, "idle routine updates must emit zero source lifecycle/message events; existing unread attention has nothing to clear");
  await session.sendUserMessage("Perform ordinary foreground work, without tools.");
  assert.ok(requests.length > 0, `Ordinary user prompt never reached provider: ${JSON.stringify(session.agent.state.messages)}`);
  latest(0, "TRAILBOSS_IDLE_LATEST", ["TRAILBOSS_BOOT_1", "TRAILBOSS_IDLE_OLD", "TRAILBOSS_FOREIGN"]);
  assert.equal(requests.length, 1);
  assert.equal(lifecycle.filter(type => type === "agent_start").length, 1);
  assert.equal(lifecycle.filter(type => type === "agent_end").length, 1);
  const injected = contextSnapshots[0].find(value => value !== null && typeof value === "object" && "customType" in value && value.customType === "runtime-fixture-context");
  assert.ok(injected !== null && typeof injected === "object" && "display" in injected && "details" in injected);
  assert.equal(injected.display, false);
  assert.deepEqual(injected.details, {
    fixtureScope: sessionId,
    fixtureVersion: "TRAILBOSS_IDLE_LATEST",
    trailbossContext: { source: "runtime-fixture", sessionId },
  });

  const active = session.sendUserMessage("Run the harmless fixture tool batch and finish normally.");
  const endedBeforeGate = active.then(() => {
    throw new Error(`Foreground work completed before expected gate: ${JSON.stringify(session.agent.state.messages)}`);
  });
  await Promise.race([requestEntered.promise, endedBeforeGate]);
  const duringRequest = counts();
  await publish(sessionId, "TRAILBOSS_DURING_REQUEST");
  await quiesce();
  assert.deepEqual(counts(), duringRequest, "publication must not independently resume or interrupt an active provider request");
  requestRelease.resolve();
  await Promise.race([toolEntered.promise, endedBeforeGate]);
  // Let the runtime finish dispatching the batch's start events while every
  // executing tool is held; those ordinary starts are not publication effects.
  await quiesce();
  const duringTool = counts();
  await publish(sessionId, "TRAILBOSS_DURING_TOOL_OLD");
  await publish(sessionId, "TRAILBOSS_DURING_TOOL_LATEST");
  await quiesce();
  assert.deepEqual(counts(), duringTool, "publication must not create a tool interruption or independent continuation");
  assert.equal(toolCompletions.length, 0);
  assert.ok(toolSignals.every(signal => !signal?.aborted));
  publishAtAgentEnd = true;
  toolRelease.resolve();
  await active;
  await quiesce();
  assert.deepEqual(toolCompletions.slice().sort(), ["a", "b"]);
  assert.equal(requests.length, 3, "one ordinary tool continuation, no context-triggered provider request");
  latest(2, "TRAILBOSS_DURING_TOOL_LATEST", ["TRAILBOSS_IDLE_LATEST", "TRAILBOSS_DURING_REQUEST", "TRAILBOSS_DURING_TOOL_OLD", "TRAILBOSS_FOREIGN"]);
  assert.equal(lifecycle.filter(type => type === "agent_start").length, 2);
  assert.equal(lifecycle.filter(type => type === "agent_end").length, 2);
  assert.ok(racePublication, "the active-to-idle publication must actually have executed");

  const afterRace = counts();
  await publish(sessionId, "TRAILBOSS_IDLE_RACE_LATEST");
  await quiesce();
  assert.deepEqual(counts(), afterRace, "idle-after-active updates must preserve unread attention by producing zero lifecycle events");
  await session.sendUserMessage("Continue ordinary user work after the active-to-idle publication.");
  latest(3, "TRAILBOSS_IDLE_RACE_LATEST", ["TRAILBOSS_DURING_TOOL_LATEST", 'TRAILBOSS_IDLE_RACE"', "TRAILBOSS_FOREIGN"]);
  assert.equal(requests.length, 4);

  const previousSession = sessionId;
  assert.equal(await session.newSession(), true);
  assert.notEqual(sessionId, previousSession);
  assert.equal(startupCount, 2);
  const switched = counts();
  await quiesce();
  assert.deepEqual(counts(), switched, "new-session publication during producer lifecycle must remain passive in either registration order");
  await session.sendUserMessage("Perform ordinary work in this independent session.");
  latest(4, "TRAILBOSS_BOOT_2", ["TRAILBOSS_IDLE_RACE", "TRAILBOSS_DURING_TOOL", "TRAILBOSS_FOREIGN", "TRAILBOSS_BOOT_1"]);
  assert.equal(requests.length, 5);
  assert.equal(lifecycle.filter(type => type === "agent_start").length, 4);
  assert.equal(lifecycle.filter(type => type === "agent_end").length, 4);
  assert.deepEqual(errors, []);
} finally {
  requestRelease.resolve();
  toolRelease.resolve();
  await session.dispose();
  authStorage.close();
}
console.log(`PASS passive-context ${order}`);
