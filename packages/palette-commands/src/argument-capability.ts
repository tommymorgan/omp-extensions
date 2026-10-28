import { sessionFromSocketPath } from './registry.ts';
import { sessionRequest } from './session-socket.ts';

export const ARGUMENT_CAPABILITY = 'plugin_action_arguments_v1';

/** Capability is scoped to this exact session socket and current Core boot, never a version cache. */
export async function readArgumentCapability(
  socketPath: string,
  expectedSession?: string,
): Promise<{ bootId: string } | null> {
  const session = sessionFromSocketPath(socketPath);
  if (session === null || (expectedSession !== undefined && session !== expectedSession)) return null;
  try {
    const result = await sessionRequest<unknown>(socketPath, 'ui.command.list', {});
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
    if (!('type' in result) || result.type !== 'ui_command_list') return null;
    if (!('boot_id' in result) || typeof result.boot_id !== 'string' || result.boot_id.length === 0) return null;
    if (!('capabilities' in result) || !Array.isArray(result.capabilities)) return null;
    if (!result.capabilities.every((capability) => typeof capability === 'string')) return null;
    if (!result.capabilities.includes(ARGUMENT_CAPABILITY)) return null;
    if (!('commands' in result) || !Array.isArray(result.commands)) return null;
    return { bootId: result.boot_id };
  } catch {
    return null;
  }
}
