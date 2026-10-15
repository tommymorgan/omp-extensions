import type { AgentToolResult } from '@oh-my-pi/pi-coding-agent';
import type { AsyncJob } from '@oh-my-pi/pi-coding-agent/async/job-manager';
import type { EvalStatusEvent, EvalToolDetails } from '@oh-my-pi/pi-tui/tools/eval';
import { logger } from '@oh-my-pi/pi-utils';

type EvalResult = AgentToolResult<EvalToolDetails>;
export type ObservedJob = Pick<AsyncJob,
  'id' | 'agentId' | 'ownerId' | 'status' | 'startTime' | 'endTime' |
  'resultText' | 'errorText' | 'latestDetails' | 'promise'>;

function settledFields(job: ObservedJob): Partial<EvalStatusEvent> {
  const status = job.status === 'cancelled' ? 'aborted' : job.status;
  const payload = job.latestDetails?.evalResult;
  const text = payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string'
    ? payload.text : job.resultText ?? '';
  const result = job.status === 'completed'
    ? { kind: 'agent', id: job.id, status: 'completed', text }
    : { kind: 'agent', id: job.id, status: job.status, error: job.errorText || job.resultText || `Agent ${job.status}` };
  return { status, durationMs: job.endTime! - job.startTime, result };
}

/** Observe only. Never consume deliveries, cancel jobs, or modify the worker's objects. */
export function createProgressObserver(
  lookup: (agentId: string) => ObservedJob | undefined,
  publish: (result: EvalResult) => void,
) {
  let active = true;
  let latest: EvalResult | undefined;
  const jobs = new Map<string, ObservedJob>();
  const terminal = new Map<string, Partial<EvalStatusEvent>>();

  function projectEvent(event: EvalStatusEvent): EvalStatusEvent {
    if (event.op !== 'agent' || typeof event.id !== 'string') return event;
    const id = event.id;
    let job = jobs.get(id);
    if (!job) {
      job = lookup(id);
      if (job) {
        jobs.set(id, job);
        // A sibling may finish without another worker progress update.
        void job.promise.then(refresh, refresh).catch(error => {
          logger.error('Eval progress trial update failed', { error: String(error) });
        });
      }
    }
    if (job?.endTime !== undefined && !terminal.has(id)) terminal.set(id, settledFields(job));
    const fields = terminal.get(id);
    if (fields) return { ...event, ...fields, currentTool: undefined, currentToolArgs: undefined, lastIntent: undefined };
    // Workers may report completed before the owning job has accepted its result.
    return job ? { ...event, status: 'running', durationMs: undefined, result: undefined } : event;
  }

  function project(result: EvalResult): EvalResult {
    if (!result.details) return result;
    return {
      ...result,
      details: {
        ...result.details,
        statusEvents: result.details.statusEvents?.map(projectEvent),
        cells: result.details.cells?.map(cell => ({
          ...cell, statusEvents: cell.statusEvents?.map(projectEvent),
        })),
      },
    };
  }

  function refresh(): void {
    if (!active || !latest) return;
    const jobCount = jobs.size;
    const terminalCount = terminal.size;
    const projected = project(latest);
    if (jobs.size !== jobCount || terminal.size !== terminalCount) publish(projected);
  }

  return {
    accept(result: EvalResult): EvalResult {
      latest = result;
      return project(result);
    },
    refresh,
    stop(): void { active = false; latest = undefined; jobs.clear(); terminal.clear(); },
  };
}
