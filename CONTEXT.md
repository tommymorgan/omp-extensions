# Context — omp-extensions

Personal OMP extensions repo (jj). Each package is one removable extension installed by symlink into OMP's extension dir on junkman.

## cache-watch

Alerts on silent session degradation: prompt-cache collapse and unplanned model fallback.

### Domain terms

- **Cache-read rate** — `cacheRead ÷ (cacheRead + input + cacheWrite)` over a **window** of the rolling last 5 responses; usage arrives per response on `assistant_message` (`Usage`: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`).
- **Baseline** — the session's own healthy rate: median of the first ≥20 recorded responses, frozen once established. A **cold session** (<20 responses) has no baseline and never alerts.
- **Collapse** — rolling rate below the absolute floor (70%) **and** >15 points below baseline, held for 3 consecutive evaluations (each new response re-evaluates).
- **Divergence point** — the first request whose message-prefix hash stops matching its predecessor's; reported as `<request#> @ message index <i>`.
- **Injection event** — a context contribution recorded (read-only) between two provider requests, tagged with its source extension name.
- **Benign reset** — rate drop explained by `session_compact`, `auto_compaction_*`, `session_switch`, or resume; restarts the rolling window and suppresses alerting. `retry_fallback_*` is NOT benign — it has its own alert path (below).
- **Recovery** — rolling rate above the floor for 3 consecutive evaluations; re-arms detection and clears the banner.
- **Configured model** — the model the session's preset/selection resolves to.
- **Fallback episode** — starts at a `retry_fallback_applied` event (from → to, with reason) and ends when the configured model serves a request again. One warning per episode; the banner persists for the episode (ADR 0004).

### Model

In-process, per OMP instance (TUI or headless). Events consumed: `assistant_message` (per-response usage + serving model), `before_provider_request` (prefix fingerprint), `after_provider_response` (response boundary marker), `context` (injection ledger, read-only), compaction/switch events (benign markers), `retry_fallback_applied`/`retry_fallback_succeeded` (fallback episodes). Session identity via `ctx.sessionManager.getSessionId()`. No stats.db reads, no cross-process coordination, no request mutation ever.
