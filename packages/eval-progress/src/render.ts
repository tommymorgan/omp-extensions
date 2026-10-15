import type { Component } from '@oh-my-pi/pi-tui';
import type { AgentToolResult } from '@oh-my-pi/pi-coding-agent';
import { evalToolRenderer, type EvalStatusEvent, type EvalToolDetails } from '@oh-my-pi/pi-tui/tools/eval';
import { renderAgentTreeRow } from '@oh-my-pi/pi-tui/tools/agent-tree';
import type { RenderResultOptions } from '@oh-my-pi/pi-tui/tools/renderer';
import type { Theme } from '@oh-my-pi/pi-tui/theme';
import { replaceTabs, truncateToWidth, TRUNCATE_LENGTHS } from '@oh-my-pi/pi-tui/render/render-utils';
import { sanitizeText } from '@oh-my-pi/pi-utils';

function value(event: EvalStatusEvent, key: string): string | undefined {
  return typeof event[key] === 'string' ? event[key] : undefined;
}
function number(event: EvalStatusEvent, key: string): number {
  return typeof event[key] === 'number' ? event[key] : 0;
}
function clean(text: string): string { return sanitizeText(replaceTabs(text)); }

/** Keep native code/output rendering; replace only the agent progress rows. */
export function renderResult(
  result: AgentToolResult<EvalToolDetails>, options: RenderResultOptions, theme: Theme,
): Component {
  const agents = new Map<string, EvalStatusEvent>();
  function withoutAgents(events: EvalStatusEvent[] | undefined): EvalStatusEvent[] | undefined {
    return events?.filter(event => {
      if (event.op !== 'agent' || typeof event.id !== 'string') return true;
      agents.set(event.id, event);
      return false;
    });
  }
  const details = result.details;
  const base = evalToolRenderer.renderResult({ ...result, details: details && {
    ...details,
    statusEvents: withoutAgents(details.statusEvents),
    cells: details.cells?.map(cell => ({ ...cell, statusEvents: withoutAgents(cell.statusEvents) })),
  } }, options, theme);
  if (!agents.size) return base;
  return {
    invalidate() { base.invalidate?.(); },
    render(width) {
      const lines = [...base.render(width)];
      let index = 0;
      for (const [id, event] of agents) {
        const last = ++index === agents.size;
        const prefix = theme.fg('dim', last ? theme.tree.last : theme.tree.branch);
        const cont = last ? '   ' : `${theme.fg('dim', theme.tree.vertical)}  `;
        const status = event.status === 'completed' || event.status === 'failed' || event.status === 'aborted'
          || event.status === 'pending' ? event.status : 'running';
        lines.push(renderAgentTreeRow({
          presentation: 'eval', prefix, id: clean(id).replace(/\s+/g, ' '), status, width,
          model: value(event, 'resolvedModelIdentity') ?? value(event, 'model') ?? value(event, 'resolvedModel'),
          thinkingLevel: event.resolvedThinkingLevel, advisor: event.advisor === true,
          spinnerFrame: options.spinnerFrame,
          durationMs: status !== 'running' ? number(event, 'durationMs') : undefined,
          stats: { toolCount: number(event, 'toolCount'), contextTokens: number(event, 'contextTokens'),
            contextWindow: number(event, 'contextWindow'), cost: number(event, 'cost') },
        }, theme).line);
        let preview: string | undefined;
        if (status === 'running') {
          const tool = value(event, 'currentTool');
          const intent = value(event, 'lastIntent') ?? value(event, 'currentToolArgs');
          preview = tool ? `${tool}${intent ? `: ${intent}` : ''}` : intent ?? value(event, 'taskPreview');
        } else if (event.result && typeof event.result === 'object') {
          const payload = event.result;
          if ('text' in payload && typeof payload.text === 'string') preview = payload.text;
          else if ('error' in payload && typeof payload.error === 'string') preview = payload.error;
        }
        if (preview) {
          const firstLine = clean(preview.split('\n')[0] ?? '');
          lines.push(truncateToWidth(`${cont}${theme.tree.hook} ${theme.fg('muted',
            truncateToWidth(firstLine, TRUNCATE_LENGTHS.CONTENT))}`, width));
        }
      }
      return lines;
    },
  };
}
