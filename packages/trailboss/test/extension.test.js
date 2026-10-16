import { expect, mock, test } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import install, { CONTEXT_PUBLISH_CHANNEL } from "../src/index.ts";

function harness() {
  const handlers = new Map();
  const events = new EventBus();
  const sendMessage = mock(() => { throw new Error("Routine context must not send messages"); });
  const sendUserMessage = mock(() => { throw new Error("Routine context must not steer"); });
  const setStatus = mock(() => { throw new Error("Routine context must not alter status"); });
  let sessionId = "session-one";
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    hasUI: true, ui: { setStatus },
  };
  const pi = {
    events, sendMessage, sendUserMessage,
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
  };
  return {
    pi, events, ctx, sendMessage, sendUserMessage, setStatus,
    session(id) { sessionId = id; },
    async emit(name, event = {}) {
      let result;
      for (const callback of handlers.get(name) ?? []) {
        result = await callback(event, ctx);
        if (name === "context" && result) event = result;
      }
      return result;
    },
    async context(messages = []) { return (await this.emit("context", { messages })).messages; },
  };
}

function publication(overrides = {}) {
  return {
    source: "provider", sessionId: "session-one",
    message: { customType: "provider-context", content: "initial", display: false },
    ...overrides,
  };
}

function publish(h, value = publication()) {
  let accepted = false;
  h.events.emit(CONTEXT_PUBLISH_CHANNEL, { ...value, accept() { accepted = true; } });
  return accepted;
}

test("publication accepts synchronously and only the latest snapshot per source enters context", async () => {
  const h = harness();
  install(h.pi);
  await h.emit("session_start");
  expect(publish(h)).toBe(true);
  const initial = await h.context();
  const details = { scope: "provider-scope", version: "v2", nested: { preserved: true } };
  expect(publish(h, publication({ message: {
    customType: "provider-context", content: "latest", display: false, details,
  } }))).toBe(true);
  const latest = await h.context(initial);
  expect(latest).toHaveLength(1);
  expect(latest[0]).toMatchObject({
    role: "custom", customType: "provider-context", content: "latest", display: false,
    details: { ...details, trailbossContext: { source: "provider", sessionId: "session-one" } },
  });
  expect(latest[0].timestamp).toEqual(expect.any(Number));
  expect((await h.context(latest)).map(message => message.content)).toEqual(["latest"]);
  expect((await h.context())[0].content).toBe("latest");
});

test("pinned injection is byte-stable across requests within a publication", async () => {
  const h = harness();
  install(h.pi);
  publish(h);
  const first = await h.context([{ role: "user", content: "one" }]);
  await new Promise(resolve => setTimeout(resolve, 2));
  const second = await h.context([{ role: "user", content: "one" }, { role: "assistant", content: "two" }]);
  expect(second[0]).toEqual(first[0]);
  expect(second[0].timestamp).toBe(first[0].timestamp);
});

test("replacement preserves foreground messages and unrelated custom messages without mutating input", async () => {
  const h = harness();
  install(h.pi);
  publish(h);
  const user = { role: "user", content: "Do the real work", details: {
    trailbossContext: { source: "provider", sessionId: "session-one" },
  } };
  const assistant = { role: "assistant", content: "Working" };
  const tool = { role: "toolResult", content: "Foreground result" };
  const unrelated = { role: "custom", customType: "another-provider", content: "Keep me" };
  const input = [user, assistant, tool, unrelated];
  const result = await h.context(input);
  expect(result.slice(1)).toEqual(input);
  expect(result[1]).toBe(user);
  expect(result[0]).toMatchObject({ role: "custom", customType: "provider-context" });
  expect(input).toHaveLength(4);
  expect(result).toHaveLength(5);
});

test("each source supplies its own latest snapshot and conflicting customType ownership is rejected", async () => {
  const h = harness();
  install(h.pi);
  expect(publish(h)).toBe(true);
  expect(publish(h, publication({ source: "other" }))).toBe(false);
  expect(publish(h, publication({ source: "other", message: {
    customType: "other-context", content: "other latest", display: false,
  } }))).toBe(true);
  expect((await h.context()).map(message => message.content)).toEqual(["initial", "other latest"]);
});

