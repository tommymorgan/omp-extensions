import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { CacheWatchDetector } from './detector.ts';

/**
 * cache-watch: read-only prompt-cache collapse watcher. ADR 0002: registers
 * read-only handlers only; never mutates request payloads or context.
 *
 * In pi-coding-agent 18.10.4, `after_provider_response` carries only
 * ProviderResponseMetadata (status/headers/requestId/metadata) — no usage
 * tokens. Per-response usage arrives on the finalized `assistant_message`
 * event (`message.usage`: input/cacheRead/cacheWrite), so usage capture reads
 * it there; `after_provider_response` stays registered as the response
 * boundary marker. `before_provider_request` supplies the provider wire
 * payload (`payload.messages`) for prefix fingerprinting; the handler returns
 * nothing, so the payload always passes through unchanged.
 */
export default function cacheWatch(pi: ExtensionAPI): void {
  const detectors = new Map<string, CacheWatchDetector>();

  const detectorFor = (ctx: Pick<ExtensionContext, 'sessionManager'>): CacheWatchDetector => {
    const sessionId = ctx.sessionManager.getSessionId();
    let detector = detectors.get(sessionId);
    if (!detector) {
      detector = new CacheWatchDetector(sessionId, pi.logger);
      detectors.set(sessionId, detector);
    }
    return detector;
  };

  pi.on('after_provider_response', () => {});

  pi.on('before_provider_request', (event, ctx) => {
    detectorFor(ctx).recordRequestPayload(event.payload);
  });

  pi.on('assistant_message', (event, ctx) => {
    const usage = event.message.usage;
    detectorFor(ctx).recordResponse({
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    });
  });

  pi.on('session_compact', (_event, ctx) => detectorFor(ctx).benignReset('session_compact'));
  pi.on('auto_compaction_start', (_event, ctx) => detectorFor(ctx).benignReset('auto_compaction_start'));
  pi.on('auto_compaction_end', (_event, ctx) => detectorFor(ctx).benignReset('auto_compaction_end'));
  pi.on('session_switch', (_event, ctx) => detectorFor(ctx).benignReset('session_switch'));
  pi.on('retry_fallback_applied', (_event, ctx) => detectorFor(ctx).benignReset('retry_fallback_applied'));
}
