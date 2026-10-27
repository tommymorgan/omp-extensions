import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * palette-commands dispatch map (plan Task 2.1 + delivery review finding 8
 * + round 2 R3/R7): palette action ids are sanitized command names
 * (`[A-Za-z0-9:._-]`, others → `-`, ≤120 chars) with a content-hash suffix
 * baked in, so `model set` dispatches as a stable id unique to that name.
 * The aggregator publishes ONE immutable generation — `dispatch.json` in
 * the plugin dir, `{actions: {<action_id>: {name}}}` — atomically BEFORE
 * the `trailboss-plugin.toml` manifest that names those ids, so a reader
 * can never see a manifest action without its dispatch metadata, and a
 * vanished command's id resolves as unknown rather than to a different
 * command. The bridge — spawned by trailboss with `HERDR_PLUGIN_ROOT`
 * pointing there — resolves `HERDR_PLUGIN_ACTION_ID` through this map.
 * A missing file, a corrupt shape, or an unknown id all fail closed:
 * nothing is typed into any pane.
 */

export const DISPATCH_MAP_FILENAME = 'dispatch.json';

export interface DispatchAction {
  /** The original command name to dispatch (`/<name>`); never the sanitized id. */
  name: string;
}

/**
 * Reads the id→action dispatch map; NULL on a failed read
 * (missing/unparseable/wrong-shape file) so the bridge fails closed. The
 * result is PROTOTYPE-FREE and holds only own, well-shaped entries:
 * sanitized ids come from arbitrary command names, so
 * `__proto__`/`constructor`/`toString` must resolve as ordinary keys.
 */
export function readDispatchMap(pluginDir: string | null): Record<string, DispatchAction> | null {
  if (pluginDir === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(pluginDir, DISPATCH_MAP_FILENAME), 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const actions = (parsed as Record<string, unknown>).actions;
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) return null;
  const map: Record<string, DispatchAction> = Object.create(null);
  for (const [actionId, action] of Object.entries(actions)) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) continue;
    const record = action as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0) continue;
    map[actionId] = { name: record.name };
  }
  return map;
}