for (const producerFirst of [true, false]) {
  for (const lifecycle of ["session_start", "session_switch", "session_branch", "session_tree"]) {
    test(`${lifecycle} preserves a new session publication with producer registered ${producerFirst ? "before" : "after"} Trailboss`, async () => {
      const h = harness();
      const registerProducer = () => h.pi.on(lifecycle, () => {
        expect(publish(h, publication({ sessionId: h.ctx.sessionManager.getSessionId() }))).toBe(true);
      });
      if (producerFirst) registerProducer();
      install(h.pi);
      if (!producerFirst) registerProducer();
      expect(publish(h)).toBe(true);
      const inherited = await h.context();
      h.session("session-two");
      await h.emit(lifecycle);
      // Late old-session publications cannot leak into the active conversation.
      expect(publish(h, publication({ message: {
        customType: "provider-context", content: "late old session", display: false,
      } }))).toBe(true);
      const result = await h.context(inherited);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("initial");
      expect(result[0].details.trailbossContext.sessionId).toBe("session-two");
      h.session("session-three");
      await h.emit("session_switch");
      h.session("session-one");
      expect(await h.context(result)).toEqual([]);
    });
  }
}

test("unmarked provider fallback is deduplicated while prior-session marked snapshots are removed", async () => {
  const h = harness();
  install(h.pi);
  publish(h);
  const fallback = { role: "custom", customType: "provider-context", content: "fallback", display: false };
  const inherited = { role: "custom", customType: "old-provider", content: "old", details: {
    trailbossContext: { source: "old-provider", sessionId: "session-old" },
  } };
  const result = await h.context([fallback, inherited]);
  expect(result).toHaveLength(1);
  expect(result[0].content).toBe("initial");
});

test("invalid publications do not acknowledge or replace the last accepted snapshot", async () => {
  const h = harness();
  install(h.pi);
  publish(h);
  for (const invalid of [
    null,
    publication({ source: "" }),
    publication({ sessionId: "" }),
    publication({ message: { customType: "provider-context", content: "bad", display: true } }),
    publication({ message: { customType: "", content: "bad", display: false } }),
    publication({ message: { customType: "provider-context", content: 123, display: false } }),
    publication({ message: { customType: "provider-context", content: "bad", display: false, details: [] } }),
  ]) {
    const accept = mock();
    h.events.emit(CONTEXT_PUBLISH_CHANNEL, invalid === null ? null : { ...invalid, accept });
    expect(accept).not.toHaveBeenCalled();
  }
  h.events.emit(CONTEXT_PUBLISH_CHANNEL, { ...publication(), accept: "not callable" });
  expect((await h.context())[0].content).toBe("initial");
});

test("shutdown clears snapshots and detaches only Trailboss's listener", async () => {
  const h = harness();
  const otherListener = mock();
  const unrelatedChannel = mock();
  h.events.on(CONTEXT_PUBLISH_CHANNEL, otherListener);
  h.events.on("unrelated", unrelatedChannel);
  install(h.pi);
  expect(publish(h)).toBe(true);
  const previous = await h.context();
  await h.emit("session_shutdown");
  expect(publish(h)).toBe(false);
  expect(otherListener).toHaveBeenCalledTimes(2);
  h.events.emit("unrelated", {});
  expect(unrelatedChannel).toHaveBeenCalledTimes(1);
  expect(await h.context(previous)).toEqual([]);
});

test("routine publications never send, steer, or change status during idle or active work", async () => {
  const h = harness();
  install(h.pi);
  await h.emit("session_start");
  for (const state of ["idle", "active", "interrupted"]) {
    expect(publish(h, publication({ message: {
      customType: "provider-context", content: state, display: false,
    } }))).toBe(true);
    const user = { role: "user", content: "Continue foreground work" };
    expect((await h.context([user])).map(message => message.content)).toEqual([state, user.content]);
  }
  await h.emit("session_shutdown");
  expect(h.sendMessage).not.toHaveBeenCalled();
  expect(h.sendUserMessage).not.toHaveBeenCalled();
  expect(h.setStatus).not.toHaveBeenCalled();
});
