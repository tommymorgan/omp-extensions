import { describe, expect, it } from 'bun:test';
import { CacheWatchDetector } from '../src/detector.ts';

function fixture() {
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  const detector = new CacheWatchDetector('provider-test', {
    warn: (message, context) => warnings.push({ message, context }),
    debug: () => {},
  });
  const request = (payload: unknown, healthy = true) => {
    detector.recordRequestPayload(payload);
    detector.recordResponse({ input: healthy ? 10 : 330, cacheRead: healthy ? 990 : 670, cacheWrite: 0 });
  };
  const warm = (payload: unknown) => { for (let i = 0; i < 20; i++) request(payload); };
  const collapse = (payload: unknown) => { for (let i = 0; i < 8; i++) request(payload, false); };
  return { detector, request, warm, collapse, warnings };
}
const messages = (text: string) => [{ role: 'system', content: text }, { role: 'user', content: 'question' }];

describe('provider request coverage and publication correlation', () => {
  for (const field of ['messages', 'input']) {
    it(`correlates included changed guidance in ${field} without relying on context hook order`, () => {
      const f = fixture();
      f.warm({ [field]: messages('old guidance') });
      f.detector.recordContextMessages([{ role: 'user', content: 'question' }]);
      f.detector.recordPublication('kizn-guidance', 'new guidance', 'r2');
      const payload = { [field]: messages('new guidance') };
      const original = structuredClone(payload);
      f.collapse(payload);
      expect(payload).toEqual(original);
      expect(f.warnings).toHaveLength(1);
      expect(f.warnings[0]?.context).toMatchObject({
        fingerprintCoverage: 'complete', divergence: { request: 21, messageIndex: 0 },
        cause: { kind: 'injection', source: 'kizn-guidance', request: 21, version: 'r2' },
      });
      expect(f.warnings[0]?.context?.cause).toHaveProperty('contentHash');
      expect(f.warnings[0]?.message).toContain('correlated candidate');
      expect(JSON.stringify(f.warnings)).not.toContain('new guidance');
    });
  }
  for (const field of ['system', 'instructions']) {
    it(`detects top-level ${field} without shifting message indices`, () => {
      const f = fixture();
      f.warm({ input: messages('stable'), [field]: 'old' });
      f.detector.recordPublication('kizn-guidance', 'new', 'r3');
      f.collapse({ input: messages('stable'), [field]: 'new' });
      expect(f.warnings[0]?.context).toMatchObject({ divergence: { request: 21, messageIndex: 0, source: field }, cause: { kind: 'injection' } });
    });
  }
  for (const payload of [
    null, {}, { messages: 'invalid' }, { input: [null] }, { input: [{ nonsense: true }] },
    { input: [{ type: 'function_call' }] },
    { messages: [{ role: 'user', content: [null] }] },
    { input: [], instructions: { invalid: true } },
  ]) {
    it(`reports unsupported coverage and clears stale comparisons for ${JSON.stringify(payload)}`, () => {
      const f = fixture();
      f.warm({ input: messages('old') });
      f.request({ input: messages('changed') });
      f.collapse(payload);
      expect(f.warnings[0]?.context).toMatchObject({ fingerprintCoverage: 'unsupported', divergence: null, cause: { kind: 'none', reason: 'unsupported-payload' } });
    });
  }
  it('reports chained input as partial and starts a fresh baseline after the gap', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.request({ input: messages('changed') });
    f.collapse({ input: 'delta', previous_response_id: 'previous' });
    expect(f.warnings[0]?.context).toMatchObject({ fingerprintCoverage: 'partial', divergence: null, cause: { kind: 'none', reason: 'chained-input' } });
    const fresh = fixture();
    fresh.warm({ input: messages('old') });
    fresh.request({ input: 'delta', previous_response_id: 'previous' });
    fresh.collapse({ input: messages('different full history') });
    expect(fresh.warnings[0]?.context).toMatchObject({ divergence: null, cause: { reason: 'no-divergence' } });
  });
  it('counts unsupported boundaries in the divergence request ordinal', () => {
    const f = fixture();
    f.warm({ messages: messages('old') });
    f.request({ unsupported: true });
    f.request({ input: messages('new baseline') });
    f.collapse({ input: messages('changed') });
    expect(f.warnings[0]?.context?.divergence).toEqual({ request: 23, messageIndex: 0 });
  });
  it('does not name a publication absent from the changed location', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'published guidance', 'r2');
    f.collapse({ input: [{ role: 'system', content: 'unrelated replacement' }, { role: 'user', content: 'published guidance' }] });
    expect(f.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });
  it('does not reuse a candidate after thirty healthy requests', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'guidance', 'r2');
    f.request({ input: messages('guidance') });
    for (let i = 0; i < 30; i++) f.request({ input: messages('guidance') });
    f.collapse({ input: messages('unrelated') });
    expect(f.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });
  it('expires old divergence even if no new divergence replaces it', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'guidance');
    f.request({ input: messages('guidance') });
    for (let i = 0; i < 11; i++) f.request({ input: messages('guidance') });
    f.collapse({ input: messages('guidance') });
    expect(f.warnings[0]?.context).toMatchObject({ divergence: null, cause: { reason: 'no-divergence' } });
  });
  it('does not treat initial guidance or pure append as prefix divergence', () => {
    const f = fixture();
    f.detector.recordPublication('kizn-guidance', 'guidance');
    f.warm({ input: messages('guidance') });
    f.collapse({ input: [...messages('guidance'), { role: 'user', content: 'appended' }] });
    expect(f.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-divergence' });
  });
  it('clears pending publications and context snapshots across session reset', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'guidance');
    f.detector.benignReset('session_switch');
    f.request({ input: messages('baseline') });
    f.collapse({ input: messages('guidance') });
    expect(f.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });
  it('correlates full Codex input text with tool-call history and top-level instructions', () => {
    const f = fixture();
    const input = (guidance: string) => [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: guidance }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'result' },
    ];
    f.warm({ instructions: 'Stable agent instructions', input: input('old guidance') });
    f.detector.recordPublication('kizn-guidance', 'new guidance', 'sha256:version');
    f.collapse({ instructions: 'Stable agent instructions', input: input('new guidance') });
    expect(f.warnings[0]?.context).toMatchObject({
      fingerprintCoverage: 'complete', divergence: { request: 21, messageIndex: 0 },
      cause: { kind: 'injection', source: 'kizn-guidance', version: 'sha256:version' },
    });
  });
  it('does not blame published content appended later in the same changed message', () => {
    const f = fixture();
    f.warm({ input: messages('old prefix') });
    f.detector.recordPublication('kizn-guidance', 'guidance');
    f.collapse({ input: messages('unrelated prefix\nguidance') });
    expect(f.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });
  it('retains version provenance when context and publication both observe included content', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordContextMessages([{ role: 'user', content: 'question' }]);
    f.detector.recordPublication('kizn-guidance', 'guidance', 'r2');
    f.detector.recordContextMessages([{ role: 'custom', customType: 'kizn-guidance', content: 'guidance' }]);
    f.collapse({ input: messages('guidance') });
    expect(f.warnings[0]?.context?.cause).toMatchObject({ source: 'kizn-guidance', version: 'r2' });
  });
  it('rejects stale publication content even if included at a later changed prefix', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'guidance', 'r2');
    for (let i = 0; i < 11; i++) f.request({ input: messages('old') });
    f.collapse({ input: messages('guidance') });
    expect(f.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
  });
  it('detects removed instructions at their own source rather than shifting message index', () => {
    const f = fixture();
    f.warm({ instructions: 'old', input: messages('stable') });
    f.collapse({ input: messages('stable') });
    expect(f.warnings[0]?.context?.divergence).toEqual({ request: 21, messageIndex: 0, source: 'instructions' });
  });
  it('does not compare full histories across an unsupported request gap', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.request({ messages: 'malformed' });
    f.collapse({ input: messages('different baseline') });
    expect(f.warnings[0]?.context).toMatchObject({ fingerprintCoverage: 'complete', divergence: null, cause: { reason: 'no-divergence' } });
  });
  it('keeps publications isolated between detector sessions', () => {
    const source = fixture();
    const other = fixture();
    source.warm({ input: messages('old') });
    other.warm({ input: messages('old') });
    source.detector.recordPublication('kizn-guidance', 'guidance');
    other.collapse({ input: messages('guidance') });
    expect(other.warnings[0]?.context?.cause).toEqual({ kind: 'none', reason: 'no-matching-contributor' });
    source.collapse({ input: messages('guidance') });
    expect(source.warnings[0]?.context?.cause).toMatchObject({ kind: 'injection', source: 'kizn-guidance' });
  });
  it('reports the actual changed wire request when publication inclusion is delayed', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'guidance', 'r2');
    for (let i = 0; i < 3; i++) f.request({ input: messages('old') });
    f.collapse({ input: messages('guidance') });
    expect(f.warnings[0]?.context).toMatchObject({
      divergence: { request: 24, messageIndex: 0 },
      cause: { kind: 'injection', source: 'kizn-guidance', request: 24, version: 'r2' },
    });
  });
  it('retains distinct pending publication snapshots when duplicate notices repeat', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordPublication('kizn-guidance', 'guidance one', 'r1');
    f.detector.recordPublication('kizn-guidance', 'guidance two', 'r2');
    f.detector.recordPublication('kizn-guidance', 'guidance one', 'r1');
    f.collapse({ input: messages('guidance two') });
    expect(f.warnings[0]?.context?.cause).toMatchObject({
      kind: 'injection', source: 'kizn-guidance', request: 21, version: 'r2',
    });
  });
  it('matches a changed occurrence even when identical text existed elsewhere', () => {
    const f = fixture();
    f.warm({ input: messages('new guidance\nold guidance') });
    f.detector.recordPublication('kizn-guidance', 'new guidance', 'r2');
    f.collapse({ input: messages('new guidance\nnew guidance') });
    expect(f.warnings[0]?.context?.cause).toMatchObject({
      kind: 'injection', source: 'kizn-guidance', request: 21, version: 'r2',
    });
  });
  it('preserves available version when context inclusion follows publication by several requests', () => {
    const f = fixture();
    f.warm({ input: messages('old') });
    f.detector.recordContextMessages([{ role: 'user', content: 'question' }]);
    f.detector.recordPublication('kizn-guidance', 'guidance', 'r2');
    for (let i = 0; i < 3; i++) f.request({ input: messages('old') });
    f.detector.recordContextMessages([{
      role: 'custom', customType: 'kizn-guidance', content: 'guidance', details: { version: 'r2' },
    }]);
    f.collapse({ input: messages('guidance') });
    expect(f.warnings[0]?.context?.cause).toMatchObject({
      kind: 'injection', source: 'kizn-guidance', request: 24, version: 'r2',
    });
  });
  it('bounds idle publication history while retaining recent request matches', () => {
    const evicted = fixture();
    const recent = fixture();
    for (const f of [evicted, recent]) {
      f.warm({ input: messages('baseline') });
      for (let i = 0; i < 1000; i++) {
        f.detector.recordPublication('kizn-guidance', `guidance-${i}`, `r${i}`);
      }
    }
    evicted.collapse({ input: messages('guidance-0') });
    expect(evicted.warnings[0]?.context?.cause).toEqual({
      kind: 'none', reason: 'no-matching-contributor',
    });
    recent.collapse({ input: messages('guidance-999') });
    expect(recent.warnings[0]?.context?.cause).toMatchObject({
      kind: 'injection', source: 'kizn-guidance', request: 21, version: 'r999',
    });
  });
});
