import { describe, expect, it } from 'bun:test';
import { mapBuiltinDef, mapFileCommand, mapSessionCommand, mergeByName } from '../src/inventory.ts';
import type { CommandInventoryEntry } from '../src/registry.ts';

/**
 * Review findings 2 and 4 (Task 2.1 fix pass): `getCommands()` excludes
 * builtins and carries no argument hints. The inventory therefore merges
 * three host sources, each mapped defensively from its REAL runtime shape:
 * builtin registry defs (`inlineHint`, declarative subcommands), file
 * command discovery (`argumentHint`), and the thin session catalog
 * (name/description only). These tests pin the mapper behavior with
 * realistic shapes — not pre-built inventory objects.
 */

describe('inventory mappers', () => {
  it('maps a BuiltinSlashCommand def with inlineHint and subcommands', () => {
    const entry = mapBuiltinDef({
      name: 'model',
      description: 'Inspect or change the active model',
      allowArgs: true,
      inlineHint: '<provider/model>',
      subcommands: [
        { name: 'set', description: 'Set the model', usage: '<model>' },
        { name: 'bogus', description: 42 },
      ],
    });

    expect(entry).toEqual({
      name: 'model',
      description: 'Inspect or change the active model',
      input_hint: '<provider/model>',
      subcommands: [
        { name: 'set', usage: '<model>' },
        // Valid name, unusable description: the name survives, the garbage field is ignored.
        { name: 'bogus' },
      ],
    });
  });

  it('maps a FileSlashCommand with argumentHint from discovery', () => {
    const entry = mapFileCommand({
      name: 'deploy',
      description: 'Deploy the app',
      argumentHint: '<env>',
      source: 'prompt',
      location: { type: 'file', path: '/repo/.omp/commands/deploy.md' },
      handler: async () => {},
    });

    expect(entry).toEqual({
      name: 'deploy',
      description: 'Deploy the app',
      input_hint: '<env>',
    });
  });

  it('maps the thin session-catalog shape without inventing a hint', () => {
    const entry = mapSessionCommand({ name: 'tan', description: "Log today's work", source: 'prompt' });

    expect(entry).toEqual({ name: 'tan', description: "Log today's work" });
    expect(mapSessionCommand({ name: '', source: 'prompt' })).toBeNull();
    expect(mapSessionCommand(null)).toBeNull();
  });

  it('mergeByName prefers hint-carrying entries and unions disjoint names', () => {
    const sessionList = [
      { name: 'deploy', description: 'Deploy the app' },
      { name: 'tan', description: 'Work log' },
    ] satisfies CommandInventoryEntry[];
    const fileList = [
      { name: 'deploy', description: 'Deploy the app', input_hint: '<env>' },
      { name: 'restart', description: 'Restart the session', input_hint: '[confirm]' },
    ] satisfies CommandInventoryEntry[];

    const merged = mergeByName(sessionList, fileList);

    expect(merged).toEqual([
      { name: 'deploy', description: 'Deploy the app', input_hint: '<env>' },
      { name: 'tan', description: 'Work log' },
      { name: 'restart', description: 'Restart the session', input_hint: '[confirm]' },
    ]);
  });
});
