import { describe, expect, it } from 'bun:test';
import cacheWatch from '../src/index.ts';
import { FakePi, assistantMessage, contextEvent, fakeCtx, fakeUi, providerResponse, type FakeCtx } from './harness.ts';

const CHANNEL = 'trailboss:context:publish';
const OLD = 'previous private guidance';
const NEW = 'replacement private guidance';
const payload = (content: string) => ({ input: [{ role: 'system', content }, { role: 'user', content: 'question' }] });
const publication = (sessionId: string) => ({ sessionId, source: 'kizn-guidance', message: { content: NEW, details: { version: 'r2' } } });

function cycle(pi: FakePi, ctx: FakeCtx, body: unknown, rate: number): void {
  const event = Object.freeze({ type: 'before_provider_request', payload: body });
  pi.emit(event, ctx);
  pi.emit(providerResponse(), ctx);
  pi.emit(assistantMessage(rate), ctx);
}
function warm(pi: FakePi, ctx: FakeCtx): void {
  for (let i = 0; i < 20; i++) cycle(pi, ctx, payload(OLD), 0.99);
}
function collapse(pi: FakePi, ctx: FakeCtx, body: unknown): void {
  for (let i = 0; i < 8; i++) cycle(pi, ctx, body, 0.67);
}
function fixture(sessionId = 'watched') {
  const pi = new FakePi();
  cacheWatch(pi as never);
  const ui = fakeUi();
  const ctx = fakeCtx(sessionId, { mode: 'tui', ui, agent: { kind: 'main' } });
  const text = () => ui.widgets.get(`cache-watch-banner:${sessionId}`)?.lines.join('\n') ?? '';
  return { pi, ctx, ui, text };
}

describe('read-only publication attribution through extension handlers', () => {
  for (const order of ['before context', 'after context']) {
    it(`names an included correlated candidate published ${order} with version and hash but no raw content`, () => {
      const f = fixture();
      warm(f.pi, f.ctx);
      const context = Object.freeze({ type: 'context', messages: Object.freeze([{ role: 'user', content: 'question' }]) });
      const published = publication('watched');
      Object.freeze(published.message.details);
      Object.freeze(published.message);
      Object.freeze(published);
      const before = structuredClone(published);
      let delivered: unknown;
      f.pi.events.on(CHANNEL, event => { delivered = event; });
      if (order === 'before context') f.pi.events.emit(CHANNEL, published);
      f.pi.emit(context, f.ctx);
      if (order === 'after context') f.pi.events.emit(CHANNEL, published);
      const body = payload(NEW);
      const original = structuredClone(body);
      Object.freeze(body.input[0]);
      Object.freeze(body.input[1]);
      Object.freeze(body.input);
      Object.freeze(body);
      collapse(f.pi, f.ctx, body);
      expect(f.pi.warnings).toHaveLength(1);
      expect(f.pi.warnings[0]?.context).toMatchObject({
        sessionId: 'watched', fingerprintCoverage: 'complete',
        cause: { kind: 'injection', source: 'kizn-guidance', request: 21, version: 'r2' },
      });
      expect(f.pi.warnings[0]?.context?.cause).toHaveProperty('contentHash');
      expect(f.text()).toContain('correlated candidate');
      expect(f.text()).toContain('kizn-guidance');
      expect(f.text()).toContain('r2');
      expect(JSON.stringify(f.pi.warnings)).not.toContain(NEW);
      expect(published).toEqual(before);
      expect(delivered).toBe(published);
      expect(body).toEqual(original);
      expect(context.messages).toEqual([{ role: 'user', content: 'question' }]);
    });
  }

  it('routes publication before any context to its exact session without borrowing another session UI', () => {
    const f = fixture();
    f.pi.events.emit(CHANNEL, publication('watched'));
    // Establish usage baseline without aging the first pending publication
    // through twenty provider requests; the first request supplies the prefix.
    cycle(f.pi, f.ctx, payload(OLD), 0.99);
    for (let i = 1; i < 20; i++) f.pi.emit(assistantMessage(0.99), f.ctx);
    const otherUi = fakeUi();
    const other = fakeCtx('other', { mode: 'tui', ui: otherUi, agent: { kind: 'main' } });
    warm(f.pi, other);
    collapse(f.pi, f.ctx, payload(NEW));
    collapse(f.pi, other, payload(NEW));
    expect(f.text()).toContain('kizn-guidance');
    expect(otherUi.widgets.get('cache-watch-banner:other')?.lines.join('\n')).toContain('no matching contributor');
    expect(f.pi.warnings[1]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });

  const malformed = [null, [], {}, { ...publication('watched'), sessionId: 42 }, { ...publication('watched'), sessionId: '' },
    { ...publication('watched'), source: false }, { ...publication('watched'), source: '' },
    { ...publication('watched'), message: null }, { ...publication('watched'), message: { content: [] } },
    { ...publication('watched'), message: { content: NEW, details: null } },
    { ...publication('watched'), message: { content: NEW, details: 'invalid' } },
    { ...publication('watched'), message: { content: NEW, details: { version: 2 } } }];
  for (const event of malformed) {
    it(`ignores malformed publication ${JSON.stringify(event)}`, () => {
      const f = fixture();
      warm(f.pi, f.ctx);
      f.pi.events.emit(CHANNEL, event);
      collapse(f.pi, f.ctx, payload(NEW));
      expect(f.pi.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
      expect(f.text()).not.toContain('kizn-guidance');
    });
  }

  it('does not name a valid publication absent from the changed provider prefix', () => {
    const f = fixture();
    warm(f.pi, f.ctx);
    f.pi.events.emit(CHANNEL, publication('watched'));
    collapse(f.pi, f.ctx, { input: [{ role: 'system', content: 'unrelated replacement' }, { role: 'user', content: NEW }] });
    expect(f.text()).toContain('no matching contributor');
    expect(f.text()).not.toContain('kizn-guidance');
  });

  it('unsubscribes on shutdown and leaves other event bus subscribers registered', () => {
    const f = fixture();
    warm(f.pi, f.ctx);
    let observed = 0;
    f.pi.events.on(CHANNEL, () => { observed++; });
    f.pi.emit({ type: 'session_shutdown' }, f.ctx);
    f.pi.events.emit(CHANNEL, publication('watched'));
    collapse(f.pi, f.ctx, payload(NEW));
    expect(observed).toBe(1);
    expect(f.text()).toContain('no matching contributor');
  });

  for (const diagnostic of [
    { name: 'unsupported payload', body: { unknown: true }, coverage: 'unsupported', reason: 'unsupported-payload', text: 'unsupported payload' },
    { name: 'chained input', body: { input: 'delta', previous_response_id: 'previous' }, coverage: 'partial', reason: 'chained-input', text: 'partial coverage' },
    { name: 'unchanged prefix', body: payload(OLD), coverage: 'complete', reason: 'no-divergence', text: 'no divergence' },
    { name: 'unmatched change', body: payload(NEW), coverage: 'complete', reason: 'no-matching-contributor', text: 'no matching contributor' },
  ]) {
    it(`renders a distinct attribution diagnostic for ${diagnostic.name}`, () => {
      const f = fixture();
      warm(f.pi, f.ctx);
      collapse(f.pi, f.ctx, diagnostic.body);
      expect(f.pi.warnings[0]?.context).toMatchObject({ fingerprintCoverage: diagnostic.coverage, cause: { kind: 'none', reason: diagnostic.reason } });
      expect(f.text()).toContain(diagnostic.text);
      expect(f.text()).not.toContain('none recorded');
    });
  }
});
