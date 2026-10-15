import { expect, test } from 'bun:test';
import type { AgentToolResult } from '@oh-my-pi/pi-coding-agent';
import type { EvalToolDetails } from '@oh-my-pi/pi-tui/tools/eval';
import { createProgressObserver, type ObservedJob } from '../src/progress.ts';

function running(id: string) {
  const deferred = Promise.withResolvers<void>();
  const job: ObservedJob = { id, ownerId: 'Main', agentId: id, status: 'running', startTime: 100, promise: deferred.promise };
  return { job, resolve: deferred.resolve };
}
function progress(): AgentToolResult<EvalToolDetails> {
  return { content: [], details: { cells: [{ index: 0, language: 'js', code: '', output: '', status: 'running', statusEvents: [
    { op: 'agent', id: 'fast', status: 'completed', currentTool: 'stale tool' },
    { op: 'agent', id: 'slow', status: 'running' },
  ] }] } };
}

test('completed sibling appears while the cell and other sibling are still running, even without worker updates', async () => {
  const fast = running('fast');
  const slow = running('slow');
  const emitted = Promise.withResolvers<AgentToolResult<EvalToolDetails>>();
  const observer = createProgressObserver(id => id === 'fast' ? fast.job : slow.job, emitted.resolve);
  const input = progress();
  expect(observer.accept(input).details?.cells?.[0]?.statusEvents?.[0]?.status).toBe('running');
  Object.assign(fast.job, { status: 'completed', endTime: 230, resultText: 'fallback text', latestDetails: { evalResult: { text: 'Verification passed' } } });
  fast.resolve();
  const result = await emitted.promise;
  expect(result.details?.cells?.[0]?.status).toBe('running');
  expect(result.details?.cells?.[0]?.statusEvents).toMatchObject([
    { id: 'fast', status: 'completed', durationMs: 130, result: { text: 'Verification passed' }, currentTool: undefined },
    { id: 'slow', status: 'running' },
  ]);
  // Subsequent stale worker progress cannot resurrect a completed job.
  expect(observer.accept(input).details?.cells?.[0]?.statusEvents?.[0]?.status).toBe('completed');
  expect(input.details?.cells?.[0]?.statusEvents?.[0]?.currentTool).toBe('stale tool');
  observer.stop();
});

test('stopped observers cannot publish late completion into a finished or aborted call', async () => {
  const fast = running('fast');
  let publishes = 0;
  const observer = createProgressObserver(() => fast.job, () => publishes++);
  observer.accept(progress());
  observer.stop();
  Object.assign(fast.job, { status: 'cancelled', endTime: 240, errorText: 'Cancelled by user' });
  fast.resolve();
  await fast.job.promise;
  await Promise.resolve();
  observer.refresh();
  expect(publishes).toBe(0);
});

test('late job registration is recovered and failed results retain the actual error', () => {
  const fast = running('fast');
  let registered = false;
  let update: AgentToolResult<EvalToolDetails> | undefined;
  const observer = createProgressObserver(id => registered && id === 'fast' ? fast.job : undefined, result => { update = result; });
  observer.accept(progress());
  Object.assign(fast.job, { status: 'failed', endTime: 250, errorText: 'Worker disconnected' });
  registered = true;
  observer.refresh();
  expect(update?.details?.cells?.[0]?.statusEvents?.[0]).toMatchObject({ status: 'failed', result: { error: 'Worker disconnected' } });
  observer.stop();
});
