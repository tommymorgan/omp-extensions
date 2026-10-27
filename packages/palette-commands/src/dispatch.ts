import { requiresArgument } from './aggregate.ts';
import type { InstanceRegistryEntry } from './registry.ts';

/**
 * palette-commands dispatch core (plan Task 1.2 revised + review fix passes +
 * Task 2.1, ADR 0005 Revision): the bridge resolves the palette-selected pane
 * via the extension-published, SESSION-SCOPED instance registry, verifies the
 * owning process is alive AND the same incarnation (pid + /proc starttime),
 * and only then sends the slash text through the trailboss session socket as
 * `pane.send_input {text: "/<commandName>", keys: ["Enter"]}` — omp's real
 * input path, equivalent to typing "/restart" and pressing Enter. The command
 * must exist in the selected instance's OWN inventory: the manifest unions
 * commands across instances, and an unknown slash text in this pane would
 * fall through to a model turn. Before any command text, a bounded key
 * sequence clears an unsent composer draft — from any cursor position —
 * so it cannot be merged into the submitted command; prefill mode comes
 * from the selected instance's own command entry (its argument contract),
 * never the fleet-wide union.
 * `commandName` is the ORIGINAL command name, inverted
 * from the sanitized palette action id via the dispatch map (Task 2.1).
 * Anything less than a live, same-session, same-incarnation registry entry
 * sends NOTHING and exits nonzero: slash text typed into an unverified pane
 * would execute shell commands, and pane ids alone are not identity (every
 * trailboss session has a `w1:p1`).
 */

export type { InstanceRegistryEntry } from './registry.ts';

export interface DispatchTarget {
  /** The invoking trailboss session; null when it cannot be resolved. */
  session: string | null;
  /** The palette-selected pane from the invocation context. */
  paneId: string | null;
}

export interface DispatchDeps {
  /** Session-scoped registry entry published by the pane's omp instance, or null if none. */
  entryFor(session: string, paneId: string): InstanceRegistryEntry | null;
  /** Incarnation-aware liveness: pid alive AND /proc starttime matches (when recorded). */
  isProcessAlive(pid: number, startTicks?: number): boolean;
  /** Sends text + key presses into the pane via the trailboss session socket. */
  sendInput(paneId: string, text: string, keys: string[]): Promise<void>;
  /** Reads the pane's recent rendered text (trailboss `pane.read`, source `recent`) for composer verification. */
  readPaneRecent(paneId: string): Promise<string>;
  /** Injectable wait (defaults to real setTimeout) so tests run without real delays. */
  wait?: (ms: number) => Promise<void>;
}

export interface DispatchOutcome {
  code: number;
  error?: string;
}

/**
 * Composer clearing before any command text (delivery review finding 4 +
 * round 2 R4, round 3 multiline fix). Each round is `ctrl+e`
 * (cursorLineEnd — captures any suffix after the cursor), `ctrl+u`
 * (deleteToLineStart — empties the whole current line), `down`
 * (cursorDown — descends one line while any remain below; on the last
 * line omp's plain-down falls through to history-next, a no-op unless the
 * user is mid-history-browse, and any entry it pulls is itself cleared by
 * the next round), `backspace` (at column 0 joins the now-empty current
 * line into the line above — omp's deleteCharBackward crosses line
 * boundaries). One round consumes exactly one draft line FROM ANY CURSOR
 * POSITION, including lines below the cursor. The final `ctrl+e` +
 * `ctrl+u` clears the last line's residue. Every step is a no-op on an
 * empty composer, so over-sending is safe; 64 rounds bound any
 * hand-typed or pasted draft (longer drafts, or a deep history browse
 * interleaved with clearing, can retain content).
 */
export const CLEAR_ROUNDS = 64;
export const CLEAR_KEYS: string[] = [];
for (let round = 0; round < CLEAR_ROUNDS; round += 1) CLEAR_KEYS.push('ctrl+e', 'ctrl+u', 'down', 'backspace');
CLEAR_KEYS.push('ctrl+e', 'ctrl+u');

/**
 * Parses the pane's recent rendered text and returns the composer's
 * unsent residue, or null when the composer is VERIFIABLY empty
 * (rounds 5–6 review: neither a blank line nor an arbitrary `❯`
 * occurrence proves emptiness — drafts can contain both). The composer
 * prompt is the BOTTOM-MOST `❯` AT COLUMN 0: omp renders the composer's
 * continuation lines indented, so a user-typed `❯` inside draft content
 * never sits at column 0 and cannot pose as the prompt. If that line
 * has content after the prompt, it is residue. Otherwise the read is
 * accepted as empty ONLY when the remainder matches omp's status block
 * EXACTLY: an optional blank separator, then a contiguous non-blank run
 * of ≤8 lines whose first line carries the middot `·` separator, and
 * after that run ONLY blank lines to the end of the output — the
 * recognized status region must account for the entire remaining
 * output. Anything else (draft content, extra blocks, trailing
 * non-status content, no status block at all) is ambiguous and reported
 * as residue so the caller refuses dispatch. omp's borderless composer
 * (bottomBarGap: false) may place status rows DIRECTLY after editor
 * content with no blank separator, and draft continuations render with
 * a ≥2-space gutter — so a gutter-indented line inside the status
 * region is a surviving continuation, never a status row.
 */
