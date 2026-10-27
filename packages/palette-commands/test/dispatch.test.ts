import { describe, expect, it } from 'bun:test';
import { CLEAR_KEYS, CLEAR_ROUNDS, composerResidue, dispatchSlashCommand, type InstanceRegistryEntry } from '../src/dispatch.ts';

const CLEAN_PANE_TEXT = 'transcript line\n❯\n\n· model junkman\nmail omp-1 reachable\n';
const CLEAN_READ: { readPaneRecent: (paneId: string) => Promise<string>; wait: () => Promise<void> } = {
  readPaneRecent: async () => CLEAN_PANE_TEXT,
  wait: async () => {},
};

/**
 * Plan Task 1.2 (revised + review fix passes), scenario — "Dispatch executes
 * the slash command in the owning instance": the bridge resolves the
 * palette-selected pane via the extension-published, SESSION-SCOPED
 * instance registry (pane ids like `w1:p1` exist in every trailboss
 * session — review finding 1), verifies the PID is alive AND the same
 * process incarnation (pid + /proc starttime — delivery review finding 3),
 * verifies the command exists in the selected instance's OWN inventory
 * (finding 5: the manifest unions instances, and unknown slash text would
 * fall through to a model turn), clears any unsent composer draft with a
 * bounded keys-only sequence from ANY cursor position (finding 4 + round 2
 * R4: ctrl+e per round captures suffixes and start-of-line cursors), and
 * derives prefill mode from the selected instance's own command entry
 * (round 2 R7: the fleet union never overrides the instance's argument
 * contract). A dead or recycled PID, a missing entry, an unresolvable
 * invoking session, or a command another instance published sends NOTHING
 * and exits nonzero: slash text into an unverified pane would execute
 * shell commands (ADR 0005 Revision).
 */

interface Sent {
  paneId: string;
  text: string;
  keys: string[];
}

const LIVE_ENTRY: InstanceRegistryEntry = {
  pane_id: 'w1:p1',
  pid: process.pid,
  proc_start_ticks: 424242,
  session_id: 'palette-smoke-2',
  started_unix_ms: Date.now(),
  commands: [
    { name: 'restart' },
    { name: 'tan', input_hint: '<work>' },
    { name: 'compact', input_hint: '[focus]' },
  ],
};

