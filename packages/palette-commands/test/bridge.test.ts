import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeDispatch, bridgeMain, runBridgeExecutable } from '../src/bridge.ts';
import { CLEAR_KEYS } from '../src/dispatch.ts';
import { writeInstanceRegistry } from '../src/registry.ts';

const CLEAN_PANE_TEXT = 'transcript line\n❯\n\n· model junkman\nmail omp-1 reachable\n';

/**
 * Plan Task 1.1, scenario 2 — "Bridge receives selected pane context": the
 * trailboss-spawned bridge argv reads `HERDR_PLUGIN_ACTION_ID` and
 * `HERDR_PLUGIN_CONTEXT_JSON` from its environment and logs one JSON line
 * `{action_id, context}`. At this layer the palette is replaced by the
 * fixture env trailboss sets when invoking plugin action "restart" with a
 * pane selected (PluginInvocationContext.focused_pane_id).
 *
 * Dispatch tests pin the delivery-review hardened contract: action ids
 * resolve through ONE dispatch.json generation (finding 8), the invoking
 * session is bound to the SELECTED socket (finding 2 + round 2 R6 — a
 * disagreeing OR UNRECOGNIZABLE socket refuses dispatch), the registry
 * entry must carry the command in its own inventory (finding 5), prefill
 * mode comes from the selected instance's own command entry (R7), and
 * every dispatch first clears the composer draft with a keys-only send
 * (finding 4 + R4).
 */
describe('bridgeMain', () => {
  it('logs the action id and parsed pane context as one JSON line and exits 0', () => {
    const contextJson = JSON.stringify({
      workspace_id: 'daily',
      focused_pane_id: 'pane-7',
      focused_pane_agent: 'omp',
      invocation_source: 'command_palette',
    });
    const lines: string[] = [];
    const exitCode = bridgeMain(
      {
        HERDR_PLUGIN_ACTION_ID: 'restart',
        HERDR_PLUGIN_CONTEXT_JSON: contextJson,
      },
      { writeLine: (line) => void lines.push(line) },
    );

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      action_id: 'restart',
      context: JSON.parse(contextJson),
    });
    expect(JSON.parse(lines[0]).context).toMatchObject({ focused_pane_id: 'pane-7' });
  });

  it('returns controlled exit 3 on malformed context JSON, logging nothing (review fix: the executable path must not throw)', () => {
    const lines: string[] = [];
    const exitCode = bridgeMain(
      {
        HERDR_PLUGIN_ACTION_ID: 'restart',
        HERDR_PLUGIN_CONTEXT_JSON: '{not-json',
      },
      { writeLine: (line) => void lines.push(line) },
    );

    expect(exitCode).toBe(3);
    expect(lines).toEqual([]);
  });
});

function writeDispatchMap(pluginDir: string, actions: Record<string, { name: string }>): void {
  writeFileSync(join(pluginDir, 'dispatch.json'), `${JSON.stringify({ actions })}\n`);
}