export function composerResidue(paneText: string): string | null {
  const lines = paneText.split('\n');
  let promptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('❯')) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex === -1) return 'composer prompt not found in pane output';
  const afterPrompt = lines[promptIndex].slice(1).trim();
  if (afterPrompt.length > 0) return afterPrompt;
  let i = promptIndex + 1;
  if (i < lines.length && lines[i].trim().length === 0) i += 1;
  let statusLines = 0;
  while (i + statusLines < lines.length && lines[i + statusLines].trim().length > 0) statusLines += 1;
  if (statusLines === 0) return 'no recognizable status block after the composer prompt';
  if (statusLines > 8) return `unrecognized content after the composer prompt (${statusLines} consecutive lines)`;
  for (let j = i; j < i + statusLines; j += 1) {
    if (/^ {2,}/.test(lines[j])) return 'composer continuation above the status block';
  }
  if (!lines[i].includes('·')) return 'composer is followed by non-status content';
  for (let j = i + statusLines; j < lines.length; j += 1) {
    if (lines[j].trim().length > 0) return 'non-status content after the status block';
  }
  return null;
}

/** Dispatches `/<commandName>` (+ Enter) — or a prefill `/<commandName> ` with no keys — to the pane; NOTHING is sent unless the pane is a live, same-session registry-published omp instance. */
export async function dispatchSlashCommand(
  commandName: string,
  target: DispatchTarget,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  if (target.paneId === null || target.paneId.length === 0) {
    return { code: 3, error: 'palette-commands: invocation context names no pane; refusing to dispatch' };
  }
  if (target.session === null) {
    return {
      code: 4,
      error: 'palette-commands: cannot resolve the invoking trailboss session; refusing to dispatch',
    };
  }
  const entry = deps.entryFor(target.session, target.paneId);
  if (entry === null) {
    return {
      code: 4,
      error: `palette-commands: no instance registry entry for pane ${target.paneId} in session ${target.session}; refusing to dispatch`,
    };
  }
  if (entry.pane_id !== target.paneId) {
    return {
      code: 4,
      error: `palette-commands: registry entry for ${target.paneId} names pane ${String(entry.pane_id)}; refusing to dispatch`,
    };
  }
  if (!deps.isProcessAlive(entry.pid, entry.proc_start_ticks)) {
    return {
      code: 5,
      error: `palette-commands: stale registry entry for pane ${target.paneId} (pid ${entry.pid} is dead or a recycled pid); refusing to dispatch`,
    };
  }
  const command = (entry.commands ?? []).find((entry) => entry.name === commandName);
  if (command === undefined) {
    return {
      code: 9,
      error: `palette-commands: /${commandName} is not in the selected instance's inventory (published by another instance); refusing to dispatch`,
    };
  }
  // R7 (round 2): prefill mode comes from THIS instance's own command
  // entry — the fleet-wide union never overrides the selected command's
  // argument contract.
  const prefill = requiresArgument(command);
  try {
    // Clear any unsent draft first (finding 4 + R4): a keys-only
    // send_input that consumes draft lines from any cursor position, then
    // the command text into a composer whose draft (within the
    // CLEAR_ROUNDS bound) is gone.
    await deps.sendInput(target.paneId, '', CLEAR_KEYS);
    // Round-4 P2: a bounded clearing cannot PROVE the composer empty —
    // verify the rendered composer (trailboss pane.read) before any
    // command text. One retry absorbs a slow render; residue beyond the
    // CLEAR_ROUNDS bound (or an unreadable composer) refuses dispatch
    // instead of submitting merged input.
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let residue: string | null = 'unverified';
    for (let attempt = 0; attempt < 2 && residue !== null; attempt += 1) {
      await wait(attempt === 0 ? 300 : 500);
      residue = composerResidue(await deps.readPaneRecent(target.paneId));
    }
    if (residue !== null) {
      return {
        code: 10,
        error: `palette-commands: composer not verifiably empty for pane ${target.paneId} (residue: ${residue}); refusing dispatch`,
      };
    }
    await deps.sendInput(
      target.paneId,
      prefill ? `/${commandName} ` : `/${commandName}`,
      prefill ? [] : ['Enter'],
    );
  } catch (err) {
    return {
      code: 6,
      error: `palette-commands: sending to pane ${target.paneId} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { code: 0 };
}
