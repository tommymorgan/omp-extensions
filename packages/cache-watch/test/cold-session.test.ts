import { describe, expect, it } from 'bun:test';
import { FakePi, assistantMessage, fakeCtx, providerResponse } from './harness.ts';
import cacheWatch from '../src/index.ts';

describe('cold session', () => {
  it('does not alert at 55% rolling rate when no baseline is established', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    for (let i = 0; i < 4; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.55), ctx);
    }

    expect(pi.warnings.length).toBe(0);
  });
});
