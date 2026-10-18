# ADR 0004: Fallback alerting — one warning per episode, on `retry_fallback_applied`

Date: 2026-10-18 · Status: accepted

## Decision

A **fallback episode** starts at a `retry_fallback_applied` event and ends when the configured model serves a request again (observed via the serving model on `assistant_message`). The extension logs exactly one `logger.warn` per episode, carrying the event's `from`, `to`, and `reason` verbatim; `retry_fallback_succeeded` only annotates (confirms the fallback landed) and never alerts. The banner (Slice 4.2) persists for the episode's duration. The extension never influences retry or model selection.

## Rationale

`retry_fallback_applied` is the single authoritative "configured model couldn't be used" moment — it carries from/to/role/reason (shared-events.ts). The incident class (GPT quota exhausted → silently on the local model) is a state, not an event-per-request: repeated warnings per request would be noise, while a single persistent banner matches the condition's duration. Alerting on `applied` rather than `succeeded` warns at the moment of silent degradation even if the fallback request later fails again.

## Consequences

Task 4.1 needs only `retry_fallback_applied`, `retry_fallback_succeeded`, and the serving-model field of `assistant_message` — no retry-internals knowledge. Episode state resets on session switch/compaction like other rolling state.

## Alternatives rejected

Alert per fallback request (noise); alert only on `retry_fallback_succeeded` (misses fallbacks that keep failing); inspect provider errors directly (duplicates retry logic, fragile).
