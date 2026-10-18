import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessageWithModel,
  fakeCtx,
  fakeUi,
  providerResponse,
  retryFallbackApplied,
} from './harness.ts';
import cacheWatch from '../src/index.ts';

/**
 * Plan Task 4.2 — fallback banner via the shared banner surface. The fallback
 * episode (ADR 0004) drives its own widget: raised when an episode opens,
 * removed when the configured model serves again. Separate widget key from
 * the collapse banner so both alerts can coexist.
 */
const FALLBACK_KEY = 'cache-watch-fallback:cache-watch-demo';
const RED = '\x1b[31m';

describe('fallback banner', () => {
  it('shows a red banner naming both models in the affected TUI session only', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ui = fakeUi();
    const ctx = fakeCtx('cache-watch-demo', { mode: 'tui', ui, agent: { kind: 'main' } });
    const otherUi = fakeUi();
    const otherCtx = fakeCtx('quiet-session', { mode: 'tui', ui: otherUi, agent: { kind: 'main' } });

    // Given: session "cache-watch-demo" is running in a TUI with an active
    // fallback episode from "gpt-5.2" to "qwen3-coder-30b".
    pi.emit(
      retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'rate limited: insufficient quota'),
      ctx,
    );

    // Then: a red banner appears naming both models.
    const banner = ui.widgets.get(FALLBACK_KEY);
    expect(banner).toBeDefined();
    const text = banner!.lines.join('\n');
    expect(text).toContain('gpt-5.2');
    expect(text).toContain('qwen3-coder-30b');
    expect(banner!.lines.every(line => line.includes(RED))).toBe(true);
    expect(banner!.placement).toBe('aboveEditor');

    // And: a TUI session without an active fallback episode shows no banner.
    pi.emit(providerResponse(), otherCtx);
    pi.emit(assistantMessageWithModel(0.94, 'gpt-5.2'), otherCtx);
    expect(otherUi.widgets.size).toBe(0);

    // Headless sessions render no banner while the warning still logs (same
    // guards as the collapse banner).
    const headlessUi = fakeUi();
    const headlessCtx = fakeCtx('headless-demo', { mode: 'print', ui: headlessUi, agent: { kind: 'main' } });
    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), headlessCtx);
    expect(headlessUi.widgets.size).toBe(0);
    expect(pi.warnings.length).toBe(2);
  });
});
