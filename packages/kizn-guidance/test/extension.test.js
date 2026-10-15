import { expect, mock, test } from "bun:test";

let currentManager;
mock.module("@oh-my-pi/pi-coding-agent/mcp/manager", () => ({
  MCPManager: { instance: () => currentManager },
}));
const { default: install } = await import("../src/index.ts");
const instructions = { bootstrap: "Scoped", rules: [], memories: [], referencedItems: [], catalog: {}, agentGuidance: {} };

function harness() {
  const handlers = new Map();
  const sent = [];
  const calls = [];
  const statuses = new Set();
  let version = "v1";
  let start = async () => ({ content: [{ type: "text", text: JSON.stringify({ handle: "private-subscription", instructionsVersion: version, instructions }) }] });
  const native = {
    capabilities: { resources: { subscribe: true } }, config: { type: "http" },
    transport: {
      async startSSEListener() { calls.push({ method: "listener" }); },
      async request(method, params) {
        calls.push({ method, params });
        if (method === "tools/call") return start();
        if (method === "resources/read") return { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify({ instructionsVersion: version, instructions }) }] };
        return {};
      },
    },
  };
  currentManager = {
    getConnection: () => native,
    addConnectionStatusListener(callback) { statuses.add(callback); return () => statuses.delete(callback); },
  };
  const ctx = { cwd: "/repo", hasUI: false, sessionManager: { getSessionId: () => "session-one" } };
  install({
    on(name, handler) { handlers.set(name, handler); },
    async exec(command, args) {
      calls.push({ method: command, args });
      return { code: 0, stdout: "origin\tgit@example.test:one/repo.git (fetch)\norigin\tgit@example.test:one/repo.git (push)\n", stderr: "" };
    },
    sendMessage(message, options) { sent.push({ message, options }); },
  });
  return {
    calls, sent, ctx, statuses,
    emit: (event, value = {}, context = ctx) => handlers.get(event)?.(value, context),
    version(next) { version = next; },
    start(next) { start = next; },
  };
}

test("activation bootstraps its own actual Git scope even if all model tools run through Eval", async () => {
  const h = harness();
  await h.emit("session_start");
  expect(h.calls.find(c => c.method === "tools/call")?.params).toEqual({
    name: "start_session", arguments: { remoteUrls: ["git@example.test:one/repo.git"] },
  });
  const prepared = await h.emit("before_agent_start");
  expect(prepared.message.content).toContain('"instructionsVersion":"v1"');
  expect(prepared.message.content).not.toContain("private-subscription");
  h.version("v2");
  await h.emit("mcp_notification", { server: "kizn", method: "notifications/resources/updated", params: { uri: "kizn://instructions/private-subscription" } });
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].options).toEqual({ deliverAs: "aside" });
  expect(h.sent[0].message.content).toContain('"instructionsVersion":"v2"');
  expect(h.sent[0].message.content).not.toContain("private-subscription");
  const context = await h.emit("context", { messages: [prepared.message, h.sent[0].message] });
  expect(context.messages).toEqual([h.sent[0].message]);
  await h.emit("session_shutdown");
  expect(h.statuses.size).toBe(0);
  expect(h.calls.at(-1).method).toBe("resources/unsubscribe");
});

test("forks create a fresh scoped session and exclude inherited instruction messages", async () => {
  const h = harness();
  await h.emit("session_start");
  const old = await h.emit("before_agent_start");
  const fork = { ...h.ctx, sessionManager: { getSessionId: () => "session-fork" } };
  await h.emit("session_branch", {}, fork);
  const prepared = await h.emit("before_agent_start", {}, fork);
  expect(h.calls.filter(c => c.method === "tools/call")).toHaveLength(2);
  const context = await h.emit("context", { messages: [old.message, prepared.message] }, fork);
  expect(context.messages).toEqual([prepared.message]);
  await h.emit("session_shutdown");
});

test("a late tools/call response cannot bind instructions after session shutdown", async () => {
  const h = harness();
  const pending = Promise.withResolvers();
  h.start(() => pending.promise);
  const activation = h.emit("session_start");
  // Wait until Git discovery has yielded to the native start request; no timers or polling.
  await Promise.resolve();
  await Promise.resolve();
  await h.emit("session_shutdown");
  pending.resolve({ content: [{ type: "text", text: JSON.stringify({ handle: "late", instructionsVersion: "late", instructions }) }] });
  await activation;
  expect(h.calls.filter(c => c.method === "resources/subscribe")).toHaveLength(0);
  expect(h.sent).toEqual([]);
});

test("overlapping activation callbacks can bootstrap only the final conversation", async () => {
  const h = harness();
  const first = h.emit("session_start");
  const fork = { ...h.ctx, sessionManager: { getSessionId: () => "final-conversation" } };
  const second = h.emit("session_switch", {}, fork);
  await Promise.all([first, second]);
  const prepared = await h.emit("before_agent_start", {}, fork);
  expect(prepared.message.details.sessionId).toBe("final-conversation");
  expect(h.calls.filter(c => c.method === "tools/call")).toHaveLength(1);
  await h.emit("session_shutdown");
});
