import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { FLOCK_CONFLICT_EXIT, runCriticalSection, type CriticalOutcome } from './critical.ts';
import { sessionFromSocketPath, type CommandInventoryEntry } from './registry.ts';
import {
  mapBuiltinDef,
  mapFileCommand,
  mapSessionCommand,
  mergeByName,
} from './inventory.ts';

/**
 * palette-commands extension (plan Task 1.2 revised + Task 2.1, ADR 0005
 * Revision): publishes this omp instance into the SESSION-SCOPED
 * palette-commands registry (`<state>/registry/<session>/<pane_id>.json` =
 * {pane_id, pid, session_id, started_unix_ms, commands}) on session start
 * and removes it on session shutdown. `commands` is the instance's
 * inventory from `pi.getCommands()` — unfiltered; deny-list filtering
 * arrives in Task 4.1 — mapped defensively (name, description, an argument
 * hint when the host exposes one, subcommands), because the runtime shape
 * of command info has changed across omp releases. The aggregator (not this
 * extension) unions all live instances' inventories into the manifest.
 *
 * Trailboss pane ids are per-session (`w1:p1` exists in every session), so
 * the session scopes the registry: the bridge only ever resolves an entry
 * in the invoking session's subdir. The session identity comes from
 * `HERDR_SESSION` when set, else derived from the pane's
 * `HERDR_SOCKET_PATH`; without a valid session identity the extension FAILS
 * CLOSED — no entry is published, so the bridge will refuse to dispatch to
 * this pane (typing slash text into an unverified pane would execute shell
 * commands). Only the pane-owning INTERACTIVE session publishes (headless
 * task subagents with rebound parent extension factories would otherwise
 * overwrite the parent pane's entry and remove it on shutdown). A
 * SIGKILLed instance leaves its stale entry for the incarnation-aware
 * liveness checks (and the later staleness sweep, Task 4.1). Lifecycle
 * mutations run as flock-held critical sections (`critical.ts`):
 * kernel-owned mutual exclusion, and a contended section retries within a
 * budget so a publish or removal is never silently dropped.
 */

export default function paletteCommands(pi: ExtensionAPI): void {
  const stateDir = join(homedir(), '.local', 'state', 'omp-extensions', 'palette-commands');
  let ids: { sessionId: string; paneId: string | null } | null = null;

  pi.on('session_start', async (_event, ctx) => {
    // Delivery review finding 1: headless sessions (task subagents with
    // rebound parent extension factories, hasUI=false) share the parent
    // pane's env keys — publishing would overwrite the parent's registry
    // entry, and their shutdown would remove it. Only the pane-owning
    // interactive session publishes.
    if (ctx.hasUI !== true) return;
    const sessionId =
      process.env.HERDR_SESSION ??
      sessionFromSocketPath(process.env.HERDR_SOCKET_PATH ?? '');
    if (sessionId === null) {
      pi.logger.warn(
        'palette-commands: no trailboss session identity (HERDR_SESSION/HERDR_SOCKET_PATH); not publishing a registry entry — the bridge will refuse to dispatch to this instance',
      );
      return;
    }
    const paneId = process.env.HERDR_PANE_ID ?? null;
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (socketPath !== undefined && sessionFromSocketPath(socketPath) !== sessionId) {
      pi.logger.warn('palette-commands: socket/session identity mismatch; not publishing registry entry');
      return;
    }
    ids = { sessionId, paneId };
    const commands = await readInventory(pi);
    pi.logger.debug(
      `palette-commands: session_start publishing (session ${sessionId}, hasUI ${String(ctx.hasUI)})`,
    );
    // Delivery review round 2 (R1/R2): publish + re-aggregation run as ONE
    // flock-held critical section in a subprocess — kernel-owned mutual
    // exclusion with an unambiguous exit-code result (never a void
    // callback mistaken for contention).
    const published = await runLifecycle(
      pi,
      'publish',
      JSON.stringify({ session: sessionId, pane: paneId, pid: process.pid, commands, socket_path: socketPath }),
      5000,
    );
    if (published) {
      pi.logger.debug(`palette-commands: published instance state for ${sessionId}`);
    }
  });

  pi.on('session_shutdown', async () => {
    if (ids === null) return;
    // Removal + re-aggregation in one flock-held critical section, with a
    // shutdown-scoped budget so teardown never hangs.
    const idsNow = ids;
    const removed = await runLifecycle(
      pi,
      'remove',
      JSON.stringify({ session: idsNow.sessionId, pane: idsNow.paneId, pid: process.pid }),
      2000,
    );
    if (removed) {
      pi.logger.debug(`palette-commands: removed instance state for ${idsNow.sessionId}`);
    }
  });

  /**
   * Lifecycle critical section (delivery review round 2, R1/R2): the
   * registry mutation and re-aggregation run in a flock-held subprocess.
   * flock's exit code is an unambiguous result — 0 ran, 1 contended
   * (retry within budgetMs), anything else is a real failure. Nothing is
   * inferred from a void callback, and no userspace lock recovery exists
   * to race with a live holder.
   */
  async function runLifecycle(
    pi: ExtensionAPI,
    mode: 'publish' | 'remove',
    payload: string,
    budgetMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let outcome;
      try {
        outcome = await runCriticalSection(stateDir, mode, { payload });
      } catch (error) {
        pi.logger.warn(`palette-commands: ${mode} critical section failed: ${String(error)}`);
        return false;
      }
      if (outcome.ran) return true;
      if (outcome.exitCode === FLOCK_CONFLICT_EXIT) {
        if (Date.now() >= deadline) {
          pi.logger.warn(
            `palette-commands: aggregation lock stayed contended; ${mode} not applied this attempt`,
          );
          return false;
        }
        continue;
      }
      pi.logger.warn(
        `palette-commands: ${mode} critical section failed (exit ${outcome.exitCode}): ${outcome.stderr}`,
      );
      return false;
    }
  }
}

