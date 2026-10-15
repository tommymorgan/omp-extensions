import { expect, test } from 'bun:test';
import { getThemeByName } from '@oh-my-pi/pi-tui/theme';
import { renderResult } from '../src/render.ts';

test('terminal agents show a sanitized first result line instead of stale tool activity while siblings keep running', async () => {
  const theme = await getThemeByName('dark');
  if (!theme) throw new Error('Bundled dark theme unavailable');
  const component = renderResult({ content: [], details: { cells: [{ index: 0, language: 'js', code: 'await wait(handles)',
    output: '', status: 'running', statusEvents: [
      { op: 'agent', id: 'fast', status: 'completed', durationMs: 900, currentTool: 'STALE_TOOL', result: { text: 'Verified\tresult\nSECOND_LINE' } },
      { op: 'agent', id: 'slow', status: 'running', currentTool: 'read', lastIntent: 'still checking' },
    ] }] } }, { expanded: false, isPartial: true, spinnerFrame: 1 }, theme);
  const lines = component.render(80);
  const text = lines.join('\n');
  expect(text).toContain('Verified');
  expect(text).toContain('result');
  expect(text).toContain('still checking');
  expect(text).not.toContain('STALE_TOOL');
  expect(text).not.toContain('SECOND_LINE');
  expect(text).not.toContain('\t');
  expect(lines.every(line => Bun.stringWidth(line) <= 80)).toBe(true);
});
