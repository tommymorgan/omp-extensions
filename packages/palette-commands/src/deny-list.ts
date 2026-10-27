import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * palette-commands deny-list (plan Task 4.1, ADR 0005 §4): command names that
 * must NEVER publish as palette actions. Enforced at aggregation time — the
 * extension still publishes full inventories (deny-listing there would let a
 * stale deny-list drift between instances), and the aggregator drops denied
 * names from the manifest, action-map, and prefill marks alike.
 *
 * Sources: the compiled default below, plus user additions in
 * `<stateDir>/deny-list.txt` (one command name per line; `#` comments and
 * blank lines ignored). An absent or unreadable user file is normal — the
 * defaults still apply.
 */

/** Compiled defaults: actions that would end the operator's session or destroy work in one keystroke. */
export const DEFAULT_DENY_LIST: ReadonlySet<string> = new Set(['quit', 'delete']);

export const DENY_LIST_FILENAME = 'deny-list.txt';

/** The effective deny-list for a state dir: defaults plus user additions. */
export function readDenyList(stateDir: string): Set<string> {
  const denied = new Set<string>(DEFAULT_DENY_LIST);
  const userPath = join(stateDir, DENY_LIST_FILENAME);
  if (existsSync(userPath)) {
    try {
      for (const line of readFileSync(userPath, 'utf8').split('\n')) {
        const name = line.trim();
        if (name.length === 0 || name.startsWith('#')) continue;
        denied.add(name);
      }
    } catch {
      // unreadable user file: defaults still apply
    }
  }
  return denied;
}
