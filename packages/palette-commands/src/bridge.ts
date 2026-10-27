import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDispatchMap } from './dispatch-map.ts';
import { dispatchSlashCommand } from './dispatch.ts';
import { isProcessAlive, registryEntryFor, sessionFromSocketPath } from './registry.ts';
import { sessionRequest } from './session-socket.ts';

/**
 * palette-commands bridge (plan Task 1.1 envelope + Tasks 1.2/2.1 dispatch,
 * ADR 0005 Revision): the argv named by every action in the aggregated
 * `trailboss-plugin.toml`. Trailboss spawns it directly with
 * `HERDR_PLUGIN_ACTION_ID` (the sanitized command id) and
 * `HERDR_PLUGIN_CONTEXT_JSON` in the environment (`focused_pane_id` is the
 * palette-captured pane).
 *
 * Task 1.1 contract (unchanged): `bridgeMain` logs the invocation envelope
 * as one JSON line. Dispatch: resolve the action id through the plugin
 * dir's ONE-generation `dispatch.json` (id → original name + prefill,
 * published atomically before the manifest — delivery review finding 8;
 * unknown id fails closed), resolve the invoking session BOUND TO THE
 * SELECTED SOCKET (finding 2: trailboss routes within the connected
 * socket's session, so a disagreeing HERDR_SESSION refuses dispatch),
 * resolve the pane via that session's registry subdir, verify the process
 * is alive AND the same incarnation, and only then type
 * `/<command name>` + Enter into the pane through the trailboss session
 * socket (`pane.send_input`), executing through omp's real input path. No
 * dispatch metadata, unknown action id, session mismatch, no same-session
 * registry entry, dead or recycled PID, mismatched pane, unresolvable
 * session, or missing socket sends NOTHING and exits nonzero.
 */

export interface BridgeIO {
  writeLine(line: string): void;
}

export function bridgeMain(
  env: Record<string, string | undefined>,
  io: BridgeIO,
): number {
  const actionId = env.HERDR_PLUGIN_ACTION_ID ?? null;
  const rawContext = env.HERDR_PLUGIN_CONTEXT_JSON;
  let context: unknown = null;
  if (rawContext !== undefined) {
    try {
      context = JSON.parse(rawContext);
    } catch {
      // Controlled failure (review fix): the envelope must not throw — the
      // executable path combines this code with the dispatch error instead.
      return 3;
    }
  }
  io.writeLine(JSON.stringify({ action_id: actionId, context }));
  return 0;
}

/** Production executable wiring: envelope on stdout, errors AND resolution logs on stderr. */
export async function runBridgeExecutable(
  env: Record<string, string | undefined>,
  writeStdout: (line: string) => void,
  writeStderr: (message: string) => void,
  options: BridgeDispatchOptions = {},
): Promise<number> {
  const envelopeCode = bridgeMain(env, { writeLine: writeStdout });
  const dispatchCode = await bridgeDispatch(env, { err: writeStderr, info: writeStderr }, options);
  return dispatchCode !== 0 ? dispatchCode : envelopeCode;
}

export interface BridgeDispatchIO {
  err(message: string): void;
  /** Optional structured log for successful resolutions (stderr-free). */
  info?(message: string): void;
}

/** Test/override seam for bridgeDispatch: state dir and socket send, injectable. */
export interface BridgeDispatchOptions {
  stateDir?: string;
  sendInput?(paneId: string, text: string, keys: string[]): Promise<void>;
  readPaneRecent?(paneId: string): Promise<string>;
  wait?(ms: number): Promise<void>;
}

/** Extracts the palette-selected pane from the invocation context JSON; malformed JSON resolves to null (fail closed downstream). */
function focusedPaneId(rawContext: string): string | null {
  let context: unknown;
  try {
    context = JSON.parse(rawContext);
  } catch {
    return null;
  }
  if (context === null || typeof context !== 'object' || !('focused_pane_id' in context)) return null;
  const paneId = (context as Record<string, unknown>).focused_pane_id;
  if (typeof paneId !== 'string' || paneId.length === 0) return null;
  return paneId;
}

interface SessionIdentity {
  session: string | null;
  /** Refusal reason when the explicit env identity contradicts the selected socket's session. */
  mismatch?: string;
}

/**
 * The invoking session, bound to the SELECTED socket (delivery review
 * finding 2 + round 2 R6): trailboss routes `pane.send_input` within the
 * connected socket's session, so registry verification must target THAT
 * session — never HERDR_SESSION when the two disagree, and never a
 * fallback when the socket's session identity cannot be established at
 * all (a symlinked or overridden socket would re-open the cross-session
 * gap). A socket under the sessions layout is authoritative; an explicit
 * HERDR_SESSION matching it is accepted; a disagreement or an
 * unrecognizable socket refuses dispatch. With NO socket at all, the
 * explicit env identity is used — nothing can be sent anyway, and
 * sendInput fails closed.
 */
