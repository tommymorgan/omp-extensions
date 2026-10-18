import { describe, expect, it } from 'bun:test';
import {
  FakePi,
  assistantMessage,
  fakeCtx,
  fakeUi,
  type FakeCtx,
} from './harness.ts';
import cacheWatch from '../src/index.ts';

/**
 * Plan Task 3.1, scenario 2 — "Banner clears on recovery": while the session
 * shows the collapse banner, three consecutive rolling-rate evaluations above
 * the absolute floor remove it without restarting the session.
 *
 * Window math (WINDOW_SIZE 5): after the alert the window holds five 58%
 * responses. Recovery responses at 94% move the rolling rate above the 70%
 * floor from the second recovery response on ((3×0.58+2×0.94)/5 = 72.4%); the
 * third consecutive above-floor evaluation lands on the fourth recovery
 * response ((0.58+4×0.94)/5 = 86.8%), which is where the banner must clear.
 */
const HEALTHY_RATE = 0.94;
const COLLAPSED_RATE = 0.58;
const BASELINE_RESPONSES = 20;
const COLLAPSE_RESPONSES = 6;
const BANNER_KEY = 'cache-watch-banner:cache-watch-demo';

function driveToBanner(pi: FakePi, ctx: FakeCtx): void {
  for (let i = 0; i < BASELINE_RESPONSES; i++) pi.emit(assistantMessage(HEALTHY_RATE), ctx);
  for (let i = 0; i < COLLAPSE_RESPONSES; i++) pi.emit(assistantMessage(COLLAPSED_RATE), ctx);
}

describe('collapse banner recovery', () => {
  it('removes the banner after 3 consecutive evaluations above the floor, without restarting the session', () => {
    const pi = new FakePi();
    cacheWatch(pi as never);
    const ui = fakeUi();
    // One session throughout: recovery clears in place, no session restart.
    const ctx = fakeCtx('cache-watch-demo', { mode: 'tui', ui, agent: { kind: 'main' } });

    driveToBanner(pi, ctx);
    expect(ui.widgets.has(BANNER_KEY)).toBe(true);

    // First recovery response: window still below the floor — banner stays.
    pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    expect(ui.widgets.has(BANNER_KEY)).toBe(true);

    // Second above-floor evaluation — one short of the contract; banner stays.
    pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    expect(ui.widgets.has(BANNER_KEY)).toBe(true);

    // Third consecutive above-floor evaluation: banner removed.
    pi.emit(assistantMessage(HEALTHY_RATE), ctx);
    expect(ui.widgets.has(BANNER_KEY)).toBe(false);
    expect(ui.widgets.size).toBe(0);
  });
});
