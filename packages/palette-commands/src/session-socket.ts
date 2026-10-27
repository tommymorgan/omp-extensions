import type { Socket } from 'bun';

/**
 * Minimal trailboss session-socket client (plan Task 1.2 revised + review
 * fix pass): the trailboss session API speaks newline-delimited JSON over
 * its unix socket — one request per line `{"id","method","params"}`
 * (`params` required, even when empty), single-line responses
 * `{"id","result"}` or `{"id","error"}`. The bridge uses it for
 * `pane.send_input`, typing slash text + Enter into the verified pane
 * through omp's real input path.
 *
 * Fix-pass hardening: the connect timer is cleared once the socket opens —
 * a response landing between CONNECT_TIMEOUT and RESPONSE_TIMEOUT is a
 * normal in-flight request, not a connect failure (a false rejection after
 * the pane text was already delivered is a double-send hazard). Response
 * bytes are accumulated raw and only complete newline-terminated lines are
 * decoded, so multi-byte characters split across chunk boundaries survive.
 */

export interface SessionErrorResponse {
  code?: string;
  message?: string;
}

const CONNECT_TIMEOUT_MS = 3000;
const RESPONSE_TIMEOUT_MS = 5000;

interface SessionResponseLine {
  id: unknown;
  result?: unknown;
  error?: SessionErrorResponse;
}

/** Sends one API request and resolves its `result`; rejects on error/timeout. */
export async function sessionRequest<T>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<T> {
  const id = `palette-commands-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestLine = `${JSON.stringify({ id, method, params })}\n`;
  const { promise, resolve, reject } = Promise.withResolvers<T>();

  let pending = new Uint8Array(0);
  let settled = false;
  let socket: Socket | null = null;

  const finish = (settle: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    clearTimeout(responseTimer);
    try {
      socket?.end();
    } catch {
      // already closed
    }
    settle();
  };
  const fail = (message: string): void => finish(() => reject(new Error(message)));
  const succeed = (value: T): void => finish(() => resolve(value));

  const connectTimer = setTimeout(
    () => fail(`trailboss session socket connect timeout (${socketPath})`),
    CONNECT_TIMEOUT_MS,
  );
  const responseTimer = setTimeout(
    () => fail(`trailboss session socket response timeout for ${method}`),
    RESPONSE_TIMEOUT_MS,
  );

  const handleLine = (lineText: string): void => {
    if (lineText.trim().length === 0) return;
    let response: unknown;
    try {
      response = JSON.parse(lineText);
    } catch {
      return; // not a complete response line; ignore stray output
    }
    if (response === null || typeof response !== 'object' || !('id' in response)) return;
    const line = response as SessionResponseLine;
    if (line.id !== id) return;
    if (line.error !== undefined) {
      fail(`trailboss session API ${method} failed: ${line.error.code ?? 'error'} ${line.error.message ?? ''}`.trim());
      return;
    }
    succeed(line.result as T);
  };

  const appendBytes = (chunk: string | Uint8Array): void => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    const merged = new Uint8Array(pending.length + bytes.length);
    merged.set(pending);
    merged.set(bytes, pending.length);
    let start = 0;
    for (let index = 0; index < merged.length; index += 1) {
      if (merged[index] === 0x0a) {
        handleLine(new TextDecoder().decode(merged.slice(start, index)));
        start = index + 1;
      }
    }
    pending = merged.slice(start);
  };

  void Bun.connect({
    unix: socketPath,
    socket: {
      data(sock, chunk) {
        socket = sock;
        appendBytes(chunk);
      },
      open(sock) {
        socket = sock;
        // Connected: only the response deadline applies from here on.
        clearTimeout(connectTimer);
        sock.write(requestLine);
      },
      error(_sock, err) {
        fail(`trailboss session socket error: ${err instanceof Error ? err.message : String(err)}`);
      },
    },
  }).catch((err: unknown) => {
    fail(`could not connect to trailboss session socket ${socketPath}: ${err instanceof Error ? err.message : String(err)}`);
  });

  return promise;
}
