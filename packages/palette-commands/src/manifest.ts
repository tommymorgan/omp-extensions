import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * palette-commands manifest writer (plan Task 1.1; generalized in Task 2.1):
 * emits the trailboss plugin manifest for plugin id `omp` with ONE action
 * per unique published command — the aggregated union of live instances'
 * inventories (Task 2.1 superseded the static restart-only manifest). Every
 * action shares the same bridge argv: trailboss spawns it with
 * `HERDR_PLUGIN_ACTION_ID` carrying the action id, and the bridge inverts
 * the id → command name via `action-map.json`. Trailboss renders palette
 * titles verbatim, so the `omp: ` prefix namespaces the actions; the bridge
 * path must be absolute at generation time. Manifests are replaced
 * atomically (write to a temp name, rename over the target).
 */

export const PLUGIN_ID = 'omp';
export const MANIFEST_FILENAME = 'trailboss-plugin.toml';
export const MANIFEST_VERSION = '0.1.0';

/** One palette action: the sanitized command id, its verbatim title, and an optional description. */
export interface ManifestAction {
  id: string;
  title: string;
  description?: string;
  argument_input?: { kind: 'raw_tail' };
  argument_hint?: string;
}

export interface ManifestOptions {
  actions: ManifestAction[];
  /** The bridge argv trailboss spawns for every action. */
  bridgeArgv: string[];
}

/** Renders the `trailboss-plugin.toml` content. */
export function renderPluginManifest({ actions, bridgeArgv }: ManifestOptions): string {
  const lines = [
    `id = ${tomlString(PLUGIN_ID)}`,
    `name = ${tomlString('OMP')}`,
    `version = ${tomlString(MANIFEST_VERSION)}`,
    // Matches the host the bridge is verified against; the trailboss runtime
    // rejects plugin manifests that omit it (Task 1.1 boundary evidence).
    `min_herdr_version = ${tomlString('0.9.0')}`,
  ];
  for (const action of actions) {
    lines.push('', '[[actions]]', `id = ${tomlString(action.id)}`, `title = ${tomlString(action.title)}`);
    if (action.description !== undefined && action.description.length > 0) {
      lines.push(`description = ${tomlString(action.description)}`);
    }
    if (action.argument_input !== undefined) {
      lines.push('argument_input = { kind = "raw_tail" }');
      if (action.argument_hint !== undefined) {
        lines.push(`argument_hint = ${tomlString(action.argument_hint)}`);
      }
    }
    lines.push(`command = [${bridgeArgv.map(tomlString).join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the manifest into the plugin dir, replacing any previous manifest atomically. */
export function writeManifestFile(pluginDir: string, options: ManifestOptions): string {
  mkdirSync(pluginDir, { recursive: true });
  const manifestPath = join(pluginDir, MANIFEST_FILENAME);
  const stagingPath = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(stagingPath, renderPluginManifest(options));
  renameSync(stagingPath, manifestPath);
  return manifestPath;
}

/** JSON string escaping is a valid TOML basic string. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}
