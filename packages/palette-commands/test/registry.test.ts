import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isProcessAlive,
  isValidRegistryKey,
  processStartTicks,
  registryEntryFor,
  registryEntryPath,
  removeInstanceState,
  sessionFromSocketPath,
  writeInstanceRegistry,
} from '../src/registry.ts';

/**
 * Review findings 1 + 3 (Task 1.2 fix pass): trailboss pane ids are
 * per-session (`w1:p1` exists in every session), so the registry must be
 * scoped `registry/<session>/<pane_id>.json` — an invocation from session A
 * must never resolve session B's entry, or the bridge would type slash text
 * into A's shell pane. Keys come from the environment (pane id, session
 * name), so they are validated against trailboss's identifier charset on
 * both write and read; invalid keys fail closed instead of escaping the
 * registry directory (`/`, `..`).
 */

const SOCK = (session: string): string =>
  `/home/tommy/.config/trailboss/sessions/${session}/trailboss.sock`;

let stateDir: string | null = null;

function freshState(): string {
  stateDir = mkdtempSync(join(tmpdir(), 'palette-registry-'));
  return stateDir;
}

afterEach(() => {
  if (stateDir !== null) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe('session-scoped registry', () => {
  it('same pane id in two sessions: only the invoking session\'s entry resolves', () => {
    const dir = freshState();
    writeInstanceRegistry(dir, { sessionId: 'daily', paneId: 'w1:p1', pidOf: () => 111 });
    writeInstanceRegistry(dir, { sessionId: 'palette-smoke-2', paneId: 'w1:p1', pidOf: () => 222 });

    const entry = registryEntryFor(dir, 'palette-smoke-2', 'w1:p1');

    expect(entry?.pid).toBe(222);
    expect(registryEntryFor(dir, 'no-such-session', 'w1:p1')).toBeNull();
    // The two entries are distinct files under per-session dirs.
    expect(registryEntryPath(dir, 'daily', 'w1:p1')).not.toBe(
      registryEntryPath(dir, 'palette-smoke-2', 'w1:p1'),
    );
  });

  it('entry visible in another session\'s directory never resolves cross-session', () => {
    const dir = freshState();
    // Hand-place an entry ONLY under session "other" (simulating a concurrent session).
    const otherDir = join(dir, 'registry', 'other');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, 'w1:p1.json'),
      `${JSON.stringify({ pane_id: 'w1:p1', pid: 999, session_id: 'other', started_unix_ms: 0 })}\n`,
    );

    expect(registryEntryFor(dir, 'invoker', 'w1:p1')).toBeNull();
  });
});
describe('registry key validation', () => {
  it('accepts trailboss-charset keys, rejects path-bearing ones', () => {
    expect(isValidRegistryKey('palette-smoke-2')).toBe(true);
    expect(isValidRegistryKey('w1:p1')).toBe(true);
    expect(isValidRegistryKey('a.b_c-d')).toBe(true);
    expect(isValidRegistryKey('../evil')).toBe(false);
    expect(isValidRegistryKey('sub/dir')).toBe(false);
    expect(isValidRegistryKey('')).toBe(false);
    expect(isValidRegistryKey('with space')).toBe(false);
  });
  it('rejects dot-segment keys on write and read (no registry escape)', () => {
    expect(isValidRegistryKey('.')).toBe(false);
    expect(isValidRegistryKey('..')).toBe(false);
    const dir = freshState();
    expect(() =>
      writeInstanceRegistry(dir, { sessionId: '..', paneId: 'w1:p1', pidOf: () => 1 }),
    ).toThrow();
    expect(() =>
      writeInstanceRegistry(dir, { sessionId: '.', paneId: 'w1:p1', pidOf: () => 1 }),
    ).toThrow();
    expect(registryEntryFor(dir, '..', 'w1:p1')).toBeNull();
    expect(registryEntryFor(dir, '.', 'w1:p1')).toBeNull();
  });

  it('write refuses invalid pane or session keys (fail closed)', () => {
    const dir = freshState();
    expect(() =>
      writeInstanceRegistry(dir, { sessionId: 'daily', paneId: '../evil', pidOf: () => 1 }),
    ).toThrow();
    expect(() =>
      writeInstanceRegistry(dir, { sessionId: 'a/b', paneId: 'w1:p1', pidOf: () => 1 }),
    ).toThrow();
  });

  it('read fails closed on invalid keys: null, never a path escape', () => {
    const dir = freshState();
    // Pre-create a file at the path an unsanitized '../evil' session key
    // would resolve to; the validation gate must refuse the lookup before
    // any path resolution, so the entry is never found.
    mkdirSync(join(dir, 'evil'), { recursive: true });
    writeFileSync(
      join(dir, 'evil', 'w1:p1.json'),
      `${JSON.stringify({ pane_id: 'w1:p1', pid: 1, session_id: 'evil', started_unix_ms: 0 })}\n`,
    );
    expect(registryEntryFor(dir, '../evil', 'w1:p1')).toBeNull();
    expect(registryEntryFor(dir, 'daily', '../evil')).toBeNull();
  });
});

describe('process incarnation', () => {
  it('records the /proc starttime of the publishing pid', () => {
    const dir = freshState();
    const { entry } = writeInstanceRegistry(dir, { sessionId: 'daily', paneId: 'w1:p1' });
    expect(entry.proc_start_ticks).toBe(processStartTicks(process.pid));
  });

  it('alive pid with a wrong incarnation counts as dead; a dead pid counts as dead', () => {
    const ticks = processStartTicks(process.pid);
    expect(ticks).not.toBeNull();
    expect(isProcessAlive(process.pid, ticks ?? -1)).toBe(true);
    // Same pid alive but a different starttime: what a RECYCLED pid looks like.
    expect(isProcessAlive(process.pid, (ticks ?? 0) + 12345)).toBe(false);
    const exited = Bun.spawnSync(['true']);
    expect(isProcessAlive(exited.pid)).toBe(false);
    expect(processStartTicks(exited.pid)).toBeNull();
  });

  it('entries without a recorded incarnation authorize nothing (fail closed, round 2 R5)', () => {
    expect(isProcessAlive(process.pid, undefined)).toBe(false);
  });
});

describe('pid-guarded removal', () => {
  it('shutdown removes only the entry this process owns', () => {
    const dir = freshState();
    writeInstanceRegistry(dir, { sessionId: 'daily', paneId: 'w1:p1', pidOf: () => 111 });
    // A different process (e.g. a headless child sharing the pane env) must
    // not unlink the parent pane's registration.
    removeInstanceState(dir, { sessionId: 'daily', paneId: 'w1:p1', pid: 222 });
    expect(registryEntryFor(dir, 'daily', 'w1:p1')?.pid).toBe(111);
    removeInstanceState(dir, { sessionId: 'daily', paneId: 'w1:p1', pid: 111 });
    expect(registryEntryFor(dir, 'daily', 'w1:p1')).toBeNull();
  });

  it('removing an absent entry is a no-op, never a throw', () => {
    const dir = freshState();
    removeInstanceState(dir, { sessionId: 'daily', paneId: 'w9:p9', pid: 111 });
  });
});

describe('sessionFromSocketPath', () => {
  it('derives the session name from a trailboss session socket path', () => {
    expect(sessionFromSocketPath(SOCK('daily'))).toBe('daily');
    expect(sessionFromSocketPath(SOCK('palette-smoke-2'))).toBe('palette-smoke-2');
    expect(sessionFromSocketPath('/tmp/other.sock')).toBeNull();
    expect(sessionFromSocketPath('')).toBeNull();
  });
});
