import type { CommandInventoryEntry } from './registry.ts';

/**
 * Inventory mappers (Task 2.1 fix pass, review findings 2 + 4). omp's
 * session catalog (`getCommands()`) excludes builtins and carries no
 * argument hints, so the published inventory merges three host sources.
 * Each mapper is defensive against shape drift across omp releases: it
 * reads only fields it can validate and never throws on corrupt input.
 *
 * The mappers are pure — `src/index.ts` owns host interaction (dynamic
 * imports, logging) and is exercised by the boundary run, while these
 * functions are pinned by unit tests with realistic runtime shapes.
 */

/** Name+description base shared by every host command shape. */
function mapBase(source: unknown): { name: string; description?: string } | null {
  if (source === null || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) return null;
  const base: { name: string; description?: string } = { name: record.name };
  if (typeof record.description === 'string' && record.description.length > 0) {
    base.description = record.description;
  }
  return base;
}

function hintFrom(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const hint = record[key];
    if (typeof hint === 'string' && hint.length > 0) return hint;
  }
  return undefined;
}

/** Maps a thin session-catalog entry (`getCommands()`): name/description, subcommands when present. */
export function mapSessionCommand(info: unknown): CommandInventoryEntry | null {
  const base = mapBase(info);
  if (base === null) return null;
  const entry: CommandInventoryEntry = base;
  const record = info as Record<string, unknown>;
  // omp releases have named the argument hint differently; take whichever
  // the host provides on this shape (the session catalog currently ships
  // none — hints come from the builtin registry and file discovery below).
  const hint = hintFrom(record, ['input_hint', 'argumentHint', 'argument_hint', 'inlineHint']);
  if (hint !== undefined) entry.input_hint = hint;
  entry.subcommands = mapSubcommands(record.subcommands);
  return entry;
}

/** Maps a `BuiltinSlashCommand` registry def: `inlineHint` + declarative subcommands. */
export function mapBuiltinDef(def: unknown): CommandInventoryEntry | null {
  const base = mapBase(def);
  if (base === null) return null;
  const entry: CommandInventoryEntry = base;
  const record = def as Record<string, unknown>;
  const hint = hintFrom(record, ['inlineHint', 'argumentHint']);
  if (hint !== undefined) entry.input_hint = hint;
  entry.subcommands = mapSubcommands(record.subcommands);
  return entry;
}

/** Maps a discovered `FileSlashCommand`: `argumentHint` is the real hint carrier on this shape. */
export function mapFileCommand(command: unknown): CommandInventoryEntry | null {
  const base = mapBase(command);
  if (base === null) return null;
  const entry: CommandInventoryEntry = base;
  const record = command as Record<string, unknown>;
  const hint = hintFrom(record, ['argumentHint', 'input_hint', 'argument_hint']);
  if (hint !== undefined) entry.input_hint = hint;
  return entry;
}

function mapSubcommands(subcommands: unknown): Array<{ name: string; usage?: string }> | undefined {
  if (!Array.isArray(subcommands)) return undefined;
  const mapped = subcommands.flatMap((subcommand) => {
    if (subcommand === null || typeof subcommand !== 'object') return [];
    const fields = subcommand as Record<string, unknown>;
    if (typeof fields.name !== 'string' || fields.name.length === 0) return [];
    const entry: { name: string; usage?: string } = { name: fields.name };
    if (typeof fields.usage === 'string' && fields.usage.length > 0) entry.usage = fields.usage;
    return [entry];
  });
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Unions inventories by command name. On a collision the entry carrying
 * more data wins — a hint-bearing file/builtin entry enriches its thin
 * session-catalog twin rather than being dropped as a duplicate.
 */
export function mergeByName(...lists: CommandInventoryEntry[][]): CommandInventoryEntry[] {
  const byName = new Map<string, CommandInventoryEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const existing = byName.get(entry.name);
      byName.set(entry.name, existing === undefined ? entry : richer(existing, entry));
    }
  }
  return [...byName.values()];
}

function richer(a: CommandInventoryEntry, b: CommandInventoryEntry): CommandInventoryEntry {
  const score = (entry: CommandInventoryEntry): number =>
    (entry.description !== undefined ? 1 : 0) +
    (entry.input_hint !== undefined ? 1 : 0) +
    (entry.subcommands !== undefined ? 1 : 0);
  return score(b) > score(a) ? b : a;
}
