export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface FakeCtx {
  sessionManager: { getSessionId(): string };
}
export function fakeCtx(sessionId: string): FakeCtx {
  return { sessionManager: { getSessionId: () => sessionId } };
}
export type Handler = (event: unknown, ctx: FakeCtx) => unknown;

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
