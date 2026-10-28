import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateCommands, writeAggregatedManifest } from '../src/aggregate.ts';
import { writeInstanceRegistry } from '../src/registry.ts';

/**
 * Plan Task 4.1, scenario — "Deny-listed commands never publish" (ADR 0005
 * §4): the compiled default deny-list {quit, delete} plus the user-extendable
 * `deny-list.txt` (one command name per line, `#` comments) in the state dir
 * are enforced at AGGREGATION: denied names never emit actions and never
 * enter dispatch.json.
 */

let stateDir: string | null = null;

afterEach(() => {
  if (stateDir !== null) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

function publish(commands: Array<{ name: string; description?: string; input_hint?: string }>): string {
  stateDir = mkdtempSync(join(tmpdir(), 'palette-deny-'));
  writeInstanceRegistry(stateDir, {
    sessionId: 'daily',
    paneId: 'w1:p1',
    pidOf: () => process.pid,
    commands: commands as never,
  });
  return stateDir;
}

describe('deny-list enforcement at aggregation (Task 4.1)', () => {
  it('default-denylisted quit and delete never publish; others do', async () => {
    const dir = publish([
      { name: 'quit', description: 'Quit omp' },
      { name: 'delete', description: 'Delete things' },
      { name: 'restart', description: 'Restart' },
    ]);
    const pluginDir = join(dir, 'plugin');

    await writeAggregatedManifest({ stateDir: dir, pluginDir, bridgePath: '/opt/bridge.ts' });

    const manifest = readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8');
    expect(manifest).not.toContain('omp: quit');
    expect(manifest).not.toContain('omp: delete');
    expect(manifest).toContain('omp: restart');
    const dispatchMap = JSON.parse(readFileSync(join(pluginDir, 'dispatch.json'), 'utf8')) as {
      actions: Record<string, { name: string }>;
    };
    const names = Object.values(dispatchMap.actions).map((action) => action.name);
    expect(names).not.toContain('quit');
    expect(names).not.toContain('delete');
    expect(aggregateCommands(dir).map((command) => command.name)).toEqual(['restart']);
  });

  it('deny-list.txt additions are honored (with comments/blank lines); deletion restores the name', async () => {
    const dir = publish([{ name: 'tan', description: 'Work log' }, { name: 'restart', description: 'Restart' }]);
    const pluginDir = join(dir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(dir, 'deny-list.txt'), '# operator additions\ntan\n\n');

    await writeAggregatedManifest({ stateDir: dir, pluginDir, bridgePath: '/opt/bridge.ts' });
    expect(aggregateCommands(dir).map((command) => command.name)).toEqual(['restart']);

    rmSync(join(dir, 'deny-list.txt'));
    await writeAggregatedManifest({ stateDir: dir, pluginDir, bridgePath: '/opt/bridge.ts' });
    expect(aggregateCommands(dir).map((command) => command.name)).toEqual(['restart', 'tan']);
  });
});
