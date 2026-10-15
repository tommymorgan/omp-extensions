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
  let notificationContext;
  let start = async () => ({ content: [{ type: "text", text: JSON.stringify({ handle: "private-subscription", instructionsVersion: version, instructions }) }] });
  const native = {
    capabilities: { resources: { subscribe: true } }, config: { type: "http" },
    transport: {
      async startSSEListener() { calls.push({ method: "listener" }); },
      async request(method, params) {
        calls.push({ method, params });
        if (method === "tools/call") return start(params);
        if (method === "resources/subscribe") queueMicrotask(() => handlers.get("mcp_notification")?.({
          server: "kizn", method: "notifications/resources/updated", params: { uri: params.uri },
        }, notificationContext));
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
  notificationContext = ctx;
  install({
    on(name, handler) { handlers.set(name, handler); },
    async exec(command, args) {
      calls.push({ method: command, args });
      const remote = args[1] === "/repo-b" ? "two" : "one";
      return { code: 0, stdout: `origin\tgit@example.test:${remote}/repo.git (fetch)\norigin\tgit@example.test:${remote}/repo.git (push)\n`, stderr: "" };
    },
    sendMessage(message, options) { sent.push({ message, options }); },
  });
  return {
    calls, sent, ctx, statuses,
    emit: (event, value = {}, context = ctx) => {
      notificationContext = context;
      return handlers.get(event)?.(value, context);
    },
    version(next) { version = next; },
    start(next) { start = next; },
  };
}

test("private bootstrap supplies model context independently of model tool calls", async () => {
  const h = harness();
  await h.emit("session_start");
  const prepared = await h.emit("before_agent_start");
  expect(prepared.message.content).toContain('"instructionsVersion":"v1"');
  expect(prepared.message.content).not.toContain("private-subscription");
  h.version("v2");
  await h.emit("mcp_notification", { server: "kizn", method: "notifications/resources/updated", params: { uri: "kizn://instructions/private-subscription" } });
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.content).toContain('"instructionsVersion":"v2"');
  expect(h.sent[0].message.content).not.toContain("private-subscription");
  const context = await h.emit("context", { messages: [prepared.message, h.sent[0].message] });
  expect(context.messages).toEqual([h.sent[0].message]);
  await h.emit("session_shutdown");
  expect(h.statuses.size).toBe(0);
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

test("compaction retry restores the complete current snapshot without another agent-start event", async () => {
  const h = harness();
  try {
    await h.emit("session_start");
    const initial = await h.emit("before_agent_start");
    const tail = { role: "user", content: "Retained compaction tail" };
    const restored = await h.emit("context", { messages: [tail] });
    expect(restored.messages[0]).toEqual(tail);
    expect(restored.messages.at(-1)?.content).toEqual(initial.message.content);
  } finally { await h.emit("session_shutdown"); }
});

test("a replacement queued after the aside drain remains available at the next context boundary", async () => {
  const h = harness();
  try {
    await h.emit("session_start");
    const initial = await h.emit("before_agent_start");
    h.version("v2");
    await h.emit("mcp_notification", { server: "kizn", method: "notifications/resources/updated", params: { uri: "kizn://instructions/private-subscription" } });
    const outgoing = await h.emit("context", { messages: [initial.message] });
    expect(outgoing.messages.map(message => message.content)).toEqual([h.sent[0].message.content]);
  } finally { await h.emit("session_shutdown"); }
});

test("reconnecting replaces an expired private handle and catches up canonical guidance", async () => {
  const h = harness();
  h.ctx.hasUI = true;
  h.ctx.ui = { notify() {} };
  try {
    await h.emit("session_start");
    const native = currentManager.getConnection("kizn");
    const request = native.transport.request.bind(native.transport);
    native.transport.request = async (method, params) => {
      if (params?.uri === "kizn://instructions/private-subscription") throw new Error("Expired private session");
      return request(method, params);
    };
    h.version("v2");
    h.start(async () => ({ content: [{ type: "text", text: JSON.stringify({ handle: "renewed-private", instructionsVersion: "v2", instructions }) }] }));
    for (const status of h.statuses) status({ serverName: "kizn", type: "connected" });
    await new Promise(resolve => setImmediate(resolve));
    const prepared = await h.emit("before_agent_start");
    expect(prepared.message.details.version).toBe("v2");
    expect(h.sent.map(entry => entry.message.details.version)).toEqual(["v2"]);
  } finally { await h.emit("session_shutdown"); }
});

test("pending and failed refresh stays stale until a successful same-version read", async () => {
  const h = harness();
  h.ctx.hasUI = true;
  h.ctx.ui = { notify() {} };
  const pending = Promise.withResolvers();
  try {
    await h.emit("session_start");
    const prepared = await h.emit("before_agent_start");
    const native = currentManager.getConnection("kizn");
    const request = native.transport.request.bind(native.transport);
    native.transport.request = async (method, params) => {
      if (method === "resources/read") return pending.promise;
      return request(method, params);
    };
    const refresh = h.emit("mcp_notification", { server: "kizn", method: "notifications/resources/updated", params: { uri: "kizn://instructions/private-subscription" } });
    const inProgress = await h.emit("context", { messages: [prepared.message] });
    expect(JSON.parse(inProgress.messages.find(message => message.customType === "kizn-guidance-status")?.content ?? "{}").kiznInstructions).toBe("stale");
    pending.reject(new Error("Disposable read failure"));
    await refresh;
    const failed = await h.emit("context", { messages: [prepared.message] });
    const notice = failed.messages.find(message => message.customType === "kizn-guidance-status");
    expect(JSON.parse(notice?.content ?? "{}").kiznInstructions).toBe("stale");
    native.transport.request = request;
    await h.emit("mcp_notification", { server: "kizn", method: "notifications/resources/updated", params: { uri: "kizn://instructions/private-subscription" } });
    const recovered = await h.emit("context", { messages: failed.messages });
    expect(recovered.messages.filter(message => message.customType === "kizn-guidance-status")).toEqual([]);
    expect(recovered.messages.find(message => message.customType === "kizn-guidance")?.details.version).toBe("v1");
  } finally { pending.resolve(undefined); await h.emit("session_shutdown"); }
});

test("disabling the native server retains last policy but marks it stale in outgoing context", async () => {
  const h = harness();
  try {
    await h.emit("session_start");
    const prepared = await h.emit("before_agent_start");
    currentManager.getConnection = () => undefined;
    await h.emit("before_agent_start");
    const outgoing = await h.emit("context", { messages: [prepared.message] });
    expect(outgoing.messages.find(message => message.customType === "kizn-guidance")?.details.version).toBe("v1");
    const notice = outgoing.messages.find(message => message.customType === "kizn-guidance-status");
    expect(JSON.parse(notice?.content ?? "{}").kiznInstructions).toBe("stale");
  } finally { await h.emit("session_shutdown"); }
});

for (const boundary of ["agent start", "provider retry"]) {
  test(`moving the same conversation rebinds repository scope at ${boundary}`, async () => {
    const h = harness();
    const native = currentManager.getConnection("kizn");
    const request = native.transport.request.bind(native.transport);
    h.start(async params => {
      const moved = params.arguments.remoteUrls.includes("git@example.test:two/repo.git");
      return { content: [{ type: "text", text: JSON.stringify({
        handle: moved ? "scope-two" : "scope-one", instructionsVersion: moved ? "v2" : "v1", instructions,
      }) }] };
    });
    native.transport.request = async (method, params) => {
      if (method === "resources/read") return { contents: [{
        uri: params.uri, mimeType: "application/json", text: JSON.stringify({
          instructionsVersion: params.uri.endsWith("/scope-two") ? "v2" : "v1", instructions,
        }),
      }] };
      return request(method, params);
    };
    try {
      await h.emit("session_start");
      const initial = await h.emit("before_agent_start");
      h.ctx.cwd = "/repo-b";
      if (boundary === "agent start") {
        const moved = await h.emit("before_agent_start");
        expect(moved.message.details.version).toBe("v2");
      }
      const outgoing = await h.emit("context", { messages: [initial.message] });
      expect(outgoing.messages.filter(message => message.customType === "kizn-guidance").map(message => message.details.version)).toEqual(["v2"]);
    } finally { await h.emit("session_shutdown"); }
  });
}
