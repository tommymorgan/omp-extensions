import { describe, expect, test } from "bun:test";
import { type Binding, type Snapshot, instructionMessage, readStartedSession } from "../src/protocol.ts";
import { type Connection, createReceiver } from "../src/receiver.ts";

const instructions = {
  bootstrap: "Owner-scoped policy", rules: [{ owner: { member: "one@example.test" }, body: "Policy marker" }],
  memories: [], referencedItems: [], catalog: {}, agentGuidance: {},
};
const first: Binding = { sessionId: "conversation-one", handle: "private-one", version: "v1" };
const uri = "kizn://instructions/private-one";
function resource(version: string, target = uri) {
  return { contents: [{ uri: target, mimeType: "application/json", text: JSON.stringify({ instructionsVersion: version, instructions }) }] };
}
function harness() {
  const sent: Snapshot[] = [];
  const owners: Binding[] = [];
  const failures: string[] = [];
  const methods: string[] = [];
  let read: () => Promise<unknown> = async () => resource("v1");
  const connection: Connection = {
    async startListener() { methods.push("listener"); },
    async request(method, params) {
      methods.push(method);
      if (method === "resources/subscribe") void receiver.notify("kizn", "notifications/resources/updated", params);
      return method === "resources/read" ? read() : {};
    },
  };
  const receiver = createReceiver({
    connection: () => connection,
    deliver(binding, snapshot) { owners.push(binding); sent.push(snapshot); },
    confirm() {},
    invalidate() {},
    report(message) { failures.push(message); },
  });
  return { receiver, methods, sent, failures, owners, setRead(next: typeof read) { read = next; } };
}

describe("authenticated canonical resource receiver", () => {
  test("catches up a canonical change missed between session bootstrap and subscription", async () => {
    const h = harness();
    h.setRead(async () => resource("v2"));
    await h.receiver.bind(first);
    expect(h.sent.map(s => s.instructionsVersion)).toEqual(["v2"]);
  });
  test("foreign server, method and handle cannot cause a read or disclosure", async () => {
    const h = harness();
    await h.receiver.bind(first);
    const count = h.methods.length;
    await h.receiver.notify("other", "notifications/resources/updated", { uri });
    await h.receiver.notify("kizn", "other", { uri });
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri: "kizn://instructions/foreign" });
    expect(h.methods.length).toBe(count);
    expect(h.sent).toEqual([]);
  });
  test("unchanged versions never wake the idle model twice", async () => {
    const h = harness();
    await h.receiver.bind(first);
    h.setRead(async () => resource("v2"));
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    expect(h.sent.map(s => s.instructionsVersion)).toEqual(["v2"]);
  });
  test("an invalidation during a fetch discards that fetch and coalesces to the latest snapshot", async () => {
    const h = harness();
    await h.receiver.bind(first);
    const pending = Promise.withResolvers<unknown>();
    h.setRead(() => pending.promise);
    const refresh = h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    h.setRead(async () => resource("v3"));
    pending.resolve(resource("v2"));
    await refresh;
    expect(h.sent.map(s => s.instructionsVersion)).toEqual(["v3"]);
  });
  test("an already-received invalidation survives a failed in-flight read", async () => {
    const h = harness();
    try {
      await h.receiver.bind(first);
      const pending = Promise.withResolvers<unknown>();
      h.setRead(() => pending.promise);
      const refresh = h.receiver.notify("kizn", "notifications/resources/updated", { uri });
      await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
      h.setRead(async () => resource("v3"));
      pending.reject(new Error("previous read failed"));
      await refresh;
      await new Promise(resolve => setImmediate(resolve));
      expect(h.sent.map(s => s.instructionsVersion)).toEqual(["v3"]);
    } finally { await h.receiver.stop(); }
  });
  test("a switched conversation discards the old in-flight fetch", async () => {
    const h = harness();
    await h.receiver.bind(first);
    const pending = Promise.withResolvers<unknown>();
    h.setRead(() => pending.promise);
    const refresh = h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    const switched = h.receiver.bind(undefined);
    pending.resolve(resource("secret-old-version"));
    await Promise.all([refresh, switched]);
    expect(h.sent).toEqual([]);
  });
  test("reconnecting catches up missed changes and shutdown ignores late events", async () => {
    const h = harness();
    await h.receiver.bind(first);
    h.receiver.disconnect();
    h.setRead(async () => resource("v4"));
    await h.receiver.reconnect();
    expect(h.sent.map(s => s.instructionsVersion)).toEqual(["v4"]);
    await h.receiver.stop();
    const count = h.methods.length;
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    expect(h.methods).toHaveLength(count);
  });
  test("malformed or foreign canonical responses fail visibly without model delivery", async () => {
    const h = harness();
    h.setRead(async () => resource("v2", "kizn://instructions/foreign"));
    await h.receiver.bind(first);
    expect(h.failures).toHaveLength(1);
    expect(h.sent).toEqual([]);
  });
  test("revoked reads fail visibly without replacing canonical instructions", async () => {
    const h = harness();
    await h.receiver.bind(first);
    h.setRead(async () => { throw new Error("revoked"); });
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    expect(h.failures).toHaveLength(1);
    expect(h.sent).toEqual([]);
    await h.receiver.stop();
  });
});

test("parses actual native tools/call start_session content and rejects refused sessions", () => {
  const start = { handle: "private-one", instructionsVersion: "v1", instructions };
  const result = { content: [{ type: "text", text: JSON.stringify(start) }] };
  expect(readStartedSession(result)).toEqual(start);
  expect(readStartedSession({ ...result, structuredContent: start })).toEqual(start);
  expect(() => readStartedSession({ ...result, isError: true })).toThrow();
  expect(() => readStartedSession({ content: [{ type: "text", text: "{}" }] })).toThrow();
});
test("model-facing snapshots do not disclose the private subscription handle", () => {
  const snapshot = { instructionsVersion: "v2", instructions };
  const message = instructionMessage(first, snapshot);
  expect(message.content).not.toContain(first.handle);
  expect(message.details).not.toHaveProperty("handle");
});

test("reconnect catch-up does not wake again for an already delivered version", async () => {
  const h = harness();
  await h.receiver.bind(first);
  h.setRead(async () => resource("v2"));
  await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
  await h.receiver.reconnect();
  expect(h.sent.map(s => s.instructionsVersion)).toEqual(["v2"]);
  await h.receiver.stop();
});

test("a late initial invalidation recovers after the readiness timeout", async () => {
  const sent: Snapshot[] = [];
  const failures: string[] = [];
  const receiver = createReceiver({
    connection: () => ({ startListener: async () => {}, request: async method => method === "resources/read" ? resource("v2") : {} }),
    confirm() {},
    invalidate() {},
    deliver(_owner, snapshot) { sent.push(snapshot); },
    report(message) { failures.push(message); },
  });
  try {
    await receiver.bind(first);
    expect(failures).toHaveLength(1);
    await receiver.notify("kizn", "notifications/resources/updated", { uri });
    expect(sent.map(snapshot => snapshot.instructionsVersion)).toEqual(["v2"]);
  } finally { await receiver.stop(); }
}, 20_000);
