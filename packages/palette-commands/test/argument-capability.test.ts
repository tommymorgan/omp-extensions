import type { Socket } from 'bun';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARGUMENT_CAPABILITY, readArgumentCapability } from '../src/argument-capability.ts';
import { actionIdFor, writeAggregatedManifest } from '../src/aggregate.ts';
import { writeInstanceRegistry } from '../src/registry.ts';

const supported = { type: 'ui_command_list', boot_id: 'boot-1', capabilities: [ARGUMENT_CAPABILITY], commands: [] };

async function withCore(run: (core: {
  root: string;
  socketPath: string;
  requests: Array<{ method: string; params: unknown }>;
  reply: (result: unknown, error?: boolean) => void;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'palette-cap-'));
  const sessionDir = join(root, 'sessions', 'daily');
  mkdirSync(sessionDir, { recursive: true });
  const socketPath = join(sessionDir, 'trailboss.sock');
  const pending = new Map<Socket, string>();
  const requests: Array<{ method: string; params: unknown }> = [];
  let response: unknown = supported;
  let isError = false;
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(client, chunk) {
        const text = (pending.get(client) ?? '') + new TextDecoder().decode(chunk);
        const newline = text.indexOf('\n');
        if (newline < 0) { pending.set(client, text); return; }
        pending.delete(client);
        const request = JSON.parse(text.slice(0, newline));
        requests.push({ method: request.method, params: request.params });
        client.write(`${JSON.stringify({ id: request.id, ...(isError ? { error: response } : { result: response }) })}\n`);
      },
      close(client) { pending.delete(client); },
    },
  });
  try {
    await run({ root, socketPath, requests, reply(result, error = false) { response = result; isError = error; } });
  } finally {
    await listener.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

async function actionsFor(root: string): Promise<Array<{ id: string; title: string; argument_input?: unknown; argument_hint?: string }>> {
  const pluginDir = join(root, 'plugin');
  await writeAggregatedManifest({ stateDir: root, pluginDir, bridgePath: '/opt/bridge.ts' });
  const parsed = Bun.TOML.parse(readFileSync(join(pluginDir, 'trailboss-plugin.toml'), 'utf8'));
  return parsed.actions ?? [];
}

describe('fresh session argument capability', () => {
  it('uses NDJSON ui.command.list and returns the current boot, never a cached version', async () => {
    await withCore(async ({ socketPath, requests, reply }) => {
      expect(await readArgumentCapability(socketPath, 'daily')).toEqual({ bootId: 'boot-1' });
      reply({ ...supported, boot_id: 'boot-2' });
      expect(await readArgumentCapability(socketPath, 'daily')).toEqual({ bootId: 'boot-2' });
      expect(requests).toEqual([{ method: 'ui.command.list', params: {} }, { method: 'ui.command.list', params: {} }]);
    });
  });

  it('refuses wrong-session and malformed paths without probing', async () => {
    await withCore(async ({ socketPath, requests }) => {
      expect(await readArgumentCapability(socketPath, 'other')).toBeNull();
      expect(await readArgumentCapability('/tmp/not-a-session.sock')).toBeNull();
      expect(requests).toEqual([]);
    });
  });

  it('treats old, malformed, error and unavailable Core results as unsupported', async () => {
    await withCore(async ({ socketPath, root, reply }) => {
      for (const result of [null, [], {}, { ...supported, type: 'wrong' }, { ...supported, boot_id: '' },
        { ...supported, capabilities: [] }, { ...supported, capabilities: [ARGUMENT_CAPABILITY, 1] },
        { ...supported, commands: {} }, { version: '99.0.0', commands: [] }]) {
        reply(result);
        expect(await readArgumentCapability(socketPath, 'daily')).toBeNull();
      }
      reply({ code: 'unsupported', message: 'old Core' }, true);
      expect(await readArgumentCapability(socketPath, 'daily')).toBeNull();
      expect(await readArgumentCapability(join(root, 'sessions', 'gone', 'trailboss.sock'), 'gone')).toBeNull();
    });
  });
});

describe('capability-gated fleet publication', () => {
  it('publishes exact escaped hints only from capable sources and probes each socket once per generation', async () => {
    await withCore(async ({ root, socketPath, requests, reply }) => {
      const hint = '  <pull-request> "quoted" \\ café\nnext  ';
      writeInstanceRegistry(root, { sessionId: 'daily', paneId: 'w1:p1', socketPath, commands: [
        { name: 'follow', input_hint: hint },
        { name: 'unknown', subcommands: [{ name: 'sub', usage: '<not-a-hint>' }] },
        { name: 'quit' },
      ] });
      writeInstanceRegistry(root, { sessionId: 'daily', paneId: 'w1:p2', socketPath, commands: [{ name: 'empty', input_hint: '' }] });
      writeInstanceRegistry(root, { sessionId: 'legacy', paneId: 'w1:p1', commands: [
        { name: 'follow', description: 'Richer legacy source', input_hint: '<wrong>' }, { name: 'legacy', input_hint: '<legacy>' },
      ] });
      const actions = await actionsFor(root);
      expect(requests).toHaveLength(1);
      expect(actions.map((action) => action.title)).toEqual(['omp: empty', 'omp: follow', 'omp: legacy', 'omp: unknown']);
      expect(actions.find((action) => action.title === 'omp: follow')).toMatchObject({ id: actionIdFor('follow'), argument_input: { kind: 'raw_tail' }, argument_hint: hint });
      expect(actions.find((action) => action.title === 'omp: empty')?.argument_hint).toBe('');
      expect(actions.find((action) => action.title === 'omp: unknown')?.argument_input).toEqual({ kind: 'raw_tail' });
      expect(actions.find((action) => action.title === 'omp: unknown')?.argument_hint).toBeUndefined();
      expect(actions.find((action) => action.title === 'omp: legacy')?.argument_input).toBeUndefined();
      expect(actions.find((action) => action.title === 'omp: legacy')?.argument_hint).toBeUndefined();
      reply({ ...supported, capabilities: [] });
      const legacyActions = await actionsFor(root);
      expect(requests).toHaveLength(2);
      for (const action of legacyActions) {
        expect(action.argument_input).toBeUndefined();
        expect(action.argument_hint).toBeUndefined();
      }
    });
  });

  it('rejects socket identity on writes and never activates malformed or mismatched registry sources', async () => {
    await withCore(async ({ root, socketPath, requests }) => {
      expect(() => writeInstanceRegistry(root, { sessionId: 'other', paneId: 'w1:p1', socketPath })).toThrow('socket');
      expect(() => writeInstanceRegistry(root, { sessionId: 'daily', paneId: 'w1:p1', socketPath: '/tmp/wrong.sock' })).toThrow('socket');
      const entry = writeInstanceRegistry(root, { sessionId: 'other', paneId: 'w1:p1', commands: [{ name: 'mismatch', input_hint: '<x>' }] });
      writeFileSync(entry.path, JSON.stringify({ ...entry.entry, socket_path: socketPath }));
      const malformed = writeInstanceRegistry(root, { sessionId: 'daily', paneId: 'w1:p2', commands: [{ name: 'malformed' }] });
      writeFileSync(malformed.path, JSON.stringify({ ...malformed.entry, socket_path: 12 }));
      const wrongDirectory = writeInstanceRegistry(root, { sessionId: 'daily', paneId: 'w1:p3', socketPath, commands: [{ name: 'wrong-directory' }] });
      writeFileSync(wrongDirectory.path, JSON.stringify({ ...wrongDirectory.entry, session_id: 'other' }));
      const actions = await actionsFor(root);
      expect(actions.map((action) => action.title)).toEqual(['omp: malformed', 'omp: mismatch']);
      for (const action of actions) expect(action.argument_input).toBeUndefined();
      expect(requests).toEqual([]);
    });
  });

  it('does not let a dead or recycled capable source authorize a legacy command', async () => {
    await withCore(async ({ root, socketPath, requests }) => {
      writeInstanceRegistry(root, { sessionId: 'legacy', paneId: 'w1:p1', commands: [{ name: 'follow', input_hint: '<legacy>' }] });
      const stale = writeInstanceRegistry(root, { sessionId: 'daily', paneId: 'w1:p2', socketPath, commands: [{ name: 'follow' }] });
      writeFileSync(stale.path, JSON.stringify({ ...stale.entry, proc_start_ticks: -1 }));
      const actions = await actionsFor(root);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.argument_input).toBeUndefined();
      expect(requests).toEqual([]);
    });
  });
});
