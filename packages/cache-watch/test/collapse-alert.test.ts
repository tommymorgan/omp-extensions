import { describe, expect, it } from 'bun:test';
import { FakePi, assistantMessage, fakeCtx, providerResponse } from './harness.ts';
import cacheWatch from '../src/index.ts';

describe('cache collapse alert', () => {
  it('logs exactly one collapse warning naming session, baseline, current rate, and both thresholds', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    // 20 responses at 94% establish the frozen baseline.
    for (let i = 0; i < 20; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.94), ctx);
    }

    // Rolling 5-response rate falls below 70% and >15 points below 94%.
    // Window lag delays recognition: the first three low responses still
    // evaluate at 0.868/0.796/0.724 (>= floor), so belowStreak reaches 3 on
    // the 6th low response — the warning lands there, not on the 3rd.
    for (let i = 0; i < 8; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.58), ctx);
    }

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('cache-watch-demo');
    expect(warning?.message).toContain('94');
    expect(warning?.message).toContain('58');
    expect(warning?.message).toContain('70');
    expect(warning?.message).toContain('15');
  });
});
