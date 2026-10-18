import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessageWithModel,
  benignEvent,
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

  it('treats a repeated applied event for the same target as the same episode', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);
    // Retries re-emit applied for the same hop; still one warning.
    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);
    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);
    pi.emit(assistantMessageWithModel(0.94, 'qwen3-coder-30b'), ctx);
    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);

    expect(pi.warnings.length).toBe(1);
  });

  it('opens a new episode with its own warning for a different fallback target', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);
    // A chained hop to a cheaper model while the first is active.
    pi.emit(retryFallbackApplied('qwen3-coder-30b', 'llama-3-8b', 'overloaded'), ctx);

    expect(pi.warnings.length).toBe(2);
    expect(pi.warnings[1]!.message).toContain('qwen3-coder-30b');
    expect(pi.warnings[1]!.message).toContain('llama-3-8b');
    expect(pi.warnings[1]!.message).toContain('overloaded');
  });

  it('re-warns as a fresh episode when a compaction cleared the active one', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);
    expect(pi.warnings.length).toBe(1);
    // benignReset (ADR 0004) clears episode state like other rolling state.
    pi.emit(benignEvent('session_compact'), ctx);
    // The fallback still serving does not open a new episode by itself...
    pi.emit(assistantMessageWithModel(0.94, 'qwen3-coder-30b'), ctx);
    expect(pi.warnings.length).toBe(1);
    // ...but a later applied event for the same hop warns again.
    pi.emit(retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'quota'), ctx);
    expect(pi.warnings.length).toBe(2);
  });
  it('re-arms fallback alerting after the configured model serves again', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    // Given: a session with an active fallback episode on "qwen3-coder-30b".
    for (let i = 0; i < 30; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessageWithModel(0.94, 'gpt-5.2'), ctx);
    }
    pi.emit(
      retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'rate limited: insufficient quota'),
      ctx,
    );
    pi.emit(assistantMessageWithModel(0.94, 'qwen3-coder-30b'), ctx);
    expect(pi.warnings.length).toBe(1);

    // When: an assistant_message reports the configured model "gpt-5.2"
    // serving again...
    pi.emit(providerResponse(), ctx);
    pi.emit(assistantMessageWithModel(0.94, 'gpt-5.2'), ctx);

    // ...and a later retry_fallback_applied again reports gpt-5.2 ->
    // qwen3-coder-30b.
    pi.emit(
      retryFallbackApplied('gpt-5.2', 'qwen3-coder-30b', 'rate limited: insufficient quota'),
      ctx,
    );

    // Then: a new warning is logged.
    expect(pi.warnings.length).toBe(2);
    expect(pi.warnings[1]!.message).toContain('gpt-5.2');
    expect(pi.warnings[1]!.message).toContain('qwen3-coder-30b');
  });
});
