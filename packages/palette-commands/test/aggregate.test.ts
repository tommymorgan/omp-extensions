import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInstanceRegistry } from '../src/registry.ts';
import { actionIdFor, aggregateCommands, writeAggregatedManifest } from '../src/aggregate.ts';

/**
 * Plan Task 2.1, scenario 1 — "Aggregated manifest is the union of live
 * instances": every omp instance publishes its command inventory in its
 * session-scoped registry entry; the aggregator walks ALL sessions' entries,
 * keeps only entries whose PID is alive, and unions commands by name into
 * one `trailboss-plugin.toml` (one action per unique command, same bridge
 * argv). A dead instance's commands must vanish from the manifest — the
 * manifest mirrors the live fleet, never stale state. Killing instance B
 * must not lose instance A's commands (ADR 0005 §1/§3 + Revision).
 */

let workDir: string | null = null;

function fresh(): { stateDir: string; pluginDir: string } {
  workDir = mkdtempSync(join(tmpdir(), 'palette-aggregate-'));
  return { stateDir: join(workDir, 'state'), pluginDir: join(workDir, 'plugin') };
}

afterEach(() => {
  if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

const DEAD_PID = 4_194_304;


describe('aggregateCommands', () => {
  it('unions live instances\' commands across all sessions; dead entries excluded', () => {
    const { stateDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'daily',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [
        { name: 'restart', description: 'Restart the session' },
        { name: 'tan', description: 'Tan' },
      ],
    });
    writeInstanceRegistry(stateDir, {
      sessionId: 'palette-smoke-2',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model', description: 'Pick a model' }],
    });
    // Dead instance in a third session: its commands must never surface.
    const deadDir = join(stateDir, 'registry', 'ghost-session');
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(
      join(deadDir, 'w3:p1.json'),
      `${JSON.stringify({
        pane_id: 'w3:p1',
        pid: DEAD_PID,
        session_id: 'ghost-session',
        started_unix_ms: 0,
        commands: [{ name: 'zombie-cmd', description: 'should not appear' }],
      })}\n`,
    );

    const commands = aggregateCommands(stateDir);

    expect(commands.map((command) => command.name)).toEqual(['model', 'restart', 'tan']);
  });
});

describe('writeAggregatedManifest', () => {
  it('emits one action per unique live command with the shared bridge argv and an id↔name map', async () => {
    const { stateDir, pluginDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'daily',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'restart', description: 'Restart the session' }],
    });
    writeInstanceRegistry(stateDir, {
      sessionId: 'palette-smoke-2',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set', description: 'Pick a model' }],
    });

    await writeAggregatedManifest({ stateDir, pluginDir, bridgePath: '/opt/bridge.ts' });

    const manifestPath = join(pluginDir, 'trailboss-plugin.toml');
    expect(existsSync(manifestPath)).toBe(true);
    const parsed = Bun.TOML.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(parsed.id).toBe('omp');
    const actions = parsed.actions as Array<Record<string, unknown>>;
    expect(actions.map((action) => action.title)).toEqual(['omp: model set', 'omp: restart']);
    expect(actions.map((action) => action.id)).toEqual([actionIdFor('model set'), actionIdFor('restart')]);
    for (const action of actions) {
      expect(action.command).toEqual(['bun', '/opt/bridge.ts']);
    }
    const map = JSON.parse(readFileSync(join(pluginDir, 'dispatch.json'), 'utf8')) as {
      actions: Record<string, { name: string }>;
    };
    expect(map.actions).toEqual({
      [actionIdFor('model set')]: { name: 'model set' },
      [actionIdFor('restart')]: { name: 'restart' },
    });
  });

  it('zero live instances → valid manifest with zero actions', async () => {
    const { stateDir, pluginDir } = fresh();
    await writeAggregatedManifest({ stateDir, pluginDir, bridgePath: '/opt/bridge.ts' });
    const parsed = Bun.TOML.parse(
      readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(parsed.id).toBe('omp');
    expect(parsed.actions ?? []).toEqual([]);
  });
});

describe('argument-requiring commands publish (plan Task 2.1, scenario 2)', () => {
  it("an input_hint command's action carries the usage hint in its description", async () => {
    const { stateDir, pluginDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'daily',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'tan', description: "Log today's work", input_hint: '<work>' }],
    });

    await writeAggregatedManifest({ stateDir, pluginDir, bridgePath: '/opt/bridge.ts' });

    const parsed = Bun.TOML.parse(
      readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8'),
    ) as Record<string, unknown>;
    const actions = parsed.actions as Array<Record<string, unknown>>;
    const tan = actions.find((action) => action.title === 'omp: tan');
    expect(tan).toBeDefined();
    expect(tan?.description).toContain('<work>');
  });
});

