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

    // Rolling 5-response rate falls below 70% and >15 points below 94% and
    // stays there for 5 consecutive evaluations (8 low responses: 3 fill the
    // window, then evaluations 1-5 trip the detector repeatedly).
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
