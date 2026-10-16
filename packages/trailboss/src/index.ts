import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CONTEXT_PUBLISH_CHANNEL, ContextPublication, GeneratedContext } from "./protocol.ts";

export { CONTEXT_PUBLISH_CHANNEL, ContextPublication } from "./protocol.ts";

/** Trailboss OMP Integration keeps routine publications off the agent's turn queue. */
export default function trailboss(pi: ExtensionAPI): void {
  const sessions = new Map<string, Map<string, ContextPublication["message"]>>();
  let stopped = false;

  const detach = pi.events.on(CONTEXT_PUBLISH_CHANNEL, data => {
    if (stopped) return;
    const publication = ContextPublication.safeParse(data);
    if (!publication.success) return;
    const { source, sessionId, message, accept } = publication.data;
    let sources = sessions.get(sessionId);
    if (!sources) {
      sources = new Map();
      sessions.set(sessionId, sources);
    }
    // Within a session each customType is an exclusive provider namespace.
    for (const [owner, cached] of sources) {
      if (owner !== source && cached.customType === message.customType) return;
    }
    // Stamp the timestamp at cache time: the injected copy must be
    // byte-identical on every request, or the pinned position itself would
    // re-stamp per request and invalidate the cached prefix.
    sources.set(source, { ...message, timestamp: Date.now() });
    // EventBus invokes listeners before returning from emit, so publishers can
    // distinguish a cached publication from a missing Trailboss receiver.
    accept();
  });

  function prune(_event: unknown, ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    // A producer's lifecycle callback may already have published for this session.
    // Preserve it regardless of extension registration order.
    for (const cachedId of sessions.keys()) {
      if (cachedId !== sessionId) sessions.delete(cachedId);
    }
  }

  pi.on("session_start", prune);
  pi.on("session_switch", prune);
  pi.on("session_branch", prune);
  pi.on("session_tree", prune);
  pi.on("session_shutdown", () => {
    stopped = true;
    sessions.clear();
    detach();
  });
  pi.on("context", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sources = stopped ? undefined : sessions.get(sessionId);
    const ownedTypes = new Set(Array.from(sources?.values() ?? [], message => message.customType));
    const messages = event.messages.filter(message =>
      !GeneratedContext.safeParse(message).success
      && !(message.role === "custom" && ownedTypes.has(message.customType)));
    // Pin cached publications at a stable request position: the first
    // messages, ahead of all conversation content. A tail append always sits
    // after the turn's new content, so the provider's cache diverges before
    // it on every request and its tokens are re-billed uncached; index 0
    // stays inside the cached prefix for the life of the publication.
    if (!stopped) {
      const pinned = [];
      for (const [source, message] of sources ?? []) {
        pinned.push({
          ...message,
          role: "custom",
          details: { ...message.details, trailbossContext: { source, sessionId } },
        });
      }
      messages.unshift(...pinned);
    }
    return { messages };
  });
}