describe('runBridgeExecutable — production wiring (Task 3.1 review fix)', () => {
  it('malformed context exits 3 with the controlled error on stderr and nothing on stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runBridgeExecutable(
      { HERDR_PLUGIN_ACTION_ID: 'restart', HERDR_PLUGIN_CONTEXT_JSON: '{not-json' },
      (line) => void stdout.push(line),
      (message) => void stderr.push(message),
    );

    expect(code).toBe(3);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('focused_pane_id');
  });

  it('a successful dispatch emits the resolution log on stderr (info is wired in production)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runBridgeExecutable(
      {
        HERDR_PLUGIN_ACTION_ID: 'model-set',
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w2:p1' }),
        HERDR_SESSION: 'smoke',
        PALETTE_COMMANDS_PLUGIN_DIR: pluginDir,
      },
      (line) => void stdout.push(line),
      (message) => void stderr.push(message),
      { stateDir: join(workDir, 'state'), sendInput: async () => {}, readPaneRecent: async () => CLEAN_PANE_TEXT, wait: async () => {} },
    );

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1); // envelope contract only
    expect(stderr.join('\n')).toContain('action model-set');
    expect(stderr.join('\n')).toContain('w2:p1');
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe('bridgeDispatch — real invocation contexts (Task 3.1)', () => {
  interface Sent {
    paneId: string;
    text: string;
    keys: string[];
  }

  function fixtureEnv(pluginDir: string, contextJson: string): Record<string, string> {
    return {
      HERDR_PLUGIN_ACTION_ID: 'model-set',
      HERDR_PLUGIN_CONTEXT_JSON: contextJson,
      HERDR_SESSION: 'smoke',
      PALETTE_COMMANDS_PLUGIN_DIR: pluginDir,
    };
  }

  const liveContext = JSON.stringify({
    workspace_id: 'w2',
    focused_pane_id: 'w2:p1',
    focused_pane_agent: 'omp',
    invocation_source: 'command_palette',
  });

  it('clears the draft, dispatches through dispatch.json to the original command name, and logs the resolved target', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Sent[] = [];
    const errors: string[] = [];
    const infos: string[] = [];

    const code = await bridgeDispatch(fixtureEnv(pluginDir, liveContext), {
      err: (message) => void errors.push(message),
      info: (message) => void infos.push(message),
    }, {
      stateDir: join(workDir, 'state'),
      readPaneRecent: async () => CLEAN_PANE_TEXT,
      wait: async () => {},
      sendInput: async (paneId, text, keys) => {
        sent.push({ paneId, text, keys });
      },
    });

    expect(code).toBe(0);
    expect(sent).toEqual([
      { paneId: 'w2:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w2:p1', text: '/model set', keys: ['Enter'] },
    ]);
    expect(errors).toEqual([]);
    expect(infos.join('\n')).toContain('smoke');
    expect(infos.join('\n')).toContain('w2:p1');
    expect(infos.join('\n')).toContain('model-set');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('malformed context JSON fails closed: nonzero, nothing sent, no throw', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    const sent: Sent[] = [];
    const errors: string[] = [];

    const code = await bridgeDispatch(fixtureEnv(pluginDir, '{not-json'), {
      err: (message) => void errors.push(message),
    }, {
      stateDir: join(workDir, 'state'),
      sendInput: async (paneId, text, keys) => {
        sent.push({ paneId, text, keys });
      },
    });

    expect(code).not.toBe(0);
    expect(sent).toEqual([]);
    expect(errors.join('\n')).toContain('context');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('missing dispatch.json fails closed: nonzero, nothing sent, error names the dispatch map', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Sent[] = [];
    const errors: string[] = [];

    const code = await bridgeDispatch(fixtureEnv(pluginDir, liveContext), {
      err: (message) => void errors.push(message),
    }, {
      stateDir: join(workDir, 'state'),
      sendInput: async (paneId, text, keys) => {
        sent.push({ paneId, text, keys });
      },
    });

    expect(code).toBe(7);
    expect(sent).toEqual([]);
    expect(errors.join('\n')).toContain('dispatch.json');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('unknown action id (manifest newer than the dispatch map) exits 7, sends NOTHING', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'other-command': { name: 'other' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Sent[] = [];
    const errors: string[] = [];

    const code = await bridgeDispatch(fixtureEnv(pluginDir, liveContext), {
      err: (message) => void errors.push(message),
    }, {
      stateDir: join(workDir, 'state'),
      sendInput: async (paneId, text, keys) => {
        sent.push({ paneId, text, keys });
      },
    });

    expect(code).toBe(7);
    expect(sent).toEqual([]);
    expect(errors.join('\n')).toContain('dispatch metadata');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('HERDR_SESSION disagreeing with the selected socket\'s session exits 8, sends NOTHING (finding 2)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Sent[] = [];
    const errors: string[] = [];

    const code = await bridgeDispatch(
      {
        ...fixtureEnv(pluginDir, liveContext),
        // Verification would target "smoke" but input routes to "other"'s panes.
        PALETTE_TRAILBOSS_SOCKET: '/run/trailboss/sessions/other/trailboss.sock',
      },
      {
        err: (message) => void errors.push(message),
      },
      {
        stateDir: join(workDir, 'state'),
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(code).toBe(8);
    expect(sent).toEqual([]);
    expect(errors.join('\n')).toContain('disagrees');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('a selected socket whose session identity cannot be established exits 8 — no env fallback (round 2, R6)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Sent[] = [];
    const errors: string[] = [];

    const code = await bridgeDispatch(
      {
        ...fixtureEnv(pluginDir, liveContext),
        // A symlink or override pointing at another session's socket: the
        // path carries no session identity, and HERDR_SESSION must NOT be
        // trusted to fill the gap.
        PALETTE_TRAILBOSS_SOCKET: '/tmp/other.sock',
      },
      {
        err: (message) => void errors.push(message),
      },
      {
        stateDir: join(workDir, 'state'),
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(code).toBe(8);
    expect(sent).toEqual([]);
    expect(errors.join('\n')).toContain('cannot establish');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('the selected socket\'s session is authoritative when HERDR_SESSION is absent', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Sent[] = [];

    const code = await bridgeDispatch(
      {
        HERDR_PLUGIN_ACTION_ID: 'model-set',
        HERDR_PLUGIN_CONTEXT_JSON: liveContext,
        PALETTE_COMMANDS_PLUGIN_DIR: pluginDir,
        PALETTE_TRAILBOSS_SOCKET: '/run/trailboss/sessions/smoke/trailboss.sock',
      },
      { err: () => {} },
      {
        stateDir: join(workDir, 'state'),
      readPaneRecent: async () => CLEAN_PANE_TEXT,
      wait: async () => {},
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(code).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ paneId: 'w2:p1', text: '/model set', keys: ['Enter'] });
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe('bridgeDispatch prefill wiring (Task 3.2 + round 2, R7)', () => {
  it('prefill comes from the selected instance\'s own entry: required hint prefills, hintless submits', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, {
      tan: { name: 'tan' },
      restart: { name: 'restart' },
    });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'tan', input_hint: '<work>' }, { name: 'restart' }],
    });
    const sent: Array<{ paneId: string; text: string; keys: string[] }> = [];

    const baseEnv = {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w2:p1' }),
      HERDR_SESSION: 'smoke',
      PALETTE_COMMANDS_PLUGIN_DIR: pluginDir,
    };
    const prefillCode = await bridgeDispatch(
      { ...baseEnv, HERDR_PLUGIN_ACTION_ID: 'tan' },
      { err: () => {} },
      {
        stateDir: join(workDir, 'state'),
      readPaneRecent: async () => CLEAN_PANE_TEXT,
      wait: async () => {},
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );
    const submitCode = await bridgeDispatch(
      { ...baseEnv, HERDR_PLUGIN_ACTION_ID: 'restart' },
      { err: () => {} },
      {
        stateDir: join(workDir, 'state'),
      readPaneRecent: async () => CLEAN_PANE_TEXT,
      wait: async () => {},
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(prefillCode).toBe(0);
    expect(submitCode).toBe(0);
    expect(sent).toEqual([
      { paneId: 'w2:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w2:p1', text: '/tan ', keys: [] },
      { paneId: 'w2:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w2:p1', text: '/restart', keys: ['Enter'] },
    ]);
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe('runBridgeExecutable prefill transport (Task 3.2 review fix)', () => {
  it('a required-argument command reaches the transport seam as "/model set " with NO keys', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeDispatchMap(pluginDir, { 'model-set': { name: 'model set' } });
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set', input_hint: '<path>' }],
    });
    const sent: Array<{ paneId: string; text: string; keys: string[] }> = [];

    const code = await runBridgeExecutable(
      {
        HERDR_PLUGIN_ACTION_ID: 'model-set',
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w2:p1' }),
        HERDR_SESSION: 'smoke',
        PALETTE_COMMANDS_PLUGIN_DIR: join(workDir, 'plugin'),
      },
      () => {},
      () => {},
      {
        stateDir: join(workDir, 'state'),
      readPaneRecent: async () => CLEAN_PANE_TEXT,
      wait: async () => {},
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(code).toBe(0);
    expect(sent).toEqual([
      { paneId: 'w2:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w2:p1', text: '/model set ', keys: [] },
    ]);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('an unreadable dispatch.json exits 7 and sends NOTHING (never a silent submit)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'palette-bridge-'));
    const pluginDir = join(workDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'dispatch.json'), '{not-json\n');
    writeInstanceRegistry(join(workDir, 'state'), {
      sessionId: 'smoke',
      paneId: 'w2:p1',
      pidOf: () => process.pid,
      commands: [{ name: 'model set' }],
    });
    const sent: Array<{ paneId: string; text: string; keys: string[] }> = [];
    const stderr: string[] = [];

    const code = await runBridgeExecutable(
      {
        HERDR_PLUGIN_ACTION_ID: 'model-set',
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w2:p1' }),
        HERDR_SESSION: 'smoke',
        PALETTE_COMMANDS_PLUGIN_DIR: join(workDir, 'plugin'),
      },
      () => {},
      (message) => void stderr.push(message),
      {
        stateDir: join(workDir, 'state'),
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(code).toBe(7);
    expect(sent).toEqual([]);
    expect(stderr.join('\n')).toContain('dispatch.json');
    rmSync(workDir, { recursive: true, force: true });
  });
});
