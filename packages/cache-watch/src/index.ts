import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { CacheWatchDetector } from './detector.ts';
import { bannerKey, formatBannerLines, type BannerState } from './banner.ts';

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
 * nothing, so the payload always passes through unchanged. The `context`
 * event supplies the per-call assembled message list for the read-only
 * injection ledger (ADR 0002: recorded, never mutated or suppressed).
 *
 * Banner (plan Task 3.1): the detector raises/lowers banner state through the
 * sink, and it renders via `ctx.ui.setWidget` — a widget above the editor,
 * never a message in the request stream. Only interactive TUI sessions of the
 * agent the human is watching render it; headless modes (`ctx.mode !== "tui"`)
 * and subagent runtimes (`ctx.agent.kind === "sub"`) skip rendering — their
 * `setWidget` stubs are no-ops anyway (agent-session.ts / runner.ts).
 */

/** The per-event context fields the banner render surface consumes. */
type SessionSurfaceCtx = Pick<ExtensionContext, 'sessionManager'> &
  Partial<Pick<ExtensionContext, 'mode' | 'ui' | 'agent'>>;

export default function cacheWatch(pi: ExtensionAPI): void {
  const detectors = new Map<string, CacheWatchDetector>();
  /** Latest event context per session; the banner renders on the session's own UI. */
  const surfaces = new Map<string, SessionSurfaceCtx>();

  const renderBanner = (sessionId: string, state: BannerState | null): void => {
    const ctx = surfaces.get(sessionId);
    if (!ctx?.ui || ctx.mode !== 'tui' || ctx.agent?.kind === 'sub') return;
    const key = bannerKey(sessionId);
    if (state === null) {
      ctx.ui.setWidget(key, undefined);
      return;
    }
    ctx.ui.setWidget(key, formatBannerLines(state, ctx.ui.theme.fg.bind(ctx.ui.theme)), {
      placement: 'aboveEditor',
    });
  };

  const detectorFor = (ctx: SessionSurfaceCtx): CacheWatchDetector => {
    const sessionId = ctx.sessionManager.getSessionId();
    surfaces.set(sessionId, ctx);
    let detector = detectors.get(sessionId);
    if (!detector) {
      detector = new CacheWatchDetector(sessionId, {
        warn: (message, context) => pi.logger.warn(message, context),
        debug: (message, context) => pi.logger.debug(message, context),
        banner: state => renderBanner(sessionId, state),
      });
      detectors.set(sessionId, detector);
    }
    return detector;
  };

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
