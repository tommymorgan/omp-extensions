/**
 * Fake OpenAI-completions provider for the cache-watch boundary harness
 * (plan Task 3.1). A tiny Bun.serve SSE server whose responses carry shaped
 * usage fields so a real `omp` TUI session's cache-read rate follows a script.
 *
 * Rate selection: each chat-completions request's last user message is scanned
 * for a `turn <n>` marker; the rate for that turn comes from the rates map
 * (default HEALTHY). Requests without a marker (title generation, probes) get
 * the healthy rate, so auxiliary traffic can never fabricate a collapse.
 *
 * Usage accounting follows pi-ai's openai-completions mapping: cacheRead =
 * prompt_tokens_details.cached_tokens, input = prompt_tokens - cached_tokens,
 * so cacheRead / (cacheRead + input) == cached / prompt == rate.
 *
 * Run standalone: bun packages/cache-watch/test/fake-provider.ts <turn> <rate-percent>...
 * (e.g. `... 20 94 6 58 5 94` = 20 turns at 94%, 6 at 58%, 5 at 94%;
 * prints the bound port on stdout), or import startFakeProvider() from the
 * pty driver.
 */
const HEALTHY_RATE = 0.94;
const PROMPT_TOKENS = 100_000;

export interface ProviderRequestLog {
  at: number;
  turn: number | null;
  rate: number;
  stream: boolean;
}

export interface FakeProvider {
  port: number;
  requests: ProviderRequestLog[];
  stop(): Promise<void>;
}

export function startFakeProvider(rates: ReadonlyMap<number, number>): Promise<FakeProvider> {
  const requests: ProviderRequestLog[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/chat/completions')) {
        const body = (await request.json()) as {
          stream?: boolean;
          model?: string;
          messages?: { role: string; content: unknown }[];
        };
        const turn = lastTurnMarker(body.messages ?? []);
        const rate = turn === null ? HEALTHY_RATE : (rates.get(turn) ?? HEALTHY_RATE);
        requests.push({ at: Date.now(), turn, rate, stream: body.stream === true });

        const cached = Math.round(PROMPT_TOKENS * rate);
        const usage = {
          prompt_tokens: PROMPT_TOKENS,
          completion_tokens: 12,
          total_tokens: PROMPT_TOKENS + 12,
          prompt_tokens_details: { cached_tokens: cached },
        };
        const reply = turn === null ? 'ack' : `ack-${turn}`;
        if (body.stream !== true) {
          return Response.json({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? 'fake-collapse',
            system_fingerprint: null,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply },
                finish_reason: 'stop',
                logprobs: null,
              },
            ],
            usage,
          });
        }
        const chunks = [
          chunk({ role: 'assistant' }, null),
          chunk({ content: reply }, null),
          chunk({}, 'stop'),
          `data: ${JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? 'fake-collapse',
            choices: [],
            usage,
          })}\n\n`,
          'data: [DONE]\n\n',
        ];
        return new Response(chunks.join(''), {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return Promise.resolve({
    port: server.port,
    requests,
    stop: () => Promise.resolve(server.stop(true)),
  });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-collapse',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** Finds the last `turn <n>` marker in a user message's string content. */
function lastTurnMarker(messages: { role: string; content: unknown }[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const text = userText(message.content);
    const match = /turn (\d+)/.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Extracts the string content of a user message (plain or text-part array). */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      parts.push(part.text);
    }
  }
  return parts.join(' ');
}

// Standalone mode: `bun fake-provider.ts <turn> <rate-percent> [...]`.
// Prints the bound port on stdout.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const rates = new Map<number, number>();
  for (let i = 0; i + 1 < args.length; i += 2) {
    rates.set(Number(args[i]), Number(args[i + 1]) / 100);
  }
  const provider = await startFakeProvider(rates);
  process.stdout.write(`${provider.port}\n`);
  process.on('SIGTERM', () => {
    void provider.stop().then(() => process.exit(0));
  });
  // Run until killed.
  const { promise } = Promise.withResolvers<void>();
  await promise;
}
