import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * palette-commands instance registry (plan Task 1.2 revised + Task 2.1, ADR
 * 0005 Revision): each omp instance running this extension publishes
 * `{pane_id, pid, session_id, started_unix_ms, commands}` as
 * `<stateDir>/registry/<session>/<pane_id>.json` (pane-null instances
 * publish under their session id; the bridge only dispatches non-null pane
 * entries). `commands` is the instance's unfiltered command inventory from
 * `api.getCommands()` (Task 2.1; deny-list filtering arrives in Task 4.1).
 *
 * The registry is SESSION-SCOPED because trailboss pane ids are per-session
 * (`w1:p1` exists in every session) — an invoking session must never
 * resolve another session's entry. The AGGREGATOR, by contrast, walks ALL
 * sessions' entries and unions their live commands by name (the manifest is
 * the stable union of the whole fleet). Keys are environment-sourced and
 * validated against trailboss's identifier charset `[A-Za-z0-9:._-]` on
 * both write and read; invalid keys fail closed rather than escaping the
 * registry directory (dot segments `.`/`..` are rejected outright).
 * Entries are removed on session_shutdown — only when the on-disk entry
 * still belongs to this process. A SIGKILLed instance leaves its stale
 * entry for the incarnation-aware liveness checks (pid alive AND
 * /proc/<pid>/stat starttime matches; Linux reuses PIDs) and the later
 * staleness sweep.
 */

export const REGISTRY_DIR_NAME = 'registry';

const KEY_PATTERN = /^[A-Za-z0-9:._-]+$/;
const SESSION_FROM_SOCKET_PATTERN = /\/sessions\/([^/]+)\/trailboss\.sock$/;

/** One command in an instance's inventory, as published for aggregation. */
export interface CommandInventoryEntry {
  name: string;
  description?: string;
  /** Usage hint for argument-requiring commands, e.g. `<work>`. */
  input_hint?: string;
  subcommands?: Array<{ name: string; usage?: string }>;
}

export interface InstanceRegistryEntry {
  pane_id: string | null;
  pid: number;
  /** /proc/<pid>/stat field 22 (clock ticks since boot): the process-incarnation id. A recycled PID never matches it. */
  proc_start_ticks?: number;
  session_id: string;
  started_unix_ms: number;
  commands?: CommandInventoryEntry[];
}

/** Trailboss identifier charset: action ids, pane ids and session names. Dot segments (`.`/`..`) are rejected: they would escape or reparent the registry directory. */
export function isValidRegistryKey(key: string): boolean {
  return key !== '.' && key !== '..' && KEY_PATTERN.test(key);
}

/** Derives the session name from a `…/sessions/<session>/trailboss.sock` path. */
export function sessionFromSocketPath(socketPath: string): string | null {
  const match = SESSION_FROM_SOCKET_PATTERN.exec(socketPath);
  if (match === null) return null;
  return isValidRegistryKey(match[1]) ? match[1] : null;
}

export interface PublishedInstance {
  entry: InstanceRegistryEntry;
  path: string;
}

export interface InstanceIds {
  sessionId: string;
  paneId: string | null;
  /** Test seam: the pid the entry claims; defaults to this process. */
  pidOf?: () => number;
  /** The instance's command inventory (Task 2.1). */
  commands?: CommandInventoryEntry[];
}

/** Registry file key: the pane id when known, else the session id. */
export function registryKey(paneId: string | null, sessionId: string): string {
  return paneId ?? sessionId;
}

export function registryEntryPath(stateDir: string, session: string, key: string): string {
  return join(stateDir, REGISTRY_DIR_NAME, session, `${key}.json`);
}

/** Publishes the instance's session-scoped registry entry atomically; refuses invalid keys. */
export function writeInstanceRegistry(
  stateDir: string,
  ids: InstanceIds,
): PublishedInstance {
  const key = registryKey(ids.paneId, ids.sessionId);
  if (!isValidRegistryKey(ids.sessionId)) {
    throw new Error(`palette-commands: invalid registry session key ${JSON.stringify(ids.sessionId)}`);
  }
  if (!isValidRegistryKey(key)) {
    throw new Error(`palette-commands: invalid registry entry key ${JSON.stringify(key)}`);
  }
  mkdirSync(join(stateDir, REGISTRY_DIR_NAME, ids.sessionId), { recursive: true });
  const pid = (ids.pidOf ?? ((): number => process.pid))();
  const entry: InstanceRegistryEntry = {
    pane_id: ids.paneId,
    pid,
    proc_start_ticks: processStartTicks(pid) ?? undefined,
    session_id: ids.sessionId,
    started_unix_ms: Date.now(),
    commands: ids.commands,
  };
  const path = registryEntryPath(stateDir, ids.sessionId, key);
  const stagingPath = `${path}.tmp-${process.pid}`;
  writeFileSync(stagingPath, `${JSON.stringify(entry)}\n`);
  renameSync(stagingPath, path);
  return { entry, path };
}

/** Reads the session-scoped registry entry for a pane, or null when absent/invalid/corrupt. */
export function registryEntryFor(
  stateDir: string,
  session: string,
  paneId: string,
): InstanceRegistryEntry | null {
  if (!isValidRegistryKey(session) || !isValidRegistryKey(paneId)) return null;
  const path = registryEntryPath(stateDir, session, paneId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstanceRegistryEntry;
  } catch {
    return null;
  }
}

/**
 * Removes the instance's registry entry (session_shutdown) — but only when
 * the on-disk entry still belongs to THIS process. A headless child sharing
 * the parent pane's env keys must never unlink the parent's registration,
 * and a key already re-published by a newer owner is left alone.
 */
export function removeInstanceState(
  stateDir: string,
  ids: { sessionId: string; paneId: string | null; pid?: number },
): void {
  const key = registryKey(ids.paneId, ids.sessionId);
  if (!isValidRegistryKey(ids.sessionId) || !isValidRegistryKey(key)) return;
  const path = registryEntryPath(stateDir, ids.sessionId, key);
  const expectedPid = ids.pid ?? process.pid;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as InstanceRegistryEntry;
    if (typeof entry.pid !== 'number' || entry.pid !== expectedPid) return;
  } catch {
    return; // absent or corrupt: nothing to remove
  }
  rmSync(path, { force: true });
}

/** /proc/<pid>/stat field 22 (starttime, clock ticks since boot): unique per process incarnation. */
export function processStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesized and may itself contain spaces and ')' —
    // fields 3+ start after the LAST ')'. Field 22 is index 19 from there.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/** The dispatch gate: an entry counts only while its PID lives (existence check). */
export function isPidAlive(pid: number): boolean {
  try {
    statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The dispatch gate, hardened: the pid must be alive AND be the same
 * process incarnation (matching /proc/<pid>/stat starttime). Linux reuses
 * PIDs, so bare existence would let a recycled pid impersonate a SIGKILLed
 * instance — and an entry WITHOUT a recorded incarnation authorizes
 * nothing either (delivery review round 2, R5): this package has never
 * shipped, every live instance publishes the field, and existence-only
 * authorization is exactly the recycled-pid hole.
 */
export function isProcessAlive(pid: number, startTicks?: number): boolean {
  if (startTicks === undefined) return false;
  if (!isPidAlive(pid)) return false;
  return processStartTicks(pid) === startTicks;
}
