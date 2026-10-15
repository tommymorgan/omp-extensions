# Kizn guidance for OMP

An independently installable, unpublished OMP extension. It receives canonical Kizn instruction changes over the existing authenticated native MCP connection and supplies them to model context without another model Kizn call. No Agent Mail, credential storage, second OAuth client, instruction polling or persistent settings changes.

## Activate

1. Configure the existing native MCP server under the exact name `kizn`, pointing to a Kizn API that advertises resource subscriptions and implements `kizn://instructions/{sessionHandle}`.
2. Install this package's dependencies with Bun. From this package directory, use `omp plugin link` (the repository's independent-package convention), or start a disposable OMP process with `-e /absolute/path/to/packages/kizn-guidance/src/index.ts`.
3. Start a new OMP process, or use the host's extension reload mechanism if it emits a fresh `session_start`. A process started with extensions disabled will not activate this package merely because it was linked.

The extension owns a private `start_session` call through `MCPManager.instance().getConnection("kizn").transport`. It discovers every fetch/push remote URL from `git -C <actual conversation cwd> remote -v`. A non-repository directory uses an empty repository scope; unexpected Git errors fail visibly rather than silently changing scope. This independent subscription session supports Eval-only tool use and activation in conversations whose models already have their own Kizn sessions. Its private handle is never supplied as the model's write handle. Models retain their existing handle or deliberately call `start_session` if needed. The canonical version hash identifies instructions and scope, not the session handle.

## Delivery and lifecycle

- The initial canonical snapshot is attached by `before_agent_start`. A changed version is fetched immediately on a matching `mcp_notification` and sent via native `pi.sendMessage(..., {deliverAs: "aside"})`: safe step-boundary delivery while busy and an event-driven turn while idle. Native plan mode folds idle asides into context without an autonomous turn; this extension does not override plan mode.
- Reads and subscriptions use the same native transport/auth/session as configured Kizn. Native `startSSEListener()` runs before subscribing, including recovery from a GET that returned 405 before the API supported subscriptions. Subscribe is followed by a canonical read to close establishment gaps.
- Native manager connection-status events resubscribe and catch up after reconnect. In-flight invalidations coalesce; unchanged versions do not create repeated idle wakes. A response from a superseded session/connection generation cannot deliver context.
- Switches, forks and tree changes create a fresh owned session with the current repository scope. Shutdown aborts owned work, removes connection listeners and unsubscribes without closing the shared transport. No private subscription binding is persisted to disk.
- Current instructions are reattached at agent-start boundaries, including after compaction. The context hook retains only the current scope/version snapshot. Rules, Memories, Concepts and evidence retain their original owner/kind authority; delivery does not claim that on-demand bodies were read or automatically acknowledge/retry a write.

Failures produce a generic UI warning or stderr message without tokens, handles, owner data or snapshots. A revoked/expired session cannot refresh successfully; reconnect/reload or explicitly refresh guidance before writing. There is no silent success or retry loop.

## Host compatibility

The package peers with OMP `^18.10.4`. Its source API references were inspected in coding-agent18.3 and the pinned18.10.4 dependency. Live integration is verified with the installed OMP18.11.0: the extension reused the host's authenticated MCP manager, received a committed external PostgreSQL change, refreshed the canonical resource and woke an idle real model without another user prompt. The model returned a novel token supplied only by the changed Rules; shutdown released the dedicated database listener. This is evidence for that host version, not a claim that every peer-compatible host has been exercised.

The native package exports `@oh-my-pi/pi-coding-agent/mcp/manager` via its `./mcp/*` export. Required APIs are `MCPManager.instance`, `getConnection`, `addConnectionStatusListener`, transport `request`, HTTP `startSSEListener`, extension `mcp_notification`, `before_agent_start`, `context`, session lifecycle events and `sendMessage` aside semantics. Hosts missing these APIs are unsupported; no private-field inspection or replacement transport is used.

`mcp.notifications` gates OMP's generic automatic resource subscriptions/context queue, not raw notification fanout to extensions. This package subscribes only its owned canonical URI and consumes that raw native event, so it does not enable a global notification setting, subscribe to unrelated servers, or write installed configuration.

OMP currently negotiates MCP 2025-11-25. This package uses that actual legacy `resources/subscribe` + authenticated GET SSE flow. Kizn's modern 2026 `subscriptions/listen` endpoint is a separate supported server protocol, not a client fallback here. Native OMP owns reconnect/auth; this package does not close/reconfigure the shared connection. A fresh MCP authorization or server configuration requires the normal host reconnect/restart path.

## Checks

Run `bun test test` in this package after integration. The permanent tests cover canonical-response validation, scoped exclusion, coalescing, version deduplication, stale-fetch/session shutdown races, reconnect catch-up, private handle non-disclosure, initial model context, Eval-independent bootstrap, forks and subscription cleanup. Tests are deterministic and do not start OMP, a model, or a database. Actual authenticated push-to-model-context verification remains the integration smoke; mock tests do not establish it.

UNLICENSED; this package is not configured for npm publication.
