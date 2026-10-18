import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessage,
  beforeProviderRequest,
  benignEvent,
  fakeCtx,
  providerResponse,
  type RequestMessageLike,
} from './harness.ts';
import cacheWatch from '../src/index.ts';

const PREFIX_LENGTH = 10;
const HEALTHY_RATE = 0.94;
const COLLAPSED_RATE = 0.58;
const HEALTHY_RESPONSES = 37;
const TOTAL_REQUESTS = 43;

/** The shared prefix fixture: ten stable messages. */
function prefixMessages(): RequestMessageLike[] {
  return Array.from({ length: PREFIX_LENGTH }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
}

/** Copy of the prefix whose message at `index` differs. */
function divergedAt(index: number): RequestMessageLike[] {
  return prefixMessages().map((message, i) =>
    i === index ? { ...message, content: `message ${i} (diverted)` } : message,
  );
}

/** Drives one request/response cycle; the collapse window lags, so the warning
 * lands on the 6th collapsed response — response 43 here (38–43 are low). */
function driveSession(pi: FakePi, messageFor: (request: number) => RequestMessageLike[]): void {
  const ctx = fakeCtx('cache-watch-demo');
  for (let request = 1; request <= TOTAL_REQUESTS; request++) {
    pi.emit(beforeProviderRequest(messageFor(request)), ctx);
    pi.emit(providerResponse(), ctx);
    pi.emit(assistantMessage(request <= HEALTHY_RESPONSES ? HEALTHY_RATE : COLLAPSED_RATE), ctx);
  }
}

describe('divergence point attribution', () => {
  it('names the diverging request and message index in the warning detail', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);

    // Requests 1–42 share the identical prefix; request 43 first differs at index 7.
    driveSession(pi, request => (request === TOTAL_REQUESTS ? divergedAt(7) : prefixMessages()));

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('43 @ message index 7');
    expect(warning?.context?.divergence).toEqual({ request: 43, messageIndex: 7 });
  });

  it('reports no divergence point when no request history exists', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    for (let i = 0; i < 20; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    for (let i = 0; i < 8; i++) {
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
    }

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).not.toContain('message index');
    expect(warning?.context?.divergence).toBeNull();
  });

  it('reports no divergence point on the first request or while prefixes stay identical', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);

    driveSession(pi, () => prefixMessages());

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).not.toContain('message index');
    expect(warning?.context?.divergence).toBeNull();
  });
});

describe('divergence attribution review fixes', () => {
  it('does not attribute append-only growth as divergence', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);

    // Normal every-turn traffic shape: the shared prefix stays intact while
    // each turn appends messages. Appends preserve the prompt-cache prefix,
    // so no divergence may be recorded.
    driveSession(pi, request => [
      ...prefixMessages(),
      ...Array.from({ length: request - 1 }, (_, k) => ({
        role: 'user',
        content: `append ${k + 1}`,
      })),
    ]);

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).not.toContain('message index');
    expect(warning?.context?.divergence).toBeNull();
  });

  it('does not carry compaction-caused divergence into a later genuine warning', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    // Requests 1-20: identical healthy prefix; baseline freezes.
    for (let i = 0; i < 20; i++) {
      pi.emit(beforeProviderRequest(prefixMessages()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    // Compaction rewrites the message list for a benign reason.
    pi.emit(benignEvent('session_compact'), ctx);
    // Post-compaction: rewritten prefix, healthy long enough to re-arm...
    const rewritten = (): RequestMessageLike[] =>
      Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `rewritten ${i}` }));
    for (let i = 0; i < 20; i++) {
      pi.emit(beforeProviderRequest(rewritten()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    // ...then a genuine collapse with the prefix intact.
    for (let i = 0; i < 8; i++) {
      pi.emit(beforeProviderRequest(rewritten()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
    }

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).not.toContain('message index');
    expect(warning?.context?.divergence).toBeNull();
  });

  it('passes the provider request payload through untouched', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');
    const payload = { model: 'test-model', max_tokens: 1024, messages: prefixMessages() };
    const snapshot = structuredClone(payload);

    pi.emit({ type: 'before_provider_request', payload }, ctx);

    expect(payload).toEqual(snapshot);
  });
});
