import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessage,
  beforeProviderRequest,
  contextEvent,
  fakeCtx,
  fakeUi,
  injectedContextMessage,
  providerResponse,
  type ContextMessageLike,
  type FakeCtx,
  type RequestMessageLike,
} from './harness.ts';
import cacheWatch from '../src/index.ts';

/**
 * Plan Task 3.1, scenario 1 — "Collapse shows a red banner in the affected
 * session only": a TUI session with an active collapse alert naming a
 * 94%-to-58% drop caused by source "kizn-guidance" shows a red banner with
 * the drop and the source; a TUI session without an active alert shows none.
 */
const PREFIX_LENGTH = 10;
const HEALTHY_RATE = 0.94;
const COLLAPSED_RATE = 0.58;
const HEALTHY_RESPONSES = 37;
const TOTAL_REQUESTS = 43;
const BANNER_KEY = 'cache-watch-banner:cache-watch-demo';
const RED = '\x1b[31m';

/** The shared prefix fixture: ten stable messages. */
function prefixMessages(): RequestMessageLike[] {
  return Array.from({ length: PREFIX_LENGTH }, (_, i) => ({
    role: 'user',
    content: `message ${i}`,
  }));
}

/** Copy of the prefix whose message at `index` differs. */
function divergedAt(index: number): RequestMessageLike[] {
  return prefixMessages().map((message, i) =>
    i === index ? { ...message, content: `message ${i} (diverted)` } : message,
  );
}

/** Stable per-call context list; `sources` adds injected custom messages. */
function contextMessages(...sources: string[]): ContextMessageLike[] {
  return [
    { role: 'user', content: 'turn' },
    ...sources.map(source => injectedContextMessage(source)),
  ];
}

/**
 * Drives one request/response cycle per request; the collapse alert lands on
 * response 43 (38–43 are collapsed) with the divergence and the
 * "kizn-guidance" injection both at request 43.
 */
function driveCollapsingSession(pi: FakePi, ctx: FakeCtx): void {
  for (let request = 1; request <= TOTAL_REQUESTS; request++) {
    const collapsed = request > HEALTHY_RESPONSES;
    pi.emit(
      contextEvent(request === TOTAL_REQUESTS ? contextMessages('kizn-guidance') : contextMessages()),
      ctx,
    );
    pi.emit(beforeProviderRequest(request === TOTAL_REQUESTS ? divergedAt(7) : prefixMessages()), ctx);
    pi.emit(providerResponse(), ctx);
    pi.emit(assistantMessage(collapsed ? COLLAPSED_RATE : HEALTHY_RATE), ctx);
  }
}

describe('collapse banner render', () => {
  it('shows a red banner with the drop and source in the affected TUI session only', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ui = fakeUi();
    const ctx = fakeCtx('cache-watch-demo', { mode: 'tui', ui, agent: { kind: 'main' } });
    const otherUi = fakeUi();
    const otherCtx = fakeCtx('quiet-session', { mode: 'tui', ui: otherUi, agent: { kind: 'main' } });

    driveCollapsingSession(pi, ctx);

    const banner = ui.widgets.get(BANNER_KEY);
    expect(banner).toBeDefined();
    const text = banner!.lines.join('\n');
    expect(text).toContain('94%');
    expect(text).toContain('58%');
    expect(text).toContain('kizn-guidance');
    expect(banner!.lines.every(line => line.includes(RED))).toBe(true);
    expect(banner!.placement).toBe('aboveEditor');
    expect(ui.widgets.size).toBe(1);

    // A different TUI session without an active alert shows no banner.
    for (let response = 1; response <= 25; response++) {
      pi.emit(assistantMessage(HEALTHY_RATE), otherCtx);
    }
    expect(otherUi.widgets.size).toBe(0);
  });

  it('renders no banner in headless sessions while the warning still logs', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ui = fakeUi();
    const ctx = fakeCtx('headless-demo', { mode: 'print', ui, agent: { kind: 'main' } });

    driveCollapsingSession(pi, ctx);

    expect(ui.widgets.size).toBe(0);
    expect(pi.warnings.length).toBe(1);
  });
});