describe('review fix pass — collisions, corrupt entries, surrogate-safe truncation', () => {
  it('names that sanitize identically get distinct STABLE hash ids; every mapping preserved', async () => {
    const { stateDir, pluginDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'daily',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [
        { name: 'model set', description: 'Space variant' },
        { name: 'model-set', description: 'Hyphen variant' },
        { name: 'model\tset', description: 'Tab variant' },
      ],
    });

    await writeAggregatedManifest({ stateDir, pluginDir, bridgePath: '/opt/bridge.ts' });

    const parsed = Bun.TOML.parse(
      readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8'),
    ) as Record<string, unknown>;
    const ids = (parsed.actions as Array<Record<string, unknown>>).map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length); // unique: trailboss rejects duplicates wholesale
    const originals = ['model set', 'model-set', 'model\tset'];
    // R3 (round 2): each id is the sanitized name + a content hash of the
    // FULL name — stable across generations, never reassigned to another
    // command, and distinct for names that sanitize identically.
    // Emission order is sorted-name order; compare order-free.
    expect(ids.slice().sort()).toEqual(originals.map(actionIdFor).sort());
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(120);
    const map = JSON.parse(readFileSync(join(pluginDir, 'dispatch.json'), 'utf8')) as {
      actions: Record<string, { name: string }>;
    };
    // The map is a bijection: every id inverts to its own original name.
    const byId: Record<string, string> = {};
    for (const id of ids) byId[id] = map.actions[id]?.name ?? '(missing)';
    for (const original of originals) expect(byId[actionIdFor(original)]).toBe(original);
  });

  it('structurally corrupt entries are skipped without blocking healthy aggregation', () => {
    const { stateDir } = fresh();
    const sessionDir = join(stateDir, 'registry', 'daily');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'corrupt-null.json'), 'null\n');
    writeFileSync(
      join(sessionDir, 'corrupt-commands.json'),
      `${JSON.stringify({ pane_id: 'w4:p1', pid: process.pid, session_id: 'daily', started_unix_ms: 0, commands: {} })}\n`,
    );
    writeInstanceRegistry(stateDir, {
      sessionId: 'other',
      paneId: 'w5:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'healthy', description: 'Fine' }],
    });

    const commands = aggregateCommands(stateDir);

    expect(commands.map((command) => command.name)).toEqual(['healthy']);
  });

  it('description truncation never splits a surrogate pair', async () => {
    const { stateDir, pluginDir } = fresh();
    const longDescription = `${'x'.repeat(189)}🌱`;
    writeInstanceRegistry(stateDir, {
      sessionId: 'daily',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'emoji', description: longDescription }],
    });

    await writeAggregatedManifest({ stateDir, pluginDir, bridgePath: '/opt/bridge.ts' });

    const parsed = Bun.TOML.parse(
      readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8'),
    ) as Record<string, unknown>;
    const action = (parsed.actions as Array<Record<string, unknown>>)[0];
    // 190 code points: the 189 ASCII chars plus the intact emoji.
    expect(Array.from(action.description as string)).toHaveLength(190);
    expect(action.description).toContain('🌱');
  });
});

describe('dead-entry sweep (plan Task 4.1)', () => {
  it('aggregation prunes registry files whose PID is dead; live files remain', () => {
    const { stateDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'smoke',
      paneId: 'w9:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'alive', description: 'Live instance' }],
    });
    writeInstanceRegistry(stateDir, {
      sessionId: 'smoke',
      paneId: 'w9:p2',
      pidOf: () => 999999999,
      commands: [{ name: 'ghost', description: 'SIGKILLed instance' }],
    });
    const deadPath = join(stateDir, 'registry', 'smoke', 'w9:p2.json');
    expect(existsSync(deadPath)).toBe(true);

    const commands = aggregateCommands(stateDir);

    expect(commands.map((command) => command.name)).toEqual(['alive']);
    expect(existsSync(deadPath)).toBe(false); // swept, not merely skipped
    expect(existsSync(join(stateDir, 'registry', 'smoke', 'w9:p1.json'))).toBe(true);
  });
});

describe('delivery review — recycled pids, stray files, suffix budget', () => {
  it('a RECYCLED pid (alive, wrong incarnation) is swept like a dead one', () => {
    const { stateDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'smoke',
      paneId: 'w9:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'alive', description: 'Live instance' }],
    });
    // Same pid as this process but a fabricated starttime: a reused pid.
    const ghostPath = join(stateDir, 'registry', 'smoke', 'w9:p2.json');
    writeFileSync(
      ghostPath,
      `${JSON.stringify({
        pane_id: 'w9:p2',
        pid: process.pid,
        proc_start_ticks: 424242,
        session_id: 'smoke',
        started_unix_ms: 0,
        commands: [{ name: 'zombie-cmd', description: 'recycled pid' }],
      })}\n`,
    );

    const commands = aggregateCommands(stateDir);

    expect(commands.map((command) => command.name)).toEqual(['alive']);
    expect(existsSync(ghostPath)).toBe(false);
  });

  it('a stray non-directory session entry is skipped, never blocks the fleet', () => {
    const { stateDir } = fresh();
    writeInstanceRegistry(stateDir, {
      sessionId: 'smoke',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'alive', description: 'Live instance' }],
    });
    // A pre-upgrade dot-segment session could write a pane JSON directly
    // into the registry root; aggregation must skip it, not crash.
    writeFileSync(join(stateDir, 'registry', 'w1:p1.json'), '{}\n');

    const commands = aggregateCommands(stateDir);

    expect(commands.map((command) => command.name)).toEqual(['alive']);
  });

  it('collision suffixes stay inside the 120-char action-id budget (finding 9)', async () => {
    const { stateDir, pluginDir } = fresh();
    const longName = 'a'.repeat(130);
    writeInstanceRegistry(stateDir, {
      sessionId: 'daily',
      paneId: 'w1:p1',
      pidOf: () => process.pid,
      commands: [
        { name: longName, description: 'First' },
        { name: `${longName}x`, description: 'Second' },
      ],
    });

    await writeAggregatedManifest({ stateDir, pluginDir, bridgePath: '/opt/bridge.ts' });

    const parsed = Bun.TOML.parse(
      readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8'),
    ) as Record<string, unknown>;
    const ids = (parsed.actions as Array<Record<string, unknown>>).map((action) => action.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(120);
  });
});
