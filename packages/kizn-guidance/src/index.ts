import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { z } from "zod";
import { type Binding, type Snapshot, instructionMessage, readStartedSession } from "./protocol.ts";
import { type Connection, createReceiver } from "./receiver.ts";

const GuidanceMessage = z.object({
  customType: z.literal("kizn-guidance"),
  details: z.object({ sessionId: z.string(), scope: z.string(), version: z.string() }),
});

export default function kiznGuidance(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let scopeCwd: string | undefined;
  let binding: Binding | undefined;
  let latest: Snapshot | undefined;
  let deliveredVersion: string | undefined;
  let stale = true;
  const failureNotice = "Kizn instruction subscription failed. Guidance is not current; reconnect Kizn or refresh instructions before writing.";
  let scope = crypto.randomUUID();
  let controller = new AbortController();
  let starting: Promise<void> | undefined;
  let manager: MCPManager | undefined;
  let detach: (() => void) | undefined;
  const adapters = new WeakMap<object, Connection>();

  function report(): void {
    stale = true;
    if (context?.hasUI) context.ui.notify(failureNotice, "warning");
    else console.error(failureNotice);
  }

  function owns(owner: Binding): boolean {
    return scopeCwd === context?.cwd && owner.sessionId === context?.sessionManager.getSessionId() && owner.handle === binding?.handle;
  }

  function deliver(owner: Binding, snapshot: Snapshot): void {
    if (!owns(owner)) return;
    latest = snapshot;
    // Re-publishing an unchanged instructionsVersion only churns the receiver
    // cache and the request tail; skip until the version actually changes.
    // activate()/session_shutdown reset the gate so a fresh activation still
    // delivers once. A refused (unaccepted) delivery never sets the gate, so
    // retry semantics when the Trailboss receiver is missing are unchanged.
    if (deliveredVersion === snapshot.instructionsVersion) return;
    let accepted = false;
    pi.events.emit("trailboss:context:publish", {
      source: "kizn-guidance",
      sessionId: owner.sessionId,
      message: {
        ...instructionMessage(owner, snapshot),
        details: { sessionId: owner.sessionId, version: snapshot.instructionsVersion, scope },
      },
      accept() { accepted = true; },
    });
    if (!accepted) throw new Error("Kizn guidance requires the Trailboss OMP Integration extension");
    deliveredVersion = snapshot.instructionsVersion;
  }

  const receiver = createReceiver({
    connection() {
      const native = manager?.getConnection("kizn");
      if (!native) return;
      let adapter = adapters.get(native);
      if (!adapter) {
        adapter = {
          async request(method, params, signal) {
            if (!native.capabilities.resources?.subscribe) throw new Error("Kizn does not advertise resource subscriptions");
            return native.transport.request(method, params, { signal });
          },
          async startListener() {
            const transport = native.transport;
            if ("startSSEListener" in transport && typeof transport.startSSEListener === "function") {
              await transport.startSSEListener();
            } else if (native.config.type === "http") {
              throw new Error("OMP HTTP transport lacks native SSE listener startup");
            }
          },
        };
        adapters.set(native, adapter);
      }
      return adapter;
    },
    deliver,
    confirm(owner) {
      if (owns(owner)) stale = false;
    },
    invalidate(owner) {
      if (owns(owner)) stale = true;
    },
    report,
  });

  function bootstrap(renew = false): Promise<void> {
    if (starting) return starting;
    const ctx = context;
    const native = manager?.getConnection("kizn");
    if (!ctx || !native || (binding && !renew)) return Promise.resolve();
    const generation = scope;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const signal = controller.signal;
    const operation = (async () => {
      try {
        const remote = await pi.exec("git", ["-C", cwd, "remote", "-v"], { signal, timeout: 10000 });
        // Outside a repository there is no repository scope. Other Git errors must not silently broaden access.
        if (remote.code !== 0 && !remote.stderr.includes("not a git repository")) throw new Error("Cannot determine Kizn repository scope");
        const urls = remote.code === 0 ? [...new Set(remote.stdout.split("\n").flatMap(line => {
          const match = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
          return match?.[1] ? [match[1]] : [];
        }))] : [];
        if (generation !== scope || signal.aborted) return;
        const result = await native.transport.request("tools/call", {
          name: "start_session", arguments: { remoteUrls: urls },
        }, { signal });
        if (generation !== scope || signal.aborted || manager?.getConnection("kizn") !== native
          || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId) return;
        const started = readStartedSession(result);
        binding = { sessionId, handle: started.handle, version: started.instructionsVersion };
        latest = { instructionsVersion: started.instructionsVersion, instructions: started.instructions };
        await receiver.bind(binding);
        if (generation === scope && binding?.handle === started.handle
          && latest?.instructionsVersion === started.instructionsVersion) deliver(binding, latest);
      } catch {
        if (generation === scope && !signal.aborted) report();
      }
    })();
    starting = operation;
    void operation.finally(() => { if (starting === operation) starting = undefined; });
    return operation;
  }

  function attach(ctx: ExtensionContext): void {
    context = ctx;
    const current = MCPManager.instance();
    if (manager === current) return;
    detach?.();
    manager = current;
    detach = manager?.addConnectionStatusListener(event => {
      if (!("serverName" in event) || event.serverName !== "kizn") return;
      if (event.type === "connected") {
        controller.abort();
        controller = new AbortController();
        scope = crypto.randomUUID();
        stale = true;
        starting = undefined;
        receiver.disconnect();
        void bootstrap(true);
      } else if (event.type === "reconnecting" || event.type === "failed") {
        stale = true;
        receiver.disconnect();
      }
    });
  }

  async function activate(ctx: ExtensionContext): Promise<void> {
    controller.abort();
    controller = new AbortController();
    scope = crypto.randomUUID();
    scopeCwd = ctx.cwd;
    const generation = scope;
    binding = undefined;
    latest = undefined;
    deliveredVersion = undefined;
    stale = true;
    starting = undefined;
    await receiver.bind(undefined);
    if (generation !== scope) return;
    attach(ctx);
    if (!manager) throw new Error("Kizn guidance requires the host's shared MCPManager instance; this OMP module does not expose it to the extension.");
    await bootstrap();
  }

  pi.on("session_start", (_event, ctx) => activate(ctx));
  pi.on("session_switch", (_event, ctx) => activate(ctx));
  pi.on("session_branch", (_event, ctx) => activate(ctx));
  pi.on("session_tree", (_event, ctx) => activate(ctx));
  pi.on("session_shutdown", async () => {
    controller.abort();
    scope = crypto.randomUUID();
    context = undefined;
    scopeCwd = undefined;
    binding = undefined;
    latest = undefined;
    deliveredVersion = undefined;
    starting = undefined;
    detach?.();
    detach = undefined;
    manager = undefined;
    await receiver.stop();
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (scopeCwd !== ctx.cwd || context?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) await activate(ctx);
    else { attach(ctx); await bootstrap(); }
    if (!binding || !latest) return;
    deliver(binding, latest);
  });
  pi.on("mcp_notification", (event, ctx) => {
    if (binding?.sessionId !== ctx.sessionManager.getSessionId()) return;
    return receiver.notify(event.server, event.method, event.params);
  });
  pi.on("context", async (event, ctx) => {
    if (context && scopeCwd !== ctx.cwd) await activate(ctx);
    if (!manager?.getConnection("kizn")) stale = true;
    const last = event.messages.findLastIndex(message => {
      const guidance = GuidanceMessage.safeParse(message);
      return guidance.success && guidance.data.details.sessionId === context?.sessionManager.getSessionId()
        // Scope-independent on purpose: an entry persisted by an earlier
        // activation of this same session still satisfies the current version,
        // so a restart reuses it in place instead of appending a duplicate
        // ~130KB snapshot and moving the request divergence point.
        && guidance.data.details.version === latest?.instructionsVersion;
    });
    const messages = event.messages.filter((message, index) =>
      !(message.role === "custom" && message.customType === "kizn-guidance-status")
      && (!GuidanceMessage.safeParse(message).success || index === last));
    // Pin the guidance to a stable request position: the first message.
    // A tail append always sits after the turn's new content, so the
    // provider cache diverges before it on every request and its ~32K
    // tokens are re-billed uncached; index 0 stays inside the cached
    // prefix for the life of the version. Rebinding here can publish
    // after the shared context hook has already run.
    let pinned;
    if (last === -1 && binding && latest) {
      const message = instructionMessage(binding, latest);
      pinned = { ...message, role: "custom", timestamp: Date.now(), details: { ...message.details, scope } };
    } else {
      const keptIndex = messages.findIndex(message => GuidanceMessage.safeParse(message).success);
      if (keptIndex >= 0) pinned = messages.splice(keptIndex, 1)[0];
    }
    if (pinned) messages.unshift(pinned);
    if (stale && context) messages.push({
      role: "custom", customType: "kizn-guidance-status", display: false, timestamp: Date.now(),
      content: JSON.stringify({ kiznInstructions: latest ? "stale" : "unavailable", message: "Kizn instructions are not current; refresh or reconnect before writing." }),
      details: { scope },
    });
    return { messages };
  });
}
