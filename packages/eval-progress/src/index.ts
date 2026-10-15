import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import type { evalSchema } from '@oh-my-pi/pi-coding-agent/tools/eval';
import { evalToolRenderer, type EvalToolDetails } from '@oh-my-pi/pi-tui/tools/eval';
import { createProgressObserver } from './progress.ts';
import { renderResult } from './render.ts';

const presentation = {
  mergeCallAndResult: evalToolRenderer.mergeCallAndResult,
  inline: evalToolRenderer.inline,
};

export default function evalProgress(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    const native = pi.getAllTools().find(tool => tool.name === 'eval');
    if (!native) return;
    pi.registerTool({
      ...presentation,
      name: 'eval', label: 'Eval', description: native.description,
      // ToolInfo erases the native schema's inferred parameter type.
      parameters: native.parameters as typeof evalSchema, approval: 'exec', loadMode: 'essential',
      renderCall: evalToolRenderer.renderCall,
      renderResult,
      async execute(_id, params, signal, onUpdate, context) {
        if (!context.invokeTool) throw new Error('Eval progress trial requires native tool delegation (OMP 18.11.1+).');
        const session = AgentRegistry.global().get(context.agent.id)?.session;
        const manager = session?.asyncJobManager;
        if (!session || !manager) throw new Error('Eval progress trial cannot access the current session job registry.');
        const observer = createProgressObserver(id => {
          const direct = manager.getJob(id);
          if (direct?.ownerId === context.agent.id && direct.type === 'task') return direct;
          return [...manager.getRunningJobs({ ownerId: context.agent.id }),
            ...manager.getRecentJobs(Number.POSITIVE_INFINITY, { ownerId: context.agent.id })]
            .find(job => job.type === 'task' && job.agentId === id);
        }, result => onUpdate?.(result));
        const timer = context.setInterval(observer.refresh, 1000);
        try {
          const result = await context.invokeTool<EvalToolDetails>(params, {
            signal, onUpdate: update => onUpdate?.(observer.accept(update)),
          });
          return observer.accept(result);
        } finally {
          context.clearTimer(timer);
          observer.stop();
        }
      },
    });
    if (ctx.hasUI) ctx.ui.setStatus('eval-progress', 'Eval progress trial');
  });
}
