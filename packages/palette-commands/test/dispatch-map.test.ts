import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISPATCH_MAP_FILENAME, readDispatchMap } from '../src/dispatch-map.ts';

/**
 * Delivery review finding 8 — the dispatch map: ONE immutable generation
 * file (dispatch.json) resolves sanitized palette action ids to their
 * original command names, published atomically BEFORE the manifest that
 * names the ids. Missing file, corrupt JSON, or wrong shape fail closed
 * (null); malformed entries are skipped, never fatal; the map is
 * prototype-free so `__proto__` and friends stay ordinary keys.
 */

function withPluginDir(mapContent: string | null): string {
  const pluginDir = mkdtempSync(join(tmpdir(), 'palette-dmap-'));
  if (mapContent !== null) {
    writeFileSync(join(pluginDir, DISPATCH_MAP_FILENAME), mapContent);
  }
  return pluginDir;
}

describe('readDispatchMap', () => {
  it('reads id → {name} entries', () => {
    const pluginDir = withPluginDir(
      `{"actions":{"model-set":{"name":"model set"},"restart":{"name":"restart"}}}\n`,
    );
    try {
      const map = readDispatchMap(pluginDir);
      expect(map).not.toBeNull();
      expect(map?.['model-set']).toEqual({ name: 'model set' });
      expect(map?.restart).toEqual({ name: 'restart' });
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('is prototype-free: a JSON __proto__ key becomes an ordinary own entry', () => {
    const pluginDir = withPluginDir(
      `{"actions":{"__proto__":{"name":"evil"},"ok":{"name":"fine"}}}\n`,
    );
    try {
      const map = readDispatchMap(pluginDir);
      expect(map).not.toBeNull();
      expect(Object.getPrototypeOf(map)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(map, '__proto__')).toBe(true);
      expect(map?.__proto__).toEqual({ name: 'evil' });
      expect(Object.keys(map ?? {})).toHaveLength(2);
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it('missing file, corrupt JSON, wrong shape: all fail closed to null', () => {
    for (const content of ['{not-json\n', '[]\n', '{"no-actions":{}}\n', 'null\n']) {
      const pluginDir = withPluginDir(content);
      try {
        expect(readDispatchMap(pluginDir)).toBeNull();
      } finally {
        rmSync(pluginDir, { recursive: true, force: true });
      }
    }
    const empty = withPluginDir(null);
    try {
      expect(readDispatchMap(empty)).toBeNull();
      expect(readDispatchMap(null)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('malformed entries are skipped without failing the whole map', () => {
    const pluginDir = withPluginDir(
      `{"actions":{"good":{"name":"ok"},"no-name":{"description":"x"},"empty-name":{"name":""},` +
        `"not-object":"string","is-null":null}}\n`,
    );
    try {
      const map = readDispatchMap(pluginDir);
      expect(map).not.toBeNull();
      expect(Object.keys(map ?? {})).toEqual(['good']);
      expect(map?.good).toEqual({ name: 'ok' });
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});
