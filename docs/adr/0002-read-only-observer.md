# ADR 0002: Read-only observer — never mutate requests

Date: 2026-10-18 · Status: accepted

## Decision

cache-watch registers only read-only event handlers. It never adds, reorders, or edits messages in `before_provider_request` or `context`, and its banner renders through a TUI surface that does not insert messages into the request stream.

## Rationale

Any message the watcher injects changes the request prefix itself — the monitor would become its own cache-collapse cause. This is the exact failure class the extension exists to catch (Oct 15: injected guidance snapshots persisted mid-transcript and moved divergence points). The banner must therefore use a render/notice surface, not message injection.

## Consequences

Prefix fingerprinting happens on the payload as received; attribution records what other extensions injected without interfering with ordering. If no non-perturbing banner surface exists in the extension API, Task 3.1's spike falls back to a status/notice API or escalates — never to message injection.
