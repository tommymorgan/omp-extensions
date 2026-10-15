# ADR 0001: Hybrid collapse detector (session-relative + absolute floor)

Date: 2026-10-18 · Status: accepted

## Decision

A collapse alert requires **both**: rolling 5-response cache-read rate below an absolute floor of **70%**, **and** more than **15 points** below the session's own frozen baseline, sustained for **3 consecutive evaluations**. Benign resets (`session_compact`, `auto_compaction_*`, `session_switch`, resume, `retry_fallback_*`) suppress or annotate. Detection re-arms after recovery (3 consecutive evaluations above the floor).

## Rationale

The Oct 15 Kizn incident showed healthy sessions at 96–99% cache-read and affected ones at 47–90% — both thresholds separate those bands cleanly. Pure session-relative blinds nothing but false-alarms on legitimately cold sessions; pure absolute floors miss slow drift (95%→72%). Baseline-from-first-20 keeps the reference fixed at the session's healthy state instead of tracking the decay. The Oct 15 signature was *repeated* divergence, not a one-time rebuild, so sustained-duration + benign markers separate pathology from normal compaction.

## Consequences

Thresholds are constants in one module (tunable later); no config surface in MVP. A session that starts already-collapsed (unhealthy baseline) only alerts once its baseline exceeds the floor by the margin — acceptable for v1.

## Alternatives rejected

Absolute floor only (drift-blind); pure relative (cold-session false alarms); per-request anomaly detection (too noisy — provider-side variance is normal).
