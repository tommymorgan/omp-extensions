import { pct, type CollapseCause, type FallbackEpisode } from './detector.ts';

/**
 * TUI banner surface (plan Slices 3 and 4, ADR 0002): the render
 * contribution for an active collapse alert and for an active fallback
 * episode. Widgets above the editor — never messages inserted into the
 * request stream, so the banners cannot perturb the cache they watch.
 */

/** Machine-readable state of an active collapse alert, consumed by the render surface. */
export interface BannerState {
  sessionId: string;
  baseline: number;
  rate: number;
  cause: CollapseCause;
}

/**
 * Widget key for a session's banner. One TUI process can host extension
 * runtimes for several sessions (subagents), so the key is session-scoped to
 * keep banners from clobbering each other.
 */
export function bannerKey(sessionId: string): string {
  return `cache-watch-banner:${sessionId}`;
}

/**
 * Widget key for a session's fallback banner. Deliberately its own key, not
 * the collapse banner's: a cache collapse and a fallback episode can be
 * simultaneous (a fallback changes response shape enough to collapse the
 * cache-read rate), and sharing one key would let either alert clobber the
 * other. Both widgets render aboveEditor independently.
 */
export function fallbackBannerKey(sessionId: string): string {
  return `cache-watch-fallback:${sessionId}`;
}

/**
 * The fallback banner's lines (plan Task 4.2): from-model → to-model while a
 * fallback episode is active, with the episode's reason when the applied
 * event carried one. Same red styling as the collapse banner.
 */
export function formatFallbackBannerLines(episode: FallbackEpisode, fg: FgStyler): string[] {
  const lines = [
    fg('error', `⚠ cache-watch: model fallback "${episode.from}" → "${episode.to}"`),
  ];
  if (episode.reason !== undefined) {
    lines.push(fg('error', `  reason: ${episode.reason}`));
  }
  return lines;
}

/** Foreground styler subset of the TUI theme API the banner needs. */
export type FgStyler = (color: 'error' | 'muted', text: string) => string;

/**
 * The banner's two lines: the drop (frozen baseline → rolling rate at alert
 * time), then the Task 2.2 attribution line (injection source / compaction /
 * none recorded). Thresholds live in detector.ts; formatting reuses its pct().
 */
export function formatBannerLines(state: BannerState, fg: FgStyler): string[] {
  const cause =
    state.cause.kind === 'injection'
      ? `injection "${state.cause.source}"`
      : state.cause.kind === 'compaction'
        ? `compaction (${state.cause.benignKind})`
        : 'none recorded';
  return [
    fg('error', `⚠ cache-watch: prompt-cache collapse ${pct(state.baseline)} → ${pct(state.rate)}`),
    fg('error', `  cause: ${cause}`),
  ];
}
