# Feature: Cache-Rate Collapse Watcher

**Created**: 2026-10-18
**Goal**: OMP sessions alert within minutes when their prompt-cache read rate collapses, naming the drop, the divergence point, and the context injection that caused it.
> Source PRD: none — plan-only (agreed; no PRD was authored)
> PRD coverage: none — no PRD, so no ledger; scenario set below is the sole requirement source
> Context: [CONTEXT.md](../CONTEXT.md) · [ADR 0001](../docs/adr/0001-hybrid-collapse-detector.md) · [ADR 0002](../docs/adr/0002-read-only-observer.md) · [ADR 0003](../docs/adr/0003-in-process-events-over-stats-db.md)

## Slice 1: Detect and log cache collapse

**Tracer bullet**: a session whose rolling cache-read rate collapses produces one warning log entry naming the session and the crossed thresholds — nothing else exists yet.
**Touches**: `packages/cache-watch/` (new package), extension registration in `package.json`
**Off-limits**: any existing package (`editor`, `eval-progress`), OMP core, any mutation of provider request payloads

### Task 1.1: Usage capture, hybrid detector, log alert
> Depends on: none
> Shippable state: extension installed in every OMP process observes its own requests and logs a collapse warning; no UI, no attribution, no config
> Boundary verification: synthetic session driven by unit tests plus one headless `omp -p` run with collapsing fixture rates → exactly one `logger.warn` entry in `~/.omp/logs/omp.2026-10-18.log`

<!-- estimate: ~280 reviewable lines | feature-files: features/cache-collapse-alert.feature | demoable: yes -->

<!-- DONE -->
# Living: features/cache-collapse-alert.feature::Cache collapse triggers a warning alert
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Cache collapse triggers a warning alert
  Given a session "cache-watch-demo" with a baseline cache-read rate of 94% established over its first 20 provider responses
  When its rolling 5-response cache-read rate stays below 70% and more than 15 points below baseline for 3 consecutive evaluations with no compaction, switch, or retry event in between
  Then a warning is logged naming session "cache-watch-demo", its baseline 94%, the current rolling rate, and both crossed thresholds
  And the warning is logged once for the collapse, not once per response

<!-- DONE -->
# Living: features/cache-collapse-alert.feature::Benign compaction reset does not alert
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Benign compaction reset does not alert
  Given a session "cache-watch-demo" with a baseline cache-read rate of 94%
  When its rolling rate drops below both thresholds for 2 evaluations immediately after a session_compact event and then recovers above 85%
  Then no collapse warning is logged

<!-- DONE -->
# Living: features/cache-collapse-alert.feature::Recovery re-arms detection
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Recovery re-arms detection
  Given a session that already logged a collapse warning and whose rolling rate recovered above 85% for 10 responses
  When a second collapse stays below both thresholds for 3 consecutive evaluations
  Then a second collapse warning is logged

<!-- TODO -->
# Living: features/cache-collapse-alert.feature::Cold session does not alert
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Cold session does not alert
  Given a session with only 4 recorded provider responses
  When its rolling cache-read rate reads 55%
  Then no collapse warning is logged because no baseline is established

## Slice 2: Attribute the divergence to an injection

**Tracer bullet**: the collapse warning gains a cause line naming the context injection nearest upstream of the divergence point (or stating none was recorded).
**Touches**: `packages/cache-watch/` (prefix fingerprinting, injection ledger, alert formatting)
**Off-limits**: mutation of any provider request payload or context contributions from other extensions

### Task 2.1: Request-prefix fingerprinting and divergence points
> Depends on: Task 1.1
> Shippable state: divergence points are computed and included in the warning detail (indices only, no cause naming yet)
> Boundary verification: unit fixtures with consecutive requests whose message lists change at a known index → reported divergence index matches

<!-- estimate: ~180 reviewable lines | feature-files: features/cache-divergence-attribution.feature | demoable: yes -->

<!-- TODO -->
# Living: features/cache-divergence-attribution.feature::Alert reports the divergence point
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Alert reports the divergence point
  Given requests 40, 41 and 42 of session "cache-watch-demo" share an identical message-prefix hash and request 43's prefix hash first differs at message index 7
  When the collapse warning fires
  Then the warning detail names request 43 and message index 7 as the divergence point

### Task 2.2: Injection correlation and cause naming
> Depends on: Task 2.1
> Shippable state: warnings name the nearest upstream context-injection source, a compaction marker, or "none recorded"
> Boundary verification: unit fixture injecting a synthetic context event between requests 42 and 43 → warning names that source; headless re-run confirms end to end

<!-- estimate: ~220 reviewable lines | feature-files: features/cache-divergence-attribution.feature | demoable: yes -->

<!-- TODO -->
# Living: features/cache-divergence-attribution.feature::Alert names the nearest upstream injection
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Alert names the nearest upstream injection
  Given the divergence point is request 43 of session "cache-watch-demo"
  And a context injection from source "kizn-guidance" was recorded between requests 42 and 43
  When the collapse warning fires
  Then the warning names source "kizn-guidance" as the nearest upstream injection

<!-- TODO -->
# Living: features/cache-divergence-attribution.feature::Injection-free collapse reports none
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Injection-free collapse reports none
  Given the divergence point is request 43 of session "cache-watch-demo" and no context injection was recorded in the 10 requests before it
  When the collapse warning fires
  Then the warning states that no context injection was recorded before the divergence

<!-- TODO -->
# Living: features/cache-divergence-attribution.feature::Compaction is named as the cause
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Compaction is named as the cause
  Given the divergence point immediately follows a session_compact event and no context injection was recorded between them
  When the collapse warning fires
  Then the warning names the compaction as the likely cause instead of an injection

## Slice 3: In-TUI collapse banner

**Tracer bullet**: a collapsing TUI session shows a red banner naming the drop and attributed source; it clears on recovery.
**Touches**: `packages/cache-watch/` (TUI render contribution)
**Off-limits**: injecting any message into the request stream (the banner must never perturb the cache it watches)

### Task 3.1: Banner render and lifecycle
> Depends on: Task 1.1 (not on Slice 2; banner shows attribution line only when present)
> Shippable state: TUI sessions show the banner during an active alert and remove it on recovery; headless sessions are unaffected
> Boundary verification: pty-driven OMP run with synthetic collapsing rates → banner text present in pty capture during collapse, absent after recovery fixture, absent in a second non-collapsing session's capture

<!-- estimate: ~250 reviewable lines | feature-files: features/cache-banner.feature | demoable: yes -->

<!-- TODO -->
# Living: features/cache-banner.feature::Collapse shows a red banner in the affected session only
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Collapse shows a red banner in the affected session only
  Given session "cache-watch-demo" is running in a TUI and has an active collapse alert naming a 94%-to-58% drop caused by source "kizn-guidance"
  Then a red banner appears in that session's interface showing the drop and the source
  And a different TUI session without an active alert shows no banner

<!-- TODO -->
# Living: features/cache-banner.feature::Banner clears on recovery
# Action: creates
# Status: TODO
# Living updated: NO
Scenario: Banner clears on recovery
  Given session "cache-watch-demo" is showing the collapse banner
  When its rolling rate recovers above the absolute floor for 3 consecutive evaluations
  Then the banner is removed without restarting the session
