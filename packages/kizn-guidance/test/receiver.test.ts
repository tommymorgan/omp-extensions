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
    async request(method) {
      methods.push(method);
      return method === "resources/read" ? read() : {};
    },
  };
  const receiver = createReceiver({
    connection: () => connection,
    deliver(binding, snapshot) { owners.push(binding); sent.push(snapshot); },
    report(message) { failures.push(message); },
  });
  return { receiver, methods, sent, failures, owners, setRead(next: typeof read) { read = next; } };
}

describe("authenticated canonical resource receiver", () => {
  test("starts native listener before subscribing and catches up without a tool call", async () => {
    const h = harness();
    h.setRead(async () => resource("v2"));
    await h.receiver.bind(first);
    expect(h.methods).toEqual(["listener", "resources/subscribe", "resources/read"]);
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
  test("a switched conversation discards the old in-flight fetch and unsubscribes", async () => {
    const h = harness();
    await h.receiver.bind(first);
    const pending = Promise.withResolvers<unknown>();
    h.setRead(() => pending.promise);
    const refresh = h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    const switched = h.receiver.bind(undefined);
    pending.resolve(resource("secret-old-version"));
    await Promise.all([refresh, switched]);
    expect(h.sent).toEqual([]);
    expect(h.methods.at(-1)).toBe("resources/unsubscribe");
  });
  test("reconnecting resubscribes and catches up changes missed while disconnected", async () => {
    const h = harness();
    await h.receiver.bind(first);
    h.receiver.disconnect();
    h.setRead(async () => resource("v4"));
    await h.receiver.reconnect();
    expect(h.methods.filter(m => m === "resources/subscribe")).toHaveLength(2);
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
  test("revoked reads do not claim success and stop cleans up owned subscription", async () => {
    const h = harness();
    await h.receiver.bind(first);
    h.setRead(async () => { throw new Error("revoked"); });
    await h.receiver.notify("kizn", "notifications/resources/updated", { uri });
    expect(h.failures).toHaveLength(1);
    expect(h.sent).toEqual([]);
    await h.receiver.stop();
    expect(h.methods.at(-1)).toBe("resources/unsubscribe");
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
test("delivered snapshots preserve canonical owner data and distinguish policy from references", () => {
  const snapshot = { instructionsVersion: "v2", instructions };
  const message = instructionMessage(first, snapshot);
  expect(message.content).toContain(JSON.stringify(snapshot));
  expect(message.content).toContain("Concepts are reference/options");
  expect(message.content).toContain("Never retry a refused write automatically");
  expect(message.details.sessionId).toBe(first.sessionId);
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