describe('dispatchSlashCommand', () => {
  it('clears the composer draft, then sends exactly "/restart" + Enter to the invoking session\'s registry-resolved live pane', async () => {
    const sent: Sent[] = [];
    const lookedUp: Array<{ session: string; paneId: string }> = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'palette-smoke-2', paneId: 'w1:p1' },
      {
        entryFor: (session, paneId) => {
          lookedUp.push({ session, paneId });
          return LIVE_ENTRY;
        },
        isProcessAlive: (pid, startTicks) =>
          pid === LIVE_ENTRY.pid && startTicks === LIVE_ENTRY.proc_start_ticks,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).toBe(0);
    expect(outcome.error).toBeUndefined();
    expect(lookedUp).toEqual([{ session: 'palette-smoke-2', paneId: 'w1:p1' }]);
    // Call order is draft clearing FIRST, then the command text.
    expect(sent).toEqual([
      { paneId: 'w1:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w1:p1', text: '/restart', keys: ['Enter'] },
    ]);
  });

  it('the clearing sequence is keys-only, bounded, and consumes a line from any cursor position', () => {
    // One round per draft line: ctrl+e (line END — captures any suffix
    // after the cursor), ctrl+u (delete the line to its start), down
    // (descend to the next line while any remain below), backspace (join
    // the now-empty current line into the line above).
    expect(CLEAR_KEYS.length).toBe(CLEAR_ROUNDS * 4 + 2);
    for (let round = 0; round < CLEAR_ROUNDS; round += 1) {
      expect(CLEAR_KEYS.slice(round * 4, round * 4 + 4)).toEqual(['ctrl+e', 'ctrl+u', 'down', 'backspace']);
    }
    expect(CLEAR_KEYS.slice(-2)).toEqual(['ctrl+e', 'ctrl+u']);
    for (const key of CLEAR_KEYS) expect(['ctrl+e', 'ctrl+u', 'down', 'backspace']).toContain(key);
  });

  it('composerResidue: only the unambiguous empty shape verifies clean; ambiguous reads refuse', () => {
    expect(composerResidue('transcript\n❯\n\n· model junkman\nmail omp-1 reachable\n')).toBeNull();
    expect(composerResidue('❯\n· model junkman\nmail omp-1\n')).toBeNull(); // no blank separator
    expect(composerResidue('❯ DRAFTMARKER q7\n\n· status')).toBe('DRAFTMARKER q7');
    expect(composerResidue('❯ FIRSTLINE\n  SECONDLINE\n\n· status')).toBe('FIRSTLINE');
    expect(composerResidue('no prompt anywhere\n· status')).toContain('not found');
    // Round-5 regressions: blank continuation lines and a literal ❯ inside
    // draft content must never false-clean.
    expect(composerResidue('❯\n\n  SECRET\n\n· status')).toContain('composer continuation');
    expect(composerResidue('❯\n  SECONDLINE\n\n· status')).toContain('composer continuation');
    expect(composerResidue('❯\n\n  ❯\n  SECRET\n\n· status')).toContain('composer continuation');
    expect(composerResidue('❯\n\n')).toContain('no recognizable status block');
    // Round-6 regressions (reviewer fixtures): residue hidden BEFORE a
    // trailing prompt-looking draft line, and non-status output after a
    // middot-headed block — the status region must account for the whole
    // remaining output.
    expect(composerResidue('❯\n  SECRET\n  ❯\n\n· model junkman\nmail omp-1 reachable\n')).toContain('composer continuation');
    expect(composerResidue('❯\n\n· draft bullet\n\nSECRET\n\n· real status')).toContain('non-status content after the status block');
    expect(composerResidue('❯\n  a · b\n\n· model junkman\nmail omp-1\n')).toContain('composer continuation');
    // Round-7 regression (contiguous footer, bottomBarGap:false): a
    // gutter-indented continuation containing a middot must never pass
    // as the first status row.
    expect(composerResidue('❯\n  a · b\n· model junkman\nmail omp-1 reachable\n')).toContain('composer continuation above the status block');
  });

  it('residue beyond the clearing bound refuses dispatch: clearing keys only, no command sent', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'smoke', paneId: 'w1:p1' },
      {
        entryFor: () => LIVE_ENTRY,
        isProcessAlive: () => true,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
        readPaneRecent: async () => '❯ /restart\nunintended residue line 66\n\nstatus',
        wait: async () => {},
      },
    );
    expect(outcome.code).toBe(10);
    expect(outcome.error).toContain('refusing dispatch');
    expect(sent).toEqual([{ paneId: 'w1:p1', text: '', keys: CLEAR_KEYS }]);
  });

  it('a gutter-indented continuation posing as a status row (bottomBarGap:false) refuses dispatch', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'smoke', paneId: 'w1:p1' },
      {
        entryFor: () => LIVE_ENTRY,
        isProcessAlive: () => true,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
        readPaneRecent: async () => '❯\n  a · b\n· model junkman\nmail omp-1 reachable\n',
        wait: async () => {},
      },
    );
    expect(outcome.code).toBe(10);
    expect(outcome.error).toContain('composer continuation above the status block');
    expect(sent).toEqual([{ paneId: 'w1:p1', text: '', keys: CLEAR_KEYS }]);
  });

  it('unresolvable invoking session: sends nothing, exits nonzero', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: null, paneId: 'w1:p1' },
      {
        entryFor: () => {
          throw new Error('entryFor must not be called without a session');
        },
        isProcessAlive: () => true,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).not.toBe(0);
    expect(sent).toEqual([]);
  });

  it('dead registry PID: sends nothing, exits nonzero, names the stale pane', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'palette-smoke-2', paneId: 'w1:p1' },
      {
        entryFor: () => ({ ...LIVE_ENTRY, pid: 4_194_304 }),
        isProcessAlive: () => false,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).not.toBe(0);
    expect(outcome.error).toMatch(/w1:p1/);
    expect(sent).toEqual([]);
  });

  it('recycled PID (alive but a different incarnation): sends nothing, exits nonzero', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'palette-smoke-2', paneId: 'w1:p1' },
      {
        // The kernel reused the pid for a new process: alive, wrong starttime.
        entryFor: () => ({ ...LIVE_ENTRY, proc_start_ticks: 777 }),
        isProcessAlive: (pid, startTicks) =>
          pid === LIVE_ENTRY.pid && startTicks === LIVE_ENTRY.proc_start_ticks,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).toBe(5);
    expect(outcome.error).toMatch(/recycled/);
    expect(sent).toEqual([]);
  });

  it('no registry entry: sends nothing, exits nonzero', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'palette-smoke-2', paneId: 'w9:p9' },
      {
        entryFor: () => null,
        isProcessAlive: () => true,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).not.toBe(0);
    expect(outcome.error).toMatch(/w9:p9/);
    expect(sent).toEqual([]);
  });

  it('command absent from the selected instance\'s inventory: sends nothing, exits 9', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'palette-smoke-2', paneId: 'w1:p1' },
      {
        // Another instance published /restart; this one never did.
        entryFor: () => ({ ...LIVE_ENTRY, commands: [{ name: 'model' }] }),
        isProcessAlive: () => true,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).toBe(9);
    expect(outcome.error).toMatch(/inventory/);
    expect(sent).toEqual([]);
  });

  it('inventory-less entry (legacy shape): fail closed, sends nothing', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'restart',
      { session: 'palette-smoke-2', paneId: 'w1:p1' },
      {
        entryFor: () => ({ ...LIVE_ENTRY, commands: undefined }),
        isProcessAlive: () => true,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => void sent.push({ paneId, text, keys }),
      },
    );

    expect(outcome.code).toBe(9);
    expect(sent).toEqual([]);
  });
});

describe('prefill mode from the selected instance\'s own entry (round 2, R7)', () => {
  it('a REQUIRED-argument command prefills "/tan " with NO key press', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'tan',
      { session: 'palette-smoke-3', paneId: 'w1:p1' },
      {
        entryFor: () => LIVE_ENTRY,
        isProcessAlive: () => true,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(outcome.code).toBe(0);
    expect(sent).toEqual([
      { paneId: 'w1:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w1:p1', text: '/tan ', keys: [] },
    ]);
  });

  it('an optional-only hint ("/compact [focus]") submits immediately — bare-invocable', async () => {
    const sent: Sent[] = [];
    const outcome = await dispatchSlashCommand(
      'compact',
      { session: 'palette-smoke-3', paneId: 'w1:p1' },
      {
        entryFor: () => LIVE_ENTRY,
        isProcessAlive: () => true,
        ...CLEAN_READ,
        sendInput: async (paneId, text, keys) => {
          sent.push({ paneId, text, keys });
        },
      },
    );

    expect(outcome.code).toBe(0);
    expect(sent).toEqual([
      { paneId: 'w1:p1', text: '', keys: CLEAR_KEYS },
      { paneId: 'w1:p1', text: '/compact', keys: ['Enter'] },
    ]);
  });
});
