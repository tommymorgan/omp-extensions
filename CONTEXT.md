# Context — omp-extensions

Personal OMP extensions repo (jj). Each package is one removable extension installed by symlink into OMP's extension dir on junkman.

## cache-watch (planned)

Watches a session's prompt-cache health and alerts on collapse.

### Domain terms

- **Cache-read rate** — `cacheRead ÷ (cacheRead + uncached input)` over a **window** of the rolling last 5 provider responses.
- **Baseline** — the session's own healthy rate: median of the first ≥20 recorded responses, frozen once established. A **cold session** (<20 responses) has no baseline and never alerts.
- **Collapse** — rolling rate below the absolute floor (70%) **and** >15 points below baseline, held for 3 consecutive evaluations (each new response re-evaluates).
- **Divergence point** — the first request whose message-prefix hash stops matching its predecessor's; reported as `<request#> @ message index <i>`.
- **Injection event** — a context contribution recorded (read-only) between two provider requests, tagged with its source extension name.
- **Benign reset** — rate drop explained by `session_compact`, `auto_compaction_*`, `session_switch`, resume, or `retry_fallback_*`; suppresses/annotates rather than alerts.
- **Recovery** — rolling rate above the floor for 3 consecutive evaluations; re-arms detection and clears the banner.

### Model

In-process, per OMP instance (TUI or headless). Events consumed: `after_provider_response` (usage), `before_provider_request` (prefix fingerprint), `context` (injection ledger, read-only), compaction/switch/retry events (benign markers). No stats.db reads, no cross-process coordination, no request mutation ever.
