import { pct, type CollapseCause } from './detector.ts';

/**
 * TUI banner surface (plan Slice 3, ADR 0002): the render contribution for an
 * active collapse alert. A widget above the editor — never a message inserted
 * into the request stream, so the banner cannot perturb the cache it watches.
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
