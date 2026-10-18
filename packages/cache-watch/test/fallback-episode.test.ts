import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessageWithModel,
  fakeCtx,
  providerResponse,
  retryFallbackApplied,
  retryFallbackSucceeded,
} from './harness.ts';
import cacheWatch from '../src/index.ts';

describe('model fallback episode', () => {
  it('logs one warning per fallback episode and stays quiet while the fallback keeps serving', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    // Given: the session's first 30 requests were served by configured model "gpt-5.2".
    for (let i = 0; i < 30; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessageWithModel(0.94, 'gpt-5.2'), ctx);
    }
    expect(pi.warnings.length).toBe(0);

    // When: retry_fallback_applied reports from "gpt-5.2" to "qwen3-coder-30b"
    // with reason "rate limited: insufficient quota".
    pi.emit(
      retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'rate limited: insufficient quota'),
      ctx,
    );

    // Then: exactly one warning naming the session, from, to, and the reason.
    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0]!;
    expect(warning.message).toContain('cache-watch-demo');
    expect(warning.message).toContain('gpt-5.2');
    expect(warning.message).toContain('qwen3-coder-30b');
    expect(warning.message).toContain('rate limited: insufficient quota');
    expect(warning.context).toMatchObject({
      sessionId: 'cache-watch-demo',
      from: 'gpt-5.2',
      to: 'qwen3-coder-30b',
      reason: 'rate limited: insufficient quota',
    });

    // And: no further warning while requests continue succeeding on the
    // fallback model.
    for (let i = 0; i < 6; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessageWithModel(0.94, 'qwen3-coder-30b'), ctx);
      pi.emit(retryFallbackSucceeded('qwen3-coder-30b'), ctx);
    }
    expect(pi.warnings.length).toBe(1);
  });
});