function invokingSession(env: Record<string, string | undefined>, socketPath: string | null): SessionIdentity {
  const explicit = env.HERDR_SESSION !== undefined && env.HERDR_SESSION.length > 0 ? env.HERDR_SESSION : null;
  const fromSocket = socketPath === null ? null : sessionFromSocketPath(socketPath);
  if (socketPath !== null && fromSocket === null) {
    return {
      session: null,
      mismatch: `palette-commands: cannot establish the selected socket's session identity (${socketPath}); refusing to dispatch`,
    };
  }
  if (fromSocket !== null) {
    if (explicit !== null && explicit !== fromSocket) {
      return {
        session: null,
        mismatch: `palette-commands: HERDR_SESSION "${explicit}" disagrees with the selected socket's session "${fromSocket}"; refusing to dispatch`,
      };
    }
    return { session: fromSocket };
  }
  return { session: explicit };
}

/** Runs the dispatch for a full plugin invocation env; 0 = dispatched (or nothing to dispatch). */
export async function bridgeDispatch(
  env: Record<string, string | undefined>,
  io: BridgeDispatchIO,
  options: BridgeDispatchOptions = {},
): Promise<number> {
  const actionId = env.HERDR_PLUGIN_ACTION_ID;
  const rawContext = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (actionId === undefined || rawContext === undefined) {
    // Envelope-only invocation (no action context): nothing to dispatch.
    return 0;
  }
  const socketPath = env.PALETTE_TRAILBOSS_SOCKET ?? env.HERDR_SOCKET_PATH ?? null;
  const pluginDir = env.PALETTE_COMMANDS_PLUGIN_DIR ?? env.HERDR_PLUGIN_ROOT ?? null;
  const stateDir = options.stateDir ?? join(homedir(), '.local', 'state', 'omp-extensions', 'palette-commands');
  const paneId = focusedPaneId(rawContext);
  const identity = invokingSession(env, socketPath);
  if (identity.mismatch !== undefined) {
    io.err(identity.mismatch);
    return 8;
  }
  const session = identity.session;
  if (rawContext !== undefined && paneId === null && rawContext.trim() !== '') {
    io.err('palette-commands: invocation context JSON names no usable focused_pane_id (malformed or absent); refusing to dispatch');
    return 3;
  }
  // ONE immutable dispatch-map generation (finding 8): id → original
  // name, published atomically BEFORE the manifest that names the ids.
  const dispatchMap = readDispatchMap(pluginDir);
  if (dispatchMap === null) {
    io.err(`palette-commands: dispatch.json is missing or unreadable in plugin dir ${pluginDir ?? '(none)'}; refusing to dispatch`);
    return 7;
  }
  const action = dispatchMap[actionId];
  if (action === undefined) {
    io.err(`palette-commands: action id ${actionId} has no dispatch metadata (stale palette manifest or dispatch map); refusing to dispatch — re-run aggregation`);
    return 7;
  }
  const outcome = await dispatchSlashCommand(
    action.name,
    { session, paneId },
    {
      entryFor: (session, paneId) => registryEntryFor(stateDir, session, paneId),
      isProcessAlive,
      sendInput: async (paneId, text, keys) => {
        if (options.sendInput !== undefined) {
          await options.sendInput(paneId, text, keys);
          return;
        }
        if (socketPath === null) {
          throw new Error('no trailboss session socket (set PALETTE_TRAILBOSS_SOCKET or run under trailboss)');
        }
        await sessionRequest(socketPath, 'pane.send_input', { pane_id: paneId, text, keys });
      },
      readPaneRecent: async (paneId) => {
        if (options.readPaneRecent !== undefined) {
          return options.readPaneRecent(paneId);
        }
        if (socketPath === null) {
          throw new Error('no trailboss session socket (set PALETTE_TRAILBOSS_SOCKET or run under trailboss)');
        }
        const response = await sessionRequest<{ read?: { text?: unknown } }>(socketPath, 'pane.read', {
          pane_id: paneId,
          source: 'recent',
          lines: 256,
        });
        const text = response.read?.text;
        return typeof text === 'string' ? text : '';
      },
      wait: options.wait,
    },
  );
  if (outcome.error !== undefined) io.err(outcome.error);
  else if (io.info !== undefined && paneId !== null && session !== null) {
    io.info(`palette-commands: action ${actionId} -> /${action.name} sent to pane ${paneId} (session ${session})`);
  }
  return outcome.code;
}

if (import.meta.main) {
  process.exit(
    await runBridgeExecutable(
      process.env,
      (line) => void process.stdout.write(`${line}\n`),
      (message) => void process.stderr.write(`${message}\n`),
    ),
  );
}
