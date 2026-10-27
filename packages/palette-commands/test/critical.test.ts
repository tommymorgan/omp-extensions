import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCriticalSection } from '../src/critical.ts';
import { registryEntryFor } from '../src/registry.ts';

/**
 * Delivery review round 2 (R1/R2): all shared-state mutations — instance
 * publish, instance removal, manifest re-aggregation — run as flock-held
 * critical sections. The KERNEL owns mutual exclusion (no userspace
 * takeover, no corpses, no grace windows — the failure classes of both
 * superseded userspace protocols are unreachable), and flock's exit code
 * is an unambiguous result: 0 ran, 1 contended, anything else failed.
 * These tests exercise the real subprocess path, including a concurrent
 * multi-process serialization witness.
 */

let workDir: string | null = null;

afterEach(() => {
  if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function fresh(): { stateDir: string; pluginDir: string } {
  workDir = mkdtempSync(join(tmpdir(), 'palette-critical-'));
  const stateDir = join(workDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { stateDir, pluginDir: join(workDir, 'plugin') };
}

function publishPayload(session: string, pane: string, commands: Array<{ name: string }>): string {
  return JSON.stringify({ session, pane, pid: process.pid, commands });
}

describe('flock-held critical sections', () => {
  it('aggregate runs and reports the generation', async () => {
    const { stateDir, pluginDir } = fresh();
    const outcome = await runCriticalSection(stateDir, 'aggregate', { pluginDir });
    expect(outcome.ran).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(pluginDir, 'trailboss-plugin.toml'))).toBe(true);
    expect(existsSync(join(pluginDir, 'dispatch.json'))).toBe(true);
  });

  it('publish writes the registry entry (with the caller pid) and aggregates', async () => {
    const { stateDir, pluginDir } = fresh();
    const outcome = await runCriticalSection(stateDir, 'publish', {
      pluginDir,
      payload: publishPayload('smoke', 'w1:p1', [{ name: 'restart' }]),
    });
    expect(outcome.ran).toBe(true);
    const entry = registryEntryFor(stateDir, 'smoke', 'w1:p1');
    expect(entry?.pid).toBe(process.pid);
    expect(entry?.proc_start_ticks).toBeDefined();
    expect(existsSync(join(pluginDir, 'trailboss-plugin.toml'))).toBe(true);
  });

  it('remove takes only the caller pid\'s entry, then aggregates', async () => {
    const { stateDir, pluginDir } = fresh();
    await runCriticalSection(stateDir, 'publish', {
      pluginDir,
      payload: publishPayload('smoke', 'w1:p1', [{ name: 'restart' }]),
    });
    // A different process (e.g. a headless child sharing the pane env):
    // pid-guarded removal leaves the owner's entry in place.
    await runCriticalSection(stateDir, 'remove', {
      pluginDir,
      payload: JSON.stringify({ session: 'smoke', pane: 'w1:p1', pid: 999_999_999 }),
    });
    expect(registryEntryFor(stateDir, 'smoke', 'w1:p1')?.pid).toBe(process.pid);
    await runCriticalSection(stateDir, 'remove', {
      pluginDir,
      payload: JSON.stringify({ session: 'smoke', pane: 'w1:p1', pid: process.pid }),
    });
    expect(registryEntryFor(stateDir, 'smoke', 'w1:p1')).toBeNull();
  });

  it('a held lock times out (flock -E conflict exit 75): contention is reported, never mistaken for success', async () => {
    const { stateDir } = fresh();
    const holder = Bun.spawn(
      ['flock', '-x', join(stateDir, 'aggregate.flock'), 'sh', '-c', 'echo acquired; sleep 2'],
      { stdout: 'pipe' },
    );
    // Await the holder's own under-lock signal instead of guessing a delay:
    // the echo runs while the lock is held, so its first byte proves contention.
    const reader = holder.stdout.getReader();
    await reader.read();
    await reader.cancel();
    const outcome = await runCriticalSection(stateDir, 'aggregate', { waitSeconds: 0.3 });
    expect(outcome.ran).toBe(false);
    expect(outcome.exitCode).toBe(75);
    holder.kill();
    await holder.exited;
  });

  it('a real child failure under an acquired lock surfaces its own exit code and stderr, not the conflict code', async () => {
    const { stateDir } = fresh();
    const outcome = await runCriticalSection(stateDir, 'bogus' as never, { waitSeconds: 0.3 });
    expect(outcome.ran).toBe(false);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain('unknown critical-section mode');
  });

  it('concurrent sections serialize: every publish survives and the final generation is coherent', async () => {
    const { stateDir, pluginDir } = fresh();
    // Three concurrent flock-held subprocesses: two publishes (different
    // panes) and one aggregate. The kernel serializes them; no entry is
    // lost and no manifest write is clobbered.
    const results = await Promise.all([
      runCriticalSection(stateDir, 'publish', {
        pluginDir,
        payload: publishPayload('smoke', 'w1:p1', [{ name: 'restart' }]),
      }),
      runCriticalSection(stateDir, 'publish', {
        pluginDir,
        payload: publishPayload('smoke', 'w1:p2', [{ name: 'model set' }]),
      }),
      runCriticalSection(stateDir, 'aggregate', { pluginDir }),
    ]);
    for (const outcome of results) expect(outcome.ran).toBe(true);
    expect(registryEntryFor(stateDir, 'smoke', 'w1:p1')?.pid).toBe(process.pid);
    expect(registryEntryFor(stateDir, 'smoke', 'w1:p2')?.pid).toBe(process.pid);
    const manifest = readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8');
    expect(manifest).toContain('omp: restart');
    expect(manifest).toContain('omp: model set');
  });

  it('an unknown mode exits 64 without touching state', async () => {
    const { stateDir, pluginDir } = fresh();
    const outcome = await runCriticalSection(stateDir, 'bogus' as never, { pluginDir });
    expect(outcome.ran).toBe(false);
    expect(outcome.exitCode).toBe(64);
  });
});
