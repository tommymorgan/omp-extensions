import { describe, expect, it } from 'bun:test';
import { FakePi, assistantMessage, benignEvent, fakeCtx, providerResponse } from './harness.ts';
import cacheWatch from '../src/index.ts';

describe('benign compaction reset', () => {
  it('does not alert when a collapse follows a session_compact and then recovers', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    for (let i = 0; i < 20; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.94), ctx);
    }

    pi.emit(benignEvent('session_compact'), ctx);

    // Deep collapse: enough low responses that, without benign suppression,
    // the 3-consecutive-evaluation rule would fire.
    for (let i = 0; i < 7; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.58), ctx);
    }

    // Recovery above 85%.
    for (let i = 0; i < 6; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(0.85), ctx);
    }

    expect(pi.warnings.length).toBe(0);
    expect(pi.debugs.some((d) => d.message.includes('benign'))).toBe(true);
  });
});
