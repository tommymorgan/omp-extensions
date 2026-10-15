import { expect, test } from "bun:test";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { createReceiver } from "../src/receiver.ts";

test("native GET failure reports stale guidance even when subscription POST succeeds", async () => {
  const handle = "private-failure-fixture";
  const warnings: string[] = [];
  const delivered: unknown[] = [];
  const instructions = { bootstrap: "Failure fixture", rules: [], memories: [], referencedItems: [], catalog: {}, agentGuidance: {} };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return new Response("Unavailable", { status: 503 });
    const rpc = await request.json();
    const result = rpc.method === "resources/read" ? { contents: [{
      uri: rpc.params.uri, mimeType: "application/json", text: JSON.stringify({ instructionsVersion: "v2", instructions }),
    }] } : {};
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  } });
  const transport = new HttpTransport({ type: "http", url: server.url.toString(), timeout: 1000 });
  const connection = {
    startListener: () => transport.startSSEListener(),
    request: (method: string, params: { uri: string }, signal?: AbortSignal) => transport.request(method, params, { signal }),
  };
  const receiver = createReceiver({
    connection: () => connection,
    deliver(_binding, snapshot) { delivered.push(snapshot); },
    confirm() {},
    invalidate() {},
    report(message) { warnings.push(message); },
  });
  try {
    await transport.connect();
    transport.setProtocolVersion("2025-11-25");
    await receiver.bind({ sessionId: "failure-conversation", handle, version: "v1" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(handle);
    expect(delivered).toEqual([]);
  } finally {
    await receiver.stop();
    await transport.close();
    server.stop(true);
  }
}, 20_000);
