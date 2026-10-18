import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessage,
  beforeProviderRequest,
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
  it('names the nearest upstream injection source in the warning', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);

    // Divergence at request 43; injections land between 10–11 and 42–43.
    driveSession(
      pi,
      request => (request === TOTAL_REQUESTS ? divergedAt(7) : prefixMessages()),
      request =>
        request === 11
          ? contextMessages('earlier-guidance')
          : request === TOTAL_REQUESTS
            ? contextMessages('kizn-guidance')
            : contextMessages(),
    );

    expect(pi.warnings.length).toBe(1);
    const warning = pi.warnings[0];
    expect(warning?.message).toContain('nearest upstream injection');
    expect(warning?.message).toContain('"kizn-guidance"');
    expect(warning?.context?.cause).toEqual({ kind: 'injection', source: 'kizn-guidance', request: 43 });
  });
});
