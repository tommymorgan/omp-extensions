# Tommy's OMP extensions

One source repository, independently installable packages. The first package is [the editor](packages/editor/README.md), which combines Home/End navigation and undo/redo.

## Development

Requires Bun and OMP. The regression dependencies are pinned to OMP 18.10.4.

```sh
bun install
bun run test
omp plugin link ./packages/editor
```

Run `/restart` in OMP after installing or changing the editor. Keep only one active editor registration: do not also install the old loose `editor-redo.ts` or `zz-home-end` extension.

## Packages

- `packages/editor`: `tommy-omp-editor`, with one `omp.extensions` entry point.
- `packages/trailboss`: `tommy-omp-trailboss`, **Trailboss OMP Integration**, with passive, session-scoped routine context delivery through public OMP extension hooks.
- `packages/kizn-guidance`: `tommy-omp-kizn-guidance`, native authenticated Kizn instruction-change delivery through the Trailboss integration. See its [activation requirements](packages/kizn-guidance/README.md).

## Trailboss OMP Integration

Link both packages, then start a new OMP process or reload extensions through a host mechanism that emits a fresh `session_start`:

```sh
omp plugin link ./packages/trailboss
omp plugin link ./packages/kizn-guidance
```

No OMP core, Kizn backend, or Trailboss Core/sidebar changes are required. Routine publications never enter the agent's turn queue: idle agents stay idle, and active agents consume the latest context at the next provider boundary without interrupting tools. Existing completion attention is left alone. Actual user/delegated work retains normal wake and completion behavior; this is not suppression of all MCP traffic.

Other cooperating extensions can publish a hidden context snapshot on the public session event bus:

```ts
let accepted = false;
pi.events.emit("trailboss:context:publish", {
  source: "my-extension:instructions",
  sessionId: ctx.sessionManager.getSessionId(),
  message: { customType: "my-extension-instructions", content: snapshot, display: false },
  accept() { accepted = true; },
});
if (!accepted) throw new Error("Trailboss OMP Integration is not enabled");
```

Publication acceptance is synchronous. Each source owns its `customType` namespace within a session; another source cannot claim it. New publications replace that source's cached snapshot. The `context` hook injects only the current session's latest snapshots, retaining provider details and ordinary conversation messages. Session changes prune other sessions; shutdown clears snapshots and detaches only the integration's listener. Providers must validate their own generation/authority before publishing. The integration does not reinterpret MCP notifications or intercept other extensions' APIs.

Run `bun run test:trailboss` for the focused suite. Its isolated real-SDK harness exercises actual provider dispatch and foreground tool batches without credentials or network calls; unit tests alone do not prove installed-session activation.

Source: [tommymorgan/omp-extensions](https://github.com/tommymorgan/omp-extensions). No package has been published to npm. The editor remains `UNLICENSED`; public source availability does not grant a reuse license.
