import type { Socket } from 'bun';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRequest } from '../src/session-socket.ts';

/**
 * Review findings 2 + 4 (Task 1.2 fix pass): the connect timer must be
 * cleared once the socket opens, or an in-flight request whose response
 * lands between CONNECT_TIMEOUT (3s) and RESPONSE_TIMEOUT (5s) is falsely
 * rejected after the pane text may already have been delivered (double-send
 * hazard). And the response reader must accumulate raw bytes and decode
 * only complete newline-terminated lines — per-chunk TextDecoder decoding
 * corrupts multi-byte characters split across chunk boundaries, silently
 * dropping the response line.
 */

interface Result {
  ok?: boolean;
  message?: string;
}

function tempSocketPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `palette-sock-${prefix}-`)), 'test.sock');
}

async function withFakeSessionSocket(
  prefix: string,
  respond: (client: Socket, requestLine: string) => void,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const socketPath = tempSocketPath(prefix);
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(client, chunk) {
        respond(client, new TextDecoder().decode(chunk));
      },
    },
  });
  try {
    await run(socketPath);
  } finally {
    await listener.stop(true);
    rmSync(socketPath, { recursive: true, force: true });
  }
}

describe('sessionRequest', () => {
  // Real timer, deliberately: this test reproduces the connect-timer vs
  // response-timer race against the platform clock — the bug only manifests
  // when the 3s connect timer actually fires while the socket is open and
  // the response is in flight at 3.5s. Fake timers cannot drive it: the
  // response delay and the client timers must interleave through real
  // socket I/O.
  it('resolves a delayed response arriving after CONNECT_TIMEOUT but before RESPONSE_TIMEOUT', async () => {
    await withFakeSessionSocket(
      'slow',
      (client, requestLine) => {
        const requestId = (JSON.parse(requestLine) as { id: string }).id;
        setTimeout(() => {
          client.write(`${JSON.stringify({ id: requestId, result: { ok: true } })}\n`);
        }, 3500);
      },
      async (socketPath) => {
        const result = await sessionRequest<Result>(socketPath, 'ping', {});
        expect(result).toEqual({ ok: true });
      },
    );
  }, 9000);

  // Real timer, deliberately: the split must arrive as two separate socket
  // data events mid-character; that chunk boundary is produced by real I/O
  // scheduling, not by anything a fake clock controls.
  it('parses a response whose multi-byte character is split across chunk boundaries', async () => {
    await withFakeSessionSocket(
      'split',
      (client, requestLine) => {
        const response = `${JSON.stringify({
          id: (JSON.parse(requestLine) as { id: string }).id,
          result: { message: 'done — verified' },
        })}\n`;
        const bytes = new TextEncoder().encode(response);
        const emDashStart = bytes.indexOf(0xe2); // first byte of U+2014 —
        const boundary = emDashStart + 1; // split mid-character
        client.write(bytes.slice(0, boundary));
        setTimeout(() => client.write(bytes.slice(boundary)), 50);
      },
      async (socketPath) => {
        const result = await sessionRequest<Result>(socketPath, 'ping', {});
        expect(result.message).toBe('done — verified');
      },
    );
  });
});
