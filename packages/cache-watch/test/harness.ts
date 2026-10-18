export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}
export interface FakeTheme {
  fg(color: 'error' | 'muted', text: string): string;
}

/** Recorded widget content: styled lines plus the placement it was given. */
export interface FakeWidget {
  lines: string[];
  placement?: string;
}

/** Models the ExtensionUIContext surface cache-watch consumes (setWidget + theme). */
export interface FakeUi {
  theme: FakeTheme;
  widgets: Map<string, FakeWidget>;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: string }): void;
}

export function fakeUi(): FakeUi {
  return {
    theme: {
      fg: (color, text) =>
        color === 'error' ? `\x1b[31m${text}\x1b[0m` : `\x1b[90m${text}\x1b[0m`,
    },
    widgets: new Map(),
    setWidget(key, content, options) {
      if (content === undefined) {
        this.widgets.delete(key);
        return;
      }
      this.widgets.set(key, { lines: content, placement: options?.placement });
    },
  };
}

export interface FakeCtx {
  sessionManager: { getSessionId(): string };
  mode?: 'tui' | 'rpc' | 'json' | 'print';
  agent?: { kind: 'main' | 'sub' };
  ui?: FakeUi;
}
export function fakeCtx(
  sessionId: string,
  overrides: Partial<Omit<FakeCtx, 'sessionManager'>> = {},
): FakeCtx {
  return { sessionManager: { getSessionId: () => sessionId }, ...overrides };
}

export class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly warnings: { message: string; context?: Record<string, unknown> }[] = [];
  readonly debugs: { message: string; context?: Record<string, unknown> }[] = [];

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  logger = {
    warn: (message: string, context?: Record<string, unknown>) => {
      this.warnings.push({ message, context });
    },
    debug: (message: string, context?: Record<string, unknown>) => {
      this.debugs.push({ message, context });
    },
  };

  emit(event: unknown, ctx: FakeCtx): void {
    if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') {
      throw new Error('event must carry a string type field');
    }
    for (const handler of this.handlers.get(event.type) ?? []) {
      handler(event, ctx);
    }
  }
}

/** Build a Usage record with the given cache-read rate over `prompt` input tokens. */
export function usageWithRate(rate: number, prompt = 1000): UsageLike {
  const cacheRead = Math.round(prompt * rate);
  const input = prompt - cacheRead;
  return {
    input,
    output: 100,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + cacheRead + 100,
  };
}

export function assistantMessage(rate: number, prompt = 1000): unknown {
  return { type: 'assistant_message', message: { role: 'assistant', usage: usageWithRate(rate, prompt) } };
}

export function providerResponse(): unknown {
  return { type: 'after_provider_response', status: 200, headers: {}, requestId: null };
}

export interface RequestMessageLike {
  role: string;
  content: unknown;
}

/** before_provider_request fixture carrying a provider wire payload's message array. */
export function beforeProviderRequest(messages: RequestMessageLike[]): unknown {
  return {
    type: 'before_provider_request',
    payload: { model: 'test-model', max_tokens: 1024, messages },
  };
}

export function benignEvent(type: string): unknown {
  return { type };
}

export interface ContextMessageLike {
  role: string;
  customType?: string;
  content: unknown;
}

/**
 * context event fixture: OMP dispatches `{ type: "context", messages }` before
 * each provider call (pi-coding-agent 18.10.4 `ContextEvent`). Only the fields
 * cache-watch reads are modeled: the message list with role/customType.
 */
export function contextEvent(messages: ContextMessageLike[]): unknown {
  return { type: 'context', messages };
}

/** A context contribution injected by a source extension (role "custom"). */
export function injectedContextMessage(source: string): ContextMessageLike {
  return { role: 'custom', customType: source, content: `context from ${source}` };
}
