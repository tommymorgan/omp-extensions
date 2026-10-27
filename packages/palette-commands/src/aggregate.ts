import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDenyList } from './deny-list.ts';
import { FLOCK_CONFLICT_EXIT, runCriticalSection } from './critical.ts';
import { DISPATCH_MAP_FILENAME, type DispatchAction } from './dispatch-map.ts';
import { writeManifestFile, type ManifestAction } from './manifest.ts';

import {
  isProcessAlive,
  REGISTRY_DIR_NAME,
  type CommandInventoryEntry,
  type InstanceRegistryEntry,
} from './registry.ts';

/**
 * palette-commands aggregator (plan Task 2.1, ADR 0005 §1/§3 + Revision):
 * walks ALL sessions' registry entries — the registry is session-scoped for
 * dispatch safety, but the manifest is the stable UNION of the whole live
 * fleet — keeps only entries whose process is alive AND the same
 * incarnation (pid + /proc starttime; a recycled pid never publishes),
 * unions commands by name (same name from multiple instances is one
 * action; the described variant wins; deterministic order: sorted by
 * name), and publishes ONE coherent generation into the plugin dir:
 * `dispatch.json` (sanitized id → original name, atomic replace) FIRST,
 * then the `trailboss-plugin.toml` manifest that names those ids — a
 * manifest action is never visible without its dispatch metadata. Action
 * ids are STABLE: a content hash of the command name is baked into every
 * id, so an id is never reassigned to a different command across
 * generations (a vanished command's id resolves as unknown — fail closed —
 * never to a newcomer). Prefill mode is determined at DISPATCH time from
 * the selected instance's own command entry, not from this union. Zero
 * live instances produce a valid zero-action manifest. The static
 * restart-only manifest from Task 1.1 is superseded: `omp: restart`
 * appears exactly when a live instance publishes `restart` (it is an omp
 * builtin).
 */

const ACTION_ID_MAX_CHARS = 120;
const DESCRIPTION_MAX_CHARS = 190;

/** Sanitizes a command name into a trailboss action id (`[A-Za-z0-9:._-]`, others → `-`, ≤120). */
export function sanitizeActionId(name: string): string {
  return name.replace(/[^A-Za-z0-9:._-]/g, '-').slice(0, ACTION_ID_MAX_CHARS);
}

/**
 * Stable action id for a command name: the sanitized name truncated to
 * leave room for a content-hash suffix (delivery review round 2, R3).
 * Distinct names get distinct hashes, so an id always means the same
 * command across generations — a vanished command's id resolves as
 * unknown (fail closed), never to the next colliding name.
 */
export function actionIdFor(name: string): string {
  const base = sanitizeActionId(name).slice(0, ACTION_ID_MAX_CHARS - 9);
  const digest = new Bun.CryptoHasher('sha256').update(name).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

/** Truncates on code-point boundaries: a UTF-16 slice can split an emoji into a lone surrogate, which is an invalid TOML scalar and would get the whole manifest rejected. */
export function truncateCodePoints(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join('');
}

/**
 * True when the command's usage hint carries a REQUIRED `<placeholder>`
 * argument (delivery review finding 10): omp marks optional parameters
 * with `[brackets]` and required ones with `<angle>`. Bracket-only hints
 * (`/compact [focus]`, `/model [name]`) are bare-invocable and dispatch
 * for immediate execution; anything with a required placeholder prefills
 * the composer instead. Placeholders quoted inside a bracket group
 * (`[--while '<cmd>']`) are optional and do not count.
 */
export function requiresArgument(command: CommandInventoryEntry): boolean {
  const hint = usageHint(command);
  if (hint === undefined) return false;
  const unbracketed = hint.replace(/\[[^\]]*\]/g, '');
  return /<[^>]+>/.test(unbracketed);
}

function usageHint(command: CommandInventoryEntry): string | undefined {
  if (command.input_hint !== undefined && command.input_hint.length > 0) return command.input_hint;
  for (const subcommand of command.subcommands ?? []) {
    if (subcommand.usage !== undefined && subcommand.usage.length > 0) return subcommand.usage;
  }
  return undefined;
}

