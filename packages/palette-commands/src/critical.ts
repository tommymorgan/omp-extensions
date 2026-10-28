import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAggregatedManifest } from './aggregate.ts';
import {
  removeInstanceState,
  writeInstanceRegistry,
  type CommandInventoryEntry,
} from './registry.ts';

/**
 * palette-commands critical section (delivery review round 2, findings
 * R1/R2): every cross-process mutation of the shared state — instance
 * publish, instance removal, and manifest re-aggregation — runs inside
 * ONE critical section owned by the KERNEL. This CLI is spawned under
 * `flock -x <stateDir>/aggregate.flock`; mutual exclusion, holder death,
 * and release are all handled by the OS.
 *
 * The superseded userspace protocols (per-holder claim files, then a lock
 * directory with rename-based dead-holder takeover) could not make
 * recovery conditional on the observed holder: a delayed contender could
 * rename away a live replacement lock, a paused initializer could be
 * reclaimed while alive, and a successful void callback was mistakable
 * for acquisition failure. `flock` deletes the entire class: no takeover,
 * no corpses, no grace windows — the kernel drops the lock when the
 * holder dies, and the child's exit code is an unambiguous result.
 *
 * Modes (argv): `aggregate [pluginDir]` re-aggregates and prints the
 * generation JSON; `publish`/`remove` read a JSON payload from stdin and
 * apply the registry mutation before re-aggregating, all under the held
 * flock. Callers reach these through `runCriticalSection` (below), which
 * supplies the lock; the extension (`index.ts`) uses it for lifecycle
 * events, and `aggregate.ts`'s CLI entry delegates here for manual runs.
 */

export interface PublishPayload {
  session: string;
  pane: string | null;
  pid: number;
  commands: CommandInventoryEntry[];
  socket_path?: string;
}

export interface RemovePayload {
  session: string;
  pane: string | null;
  pid: number;
}

/** One critical-section result. `ran` is true only when the section executed (exit 0); `stdout` carries the child's output for CLI pass-through. */
export interface CriticalOutcome {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** flock's reserved conflict exit code (`flock -E`): lock stayed held past the wait. Any OTHER nonzero exit is the child's real status and must be surfaced, not retried. */
export const FLOCK_CONFLICT_EXIT = 75;
const FLOCK_WAIT_S = 2;

/**
 * Runs one critical section as an `flock`-held subprocess of this file.
 * `flock -w` exit code 1 means the lock stayed held past the wait
 * (contended — the caller retries or skips); any other nonzero is a real
 * failure and its stderr is surfaced. `payload`, when given, is piped to
 * the child's stdin.
 */
export async function runCriticalSection(
  stateDir: string,
  mode: 'aggregate' | 'publish' | 'remove',
  options: { pluginDir?: string; payload?: string; waitSeconds?: number } = {},
): Promise<CriticalOutcome> {
  mkdirSync(stateDir, { recursive: true });
  const proc = Bun.spawn({
    cmd: [
      'flock',
      '-E',
      String(FLOCK_CONFLICT_EXIT),
      '-x',
      '-w',
      String(options.waitSeconds ?? FLOCK_WAIT_S),
      join(stateDir, 'aggregate.flock'),
      'bun',
      join(import.meta.dir, 'critical.ts'),
      stateDir,
      mode,
      ...(options.pluginDir === undefined ? [] : [options.pluginDir]),
    ],
    stdin: options.payload === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.payload !== undefined && proc.stdin !== null) {
    proc.stdin.write(options.payload);
    await proc.stdin.end();
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { ran: exitCode === 0, exitCode, stdout, stderr };
}

async function aggregate(stateDir: string, pluginDir?: string): Promise<void> {
  const outcome = await writeAggregatedManifest({
    stateDir,
    ...(pluginDir === undefined ? {} : { pluginDir }),
    bridgePath: join(import.meta.dir, 'bridge.ts'),
  });
  const names = Object.values(outcome.actionMap);
  process.stdout.write(
    `${JSON.stringify({ manifest: outcome.manifestPath, actions: names.length, commands: names })}\n`,
  );
}

function payloadFromStdin(): Record<string, unknown> {
  return JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>;
}

function parseIds(payload: Record<string, unknown>): { session: string; pane: string | null; pid: number } | null {
  const { session, pane, pid } = payload;
  if (typeof session !== 'string' || session.length === 0) return null;
  if (pane !== null && typeof pane !== 'string') return null;
  if (typeof pid !== 'number') return null;
  return { session, pane: typeof pane === 'string' ? pane : null, pid };
}

if (import.meta.main) {
  const [stateDir, mode, pluginDir] = process.argv.slice(2);
  if (stateDir === undefined || mode === undefined) {
    process.stderr.write('usage: critical.ts <stateDir> <aggregate|publish|remove> [pluginDir]\n');
    process.exit(64);
  }
  mkdirSync(stateDir, { recursive: true });
  if (mode === 'aggregate') {
    await aggregate(stateDir, pluginDir);
  } else if (mode === 'publish') {
    const payload = payloadFromStdin();
    const ids = parseIds(payload);
    const commands = payload.commands;
    const socketPath = payload.socket_path;
    if (socketPath !== undefined && typeof socketPath !== 'string') {
      process.stderr.write('palette-commands: publish socket_path must be a string\n');
      process.exit(64);
    }
    if (ids === null || !Array.isArray(commands)) {
      process.stderr.write('palette-commands: publish payload must be {session, pane, pid, commands}\n');
      process.exit(64);
    }
    writeInstanceRegistry(stateDir, {
      sessionId: ids.session,
      paneId: ids.pane,
      pidOf: () => ids.pid,
      commands: commands as CommandInventoryEntry[],
      socketPath,
    });
    await aggregate(stateDir, pluginDir);
  } else if (mode === 'remove') {
    const payload = payloadFromStdin();
    const ids = parseIds(payload);
    if (ids === null) {
      process.stderr.write('palette-commands: remove payload must be {session, pane, pid}\n');
      process.exit(64);
    }
    removeInstanceState(stateDir, { sessionId: ids.session, paneId: ids.pane, pid: ids.pid });
    await aggregate(stateDir, pluginDir);
  } else {
    process.stderr.write(`palette-commands: unknown critical-section mode ${JSON.stringify(mode)}\n`);
    process.exit(64);
  }
}
