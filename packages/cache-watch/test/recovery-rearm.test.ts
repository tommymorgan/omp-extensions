import { describe, expect, it } from 'bun:test';
import { FakePi, assistantMessage, fakeCtx, providerResponse } from './harness.ts';
import cacheWatch from '../src/index.ts';

describe('recovery re-arms detection', () => {
  it('logs a second collapse warning after a recovered session collapses again', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    for (let i = 0; i < 20; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.94), ctx);
    }

    // First collapse: warning 1.
    for (let i = 0; i < 8; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.58), ctx);
    }
    expect(pi.warnings.length).toBe(1);

    // Recovery above 85% for 10 responses.
    for (let i = 0; i < 10; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.85), ctx);
    }

    // Second collapse: warning 2.
    for (let i = 0; i < 8; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.58), ctx);
    }
    expect(pi.warnings.length).toBe(2);
  });
});
