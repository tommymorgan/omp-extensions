import { z } from "zod";
import { type Binding, type Snapshot, readSnapshot } from "./protocol.ts";

export type Connection = {
  request: (method: string, params: { uri: string }, signal?: AbortSignal) => Promise<unknown>;
  startListener: () => Promise<void>;
};
export type ReceiverHost = {
  connection: () => Connection | undefined;
  deliver: (binding: Binding, snapshot: Snapshot) => void;
  confirm: (binding: Binding) => void;
  report: (message: string) => void;
};

function createConfirmation() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

/** One generation owns one exact session/handle/transport; transport and credentials remain host-owned. */
export function createReceiver(host: ReceiverHost) {
  let binding: Binding | undefined;
  let active: {
    binding: Binding;
    connection: Connection;
    abort: AbortController;
    uri: string;
    dirty: boolean;
    reading: boolean;
    ready: boolean;
    revision: number;
    version: string;
    confirmation: ReturnType<typeof createConfirmation>;
  } | undefined;
  let operations = Promise.resolve();
  const report = () => host.report("Kizn instruction subscription failed. Guidance is not current; reconnect Kizn or refresh instructions before writing.");

  async function refresh(state: NonNullable<typeof active>): Promise<void> {
    if (state.reading || !state.ready) return;
    state.reading = true;
    try {
      while (state.dirty && active === state && !state.abort.signal.aborted) {
        state.dirty = false;
        const revision = state.revision;
        const result = await state.connection.request("resources/read", { uri: state.uri }, state.abort.signal);
        if (active !== state || state.abort.signal.aborted) return;
        if (revision !== state.revision) continue;
        const snapshot = readSnapshot(result, state.uri);
        // A notification arriving during the read invalidates that read: publish only the final coalesced snapshot.
        if (state.dirty) continue;
        host.confirm(state.binding);
        if (snapshot.instructionsVersion === state.version) continue;
        host.deliver(state.binding, snapshot);
        state.version = snapshot.instructionsVersion;
        state.binding = { ...state.binding, version: snapshot.instructionsVersion };
        binding = state.binding;
      }
    } catch {
      if (active === state && !state.abort.signal.aborted) report();
    } finally {
      state.reading = false;
      if (state.dirty && active === state && !state.abort.signal.aborted) void refresh(state);
    }
  }

  function retire(): void {
    const old = active;
    active = undefined;
    if (!old) return;
    old.abort.abort();
    // Wait for a possibly installed subscribe before removing it. Never close the shared transport.
    operations = operations.then(async () => {
      try { await old.connection.request("resources/unsubscribe", { uri: old.uri }); }
      catch { report(); }
    });
  }

  function connect(): Promise<void> {
    const connection = host.connection();
    if (!binding || !connection) return operations;
    if (active?.connection === connection && active.binding.handle === binding.handle && active.binding.sessionId === binding.sessionId) return operations;
    retire();
    const state = {
      binding, connection, abort: new AbortController(),
      uri: `kizn://instructions/${encodeURIComponent(binding.handle)}`,
      dirty: true, reading: false, ready: false, revision: 0, version: binding.version,
      confirmation: createConfirmation(),
    };
    active = state;
    operations = operations.then(async () => {
      if (active !== state) return;
      try {
        // Public native listener is idempotent; this also recovers a pre-deployment GET 405.
        await connection.startListener();
        if (active !== state) return;
        await connection.request("resources/subscribe", { uri: state.uri }, state.abort.signal);
        if (active !== state) return;
        // Native listener startup is best-effort. Kizn's initial invalidation proves end-to-end delivery.
        const confirmed = createConfirmation();
        const timer = setTimeout(() => confirmed.reject(new Error("Kizn notification delivery was not established")), 10_000);
        const onAbort = () => confirmed.reject(state.abort.signal.reason);
        state.abort.signal.addEventListener("abort", onAbort, { once: true });
        void state.confirmation.promise.then(confirmed.resolve);
        try { await confirmed.promise; }
        finally {
          clearTimeout(timer);
          state.abort.signal.removeEventListener("abort", onAbort);
        }
        if (active !== state) return;
        state.ready = true;
        await refresh(state);
      } catch {
        if (active === state && !state.abort.signal.aborted) report();
      }
    });
    return operations;
  }

  return {
    bind(next: Binding | undefined): Promise<void> {
      if (binding?.sessionId === next?.sessionId && binding?.handle === next?.handle && next) {
        binding = next;
        if (active) {
          active.binding = next;
          active.version = next.version;
          active.revision += 1;
          active.dirty = true;
          void refresh(active);
        }
      } else {
        retire();
        binding = next;
      }
      return connect();
    },
    reconnect(): Promise<void> { retire(); return connect(); },
    disconnect(): void { retire(); },
    notify(server: string, method: string, params: unknown): Promise<void> {
      if (server !== "kizn" || method !== "notifications/resources/updated" || !active) return Promise.resolve();
      const update = z.object({ uri: z.string() }).safeParse(params);
      if (!update.success || update.data.uri !== active.uri) return Promise.resolve();
      active.confirmation.resolve();
      active.dirty = true;
      return refresh(active);
    },
    async stop(): Promise<void> { binding = undefined; retire(); await operations; },
  };
}
