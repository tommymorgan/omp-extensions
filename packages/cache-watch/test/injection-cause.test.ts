import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessage,
  beforeProviderRequest,
  benignEvent,
  contextEvent,
  fakeCtx,
  injectedContextMessage,
  providerResponse,
  type ContextMessageLike,
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

/** Stable per-call context list; `sources` adds injected custom messages. */
function contextMessages(...sources: string[]): ContextMessageLike[] {
  return [
    { role: 'user', content: 'turn' },
    ...sources.map(source => injectedContextMessage(source)),
  ];
}

/**
 * Drives one request/response cycle with the context event that precedes each
 * provider call; the warning lands on response 43 (38–43 are collapsed).
 */
function driveSession(
  pi: FakePi,
  messageFor: (request: number) => RequestMessageLike[],
  contextFor: (request: number) => ContextMessageLike[] = () => contextMessages(),
): void {
  const ctx = fakeCtx('cache-watch-demo');
  for (let request = 1; request <= TOTAL_REQUESTS; request++) {
    pi.emit(contextEvent(contextFor(request)), ctx);
    pi.emit(beforeProviderRequest(messageFor(request)), ctx);
    pi.emit(providerResponse(), ctx);
    pi.emit(assistantMessage(request <= HEALTHY_RESPONSES ? HEALTHY_RATE : COLLAPSED_RATE), ctx);
  }
}

describe('injection correlation and cause naming', () => {
  it('names an observed contributor only when included at the changed wire prefix', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);

    // Divergence at request 43; injections land between 10–11 and 42–43.
    driveSession(
      pi,
      request => (request === TOTAL_REQUESTS ? divergedAt(7).map((message, index) =>
        index === 7 ? { ...message, content: 'context from kizn-guidance' } : message) : prefixMessages()),
      request =>
        request === 11
          ? contextMessages('earlier-guidance')
          : request === TOTAL_REQUESTS
            ? contextMessages('kizn-guidance')
            : contextMessages(),
    );

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('correlated candidate');
    expect(warning?.message).toContain('"kizn-guidance"');
    expect(warning?.context?.cause).toMatchObject({ kind: 'injection', source: 'kizn-guidance', request: 43 });
  });

  it('reports no matching contributor when changed wire content has no observed source', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);

    // No injection in the 10 requests before the divergence at request 43.
    driveSession(pi, request => (request === TOTAL_REQUESTS ? divergedAt(7) : prefixMessages()));

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('no-matching-contributor');
    expect(warning?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });

  it('names the compaction as the likely cause when the divergence immediately follows it', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    // Requests 1-30: healthy baseline, stable prefix A.
    for (let request = 1; request <= 30; request++) {
      pi.emit(contextEvent(contextMessages()), ctx);
      pi.emit(beforeProviderRequest(prefixMessages()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    // session_compact after response 30 (marker attributed to request 30);
    // fingerprints are cleared, so request 31 re-baselines on the rewritten
    // prefix B instead of diverging.
    pi.emit(benignEvent('session_compact'), ctx);
    const rewritten = (): RequestMessageLike[] =>
      Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `rewritten ${i}` }));
    // Request 31: rewritten prefix B (re-baseline), healthy.
    pi.emit(contextEvent(contextMessages()), ctx);
    pi.emit(beforeProviderRequest(rewritten()), ctx);
    pi.emit(providerResponse(), ctx);
    pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    // Request 32 onward: B diverges at index 2 while still inside the
    // compaction boundary window — the plan's "immediately follows" Given.
    const settled = (): RequestMessageLike[] =>
      rewritten().map((message, i) =>
        i === 2 ? { ...message, content: 'rewritten 2 (settled)' } : message,
      );
    // Healthy at 31-33 clears suppression (3 above-floor evaluations)...
    for (const request of [32, 33]) {
      pi.emit(contextEvent(contextMessages()), ctx);
      pi.emit(beforeProviderRequest(settled()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    // ...then a genuine collapse warns with divergence at request 32.
    for (let request = 34; request <= 40; request++) {
      pi.emit(contextEvent(contextMessages()), ctx);
      pi.emit(beforeProviderRequest(settled()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
    }

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('divergence at request 32 @ message index 2');
    expect(warning?.message).toContain('likely cause');
    expect(warning?.message).toContain('session_compact');
    expect(warning?.context?.cause).toEqual({
      kind: 'compaction',
      benignKind: 'session_compact',
      request: 30,
    });
  });

  it('does not let a stale compaction marker shadow a nearer injection', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ctx = fakeCtx('cache-watch-demo');

    // Requests 1-30: healthy baseline, stable prefix.
    for (let request = 1; request <= 30; request++) {
      pi.emit(contextEvent(contextMessages()), ctx);
      pi.emit(beforeProviderRequest(prefixMessages()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    // An old compaction marker...
    pi.emit(benignEvent('session_compact'), ctx);
    // ...suppressed collapse while the cache warms back up (31-36)...
    for (let request = 31; request <= 36; request++) {
      pi.emit(contextEvent(contextMessages()), ctx);
      pi.emit(beforeProviderRequest(prefixMessages()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
    }
    // ...recovery re-arms (37-40)...
    for (let request = 37; request <= 40; request++) {
      pi.emit(contextEvent(contextMessages()), ctx);
      pi.emit(beforeProviderRequest(prefixMessages()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    }
    // A named contributor lands right before request 41 and is included at
    // the changed wire prefix; the old compaction must not shadow it.
    const includedGuidance = () => divergedAt(7).map((message, index) =>
      index === 7 ? { ...message, content: 'context from kizn-guidance' } : message);
    pi.emit(contextEvent(contextMessages('kizn-guidance')), ctx);
    pi.emit(beforeProviderRequest(includedGuidance()), ctx);
    pi.emit(providerResponse(), ctx);
    pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
    for (let request = 42; request <= 46; request++) {
      pi.emit(contextEvent(contextMessages('kizn-guidance')), ctx);
      pi.emit(beforeProviderRequest(includedGuidance()), ctx);
      pi.emit(providerResponse(), ctx);
      pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
    }

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('kizn-guidance');
    expect(warning?.message).not.toContain('session_compact');
    expect(warning?.context?.cause).toMatchObject({
      kind: 'injection',
      source: 'kizn-guidance',
      request: 41,
    });
  });
});
