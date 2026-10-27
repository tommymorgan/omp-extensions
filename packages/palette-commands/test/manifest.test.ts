import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeManifestFile } from '../src/manifest.ts';

/**
 * Plan Task 1.1, scenario 1 — "Palette lists a published omp command",
 * carried forward through the Task 2.1 generalization: the manifest writer
 * emits the `trailboss-plugin.toml` that, once linked, makes omp commands
 * visible in `ui.command.list`. Since Task 2.1 the manifest is the
 * aggregated union — one `[[actions]]` per unique live command, all sharing
 * the bridge argv (`HERDR_PLUGIN_ACTION_ID` carries the id) — and the
 * palette-facing assertions reduce to the manifest fields trailboss renders
 * from: root plugin identity plus each action's id/title/description/argv.
 */
describe('writeManifestFile', () => {
  it('emits a plugin manifest with one entry per action and the shared bridge argv', () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'palette-manifest-'));
    try {
      const manifestPath = writeManifestFile(pluginDir, {
        actions: [
          {
            id: 'restart',
            title: 'omp: restart',
            description: 'Restart the OMP session attached to the selected pane',
          },
          { id: 'tan', title: 'omp: tan' },
        ],
        bridgeArgv: ['bun', '/opt/bridge.ts'],
      });

      expect(manifestPath).toBe(join(pluginDir, 'trailboss-plugin.toml'));

      const parsed = Bun.TOML.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      expect(parsed.id).toBe('omp');
      expect(typeof parsed.name).toBe('string');
      expect(parsed.min_herdr_version).toBe('0.9.0');
      expect((parsed.name as string).length).toBeGreaterThan(0);
      expect(typeof parsed.version).toBe('string');
      expect((parsed.version as string).length).toBeGreaterThan(0);

      const actions = parsed.actions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(2);
      expect(actions[0].id).toBe('restart');
      expect(actions[0].title).toBe('omp: restart');
      expect(typeof actions[0].description).toBe('string');
      expect((actions[0].description as string).length).toBeGreaterThan(0);
      expect(actions[0].command).toEqual(['bun', '/opt/bridge.ts']);
      expect(actions[1].id).toBe('tan');
      expect(actions[1].title).toBe('omp: tan');
      expect(actions[1].command).toEqual(['bun', '/opt/bridge.ts']);
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});
