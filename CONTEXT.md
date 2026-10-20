# Context — omp-extensions

Personal OMP extensions repo (jj). Each package is one removable extension installed by symlink into OMP's extension dir on junkman.

## cache-watch

Alerts on silent session degradation: prompt-cache collapse and unplanned model fallback.

### Domain terms

- **Cache-read rate** — `cacheRead ÷ (cacheRead + input + cacheWrite)` over a **window** of the rolling last 5 responses; usage arrives per response on `assistant_message` (`Usage`: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`).
- **Baseline** — the session's own healthy rate: median of the first ≥20 recorded responses, frozen once established. A **cold session** (<20 responses) has no baseline and never alerts.
- **Collapse** — rolling rate below the absolute floor (70%) **and** >15 points below baseline, held for 3 consecutive evaluations (each new response re-evaluates).
- **Contributor candidate** — a named custom-context contribution or read-only `trailboss:context:publish` observation, with source, available version and SHA-256 content digest. Naming requires its content to cover the first changed text offset at the actual divergent provider prefix; appearing elsewhere or merely being published is insufficient, but identical text elsewhere does not disqualify a newly changed occurrence. Publications cover contributors ordered after the watcher's context hook; later context inclusion retains an available `details.version`. Retention keeps at most 64 observations, evicting the oldest even while idle; candidate eligibility and remembered divergence also expire after 10 provider-request boundaries. Correlation is not proof that the contribution caused cache loss.
- **Fingerprint coverage** — complete for full `messages` or Responses/Codex `input` histories, including top-level `system` and `instructions`; partial for `previous_response_id` chains; unsupported for unrecognized/malformed shapes. Every provider boundary advances the ordinal. Incomplete coverage clears the comparison baseline, so the next complete request establishes a fresh fingerprint instead of inventing a cross-gap divergence. Pure appended messages do not diverge from their preserved prefix.
- **Benign reset** — rate drop explained by `session_compact`, `auto_compaction_*`, `session_switch`, or resume; restarts the rolling window and suppresses alerting. A `session_switch` additionally ends the active alert episode (the TUI wipes widgets on switch, so the episode cannot survive it). `retry_fallback_*` is NOT benign — it has its own alert path (below).
- **Recovery** — rolling rate above the floor for 3 consecutive evaluations; re-arms detection and clears the banner.
- **Configured model** — the model the session's preset/selection resolves to. Never adopted from a serving fallback target (the last fallback target is remembered across benign resets). Bootstrap limit: a session first observed already serving a fallback has no event contradicting it, so the fallback is initially taken as configured.
- **Fallback episode** — starts at a `retry_fallback_applied` event (from → to, with reason) and ends when the configured model serves a request again. One warning per episode; the banner persists for the episode (ADR 0004).

### Model

In-process, per OMP instance (TUI or headless). Events consumed: `assistant_message` (per-response usage + serving model), `before_provider_request` (provider-prefix fingerprint), `after_provider_response` (response boundary marker), `context` and `trailboss:context:publish` (read-only contributor observations), compaction/switch events (benign markers), `retry_fallback_applied`/`retry_fallback_succeeded` (fallback episodes). Session identity via `ctx.sessionManager.getSessionId()`; publications route by their exact session ID, even before a UI context exists. The publication listener is removed on shutdown. No stats.db reads, cross-process coordination, publication acceptance or request mutation. Warnings carry coverage and correlated provenance, never contributor content. The banner distinguishes correlated candidates, unsupported payloads, partial chained input, no observed divergence and no matching contributor.