/**
 * Reads the instance's command inventory from three host sources, merged by
 * name (fix pass, findings 2 + 4):
 *
 * 1. `pi.getCommands()` — the session catalog (file/skill/extension
 *    commands). Thin: name and description, no argument hints, NO builtins.
 * 2. The builtin registry (`BUILTIN_SLASH_COMMAND_DEFS` via deep import) —
 *    where `omp: restart` and `omp: model` come from, with `inlineHint`
 *    usage hints and declarative subcommands.
 * 3. File-command discovery (`discoverSlashCommands`) — `.omp/commands`
 *    entries with their real `argumentHint`.
 *
 * Both imports are dynamic and individually optional: omp renames or moves
 * internal modules across releases, and a failed source degrades the
 * inventory (logged) rather than breaking publication. An entirely
 * unreadable catalog publishes no commands.
 */
async function readInventory(pi: ExtensionAPI): Promise<CommandInventoryEntry[]> {
  const sessionCommands = await safeList(pi, 'getCommands');
  const builtins = await loadBuiltinDefs(pi);
  const fileCommands = await loadFileCommands(pi);
  return mergeByName(
    sessionCommands.map(mapSessionCommand).filter((entry): entry is CommandInventoryEntry => entry !== null),
    builtins.map(mapBuiltinDef).filter((entry): entry is CommandInventoryEntry => entry !== null),
    fileCommands.map(mapFileCommand).filter((entry): entry is CommandInventoryEntry => entry !== null),
  );
}

/** Calls a host catalog accessor defensively; an unreadable catalog is an empty list. */
async function safeList(pi: ExtensionAPI, method: 'getCommands'): Promise<unknown[]> {
  try {
    const infos = pi[method]();
    return Array.isArray(infos) ? infos : [];
  } catch {
    return [];
  }
}

/** Loads the builtin slash-command defs; empty (logged) when the host does not expose the module. */
async function loadBuiltinDefs(pi: ExtensionAPI): Promise<unknown[]> {
  try {
    // Dynamic: the host may not expose this internal subpath in every omp
    // release; a static import would fail the whole extension at load.
    const module = (await import('@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry')) as {
      BUILTIN_SLASH_COMMAND_DEFS?: unknown;
    };
    return Array.isArray(module.BUILTIN_SLASH_COMMAND_DEFS) ? module.BUILTIN_SLASH_COMMAND_DEFS : [];
  } catch (error) {
    pi.logger.warn(`palette-commands: builtin registry unavailable; builtin commands (omp: restart, omp: model) will not publish: ${String(error)}`);
    return [];
  }
}

/** Loads discovered file commands (`.omp/commands`) with their argument hints. */
async function loadFileCommands(pi: ExtensionAPI): Promise<unknown[]> {
  try {
    // Dynamic: the export may be absent in older hosts; a static import
    // would fail the whole extension at load.
    const module = (await import('@oh-my-pi/pi-coding-agent')) as {
      discoverSlashCommands?: (options?: { cwd?: string }) => Promise<unknown[]>;
    };
    if (typeof module.discoverSlashCommands !== 'function') return [];
    const commands = await module.discoverSlashCommands({ cwd: process.cwd() });
    return Array.isArray(commands) ? commands : [];
  } catch (error) {
    pi.logger.warn(`palette-commands: file-command discovery unavailable; argument hints for file commands may be missing: ${String(error)}`);
    return [];
  }
}
