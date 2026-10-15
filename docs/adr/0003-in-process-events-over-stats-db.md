# ADR 0003: In-process events, not stats.db polling

Date: 2026-10-18 · Status: accepted

## Decision

The MVP detector consumes in-process extension events (`after_provider_response` usage, `before_provider_request` payloads, `context` events) instead of polling `~/.omp/stats.db`.

## Rationale

Attribution (naming the injection nearest the divergence point) requires correlating per-request prefix fingerprints with context-injection timing — neither is available in stats.db, which records token accounting only. In-process events give exact ordering, the outgoing payload for fingerprinting, and benign-reset markers in one stream, with no polling interval or WAL contention. stats.db remains the retrospective/backfill source for the manual diagnosis skills; a stats.db-based cross-session dashboard is an explicit MVP non-goal.

## Consequences

Coverage = every OMP process that loads the extension (TUI and headless alike); no cross-session aggregation exists in v1. Window state lives in memory per session; a process restart forgets history and re-establishes a baseline (≤20 responses), which the cold-session rule already handles.
