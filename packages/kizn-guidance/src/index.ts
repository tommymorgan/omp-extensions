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

  function deliver(owner: Binding, snapshot: Snapshot): void {
    if (scopeCwd !== context?.cwd || owner.sessionId !== context?.sessionManager.getSessionId() || owner.handle !== binding?.handle) return;
    latest = snapshot;
    const message = instructionMessage(owner, snapshot);
    pi.sendMessage({ ...message, details: { ...message.details, scope } }, { deliverAs: "aside" });
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
      if (scopeCwd === context?.cwd && owner.sessionId === context?.sessionManager.getSessionId() && owner.handle === binding?.handle) stale = false;
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
        const previousVersion = latest?.instructionsVersion;
        binding = { sessionId, handle: started.handle, version: started.instructionsVersion };
        latest = { instructionsVersion: started.instructionsVersion, instructions: started.instructions };
        await receiver.bind(binding);
        if (generation === scope && binding?.handle === started.handle
          && previousVersion && previousVersion !== started.instructionsVersion
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
    const message = instructionMessage(binding, latest);
    return { message: { ...message, details: { ...message.details, scope } } };
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
        && guidance.data.details.scope === scope && guidance.data.details.version === latest?.instructionsVersion;
    });
    const messages = event.messages.filter((message, index) =>
      !(message.role === "custom" && message.customType === "kizn-guidance-status")
      && (!GuidanceMessage.safeParse(message).success || index === last));
    // Compaction and an aside queued after the drain can both leave the outgoing context without its snapshot.
    if (last === -1 && binding && latest) {
      const message = instructionMessage(binding, latest);
      messages.push({ ...message, role: "custom", timestamp: Date.now(), details: { ...message.details, scope } });
    }
    if (stale && context) messages.push({
      role: "custom", customType: "kizn-guidance-status", display: false, timestamp: Date.now(),
      content: JSON.stringify({ kiznInstructions: latest ? "stale" : "unavailable", message: failureNotice }),
      details: { scope },
    });
    return { messages };
  });
}