/** Action description: truncated command description plus the usage hint when one exists. */
export function actionDescription(command: CommandInventoryEntry): string | undefined {
  const parts: string[] = [];
  if (command.description !== undefined && command.description.length > 0) {
    parts.push(truncateCodePoints(command.description, DESCRIPTION_MAX_CHARS));
  }
  const usage = usageHint(command);
  if (usage !== undefined) parts.push(usage);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Unions the command inventories of all LIVE instances across all sessions, sorted by name. */
export function aggregateCommands(stateDir: string): CommandInventoryEntry[] {
  const registryDir = join(stateDir, REGISTRY_DIR_NAME);
  if (!existsSync(registryDir)) return [];
  const denied = readDenyList(stateDir);
  const byName = new Map<string, CommandInventoryEntry>();
  for (const session of readdirSync(registryDir).sort()) {
    const sessionDir = join(registryDir, session);
    // Stray non-directory entries (hand-placed files, pre-upgrade
    // dot-segment sessions) are skipped: one bad entry must never block
    // the whole fleet's refresh.
    if (!statSync(sessionDir).isDirectory()) continue;
    for (const file of readdirSync(sessionDir).sort()) {
      if (!file.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(sessionDir, file), 'utf8'));
      } catch {
        continue; // unparseable entry: skip, never crash aggregation
      }
      // Structurally corrupt entries (null, wrong pid type, commands: {})
      // are skipped individually — one bad file must never block the whole
      // fleet's refresh. Per-command garbage is skipped the same way.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const entry = parsed as InstanceRegistryEntry;
      if (typeof entry.pid !== 'number' || !Array.isArray(entry.commands)) continue;
      if (!isProcessAlive(entry.pid, entry.proc_start_ticks)) {
        // Task 4.1 sweep: a dead OR RECYCLED pid (no session_shutdown ran,
        // or the kernel reused the pid for another process) means the
        // entry is stale — prune its file so the registry self-heals on
        // every aggregation, from any session.
        unlinkSync(join(sessionDir, file));
        continue;
      }
      for (const raw of entry.commands) {
        if (
          raw === null ||
          typeof raw !== 'object' ||
          typeof (raw as CommandInventoryEntry).name !== 'string' ||
          (raw as CommandInventoryEntry).name.length === 0
        ) {
          continue;
        }
        const command = raw as CommandInventoryEntry;
        if (denied.has(command.name)) continue; // Task 4.1: deny-listed names never publish
        const existing = byName.get(command.name);
        if (
          existing === undefined ||
          (existing.description === undefined && command.description !== undefined)
        ) {
          byName.set(command.name, command);
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface AggregateOptions {
  stateDir: string;
  /** Defaults to `PALETTE_COMMANDS_PLUGIN_DIR`, else the standard plugin dir. */
  pluginDir?: string;
  /** Absolute path of the bridge entry every action spawns. */
  bridgePath: string;
}

export interface AggregatedManifest {
  manifestPath: string;
  actionMap: Record<string, string>;
}

/** Aggregates live instances and publishes ONE coherent generation: dispatch.json (id → original name) first, then the trailboss manifest that names those ids. */
export function writeAggregatedManifest(options: AggregateOptions): AggregatedManifest {
  const pluginDir =
    options.pluginDir ??
    process.env.PALETTE_COMMANDS_PLUGIN_DIR ??
    join(homedir(), '.local', 'state', 'omp-extensions', 'palette-commands', 'plugin');
  const commands = aggregateCommands(options.stateDir);
  // Null prototype so a sanitized id like `__proto__` becomes an own entry
  // instead of mutating the map's prototype; JSON.stringify serializes own
  // entries either way.
  const dispatchMap: Record<string, DispatchAction> = Object.create(null);
  const usedIds = new Set<string>();
  const actions: ManifestAction[] = commands.map((command) => {
    // R3 (delivery review round 2): collision-suffixed ids reassigned an
    // existing id to a DIFFERENT command when a colliding name appeared or
    // vanished between generations. The hash suffix makes ids stable and
    // unique per name — a vanished command's id resolves as unknown (fail
    // closed), never to the next colliding name.
    const id = actionIdFor(command.name);
    if (usedIds.has(id)) {
      // Two distinct names hashing to the same 8-hex suffix (~2^-64):
      // refuse loudly rather than emit a duplicate id trailboss would
      // reject wholesale.
      throw new Error(`palette-commands: action id collision for ${JSON.stringify(command.name)}`);
    }
    usedIds.add(id);
    dispatchMap[id] = { name: command.name };
    return {
      id,
      title: `omp: ${command.name}`,
      description: actionDescription(command),
    };
  });
  mkdirSync(pluginDir, { recursive: true });
  // Finding 8: publish the dispatch metadata FIRST (atomic replace), then
  // the manifest — a manifest action can never be visible without its
  // dispatch metadata already in place.
  const dispatchPath = join(pluginDir, DISPATCH_MAP_FILENAME);
  const stagingDispatchPath = `${dispatchPath}.tmp-${process.pid}`;
  writeFileSync(stagingDispatchPath, `${JSON.stringify({ actions: dispatchMap }, null, 2)}\n`);
  renameSync(stagingDispatchPath, dispatchPath);
  const manifestPath = writeManifestFile(pluginDir, {
    actions,
    bridgeArgv: ['bun', options.bridgePath],
  });
  // Upgrade hygiene: the split two-file scheme (action-map.json +
  // prefill-actions.json) is superseded by dispatch.json; remove stale
  // copies an older install may have left in the plugin dir.
  for (const stale of ['action-map.json', 'prefill-actions.json']) {
    try {
      unlinkSync(join(pluginDir, stale));
    } catch {
      // absent: fine
    }
  }
  const actionMap: Record<string, string> = Object.create(null);
  for (const [id, action] of Object.entries(dispatchMap)) actionMap[id] = action.name;
  return { manifestPath, actionMap };
}

/**
 * CLI entry point (manual aggregation path): delegates to the flock-held
 * critical section (`critical.ts`), so a manual run can never interleave
 * with a concurrent instance's publish/removal or another aggregation.
 */
export async function cliAggregate(stateDir: string, pluginDir?: string): Promise<void> {
  const outcome = await runCriticalSection(stateDir, 'aggregate', { pluginDir });
  if (outcome.exitCode === FLOCK_CONFLICT_EXIT) {
    process.stderr.write('palette-commands: another live aggregation holds the lock; its result subsumes this run\n');
    return;
  }
  process.stdout.write(outcome.stdout);
  process.stderr.write(outcome.stderr);
  if (outcome.exitCode !== 0) process.exit(outcome.exitCode);
}

if (import.meta.main) {
  const stateDir = process.argv[2] ?? join(homedir(), '.local', 'state', 'omp-extensions', 'palette-commands');
  const pluginDir = process.argv[3];
  await cliAggregate(stateDir, pluginDir === undefined ? undefined : pluginDir);
}
