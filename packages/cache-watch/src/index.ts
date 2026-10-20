import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { CacheWatchDetector, type FallbackEpisode } from './detector.ts';
import {
  bannerKey,
  fallbackBannerKey,
  formatBannerLines,
  formatFallbackBannerLines,
  type BannerState,
  type FgStyler,
} from './banner.ts';

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
 * payload for prefix fingerprinting; the handler returns nothing, so the
 * payload always passes through unchanged. Context observations and
 * Trailboss publications are read-only contributor candidates, not proof
 * that a contribution reached the outgoing provider prefix.
 *
 * Banners (plan Tasks 3.1 and 4.2): the detector raises/lowers banner state
 * through the sink, and it renders via `ctx.ui.setWidget` — a widget above
 * the editor, never a message in the request stream. Only interactive TUI
 * sessions of the agent the human is watching render it; headless modes
 * (`ctx.mode !== "tui"`) and subagent runtimes (`ctx.agent.kind === "sub"`)
 * skip rendering — their `setWidget` stubs are no-ops anyway (agent-session.ts
 * / runner.ts). The collapse banner and the fallback banner use separate
 * session-scoped widget keys (`bannerKey` / `fallbackBannerKey`) so a
 * simultaneous collapse alert and fallback episode both stay visible.
 */

/** The per-event context fields the banner render surface consumes. */
type SessionSurfaceCtx = Pick<ExtensionContext, 'sessionManager'> &
  Partial<Pick<ExtensionContext, 'mode' | 'ui' | 'agent'>>;

export default function cacheWatch(pi: ExtensionAPI): void {
  const detectors = new Map<string, CacheWatchDetector>();
  /** Latest event context per session; the banner renders on the session's own UI. */
  const surfaces = new Map<string, SessionSurfaceCtx>();

  const renderWidget = (
    sessionId: string,
    key: string,
    format: ((fg: FgStyler) => string[]) | null,
  ): void => {
    const ctx = surfaces.get(sessionId);
    if (!ctx?.ui || ctx.mode !== 'tui' || ctx.agent?.kind === 'sub') return;
    if (format === null) {
      ctx.ui.setWidget(key, undefined);
      return;
    }
    ctx.ui.setWidget(key, format(ctx.ui.theme.fg.bind(ctx.ui.theme)), {
      placement: 'aboveEditor',
    });
  };

  const detectorForSession = (sessionId: string): CacheWatchDetector => {
    let detector = detectors.get(sessionId);
    if (!detector) {
      detector = new CacheWatchDetector(sessionId, {
        warn: (message, context) => pi.logger.warn(message, context),
        debug: (message, context) => pi.logger.debug(message, context),
        banner: state =>
          renderWidget(sessionId, bannerKey(sessionId), state === null ? null : fg =>
            formatBannerLines(state, fg),
          ),
        fallbackBanner: episode =>
          renderWidget(sessionId, fallbackBannerKey(sessionId), episode === null ? null : fg =>
            formatFallbackBannerLines(episode, fg),
          ),
      });
      detectors.set(sessionId, detector);
    }
    return detector;
  };

  const detectorFor = (ctx: SessionSurfaceCtx): CacheWatchDetector => {
    const sessionId = ctx.sessionManager.getSessionId();
    surfaces.set(sessionId, ctx);
    return detectorForSession(sessionId);
  };

  const unsubscribePublication = pi.events.on('trailboss:context:publish', data => {
    if (
      !data || typeof data !== 'object' || Array.isArray(data) ||
      !('sessionId' in data) || typeof data.sessionId !== 'string' || data.sessionId.length === 0 ||
      !('source' in data) || typeof data.source !== 'string' || data.source.length === 0 ||
      !('message' in data) || !data.message || typeof data.message !== 'object' ||
      Array.isArray(data.message) || !('content' in data.message) ||
      typeof data.message.content !== 'string'
    ) return;
    let version: string | undefined;
    if ('details' in data.message && data.message.details !== undefined) {
      const details = data.message.details;
      if (!details || typeof details !== 'object' || Array.isArray(details)) return;
      if ('version' in details && details.version !== undefined) {
        if (typeof details.version !== 'string') return;
        version = details.version;
      }
    }
    // A publication may precede the first context event. Its session ID owns
    // the detector, but only an actual extension context can supply its UI.
    detectorForSession(data.sessionId).recordPublication(data.source, data.message.content, version);
  });
  pi.on('session_shutdown', () => { unsubscribePublication(); });

  pi.on('after_provider_response', () => {});

  pi.on('before_provider_request', (event, ctx) => {
    detectorFor(ctx).recordRequestPayload(event.payload);
  });

  pi.on('context', (event, ctx) => {
    detectorFor(ctx).recordContextMessages(event.messages);
  });

  pi.on('assistant_message', (event, ctx) => {
    const detector = detectorFor(ctx);
    const usage = event.message.usage;
    detector.recordResponse({
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    });
    // Serving model (AssistantMessage.model, pi-ai 18.10.4 types.d.ts): drives
    // the fallback episode lifecycle. Fixtures without a model are skipped.
    const model = event.message.model;
    if (typeof model === 'string' && model.length > 0) detector.recordServingModel(model);
  });

  pi.on('session_compact', (_event, ctx) => detectorFor(ctx).benignReset('session_compact'));
  pi.on('auto_compaction_start', (_event, ctx) => detectorFor(ctx).benignReset('auto_compaction_start'));
  pi.on('auto_compaction_end', (_event, ctx) => detectorFor(ctx).benignReset('auto_compaction_end'));
  pi.on('session_switch', (_event, ctx) => detectorFor(ctx).benignReset('session_switch'));
  // retry_fallback_* is NOT benign (ADR 0004 / CONTEXT.md): the applied event
  // opens a fallback episode with its single warning; succeeded only annotates.
  pi.on('retry_fallback_applied', (event, ctx) =>
    detectorFor(ctx).recordFallbackApplied(event.from, event.to, event.reason),
  );
  pi.on('retry_fallback_succeeded', (event, ctx) =>
    detectorFor(ctx).recordFallbackSucceeded(event.model),
  );
}
